'use strict';
// 路由组三：成绩 / 离校 / 报表 / 审计
const { ApiError, now, today, inScope, assertStudentInScope, getStudentScoped } = require('./util');
const { toCsv } = require('./xlsxmini');
const { FEE_ITEMS } = require('./perm');
const { assertCanStartDepart, assertInDepart } = require('./domain/status');

module.exports = (D) => {
const { q, audit } = D;
const getStudent = (c, id) => getStudentScoped(q, c, id);
const csvOut = (c, rows, name, needPerm) => {
  if (needPerm && !c.user.perms.includes(needPerm)) throw new ApiError(403, `导出需要「${needPerm}」权限`);
  c.rawOut(200, toCsv(rows), 'text/csv; charset=utf-8', name); return { __done: true };
};

return [
// ---- 成绩 ----
{ m: 'POST', p: '/api/scores/import', perm: 'score.import', audit: '导入成绩', h: (c) => {
  const exam = String(c.body.exam || '').trim(), subject = String(c.body.subject || '').trim();
  if (!exam || !subject) throw new ApiError(400, '考试名和科目必填');
  const rows = D.parseSpreadsheet(c.body.filename, c.body.b64);
  if (rows.length < 2) throw new ApiError(400, '文件没有数据行');
  const header = rows[0].map(x => String(x).trim());
  let iId = header.findIndex(h => ['身份证号', '身份证', '证件号'].includes(h));
  let iVal = header.findIndex(h => ['成绩', '分数', c.body.value_col].includes(h));
  if (Number.isInteger(Number(c.body.idcard_col)) && c.body.idcard_col !== '') iId = Number(c.body.idcard_col);
  if (Number.isInteger(Number(c.body.value_col)) && c.body.value_col !== '') iVal = Number(c.body.value_col);
  if (iId < 0 || iVal < 0) throw new ApiError(400, `没找到身份证号列或成绩列（表头：${header.join(' | ')}）——可在高级选项里填列号`);
  let okN = 0; const errors = [];
  D.tx(() => {
    for (let r = 1; r < rows.length; r++) {
      const rowNo = r + 1;
      const idRaw = String(rows[r][iId] ?? '').trim().toUpperCase();
      const vRaw = String(rows[r][iVal] ?? '').trim();
      if (!idRaw && !vRaw) continue;
      if (!/^\d{17}[\dX]$/.test(idRaw)) { errors.push({ row: rowNo, msg: '身份证号格式不对' }); continue; }
      const s = q.one('SELECT * FROM students WHERE idcard=?', idRaw);
      if (!s) { errors.push({ row: rowNo, msg: '系统里没有该身份证号' }); continue; }
      if (!inScope(c.user, s.class_name)) { errors.push({ row: rowNo, msg: '该学生不在你的数据范围' }); continue; }
      const v = Number(vRaw);
      if (vRaw === '' || Number.isNaN(v) || v < 0 || v > 1000) { errors.push({ row: rowNo, msg: `成绩「${vRaw}」不是有效数字` }); continue; }
      const old = q.one('SELECT * FROM scores WHERE student_id=? AND exam=? AND subject=?', s.id, exam, subject);
      q.run(`INSERT INTO scores(student_id,exam,subject,value,at,by) VALUES(?,?,?,?,?,?)
             ON CONFLICT(student_id,exam,subject) DO UPDATE SET value=excluded.value, at=excluded.at, by=excluded.by`,
        s.id, exam, subject, v, now(), c.user.username);
      if (old && old.value !== v) audit(c.user.username, '成绩覆盖', s.idcard, `${exam}/${subject} ${old.value}→${v}`);
      okN++;
    }
  });
  return { ok: okN, errors, total: rows.length - 1, exam, subject };
}},
{ m: 'GET', p: '/api/scores/list', perm: 'score.view', h: (c) => {
  const exams = q.all('SELECT DISTINCT exam FROM scores ORDER BY exam');
  const exam = c.query.exam || (exams[0] && exams[0].exam) || '';
  const rows = exam ? q.all('SELECT sc.*, s.name, s.class_name FROM scores sc JOIN students s ON s.id=sc.student_id WHERE sc.exam=? ORDER BY s.class_name, s.name', exam) : [];
  return { exams: exams.map(e => e.exam), exam, rows: rows.filter(r => inScope(c.user, r.class_name)) };
}},
{ m: 'POST', p: '/api/score/edit', perm: 'score.edit', audit: '修改成绩', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const v = Number(c.body.value);
  if (Number.isNaN(v) || v < 0 || v > 1000) throw new ApiError(400, '成绩需为 0-1000 的数字');
  const old = q.one('SELECT * FROM scores WHERE student_id=? AND exam=? AND subject=?', s.id, c.body.exam, c.body.subject);
  q.run(`INSERT INTO scores(student_id,exam,subject,value,at,by) VALUES(?,?,?,?,?,?)
         ON CONFLICT(student_id,exam,subject) DO UPDATE SET value=excluded.value, at=excluded.at, by=excluded.by`,
    s.id, String(c.body.exam), String(c.body.subject), v, now(), c.user.username);
  audit(c.user.username, '修改成绩', s.idcard, `${c.body.exam}/${c.body.subject} ${old ? old.value + '→' : ''}${v}`);
  return { ok: true };
}},

// ---- 离校 ----
{ m: 'POST', p: '/api/depart/start', perm: 'depart.process', audit: '离校开始', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  assertCanStartDepart(s);
  D.tx(() => {
    q.run(`INSERT INTO departures(student_id,at,by) VALUES(?,?,?) ON CONFLICT(student_id) DO NOTHING`, s.id, now(), c.user.username);
    q.run(`UPDATE students SET status='离校办理中' WHERE id=?`, s.id);
  });
  return { ok: true };
}},
{ m: 'POST', p: '/api/depart/detail', perm: 'depart.process', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const supplies = q.all(`SELECT ss.*, sc.name FROM supply_state ss JOIN supplies_catalog sc ON sc.id=ss.item_id WHERE ss.student_id=?`, s.id);
  const catalog = q.all('SELECT * FROM supplies_catalog ORDER BY id');
  const dep = q.one('SELECT * FROM departures WHERE student_id=?', s.id) || { student_id: s.id, supplies_ok: 0, clean_ok: 0, clean_note: '', refund: 0, done: 0 };
  const deposit = q.one(`SELECT amount, paid FROM fee_state WHERE student_id=? AND item='押金'`, s.id);
  const dorm = q.one(`SELECT d.building,d.floor,d.room FROM dorm_assign da JOIN dorms d ON d.id=da.dorm_id WHERE da.student_id=? AND da.active=1`, s.id);
  return { student: s, supplies, catalog, departure: dep, deposit: deposit || null, dorm: dorm || null };
}},
{ m: 'POST', p: '/api/depart/supply', perm: 'depart.process', audit: '物资收回', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  assertInDepart(s);
  const item = q.one('SELECT * FROM supplies_catalog WHERE id=?', c.body.item_id);
  if (!item) throw new ApiError(404, '找不到该物资');
  q.run(`INSERT INTO supply_state(student_id,item_id,status,note,at,by) VALUES(?,?,?,?,?,?)
         ON CONFLICT(student_id,item_id) DO UPDATE SET status='已还', note=excluded.note, at=excluded.at, by=excluded.by`,
    s.id, item.id, '已还', String(c.body.note || '离校收回'), now(), c.user.username);
  return { ok: true };
}},
{ m: 'POST', p: '/api/depart/clean', perm: 'depart.process', audit: '卫生检查', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  assertInDepart(s);
  q.run(`INSERT INTO departures(student_id,clean_ok,clean_note,at,by) VALUES(?,?,?,?,?)
         ON CONFLICT(student_id) DO UPDATE SET clean_ok=excluded.clean_ok, clean_note=excluded.clean_note, at=excluded.at, by=excluded.by`,
    s.id, c.body.pass ? 1 : 0, String(c.body.note || ''), now(), c.user.username);
  return { ok: true };
}},
{ m: 'POST', p: '/api/depart/refund', perm: 'deposit.refund', audit: '退押金', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const dep = q.one('SELECT * FROM departures WHERE student_id=?', s.id);
  if (!dep) throw new ApiError(400, '还没开始离校办理');
  if (dep.done) throw new ApiError(409, '押金已退过，不能重复退');
  assertInDepart(s);
  const supplies = q.all(`SELECT ss.status FROM supply_state ss JOIN supplies_catalog sc ON sc.id=ss.item_id WHERE ss.student_id=?`, s.id);
  const notReturned = supplies.filter(x => x.status === '已领' || x.status === '缺').length;
  if (notReturned) throw new ApiError(400, `还有 ${notReturned} 项物资未收回，不能退押金`);
  if (!dep.clean_ok) throw new ApiError(400, '卫生检查未通过，不能退押金');
  const refund = Math.max(0, Number(c.body.refund) || 0);
  const dep0 = q.one(`SELECT amount, paid FROM fee_state WHERE student_id=? AND item='押金'`, s.id);
  const cap = dep0 && dep0.paid === 1 ? Math.max(0, Number(dep0.amount) || 0) : 0;
  if (refund > cap) throw new ApiError(400, cap > 0 ? `退款不能超过实缴押金（${cap} 元）` : '该生未缴押金，退款金额只能为 0');
  D.tx(() => { // 退款+销账+释放床位+改状态 必须同成败（S4 数据完整性）
    q.run('UPDATE departures SET refund=?, done=1, at=?, by=? WHERE student_id=?', refund, now(), c.user.username, s.id);
    q.run('INSERT INTO fee_log(student_id,item,action,amount,at,by) VALUES(?,?,?,?,?,?)',
      s.id, '押金', `退还（原缴 ${dep0 ? dep0.amount : '?'}）`, refund, now(), c.user.username);
    const da = q.one('SELECT id FROM dorm_assign WHERE student_id=? AND active=1', s.id);
    if (da) q.run('UPDATE dorm_assign SET active=0 WHERE id=?', da.id);
    q.run(`UPDATE students SET status='已离校' WHERE id=?`, s.id);
  });
  return { ok: true };
}},

