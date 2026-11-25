'use strict';
/* v1.3.4 全功能实操审查（人肉旅程级）：起干净实例 → 校长/前台/宿管三角色全流程走一遍。
   运行：LENEN_PORT=8796 node test/audit.js   （自起自停，数据在临时目录） */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeXlsx, parseSpreadsheet, toCsv } = require('../lib/xlsxmini');

const PORT = Number(process.env.LENEN_PORT) || 8796;
const BASE = 'http://127.0.0.1:' + PORT;
const OWN_DATA = !process.env.AUDIT_DATA;
const AUDIT_DATA = process.env.AUDIT_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lenen-audit-'));
process.env.AUDIT_DATA = AUDIT_DATA;
let srv = null;
function startServer() {
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, LENEN_PORT: String(PORT), LENEN_DATA: AUDIT_DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
async function ensureServer() {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
  startServer();
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('audit.js 自起服务超时');
}
async function stopServer() {
  if (srv) { await new Promise(r => { srv.once('exit', r); srv.kill(); }); srv = null; }
  if (OWN_DATA) { try { fs.rmSync(AUDIT_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}
let pass = 0, fail = 0; const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- 身份证生成（过 GB 校验码）---- */
function genId(base17) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const c = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base17[i]) * w[i];
  return base17 + c[sum % 11];
}
const ID = {
  张伟: '130503196704015618', // 男 一班
  李娜: '130503199203044529', // 女 一班
  王强: '110101199003077774', // 男 二班
  赵敏: '130503199505061121', // 女 一班
  钱进: genId('11010120000101123'), // 男（新建档用）
  孙杰: genId('13050319980304442'), // 女 一班
  male2: genId('11010119950506273'), // 男（满床测试用）
  stranger: '110101198901012345', // 合法但不在库（女）
};
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/* ---- 会话罐 ---- */
function Jar() { this.sid = null; }
Jar.prototype.cookie = function () { return this.sid ? 'lenen_sid=' + this.sid : ''; };
async function call(jar, method, p, body, extraHeaders) {
  const headers = { ...(extraHeaders || {}) };
  if (jar && jar.sid) headers.cookie = jar.cookie();
  const opt = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; opt.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (jar && sc.length) { const m = /lenen_sid=([^;]*)/.exec(sc[0]); if (m) jar.sid = m[1]; }
  const ct = r.headers.get('content-type') || '';
  const j = ct.includes('json') ? await r.json().catch(() => null) : null;
  return { status: r.status, j, headers: r.headers, buf: j ? null : Buffer.from(await r.arrayBuffer()) };
}
const POST = (jar, p, body, eh) => call(jar, 'POST', p, body, eh);
const GET = (jar, p) => call(jar, 'GET', p);

async function login(username, password) {
  const jar = new Jar();
  const r = await POST(jar, '/api/login', { username, password });
  return { jar, r };
}

(async () => {
  await ensureServer();
  /* ============ S0 静态资源与未登录 ============ */
  console.log('---- S0 静态/未登录 ----');
  const idx = await call(null, 'GET', '/');
  ok(idx.status === 200 && /app\.js\?v=10/.test(idx.buf.toString()) && /shoelace\.js/.test(idx.buf.toString()), '首页含 app.js?v=10 与 shoelace');
  ok((idx.headers.get('cache-control') || '') === 'no-cache', '首页 no-cache');
  const appjs = await GET(null, '/app.js?v=10');
  ok(appjs.status === 200 && /immutable/.test(appjs.headers.get('cache-control') || ''), 'app.js 带版本=immutable 长缓存');
  const css = await GET(null, '/style.css?v=10');
  ok(css.status === 200 && /immutable/.test(css.headers.get('cache-control') || ''), 'style.css?v=10 200 immutable');
  const css2 = await GET(null, '/style.css');
  ok(/max-age=3600/.test(css2.headers.get('cache-control') || ''), '无版本 css=1h 缓存');
  const shoe = await GET(null, '/vendor/shoelace/shoelace.js');
  ok(shoe.status === 200 && /immutable/.test(shoe.headers.get('cache-control') || ''), 'vendor/shoelace.js 200 immutable');
  const theme = await GET(null, '/vendor/shoelace/themes/light.css');
  ok(theme.status === 200, 'shoelace 主题 light.css 200');
  const icons = await GET(null, '/vendor/icons.js');
  ok(icons.status === 200, 'icons.js 200');
  const spa = await GET(null, '/some/unknown/page');
  ok(spa.status === 200 && /text\/html/.test(spa.headers.get('content-type') || ''), 'SPA 回退：未知路径返回首页');
  const gz = await call(null, 'GET', '/app.js?v=10', undefined, { 'accept-encoding': 'gzip' });
  ok(gz.headers.get('content-encoding') === 'gzip', '静态 gzip 生效');
  const me0 = await GET(null, '/api/me');
  ok(me0.status === 200 && me0.j.user === null && me0.j.version === '1.3.8', '/api/me 未登录 user=null version=1.3.5');
  ok((me0.headers.get('x-content-type-options') || '') === 'nosniff' && !me0.headers.get('x-frame-options'), '安全头 nosniff 在位且无 XFO（手机 iframe 访问兼容）');
  ok(/default-src/.test(idx.headers.get('content-security-policy') || '') && !/frame-ancestors/.test(idx.headers.get('content-security-policy') || ''), '入口页 CSP 在位且不锁 iframe');
  const h0 = await GET(null, '/api/health');
  ok(h0.status === 200 && h0.j.ok === true && h0.j.version === '1.3.8', '健康检查 /api/health 免登录');
  const meStore = await GET(null, '/api/students');
  ok(/no-store/.test(meStore.headers.get('cache-control') || ''), 'API 响应 no-store');
  const anon401 = await GET(null, '/api/students');
  ok(anon401.status === 401, '未登录访问业务接口 401');
  const nf = await GET(null, '/api/nope');
  ok(nf.status === 404, '未知接口 404');
  const badjson = await POST(new Jar(), '/api/login', '{bad json');
  ok(badjson.status === 400, '非法 JSON 400');
  const big = await POST(new Jar(), '/api/login', JSON.stringify({ x: 'y'.repeat(9 * 1024 * 1024) }));
  ok(big.status === 413, '请求体 >8MB → 413');

  /* 登录锁定（用 ghost 账号试，不动 admin） */
  for (let i = 0; i < 5; i++) await POST(new Jar(), '/api/login', { username: 'ghost', password: 'wrong-' + i });
  const locked = await POST(new Jar(), '/api/login', { username: 'ghost', password: 'wrong-5' });
  ok(locked.status === 429 && /秒后再试/.test(locked.j.error), '连错 5 次触发锁定 429');

  /* 跨站 Origin 防护 */
  const cs = await POST(new Jar(), '/api/login', { username: 'admin', password: 'change-me-on-first-login' }, { origin: 'https://evil.example.com' });
  ok(cs.status === 403 && /跨站/.test(cs.j.error), '异源 POST 403 拒绝');
  const cs2 = await POST(new Jar(), '/api/login', { username: 'admin', password: 'change-me-on-first-login' }, { origin: 'https://evil.example.com/?x=http://127.0.0.1:' + PORT });
  ok(cs2.status === 403, '修复②验证：Origin 藏宿主参数仍被拒（严格比对，原来可绕过）');

  /* ============ S1 校长首登强制改密 ============ */
  console.log('---- S1 校长登录/强制改密 ----');
  const a1 = await login('admin', 'change-me-on-first-login');
  ok(a1.r.status === 200 && a1.r.j.user.must_change === true, 'admin 初始密码登录成功 must_change=true');
  ok(a1.r.j.user.perms.length === 23 && a1.r.j.user.scope.type === 'all', '校长 23 项权限+全部范围');
  ok(/HttpOnly/.test(a1.r.headers.get('set-cookie') || ''), 'Cookie 带 HttpOnly');
  const A = a1.jar;
  const kn7 = await GET(A, '/api/students');
  ok(kn7.status === 403 && /先修改初始密码/.test(kn7.j.error || ''), '修复⑦验证：must_change=1 业务接口 403（服务端强制，原来可绕过）');
  const meExempt = await GET(A, '/api/me');
  ok(meExempt.status === 200 && meExempt.j.user && meExempt.j.user.must_change === true, '强制改密期间 /api/me 放行');
  const pwWrongOld = await POST(A, '/api/my/password', { old: 'bad-old', new: 'Adm!n-2026-Strong' });
  ok(pwWrongOld.status === 400, '改密：原密码不对 400');
  const pwShort = await POST(A, '/api/my/password', { old: 'change-me-on-first-login', new: 'short7' });
  ok(pwShort.status === 400, '改密：新密码 <8 位 400');
  const pwOk = await POST(A, '/api/my/password', { old: 'change-me-on-first-login', new: 'Adm!n-2026-Strong' });
  ok(pwOk.status === 200, '改密成功 200');
  const reOld = await login('admin', 'change-me-on-first-login');
  ok(reOld.r.status === 401, '旧密码登录 401');
  const reNew = await login('admin', 'Adm!n-2026-Strong');
  ok(reNew.r.status === 200 && reNew.r.j.user.must_change === false, '新密码登录成功 must_change=false');
  await POST(reNew.jar, '/api/logout', {});
  const meAfterOut = await GET(reNew.jar, '/api/me');
  ok(meAfterOut.j.user === null, '注销后 /api/me 为 null');
  const A2 = (await login('admin', 'Adm!n-2026-Strong')).jar; // 主会话

  /* ============ S2 岗位与员工 ============ */
  console.log('---- S2 岗位/员工管理 ----');
  const pos0 = await GET(A2, '/api/positions');
  ok(pos0.j.positions.length === 1 && pos0.j.positions[0].name === '校长' && pos0.j.positions[0].system === 1, '初始仅系统岗位「校长」');
  ok(pos0.j.permList.length === 23 && pos0.j.groups.length === 10, '权限点目录 23 项/10 组');
  const zrId = pos0.j.positions[0].id;
  const editSys = await POST(A2, '/api/positions/save', { id: zrId, name: '校长改', perms: [] });
  ok(editSys.status === 400, '系统岗位不可修改 400');
  const delSys = await POST(A2, '/api/positions/delete', { id: zrId });
  ok(delSys.status === 400, '系统岗位不可删除 400');
  await POST(A2, '/api/positions/save', { name: '前台', perms: ['student.view', 'student.edit', 'student.import', 'fee.record', 'att.view', 'report.view', 'leave.record', 'leave.close'], scope: { type: 'classes', classes: ['临床一班'] } });
  await POST(A2, '/api/positions/save', { name: '宿管', perms: ['student.view', 'dorm.assign', 'dorm.manage', 'att.view'], scope: { type: 'all' } });
  const pos1 = await GET(A2, '/api/positions');
  const front = pos1.j.positions.find(p => p.name === '前台');
  const house = pos1.j.positions.find(p => p.name === '宿管');
  ok(front && front.scope.type === 'classes' && front.scope.classes[0] === '临床一班', '前台岗位=班级范围 临床一班');
  ok(house && house.scope.type === 'all', '宿管岗位=全部范围');
  const dupPos = await POST(A2, '/api/positions/save', { name: '前台', perms: [] });
  ok(dupPos.status === 500 || dupPos.status === 409, '岗位重名被拒（' + dupPos.status + '）');

  const u1 = await POST(A2, '/api/users/add', { name: '王前台', phone: '13800000001', position_id: front.id });
  ok(u1.status === 200 && u1.j.initpass === '000001' && /已创建并激活/.test(u1.j.msg), '新增员工=手机号+岗位直激活，初始密码=后6位');
  const u2 = await POST(A2, '/api/users/add', { name: '李宿管', phone: '13800000002', position_id: house.id });
  ok(u2.status === 200, '新增宿管');
  const u3 = await POST(A2, '/api/users/add', { name: '赵待激活', phone: '13800000003' });
  ok(u3.status === 200 && /待激活/.test(u3.j.msg), '无岗位新增=待激活');
  ok((await POST(A2, '/api/users/add', { name: 'x', phone: '123' })).status === 400, '手机号格式错 400');
  ok((await POST(A2, '/api/users/add', { name: 'x', phone: '13800000001' })).status === 409, '手机号重复 409');
  ok((await POST(A2, '/api/users/add', { name: 'x', phone: '13800000009', position_id: zrId })).status === 400, '不能分配校长岗位 400');
  const utpl = await GET(A2, '/api/users/template');
  ok(utpl.status === 200 && parseSpreadsheet('t.xlsx', utpl.buf.toString('base64'))[0][0] === '姓名', '员工模板真 xlsx 可回读');

  const urows = [['姓名', '手机号', '岗位'], ['张三丰', '13900000001', '前台'], ['李四', 'badphone', '前台'], ['王五', '13800000001', '前台']];
  const uimp = await POST(A2, '/api/users/import', { filename: 'u.xlsx', b64: makeXlsx(urows).toString('base64') });
  ok(uimp.j.ok === 1 && uimp.j.activated === 1 && uimp.j.errors.length === 2, '员工批量导入：1 成功直激活+2 错误行');

  const f1 = await login('13800000001', '000001');
  ok(f1.r.status === 200 && f1.r.j.user.must_change === true, '前台初始密码登录 must_change=true');
  await POST(f1.jar, '/api/my/password', { old: '000001', new: 'qt-2026-Strong!' });
  const f2 = await login('13800000001', 'qt-2026-Strong!');
  ok(f2.r.status === 200 && f2.r.j.user.position === '前台', '前台改密后登录成功');
  const F = f2.jar;
  ok(F && f2.r.j.user.scope.type === 'classes', '前台会话范围=班级');
  const h1 = await login('13800000002', '000002');
  await POST(h1.jar, '/api/my/password', { old: '000002', new: 'sg-2026-Strong' });
  const H = (await login('13800000002', 'sg-2026-Strong')).jar;
  ok(H !== null, '宿管就绪');

  const pLogin = await login('13800000003', '000003');
  ok(pLogin.r.status === 403 && /待校长激活/.test(pLogin.r.j.error), '待激活账号登录 403');
  const act = await POST(A2, '/api/users/set', { id: 4, action: 'activate', position_id: house.id });
  ok(act.status === 200, '激活待激活员工');
  const z1 = await login('13800000003', '000003');
  ok(z1.r.status === 200, '激活后可登录');
  let Z = z1.jar;
  await POST(Z, '/api/my/password', { old: '000003', new: 'zhao-2026-ok' });
  const noPos = await POST(A2, '/api/users/set', { id: 4, action: 'activate', position_id: '' });
  ok(noPos.status === 400, '激活必须分配岗位 400');
  const dis = await POST(A2, '/api/users/set', { id: 4, action: 'disable' });
  ok(dis.status === 200, '停用员工');
  const z2 = await GET(Z, '/api/students');
  ok(z2.status === 401, '停用后旧会话立即失效 401');
  ok((await login('13800000003', 'zhao-2026-ok')).r.status === 403, '停用后登录 403 已停用');
  await POST(A2, '/api/users/set', { id: 4, action: 'enable' });
  ok((await login('13800000003', 'zhao-2026-ok')).r.status === 200, '启用后可再登录');
  const disAdmin = await POST(A2, '/api/users/set', { id: 1, action: 'disable' });
  ok(disAdmin.status === 400, '不能停用校长 400');
  const rp = await POST(A2, '/api/users/reset-pass', { id: 4 });
  ok(rp.status === 200 && rp.j.password.length >= 8, '重置密码返回随机密码');
  const zRe = await login('13800000003', rp.j.password);
  ok(zRe.r.status === 200, '重置后的密码可登录（must_change=1）');
  await POST(zRe.jar, '/api/my/password', { old: rp.j.password, new: 'zhao-2026-v2' }); // 服务端强制改密：先改密再继续
  Z = zRe.jar;
  const ulist = await GET(A2, '/api/users');
  ok(ulist.j.users.length === 5 && ulist.j.positions.length === 3, '员工 5 人/岗位 3 个齐全');

  /* 自助注册 */
  ok((await POST(new Jar(), '/api/register', { username: 'AB', name: 'x', password: '12345678' })).status === 400, '注册：账号格式错 400');
  const reg = await POST(new Jar(), '/api/register', { username: 'newbie01', name: '新员工', password: 'newbie-2026' });
  ok(reg.status === 200 && /待校长激活/.test(reg.j.msg), '自助注册→pending');
  const nbLogin = await login('newbie01', 'newbie-2026');
  ok(nbLogin.r.status === 403, '注册后未激活不能登录');
  const nbUser = ulist.j.users; // refresh
  const ulist2 = await GET(A2, '/api/users');
  const nb = ulist2.j.users.find(u => u.username === 'newbie01');
  await POST(A2, '/api/users/set', { id: nb.id, action: 'activate', position_id: front.id });
  ok((await login('newbie01', 'newbie-2026')).r.status === 200, '激活 newbie 后可登录');

  /* ============ S3 学生导入 ============ */
  console.log('---- S3 学生导入 ----');
  const stpl = await GET(A2, '/api/students/template');
  ok(stpl.status === 200 && parseSpreadsheet('s.xlsx', stpl.buf.toString('base64'))[0][1] === '身份证号', '学生模板真 xlsx 可回读');
  const rows = [
    ['姓名', '身份证号', '手机号', '班级'],
    ['张伟', ID.张伟, '15011112222', '临床一班'],
    ['李娜', ID.李娜, '15022223333', '临床一班'],
    ['王强', ID.王强, '15033334444', '临床二班'],
    ['赵敏', ID.赵敏, '15044445555', '临床一班'],
    ['钱进', ID.钱进, '15055556666', '临床二班'],
    ['孙杰', ID.孙杰, '15066667777', '临床一班'],
    [ID.张伟, ID.张伟, '', '临床一班'],
    ['坏号', '110101199003070000', '', '临床一班'],
    ['', ID.赵敏, '', '临床一班'],
  ];
  const imp1 = await POST(A2, '/api/students/import', { filename: 's.xlsx', b64: makeXlsx(rows).toString('base64') });
  ok(imp1.j.ok === 6 && imp1.j.total === 9 && imp1.j.errors.length === 3, `导入 6 成功 3 错误行（重复/校验码/缺姓名）`);
  const imp2 = await POST(A2, '/api/students/import', { filename: 's.xlsx', b64: makeXlsx(rows).toString('base64') });
  ok(imp2.j.ok === 0 && imp2.j.errors.length === 9, '重复导入全部跳过（6 已有+校验码+缺姓名+文件内重复）');
  const csvImp = await POST(A2, '/api/students/import', { filename: 's.csv', b64: Buffer.from(toCsv([['姓名', '身份证号', '班级'], ['测试生', genId('11010120000101574'), '临床二班']])).toString('base64') });
  ok(csvImp.j.ok === 1, 'CSV 也能导入');
  const sList = await GET(A2, '/api/students');
  ok(sList.j.students.length === 7, '学生共 7 人');
  ok(sList.j.students.every(s => /\*{10}/.test(s.idcard_mask)), '列表身份证脱敏');
  const q1 = await GET(A2, '/api/students?q=' + encodeURIComponent('张伟'));
  ok(q1.j.students.length === 1 && q1.j.students[0].name === '张伟', '按姓名搜索');
  const q2 = await GET(A2, '/api/students?status=' + encodeURIComponent('已导入'));
  ok(q2.j.students.length === 7, '按状态过滤（初始全部已导入）');

  /* ============ S4 报到（含拍照/范围） ============ */
  console.log('---- S4 报到 ----');
  const lk1 = await POST(A2, '/api/checkin/lookup', { idcard: ID.张伟 });
  ok(lk1.j.found === true && lk1.j.student.status === '已导入' && lk1.j.fee_ok === false, 'lookup：老学生已导入未缴费');
  ok((await POST(A2, '/api/checkin/lookup', { idcard: '123' })).status === 400, 'lookup：坏号码 400');
  const lk2 = await POST(A2, '/api/checkin/lookup', { idcard: ID.stranger });
  ok(lk2.j.found === false && lk2.j.sex === '女', 'lookup：陌生卡 found=false 带性别推导');
  const ck1 = await POST(A2, '/api/checkin/confirm', { idcard: ID.张伟, phone: '15011112222', photo_b64: TINY_JPEG_B64 });
  ok(ck1.j.ok === true && ck1.j.student.status === '报到中' && ck1.j.fee_ok === false, '张伟报到→报到中+存照');
  const ck2 = await POST(A2, '/api/checkin/confirm', { idcard: ID.张伟, phone: '15011112222' });
  ok(ck2.j.ok === true && ck2.j.student.status === '报到中', '重复报到不回退状态（幂等）');
  const bigPhoto = 'A'.repeat(500 * 1024);
  const ck3 = await POST(A2, '/api/checkin/confirm', { idcard: ID.李娜, phone: '15022223333', photo_b64: bigPhoto });
  ok(ck3.status === 400 && /照片太大/.test(ck3.j.error), '照片 >300KB 400');
  const lk3 = await POST(A2, '/api/checkin/lookup', { idcard: ID.李娜 });
  ok(lk3.j.student.status === '已导入', '修复B3验证：照片超限报名失败但学生状态未被改动');
  const ck4 = await POST(A2, '/api/checkin/confirm', { idcard: ID.李娜, phone: '15022223333', photo_b64: TINY_JPEG_B64 });
  ok(ck4.j.ok === true && ck4.j.student.status === '报到中', '李娜正常报到');
  const ck5 = await POST(A2, '/api/checkin/confirm', { idcard: ID.钱进, name: '钱进', phone: '15055556666' });
  ok(ck5.j.ok === true && ck5.j.student.status === '报到中', '陌生卡建档+报到');
  const ck6 = await POST(A2, '/api/checkin/confirm', { idcard: ID.male2, name: '陆六', phone: '15077778888' });
  ok(ck6.j.ok === true, '陆六建档报到（满床测试用）');
  ok((await POST(A2, '/api/checkin/confirm', { idcard: ID.赵敏, phone: '123' })).status === 400, '报到手机号格式 400');
  const ph = await GET(A2, '/api/photo?sid=' + ck1.j.student.id);
  ok(ph.status === 200 && (ph.headers.get('content-type') || '').includes('image/jpeg') && ph.buf.length === Buffer.from(TINY_JPEG_B64, 'base64').length, '照片读取 200 image/jpeg 字节一致');
  ok((await GET(A2, '/api/photo?sid=99999')).status === 404, '无照片 404');
  ok((await GET(null, '/api/photo?sid=' + ck1.j.student.id)).status === 401, '照片未登录 401');
  ok((await GET(H, '/api/photo?sid=' + ck1.j.student.id)).status === 200, '宿管(att.view)可看照片');
  ok((await GET(F, '/api/photo?sid=' + ck1.j.student.id)).status === 200, '前台看本班照片 200');
  const wqId = sList.j.students.find(s2 => s2.name === '王强').id;
  ok((await GET(F, '/api/photo?sid=' + wqId)).status === 403, 'S1: 前台看二班照片 403（照片范围审查修复）');
  const csvRows = toCsv([['身份证号', '成绩'], [ID.张伟, '85'], [ID.李娜, '92'], [ID.stranger, '60']]);

  /* ============ S5 缴费 ============ */
  console.log('---- S5 缴费 ----');
  const fe1 = await POST(A2, '/api/fees/set', { student_id: ck1.j.student.id, item: '报名费', amount: 3000, paid: true, method: '现金' });
  ok(fe1.j.ok === true && fe1.j.fee_ok === false, '报名费已缴 fee_ok=false');
  ok((await POST(A2, '/api/fees/set', { student_id: ck1.j.student.id, item: '外星费', amount: 1, paid: true })).status === 400, '非法费项 400');
  const feFrontDeny = await POST(F, '/api/fees/set', { student_id: ck1.j.student.id, item: '报名费', amount: 3100, paid: true });
  ok(feFrontDeny.status === 403 && /修改缴费金额/.test(feFrontDeny.j.error), '前台改已缴金额（无 fee.edit）403');
  const feAdmin = await POST(A2, '/api/fees/set', { student_id: ck1.j.student.id, item: '报名费', amount: 3100, paid: true, method: '现金' });
  ok(feAdmin.j.ok === true, '校长（有 fee.edit）可改已缴金额');
  for (const it of ['住宿费', '书费', '学费']) await POST(A2, '/api/fees/set', { student_id: ck1.j.student.id, item: it, amount: 1000, paid: true, method: '扫码' });
  const feDone = await GET(A2, '/api/students');
  const zw = feDone.j.students.find(s => s.name === '张伟');
  const det1 = await POST(A2, '/api/student/detail', { id: zw.id });
  ok(det1.j.fee_ok === true && det1.j.fees.length === 4, '四项缴齐 fee_ok=true（此时押金未缴不阻塞）');
  const feNeg = await POST(A2, '/api/fees/set', { student_id: zw.id, item: '押金', amount: -500, paid: true });
  ok(feNeg.j.ok === true, '负数金额钳到 0 不炸');
  const feScope = await POST(F, '/api/fees/set', { student_id: feDone.j.students.find(s => s.name === '王强').id, item: '报名费', amount: 100, paid: true });
  ok(feScope.status === 403 && /不在你的数据范围/.test(feScope.j.error), '前台缴二班学生 403 范围拦截');
  const feFrontOk = await POST(F, '/api/fees/set', { student_id: feDone.j.students.find(s => s.name === '李娜').id, item: '住宿费', amount: 800, paid: true, method: '现金' });
  ok(feFrontOk.j.ok === true, '前台缴本班学生 200');

  /* ============ S6 宿舍 ============ */
  console.log('---- S6 宿舍 ----');
  const d1 = await POST(A2, '/api/dorms/save', { building: '1号楼', floor: 1, room: '101', sex: '男', beds: 4 });
  ok(d1.j.ok === true, '新建男生宿舍 101×4床');
  ok((await POST(A2, '/api/dorms/save', { building: '1号楼', floor: 1, room: '101', sex: '男', beds: 4 })).status === 409, '重复宿舍号 409');
  ok((await POST(A2, '/api/dorms/save', { building: '1号楼', floor: 1, room: '102', sex: '男', beds: 0 })).status === 400, '床位 0 拒绝');
  ok((await POST(A2, '/api/dorms/save', { building: '1号楼', floor: 1, room: '102', sex: '男', beds: 21 })).status === 400, '床位 21 拒绝（1-20）');
  await POST(A2, '/api/dorms/save', { building: '1号楼', floor: 2, room: '201', sex: '女', beds: 4 });
  await POST(A2, '/api/dorms/save', { building: '3号楼', floor: 3, room: '301', sex: '男', beds: 1 });
  await POST(A2, '/api/dorms/save', { building: '3号楼', floor: 3, room: '302', sex: '男', beds: 1 });
  await POST(A2, '/api/dorms/save', { building: '9号楼', floor: 9, room: '901', sex: '男', beds: 2 });
  const dorms0 = await GET(A2, '/api/dorms');
  ok(dorms0.j.dorms.length === 5 && dorms0.j.dorms.every(d => d.used === 0), '5 间宿舍全空');
  const auto1 = await POST(A2, '/api/dorm/auto', {});
  ok(auto1.j.assigned === 1 && auto1.j.skipped.length === 3 && auto1.j.skipped.every(x => x.why === '缴费未齐'), '自动分配：张伟入住；李娜/钱进/陆六缴费未齐跳过');
  const dorms1 = await GET(A2, '/api/dorms');
  const d101 = dorms1.j.dorms.find(d => d.room === '101');
  ok(d101.used === 1, '101 已住 1 人');
  const stuAll = (await GET(A2, '/api/students')).j.students;
  const byName = {}; for (const s of stuAll) byName[s.name] = s;
  const ln = (await POST(A2, '/api/student/detail', { id: byName['李娜'].id })).j;
  ok(ln.student.status === '报到中', '李娜仍为报到中（未分配）');
  const asg1 = await POST(A2, '/api/dorm/assign', { student_id: byName['李娜'].id, dorm_id: d101.id });
  ok(asg1.status === 400 && /性别不符/.test(asg1.j.error), '女生分男宿 400');
  const d201 = dorms1.j.dorms.find(d => d.room === '201');
  const asg2 = await POST(A2, '/api/dorm/assign', { student_id: byName['李娜'].id, dorm_id: d201.id });
  ok(asg2.j.ok === true, '李娜分入 201');
  const ln2 = (await POST(A2, '/api/student/detail', { id: byName['李娜'].id })).j;
  ok(ln2.student.status === '在训' && ln2.dorm && ln2.dorm.room === '201', '分配后状态→在训');
  const asg3 = await POST(A2, '/api/dorm/assign', { student_id: byName['李娜'].id, dorm_id: d201.id });
  ok(asg3.status === 400 && /已在这个宿舍/.test(asg3.j.error), '重复分配同宿舍 400');
  await POST(A2, '/api/dorm/assign', { student_id: byName['赵敏'].id, dorm_id: d201.id });
  await POST(A2, '/api/dorm/assign', { student_id: byName['孙杰'].id, dorm_id: d201.id });
  const d301 = dorms1.j.dorms.find(d => d.room === '301');
  const d302 = dorms1.j.dorms.find(d => d.room === '302');
  const asg4 = await POST(A2, '/api/dorm/assign', { student_id: byName['王强'].id, dorm_id: d301.id });
  ok(asg4.j.ok === true, '王强入 301（单人间满）');
  const asg5 = await POST(A2, '/api/dorm/assign', { student_id: byName['陆六'].id, dorm_id: d301.id });
  ok(asg5.status === 400 && /床位已满/.test(asg5.j.error), '满床再分 400');
  const asg6 = await POST(A2, '/api/dorm/assign', { student_id: byName['陆六'].id, dorm_id: d302.id });
  ok(asg6.j.ok === true, '陆六入 302');
  const sexChg = await POST(A2, '/api/dorms/save', { id: d301.id, building: '3号楼', floor: 3, room: '301', sex: '女', beds: 1 });
  ok(sexChg.status === 400 && /不能改性别/.test(sexChg.j.error), '有人住不能改性别 400');
  const bedsFew = await POST(A2, '/api/dorms/save', { id: d201.id, building: '1号楼', floor: 2, room: '201', sex: '女', beds: 2 });
  ok(bedsFew.status === 400 && /床位数不能小于在住人数/.test(bedsFew.j.error), '床位缩到在住人数以下 400');
  const dupUpd = await POST(A2, '/api/dorms/save', { id: d101.id, building: '1号楼', floor: 2, room: '201', sex: '男', beds: 4 });
  ok(dupUpd.status === 409 && /重名/.test(dupUpd.j.error), '修复B1验证：改名撞现有宿舍号→409 友好提示（原来 500）');
  const sw1 = await POST(A2, '/api/dorm/swap', { a: byName['张伟'].id, b: byName['李娜'].id });
  ok(sw1.status === 400 && /同性别/.test(sw1.j.error), '异性调换 400');
  const sw2 = await POST(A2, '/api/dorm/swap', { a: byName['张伟'].id, b: byName['王强'].id });
  ok(sw2.j.ok === true, '张伟↔王强 同性别互换');
  const occ1 = (await GET(A2, '/api/dorms')).j.occupants;
  const zwOcc = occ1.find(o => o.student_id === byName['张伟'].id);
  const wqOcc = occ1.find(o => o.student_id === byName['王强'].id);
  ok(zwOcc && zwOcc.dorm_id === d301.id && wqOcc && wqOcc.dorm_id === d101.id, '互换生效：张伟→301 王强→101');
  const sw3 = await POST(A2, '/api/dorm/swap', { a: byName['李娜'].id, b: byName['赵敏'].id });
  ok(sw3.status === 400 && /同一宿舍/.test(sw3.j.error), '同宿舍两人调换 400');
  const sw4 = await POST(A2, '/api/dorm/swap', { a: byName['张伟'].id, b: byName['钱进'].id });
  ok(sw4.j.ok === true, '单边调换=床位转移（钱进接过张伟床位）');
  const occ2 = (await GET(A2, '/api/dorms')).j.occupants;
  ok(occ2.find(o => o.student_id === byName['钱进'].id).dorm_id === d301.id && !occ2.find(o => o.student_id === byName['张伟'].id), '转移后钱进在301、张伟无床位');
  const delOcc = await POST(A2, '/api/dorms/delete', { id: d201.id });
  ok(delOcc.status === 400 && /有人住/.test(delOcc.j.error), '删除有人宿舍 400');
  const d901 = (await GET(A2, '/api/dorms')).j.dorms.find(d => d.room === '901');
  ok((await POST(A2, '/api/dorms/delete', { id: d901.id })).j.ok === true, '删除空宿舍 ok');
  ok((await GET(F, '/api/dorms')).status === 403, '前台无 dorm.assign 403');
  ok((await GET(H, '/api/dorms')).status === 200, '宿管可看宿舍');

  /* ============ S7 物资/发书 ============ */
  console.log('---- S7 物资/发书 ----');
  ok((await POST(A2, '/api/supplies/catalog', { name: '床单' })).j.ok === true, '物资目录+床单');
  await POST(A2, '/api/supplies/catalog', { name: '脸盆' });
  ok((await POST(A2, '/api/supplies/catalog', { name: '床单' })).status === 409, '物资重名 409');
  const cat1 = await GET(F, '/api/supplies/catalog');
  ok(cat1.j.catalog.length === 2, '前台可看物资目录（student.view）');
  const sup1 = await POST(A2, '/api/supply/set', { student_id: byName['张伟'].id, item_id: cat1.j.catalog[0].id, status: '已领', note: '' });
  ok(sup1.j.ok === true, '张伟领床单');
  await POST(A2, '/api/supply/set', { student_id: byName['张伟'].id, item_id: cat1.j.catalog[1].id, status: '缺', note: '缺脸盆' });
  const supL = await POST(A2, '/api/supply/list', { student_id: byName['张伟'].id });
  ok(supL.j.records.length === 2 && supL.j.records.find(r => r.status === '缺'), '物资登记含「缺」状态');
  const delCat = await POST(A2, '/api/supplies/catalog', { name: 'x', delete_id: cat1.j.catalog[1].id });
  ok(delCat.j.ok === true, '目录可删项');
  ok((await POST(A2, '/api/supply/set', { student_id: byName['张伟'].id, item_id: cat1.j.catalog[1].id, status: '已领' })).status === 404, '已删物资再登记 404');
  ok((await POST(F, '/api/supply/set', { student_id: byName['张伟'].id, item_id: cat1.j.catalog[0].id, status: '已领' })).status === 403, '前台无 supply.record 403');
  ok((await POST(A2, '/api/books/catalog', { name: '行测教材' })).j.ok === true, '书目+行测教材');
  const bg1 = await POST(A2, '/api/book/give', { student_id: byName['张伟'].id, book_id: 1 });
  const bg2 = await POST(A2, '/api/book/give', { student_id: byName['张伟'].id, book_id: 1 });
  ok(bg1.j.count === 1 && bg2.j.count === 2, '发书计数 1→2');
  const bl = await POST(A2, '/api/book/list', { student_id: byName['张伟'].id });
  ok(bl.j.records[0].count === 2, '发书记录累计 2 本');

  /* ============ S8 考勤 ============ */
  console.log('---- S8 考勤 ----');
  const t1 = await POST(A2, '/api/att/tap', { idcard: ID.张伟 });
  ok(t1.j.known === true && /打卡成功/.test(t1.j.msg) && t1.j.has_photo === true, '刷卡打卡成功带照片');
  const t2 = await POST(A2, '/api/att/tap', { idcard: ID.张伟 });
  ok(t2.j.duplicate === true && /今日已打卡/.test(t2.j.msg), '重复打卡提示（不 400，友好）');
  const t3 = await POST(A2, '/api/att/tap', { idcard: ID.stranger });
  ok(t3.j.known === false && /不是我们的学生/.test(t3.j.msg), '陌生卡 known=false');
  ok((await POST(A2, '/api/att/tap', { idcard: 'xx' })).status === 400, '刷卡格式错 400');
  const day1 = await GET(A2, '/api/att/day');
  const zwRow = day1.j.rows.find(r => r.name === '张伟');
  ok(zwRow.state === '出勤', '当日名单张伟=出勤');
  const lnRow = day1.j.rows.find(r => r.name === '李娜');
  ok(lnRow.state === '缺勤', '李娜未打卡=缺勤');
  ok((await POST(F, '/api/att/manual', { student_id: byName['李娜'].id })).status === 403, '前台无 att.manual 补卡 403');
  const m1 = await POST(A2, '/api/att/manual', { student_id: byName['李娜'].id, note: '人工补卡' });
  ok(m1.j.ok === true, '校长补卡');
  ok((await POST(A2, '/api/att/manual', { student_id: byName['李娜'].id })).status === 409, '重复补卡 409');
  const m2 = await POST(A2, '/api/att/manual', { student_id: byName['李娜'].id, remove: true });
  ok(m2.j.ok === true && (await GET(A2, '/api/att/day')).j.rows.find(r => r.name === '李娜').state === '缺勤', '删卡后回到缺勤');

  /* ============ S9 请假销假 ============ */
  console.log('---- S9 请假销假 ----');
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const lvScope = await POST(F, '/api/leave/add', { student_id: byName['王强'].id, from: todayStr, to: tomorrow, reason: 'range-test' });
  ok(lvScope.status === 403, '前台给二班请假 403');
  const lvWq = await POST(A2, '/api/leave/add', { student_id: byName['王强'].id, from: todayStr, to: tomorrow, reason: '二班假单' });
  ok(lvWq.j.ok === true, '校长给二班请假');
  const lv1 = await POST(F, '/api/leave/add', { student_id: byName['李娜'].id, from: todayStr, to: tomorrow, reason: '回家' });
  ok(lv1.j.ok === true, '前台给本班请假');
  const ln3 = (await POST(A2, '/api/student/detail', { id: byName['李娜'].id })).j;
  ok(ln3.student.status === '请假中' && ln3.leaves.length === 1, '请假后状态→请假中');
  const tLeave = await POST(A2, '/api/att/tap', { idcard: ID.李娜 });
  ok(tLeave.j.known === true && tLeave.j.msg.includes('打卡成功') && tLeave.j.leave_open === true, '请假期间刷卡成功且标记 leave_open');
  const lvClose403 = await POST(F, '/api/leave/close', { id: 1 });
  ok(lvClose403.status === 403, '前台无 leave.close 403');
  const lvBad = await POST(A2, '/api/leave/add', { student_id: byName['孙杰'].id, from: tomorrow, to: todayStr, reason: 'bad' });
  ok(lvBad.status === 400, '止<起 400');
  const lvOv1 = await POST(A2, '/api/leave/add', { student_id: byName['孙杰'].id, from: todayStr, to: tomorrow, reason: '假1' });
  const lvOv2 = await POST(A2, '/api/leave/add', { student_id: byName['孙杰'].id, from: todayStr, to: tomorrow, reason: '假2' });
  ok(lvOv1.j.ok === true, '首张请假单登记成功');
  ok(lvOv2.status === 409 && /已有未销假/.test(lvOv2.j.error || ''), '修复⑥验证：重叠请假单 409（原来两张都收）');
  const leaves1 = await GET(A2, '/api/leaves?open=1');
  const lnLeave = leaves1.j.leaves.find(l => l.name === '李娜');
  ok(lnLeave && lnLeave.status === 'open', '请假单列表 open');
  const lc1 = await POST(A2, '/api/leave/close', { id: lnLeave.id });
  ok(lc1.j.ok === true, '销假');
  const ln4 = (await POST(A2, '/api/student/detail', { id: byName['李娜'].id })).j;
  ok(ln4.student.status === '在训', '销假后状态回在训');
  ok((await POST(A2, '/api/leave/close', { id: lnLeave.id })).status === 409, '二次销假 409');
  const wqLeave = (await GET(A2, '/api/leaves')).j.leaves.find(l => l.name === '王强');
  const lvCloseScope = await POST(F, '/api/leave/close', { id: wqLeave.id });
  ok(lvCloseScope.status === 403 && /不在你的数据范围/.test(lvCloseScope.j.error), '修复B2验证：前台销二班假单 403（原来能越权）');
  const lvF = await GET(F, '/api/leaves');
  ok(lvF.j.leaves.every(l => l.class_name === '临床一班'), '前台请假列表只见本班');

  /* ============ S10 成绩 ============ */
  console.log('---- S10 成绩 ----');
  const sc1 = await POST(A2, '/api/scores/import', { filename: 'k.csv', b64: Buffer.from(csvRows).toString('base64'), exam: '入学模考', subject: '行测' });
  ok(sc1.j.ok === 2 && sc1.j.errors.length === 1 && /没有该身份证/.test(sc1.j.errors[0].msg), 'CSV 成绩导入 2 成功 1 陌生号');
  const xlsxScore = makeXlsx([['身份证号', '成绩'], [ID.张伟, '78'], [ID.李娜, 'abc'], [ID.赵敏, '2000']]);
  const sc2 = await POST(A2, '/api/scores/import', { filename: 'k.xlsx', b64: xlsxScore.toString('base64'), exam: '入学模考', subject: '申论' });
  ok(sc2.j.ok === 1 && sc2.j.errors.length === 2, 'xlsx 导入：1 成功+非数字/超范围 2 错误');
  ok((await POST(A2, '/api/scores/import', { filename: 'k.csv', b64: Buffer.from(csvRows).toString('base64'), exam: '', subject: 'x' })).status === 400, '缺考试名 400');
  const sc3 = await POST(A2, '/api/scores/import', { filename: 'k.csv', b64: Buffer.from(toCsv([['身份证号', '成绩'], [ID.张伟, '86']])).toString('base64'), exam: '入学模考', subject: '行测' });
  ok(sc3.j.ok === 1, '同科目重导=覆盖（ON CONFLICT）');
  const sl1 = await GET(A2, '/api/scores/list?exam=' + encodeURIComponent('入学模考'));
  const zwScore = sl1.j.rows.find(r => r.name === '张伟' && r.subject === '行测');
  ok(sl1.j.rows.length === 3 && zwScore.value === 86, '成绩列表含覆盖后的 86（行测2+申论1）');
  const se1 = await POST(A2, '/api/score/edit', { student_id: byName['张伟'].id, exam: '入学模考', subject: '行测', value: 88 });
  ok(se1.j.ok === true, '手改成绩 86→88');
  ok((await POST(A2, '/api/score/edit', { student_id: byName['张伟'].id, exam: '入学模考', subject: '行测', value: 9999 })).status === 400, '改分超范围 400');
  ok((await GET(F, '/api/scores/list')).status === 403, '前台无 score.view 403');
  const aud1 = await GET(A2, '/api/audit?limit=300');
  ok(aud1.j.rows.some(r => r.action === '成绩覆盖' && /85.*86/.test(r.detail)), '审计含「成绩覆盖 85→86」痕迹');

  /* ============ S11 离校全流程 ============ */
  console.log('---- S11 离校 ----');
  const depStart = await POST(A2, '/api/depart/start', { student_id: byName['李娜'].id });
  ok(depStart.j.ok === true, '李娜开始离校');
  ok((await POST(A2, '/api/depart/start', { student_id: byName['李娜'].id })).status === 400, '重复开始离校 400');
  const depD = await POST(A2, '/api/depart/detail', { student_id: byName['李娜'].id });
  ok(depD.j.student.status === '离校办理中' && depD.j.departure && depD.j.dorm, '离校详情带在住宿舍');
  const rfEarly = await POST(A2, '/api/depart/refund', { student_id: byName['李娜'].id, refund: 500 });
  ok(rfEarly.status === 400 && /卫生检查未通过/.test(rfEarly.j.error), '未检卫生退押金 400');
  const cl1 = await POST(A2, '/api/depart/clean', { student_id: byName['李娜'].id, pass: true, note: '干净' });
  ok(cl1.j.ok === true, '卫生检查通过');
  const rf1 = await POST(A2, '/api/depart/refund', { student_id: byName['李娜'].id, refund: 888888 });
  ok(rf1.status === 400 && /未缴押金/.test(rf1.j.error || ''), '修复⑤验证：未缴押金退款被拒（原来 888888 也放行）');
  const rf0 = await POST(A2, '/api/depart/refund', { student_id: byName['李娜'].id, refund: 0 });
  ok(rf0.j.ok === true, '未缴押金允许 0 元退款完成离校');
  const ln5 = (await POST(A2, '/api/student/detail', { id: byName['李娜'].id })).j;
  ok(ln5.student.status === '已离校' && !ln5.dorm && ln5.departure.done === 1 && ln5.departure.refund === 0, '退款后=已离校+床位释放+金额入档');
  ok((await POST(A2, '/api/depart/refund', { student_id: byName['李娜'].id, refund: 1 })).status === 409, '二次退押金 409');
  const tOff = await POST(A2, '/api/att/tap', { idcard: ID.李娜 });
  ok(tOff.j.refused === true && /已离校/.test(tOff.j.msg), '已离校刷卡拒绝');
  // 赵敏：物资未收回阻塞退押金
  const cat2 = await GET(A2, '/api/supplies/catalog');
  await POST(A2, '/api/supply/set', { student_id: byName['赵敏'].id, item_id: cat2.j.catalog[0].id, status: '已领' });
  await POST(A2, '/api/depart/start', { student_id: byName['赵敏'].id });
  await POST(A2, '/api/depart/clean', { student_id: byName['赵敏'].id, pass: true });
  const rfBlock = await POST(A2, '/api/depart/refund', { student_id: byName['赵敏'].id, refund: 500 });
  ok(rfBlock.status === 400 && /物资未收回/.test(rfBlock.j.error), '物资未收回阻塞退押金 400');
  const supBack = await POST(A2, '/api/depart/supply', { student_id: byName['赵敏'].id, item_id: cat2.j.catalog[0].id, note: '收回' });
  ok(supBack.j.ok === true, '离校物资收回');
  const depPay = await POST(A2, '/api/fees/set', { student_id: byName['赵敏'].id, item: '押金', amount: 800, paid: true, method: '现金' });
  ok(depPay.j.ok === true, '赵敏缴押金 800');
  const rfOver = await POST(A2, '/api/depart/refund', { student_id: byName['赵敏'].id, refund: 900 });
  ok(rfOver.status === 400 && /超过实缴/.test(rfOver.j.error || ''), '修复⑤验证：退款超过实缴押金 400');
  const rf2 = await POST(A2, '/api/depart/refund', { student_id: byName['赵敏'].id, refund: 500 });
  ok(rf2.j.ok === true, '收回后退押金成功（500 ≤ 实缴 800）');
  const depStart2 = await POST(A2, '/api/depart/start', { student_id: byName['张伟'].id });
  ok(depStart2.j.ok === true, '在训学生可开始离校（张伟→离校办理中）');

  /* ============ S12 报表/导出/审计 ============ */
  console.log('---- S12 报表/导出 ----');
  const rFee = await GET(A2, '/api/report/fees');
  ok(rFee.j.items.length === 5 && rFee.j.byStatus.some(x => x.status === '已离校'), '缴费汇总+状态分布');
  ok((await GET(A2, '/api/report/checkin')).j.rows.length >= 1, '报到情况');
  const rDorm = await GET(A2, '/api/report/dorm');
  ok(rDorm.j.rows.every(r2 => r2.used !== undefined), '宿舍占用含已住数');
  const rAtt = await GET(A2, '/api/report/attendance');
  ok(rAtt.j.total === 4 && rAtt.j.present === 0 && rAtt.j.leave === 2 && rAtt.j.missing.length === 2,
     `今日考勤汇总 出勤${rAtt.j.present}/应到${rAtt.j.total}/请假${rAtt.j.leave}/缺勤${rAtt.j.missing.length}（离校办理中+已离校不计，设计如此）`);
  ok((await GET(A2, '/api/report/scores?exam=' + encodeURIComponent('入学模考'))).j.rows.length === 3, '成绩总表');
  const csv1 = await GET(A2, '/api/report/fees?format=csv');
  ok(csv1.status === 200 && /text\/csv/.test(csv1.headers.get('content-type') || '') && csv1.buf[0] === 0xEF && csv1.buf[1] === 0xBB && csv1.buf[2] === 0xBF && (csv1.headers.get('content-disposition') || '').includes('attachment'), 'CSV 导出带 BOM+下载头');
  const csvAtt = await GET(A2, '/api/report/attendance?format=csv&date=' + todayStr);
  ok(csvAtt.status === 200 && /缺勤名单/.test(decodeURIComponent(csvAtt.headers.get('content-disposition') || '')), '缺勤名单按日期导出（文件名 URL 编码，解码后匹配）');
  const csvNoPerm = await GET(F, '/api/report/fees?format=csv');
  ok(csvNoPerm.status === 403, '无 report.export 导出 403');
  const rFeeF = await GET(F, '/api/report/fees');
  ok(rFeeF.status === 200 && rFeeF.j.byStatus.length >= 1, '报表对班级岗显示全校数（备注：报表不做范围过滤，已知设计）');
  const audCsv = await GET(A2, '/api/audit?format=csv&limit=2000');
  ok(audCsv.status === 200 && /审计日志/.test(decodeURIComponent(audCsv.headers.get('content-disposition') || '')), '审计导出 CSV');
  const audCnt = await GET(A2, '/api/audit?limit=50');
  ok(audCnt.j.rows.length > 20 && audCnt.j.rows.every(r2 => !/password|new.*:/i.test(r2.detail)), '审计不落密码字段');

  /* ============ S13 越权矩阵 ============ */
  console.log('---- S13 越权矩阵 ----');
  ok((await GET(F, '/api/users')).status === 403, '前台访问员工管理 403');
  ok((await GET(F, '/api/audit')).status === 403, '前台访问审计 403');
  ok((await POST(F, '/api/positions/save', { name: 'x', perms: [] })).status === 403, '前台建岗位 403');
  const detScope = await POST(F, '/api/student/detail', { id: byName['王强'].id });
  ok(detScope.status === 403, '前台看二班档案 403');
  const stuF = await GET(F, '/api/students');
  const fNames = stuF.j.students.map(s => s.name);
  ok(stuF.j.students.length === 5 && fNames.includes('陆六') && !fNames.some(n => ['王强', '测试生', '钱进'].includes(n)),
     '前台学生列表=本班4人+未分班1人（未分班全员可见），二班具名学生（王强/测试生/钱进）不可见');
  ok((await POST(H, '/api/fees/set', { student_id: byName['张伟'].id, item: '书费', amount: 1, paid: true })).status === 403, '宿管登记缴费 403');
  ok((await POST(H, '/api/att/manual', { student_id: byName['张伟'].id })).status === 403, '宿管补卡 403（无 att.manual）');
  ok((await GET(H, '/api/att/day')).status === 200, '宿管看考勤 200');
  ok((await GET(Z, '/api/students')).status === 200, '宿管（student.view, 全范围）看学生 200');

  /* ============ S14 会话/头部 ============ */
  console.log('---- S14 会话/响应头 ----');
  const jz = await call(A2, 'GET', '/api/audit?limit=2000', undefined, { 'accept-encoding': 'gzip' });
  ok(jz.headers.get('content-encoding') === 'gzip' || jz.buf.length < 600, 'JSON 大响应 gzip');
  const gone = new Jar(); gone.sid = A2.sid + 'x';
  ok((await GET(gone, '/api/me')).j.user === null, '伪造 sid 无效');
  const gzFlag = await login('admin', 'Adm!n-2026-Strong');
  ok(/SameSite=Lax/.test(gzFlag.r.headers.get('set-cookie') || ''), 'Cookie SameSite=Lax');

  /* ============ S15 运维 ============ */
  console.log('---- S15 运维 ----');
  const dataDir = process.env.AUDIT_DATA;
  execFileSync(process.execPath, [path.join(__dirname, '..', 'backup.js')], { env: { ...process.env, LENEN_DATA: dataDir } });
  const baks = fs.readdirSync(path.join(dataDir, 'backups')).filter(f => f.endsWith('.db'));
  ok(baks.length >= 2, 'backup.js 手动备份成功（启动1+手动1）');
  { // S4/S10 恢复演练：备份必须能打开、integrity ok、行数一致
    const { DatabaseSync } = require('node:sqlite');
    const bak = baks.sort().pop();
    const b2 = new DatabaseSync(path.join(dataDir, 'backups', bak), { readOnly: true });
    const ic = b2.prepare('PRAGMA integrity_check').get();
    const bn = b2.prepare('SELECT COUNT(*) AS n FROM students').get().n;
    b2.close();
    ok(ic && Object.values(ic)[0] === 'ok' && bn >= 7, `恢复演练：${bak} integrity=ok 学生=${bn}`);
  }
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok(appSrc.includes("ready ? el('sl-button', { type: 'submit'") && appSrc.includes("class: 'pri', style: 'width:100%;margin-top:6px;padding:10px'"), '修复A1验证：降级模式提交按钮为原生 button');
  ok(appSrc.includes('unhandledrejection') && appSrc.includes("customElements.get('sl-dialog')"), 'unhandledrejection 兜底 + askConfirm 守卫在位');
  ok(appSrc.includes("'aria-label': attrs.label") && appSrc.includes('autofocus: true'), 'S6: 原生降级输入带 aria-label/required + 账号框 autofocus');
  ok(appSrc.includes('function fmtDT(iso)') && (appSrc.match(/fmtDT\(/g) || []).length >= 7, '正确性: 时间显示统一走 fmtDT（北京时间，不再显示 UTC）');
  ok(appSrc.includes('let pageCleanup = null;') && appSrc.includes('pageCleanup = stopCam;'), '正确性: 切页清理钩子在位（离开报到页关摄像头）');
  ok(appSrc.includes("r.status === 401 && ME) { location.reload()"), '正确性: 会话过期自动回登录页');
  ok(appSrc.includes('本页无数据') && appSrc.includes('该考试暂无成绩'), 'UI: 报表/成绩空状态提示');
  const xl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'xlsxmini.js'), 'utf8');
  ok(xl.includes('E[+-]?\\d+$/i.test(v)'), '正确性: Excel 科学计数法数值归一');
  const core = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes_core.js'), 'utf8');
  ok(core.includes("class_name IN ("), '正确性: 学生列表班级范围在 SQL 内过滤（LIMIT 截断不再漏人）');
  const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  ok(cssSrc.includes('rgba(79, 70, 229, .06)') && cssSrc.includes('button.sm { padding: 6px 12px'), 'S5/S6: color-mix 静态回退 + 移动端触控目标');

  /* ============ 汇总 ============ */
  await stopServer();
  console.log('\n========================================');
  console.log(`AUDIT: ${pass} passed, ${fail} failed  （共 ${pass + fail} 项）`);
  if (fails.length) { console.log('失败清单:'); for (const f of fails) console.log(' - ' + f); }
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error('AUDIT CRASH:', e); await stopServer(); process.exit(2); });
