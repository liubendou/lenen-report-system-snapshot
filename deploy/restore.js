'use strict';
/* 数据库备份恢复工具（需先停止服务后运行）：
   用法：node deploy/restore.js <备份文件路径> */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateTo, cstStamp } = require('../lib/migrations');

const bakFile = process.argv[2];
if (!bakFile || !fs.existsSync(bakFile)) {
  console.error('用法：node deploy/restore.js <备份文件路径>');
  process.exit(1);
}

// 1. 校验备份文件完整性
const checkDb = new DatabaseSync(bakFile, { readOnly: true });
const ic = checkDb.prepare('PRAGMA integrity_check').get();
checkDb.close();
if (!ic || Object.values(ic)[0] !== 'ok') {
  console.error('备份文件完整性检查未通过，拒绝恢复:', ic);
  process.exit(1);
}

const DATA_DIR = process.env.LENEN_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
const mainDb = path.join(DATA_DIR, 'lenen.db');

// 2. 恢复前将当前库另存一份保险快照
if (fs.existsSync(mainDb)) {
  const prePath = path.join(DATA_DIR, 'backups', `pre-restore-${cstStamp()}.db`);
  fs.copyFileSync(mainDb, prePath);
  console.log('已保存恢复前快照:', prePath);
}

// 3. 覆盖主库并清理残留 WAL/SHM
fs.copyFileSync(bakFile, mainDb);
for (const ext of ['-wal', '-shm']) {
  try { if (fs.existsSync(mainDb + ext)) fs.unlinkSync(mainDb + ext); } catch {}
}

// 4. 对齐当前代码 Schema 版本
const db = new DatabaseSync(mainDb);
const ver = migrateTo(db);
const stuN = db.prepare('SELECT COUNT(*) AS n FROM students').get().n;
db.close();
console.log(`RESTORE_OK: 已从 ${bakFile} 恢复（schema=v${ver}，学生数=${stuN}）`);

