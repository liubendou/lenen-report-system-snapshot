'use strict';
// 手动/定时备份：VACUUM INTO 到 data/backups/，校验完整性，保留最近 30 份。用法：node backup.js
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { cstStamp } = require('./lib/migrations');

const DATA_DIR = process.env.LENEN_DATA || path.join(__dirname, 'data');
const bakDir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(bakDir, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'lenen.db'), { readOnly: false });
db.exec('PRAGMA busy_timeout=5000');
const stamp = cstStamp();
let target = path.join(bakDir, `lenen-${stamp}.db`);
let seq = 1;
while (fs.existsSync(target)) {
  target = path.join(bakDir, `lenen-${stamp}-${seq++}.db`);
}
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

// 备份后立即验证完整性，防止损坏备份静默淘汰历史好备份
const verifyDb = new DatabaseSync(target, { readOnly: true });
const ic = verifyDb.prepare('PRAGMA integrity_check').get();
verifyDb.close();
if (!ic || Object.values(ic)[0] !== 'ok') {
  try { fs.unlinkSync(target); } catch {}
  console.error('backup integrity_check FAILED:', ic);
  process.exit(1);
}

const files = fs.readdirSync(bakDir).filter(f => f.endsWith('.db')).sort();
while (files.length > 30) fs.unlinkSync(path.join(bakDir, files.shift()));
console.log('backup ->', target, `(${files.length} kept, integrity=ok)`);
