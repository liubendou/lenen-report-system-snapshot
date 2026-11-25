'use strict';
// 路由组二：宿舍（含调换）/ 物资 / 发书 / 考勤 / 请假销假
const { ApiError, now, today, assertStudentInScope, feeAllPaid, inScope, getStudentScoped } = require('./util');
const { checkIdcard } = require('./perm');
const { assertCanAssignDorm } = require('./domain/status');

module.exports = (D) => {
const { q, audit } = D;
const getStudent = (c, id) => getStudentScoped(q, c, id);
const activeAssign = (sid) => q.one('SELECT * FROM dorm_assign WHERE student_id=? AND active=1', sid);
const usedBeds = (dormId) => q.one('SELECT COUNT(*) AS n FROM dorm_assign WHERE dorm_id=? AND active=1', dormId).n;
function assign(student, dorm, user) {
  const old = activeAssign(student.id);
  if (old) q.run('UPDATE dorm_assign SET active=0 WHERE id=?', old.id);
  q.run('INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(?,?,?,?,1)', student.id, dorm.id, now(), user.username);
}

return [
// ---- 宿舍 ----
{ m: 'GET', p: '/api/dorms', perm: 'dorm.assign', h: () => {
  // S7 性能审查修复：原来每间宿舍单独 COUNT（N+1 查询），改一次 GROUP BY
  const usedMap = new Map(q.all('SELECT dorm_id, COUNT(*) AS n FROM dorm_assign WHERE active=1 GROUP BY dorm_id').map(x => [x.dorm_id, x.n]));
  const dorms = q.all('SELECT * FROM dorms ORDER BY building, floor, room').map(d => ({ ...d, used: usedMap.get(d.id) || 0 }));
  const occ = q.all(`SELECT da.student_id, da.dorm_id, s.name, s.class_name, s.sex FROM dorm_assign da
                     JOIN students s ON s.id=da.student_id WHERE da.active=1`);
  return { dorms, occupants: occ };
}},
{ m: 'POST', p: '/api/dorms/save', perm: 'dorm.manage', audit: '宿舍保存', h: (c) => {
  const building = String(c.body.building || '').trim();
  const floor = Number(c.body.floor);
  const room = String(c.body.room || '').trim();
  const sex = c.body.sex === '女' ? '女' : '男';
  const beds = Number(c.body.beds);
  if (!building || !room) throw new ApiError(400, '楼栋和宿舍号必填');
  if (!Number.isInteger(floor) || floor < 1) throw new ApiError(400, '楼层需为 ≥1 的整数');
  if (!Number.isInteger(beds) || beds < 1 || beds > 20) throw new ApiError(400, '床位数人工输入，范围 1-20');
    if (c.body.id) {
    const old = q.one('SELECT * FROM dorms WHERE id=?', c.body.id);
    if (!old) throw new ApiError(404, '找不到宿舍');
    if (sex !== old.sex && usedBeds(old.id) > 0) throw new ApiError(400, '宿舍已有人入住，不能改性别');
    if (beds < usedBeds(old.id)) throw new ApiError(400, `已住 ${usedBeds(old.id)} 人，床位数不能小于在住人数`);
    try {
      q.run('UPDATE dorms SET building=?, floor=?, room=?, sex=?, beds=?, bad=?, note=? WHERE id=?',
        building, floor, room, sex, beds, c.body.bad ? 1 : 0, String(c.body.note || ''), old.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new ApiError(409, '该楼栋已有这个宿舍号（不能与现有宿舍重名）');
      throw e;
    }
    return { ok: true };
  }
  if (q.one('SELECT id FROM dorms WHERE building=? AND room=?', building, room)) throw new ApiError(409, '该楼栋已有这个宿舍号');
  q.run('INSERT INTO dorms(building,floor,room,sex,beds,bad,note) VALUES(?,?,?,?,?,?,?)',
    building, floor, room, sex, beds, c.body.bad ? 1 : 0, String(c.body.note || ''));
  return { ok: true };
}},
{ m: 'POST', p: '/api/dorms/delete', perm: 'dorm.manage', audit: '宿舍删除', h: (c) => {
  const d = q.one('SELECT * FROM dorms WHERE id=?', c.body.id);
  if (!d) throw new ApiError(404, '找不到宿舍');
  if (usedBeds(d.id)) throw new ApiError(400, '宿舍有人住，不能删');
  q.run('DELETE FROM dorms WHERE id=?', d.id);
  return { ok: true };
}},
{ m: 'POST', p: '/api/dorm/auto', perm: 'dorm.assign', audit: '宿舍自动分配', h: (c) => {
  // 自动分配跑全量（操作者需 dorm.assign 权限）；预加载缴费齐集合与床位占用，消除 O(学生×宿舍) N+1 查询（修复 F22）
  const pend = q.all(`SELECT * FROM students WHERE status='报到中'`);
  let assigned = 0; const skipped = [];
  if (!pend.length) return { assigned, skipped };
  const paidSet = new Set(
    q.all(`SELECT student_id FROM fee_state WHERE paid=1 AND item IN ('报名费','住宿费','书费','学费') GROUP BY student_id HAVING COUNT(DISTINCT item)=4`)
      .map(r => r.student_id)
  );
  const usedMap = new Map(q.all('SELECT dorm_id, COUNT(*) AS n FROM dorm_assign WHERE active=1 GROUP BY dorm_id').map(x => [x.dorm_id, x.n]));
  const dorms = q.all('SELECT * FROM dorms WHERE bad=0 ORDER BY building, floor, room').map(d => ({ ...d, used: usedMap.get(d.id) || 0 }));
  const oldAssignMap = new Map(q.all('SELECT student_id, id FROM dorm_assign WHERE active=1').map(x => [x.student_id, x.id]));
  const t = now();
  D.tx(() => {
    for (const s of pend) {
      if (!paidSet.has(s.id)) { skipped.push({ id: s.id, name: s.name, why: '缴费未齐' }); continue; }
      const target = dorms.find(d => d.sex === s.sex && d.used < d.beds);
      if (!target) { skipped.push({ id: s.id, name: s.name, why: `没有空的「${s.sex}」宿舍床位` }); continue; }
      const oldId = oldAssignMap.get(s.id);
      if (oldId) q.run('UPDATE dorm_assign SET active=0 WHERE id=?', oldId);
      q.run('INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(?,?,?,?,1)', s.id, target.id, t, c.user.username);
      q.run('UPDATE students SET status=\'在训\' WHERE id=?', s.id);
      target.used++;
      assigned++;
    }
  });
  return { assigned, skipped };
}},
{ m: 'POST', p: '/api/dorm/assign', perm: 'dorm.assign', audit: '宿舍分配', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  assertCanAssignDorm(s);
  const d = q.one('SELECT * FROM dorms WHERE id=?', c.body.dorm_id);
  if (!d) throw new ApiError(404, '找不到宿舍');
  if (d.sex !== s.sex) throw new ApiError(400, `性别不符：${s.sex} 生只能分「${d.sex}」宿舍`);
  if (usedBeds(d.id) >= d.beds) throw new ApiError(400, '该宿舍床位已满');
  const old = activeAssign(s.id);
  if (old && old.dorm_id === d.id) throw new ApiError(400, '该生已在这个宿舍');
  D.tx(() => {
    assign(s, d, c.user);
    if (['已导入', '报到中'].includes(s.status)) q.run('UPDATE students SET status=\'在训\', checkin_at=COALESCE(checkin_at,?) WHERE id=?', now(), s.id);
  });
  return { ok: true };
}},
{ m: 'POST', p: '/api/dorm/swap', perm: 'dorm.assign', audit: '宿舍调换', h: (c) => {
  const a = getStudent(c, c.body.a);
  const b = getStudent(c, c.body.b);
  assertCanAssignDorm(a);
  assertCanAssignDorm(b);
  if (a.sex !== b.sex) throw new ApiError(400, '只能同性别学生之间调换宿舍');
  const aa = activeAssign(a.id), bb = activeAssign(b.id);
  if (!aa && !bb) throw new ApiError(400, '两人都没有宿舍，请用「分配」');
  if (aa && bb && aa.dorm_id === bb.dorm_id) throw new ApiError(400, '两人已在同一宿舍');
  D.tx(() => {
    const t = now();
    if (aa && bb) { // 互换
      q.run('UPDATE dorm_assign SET dorm_id=? WHERE id=?', bb.dorm_id, aa.id);
      q.run('UPDATE dorm_assign SET dorm_id=? WHERE id=?', aa.dorm_id, bb.id);
    } else if (aa) { // a 有 b 无 → 床位转移给 b
      q.run('UPDATE dorm_assign SET active=0 WHERE id=?', aa.id);
      q.run('INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(?,?,?,?,1)', b.id, aa.dorm_id, t, c.user.username);
      if (['已导入', '报到中'].includes(b.status)) q.run('UPDATE students SET status=\'在训\', checkin_at=COALESCE(checkin_at,?) WHERE id=?', t, b.id);
    } else {
      q.run('UPDATE dorm_assign SET active=0 WHERE id=?', bb.id);
      q.run('INSERT INTO dorm_assign(student_id,dorm_id,at,by,active) VALUES(?,?,?,?,1)', a.id, bb.dorm_id, t, c.user.username);
      if (['已导入', '报到中'].includes(a.status)) q.run('UPDATE students SET status=\'在训\', checkin_at=COALESCE(checkin_at,?) WHERE id=?', t, a.id);
    }
    audit(c.user.username, '宿舍调换', `${a.name}/${b.name}`, '');
  });
  return { ok: true };
}},

// ---- 物资 ----
{ m: 'GET', p: '/api/supplies/catalog', perm: 'student.view', h: () => ({ catalog: q.all('SELECT * FROM supplies_catalog ORDER BY id') })},
{ m: 'POST', p: '/api/supplies/catalog', perm: 'supply.record', audit: '物资目录', h: (c) => {
  const name = String(c.body.name || '').trim();
  if (!name) throw new ApiError(400, '物资名必填');
  if (c.body.delete_id) {
    q.run('DELETE FROM supply_state WHERE item_id=?', c.body.delete_id);
    q.run('DELETE FROM supplies_catalog WHERE id=?', c.body.delete_id);
    return { ok: true };
  }
  try { q.run('INSERT INTO supplies_catalog(name) VALUES(?)', name); } catch { throw new ApiError(409, '物资已存在'); }
  return { ok: true };
}},
{ m: 'POST', p: '/api/supply/list', perm: 'student.view', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  return { records: q.all(`SELECT ss.*, sc.name FROM supply_state ss JOIN supplies_catalog sc ON sc.id=ss.item_id WHERE ss.student_id=?`, s.id),
           catalog: q.all('SELECT * FROM supplies_catalog ORDER BY id') };
}},
{ m: 'POST', p: '/api/supply/set', perm: 'supply.record', audit: '物资登记', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const item = q.one('SELECT * FROM supplies_catalog WHERE id=?', c.body.item_id);
  if (!item) throw new ApiError(404, '找不到该物资');
  const st = ['已领', '未领', '缺'].includes(c.body.status) ? c.body.status : '未领';
  q.run(`INSERT INTO supply_state(student_id,item_id,status,note,at,by) VALUES(?,?,?,?,?,?)
         ON CONFLICT(student_id,item_id) DO UPDATE SET status=excluded.status, note=excluded.note, at=excluded.at, by=excluded.by`,
    s.id, item.id, st, String(c.body.note || ''), now(), c.user.username);
  return { ok: true };
}},

