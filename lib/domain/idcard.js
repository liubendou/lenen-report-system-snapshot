'use strict';
// 身份证校验、展示脱敏与日志/审计文本自动脱敏（F17/F18/F19）

function checkIdcard(id) {
  const s = String(id || '').toUpperCase().trim();
  if (s.includes('[SCI:') || /^\d+(\.\d+)?E[+-]?\d+$/i.test(s)) {
    return { ok: false, why: '身份证号被 Excel 存成了科学计数法（末位精度已丢失），请将该列设为「文本」格式后重新填写' };
  }
  if (!/^\d{17}[\dX]$/.test(s)) return { ok: false, why: '身份证号格式不对（需 18 位）' };
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
  if (c[sum % 11] !== s[17]) return { ok: false, why: '身份证校验码不匹配（号码疑似有误）' };
  const sex = Number(s[16]) % 2 === 1 ? '男' : '女';
  return { ok: true, sex, id: s };
}

function maskIdcard(id) {
  const s = String(id || '');
  return s.length === 18 ? s.slice(0, 4) + '**********' + s.slice(14) : s;
}

function scrubIdcards(text) {
  return String(text || '').replace(/\b(\d{4})\d{10}(\d{3}[\dXx])\b/g, (_, a, b) => a + '**********' + b.toUpperCase());
}

module.exports = { checkIdcard, maskIdcard, scrubIdcards };
