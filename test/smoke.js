'use strict';
/* 端到端冒烟测试：可直接 node test/smoke.js（若 8790 未起服则自动启动临时实例并清理） */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.LENEN_PORT || 8790);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, '_data_smoke');
let srv = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function ensureServer() {
  try {
    const r = await fetch(BASE + '/api/health');
    if (r.ok) return;
  } catch {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, LENEN_PORT: String(PORT), LENEN_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('smoke test server failed to start');
}
async function stopServer() {
  if (!srv) return;
  await new Promise(r => { srv.once('exit', r); srv.kill(); });
  srv = null;
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
let cookie = '';
let passed = 0, failed = 0;
async function call(method, p, body) {
  const opt = { method, headers: {} };
  if (cookie) opt.headers.Cookie = cookie;
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) { const j = await r.json(); return { status: r.status, j }; }
  return { status: r.status, text: await r.text() };
}
function ok(name, cond, extra) { if (cond) { passed++; console.log('  [ok]', name); } else { failed++; console.log('  [FAIL]', name, extra || ''); } }

(async () => {
  await ensureServer();
  // 1. 登录
  let r = await call('POST', '/api/login', { username: 'admin', password: 'change-me-on-first-login' });
  ok('校长登录', r.status === 200 && r.j.user.perms.length > 0, JSON.stringify(r.j));
  await call('POST', '/api/my/password', { old: 'change-me-on-first-login', new: 'smoke-admin-pass' }); // 服务端强制改密：先改密再继续
  // 2. 建岗位+员工
  r = await call('POST', '/api/positions/save', { name: '前台', perms: ['student.view', 'student.edit', 'student.import', 'fee.record', 'dorm.assign', 'att.view', 'leave.record', 'supply.record', 'book.give', 'depart.process'], scope: { type: 'all' } });
  ok('建岗位', r.status === 200);
  const pos = (await call('GET', '/api/positions')).j.positions.find(p => p.name === '前台');
  ok('岗位读回', !!pos);
  r = await call('POST', '/api/register', { username: 'front1', name: '前台甲', password: 'front-test-pass' });
  ok('自助注册', r.status === 200);
  const users = (await call('GET', '/api/users')).j.users;
  const f1 = users.find(u => u.username === 'front1');
  r = await call('POST', '/api/users/set', { id: f1.id, action: 'activate', position_id: pos.id });
  ok('激活员工', r.status === 200);
  // 3. 导入学生（含 1 错误行）
  const csv = '姓名,身份证号,手机号,班级\n张伟,130503196704015618,13800000001,临床一班\n李娜,130503199203044529,13800000002,临床一班\n王强,110101199003077774,13800000003,临床二班\n赵敏,130503199505061121,13800000004,临床一班\n错误行,12345,13800000005,临床一班\n';
  r = await call('POST', '/api/students/import', { filename: 's.csv', b64: Buffer.from(csv).toString('base64') });
  ok('导入学生', r.status === 200 && r.j.ok === 4 && r.j.errors.length === 1, JSON.stringify(r.j));
  // 性别从身份证推导
  const stus = (await call('GET', '/api/students?q=临床一班')).j.students;
  const zhang = stus.find(s => s.name === '张伟'), li = stus.find(s => s.name === '李娜'), zhao = stus.find(s => s.name === '赵敏');
  ok('性别推导(张伟=男,李娜=女)', zhang.sex === '男' && li.sex === '女', `${zhang.sex}/${li.sex}`);
  // 4. 报到（张伟：建档路径跳过，直接确认）
  r = await call('POST', '/api/checkin/confirm', { idcard: zhang.idcard, phone: '13900000001', photo_b64: Buffer.from('fakejpeg').toString('base64') });
  ok('张伟报到+拍照', r.status === 200 && r.j.student.status === '报到中', JSON.stringify(r.j));
  r = await call('POST', '/api/checkin/confirm', { idcard: zhang.idcard, phone: '13900000001' });
  ok('重复报到仍可(补照片/电话)', r.status === 200);
  // 状态机：报到后已在报到中，缴费齐 → 自动分配
  for (const item of ['报名费', '住宿费', '书费', '学费', '押金']) {
    r = await call('POST', '/api/fees/set', { student_id: zhang.id, item, amount: item === '押金' ? 200 : 1000, paid: true, method: '现金' });
  }
  ok('张伟缴费登记', r.j.fee_ok === true, JSON.stringify(r.j));
  // 李娜、赵敏报到并缴费
  for (const s of [li, zhao]) {
    await call('POST', '/api/checkin/confirm', { idcard: s.idcard, phone: '139' + String(s.idcard).slice(8, 16) });
    for (const item of ['报名费', '住宿费', '书费', '学费', '押金']) await call('POST', '/api/fees/set', { student_id: s.id, item, amount: 500, paid: true, method: '转账' });
  }
  // 5. 宿舍
  r = await call('POST', '/api/dorms/save', { building: '1号楼', floor: 2, room: '201', sex: '男', beds: 2 });
  ok('建男宿', r.status === 200);
  r = await call('POST', '/api/dorms/save', { building: '1号楼', floor: 3, room: '301', sex: '女', beds: 2 });
  ok('建女宿', r.status === 200);
  await call('POST', '/api/dorms/save', { building: '2号楼', floor: 1, room: '102', sex: '男', beds: 2 });
  r = await call('POST', '/api/dorm/auto', {});
  ok('自动分配3人', r.j.assigned === 3 && r.j.skipped.length === 0, JSON.stringify(r.j));
  r = await call('POST', '/api/dorm/swap', { a: zhang.id, b: li.id });
  ok('异性调换被拒', r.status === 400);
  const wang = (await call('GET', '/api/students?q=王强')).j.students[0];
  await call('POST', '/api/checkin/confirm', { idcard: wang.idcard, phone: '13900000003' });
  for (const item of ['报名费', '住宿费', '书费', '学费', '押金']) await call('POST', '/api/fees/set', { student_id: wang.id, item, amount: 500, paid: true, method: '现金' });
  r = await call('POST', '/api/dorm/auto', {});
  ok('王强进男宿(剩1床)', r.j.assigned === 1, JSON.stringify(r.j));
  // 手动把王强调到 2号楼102，制造跨宿舍调换场景
  const dormsNow = (await call('GET', '/api/dorms')).j.dorms;
  const d2 = dormsNow.find(d => d.building === '2号楼');
  r = await call('POST', '/api/dorm/assign', { student_id: wang.id, dorm_id: d2.id });
  ok('手动分配到2号楼', r.status === 200, JSON.stringify(r.j));
  // 调换张伟↔王强（同性别）
  r = await call('POST', '/api/dorm/swap', { a: zhang.id, b: wang.id });
  ok('同性调换成功', r.status === 200, JSON.stringify(r.j));
  // 6. 考勤
  r = await call('POST', '/api/att/tap', { idcard: zhang.idcard });
  ok('张伟打卡+照片核验', r.j.known && r.j.has_photo === true, JSON.stringify(r.j));
  r = await call('POST', '/api/att/tap', { idcard: zhang.idcard });
  ok('重复打卡提示', r.j.duplicate === true);
  r = await call('POST', '/api/att/tap', { idcard: '110101198901012345' });
  ok('陌生号码=不是我们的人', r.j.known === false);
  // 7. 请假销假
  const t = new Date().toLocaleDateString('sv-SE');
  r = await call('POST', '/api/leave/add', { student_id: li.id, from: t, to: t, reason: '生病' });
  ok('登记请假', r.status === 200);
  r = await call('POST', '/api/att/tap', { idcard: li.idcard });
  ok('请假期间刷卡有标记', r.j.leave_open === true);
  const leavesR = await call('GET', '/api/leaves?open=1'); const leaves = leavesR.j.leaves; if (!leaves) console.log('DEBUG leaves:', leavesR.status, JSON.stringify(leavesR).slice(0, 300));
  r = await call('POST', '/api/leave/close', { id: leaves[0].id });
  ok('销假', r.status === 200);
  // 8. 物资 + 发书
  await call('POST', '/api/supplies/catalog', { name: '床单被罩' });
  await call('POST', '/api/supplies/catalog', { name: '白大褂' });
  r = await call('POST', '/api/supply/set', { student_id: zhang.id, item_id: 1, status: '已领' });
  ok('物资已领', r.status === 200);
  await call('POST', '/api/books/catalog', { name: '解剖学' });
  r = await call('POST', '/api/book/give', { student_id: zhang.id, book_id: 1 });
  ok('发书计数', r.j.count === 1);
  r = await call('POST', '/api/book/give', { student_id: zhang.id, book_id: 1 });
  ok('再发一本', r.j.count === 2);
  // 9. 成绩导入（CSV 列映射）
  const scsv = '身份证号,分数\n' + zhang.idcard + ',85\n' + li.idcard + ',92\n';
  r = await call('POST', '/api/scores/import', { filename: 'x.csv', b64: Buffer.from(scsv).toString('base64'), exam: '入学模考一', subject: '行测' });
  ok('成绩导入', r.j.ok === 2, JSON.stringify(r.j));
  // 10. 离校（张伟：物资收回→卫生通过→退押金）
  r = await call('POST', '/api/depart/start', { student_id: zhang.id });
  ok('开始离校', r.status === 200);
  r = await call('POST', '/api/depart/refund', { student_id: zhang.id, refund: 200 });
  ok('物资未收完拒退押金', r.status === 400, JSON.stringify(r.j));
  r = await call('POST', '/api/depart/supply', { student_id: zhang.id, item_id: 1 });
  r = await call('POST', '/api/depart/supply', { student_id: zhang.id, item_id: 2 });
  r = await call('POST', '/api/depart/refund', { student_id: zhang.id, refund: 200 });
  ok('卫生未过拒退押金', r.status === 400);
  await call('POST', '/api/depart/clean', { student_id: zhang.id, pass: true, note: '干净' });
  r = await call('POST', '/api/depart/refund', { student_id: zhang.id, refund: 200 });
  ok('退押金完成离校', r.status === 200);
  const zhangAfter = (await call('GET', '/api/students?q=张伟')).j.students[0];
  ok('状态=已离校', zhangAfter.status === '已离校');
  r = await call('POST', '/api/att/tap', { idcard: zhang.idcard });
  ok('离校学生打卡被拒', r.j.refused === true);
  // 11. 报表与审计
  r = await call('GET', '/api/report/fees');
  ok('缴费报表', r.status === 200 && r.j.items.length === 5);
  r = await call('GET', '/api/report/attendance');
  ok('缺勤报表', r.status === 200);
  r = await call('GET', '/api/audit?limit=50');
  ok('审计有记录', r.j.rows && r.j.rows.length > 10, JSON.stringify(r.j).slice(0, 300));
  // 12. 权限验证：前台账号无 admin.users
  const adminCookie = cookie;
  await call('POST', '/api/logout');
  r = await call('POST', '/api/login', { username: 'front1', password: 'front-test-pass' });
  ok('前台登录', r.status === 200);
  r = await call('GET', '/api/users');
  ok('前台无员工管理权限(403)', r.status === 403);
  r = await call('GET', '/api/students');
  ok('前台可看学生', r.status === 200);
  r = await call('POST', '/api/fees/set', { student_id: li.id, item: '报名费', amount: 1, paid: true });
  ok('前台无改已缴金额权限(403)', r.status === 403, JSON.stringify(r.j));
  cookie = adminCookie;
  // 13. 未登录拦截
  const saved = cookie; cookie = '';
  r = await call('GET', '/api/students');
  ok('未登录401', r.status === 401);
  cookie = saved;
  console.log(`\nSMOKE: ${passed} passed, ${failed} failed`);
  await stopServer();
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error('SMOKE-CRASH', e); await stopServer(); process.exit(1); });
