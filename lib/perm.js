'use strict';
// 权限点目录（内置枚举，岗位=勾选组合；校长=全量，不可改）
const GROUPS = ['学生', '缴费', '宿舍', '物资书', '考勤', '请假', '成绩', '离校', '报表', '系统'];
const PERMS = [
  { k: 'student.import',  g: '学生',   t: '导入学生' },
  { k: 'student.view',    g: '学生',   t: '查看学生' },
  { k: 'student.edit',    g: '学生',   t: '编辑学生' },
  { k: 'fee.record',      g: '缴费',   t: '登记缴费' },
  { k: 'fee.edit',        g: '缴费',   t: '修改缴费金额' },
  { k: 'deposit.refund',  g: '缴费',   t: '退还押金' },
  { k: 'dorm.manage',     g: '宿舍',   t: '宿舍楼管理' },
  { k: 'dorm.assign',     g: '宿舍',   t: '分配与调换' },
  { k: 'supply.record',   g: '物资书', t: '物资登记' },
  { k: 'book.give',       g: '物资书', t: '发书' },
  { k: 'att.view',        g: '考勤',   t: '查看考勤' },
  { k: 'att.manual',      g: '考勤',   t: '补卡改卡' },
  { k: 'leave.record',    g: '请假',   t: '登记请假' },
  { k: 'leave.close',     g: '请假',   t: '销假' },
  { k: 'score.view',      g: '成绩',   t: '查看成绩' },
  { k: 'score.import',    g: '成绩',   t: '导入成绩' },
  { k: 'score.edit',      g: '成绩',   t: '修改成绩' },
  { k: 'depart.process',  g: '离校',   t: '离校办理' },
  { k: 'report.view',     g: '报表',   t: '查看报表' },
  { k: 'report.export',   g: '报表',   t: '导出数据' },
  { k: 'admin.users',     g: '系统',   t: '员工管理' },
  { k: 'admin.positions', g: '系统',   t: '岗位权限管理' },
  { k: 'audit.view',      g: '系统',   t: '审计日志' },
];
const PERM_KEYS = PERMS.map(p => p.k);
const FEE_ITEMS = ['报名费', '住宿费', '书费', '学费', '押金'];
const STATUSES = ['已导入', '报到中', '在训', '请假中', '离校办理中', '已离校'];

const { checkIdcard, maskIdcard, scrubIdcards } = require('./domain/idcard');

module.exports = { PERMS, PERM_KEYS, GROUPS, FEE_ITEMS, STATUSES, checkIdcard, maskIdcard, scrubIdcards };