// ---- 发书 ----
{ m: 'GET', p: '/api/books/catalog', perm: 'student.view', h: () => ({ catalog: q.all('SELECT * FROM books_catalog ORDER BY id') })},
{ m: 'POST', p: '/api/books/catalog', perm: 'book.give', audit: '书目维护', h: (c) => {
  const name = String(c.body.name || '').trim();
  if (!name) throw new ApiError(400, '书名必填');
  if (c.body.delete_id) { q.run('DELETE FROM books_catalog WHERE id=?', c.body.delete_id); return { ok: true }; }
  try { q.run('INSERT INTO books_catalog(name) VALUES(?)', name); } catch { throw new ApiError(409, '书目已存在'); }
  return { ok: true };
}},
{ m: 'POST', p: '/api/book/give', perm: 'book.give', audit: '发书', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const book = q.one('SELECT * FROM books_catalog WHERE id=?', c.body.book_id);
  if (!book) throw new ApiError(404, '找不到该书');
  const t = now();
  q.run(`INSERT INTO book_state(student_id,book_id,count,at,by) VALUES(?,?,1,?,?)
         ON CONFLICT(student_id,book_id) DO UPDATE SET count=count+1, at=excluded.at, by=excluded.by`,
    s.id, book.id, t, c.user.username);
  const n = q.one('SELECT count FROM book_state WHERE student_id=? AND book_id=?', s.id, book.id).count;
  return { ok: true, count: n };
}},
{ m: 'POST', p: '/api/book/list', perm: 'student.view', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  return { records: q.all(`SELECT bs.*, bc.name FROM book_state bs JOIN books_catalog bc ON bc.id=bs.book_id WHERE bs.student_id=?`, s.id),
           catalog: q.all('SELECT * FROM books_catalog ORDER BY id') };
}},

