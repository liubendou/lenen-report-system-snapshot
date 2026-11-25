'use strict';
// 会话与口令：scrypt 哈希 + 内存会话 + 登录失败锁定
const crypto = require('node:crypto');

const sessions = new Map(); // sid -> {uid, exp}（内存缓存，写穿到 store 即重启不丢）
const failCnt = new Map();  // key -> {n, until}
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAIL = 5, LOCK_MS = 10 * 60 * 1000;
let store = null; // { get, put, del, clean } 由 server.js 注入（SQLite sessions 表）
function attachSessionStore(s2) { store = s2; }
function cleanExpired() { if (store) { try { store.clean(); } catch {} } }

/* 强随机临时密码（Ln + 12 位 base64url + !） */
function strongPassword() { return 'Ln' + crypto.randomBytes(9).toString('base64url') + '!'; }
/* 未知用户时的耗时对齐（防用户名枚举：失败路径与 scrypt 校验耗时接近） */
function equalizeTiming() { try { crypto.scryptSync('lenen-equalize', 'salt', 32); } catch (e) {} }
function scryptHexAsync(pw, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), salt, 32, (err, key) => err ? reject(err) : resolve(key.toString('hex')));
  });
}
async function equalizeTimingAsync() { try { await scryptHexAsync('lenen-equalize', 'salt'); } catch (e) {} }
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return 's1$' + salt + '$' + h;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, h] = String(stored).split('$');
    const got = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
  } catch { return false; }
}
async function verifyPasswordAsync(pw, stored) {
  try {
    const [, salt, h] = String(stored).split('$');
    const got = await scryptHexAsync(pw, salt);
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
  } catch { return false; }
}
function loginKey(u, ip) { return String(u).toLowerCase() + '|' + ip; }
function loginBlocked(u, ip) { const f = failCnt.get(loginKey(u, ip)); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function loginFail(u, ip) { const k = loginKey(u, ip); const f = failCnt.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= MAX_FAIL) { f.until = Date.now() + LOCK_MS; f.n = 0; } failCnt.set(k, f); }
function loginOk(u, ip) { failCnt.delete(loginKey(u, ip)); }

function createSession(uid) {
  const sid = crypto.randomBytes(24).toString('base64url');
  const exp = Date.now() + SESSION_MS;
  sessions.set(sid, { uid, exp });
  if (store) { try { store.put(sid, uid, exp); } catch {} }
  return sid;
}
function getSession(sid) {
  if (!sid) return null;
  let s = sessions.get(sid);
  if (!s && store) {
    try { const row = store.get(sid); if (row) { s = { uid: row.uid, exp: row.exp }; sessions.set(sid, s); } } catch {}
  }
  if (!s) return null;
  if (s.exp < Date.now()) { dropSession(sid); return null; }
  const prevExp = s.exp;
  s.exp = Date.now() + SESSION_MS; // 滑动续期（每分钟节流写盘一次，并通知响应刷新 Cookie Max-Age）
  if (s.exp - prevExp >= 60 * 1000) {
    s._renewed = true;
    if (store) { try { store.put(sid, s.uid, s.exp); } catch {} }
  }
  return s;
}
function dropSession(sid) {
  sessions.delete(sid);
  if (store) { try { store.del(sid); } catch {} }
}
function dropUserSessions(uid) {
  for (const [k, v] of sessions) if (v.uid === uid) sessions.delete(k);
  if (store && store.delByUser) { try { store.delByUser(uid); } catch {} }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync, strongPassword, equalizeTiming, equalizeTimingAsync, loginBlocked, loginFail, loginOk, createSession, getSession, dropSession, dropUserSessions, parseCookies, SESSION_MS, attachSessionStore, cleanExpired };
