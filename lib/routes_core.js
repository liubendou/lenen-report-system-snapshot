'use strict';
// 路由组一：认证 / 员工 / 岗位 / 学生 / 导入 / 报到 / 缴费 / 照片
const { ApiError, now, inScope, assertStudentInScope, feeAllPaid, scopeOf } = require('./util');
const { checkIdcard, maskIdcard, FEE_ITEMS } = require('./perm');
const { parseSpreadsheet, toCsv, makeXlsx } = require('./xlsxmini');

module.exports = (D) => { // D = {q, audit, auth, perm: PERM collections...}
const { q, audit } = D;
/* 注册限流：每 IP 每小时最多 30 次尝试（防垃圾注册灌库） */
const regFails = new Map();
const regHit = (ip) => {
  const t = Date.now();
  let f = regFails.get(ip);
  if (f && f.until > t && f.n >= 30) return false;
  if (!f || f.until <= t) { f = { n: 0, until: t + 3600e3 }; regFails.set(ip, f); }
  f.n++;
  if (regFails.size > 500) for (const [k, v] of regFails) if (v.until <= t) regFails.delete(k);
  return true;
};

function userInfo(id) {
  const u = q.one(`SELECT u.*, p.name AS position_name, p.perms AS perms_json, p.scope AS scope_json
                   FROM users u LEFT JOIN positions p ON p.id=u.position_id WHERE u.id=?`, id);
  if (!u) return null;
  const perms = u.status === 'active' && u.perms_json ? JSON.parse(u.perms_json) : [];
  return { id: u.id, username: u.username, name: u.name, status: u.status, position: u.position_name || '', perms,
           scope: u.scope_json ? JSON.parse(u.scope_json) : { type: 'all' }, must_change: !!u.must_change };
}
function getUserByLogin(username) { return q.one('SELECT * FROM users WHERE username=?', String(username).toLowerCase().trim()); }

return [
// ---- 认证 ----
{ m: 'GET', p: '/api/health', h: () => {
  try {
    const uv = Number(q.one('PRAGMA user_version').user_version || 0);
    const uCnt = q.one('SELECT COUNT(*) AS n FROM users').n;
    return { ok: true, db_ok: uCnt >= 1, schema_version: uv, version: D.version, uptime: Math.round(process.uptime()), time: now() };
  } catch (e) {
    throw new ApiError(503, '数据库健康检查未通过: ' + e.message);
  }
}},
{ m: 'POST', p: '/api/login', async: true, h: async (c) => {
  const lock = D.auth.loginBlocked(c.body.username, c.ip);
  if (lock) throw new ApiError(429, `失败次数过多，${lock} 秒后再试`);
  const u = getUserByLogin(c.body.username);
  if (!u) { await D.auth.equalizeTimingAsync(); D.auth.loginFail(c.body.username, c.ip); audit(String(c.body.username || '').slice(0, 40), '登录失败', '', '账号不存在 ip=' + c.ip); throw new ApiError(401, '账号或密码不对'); }
  if (!(await D.auth.verifyPasswordAsync(c.body.password, u.pass))) { D.auth.loginFail(c.body.username, c.ip); audit(String(c.body.username || '').slice(0, 40), '登录失败', '', '密码错误 ip=' + c.ip); throw new ApiError(401, '账号或密码不对'); }
  if (u.status !== 'active') throw new ApiError(403, u.status === 'pending' ? '账号待校长激活' : '账号已停用');
  D.auth.loginOk(c.body.username, c.ip);
  const sid = D.auth.createSession(u.id);
  c.setCookie(sid);
  audit(u.username, '登录', u.username, '');
  return { user: userInfo(u.id) };
}},
{ m: 'POST', p: '/api/logout', h: (c) => { if (c.sid) D.auth.dropSession(c.sid); c.clearCookie(); return { ok: true }; }},
{ m: 'GET', p: '/api/me', h: (c) => ({ user: c.user ? userInfo(c.user.id) : null, version: D.version })},
{ m: 'POST', p: '/api/my/password', h: (c) => {
  if (!c.user) throw new ApiError(401, '请先登录');
  const u = q.one('SELECT * FROM users WHERE id=?', c.user.id);
  if (!D.auth.verifyPassword(c.body.old, u.pass)) throw new ApiError(400, '原密码不对');
  if (String(c.body.new || '').length < 8) throw new ApiError(400, '新密码至少 8 位');
  q.run('UPDATE users SET pass=?, must_change=0 WHERE id=?', D.auth.hashPassword(c.body.new), u.id);
  audit(u.username, '改密码', u.username, '');
  return { ok: true };
}},
{ m: 'POST', p: '/api/register', h: (c) => {
  if (!regHit(c.ip)) throw new ApiError(429, '注册过于频繁，请 1 小时后再试');
  const un = String(c.body.username || '').toLowerCase().trim();
  if (!/^[a-z0-9_]{3,20}$/.test(un)) throw new ApiError(400, '账号限小写字母/数字/下划线，3-20 位');
  const name = String(c.body.name || '').trim();
  if (!name) throw new ApiError(400, '必须填写真实姓名');
  if (String(c.body.password || '').length < 8) throw new ApiError(400, '密码至少 8 位');
  if (getUserByLogin(un)) throw new ApiError(409, '账号已存在');
  q.run('INSERT INTO users(username,name,pass,status,created_at) VALUES(?,?,?,?,?)', un, name, D.auth.hashPassword(c.body.password), 'pending', now());
  audit(un, '自助注册', un, name);
  return { ok: true, msg: '已提交，等待校长激活并分配岗位' };
}},

// ---- 员工管理 ----
{ m: 'GET', p: '/api/users', perm: 'admin.users', h: () => ({
  users: q.all(`SELECT u.id,u.username,u.name,u.status,u.created_at,p.name AS position
                FROM users u LEFT JOIN positions p ON p.id=u.position_id ORDER BY u.id`),
  positions: q.all('SELECT id,name,system FROM positions'),
})},
{ m: 'POST', p: '/api/users/set', perm: 'admin.users', audit: '员工设置', h: (c) => {
  const u = q.one('SELECT * FROM users WHERE id=?', c.body.id);
  if (!u) throw new ApiError(404, '找不到员工');
  const uPos = u.position_id ? q.one('SELECT system FROM positions WHERE id=?', u.position_id) : null;
  if ((u.username === 'admin' || (uPos && uPos.system)) && c.user.id !== u.id)
    throw new ApiError(403, '不能修改校长（系统岗位）账号');
  if (u.username === 'admin' && (c.body.action === 'disable' || c.body.action === 'setpos'))
    throw new ApiError(400, '不能停用或更改校长账号岗位');
  const a = c.body.action;
  const checkPos = () => { const p = q.one('SELECT * FROM positions WHERE id=?', c.body.position_id);
    if (!p) throw new ApiError(404, '找不到岗位'); if (p.system) throw new ApiError(400, '校长是系统岗位，不能分配'); };
  if (a === 'activate') { if (!c.body.position_id) throw new ApiError(400, '激活时必须分配岗位');
    checkPos();
    q.run(`UPDATE users SET status='active', position_id=? WHERE id=?`, c.body.position_id, u.id); }
  else if (a === 'disable') q.run(`UPDATE users SET status='disabled' WHERE id=?`, u.id);
  else if (a === 'enable') q.run(`UPDATE users SET status='active' WHERE id=?`, u.id);
  else if (a === 'setpos') { if (!c.body.position_id) throw new ApiError(400, '缺岗位'); checkPos(); q.run('UPDATE users SET position_id=? WHERE id=?', c.body.position_id, u.id); }
  else throw new ApiError(400, '未知操作');
  return { ok: true };
}},
{ m: 'POST', p: '/api/users/reset-pass', perm: 'admin.users', audit: '重置密码', h: (c) => {
  const u = q.one('SELECT * FROM users WHERE id=?', c.body.id);
  if (!u) throw new ApiError(404, '找不到员工');
  const uPos = u.position_id ? q.one('SELECT system FROM positions WHERE id=?', u.position_id) : null;
  if ((u.username === 'admin' || (uPos && uPos.system)) && c.user.id !== u.id)
    throw new ApiError(403, '不能重置校长（系统岗位）密码');
  const pw = D.auth.strongPassword();
  q.run('UPDATE users SET pass=?, must_change=1 WHERE id=?', D.auth.hashPassword(pw), u.id);
  return { ok: true, password: pw };
}},
{ m: 'POST', p: '/api/users/add', perm: 'admin.users', audit: '新增员工', h: (c) => {
  const name = String(c.body.name || '').trim();
  const phone = String(c.body.phone || '').trim();
  if (!name) throw new ApiError(400, '姓名必填');
  if (!/^1\d{10}$/.test(phone)) throw new ApiError(400, '手机号格式不对（11 位数字）');
  if (getUserByLogin(phone)) throw new ApiError(409, '该手机号已是账号');
  let position_id = null, status = 'pending';
  if (c.body.position_id) {
    const p = q.one('SELECT * FROM positions WHERE id=?', c.body.position_id);
    if (!p) throw new ApiError(404, '找不到岗位');
    if (p.system) throw new ApiError(400, '不能把人加成校长岗位');
    position_id = p.id; status = 'active';
  }
  q.run('INSERT INTO users(username,name,pass,status,position_id,must_change,created_at) VALUES(?,?,?,?,?,?,?)',
    phone, name, D.auth.hashPassword(phone.slice(-6)), status, position_id, 1, now());
  return { ok: true, username: phone, initpass: phone.slice(-6), msg: status === 'active' ? '已创建并激活' : '已创建（待激活：去员工列表分配岗位）' };
}},
{ m: 'GET', p: '/api/users/template', perm: 'admin.users', raw: (c) => ({
  text: makeXlsx([['姓名', '手机号', '岗位'], ['李前台', '13800000001', '前台'], ['王宿管', '13900000002', '宿管']], '员工'),
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', download: '员工导入模板.xlsx',
})},
{ m: 'POST', p: '/api/users/import', perm: 'admin.users', audit: '批量导入员工', h: (c) => {
  const rows = parseSpreadsheet(c.body.filename, c.body.b64);
  if (!rows.length) throw new ApiError(400, '文件是空的');
  const header = rows[0].map(x => String(x).trim());
  const iName = header.findIndex(h => ['姓名', '名字', '员工姓名'].includes(h));
  const iPhone = header.findIndex(h => ['手机号', '手机', '电话', '账号'].includes(h));
  const iPos = header.findIndex(h => ['岗位', '职位', '岗位名'].includes(h));
  if (iName < 0 || iPhone < 0) throw new ApiError(400, '表头必须包含「姓名」和「手机号」列（可选「岗位」列；模板列：姓名/手机号/岗位）');
  const posCache = {};
  const posByName = (nm) => {
    nm = String(nm || '').trim(); if (!nm) return null;
    if (!(nm in posCache)) posCache[nm] = q.one('SELECT * FROM positions WHERE name=? AND system=0', nm);
    return posCache[nm];
  };
  const errors = []; let okN = 0, activated = 0;
  D.tx(() => {
  for (let r = 1; r < rows.length; r++) {
    const rowNo = r + 1;
    const name = String(rows[r][iName] ?? '').trim();
    const phone = String(rows[r][iPhone] ?? '').trim();
    if (!name && !phone) continue;
    if (!name) { errors.push({ row: rowNo, msg: '缺姓名' }); continue; }
    if (!/^1\d{10}$/.test(phone)) { errors.push({ row: rowNo, msg: `手机号「${phone}」格式不对` }); continue; }
    if (getUserByLogin(phone)) { errors.push({ row: rowNo, msg: `${phone} 已是账号，跳过` }); continue; }
    let pid = null, st = 'pending';
    if (iPos >= 0) {
      const p = posByName(rows[r][iPos]);
      if (p) { pid = p.id; st = 'active'; }
      else if (String(rows[r][iPos] ?? '').trim()) errors.push({ row: rowNo, msg: `岗位「${String(rows[r][iPos]).trim()}」不存在，账号先建为待激活` });
    }
    q.run('INSERT INTO users(username,name,pass,status,position_id,must_change,created_at) VALUES(?,?,?,?,?,?,?)',
      phone, name, D.auth.hashPassword(phone.slice(-6)), st, pid, 1, now());
    okN++; if (st === 'active') activated++;
  }
  });
  return { ok: okN, activated, errors, total: rows.length - 1, msg: '初始密码=手机号后6位，首次登录强制改密' };
}},


// ---- 岗位 ----
{ m: 'GET', p: '/api/positions', perm: 'admin.positions', h: () => ({
  positions: q.all('SELECT * FROM positions').map(p => ({ ...p, perms: JSON.parse(p.perms), scope: JSON.parse(p.scope) })),
  allPerms: D.allPerms, permList: D.permList || [], groups: D.groups,
})},
{ m: 'POST', p: '/api/positions/save', perm: 'admin.positions', audit: '岗位保存', h: (c) => {
  const name = String(c.body.name || '').trim();
  if (!name) throw new ApiError(400, '岗位名必填');
  const perms = (c.body.perms || []).filter(k => D.allPerms.includes(k));
  if (c.body.id) {
    const old = q.one('SELECT * FROM positions WHERE id=?', c.body.id);
    if (!old) throw new ApiError(404, '找不到岗位');
    if (old.system) throw new ApiError(400, '系统岗位（校长）不可修改');
    if (q.one('SELECT id FROM positions WHERE name=? AND id!=?', name, old.id)) throw new ApiError(409, '该岗位名已存在');
    q.run('UPDATE positions SET name=?, perms=?, scope=? WHERE id=?', name, JSON.stringify(perms), JSON.stringify(c.body.scope || { type: 'all' }), old.id);
    return { ok: true };
  }
  if (q.one('SELECT id FROM positions WHERE name=?', name)) throw new ApiError(409, '该岗位名已存在');
  q.run('INSERT INTO positions(name,perms,scope) VALUES(?,?,?)', name, JSON.stringify(perms), JSON.stringify(c.body.scope || { type: 'all' }));
  return { ok: true };
}},
{ m: 'POST', p: '/api/positions/delete', perm: 'admin.positions', audit: '岗位删除', h: (c) => {
  const old = q.one('SELECT * FROM positions WHERE id=?', c.body.id);
  if (!old) throw new ApiError(404, '找不到岗位');
  if (old.system) throw new ApiError(400, '系统岗位不可删除');
  const used = q.one('SELECT COUNT(*) AS n FROM users WHERE position_id=?', old.id).n;
  if (used) throw new ApiError(400, `仍有 ${used} 名员工在该岗位上，先移走再删`);
  q.run('DELETE FROM positions WHERE id=?', old.id);
  return { ok: true };
}},

// ---- 学生 ----
{ m: 'GET', p: '/api/students', perm: 'student.view', h: (c) => {
  const cond = []; const args = [];
  if (c.query.status) { cond.push('status=?'); args.push(c.query.status); }
  if (c.query.q) { cond.push('(name LIKE ? OR idcard LIKE ? OR phone LIKE ? OR class_name LIKE ?)'); const like = `%${c.query.q}%`; args.push(like, like, like, like); }
  // 班级范围在 SQL 内过滤：原来 LIMIT 2000 先截断再 JS 过滤，人数多时范围岗会漏人（正确性审查修复）
  const sc = scopeOf(c.user);
  if (sc.type === 'classes') {
    const ph = (sc.classes || []).map(() => '?').join(',');
    cond.push(`(class_name IN (${ph}) OR class_name = '')`); // 未分班学生全员可见（既定设计）
    args.push(...(sc.classes || []));
  }
  const whereSql = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const total = q.one(`SELECT COUNT(*) AS n FROM students ${whereSql}`, ...args).n;
  const limit = Math.max(1, Math.min(2000, Number(c.query.limit) || 2000));
  const offset = Math.max(0, Number(c.query.offset) || 0);
  const rows = q.all(`SELECT id,name,idcard,sex,phone,class_name,status,checkin_at FROM students
                      ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
  const students = rows.filter(s => inScope(c.user, s.class_name)).map(s => ({ ...s, idcard_mask: maskIdcard(s.idcard) }));
  return { students, total, has_more: offset + rows.length < total };
}},
{ m: 'GET', p: '/api/students/template', perm: 'student.import', raw: (c) => ({
  text: makeXlsx([['姓名', '身份证号', '手机号', '班级'], ['张三', '110101199003077774', '13800000000', '临床一班']], '学生'), // 示例号必须能过 GB 校验（正确性审查修复）
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', download: '学生导入模板.xlsx',
})},
{ m: 'POST', p: '/api/students/import', perm: 'student.import', audit: '导入学生', h: (c) => {
  const rows = parseSpreadsheet(c.body.filename, c.body.b64);
  if (!rows.length) throw new ApiError(400, '文件是空的');
  const header = rows[0].map(x => String(x).trim());
  const col = (names) => header.findIndex(h => names.includes(h));
  const iName = col(['姓名']), iId = col(['身份证号', '身份证', '证件号']), iPhone = col(['手机号', '电话']), iClass = col(['班级']);
  if (iId < 0) throw new ApiError(400, '表头必须包含「身份证号」列（模板列：姓名/身份证号/手机号/班级）');
  const errors = []; const seen = new Set(); let okN = 0;
  D.tx(() => {
  for (let r = 1; r < rows.length; r++) {
    const rowNo = r + 1;
    const name = String(rows[r][iName] ?? '').trim();
    const idRaw = String(rows[r][iId] ?? '').trim();
    const phone = iPhone >= 0 ? String(rows[r][iPhone] ?? '').trim() : '';
    const klass = iClass >= 0 ? String(rows[r][iClass] ?? '').trim() : '';
    if (!name && !idRaw) continue;
    const chk = checkIdcard(idRaw);
    if (!chk.ok) { errors.push({ row: rowNo, msg: chk.why }); continue; }
    if (!name) { errors.push({ row: rowNo, msg: '缺姓名' }); continue; }
    if (seen.has(chk.id)) { errors.push({ row: rowNo, msg: '文件内身份证号重复' }); continue; }
    seen.add(chk.id);
    const exist = q.one('SELECT id FROM students WHERE idcard=?', chk.id);
    if (exist) { errors.push({ row: rowNo, msg: `系统里已有该学生(id=${exist.id})，跳过` }); continue; }
    q.run('INSERT INTO students(idcard,name,sex,phone,class_name,status,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)',
      chk.id, name, chk.sex, phone, klass, '已导入', now(), c.user.username);
    okN++;
  }
  });
  return { ok: okN, errors, total: rows.length - 1 };
}},
{ m: 'POST', p: '/api/student/detail', perm: 'student.view', h: (c) => {
  const s = q.one('SELECT * FROM students WHERE id=?', c.body.id);
  assertStudentInScope(c.user, s);
  const fees = q.all('SELECT * FROM fee_state WHERE student_id=? ORDER BY item', s.id);
  const da = q.one(`SELECT da.id, d.building, d.floor, d.room, d.sex FROM dorm_assign da
                    JOIN dorms d ON d.id=da.dorm_id WHERE da.student_id=? AND da.active=1`, s.id);
  const supplies = q.all(`SELECT ss.*, sc.name FROM supply_state ss JOIN supplies_catalog sc ON sc.id=ss.item_id WHERE ss.student_id=?`, s.id);
  const books = q.all(`SELECT bs.*, bc.name FROM book_state bs JOIN books_catalog bc ON bc.id=bs.book_id WHERE bs.student_id=?`, s.id);
  const leaves = q.all('SELECT * FROM leaves WHERE student_id=? ORDER BY id DESC LIMIT 20', s.id);
  const att = q.all('SELECT date,at,manual,note FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 30', s.id);
  const dep = q.one('SELECT * FROM departures WHERE student_id=?', s.id);
  const scores = c.user.perms.includes('score.view') ? q.all('SELECT exam,subject,value,at FROM scores WHERE student_id=? ORDER BY exam,subject', s.id) : undefined;
  return { student: { ...s, idcard_mask: maskIdcard(s.idcard) }, fees, dorm: da, supplies, books, leaves, att, departure: dep || null, scores,
           fee_ok: feeAllPaid(q, s.id), has_photo: !!q.one('SELECT student_id FROM photos WHERE student_id=?', s.id) };
}},
{ m: 'POST', p: '/api/student/edit', perm: 'student.edit', h: (c) => {
  const s = q.one('SELECT * FROM students WHERE id=?', c.body.id);
  assertStudentInScope(c.user, s);
  const name = c.body.name !== undefined ? String(c.body.name).trim() : s.name;
  const phone = c.body.phone !== undefined ? String(c.body.phone).trim() : s.phone;
  const klass = c.body.class_name !== undefined ? String(c.body.class_name).trim() : s.class_name;
  if (!name) throw new ApiError(400, '姓名不能为空');
  q.run('UPDATE students SET name=?, phone=?, class_name=? WHERE id=?', name, phone, klass, s.id);
  audit(c.user.username, '编辑学生', maskIdcard(s.idcard), JSON.stringify({ name, phone, class: klass }));
  return { ok: true };
}},

// ---- 报到 ----
{ m: 'POST', p: '/api/checkin/lookup', perm: 'student.view', h: (c) => {
  const chk = checkIdcard(c.body.idcard);
  if (!chk.ok) throw new ApiError(400, chk.why);
  const s = q.one('SELECT * FROM students WHERE idcard=?', chk.id);
  if (!s) return { found: false, idcard: chk.id, sex: chk.sex };
  assertStudentInScope(c.user, s);
  const fees = q.all('SELECT * FROM fee_state WHERE student_id=? ORDER BY item', s.id);
  return { found: true, student: { ...s, idcard_mask: maskIdcard(s.idcard) }, fees, fee_ok: feeAllPaid(q, s.id),
           dorm: q.one(`SELECT d.building,d.floor,d.room FROM dorm_assign da JOIN dorms d ON d.id=da.dorm_id WHERE da.student_id=? AND da.active=1`, s.id) || null };
}},
{ m: 'POST', p: '/api/checkin/confirm', perm: 'student.edit', audit: '报到确认', h: (c) => {
  const chk = checkIdcard(c.body.idcard);
  if (!chk.ok) throw new ApiError(400, chk.why);
  const phone = String(c.body.phone || '').trim();
  if (!/^1\d{10}$/.test(phone)) throw new ApiError(400, '手机号格式不对（需 11 位）');
  let photoBuf = null;
  if (c.body.photo_b64) {
    photoBuf = Buffer.from(String(c.body.photo_b64), 'base64');
    if (photoBuf.length > 300 * 1024) throw new ApiError(400, '照片太大（>300KB），请压缩后再拍');
  }
  let s = q.one('SELECT * FROM students WHERE idcard=?', chk.id);
  const t = now();
  D.tx(() => {
    if (!s) {
      const name = String(c.body.name || '').trim();
      if (!name) throw new ApiError(400, '系统里没有该身份证号，需录入姓名建档');
      const klass = String(c.body.class_name || '').trim();
      const r = q.run('INSERT INTO students(idcard,name,sex,phone,class_name,status,checkin_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        chk.id, name, chk.sex, phone, klass, '报到中', t, t, c.user.username);
      s = q.one('SELECT * FROM students WHERE id=?', r.lastInsertRowid);
    } else {
      assertStudentInScope(c.user, s);
      if (['在训', '离校办理中', '已离校'].includes(s.status)) throw new ApiError(409, `该学生状态为「${s.status}」，不能重复报到（如有异常请联系校长）`);
      q.run('UPDATE students SET phone=?, checkin_at=COALESCE(checkin_at,?), status=CASE WHEN status=\'已导入\' THEN \'报到中\' ELSE status END WHERE id=?', phone, t, s.id);
      s = q.one('SELECT * FROM students WHERE id=?', s.id);
    }
    if (photoBuf) {
      q.run('INSERT INTO photos(student_id,blob,taken_at,by) VALUES(?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET blob=excluded.blob, taken_at=excluded.taken_at, by=excluded.by',
        s.id, photoBuf, t, c.user.username);
    }
    audit(c.user.username, '报到', chk.id, `${s.name} 手机${phone}`);
  });
  return { ok: true, student: { ...s, idcard_mask: maskIdcard(s.idcard) }, fee_ok: feeAllPaid(q, s.id) };
}},

// ---- 缴费（纯人工登记） ----
{ m: 'POST', p: '/api/fees/set', perm: 'fee.record', audit: '缴费登记', h: (c) => {
  const s = q.one('SELECT * FROM students WHERE id=?', c.body.student_id);
  assertStudentInScope(c.user, s);
  if (!FEE_ITEMS.includes(c.body.item)) throw new ApiError(400, '费用项目必须是：' + FEE_ITEMS.join('/'));
  const amount = Math.max(0, Number(c.body.amount) || 0);
  const paid = c.body.paid ? 1 : 0;
  const old = q.one('SELECT * FROM fee_state WHERE student_id=? AND item=?', s.id, c.body.item);
  if (old && old.paid === 1 && (amount !== old.amount || !paid) && !c.user.perms.includes('fee.edit'))
    throw new ApiError(403, '该项已登记缴清，修改金额或取消已缴需要「修改缴费金额」权限');
  const t = now();
  D.tx(() => {
    q.run(`INSERT INTO fee_state(student_id,item,amount,paid,method,at,by) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(student_id,item) DO UPDATE SET amount=excluded.amount, paid=excluded.paid, method=excluded.method, at=excluded.at, by=excluded.by`,
      s.id, c.body.item, amount, paid, String(c.body.method || ''), t, c.user.username);
    q.run('INSERT INTO fee_log(student_id,item,action,amount,at,by) VALUES(?,?,?,?,?,?)',
      s.id, c.body.item, paid ? (old ? '改登' : '登记已缴') : '登记未缴', amount, t, c.user.username);
  });
  return { ok: true, fee_ok: feeAllPaid(q, s.id) };
}},
{ m: 'GET', p: '/api/photo', h: (c) => {
  if (!c.user) throw new ApiError(401, '请先登录');
  if (!c.user.perms.includes('att.view') && !c.user.perms.includes('student.view')) throw new ApiError(403, '无查看照片权限');
  const sid = Number(c.query.sid);
  const stu = Number.isInteger(sid) ? q.one('SELECT * FROM students WHERE id=?', sid) : null;
  if (!stu) { c.res.writeHead(404, { 'Content-Type': 'text/plain' }); c.res.end('no photo'); return { __done: true }; }
  assertStudentInScope(c.user, stu); // S1 审查修复：班级范围岗只能看本班学生照片
  const p = q.one('SELECT blob FROM photos WHERE student_id=?', sid);
  if (!p) { c.res.writeHead(404, { 'Content-Type': 'text/plain' }); c.res.end('no photo'); return { __done: true }; }
  c.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  c.res.end(p.blob);
  return { __done: true };
}},
];
};