// ---- 考勤 ----
{ m: 'POST', p: '/api/att/tap', perm: 'att.view', audit: '刷卡打卡', h: (c) => {
  const chk = checkIdcard(c.body.idcard);
  if (!chk.ok) throw new ApiError(400, chk.why);
  const s = q.one('SELECT * FROM students WHERE idcard=?', chk.id);
  if (!s) return { known: false, msg: '系统里没有这个身份证号——不是我们的学生' };
  assertStudentInScope(c.user, s);
  const stuBrief = { id: s.id, name: s.name, sex: s.sex, class_name: s.class_name, status: s.status };
  if (s.status === '已离校') return { known: true, student: stuBrief, msg: '该学生已离校，打卡拒绝', refused: true };
  const d = today();
  const exist = q.one('SELECT * FROM attendance WHERE student_id=? AND date=?', s.id, d);
  if (exist) return { known: true, student: stuBrief, msg: `今日已打卡（${exist.at.slice(11, 19)}）`, duplicate: true };
  const leave = q.one(`SELECT id FROM leaves WHERE student_id=? AND status='open' AND ? BETWEEN from_d AND to_d`, s.id, d);
  q.run('INSERT INTO attendance(student_id,date,at,by,note) VALUES(?,?,?,?,?)', s.id, d, now(), c.user.username,
        leave ? '请假期间刷卡' : '');
  const photo = q.one('SELECT student_id FROM photos WHERE student_id=?', s.id);
  return { known: true, student: stuBrief,
           has_photo: !!photo, leave_open: !!leave, msg: `打卡成功 ${now().slice(11, 19)}` };
}},
{ m: 'GET', p: '/api/att/day', perm: 'att.view', h: (c) => {
  const d = c.query.date || today();
  const students = q.all(`SELECT id,name,sex,class_name,status FROM students WHERE status IN ('在训','请假中','报到中')`)
    .filter(s => inScope(c.user, s.class_name));
  const taps = q.all('SELECT student_id, at, manual, note FROM attendance WHERE date=?', d);
  const tapMap = new Map(taps.map(t => [t.student_id, t]));
  const openLeaves = new Set(q.all(`SELECT student_id FROM leaves WHERE status='open' AND ? BETWEEN from_d AND to_d`, d).map(l => l.student_id));
  return { date: d, rows: students.map(s => ({ ...s, tap: tapMap.get(s.id) || null, leave_open: openLeaves.has(s.id),
           state: tapMap.get(s.id) ? '出勤' : (openLeaves.has(s.id) ? '请假' : '缺勤') })) };
}},
{ m: 'POST', p: '/api/att/manual', perm: 'att.manual', audit: '补卡', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const d = c.body.date || today();
  if (c.body.remove) { q.run('DELETE FROM attendance WHERE student_id=? AND date=?', s.id, d); return { ok: true, msg: '已删除该日打卡' }; }
  const exist = q.one('SELECT id FROM attendance WHERE student_id=? AND date=?', s.id, d);
  if (exist) throw new ApiError(409, '该生当日已有打卡记录');
  q.run('INSERT INTO attendance(student_id,date,at,by,manual,note) VALUES(?,?,?,?,-1,?)', s.id, d, now(), c.user.username, String(c.body.note || '人工补卡'));
  return { ok: true };
}},

