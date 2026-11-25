'use strict';
/* 管理员密码重置工具（在服务器上本机运行）：
   node deploy\reset-admin.js            → 重置为初始密码 change-me-on-first-login（首登强制改密）
   node deploy\reset-admin.js 新密码     → 直接设置为指定密码（至少 8 位） */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const DATA_DIR = process.env.LENEN_DATA || path.join(__dirname, '..', 'data');
const db = new DatabaseSync(path.join(DATA_DIR, 'lenen.db'));
const newPw = process.argv[2] || 'change-me-on-first-login';
if (newPw.length < 8) { console.error('密码至少 8 位'); process.exit(1); }
const salt = crypto.randomBytes(16).toString('hex');
const h = crypto.scryptSync(newPw, salt, 32).toString('hex');
const u = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
if (!u) { console.error('找不到 admin 账号'); process.exit(1); }
db.prepare('UPDATE users SET pass=?, must_change=?, status=? WHERE id=?').run('s1$' + salt + '$' + h, process.argv[2] ? 0 : 1, 'active', u.id);
db.prepare('DELETE FROM sessions WHERE uid=?').run(u.id);
db.close();
console.log('OK：admin 密码已重置为', process.argv[2] ? '你指定的新密码' : 'change-me-on-first-login（首次登录需修改）');
