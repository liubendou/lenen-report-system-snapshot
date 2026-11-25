'use strict';
/* Phase 2 回归测试套件（每个批次先写失败用例，修复后转绿并常驻）
   运行：node test/regress.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeXlsx } = require('../lib/xlsxmini');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LENEN_REGRESS_PORT) || 8798;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lenen-regress-'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function genId(base17) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base17[i]) * w[i];
  return base17 + c[sum % 11];
}

function client() {
  let sid = '';
  return async (method, p, body, extra = {}) => {
    const h = { ...(sid ? { Cookie: 'lenen_sid=' + sid } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(extra.headers || {}) };
    const r = await fetch(BASE + p, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(extra.timeout || 8000),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /lenen_sid=([^;]*)/.exec(sc); if (m) sid = m[1]; }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text, headers: r.headers };
  };
}

let srv = null;
async function startServer() {
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, LENEN_PORT: String(PORT), LENEN_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('regress server failed to start');
}
async function stopServer() {
  if (srv) { await new Promise(r => { srv.once('exit', r); srv.kill(); }); srv = null; }
}

(async () => {
  await startServer();
  const anon = client();
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'change-me-on-first-login' });
  await admin('POST', '/api/my/password', { old: 'change-me-on-first-login', new: 'Adm!n-Regress-2026' });

  console.log('==== B1: 写入原子性与错误处理 (F06, F12, F38, F39) ====');
  // F38: 畸形 URL 编码不应挂死请求
  {
    let status = 0;
    try {
      const r = await fetch(BASE + '/%E0%A4%A', { signal: AbortSignal.timeout(1500) });
      status = r.status;
    } catch { status = -1; }
    ok('B1-F38: 畸形 URL 立即返回 400 而非挂死超时', status === 400, 'status=' + status);
  }
  // F39: 未登录改密应返 401 而非 500
  {
    const r = await anon('POST', '/api/my/password', { old: 'a', new: 'bbbbbbbb' });
    ok('B1-F39a: 未登录调用 /api/my/password 返回 401', r.status === 401, 'status=' + r.status);
  }
  // F39: 岗位重名应返 409 而非 500
  {
    await admin('POST', '/api/positions/save', { name: '测试岗B1', perms: ['student.view'] });
    const r = await admin('POST', '/api/positions/save', { name: '测试岗B1', perms: [] });
    ok('B1-F39b: 新建重名岗位返回 409 而非 500', r.status === 409, 'status=' + r.status);
  }
  // F39: 坏 xlsx 与旧版 .xls 返回 400 明确提示而非 500
  {
    const r1 = await admin('POST', '/api/students/import', { filename: 'bad.xlsx', b64: Buffer.from('not-a-zip').toString('base64') });
    ok('B1-F39c: 损坏的 xlsx 返回 400 而非 500', r1.status === 400, 'status=' + r1.status);
    const r2 = await admin('POST', '/api/students/import', { filename: 'old.xls', b64: Buffer.from('xxxx').toString('base64') });
    ok('B1-F39d: 上传 .xls 返回 400 且提示另存为 .xlsx', r2.status === 400 && /xlsx/.test(r2.j?.error || ''), r2.status + ' ' + r2.text);
  }
  // F06: 业务写入与自动审计在同一事务内（若自动审计写入失败，业务数据必须回滚）
  {
    const id1 = genId('13010219990101101');
    await admin('POST', '/api/checkin/confirm', { idcard: id1, name: '事务生', phone: '13800000101' });
    const stu = (await admin('GET', '/api/students?q=事务生')).j.students[0];
    // 在 SQLite 中注入触发器：当审计动作='缴费登记'时抛错，测试 fee_state/fee_log 是否回滚
    const db = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`CREATE TRIGGER fail_audit_fee BEFORE INSERT ON audit WHEN NEW.action='缴费登记' BEGIN SELECT RAISE(ABORT, 'audit disk full'); END;`);
    db.close();
    const r = await admin('POST', '/api/fees/set', { student_id: stu.id, item: '学费', amount: 3000, paid: true });
    const detail = (await admin('POST', '/api/student/detail', { id: stu.id })).j;
    const db2 = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db2.exec('PRAGMA busy_timeout=5000');
    db2.exec('DROP TRIGGER IF EXISTS fail_audit_fee');
    db2.close();
    ok('B1-F06: 自动审计失败时缴费业务写入同步回滚', r.status === 500 && detail.fees.length === 0, 'fees=' + JSON.stringify(detail.fees));
  }
  // F12: 成绩导入包裹在事务中，中途异常整体回滚
  {
    const id2 = genId('13010219990101103');
    await admin('POST', '/api/checkin/confirm', { idcard: id2, name: '成绩生', phone: '13800000102' });
    const db = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`CREATE TRIGGER fail_audit_score BEFORE INSERT ON audit WHEN NEW.action='导入成绩' BEGIN SELECT RAISE(ABORT, 'score audit fail'); END;`);
    db.close();
    const csv = Buffer.from(`身份证号,成绩\n${id2},95\n`, 'utf8').toString('base64');
    const r = await admin('POST', '/api/scores/import', { exam: 'B1模考', subject: '数学', filename: 's.csv', b64: csv });
    const db2 = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db2.exec('PRAGMA busy_timeout=5000');
    db2.exec('DROP TRIGGER IF EXISTS fail_audit_score');
    const scCnt = db2.prepare(`SELECT COUNT(*) AS n FROM scores WHERE exam='B1模考'`).get().n;
    db2.close();
    ok('B1-F12: 成绩导入与审计同事务，审计失败时已插入成绩整体回滚', r.status === 500 && scCnt === 0, 'scCnt=' + scCnt);
  }

  console.log('==== B2: 服务端状态机与业务守卫 (F02, F03, F04, F05) ====');
  {
    await admin('POST', '/api/dorms/save', { building: 'B2栋', floor: 1, room: '101', sex: '男', beds: 4 });
    await admin('POST', '/api/dorms/save', { building: 'B2栋', floor: 1, room: '102', sex: '女', beds: 4 });
    await admin('POST', '/api/dorms/save', { building: 'B2栋', floor: 1, room: '103', sex: '男', beds: 4 });
    const dorms = (await admin('GET', '/api/dorms')).j.dorms;
    const dM = dorms.find(d => d.building === 'B2栋' && d.room === '101');
    const dM2 = dorms.find(d => d.building === 'B2栋' && d.room === '103');
    const dF = dorms.find(d => d.building === 'B2栋' && d.sex === '女');

    // F03: 未开始离校不能直接 clean + refund 跳到已离校
    const idBypass = genId('13010219990101201');
    await admin('POST', '/api/checkin/confirm', { idcard: idBypass, name: '跳步生', phone: '13800000201' });
    const sBypass = (await admin('GET', '/api/students?q=跳步生')).j.students[0];
    const rCleanBypass = await admin('POST', '/api/depart/clean', { student_id: sBypass.id, pass: true });
    const rRefundBypass = await admin('POST', '/api/depart/refund', { student_id: sBypass.id, refund: 0 });
    const stAfterBypass = (await admin('POST', '/api/student/detail', { id: sBypass.id })).j.student.status;
    ok('B2-F03: 未开始离校直接 clean/refund 被拒 400 且状态不变', rCleanBypass.status === 400 && rRefundBypass.status === 400 && stAfterBypass === '报到中', `${rCleanBypass.status}/${rRefundBypass.status}/${stAfterBypass}`);

    // F02b: 已导入学生手动分宿转在训时自动补齐 checkin_at
    const idImp = genId('13010219990101203');
    const xlsxB64 = makeXlsx([['姓名', '身份证号', '手机号', '班级'], ['直分生', idImp, '13800000203', '一班']], 's').toString('base64');
    await admin('POST', '/api/students/import', { filename: 'b2.xlsx', b64: xlsxB64 });
    const sImp = (await admin('GET', '/api/students?q=直分生')).j.students[0];
    await admin('POST', '/api/dorm/assign', { student_id: sImp.id, dorm_id: (sImp.sex === '男' ? dM : dF).id });
    const detImp = (await admin('POST', '/api/student/detail', { id: sImp.id })).j.student;
    ok('B2-F02b: 已导入学生手动分宿舍后 checkin_at 自动补齐', detImp.status === '在训' && !!detImp.checkin_at, JSON.stringify(detImp));

    // F04a & F04b: 未领物资与已删目录孤儿记录不阻塞退押金
    await admin('POST', '/api/supplies/catalog', { name: 'B2未领物' });
    await admin('POST', '/api/supplies/catalog', { name: 'B2待删物' });
    const cats = (await admin('GET', '/api/supplies/catalog')).j.catalog;
    const cUnissued = cats.find(c => c.name === 'B2未领物');
    const cToDel = cats.find(c => c.name === 'B2待删物');
    await admin('POST', '/api/supply/set', { student_id: sImp.id, item_id: cUnissued.id, status: '未领' });
    await admin('POST', '/api/supply/set', { student_id: sImp.id, item_id: cToDel.id, status: '已领' });
    await admin('POST', '/api/supplies/catalog', { name: 'x', delete_id: cToDel.id });
    await admin('POST', '/api/depart/start', { student_id: sImp.id });
    // F02a(离校办理中分宿被拒)
    const rAssignDep = await admin('POST', '/api/dorm/assign', { student_id: sImp.id, dorm_id: dM2.id });
    await admin('POST', '/api/depart/clean', { student_id: sImp.id, pass: true });
    const rRefOk = await admin('POST', '/api/depart/refund', { student_id: sImp.id, refund: 0 });
    ok('B2-F04: 未领物资与已删目录孤儿记录不死锁退押金', rRefOk.status === 200, rRefOk.status + ' ' + rRefOk.text);

    // F02a: 已离校学生不能再分配或调换宿舍
    const rAssignLeft = await admin('POST', '/api/dorm/assign', { student_id: sImp.id, dorm_id: dM2.id });
    ok('B2-F02a: 离校办理中/已离校学生分配宿舍被拒 400', rAssignDep.status === 400 && rAssignLeft.status === 400, `${rAssignDep.status}/${rAssignLeft.status}`);

    // F05: 无 fee.edit 权限不能把已缴改回未缴绕过金额锁
    await admin('POST', '/api/positions/save', { name: '仅登记缴费岗', perms: ['student.view', 'fee.record'], scope: { type: 'all' } });
    const posId = (await admin('GET', '/api/positions')).j.positions.find(p => p.name === '仅登记缴费岗').id;
    await admin('POST', '/api/users/add', { name: '收费员', phone: '13800000209', position_id: posId });
    const feeClerk = client();
    await feeClerk('POST', '/api/login', { username: '13800000209', password: '000209' });
    await feeClerk('POST', '/api/my/password', { old: '000209', new: 'Clerk!2026' });
    await feeClerk('POST', '/api/fees/set', { student_id: sBypass.id, item: '学费', amount: 5000, paid: true });
    const step1 = await feeClerk('POST', '/api/fees/set', { student_id: sBypass.id, item: '学费', amount: 5000, paid: false });
    const feeAfter = (await admin('POST', '/api/student/detail', { id: sBypass.id })).j.fees.find(f => f.item === '学费');
    ok('B2-F05: 无 fee.edit 权限不能将已缴改回未缴', step1.status === 403 && feeAfter.paid === 1 && feeAfter.amount === 5000, `${step1.status} ${JSON.stringify(feeAfter)}`);
  }

  console.log('==== B3: 权限与会话边界 (F15, F16, F21) ====');
  {
    await admin('POST', '/api/positions/save', { name: '人事管理岗', perms: ['admin.users'], scope: { type: 'all' } });
    await admin('POST', '/api/positions/save', { name: '普通报表岗', perms: ['report.view'], scope: { type: 'all' } });
    await admin('POST', '/api/positions/save', { name: '一班成绩报表岗', perms: ['report.view', 'score.view'], scope: { type: 'classes', classes: ['一班'] } });
    const posList = (await admin('GET', '/api/positions')).j.positions;
    const hrPos = posList.find(p => p.name === '人事管理岗');
    const repPos = posList.find(p => p.name === '普通报表岗');
    const cls1Pos = posList.find(p => p.name === '一班成绩报表岗');

    await admin('POST', '/api/users/add', { name: '人事甲', phone: '13800000301', position_id: hrPos.id });
    await admin('POST', '/api/users/add', { name: '报表乙', phone: '13800000302', position_id: repPos.id });
    await admin('POST', '/api/users/add', { name: '一班丙', phone: '13800000303', position_id: cls1Pos.id });

    const loginAs = async (ph) => {
      const c = client();
      await c('POST', '/api/login', { username: ph, password: ph.slice(-6) });
      await c('POST', '/api/my/password', { old: ph.slice(-6), new: 'Pass!' + ph });
      return c;
    };
    const hr = await loginAs('13800000301');
    const rep = await loginAs('13800000302');
    const cls1 = await loginAs('13800000303');

    const users = (await admin('GET', '/api/users')).j.users;
    const adminUser = users.find(u => u.username === 'admin');
    const repUser = users.find(u => u.username === '13800000302');

    // F15a: 人事岗不能把校长降级到其他岗位
    const rDemote = await hr('POST', '/api/users/set', { id: adminUser.id, action: 'setpos', position_id: hrPos.id });
    ok('B3-F15a: 非校长账号不能修改校长岗位 (403)', rDemote.status === 403, 'status=' + rDemote.status);

    // F15b: 人事岗不能重置校长密码
    const rResetAdmin = await hr('POST', '/api/users/reset-pass', { id: adminUser.id });
    ok('B3-F15b: 非校长账号不能重置校长密码 (403)', rResetAdmin.status === 403, 'status=' + rResetAdmin.status);

    // F21: 重置普通员工密码后，其现有会话被 must_change=1 立即拦截（无新临时密码无法操作或改密）
    const rResetRep = await hr('POST', '/api/users/reset-pass', { id: repUser.id });
    const rRepAfterReset = await rep('GET', '/api/report/fees');
    const rRepBadPw = await rep('POST', '/api/my/password', { old: 'Pass!13800000302', new: 'HackPass!123' });
    ok('B3-F21: 重置员工密码后其原有会话立即被锁 (403) 且旧密码无法解锁', rResetRep.status === 200 && rRepAfterReset.status === 403 && rRepBadPw.status === 400, `reset=${rResetRep.status} after=${rRepAfterReset.status} badPw=${rRepBadPw.status}`);

    // 重新登录报表乙测试 F16a
    const rep2 = client();
    await rep2('POST', '/api/login', { username: '13800000302', password: rResetRep.j.password });
    await rep2('POST', '/api/my/password', { old: rResetRep.j.password, new: 'NewPass!302' });
    const rScoreNoPerm = await rep2('GET', '/api/report/scores?exam=B3模考');
    ok('B3-F16a: 无 score.view 权限访问 /api/report/scores 返回 403', rScoreNoPerm.status === 403, 'status=' + rScoreNoPerm.status);

    // F16b: 班级范围过滤 /api/report/scores
    const idC1 = genId('13010219990101301');
    const idC2 = genId('13010219990101303');
    const xB64 = makeXlsx([['姓名', '身份证号', '手机号', '班级'], ['一班生', idC1, '13900000301', '一班'], ['二班生', idC2, '13900000302', '二班']], 's').toString('base64');
    await admin('POST', '/api/students/import', { filename: 'b3.xlsx', b64: xB64 });
    const scCsv = Buffer.from(`身份证号,成绩\n${idC1},88\n${idC2},99\n`, 'utf8').toString('base64');
    await admin('POST', '/api/scores/import', { exam: 'B3模考', subject: '英语', filename: 'sc.csv', b64: scCsv });
    const rScoreCls1 = await cls1('GET', '/api/report/scores?exam=' + encodeURIComponent('B3模考'));
    ok('B3-F16b: 班级范围岗位在 /api/report/scores 仅见本班成绩', rScoreCls1.status === 200 && rScoreCls1.j.rows.length === 1 && rScoreCls1.j.rows[0].class_name === '一班', JSON.stringify(rScoreCls1.j));
  }

  console.log('==== B4: 身份证脱敏与 CSV 公式注入防护 (F17, F18, F19, F20) ====');
  {
    const idB4 = genId('13010219990101401');
    await admin('POST', '/api/checkin/confirm', { idcard: idB4, name: '脱敏生', phone: '13800000401' });
    const sB4 = (await admin('GET', '/api/students?q=脱敏生')).j.students[0];
    await admin('POST', '/api/student/edit', { id: sB4.id, phone: '13800000499' });
    // 刷卡两次触发正常分支与 duplicate 分支
    const tap1 = await admin('POST', '/api/att/tap', { idcard: idB4 });
    const tap2 = await admin('POST', '/api/att/tap', { idcard: idB4 });
    ok('B4-F18: 考勤重复刷卡响应不回传明文 18 位身份证', !/\b\d{17}[\dX]\b/.test( JSON.stringify(tap1.j) + JSON.stringify(tap2.j) ), JSON.stringify(tap2.j));

    const audRows = (await admin('GET', '/api/audit?limit=500')).j.rows;
    const rawIdInAudit = audRows.filter(r => /\b\d{17}[\dX]\b/i.test(String(r.target) + ' ' + String(r.detail)));
    ok('B4-F17: 审计日志 target 与 detail 均不落盘明文 18 位身份证', rawIdInAudit.length === 0, 'rawHits=' + rawIdInAudit.length);

    const editAudit = audRows.find(r => r.action === '编辑学生');
    ok('B4-F19: 编辑学生审计记录 target 非空且带脱敏标识', !!(editAudit && editAudit.target && editAudit.target.includes('****')), JSON.stringify(editAudit));

    // F20: CSV 公式注入防护
    await anon('POST', '/api/register', { username: 'csvinj1', name: '=HYPERLINK("http://evil","click")', password: 'Password!123' });
    const csvRes = await admin('GET', '/api/audit?format=csv&limit=50');
    const injLine = csvRes.text.split(/\r?\n/).find(l => l.includes('HYPERLINK')) || '';
    ok('B4-F20: CSV 导出对 =/+/-/@ 开头单元格前置单引号防公式注入', injLine.includes("'=HYPERLINK"), injLine);
  }

  console.log('==== B5: Excel/CSV 导入加固 (F01, F23, F40) ====');
  {
    // F01: 挑一个转成科学计数法后恰巧能通过校验位的 18 位身份证号，必须被拒绝而不能静默当成别人入库
    let trickySci = null;
    for (let i = 100; i < 500; i++) {
      const raw = genId('13010219990101' + String(i).padStart(3, '0'));
      const sci = Number(raw).toExponential(14).toUpperCase();
      const expanded = String(Number(sci));
      if (expanded !== raw && require('../lib/perm').checkIdcard(expanded).ok) {
        trickySci = sci;
        break;
      }
    }
    // 构造含数值型科学计数法单元格的 xlsx
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const sheetXml = head + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>身份证号</t></is></c><c r="C1" t="inlineStr"><is><t>手机号</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>丢精度生</t></is></c><c r="B2"><v>${trickySci}</v></c><c r="C2"><v>1.38E+10</v></c></row>` +
      `</sheetData></worksheet>`;
    // 借用 makeXlsx 结构替换 sheet1.xml
    const baseXlsx = makeXlsx([['姓名', '身份证号', '手机号']], 'Sheet1');
    // 直接测 CSV / XLSX 科学计数法拦截：先用带数值科学计数法单元格的自定义 zip
    const zlib = require('node:zlib');
    const buildSimpleXlsx = (xmlStr) => {
      const entries = [
        ['xl/worksheets/sheet1.xml', Buffer.from(xmlStr, 'utf8')],
      ];
      const chunks = [], central = []; let off = 0;
      for (const [name, data] of entries) {
        const nb = Buffer.from(name);
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
        chunks.push(lh, nb, data);
        const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
        central.push(Buffer.concat([ch, nb]));
        off += 30 + nb.length + data.length;
      }
      const cd = Buffer.concat(central);
      const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
      return Buffer.concat([...chunks, cd, eocd]);
    };
    const rSci = await admin('POST', '/api/students/import', { filename: 'sci.xlsx', b64: buildSimpleXlsx(sheetXml).toString('base64') });
    ok('B5-F01: Excel 科学计数法丢失精度的身份证号被精准拦截而非错当他人入库', rSci.status === 200 && rSci.j.ok === 0 && rSci.j.errors.length === 1 && /科学计数|文本/.test(rSci.j.errors[0].msg), JSON.stringify(rSci.j));

    // F40: GBK 编码 CSV 导入中文不乱码（整表 GBK：姓名,身份证号,手机号,班级\n张三,<id>,13800000501,一班）
    const idGbk = genId('13010219990101501');
    const gbkHead = Buffer.from([0xD0,0xD5,0xC3,0xFB, 0x2C, 0xC9,0xED,0xB7,0xDD,0xD6,0xA4,0xBA,0xC5, 0x2C, 0xCA,0xD6,0xBB,0xFA,0xBA,0xC5, 0x2C, 0xB0,0xE0,0xBC,0xB6, 0x0A]);
    const gbkName = Buffer.from([0xD5, 0xC5, 0xC8, 0xFD]); // "张三" in GBK
    const gbkCls = Buffer.from([0xD2, 0xBB, 0xB0, 0xE0]);  // "一班" in GBK
    const gbkCsv = Buffer.concat([
      gbkHead,
      gbkName,
      Buffer.from(`,${idGbk},13800000501,`, 'ascii'),
      gbkCls,
      Buffer.from('\n', 'ascii'),
    ]);
    const rGbk = await admin('POST', '/api/students/import', { filename: 'gbk.csv', b64: gbkCsv.toString('base64') });
    const stuGbk = (await admin('GET', '/api/students?q=' + idGbk)).j.students[0];
    ok('B5-F40: GBK 编码 CSV 导入姓名自动识别为「张三」无乱码', rGbk.status === 200 && rGbk.j.ok === 1 && stuGbk && stuGbk.name === '张三' && stuGbk.class_name === '一班', JSON.stringify(stuGbk));

    // F23: 压缩炸弹 xlsx 被 maxOutputLength 立即拒绝 (400)
    const big = Buffer.alloc(25 * 1024 * 1024, 0x61); // 25MB > 16MB limit
    const comp = zlib.deflateRawSync(big, { level: 9 });
    const nm = Buffer.from('xl/worksheets/sheet1.xml');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(big.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(big.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(0, 42);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(46 + nm.length, 12); eo.writeUInt32LE(30 + nm.length + comp.length, 16);
    const bombZip = Buffer.concat([lh, nm, comp, ch, nm, eo]);
    const rBomb = await admin('POST', '/api/students/import', { filename: 'bomb.xlsx', b64: bombZip.toString('base64') });
    ok('B5-F23: 超大解压体积 xlsx 压缩炸弹被 400 拒绝', rBomb.status === 400 && /超限|损坏/.test(rBomb.j?.error || ''), rBomb.status + ' ' + rBomb.text);
  }

  console.log('==== B6: 版本化迁移与恢复演练 (F07, F08, F09, F13) ====');
  {
    const { spawnSync } = require('node:child_process');
    // F13: dorm_assign 部分唯一索引防止同一学生出现两条 active=1 在住记录
    const db = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db.exec('PRAGMA busy_timeout=5000');
    let dupActiveBlocked = false;
    try {
      db.exec(`INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(99991,1,'2026-01-01','test',1)`);
      db.exec(`INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(99991,2,'2026-01-01','test',1)`);
    } catch (e) {
      dupActiveBlocked = /UNIQUE/i.test(String(e.message));
    } finally {
      try { db.exec('DELETE FROM dorm_assign WHERE student_id=99991'); } catch {}
      db.close();
    }
    ok('B6-F13: 数据库级部分唯一索引阻止同一学生存在多条 active=1 宿舍记录', dupActiveBlocked);

    // F07: 迁移工具支持 status / down / up 往返且数据无损
    const migDown = spawnSync(process.execPath, [path.join(ROOT, 'deploy', 'migrate.js'), 'down', '8'], {
      env: { ...process.env, LENEN_DATA: DATA },
      encoding: 'utf8',
    });
    const migUp = spawnSync(process.execPath, [path.join(ROOT, 'deploy', 'migrate.js'), 'up'], {
      env: { ...process.env, LENEN_DATA: DATA },
      encoding: 'utf8',
    });
    ok('B6-F07: deploy/migrate.js 支持回滚到 v8 再前滚到最新且退出码为 0', migDown.status === 0 && migUp.status === 0 && /v8/.test(migDown.stdout || '') && /v10/.test(migUp.stdout || ''), (migDown.stderr || '') + (migUp.stderr || ''));

    // F09: backup.js 使用北京时间命名且校验 integrity_check
    const bkRun = spawnSync(process.execPath, [path.join(ROOT, 'backup.js')], {
      env: { ...process.env, LENEN_DATA: DATA },
      encoding: 'utf8',
    });
    const cstToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const bakFiles = fs.readdirSync(path.join(DATA, 'backups')).filter(f => f.endsWith('.db'));
    ok('B6-F09: 备份文件名统一采用北京时间日期前缀，与 dailyBackup 判重时区一致', bkRun.status === 0 && bakFiles.some(f => f.startsWith('lenen-' + cstToday)), bakFiles.join(','));

    // F08: 真实起服恢复演练 deploy/restore-drill.js
    const drill = spawnSync(process.execPath, [path.join(ROOT, 'deploy', 'restore-drill.js')], {
      env: { ...process.env, LENEN_DATA: DATA },
      encoding: 'utf8',
    });
    ok('B6-F08: deploy/restore-drill.js 独立起服恢复演练通过（integrity + 行数/金额核对 + API 探活）', drill.status === 0 && /DRILL_OK/.test(drill.stdout || ''), (drill.stdout || '') + (drill.stderr || ''));
  }

  console.log('==== B7: 事件循环解锁与并发性能 (F22, F24, F25) ====');
  {
    // 准备 2200 名报到中学生与 150 间宿舍，测试：
    // 1) F25: /api/students 返回真实 total (>2000) 及 has_more 分页能力
    // 2) F22: /api/dorm/auto 在 2200 人规模下耗时 < 250ms（旧代码 N+1 查询耗时 ~1600-2200ms）
    // 3) F24: 16 并发未知账号登录期间，并发 /api/health 探针不被 scryptSync 串行阻塞 (< 120ms)
    const db = new DatabaseSync(path.join(DATA, 'lenen.db'));
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    const insStu = db.prepare(`INSERT OR IGNORE INTO students(idcard,name,sex,phone,class_name,status,checkin_at,created_at,created_by) VALUES(?,?,?,?,?,'报到中','2026-11-06T00:00:00Z','2026-11-06T00:00:00Z','bench')`);
    const insFee = db.prepare(`INSERT OR REPLACE INTO fee_state(student_id,item,amount,paid,at,by) VALUES(?,?,100,1,'2026-11-06T00:00:00Z','bench')`);
    for (let i = 0; i < 2100; i++) {
      const idc = genId('1305031997' + String(100000 + i).padStart(6, '0') + String(i % 10));
      const r = insStu.run(idc, '压测生' + i, (i % 2 === 0 ? '男' : '女'), '136' + String(10000000 + i), '压测班');
      const sid = Number(r.lastInsertRowid);
      if (sid > 0) {
        for (const it of ['报名费', '住宿费', '书费', '学费']) insFee.run(sid, it);
      }
    }
    const insDorm = db.prepare(`INSERT OR IGNORE INTO dorms(building,floor,room,sex,beds,bad) VALUES('P栋',?,?,?,8,0)`);
    for (let k = 1; k <= 80; k++) {
      insDorm.run(1 + (k % 5), 'M' + k, '男');
      insDorm.run(1 + (k % 5), 'F' + k, '女');
    }
    db.exec('COMMIT');
    db.close();

    // F25: /api/students 返回真实 total 与分页
    const sPage = await admin('GET', '/api/students');
    ok('B7-F25: /api/students 返回真实总数 total (>2000) 与 has_more 标志', typeof sPage.j.total === 'number' && sPage.j.total > 2100 && sPage.j.has_more === true, `total=${sPage.j.total} has_more=${sPage.j.has_more}`);

    // F22: /api/dorm/auto O(N) 内存分配，不再 N+1 阻塞事件循环
    const tAuto0 = performance.now();
    const rAuto = await admin('POST', '/api/dorm/auto', {});
    const autoMs = performance.now() - tAuto0;
    ok('B7-F22: 2100 名缴费齐报到生自动分宿耗时 < 200ms（消除 N+1 查询）', rAuto.status === 200 && rAuto.j.assigned >= 1200 && autoMs < 200, `assigned=${rAuto.j?.assigned} ms=${autoMs.toFixed(0)}`);

    // F24: 16 个并发未知用户登录时，异步 scrypt 不阻塞事件循环上的 /api/health
    const loginBatch = Promise.all(Array.from({ length: 16 }, (_, i) => anon('POST', '/api/login', { username: 'nonexist_' + i, password: 'badpassword' })));
    await sleep(10);
    const tHealth0 = performance.now();
    await anon('GET', '/api/health');
    const healthWaitMs = performance.now() - tHealth0;
    await loginBatch;
    ok('B7-F24: 16 并发登录期间 /api/health 响应延迟 < 80ms（异步 scrypt 不独占事件循环）', healthWaitMs < 80, `healthWaitMs=${healthWaitMs.toFixed(0)}`);

    // 清理压测数据，以免影响后续批次恢复演练速度
    const dbClean = new DatabaseSync(path.join(DATA, 'lenen.db'));
    dbClean.exec('PRAGMA busy_timeout=5000');
    dbClean.exec(`
      DELETE FROM dorm_assign WHERE student_id IN (SELECT id FROM students WHERE created_by='bench');
      DELETE FROM fee_state WHERE by='bench';
      DELETE FROM students WHERE created_by='bench';
      DELETE FROM dorms WHERE building='P栋';
    `);
    dbClean.close();
  }

  console.log('==== B8: 弱网幂等去重与前台手感防丢输入 (F11, F34, F35) ====');
  {
    const idB8 = genId('13010219990101801');
    await admin('POST', '/api/checkin/confirm', { idcard: idB8, name: '幂等生', phone: '13800000801' });
    const sB8 = (await admin('GET', '/api/students?q=幂等生')).j.students[0];
    await admin('POST', '/api/books/catalog', { name: 'B8高数' });
    const bkB8 = (await admin('GET', '/api/books/catalog')).j.catalog.find(b => b.name === 'B8高数');

    // F11a: 相同 X-Req-Id 重放 /api/book/give 不会重复累加发书计数
    const reqIdBook = 'req-b8-book-001';
    const bRes1 = await admin('POST', '/api/book/give', { student_id: sB8.id, book_id: bkB8.id }, { headers: { 'X-Req-Id': reqIdBook } });
    const bRes2 = await admin('POST', '/api/book/give', { student_id: sB8.id, book_id: bkB8.id }, { headers: { 'X-Req-Id': reqIdBook } });
    ok('B8-F11a: 携带相同 X-Req-Id 重试 /api/book/give 幂等返回 count=1', bRes1.j.count === 1 && bRes2.j.count === 1, `c1=${bRes1.j?.count} c2=${bRes2.j?.count}`);

    // F11b: 相同 X-Req-Id 重放 /api/fees/set 不会在 fee_log 产生重复流水
    const reqIdFee = 'req-b8-fee-001';
    await admin('POST', '/api/fees/set', { student_id: sB8.id, item: '书费', amount: 260, paid: true }, { headers: { 'X-Req-Id': reqIdFee } });
    await admin('POST', '/api/fees/set', { student_id: sB8.id, item: '书费', amount: 260, paid: true }, { headers: { 'X-Req-Id': reqIdFee } });
    const db = new DatabaseSync(path.join(DATA, 'lenen.db'), { readOnly: true });
    const logCnt = db.prepare(`SELECT COUNT(*) AS n FROM fee_log WHERE student_id=? AND item='书费'`).get(sB8.id).n;
    db.close();
    ok('B8-F11b: 携带相同 X-Req-Id 重试 /api/fees/set 仅写 1 条 fee_log 流水', logCnt === 1, 'logCnt=' + logCnt);

    // F34 & F35: 前端代码包含 AbortSignal.timeout、中文网络错误转换、按钮防连点与成功后清空输入
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    ok('B8-F34: 前端 api() 具备超时控制、按钮防连点与中文网络异常提示', appSrc.includes('AbortSignal.timeout') && appSrc.includes('网络连接超时或不稳定') && appSrc.includes('X-Req-Id'));
    ok('B8-F35: 报到与考勤输入框仅在请求成功后清空，网络失败不丢已输身份证号', !appSrc.includes("const idcard = input.value.trim(); input.value = '';"));
  }

  console.log('==== B9: 部署硬化与深度健康检查 (F33, F36, F37) ====');
  {
    const { spawnSync } = require('node:child_process');
    // F37: /api/health 真实探测 SQLite 并返回 db_ok 与 schema_version
    const hRes = await anon('GET', '/api/health');
    ok('B9-F37: /api/health 探测 SQLite 返回 db_ok=true 与 schema_version=10', hRes.status === 200 && hRes.j.db_ok === true && hRes.j.schema_version === 10, JSON.stringify(hRes.j));

    // F36a: 端口被占用时第二实例必须以非 0 退出码退出（供计划任务/systemd 感知失败）
    const dupSrv = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, LENEN_PORT: String(PORT), LENEN_DATA: DATA },
      timeout: 4000,
      encoding: 'utf8',
    });
    ok('B9-F36a: 端口占用时 server.js 以非 0 状态码退出 (code=1)', dupSrv.status === 1, 'status=' + dupSrv.status);

    // F36b: deploy/setup-tasks.js 备份任务包含 /RU SYSTEM（无需桌面登录也可在 23:30 备份）
    const tasksSrc = fs.readFileSync(path.join(ROOT, 'deploy', 'setup-tasks.js'), 'utf8');
    ok('B9-F36b: deploy/setup-tasks.js 每日备份任务配置 /RU SYSTEM', (tasksSrc.match(/'SYSTEM'/g) || []).length >= 2);

    // F36c: 提供 Linux systemd 服务单元 deploy/lenen.service 且 server.js 错误日志脱敏身份证号
    const hasService = fs.existsSync(path.join(ROOT, 'deploy', 'lenen.service'));
    const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok('B9-F36c: 提供 deploy/lenen.service 且 server.js 异常日志调用 scrubIdcards 脱敏', hasService && srvSrc.includes('scrubIdcards'));
  }

  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  console.log(`\nREGRESS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async e => {
  console.error('REGRESS CRASH:', e);
  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