// ---- 请假销假 ----
{ m: 'GET', p: '/api/leaves', perm: 'leave.record', h: (c) => {
  const rows = q.all(`SELECT l.*, s.name, s.class_name FROM leaves l JOIN students s ON s.id=l.student_id
                      ${c.query.open ? `WHERE l.status='open'` : ''} ORDER BY l.id DESC LIMIT 500`);
  return { leaves: rows.filter(l => inScope(c.user, l.class_name)) };
}},
{ m: 'POST', p: '/api/leave/add', perm: 'leave.record', audit: '登记请假', h: (c) => {
  const s = getStudent(c, c.body.student_id);
  const from = String(c.body.from || '').slice(0, 10), to = String(c.body.to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new ApiError(400, '请假日期不对');
  // 修复：同一学生日期重叠的未销假请假单只允许一张
  const ov = q.one(`SELECT id FROM leaves WHERE student_id=? AND status='open' AND from_d<=? AND to_d>=?`, s.id, to, from);
  if (ov) throw new ApiError(409, '该生在所选日期已有未销假的请假单，请先销假或调整日期');
  D.tx(() => {
    q.run('INSERT INTO leaves(student_id,from_d,to_d,reason,by,at) VALUES(?,?,?,?,?,?)',
      s.id, from, to, String(c.body.reason || ''), c.user.username, now());
    if (s.status === '在训') q.run('UPDATE students SET status=\'请假中\' WHERE id=?', s.id);
  });
  return { ok: true };
}},
{ m: 'POST', p: '/api/leave/close', perm: 'leave.close', audit: '销假', h: (c) => {
  const l = q.one('SELECT * FROM leaves WHERE id=?', c.body.id);
  if (!l) throw new ApiError(404, '找不到请假单');
  assertStudentInScope(c.user, q.one('SELECT * FROM students WHERE id=?', l.student_id));
  if (l.status === 'closed') throw new ApiError(409, '已销过假');
  q.run(`UPDATE leaves SET status='closed', closed_at=?, closed_by=? WHERE id=?`, now(), c.user.username, l.id);
  const s = q.one('SELECT * FROM students WHERE id=?', l.student_id);
  if (s && s.status === '请假中') q.run('UPDATE students SET status=\'在训\' WHERE id=?', s.id);
  return { ok: true };
}},
];
};
