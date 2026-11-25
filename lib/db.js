'use strict';
// SQLite(node:sqlite) 初始化与种子数据；备份用 VACUUM INTO
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('./auth');
const { PERM_KEYS, scrubIdcards } = require('./perm');
const { migrateTo, cstStamp } = require('./migrations');

let db = null;

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'lenen.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA synchronous=NORMAL');
  migrateTo(db);
  seed();
  dailyBackup(dataDir);
  return db;
}

/* 启动时兜底备份：当天还没有备份就做一份（与定时任务/backup.js 同目录同保留策略，统一用北京时间） */
function dailyBackup(dataDir) {
  try {
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const have = fs.readdirSync(dir).some(f => f.includes(today));
    if (!have) {
      const stamp = cstStamp();
      backupTo(path.join(dir, `lenen-${stamp}.db`));
      console.log('[lenen] 启动自动备份完成');
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) { console.error('[lenen] 启动备份失败(不影响运行):', e.message); }
}

function seed() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM positions').get().n;
  if (n === 0) {
    db.prepare('INSERT INTO positions(name, perms, scope, system) VALUES(?,?,?,1)')
      .run('校长', JSON.stringify(PERM_KEYS), JSON.stringify({ type: 'all' }));
  }
  const u = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (u === 0) {
    const pos = db.prepare('SELECT id FROM positions WHERE system=1').get();
    db.prepare('INSERT INTO users(username,name,pass,position_id,status,created_at,must_change) VALUES(?,?,?,?,?,?,1)')
      .run('admin', '校长', hashPassword('change-me-on-first-login'), pos.id, 'active', new Date().toISOString());
  }
}

function backupTo(file) { db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); }
/* 事务包装：多写操作要么全成要么全滚（S4 数据完整性审查；支持 SAVEPOINT 可重入嵌套） */
let txDepth = 0;
function tx(fn) {
  const sp = `sp_${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
    return out;
  } catch (e) {
    txDepth--;
    try { db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`); } catch (e2) {}
    throw e;
  }
}
function close() { try { db.close(); } catch (e) {} }
function audit(user, action, target, detail) {
  const safeTarget = scrubIdcards(String(target || '')).slice(0, 80);
  const safeDetail = scrubIdcards(String(detail || '')).slice(0, 500);
  db.prepare('INSERT INTO audit(at,user,action,target,detail) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), user || '-', action || '', safeTarget, safeDetail);
}
const q = {
  one: (sql, ...a) => db.prepare(sql).get(...a),
  all: (sql, ...a) => db.prepare(sql).all(...a),
  run: (sql, ...a) => db.prepare(sql).run(...a),
};
module.exports = { init, backupTo, audit, q, tx, close };
