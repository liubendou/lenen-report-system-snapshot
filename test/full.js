'use strict';
/* 综合测试（比冒烟更深）：安全 / 认证会话 / 权限矩阵 / 数据范围 / 全业务深测 / 报表审计 / 并发 / 持久化 / 备份
   自带编排：独立端口 + 独立临时数据目录，自动起服→断言→重启→备份→清理。
   用法：node test/full.js   （可加环境变量 LENEN_FULL_PORT，默认 8794）*/
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.LENEN_FULL_PORT) || 8794;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lenen-full-'));
const ADMIN_PW = 'full-test-admin-2026';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { passed++; } else { failed++; fails.push(name); console.log('  [FAIL]', name, extra || ''); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* 生成合法身份证：6 地区 + 8 出生(19900101) + 3 顺序（末位奇男偶女）+ GB 校验码。
   测试学生占用 seq 1-17（男）/2-6（女）；X 结尾号从 30 起找，避免撞号 */
function genId(seq3) {
  const inner = '11010119900101' + String(seq3).padStart(3, '0');
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], c = '10X98765432';
  let s = 0; for (let i = 0; i < 17; i++) s += Number(inner[i]) * w[i];
  return inner + c[s % 11];
}
const maleId = (i) => genId(i * 2 + 1);
const femaleId = (i) => genId(i * 2 + 2);
function xEndingId() {
  for (let n = 30; n < 1000; n++) { const id = genId(n); if (id.endsWith('X')) return id; }
}

