'use strict';
// 版本化数据库迁移器：支持按 user_version 前进 (up) 与回退 (down)（修复 F07/F13）

const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS positions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL,
  perms TEXT NOT NULL, scope TEXT NOT NULL, system INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, pass TEXT NOT NULL, position_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, must_change INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY AUTOINCREMENT, idcard TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, sex TEXT NOT NULL, phone TEXT DEFAULT '',
  class_name TEXT DEFAULT '', status TEXT NOT NULL DEFAULT '已导入',
  checkin_at TEXT, created_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS photos(
  student_id INTEGER PRIMARY KEY, blob BLOB NOT NULL, taken_at TEXT, by TEXT);
CREATE TABLE IF NOT EXISTS fee_state(
  student_id INTEGER, item TEXT, amount REAL DEFAULT 0, paid INTEGER DEFAULT 0,
  method TEXT DEFAULT '', at TEXT, by TEXT, PRIMARY KEY(student_id, item));
CREATE TABLE IF NOT EXISTS fee_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, item TEXT,
  action TEXT, amount REAL, at TEXT, by TEXT);
CREATE TABLE IF NOT EXISTS dorms(
  id INTEGER PRIMARY KEY AUTOINCREMENT, building TEXT NOT NULL, floor INTEGER NOT NULL,
  room TEXT NOT NULL, sex TEXT NOT NULL, beds INTEGER NOT NULL, bad INTEGER DEFAULT 0,
  note TEXT DEFAULT '', UNIQUE(building, room));
CREATE TABLE IF NOT EXISTS dorm_assign(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, dorm_id INTEGER,
  at TEXT, by TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS supplies_catalog(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS supply_state(
  student_id INTEGER, item_id INTEGER, status TEXT DEFAULT '未领', note TEXT DEFAULT '',
  at TEXT, by TEXT, PRIMARY KEY(student_id, item_id));
CREATE TABLE IF NOT EXISTS books_catalog(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS book_state(
  student_id INTEGER, book_id INTEGER, count INTEGER DEFAULT 0, at TEXT, by TEXT,
  PRIMARY KEY(student_id, book_id));
CREATE TABLE IF NOT EXISTS attendance(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, date TEXT, at TEXT,
  by TEXT, manual INTEGER DEFAULT 0, note TEXT DEFAULT '', UNIQUE(student_id, date));
CREATE TABLE IF NOT EXISTS leaves(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, from_d TEXT, to_d TEXT,
  reason TEXT DEFAULT '', by TEXT, at TEXT, status TEXT DEFAULT 'open',
  closed_at TEXT, closed_by TEXT);
CREATE TABLE IF NOT EXISTS scores(
  id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER, exam TEXT, subject TEXT,
  value REAL, at TEXT, by TEXT, UNIQUE(student_id, exam, subject));
CREATE TABLE IF NOT EXISTS departures(
  student_id INTEGER PRIMARY KEY, supplies_ok INTEGER DEFAULT 0, clean_ok INTEGER DEFAULT 0,
  clean_note TEXT DEFAULT '', refund REAL DEFAULT 0, done INTEGER DEFAULT 0,
  at TEXT, by TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, user TEXT, action TEXT,
  target TEXT DEFAULT '', detail TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);
CREATE INDEX IF NOT EXISTS idx_da_student ON dorm_assign(student_id, active);
CREATE INDEX IF NOT EXISTS idx_da_dorm ON dorm_assign(dorm_id, active);
CREATE INDEX IF NOT EXISTS idx_scores_exam ON scores(exam);
CREATE INDEX IF NOT EXISTS idx_leaves_stu ON leaves(student_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS idx_users_pos ON users(position_id);
CREATE TABLE IF NOT EXISTS sessions(
  sid TEXT PRIMARY KEY, uid INTEGER NOT NULL, exp INTEGER NOT NULL);
`;

const MIGRATIONS = [
  {
    version: 8,
    name: '008_baseline',
    up(db) {
      db.exec(BASELINE_SQL);
    },
    down() {
      throw new Error('基线版本 v8 不可继续回退');
    },
  },
  {
    version: 9,
    name: '009_dorm_active_uidx',
    up(db) {
      // 若历史数据同一学生有多条 active=1，仅保留最新一条
      db.exec(`UPDATE dorm_assign SET active=0 WHERE active=1 AND id NOT IN (SELECT MAX(id) FROM dorm_assign WHERE active=1 GROUP BY student_id)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_da_one_active ON dorm_assign(student_id) WHERE active=1`);
    },
    down(db) {
      db.exec(`DROP INDEX IF EXISTS uidx_da_one_active`);
    },
  },
  {
    version: 10,
    name: '010_req_dedupe',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS req_dedupe(
          req_id TEXT PRIMARY KEY,
          uid INTEGER,
          path TEXT,
          status INTEGER,
          resp TEXT,
          at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_req_dedupe_at ON req_dedupe(at);
      `);
    },
    down(db) {
      db.exec(`DROP INDEX IF EXISTS idx_req_dedupe_at; DROP TABLE IF EXISTS req_dedupe;`);
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version || 0);
}

function migrateTo(db, target = LATEST_VERSION) {
  db.exec(BASELINE_SQL);
  let cur = getVersion(db);
  if (cur < 8) {
    db.exec('PRAGMA user_version=8');
    cur = 8;
  }
  while (cur < target) {
    const next = cur + 1;
    const m = MIGRATIONS.find(x => x.version === next);
    if (!m) throw new Error('找不到迁移脚本 v' + next);
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version=${next}`);
      db.exec('COMMIT');
      cur = next;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  while (cur > target) {
    const m = MIGRATIONS.find(x => x.version === cur);
    if (!m) throw new Error('找不到回退脚本 v' + cur);
    const prev = cur - 1;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.down(db);
      db.exec(`PRAGMA user_version=${prev}`);
      db.exec('COMMIT');
      cur = prev;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  return cur;
}

/* 北京时间备份时间戳：YYYY-MM-DD-HH-mm-ss（保证与 Asia/Shanghai 日期判重完全一致） */
function cstStamp(d = new Date()) {
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); // "YYYY-MM-DD HH:MM:SS"
  return s.replace(/[ :]/g, '-').slice(0, 19);
}

module.exports = { MIGRATIONS, LATEST_VERSION, getVersion, migrateTo, cstStamp };

