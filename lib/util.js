'use strict';
// 路由公共工具：错误、时间、数据范围过滤
class ApiError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const now = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD

function scopeOf(user) { return user._scope || { type: 'all' }; }
function inScope(user, className) {
  const sc = scopeOf(user);
  if (sc.type === 'all') return true;
  if (!className) return true; // 未分班的学生所有人可见（需分班）
  return (sc.classes || []).includes(className);
}
function assertStudentInScope(user, stu) {
  if (!stu) throw new ApiError(404, '找不到该学生');
  if (!inScope(user, stu.class_name)) throw new ApiError(403, '该学生不在你的数据范围内');
}
/* 按学生查询的统一入口：整数 id + 存在性 + 数据范围（工程审查：ops/admin 两处重复实现收拢） */
function getStudentScoped(q, c, id) {
  const n = Number(id);
  if (!Number.isInteger(n)) throw new ApiError(404, '找不到该学生');
  const s = q.one('SELECT * FROM students WHERE id=?', n);
  assertStudentInScope(c.user, s);
  return s;
}
function feeAllPaid(db, studentId) {
  const rows = db.all('SELECT item, paid FROM fee_state WHERE student_id=?', studentId);
  const items = rows.map(r => r.item);
  for (const it of ['报名费', '住宿费', '书费', '学费']) if (!items.includes(it) || rows.find(r => r.item === it).paid !== 1) return false;
  return true; // 押金不强制（报道后缴也可），四项必缴才算缴费齐
}
module.exports = { ApiError, now, today, inScope, assertStudentInScope, scopeOf, feeAllPaid, getStudentScoped };
