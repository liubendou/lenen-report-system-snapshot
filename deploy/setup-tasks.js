'use strict';
/* 注册 Windows 计划任务：开机自启 + 每日备份。需管理员权限运行：node deploy\setup-tasks.js */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const node = process.execPath;
const here = __dirname; // deploy/
const home = path.resolve(here, '..');

function schtasks(args) {
  try { console.log(execFileSync('schtasks', args, { encoding: 'utf8' }).trim()); }
  catch (e) { console.error('schtasks failed:', (e.stdout || '') + (e.stderr || e.message)); process.exitCode = 1; }
}
schtasks(['/Create', '/TN', 'lenen-autostart', '/TR', `"${node}" "${path.join(home, 'server.js')}"`, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/F']);
schtasks(['/Create', '/TN', 'lenen-backup', '/TR', `"${node}" "${path.join(home, 'backup.js')}"`, '/SC', 'DAILY', '/ST', '23:30', '/RU', 'SYSTEM', '/F']);
console.log('done: lenen-autostart (ONSTART) + lenen-backup (daily 23:30, keep 30)');
