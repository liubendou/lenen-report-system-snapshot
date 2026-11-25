'use strict';
/* 数据库版本迁移 CLI：
   node deploy/migrate.js status       → 查看当前版本与最新版本
   node deploy/migrate.js up [target]  → 前进到指定版本（默认最新）
   node deploy/migrate.js down <target>→ 回滚到指定版本（如 8） */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { LATEST_VERSION, getVersion, migrateTo } = require('../lib/migrations');

const DATA_DIR = process.env.LENEN_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'lenen.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');

const cmd = (process.argv[2] || 'status').toLowerCase();
const before = getVersion(db);

if (cmd === 'status') {
  console.log(`db=${dbPath} current=v${before} latest=v${LATEST_VERSION}`);
  db.close();
  process.exit(0);
}
if (cmd === 'up') {
  const target = process.argv[3] ? Number(process.argv[3]) : LATEST_VERSION;
  const after = migrateTo(db, target);
  console.log(`migrate up: v${before} -> v${after}`);
  db.close();
  process.exit(0);
}
if (cmd === 'down') {
  const target = Number(process.argv[3]);
  if (!Number.isInteger(target) || target < 8) {
    console.error('请指定合法回退目标版本（>= 8），例如：node deploy/migrate.js down 8');
    db.close();
    process.exit(1);
  }
  const after = migrateTo(db, target);
  console.log(`migrate down: v${before} -> v${after}`);
  db.close();
  process.exit(0);
}

console.error('未知命令：支持 status / up / down');
db.close();
process.exit(1);