function client() {
  let cookie = '';
  return {
    async call(method, p, body, opt = {}) {
      const h = { ...(opt.headers || {}) };
      if (cookie) h.Cookie = cookie;
      let payload;
      if (body !== undefined) { h['Content-Type'] = opt.raw ? 'text/plain' : 'application/json'; payload = opt.raw ? body : JSON.stringify(body); }
      let r;
      try { r = await fetch(BASE + p, { method, headers: h, body: payload }); }
      catch (e) { return { status: -1, err: String(e && e.message || e) }; }
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      const out = { status: r.status, disp: r.headers.get('content-disposition') || '', ct, headers: r.headers };
      if (ct.includes('json')) out.j = await r.json();
      else { out.buf = Buffer.from(await r.arrayBuffer()); out.text = out.buf.toString('utf8'); }
      return out;
    },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

let srv = null;
function startServer() {
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, LENEN_PORT: String(PORT), LENEN_DATA: DATA }, stdio: ['ignore', 'ignore', 'pipe'] });
  srv.stderr.on('data', d => { const t = String(d); if (t.includes('Error') || t.includes('error')) process.stderr.write('[srv] ' + t); });
}
async function waitUp() { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/me'); if (r.ok) return true; } catch {} await sleep(200); } return false; }
function stopServer() { return new Promise(r => { if (!srv) return r(); srv.on('exit', () => r()); srv.kill(); }); }

(async () => {
  // ================= 起服 =================
  startServer();
  ok('服务器启动', await waitUp());
  const admin = client();

  // ================= A. 静态资源与未登录防护 =================
  console.log('A. 静态资源与未登录防护');
  let r = await admin.call('GET', '/');
  ok('首页 200 HTML', r.status === 200 && /text\/html/.test(r.ct) && r.text.includes('app.js'), r.ct);
  r = await admin.call('GET', '/app.js');
  ok('app.js 200', r.status === 200 && /javascript/.test(r.ct));
  r = await admin.call('GET', '/style.css');
  ok('style.css 200', r.status === 200 && /css/.test(r.ct));
  r = await admin.call('GET', '/some/deep/route');
  ok('SPA 回退', r.status === 200 && /text\/html/.test(r.ct));
  // 性能：gzip + 分级缓存
  let gz = await fetch(BASE + '/app.js?v=2', { headers: { 'Accept-Encoding': 'gzip' } });
  const rawLen = Number(gz.headers.get('content-length'));
  ok('静态 gzip 生效', gz.status === 200 && gz.headers.get('content-encoding') === 'gzip' && rawLen < 62614, rawLen + 'B');
  ok('带版本=长期缓存', /immutable/.test(gz.headers.get('cache-control') || ''), gz.headers.get('cache-control'));
  gz = await fetch(BASE + '/vendor/pico.min.css', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('vendor gzip+长期缓存', gz.headers.get('content-encoding') === 'gzip' && /immutable/.test(gz.headers.get('cache-control') || ''));
  gz = await fetch(BASE + '/');
  ok('入口页 no-cache', (gz.headers.get('cache-control') || '') === 'no-cache', gz.headers.get('cache-control'));
  ok('入口页 CSP 在位且不锁 iframe(手机经隧道/预览页访问)', /default-src/.test(gz.headers.get('content-security-policy') || '') && !/frame-ancestors/.test(gz.headers.get('content-security-policy') || ''), gz.headers.get('content-security-policy'));

  r = await admin.call('GET', '/..%2f..%2fetc%2fpasswd');
  ok('路径穿越不泄漏', r.status === 200 && !r.text.includes('root:'), r.status);
  r = await admin.call('GET', '/api/nope');
  ok('未知接口 404', r.status === 404);
  for (const p of ['/api/students', '/api/users', '/api/positions', '/api/audit', '/api/leaves', '/api/dorms', '/api/att/day', '/api/report/fees', '/api/scores/list', '/api/students/template']) {
    r = await admin.call('GET', p);
    ok('未登录401 ' + p, r.status === 401, r.status);
  }
  r = await admin.call('GET', '/api/me');
  ok('未登录 /api/me = user:null', r.status === 200 && r.j.user === null);
  ok('/api/me 带版本号', r.j.version === '1.3.8', JSON.stringify(r.j));
  ok('安全响应头 nosniff 在位且无 XFO(不拒 iframe)', r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-frame-options'), String(r.headers.get('x-content-type-options')));
  r = await client().call('GET', '/api/health');
  ok('健康检查免登录 /api/health', r.status === 200 && r.j.ok === true && r.j.version === '1.3.8', JSON.stringify(r.j).slice(0, 120));
  r = await admin.call('GET', '/api/photo?sid=1');
  ok('未登录照片 401', r.status === 401);

  // ================= C. 认证与会话 =================
  console.log('C. 认证与会话');
  r = await client().call('POST', '/api/login', { username: 'admin', password: 'change-me-on-first-login' });
  ok('初始校长登录', r.status === 200 && r.j.user.must_change === true, JSON.stringify(r.j).slice(0, 120));
  r = await client().call('POST', '/api/login', { username: 'admin', password: 'wrong-pass' });
  ok('错密码 401', r.status === 401);
  r = await client().call('POST', '/api/register', { username: 'BAD!', name: 'x', password: '12345678' });
  ok('注册非法账号名 400', r.status === 400);
  r = await client().call('POST', '/api/register', { username: 'front2', name: '前台二', password: '123' });
  ok('注册短密码 400', r.status === 400);
  r = await client().call('POST', '/api/register', { username: 'front2', name: '前台二', password: 'front2-pass-123' });
  ok('注册成功', r.status === 200);
  r = await client().call('POST', '/api/register', { username: 'front2', name: '前台二', password: 'front2-pass-123' });
  ok('重复注册 409', r.status === 409);
  r = await client().call('POST', '/api/login', { username: 'front2', password: 'front2-pass-123' });
  ok('待激活登录被拒 403', r.status === 403, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/login', { username: 'admin', password: 'change-me-on-first-login' });
  ok('管理员登录', r.status === 200);
  r = await admin.call('GET', '/api/students');
  ok('must_change=1 业务接口 403(服务端强制)', r.status === 403, r.status);
  r = await admin.call('POST', '/api/my/password', { old: 'bad-old-pass', new: ADMIN_PW });
  ok('改密原密码错 400', r.status === 400);
  r = await admin.call('POST', '/api/my/password', { old: 'change-me-on-first-login', new: 'short' });
  ok('改密新密码太短 400', r.status === 400);
  r = await admin.call('POST', '/api/my/password', { old: 'change-me-on-first-login', new: ADMIN_PW });
  ok('管理员改密成功', r.status === 200);
  r = await admin.call('POST', '/api/users/set', { id: 999, action: 'activate', position_id: 1 });
  ok('激活不存在员工 404', r.status === 404);
  const uList = (await admin.call('GET', '/api/users')).j.users;
  const f2 = uList.find(u => u.username === 'front2');
  ok('员工列表含待激活', !!f2 && f2.status === 'pending');
  r = await admin.call('POST', '/api/users/set', { id: f2.id, action: 'activate' });
  ok('激活缺岗位 400', r.status === 400);
  await admin.call('POST', '/api/positions/save', { name: '临时岗', perms: ['student.view'], scope: { type: 'all' } });
  const tmpPos = (await admin.call('GET', '/api/positions')).j.positions.find(p => p.name === '临时岗');
  r = await admin.call('POST', '/api/users/set', { id: f2.id, action: 'activate', position_id: tmpPos.id });
  ok('激活成功', r.status === 200);
  const f2c = client();
  r = await f2c.call('POST', '/api/login', { username: 'front2', password: 'front2-pass-123' });
  ok('front2 登录', r.status === 200);
  r = await admin.call('POST', '/api/users/reset-pass', { id: f2.id });
  ok('重置密码返回临时密码', r.status === 200 && /^Ln.+!$/.test(r.j.password), JSON.stringify(r.j));
  const tempPw = r.j.password;
  r = await client().call('POST', '/api/login', { username: 'front2', password: 'front2-pass-123' });
  ok('旧密码已失效', r.status === 401);
  r = await client().call('POST', '/api/login', { username: 'front2', password: tempPw });
  ok('临时密码可登录+必须改密', r.status === 200 && r.j.user.must_change === true);
  // front2 的旧会话（重置密码前建立）在服务端强制改密下必须先改密才能继续用
  r = await f2c.call('POST', '/api/my/password', { old: tempPw, new: 'front2-pass-456' });
  ok('front2 用临时密码改密成功', r.status === 200, JSON.stringify(r.j));
  await admin.call('POST', '/api/logout');
  r = await admin.call('GET', '/api/users');
  ok('登出后会话失效', r.status === 401);
  r = await client().call('POST', '/api/login', { username: 'admin', password: 'change-me-on-first-login' });
  ok('旧密码不能再登录', r.status === 401);
  r = await admin.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW });
  ok('新密码登录+must_change 清除', r.status === 200 && r.j.user.must_change === false);
  r = await admin.call('GET', '/api/users');
  ok('换新会话正常', r.status === 200);
  const bigResp = await fetch(BASE + '/api/positions', { headers: { Cookie: admin.cookie, 'Accept-Encoding': 'gzip' } });
  ok('API gzip 生效(大响应)', bigResp.headers.get('content-encoding') === 'gzip', String(bigResp.headers.get('content-encoding')));
  ok('API 响应 no-store', /no-store/.test(bigResp.headers.get('cache-control') || ''), String(bigResp.headers.get('cache-control')));
  // 停用→现有会话立即失效；启用恢复
  r = await admin.call('POST', '/api/users/set', { id: f2.id, action: 'disable' });
  ok('停用员工', r.status === 200);
  r = await f2c.call('GET', '/api/students');
  ok('停用后会话立即失效', r.status === 401, r.status);
  r = await admin.call('POST', '/api/users/set', { id: f2.id, action: 'enable' });
  r = await f2c.call('GET', '/api/students');
  ok('启用后原会话恢复', r.status === 200, r.status);
  r = await admin.call('POST', '/api/users/set', { id: 1, action: 'disable' });
  ok('不能停用校长', r.status === 400);
  // 登录失败锁定（独立用户名，不污染 admin）
  const lc = client();
  for (let i = 0; i < 5; i++) await lc.call('POST', '/api/login', { username: 'lockme', password: 'wrong-wrong' });
  r = await lc.call('POST', '/api/login', { username: 'lockme', password: 'whatever1' });
  ok('5 次失败后锁定 429', r.status === 429, r.status);

  // ================= B. 注入 / 篡改 / 边界输入 =================
  console.log('B. 注入与边界输入');
  const sc = client();
  r = await sc.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW }, { headers: { Origin: 'https://evil.example.com' } });
  ok('跨站 Origin 写请求被拒 403', r.status === 403, r.status);
  r = await sc.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW }, { headers: { Origin: BASE } });
  ok('同源 Origin 放行', r.status === 200);
  r = await sc.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW }, { headers: { Origin: 'https://evil.example.com/?x=' + BASE } });
  ok('Origin 藏宿主参数仍被拒(严格比对)', r.status === 403, r.status);
  r = await sc.call('POST', '/api/login', '{bad json', { raw: true });
  ok('坏 JSON 400(非500)', r.status === 400, r.status);
  r = await sc.call('POST', '/api/login', '{"a":"' + 'x'.repeat(9 * 1024 * 1024) + '"}');
  ok('超大请求体 413', r.status === 413, r.status + '/' + (r.err || ''));
  const forged = client(); forged.cookie = 'lenen_sid=forged-token';
  r = await forged.call('GET', '/api/students');
  ok('伪造 Cookie 401', r.status === 401);
  r = await admin.call('GET', "/api/students?q='; DROP TABLE students;--");
  ok('SQL 注入串安全返回', r.status === 200, JSON.stringify(r.j).slice(0, 100));
  r = await admin.call('GET', '/api/students');
  ok('students 表仍在(注入无效)', r.status === 200);
  const xssId = xEndingId();
  r = await admin.call('POST', '/api/checkin/confirm', { idcard: xssId, phone: '13800000777', name: '<img src=x onerror=alert(1)>', class_name: '一班' });
  ok('XSS 载荷建档不炸(200)', r.status === 200, JSON.stringify(r.j).slice(0, 100));
  r = await admin.call('GET', '/api/students?q=%3Cimg');
  ok('XSS 载荷查询可读回(前端转义责任)', r.status === 200 && r.j.students.length === 1);
  r = await admin.call('GET', '/api/photo?sid=abc');
  ok('photo sid 非数字不 500', r.status === 404, r.status);
  r = await admin.call('POST', '/api/att/manual', { student_id: 'abc', date: '2026-01-01' });
  ok('student_id 非数字 404(非500)', r.status === 404, r.status);
  r = await admin.call('POST', '/api/students/import', { filename: 'x.csv', b64: '####not-base64####' });
  ok('坏 base64 导入不 500', r.status !== 500, r.status);

  // ================= F1. 学生导入深测（性别显式声明，防场景错位）=================
  console.log('F1. 学生导入');
  const S = {};
  const spec = [ // [名, 性别, 班级]  —— S1..S11
    ['测试一', '男', '一班'], ['测试二', '男', '一班'], ['测试三', '男', '一班'],
    ['测试四', '女', '一班'], ['测试五', '男', '一班'], ['测试六', '男', '一班'],
    ['测试七', '男', '一班'], ['测试八', '男', '二班'], ['测试九', '男', '二班'],
    ['测试十', '女', '一班'], ['测试十一', '女', '一班'],
  ];
  let mi = 0, fi = 0, csv = '姓名,身份证号,手机号,班级\n';
  spec.forEach(([nm, sex, cls], i) => {
    const idc = sex === '男' ? maleId(mi++) : femaleId(fi++);
    S['S' + (i + 1)] = { name: nm, idcard: idc, sex, cls };
    csv += `${nm},${idc},139${String(10000000 + i)},${cls}\n`;
  });
  csv += '错误人,12345,13800000099,一班\n';            // 行13：校验码错
  csv += `${S.S1.name},${S.S1.idcard},13900000001,一班\n`; // 行14：文件内重复
  csv += `${S.S2.name},${S.S2.idcard},13900000002,一班\n`; // 行15：文件内重复
  r = await admin.call('POST', '/api/students/import', { filename: 's.csv', b64: b64(csv) });
  ok('批量导入 ok=11', r.status === 200 && r.j.ok === 11, JSON.stringify(r.j).slice(0, 200));
  ok('错误行号 13/14/15', JSON.stringify(r.j.errors.map(e => e.row)) === '[13,14,15]', JSON.stringify(r.j.errors));
  r = await admin.call('POST', '/api/students/import', { filename: 's2.csv', b64: b64(`姓名,身份证号\n${S.S2.name},${S.S2.idcard}\n`) });
  ok('重复导入提示系统已有', r.j.ok === 0 && /系统里已有该学生/.test(r.j.errors[0].msg), JSON.stringify(r.j.errors));
  const stuList = (await admin.call('GET', '/api/students')).j.students;
  for (const k of Object.keys(S)) S[k].id = stuList.find(s => s.idcard === S[k].idcard).id;
  ok('11 生性别推导正确', Object.values(S).every(s => stuList.find(x => x.id === s.id).sex === s.sex));
  r = await admin.call('POST', '/api/student/detail', { id: 999999 });
  ok('详情不存在 404', r.status === 404);
  r = await admin.call('POST', '/api/student/edit', { id: S.S1.id, phone: '13711112222', class_name: '一班' });
  ok('编辑学生', r.status === 200);
  r = await admin.call('POST', '/api/student/edit', { id: S.S1.id, name: '' });
  ok('姓名清空被拒 400', r.status === 400);
  r = await admin.call('POST', '/api/checkin/confirm', { idcard: S.S1.idcard, phone: '123' });
  ok('报到手机号格式 400', r.status === 400);

  // ================= F2. 缴费规则 =================
  console.log('F2. 缴费');
  r = await admin.call('POST', '/api/fees/set', { student_id: S.S1.id, item: '饭费', amount: 1, paid: true });
  ok('非法费用项 400', r.status === 400);
  r = await admin.call('POST', '/api/fees/set', { student_id: S.S1.id, item: '报名费', amount: 1000, paid: true, method: '现金' });
  ok('首项缴费 fee_ok=false', r.status === 200 && r.j.fee_ok === false);
  for (const it of ['住宿费', '书费', '学费']) await admin.call('POST', '/api/fees/set', { student_id: S.S1.id, item: it, amount: 500, paid: true });
  r = await admin.call('POST', '/api/fees/set', { student_id: S.S1.id, item: '押金', amount: 0, paid: false });
  ok('四项齐才 fee_ok=true(押金不强制)', r.j.fee_ok === true, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/fees/set', { student_id: S.S1.id, item: '学费', amount: -50, paid: true });
  ok('负金额钳到 0', r.status === 200);

  // ================= F3. 宿舍 =================
  console.log('F3. 宿舍');
  r = await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 0, room: '101', sex: '男', beds: 2 });
  ok('楼层 0 拒绝', r.status === 400);
  r = await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '101', sex: '男', beds: 0 });
  ok('床位 0 拒绝', r.status === 400);
  r = await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '101', sex: '男', beds: 21 });
  ok('床位 21 拒绝', r.status === 400);
  r = await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '101', sex: '男', beds: 2 });
  ok('建男宿 T101', r.status === 200);
  r = await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '101', sex: '男', beds: 2 });
  ok('重复宿舍 409', r.status === 409);
  await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '102', sex: '男', beds: 1 });
  await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '201', sex: '女', beds: 2 });
  await admin.call('POST', '/api/dorms/save', { building: 'T栋', floor: 1, room: '301', sex: '男', beds: 4 });
  const dorms = (await admin.call('GET', '/api/dorms')).j.dorms;
  const dM1 = dorms.find(d => d.room === '101'), dM2 = dorms.find(d => d.room === '102'), dF1 = dorms.find(d => d.room === '201'), dM3 = dorms.find(d => d.room === '301');
  // 调换边界（未分配时）
  r = await admin.call('POST', '/api/dorm/swap', { a: S.S5.id, b: S.S6.id });
  ok('两个男生都没宿舍调换 400', r.status === 400);
  r = await admin.call('POST', '/api/dorm/swap', { a: S.S1.id, b: S.S4.id });
  ok('异性调换 400(未分配也先拒)', r.status === 400);
  // 分配
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S1.id, dorm_id: dM1.id });
  ok('分配 S1→T101', r.status === 200);
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S2.id, dorm_id: dM1.id });
  ok('分配 S2→T101(满)', r.status === 200, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S3.id, dorm_id: dM1.id });
  ok('满床再分 400', r.status === 400);
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S3.id, dorm_id: dF1.id });
  ok('性别不符 400', r.status === 400);
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S3.id, dorm_id: dM2.id });
  ok('分配 S3→T102', r.status === 200);
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S3.id, dorm_id: dM2.id });
  ok('重复分配同宿舍 400', r.status === 400);
  r = await admin.call('POST', '/api/dorm/swap', { a: S.S1.id, b: S.S2.id });
  ok('同宿舍调换 400', r.status === 400);
  r = await admin.call('POST', '/api/dorm/swap', { a: S.S1.id, b: S.S3.id });
  ok('互换成功', r.status === 200);
  let occ = (await admin.call('GET', '/api/dorms')).j.occupants;
  ok('互换后床位对调', occ.find(o => o.student_id === S.S1.id).dorm_id === dM2.id && occ.find(o => o.student_id === S.S3.id).dorm_id === dM1.id);
  r = await admin.call('POST', '/api/dorm/swap', { a: S.S1.id, b: S.S5.id });
  ok('单方有床=转移', r.status === 200);
  occ = (await admin.call('GET', '/api/dorms')).j.occupants;
  ok('转移后 S5 入住 S1 原床', occ.find(o => o.student_id === S.S5.id).dorm_id === dM2.id && !occ.find(o => o.student_id === S.S1.id));
  // 女生先入住 T201，再做「有人住」的编辑边界
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S4.id, dorm_id: dF1.id });
  ok('分配 S4→T201', r.status === 200);
  r = await admin.call('POST', '/api/dorms/save', { id: dF1.id, building: 'T栋', floor: 1, room: '201', sex: '男', beds: 2 });
  ok('有人住改性别 400', r.status === 400);
  r = await admin.call('POST', '/api/dorms/save', { id: dM2.id, building: 'T栋', floor: 1, room: '102', sex: '男', beds: 1 });
  ok('床位数=在住数 可改', r.status === 200);
  r = await admin.call('POST', '/api/dorms/delete', { id: dM1.id });
  ok('有人住不能删', r.status === 400);
  // 自动分配：S7 未缴费跳过 → 缴费后分入
  await admin.call('POST', '/api/checkin/confirm', { idcard: S.S7.idcard, phone: '13970000001' });
  r = await admin.call('POST', '/api/dorm/auto', {});
  ok('未缴费自动分配跳过', r.j.skipped.some(x => x.id === S.S7.id && x.why === '缴费未齐'), JSON.stringify(r.j));
  for (const it of ['报名费', '住宿费', '书费', '学费']) await admin.call('POST', '/api/fees/set', { student_id: S.S7.id, item: it, amount: 100, paid: true });
  r = await admin.call('POST', '/api/dorm/auto', {});
  ok('缴费齐自动分配+转在训', r.j.assigned >= 1, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/student/detail', { id: S.S7.id });
  ok('S7 状态=在训', r.j.student.status === '在训');
  // 女生满床：S4 已在 T201，S10 补满，S11 无床可分
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S10.id, dorm_id: dF1.id });
  ok('分配 S10→T201(满)', r.status === 200);
  await admin.call('POST', '/api/checkin/confirm', { idcard: S.S11.idcard, phone: '13911000001' });
  for (const it of ['报名费', '住宿费', '书费', '学费']) await admin.call('POST', '/api/fees/set', { student_id: S.S11.id, item: it, amount: 100, paid: true });
  r = await admin.call('POST', '/api/dorm/auto', {});
  ok('女生无空床跳过', r.j.skipped.some(x => x.id === S.S11.id && /没有空/.test(x.why)), JSON.stringify(r.j));

  // ================= D. 权限矩阵与数据范围 =================
  console.log('D. 权限矩阵与数据范围');
  await admin.call('POST', '/api/positions/save', { name: '只读岗', perms: ['student.view'], scope: { type: 'all' } });
  await admin.call('POST', '/api/positions/save', { name: '缴费岗', perms: ['student.view', 'fee.record'], scope: { type: 'all' } });
  await admin.call('POST', '/api/positions/save', { name: '报表岗', perms: ['report.view'], scope: { type: 'all' } });
  await admin.call('POST', '/api/positions/save', { name: '一班教师', perms: ['student.view', 'att.view'], scope: { type: 'classes', classes: ['一班'] } });
  const posAll = (await admin.call('GET', '/api/positions')).j.positions;
  const pRo = posAll.find(p => p.name === '只读岗'), pFee = posAll.find(p => p.name === '缴费岗'),
        pRep = posAll.find(p => p.name === '报表岗'), pSc = posAll.find(p => p.name === '一班教师');
  for (const [un, pw] of [['u_ro', 'uro-pass-1234'], ['u_fee', 'ufee-pass-1234'], ['u_rep', 'urep-pass-1234'], ['u_sc', 'usc-pass-12345']]) {
    await admin.call('POST', '/api/register', { username: un, name: un, password: pw });
    const uu = (await admin.call('GET', '/api/users')).j.users.find(u => u.username === un);
    const pid = { u_ro: pRo.id, u_fee: pFee.id, u_rep: pRep.id, u_sc: pSc.id }[un];
    await admin.call('POST', '/api/users/set', { id: uu.id, action: 'activate', position_id: pid });
  }
  const ro = client(), fee = client(), rep = client(), sct = client();
  await ro.call('POST', '/api/login', { username: 'u_ro', password: 'uro-pass-1234' });
  await fee.call('POST', '/api/login', { username: 'u_fee', password: 'ufee-pass-1234' });
  await rep.call('POST', '/api/login', { username: 'u_rep', password: 'urep-pass-1234' });
  await sct.call('POST', '/api/login', { username: 'u_sc', password: 'usc-pass-12345' });
  r = await ro.call('GET', '/api/students');
  ok('只读岗可看学生', r.status === 200);
  const roDenied = [['GET', '/api/users'], ['GET', '/api/positions'], ['GET', '/api/audit'], ['GET', '/api/leaves'], ['GET', '/api/dorms'], ['GET', '/api/report/fees'], ['GET', '/api/scores/list'], ['GET', '/api/students/template'], ['POST', '/api/students/import'], ['POST', '/api/fees/set'], ['POST', '/api/dorms/save'], ['POST', '/api/dorm/auto'], ['POST', '/api/att/tap'], ['POST', '/api/att/manual'], ['POST', '/api/leave/add'], ['POST', '/api/supply/set'], ['POST', '/api/book/give'], ['POST', '/api/scores/import'], ['POST', '/api/depart/start'], ['POST', '/api/depart/refund']];
  let roAll403 = true; const roBad = [];
  for (const [m, p] of roDenied) { const rr = await ro.call(m, p, m === 'POST' ? {} : undefined); if (rr.status !== 403) { roAll403 = false; roBad.push(p + ':' + rr.status); } }
  ok('只读岗 20 项越权全 403', roAll403, roBad.join(','));
  r = await fee.call('POST', '/api/fees/set', { student_id: S.S2.id, item: '报名费', amount: 100, paid: true });
  ok('缴费岗可登记', r.status === 200);
  r = await fee.call('POST', '/api/fees/set', { student_id: S.S2.id, item: '报名费', amount: 200, paid: true });
  ok('缴费岗改已缴金额 403', r.status === 403, r.status);
  r = await admin.call('POST', '/api/fees/set', { student_id: S.S2.id, item: '报名费', amount: 200, paid: true });
  ok('有 fee.edit 可改金额', r.status === 200);
  r = await rep.call('GET', '/api/report/fees');
  ok('报表岗看报表 200', r.status === 200);
  r = await rep.call('GET', '/api/report/fees?format=csv');
  ok('报表岗导出 403(需 report.export)', r.status === 403, r.status);
  r = await admin.call('GET', '/api/report/fees?format=csv');
  ok('校长导出 CSV+BOM+附件头', r.status === 200 && r.text.startsWith('\uFEFF') && r.disp.includes('attachment'), r.status + '/' + r.disp);
  r = await sct.call('GET', '/api/students');
  ok('范围岗只见一班', r.status === 200 && r.j.students.length > 0 && r.j.students.every(s => s.class_name === '一班'), 'n=' + (r.j.students || []).length);
  r = await sct.call('POST', '/api/student/detail', { id: S.S9.id }); // S9 二班
  ok('范围外学生详情 403', r.status === 403 || r.status === 404, r.status);
  r = await sct.call('POST', '/api/att/tap', { idcard: S.S9.idcard });
  ok('范围外打卡 403', r.status === 403, r.status);
  r = await sct.call('POST', '/api/att/tap', { idcard: S.S1.idcard });
  ok('范围内打卡放行', r.status === 200, JSON.stringify(r.j).slice(0, 100));
  // 岗位增删
  await admin.call('POST', '/api/positions/save', { name: '短命岗', perms: [], scope: { type: 'all' } });
  const pTmp = (await admin.call('GET', '/api/positions')).j.positions.find(p => p.name === '短命岗');
  r = await admin.call('POST', '/api/positions/delete', { id: pTmp.id });
  ok('删空岗成功', r.status === 200);
  r = await admin.call('POST', '/api/positions/delete', { id: 1 });
  ok('删系统岗 400', r.status === 400);
  r = await admin.call('POST', '/api/positions/delete', { id: pRo.id });
  ok('删在用岗 400', r.status === 400);
  r = await admin.call('POST', '/api/positions/save', { id: 1, name: '改校长', perms: [] });
  ok('改系统岗 400', r.status === 400);

  // ================= D2. 员工管理新增/批量导入/模板 =================
  console.log('D2. 员工管理与注册');
  r = await admin.call('GET', '/api/positions');
  ok('permList 为对象数组(权限勾选bug回归)', Array.isArray(r.j.permList) && r.j.permList.length > 0 && typeof r.j.permList[0] === 'object' && !!r.j.permList[0].k, JSON.stringify((r.j.permList || [])[0]));
  ok('员工列表岗位带 system 标志', Array.isArray(r.j.positions) && 'system' in r.j.positions[0]);
  // 员工模板（真 Excel）
  r = await admin.call('GET', '/api/users/template');
  ok('员工模板 xlsx 下载', r.status === 200 && r.buf.slice(0, 2).toString() === 'PK' && r.disp.includes('attachment'), r.status + r.disp);
  const uRows = (() => { const { parseSpreadsheet } = require(path.join(ROOT, 'lib', 'xlsxmini')); return parseSpreadsheet('t.xlsx', r.buf.toString('base64')); })();
  ok('员工模板可解析回读', uRows[0][0] === '姓名' && uRows[0][1] === '手机号' && uRows[0][2] === '岗位', JSON.stringify(uRows[0]));
  // 学生模板也应是 xlsx
  r = await admin.call('GET', '/api/students/template');
  ok('学生模板 xlsx 下载', r.status === 200 && r.buf.slice(0, 2).toString() === 'PK' && r.disp.includes('.xlsx'), r.status + r.disp);
  { // 正确性：模板示例行本身必须能通过导入（原来示例身份证校验码就是错的，照抄必报错）
    const rr2 = await admin.call('POST', '/api/students/import', { filename: 'tpl.xlsx', b64: r.buf.toString('base64') });
    ok('模板示例行可直接导入(校验码正确)', rr2.status === 200 && rr2.j.ok === 1 && rr2.j.errors.length === 0, JSON.stringify(rr2.j));
  }
  // 单个新增：无岗位→待激活
  r = await admin.call('POST', '/api/users/add', { name: '赵员工', phone: '13600001234' });
  ok('新增员工(待激活)', r.status === 200 && r.j.username === '13600001234' && r.j.initpass === '001234', JSON.stringify(r.j));
  r = await admin.call('POST', '/api/users/add', { name: '赵员工', phone: '13600001234' });
  ok('重复手机号 409', r.status === 409);
  r = await admin.call('POST', '/api/users/add', { name: '钱员工', phone: '12345' });
  ok('手机号格式 400', r.status === 400);
  r = await admin.call('POST', '/api/users/add', { name: '孙假员工', phone: '13600005678', position_id: 1 });
  ok('加成校长岗位 400', r.status === 400, JSON.stringify(r.j));
  // 带岗位新增→直接激活→手机号+后6位登录→强制改密
  r = await admin.call('POST', '/api/users/add', { name: '周前台', phone: '13500009999', position_id: tmpPos.id });
  ok('新增员工(带岗位激活)', r.status === 200);
  const zc = client();
  r = await zc.call('POST', '/api/login', { username: '13500009999', password: '009999' });
  ok('手机号+后6位登录', r.status === 200 && r.j.user.must_change === true, JSON.stringify(r.j).slice(0, 120));
  // 批量导入（真 xlsx 往返）：2 正常（1 带岗位）+1 重复+1 坏手机号+1 岗位不存在
  const { makeXlsx } = require(path.join(ROOT, 'lib', 'xlsxmini'));
  const uimp = makeXlsx([
    ['姓名', '手机号', '岗位'],
    ['吴一批', '13400001111', '临时岗'],
    ['郑一批', '13400002222', ''],
    ['赵员工', '13600001234', '临时岗'],
    ['坏号', '123', '临时岗'],
    ['无岗', '13400003333', '不存在的岗'],
  ], '员工');
  r = await admin.call('POST', '/api/users/import', { filename: 'u.xlsx', b64: uimp.toString('base64') });
  ok('批量导入 ok=3', r.status === 200 && r.j.ok === 3, JSON.stringify(r.j).slice(0, 200));
  ok('批量导入激活=1', r.j.activated === 1, JSON.stringify(r.j));
  ok('批量导入错误行 4/5/6(重复/坏号/岗位不存在)', JSON.stringify(r.j.errors.map(e => e.row)) === '[4,5,6]', JSON.stringify(r.j.errors));
  r = await client().call('POST', '/api/login', { username: '13400001111', password: '001111' });
  ok('批量导入账号可登录', r.status === 200 && r.j.user.must_change === true);
  // 激活/改岗到系统岗位被拒
  const uu2 = (await admin.call('GET', '/api/users')).j.users.find(u => u.username === '13400002222');
  ok('郑一批为待激活', !!uu2 && uu2.status === 'pending');
  r = await admin.call('POST', '/api/users/set', { id: uu2.id, action: 'activate', position_id: 1 });
  ok('激活到校长岗位 400', r.status === 400);
  r = await admin.call('POST', '/api/users/set', { id: uu2.id, action: 'activate', position_id: tmpPos.id });
  ok('正常激活', r.status === 200);

  // ================= F4. 考勤与请假 =================
  console.log('F4. 考勤与请假');
  r = await admin.call('POST', '/api/att/tap', { idcard: '110101198901012345' });
  ok('陌生卡 known=false', r.j && r.j.known === false);
  r = await admin.call('POST', '/api/att/tap', { idcard: 'bad-id' });
  ok('非法身份证打卡 400', r.status === 400);
  // 照片流（S6：尚未报到，已导入状态）
  r = await admin.call('POST', '/api/checkin/confirm', { idcard: S.S6.idcard, phone: '13900000006', photo_b64: b64('fake-jpeg-data-for-test') });
  ok('报到+拍照', r.status === 200);
  r = await admin.call('POST', '/api/att/tap', { idcard: S.S6.idcard });
  ok('打卡带照片核验', r.j.known === true && r.j.has_photo === true, JSON.stringify(r.j).slice(0, 120));
  r = await admin.call('POST', '/api/att/tap', { idcard: S.S6.idcard });
  ok('重复打卡提示', r.j.duplicate === true);
  r = await admin.call('GET', '/api/photo?sid=' + S.S6.id);
  ok('照片读取 JPEG', r.status === 200 && /image\/jpeg/.test(r.ct) && r.buf.length > 0);
  await admin.call('POST', '/api/checkin/confirm', { idcard: S.S8.idcard, phone: '13980000008', photo_b64: b64('fake-jpeg-s8') }); // S8 二班补照片
  r = await sct.call('GET', '/api/photo?sid=' + S.S8.id);
  ok('范围外学生照片 403(照片范围审查)', r.status === 403, r.status);
  r = await admin.call('GET', '/api/photo?sid=' + S.S8.id);
  ok('校长看任意照片 200', r.status === 200, r.status);
  r = await admin.call('GET', '/api/photo?sid=999999');
  ok('无照片 404', r.status === 404);
  const yday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  r = await admin.call('POST', '/api/att/manual', { student_id: S.S5.id, date: yday, note: '补卡' });
  ok('人工补卡', r.status === 200);
  r = await admin.call('POST', '/api/att/manual', { student_id: S.S5.id, date: yday });
  ok('同日重复补卡 409', r.status === 409);
  r = await admin.call('POST', '/api/att/manual', { student_id: S.S5.id, date: yday, remove: true });
  ok('删除补卡', r.status === 200);
  // 请假流（S2：报到→分配→在训→请假）
  await admin.call('POST', '/api/checkin/confirm', { idcard: S.S2.idcard, phone: '13900000002' });
  r = await admin.call('POST', '/api/dorm/assign', { student_id: S.S2.id, dorm_id: dM3.id });
  ok('S2 补分配→在训前置', r.status === 200);
  const td = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  r = await admin.call('POST', '/api/leave/add', { student_id: S.S2.id, from: td, to: '2020-01-01', reason: 'x' });
  ok('请假日期倒挂 400', r.status === 400);
  r = await admin.call('POST', '/api/leave/add', { student_id: S.S2.id, from: yday, to: td, reason: '生病' });
  ok('登记请假', r.status === 200);
  r = await admin.call('POST', '/api/leave/add', { student_id: S.S2.id, from: yday, to: td, reason: '重复单' });
  ok('重叠请假单 409', r.status === 409, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/student/detail', { id: S.S2.id });
  ok('请假中状态', r.j.student.status === '请假中');
  r = await admin.call('POST', '/api/att/tap', { idcard: S.S2.idcard });
  ok('请假期首次刷卡 leave_open 标记', r.j.leave_open === true, JSON.stringify(r.j).slice(0, 120));
  const lv = (await admin.call('GET', '/api/leaves?open=1')).j.leaves;
  ok('open 请假单可查', lv.length >= 1);
  r = await admin.call('POST', '/api/leave/close', { id: 99999 });
  ok('销假不存在 404', r.status === 404);
  r = await admin.call('POST', '/api/leave/close', { id: lv[0].id });
  ok('销假成功', r.status === 200);
  r = await admin.call('POST', '/api/leave/close', { id: lv[0].id });
  ok('重复销假 409', r.status === 409);
  r = await admin.call('POST', '/api/student/detail', { id: S.S2.id });
  ok('销假后回在训', r.j.student.status === '在训');

  // ================= F5. 物资/发书/成绩 =================
  console.log('F5. 物资发书成绩');
  r = await admin.call('POST', '/api/supplies/catalog', { name: '' });
  ok('物资空名 400', r.status === 400);
  await admin.call('POST', '/api/supplies/catalog', { name: '测试物资A' });
  r = await admin.call('POST', '/api/supplies/catalog', { name: '测试物资A' });
  ok('物资重名 409', r.status === 409);
  const cat = (await admin.call('GET', '/api/supplies/catalog')).j.catalog;
  const itemA = cat.find(c => c.name === '测试物资A');
  r = await admin.call('POST', '/api/supply/set', { student_id: S.S3.id, item_id: itemA.id, status: '已领' });
  ok('物资登记已领', r.status === 200);
  r = await admin.call('POST', '/api/supply/set', { student_id: S.S3.id, item_id: 9999 });
  ok('物资不存在 404', r.status === 404);
  await admin.call('POST', '/api/books/catalog', { name: '测试教材X' });
  r = await admin.call('POST', '/api/book/give', { student_id: S.S3.id, book_id: 9999 });
  ok('书不存在 404', r.status === 404);
  r = await admin.call('POST', '/api/book/give', { student_id: S.S3.id, book_id: 1 });
  r = await admin.call('POST', '/api/book/give', { student_id: S.S3.id, book_id: 1 });
  ok('发书计数=2', r.j.count === 2, JSON.stringify(r.j));
  // 成绩
  r = await admin.call('POST', '/api/scores/import', { filename: 'x.csv', b64: b64('身份证号,分数\n'), exam: 'E1', subject: '语文' });
  ok('成绩空文件 400', r.status === 400);
  r = await admin.call('POST', '/api/scores/import', { filename: 'x.csv', b64: b64('身份证号,分数\n' + S.S1.idcard + ',85\n' + S.S2.idcard + ',92\n110101199001012341,66\n' + S.S3.idcard + ',abc\n'), exam: 'E1', subject: '语文' });
  ok('成绩导入 ok=2 错2', r.status === 200 && r.j.ok === 2 && r.j.errors.length === 2, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/score/edit', { student_id: S.S1.id, exam: 'E1', subject: '语文', value: 1001 });
  ok('成绩越界 400', r.status === 400);
  r = await admin.call('POST', '/api/score/edit', { student_id: S.S1.id, exam: 'E1', subject: '语文', value: 'abc' });
  ok('成绩非数字 400', r.status === 400);
  r = await admin.call('POST', '/api/score/edit', { student_id: S.S1.id, exam: 'E1', subject: '语文', value: 90 });
  ok('改成绩成功', r.status === 200);
  r = await admin.call('POST', '/api/scores/import', { filename: 'x.csv', b64: b64('身份证号,分数\n' + S.S1.idcard + ',95\n'), exam: 'E1', subject: '语文' });
  ok('重导覆盖 ok=1', r.j.ok === 1);
  r = await admin.call('GET', '/api/scores/list?exam=E1');
  ok('成绩列表含覆盖值', r.j.rows.some(x => x.student_id === S.S1.id && x.value === 95), JSON.stringify(r.j.rows).slice(0, 150));

  // ================= F6. 离校五步（S3：在训+有床+领过物资A）=================
  console.log('F6. 离校');
  r = await admin.call('POST', '/api/depart/start', { student_id: S.S8.id });
  ok('未报到不能离校 400', r.status === 400, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/depart/start', { student_id: S.S3.id });
  ok('开始离校', r.status === 200);
  r = await admin.call('POST', '/api/depart/start', { student_id: S.S3.id });
  ok('重复开始离校被拒 400', r.status === 400, JSON.stringify(r.j));
  await admin.call('POST', '/api/fees/set', { student_id: S.S3.id, item: '押金', amount: 100, paid: true });
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 100 });
  ok('物资未收回拒退', r.status === 400);
  await admin.call('POST', '/api/depart/supply', { student_id: S.S3.id, item_id: itemA.id });
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 100 });
  ok('卫生未过拒退', r.status === 400);
  r = await admin.call('POST', '/api/depart/clean', { student_id: S.S3.id, pass: false, note: '脏' });
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 100 });
  ok('卫生不合格拒退', r.status === 400);
  await admin.call('POST', '/api/depart/clean', { student_id: S.S3.id, pass: true, note: '合格' });
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 200 });
  ok('退款超实缴押金 400', r.status === 400, JSON.stringify(r.j));
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 100 });
  ok('退押金完成离校', r.status === 200);
  r = await admin.call('POST', '/api/depart/refund', { student_id: S.S3.id, refund: 100 });
  ok('重复退押金 409', r.status === 409);
  r = await admin.call('POST', '/api/student/detail', { id: S.S3.id });
  ok('S3 已离校+床位释放', r.j.student.status === '已离校' && !r.j.dorm);
  r = await admin.call('POST', '/api/att/tap', { idcard: S.S3.idcard });
  ok('离校打卡被拒', r.j.refused === true);
  const dM1now = (await admin.call('GET', '/api/report/dorm')).j.rows.find(d => d.id === dM1.id);
  ok('T101 全空(S2 调走+S3 离校释放)', dM1now.used === 0, 'used=' + dM1now.used);

  // ================= G. 报表与审计 =================
  console.log('G. 报表与审计');
  r = await admin.call('GET', '/api/report/fees');
  ok('缴费报表五项', r.j.items.length === 5 && r.j.items[0].item === '报名费');
  ok('缴费汇总数字合理', r.j.items.some(x => x.paid_sum > 0));
  r = await admin.call('GET', '/api/report/checkin');
  ok('报到报表有行', r.j.rows.length >= 1);
  r = await admin.call('GET', '/api/report/attendance');
  ok('考勤日报结构', typeof r.j.total === 'number' && typeof r.j.present === 'number');
  r = await admin.call('GET', '/api/report/scores?exam=E1');
  ok('成绩报表 2 行', r.j.rows.length === 2, JSON.stringify(r.j.rows).slice(0, 120));
  for (const p of ['/api/report/fees', '/api/report/checkin', '/api/report/dorm', '/api/report/attendance', '/api/report/scores', '/api/audit']) {
    r = await admin.call('GET', p + '?format=csv');
    ok('CSV导出 ' + p, r.status === 200 && r.text.startsWith('\uFEFF'), r.status);
  }
  r = await admin.call('GET', '/api/audit?limit=3');
  ok('审计 limit 生效', r.j.rows.length <= 3);
  r = await admin.call('GET', '/api/audit?limit=2000');
  const acts = r.j.rows.map(x => x.action);
  ok('审计含关键动作', ['登录', '改密码', '导入学生', '退押金', '修改成绩'].every(a => acts.includes(a)), acts.slice(0, 12).join(','));

  // ================= H. 并发 =================
  console.log('H. 并发');
  const ps = []; for (let i = 0; i < 25; i++) ps.push(admin.call('GET', '/api/students'));
  const prs = await Promise.all(ps);
  ok('25 并发读全 200', prs.every(x => x.status === 200));
  await admin.call('POST', '/api/dorms/save', { building: 'R栋', floor: 1, room: '001', sex: '男', beds: 1 });
  const dR = (await admin.call('GET', '/api/dorms')).j.dorms.find(d => d.room === '001');
  const race = await Promise.all([S.S8, S.S9].map(s => admin.call('POST', '/api/dorm/assign', { student_id: s.id, dorm_id: dR.id })));
  ok('抢床并发恰好 1 成功', race.filter(x => x.status === 200).length === 1 && race.some(x => x.status === 400), JSON.stringify(race.map(x => x.status)));
  const lps = []; for (let i = 0; i < 8; i++) lps.push(client().call('POST', '/api/login', { username: 'admin', password: ADMIN_PW }));
  ok('8 并发登录全成功', (await Promise.all(lps)).every(x => x.status === 200));

  // ================= I. 持久化与备份 =================
  // ================= J. 注册限流（S1/S9：每 IP 每小时 30 次） =================
  console.log('J. 注册限流');
  let got429 = false;
  for (let i = 0; i < 40 && !got429; i++) {
    const rr = await client().call('POST', '/api/register', { username: 'rlx' + i, name: 'rlx', password: 'rlx-pass-123' });
    if (rr.status === 429) got429 = true;
  }
  ok('注册超过限流触发 429', got429);

  console.log('I. 持久化与备份');
  const beforeCnt = (await admin.call('GET', '/api/students?q=测试')).j.students.length;
  await stopServer();
  startServer();
  ok('重启后服务恢复', await waitUp());
  r = await admin.call('GET', '/api/students');
  ok('重启后会话保持(持久会话,升级不掉线)', r.status === 200, r.status);
  const admin2 = client();
  await admin2.call('POST', '/api/login', { username: 'admin', password: ADMIN_PW });
  r = await admin2.call('GET', '/api/students?q=测试');
  ok('重启后数据仍在', r.j.students.length === beforeCnt, r.j.students.length + '/' + beforeCnt);
  r = await admin2.call('GET', '/api/photo?sid=' + S.S6.id);
  ok('重启后照片仍在', r.status === 200);
  // 备份
  const bakDir = path.join(DATA, 'backups');
  const autoFiles = fs.readdirSync(bakDir).filter(f => f.endsWith('.db'));
  ok('启动自动备份已生成(当日兜底)', autoFiles.length >= 1, String(autoFiles.length));
  let bk = spawnSync(process.execPath, [path.join(ROOT, 'backup.js')], { env: { ...process.env, LENEN_DATA: DATA }, encoding: 'utf8' });
  ok('backup.js 退出 0', bk.status === 0, bk.stderr);
  let bfiles = fs.readdirSync(bakDir).filter(f => f.endsWith('.db'));
  ok('手动备份+1', bfiles.length === autoFiles.length + 1, bfiles.length + '/' + autoFiles.length);
  const latestBak = bfiles.sort().at(-1); // 最新一份（自动备份在先，手动在后）
  const bdb = new DatabaseSync(path.join(bakDir, latestBak), { readOnly: true });
  const bcnt = bdb.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  bdb.close();
  const ldb = new DatabaseSync(path.join(DATA, 'lenen.db'), { readOnly: true });
  const lcnt = ldb.prepare('SELECT COUNT(*) AS n FROM students').get().n;
  ldb.close();
  ok('备份数据与库一致', bcnt === lcnt, bcnt + '/' + lcnt);
  for (let i = 0; i < 32; i++) spawnSync(process.execPath, [path.join(ROOT, 'backup.js')], { env: { ...process.env, LENEN_DATA: DATA } });
  bfiles = fs.readdirSync(bakDir).filter(f => f.endsWith('.db'));
  ok('备份保留 30 份上限', bfiles.length <= 30, String(bfiles.length));

  // ================= 收尾 =================
  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log('cleanup warn(可忽略):', e.message); }
  console.log(`\nFULL: ${passed} passed, ${failed} failed${failed ? '\n失败项: ' + fails.join(' | ') : ''}`);
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error('FULL-CRASH', e); await stopServer(); try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} process.exit(1); });
