'use strict';
// 极简 .xlsx 解析（零依赖：zlib 解 zip + 正则解析 sheet/sharedStrings）+ CSV 解析
const zlib = require('node:zlib');
const { ApiError } = require('./util');

const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 32 * 1024 * 1024;

function readZip(buf) {
  // 定位 EOCD -> 中央目录 -> 各条目
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new ApiError(400, '不是有效的 .xlsx 文件（若为旧版 .xls 请在 Excel 中另存为 .xlsx）');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > 200) throw new ApiError(400, 'xlsx 条目数异常过多');
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  let totalOut = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (uncompSize > MAX_ZIP_ENTRY_BYTES || totalOut + uncompSize > MAX_ZIP_TOTAL_BYTES) {
      throw new ApiError(400, 'xlsx 解压体积超限，文件疑似损坏');
    }
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (compSize > 0 && !name.endsWith('/')) {
      if (localOff + 30 > buf.length) throw new ApiError(400, 'xlsx 文件结构损坏');
      const nl = buf.readUInt16LE(localOff + 26);
      const el = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + nl + el;
      if (dataStart + compSize > buf.length) throw new ApiError(400, 'xlsx 数据偏移越界，文件已损坏');
      const data = buf.slice(dataStart, dataStart + compSize);
      try {
        const out = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES }) : data;
        totalOut += out.length;
        if (totalOut > MAX_ZIP_TOTAL_BYTES) throw new Error('over limit');
        files[name] = out;
      } catch {
        throw new ApiError(400, 'xlsx 解压体积超限或数据损坏');
      }
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}
function xmlText(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))); }
function colToIdx(ref) { let n = 0; for (const ch of ref) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); } return n - 1; }

function parseXlsx(buf) {
  const files = readZip(buf);
  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const xml = files['xl/sharedStrings.xml'].toString('utf8');
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      let t = '';
      for (const m of si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []) t += m.replace(/<[^>]+>/g, '');
      shared.push(xmlText(t));
    }
  }
  const sheetName = Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new ApiError(400, 'xlsx 文件里没有工作表');
  const xml = files[sheetName].toString('utf8');
  const rows = [];
  for (const rowM of xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cM of rowM.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || []) {
      const ref = (cM.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
      const idx = ref ? colToIdx(ref) : cells.length;
      const t = (cM.match(/\st="([^"]+)"/) || [])[1] || '';
      let v = '';
      if (t === 's') { const i = Number((cM.match(/<v>([\s\S]*?)<\/v>/) || [])[1]); v = shared[i] ?? ''; }
      else if (t === 'inlineStr') { v = (cM.match(/<t[^>]*>([\s\S]*?)<\/t>/) || []).slice(1).join(''); v = xmlText(v.replace(/<[^>]+>/g, '')); }
      else v = ((cM.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '').trim();
      if (/^-?\d+(\.\d+)?E[+-]?\d+$/i.test(v)) v = /E\+?(1[5-9]|[2-9]\d)$/i.test(v) ? `[SCI:${v}]` : String(Number(v)); // Excel 数值单元格可能是 1.38E10 形式，归一成普通数字；15位以上已丢精度不伪造末位 0
      while (cells.length < idx) cells.push('');
      cells[idx] = v;
    }
    rows.push(cells);
  }
  return rows;
}
function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const rows = []; let row = []; let cell = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function decodeCsvText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}
// 入口：根据文件名后缀解析成二维数组（全字符串）
function parseSpreadsheet(filename, b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (/\.xlsx$/i.test(filename || '')) return parseXlsx(buf);
  if (/\.csv$/i.test(filename || '')) return parseCsv(decodeCsvText(buf));
  if (/\.txt$/i.test(filename || '')) return parseCsv(decodeCsvText(buf));
  if (/\.xls$/i.test(filename || '')) throw new ApiError(400, '不支持旧版 .xls 格式，请在 Excel 中「另存为 .xlsx」后再导入');
  throw new ApiError(400, '仅支持 .xlsx / .csv / .txt 文件');
}
function toCsv(rows) {
  const esc = c => {
    c = String(c ?? '');
    if (/^[=+\-@\t\r]/.test(c) && !/^-[\d.]+$/.test(c)) c = "'" + c;
    return /[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
  };
  return '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
}
/* ---- 生成最小 .xlsx（inlineStr 单元格，全部按文本写入，身份证不被 Excel 转成科学计数） ---- */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function xmlEsc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function colRef(n) { let s = ''; n += 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; }
function buildZip(entries) { // entries: [ [name, Buffer], ... ] 全部 STORE
  const chunks = []; const central = []; let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14); ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, nb]));
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}
function makeXlsx(rows, sheetName = 'Sheet1') {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const sheetXml = head + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((r, ri) => {
      const cells = r.map((v, ci) => (v === '' || v == null) ? null :
        `<c r="${colRef(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).filter(Boolean).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('') + '</sheetData></worksheet>';
  const wb = head + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const entries = [
    ['[Content_Types].xml', Buffer.from(head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')],
    ['_rels/.rels', Buffer.from(head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')],
    ['xl/workbook.xml', Buffer.from(wb)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheetXml)],
  ];
  return buildZip(entries);
}
module.exports = { parseSpreadsheet, toCsv, parseCsv, makeXlsx };
