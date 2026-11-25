'use strict';
// 学生状态机守卫：集中定义合法状态与前置条件（修复 F02/F03 服务端状态机绕过）
const { ApiError } = require('../util');

const STATUSES = ['已导入', '报到中', '在训', '请假中', '离校办理中', '已离校'];
const DORM_ELIGIBLE = ['已导入', '报到中', '在训', '请假中'];
const DEPART_START_ELIGIBLE = ['在训', '请假中'];

function assertCanAssignDorm(stu) {
  if (!DORM_ELIGIBLE.includes(stu.status)) {
    throw new ApiError(400, `该学生当前状态为「${stu.status}」，不能分配或调换宿舍`);
  }
}

function assertCanStartDepart(stu) {
  if (!DEPART_START_ELIGIBLE.includes(stu.status)) {
    throw new ApiError(400, `当前状态「${stu.status}」不能开始离校`);
  }
}

function assertInDepart(stu) {
  if (stu.status !== '离校办理中') {
    throw new ApiError(400, `当前状态「${stu.status}」未处于离校办理中，请先点击开始离校`);
  }
}

module.exports = {
  STATUSES,
  DORM_ELIGIBLE,
  DEPART_START_ELIGIBLE,
  assertCanAssignDorm,
  assertCanStartDepart,
  assertInDepart,
};