// ---- 报表 ----
{ m: 'GET', p: '/api/report/fees', perm: 'report.view', h: (c) => {
  const rows = q.all(`SELECT fs.item, COUNT(*) AS n, SUM(fs.paid) AS paid_n, SUM(CASE WHEN fs.paid=1 THEN fs.amount ELSE 0 END) AS paid_sum
                      FROM fee_state fs JOIN students s ON s.id=fs.student_id GROUP BY fs.item`);
  const out = FEE_ITEMS.map(it => { const r = rows.find(x => x.item === it) || {}; return { item: it, n: r.n || 0, paid_n: r.paid_n || 0, paid_sum: r.paid_sum || 0 }; });
  const byStatus = q.all('SELECT status, COUNT(*) AS n FROM students GROUP BY status');
  if (c.query.format === 'csv') return csvOut(c, [['项目', '登记人数', '已缴人数', '已缴金额'], ...out.map(r => [r.item, r.n, r.paid_n, r.paid_sum])], '缴费汇总.csv', 'report.export');
  return { items: out, byStatus };
}},
{ m: 'GET', p: '/api/report/checkin', perm: 'report.view', h: (c) => {
  const rows = q.all(`SELECT class_name, status, COUNT(*) AS n FROM students GROUP BY class_name, status ORDER BY class_name`);
  if (c.query.format === 'csv') return csvOut(c, [['班级', '状态', '人数'], ...rows.map(r => [r.class_name, r.status, r.n])], '报到情况.csv', 'report.export');
  return { rows };
}},
{ m: 'GET', p: '/api/report/dorm', perm: 'report.view', h: (c) => {
  const usedMap = new Map(q.all('SELECT dorm_id, COUNT(*) AS n FROM dorm_assign WHERE active=1 GROUP BY dorm_id').map(x => [x.dorm_id, x.n])); // S7: 去 N+1
  const rows = q.all('SELECT * FROM dorms ORDER BY building, floor, room').map(d => ({ ...d, used: usedMap.get(d.id) || 0 }));
  if (c.query.format === 'csv') return csvOut(c, [['楼栋', '楼层', '宿舍', '性别', '床位', '已住', '状态'],
    ...rows.map(r => [r.building, r.floor, r.room, r.sex, r.beds, r.used, r.bad ? '坏' : '好'])], '宿舍占用.csv', 'report.export');
  return { rows };
}},
{ m: 'GET', p: '/api/report/attendance', perm: 'report.view', h: (c) => {
  const d = c.query.date || today();
  const students = q.all(`SELECT id,name,sex,class_name,status FROM students WHERE status IN ('在训','请假中','报到中')`).filter(s => inScope(c.user, s.class_name));
  const taps = new Set(q.all('SELECT student_id FROM attendance WHERE date=?', d).map(t => t.student_id));
  const leaves = new Set(q.all(`SELECT student_id FROM leaves WHERE status='open' AND ? BETWEEN from_d AND to_d`, d).map(l => l.student_id));
  const missing = students.filter(s => !taps.has(s.id) && !leaves.has(s.id));
  if (c.query.format === 'csv') return csvOut(c, [['日期', d], ['姓名', '班级', '性别', '状态'], ...missing.map(s => [s.name, s.class_name, s.sex, s.status])], `缺勤名单_${d}.csv`, 'report.export');
  return { date: d, total: students.length, present: students.filter(s => taps.has(s.id)).length, leave: students.filter(s => leaves.has(s.id)).length, missing };
}},
{ m: 'GET', p: '/api/report/scores', perm: 'report.view', h: (c) => {
  if (!c.user.perms.includes('score.view')) throw new ApiError(403, '查看成绩总表需要「查看成绩」权限');
  const exam = c.query.exam || '';
  const rows = (exam ? q.all(`SELECT sc.exam, sc.subject, s.class_name, s.name, sc.value FROM scores sc JOIN students s ON s.id=sc.student_id WHERE sc.exam=? ORDER BY s.class_name, s.name`, exam) : [])
    .filter(r => inScope(c.user, r.class_name));
  if (c.query.format === 'csv') return csvOut(c, [['考试', '科目', '班级', '姓名', '分数'], ...rows.map(r => [r.exam, r.subject, r.class_name, r.name, r.value])], '成绩总表.csv', 'report.export');
  return { rows };
}},

// ---- 审计 ----
{ m: 'GET', p: '/api/audit', perm: 'audit.view', h: (c) => {
  const limit = Math.max(1, Math.min(2000, Number(c.query.limit) || 300));
  const rows = q.all('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit);
  if (c.query.format === 'csv') return csvOut(c, [['时间', '操作人', '动作', '对象', '明细'], ...rows.map(r => [r.at, r.user, r.action, r.target, r.detail])], '审计日志.csv', 'audit.view');
  return { rows };
}},
];
};
