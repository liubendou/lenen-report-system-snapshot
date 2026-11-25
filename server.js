'use strict';
// 乐恩报道管理系统 · 纯 Node 零依赖（http + node:sqlite，需 Node >= 22.5）
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const VERSION = '1.3.8';
const GZ_CACHE = new Map(); // path -> {mtimeMs, gz}
const GZ_TYPES = new Set(['text/css', 'text/javascript', 'text/html', 'application/json', 'image/svg+xml', 'text/csv']);
const gzable = (t) => GZ_TYPES.has(String(t).split(';')[0].trim());
const PORT = Number(process.env.LENEN_PORT) || 8800;
const DATA_DIR = process.env.LENEN_DATA || path.join(__dirname, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
function errLog(...a) { try { fs.appendFileSync(path.join(LOG_DIR, 'error.log'), new Date().toISOString() + ' ' + scrubIdcards(a.map(x => (x && x.stack) || String(x)).join(' | ')) + '\n'); } catch (e) {} }
const PUBLIC_DIR = path.join(__dirname, 'public');

const dbm = require('./lib/db');
const A = require('./lib/auth');
const { PERMS, PERM_KEYS, GROUPS, scrubIdcards } = require('./lib/perm');
const { ApiError } = require('./lib/util');
const { parseSpreadsheet } = require('./lib/xlsxmini');

dbm.init(DATA_DIR);
const { q, audit } = dbm;

const D = { q, audit, auth: A, tx: dbm.tx, allPerms: PERM_KEYS, permList: PERMS, groups: GROUPS, parseSpreadsheet, version: VERSION };
const ROUTES = new Map();
for (const mod of ['./lib/routes_core', './lib/routes_ops', './lib/routes_admin']) {
  for (const r of require(mod)(D)) {
    if (ROUTES.has(r.m + ' ' + r.p)) throw new Error('路由重复: ' + r.p);
    ROUTES.set(r.m + ' ' + r.p, r);
  }
}
A.attachSessionStore({
  get: (sid) => q.one('SELECT uid, exp FROM sessions WHERE sid=?', sid),
  put: (sid, uid, exp) => q.run('INSERT INTO sessions(sid,uid,exp) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET uid=excluded.uid, exp=excluded.exp', sid, uid, exp),
  del: (sid) => q.run('DELETE FROM sessions WHERE sid=?', sid),
  delByUser: (uid) => q.run('DELETE FROM sessions WHERE uid=?', uid),
  clean: () => {
    const nowMs = Date.now();
    q.run('DELETE FROM sessions WHERE exp < ?', nowMs);
    try { q.run('DELETE FROM req_dedupe WHERE at < ?', nowMs - 24 * 3600 * 1000); } catch {}
  },
});
A.cleanExpired();
setInterval(() => A.cleanExpired(), 30 * 60 * 1000).unref(); // 每半小时清扫过期会话
console.log(`[lenen] 路由 ${ROUTES.size} 条  版本 ${VERSION}`);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', c => { size += c.length; if (size > limit) { if (!over) { over = true; reject(new ApiError(413, '请求体太大')); } } else if (!over) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function json(res, status, obj, extraHeaders = {}) {
  let buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders };
  if (res.__gz && buf.length > 500) {
    buf = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  let pathname = req.url || '/';
  // 只信 socket 地址：X-Forwarded-For 可伪造，会绕过登录锁定/注册限流（S1 审查发现）
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  res.__gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 注：不设 X-Frame-Options / frame-ancestors——手机端经隧道/预览页(iframe)访问会被整页拒渲染（v1.3.5 实测事故）
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    let u;
    try {
      u = new URL(req.url, 'http://x');
      pathname = decodeURIComponent(u.pathname);
    } catch {
      throw new ApiError(400, '请求路径编码不合法');
    }
    // ---- API ----
    if (pathname.startsWith('/api/')) {
      // 同源防护：带 Origin 的写请求必须同源（内网多设备访问按 Host 判断）
      if (req.method !== 'GET' && req.headers.origin) {
        // 严格比对：Origin 解析出的 host 必须与请求 Host 完全一致（修复：原来 includes 子串可绕过）
        let ohost = '';
        try { ohost = new URL(String(req.headers.origin)).host.toLowerCase(); } catch (e) {}
        if (!ohost || ohost !== String(req.headers.host || '').toLowerCase()) throw new ApiError(403, '跨站请求被拒绝');
      }
      const cookies = A.parseCookies(req);
      const sid = cookies.lenen_sid || '';
      const sess = A.getSession(sid);
      const route = ROUTES.get(req.method + ' ' + pathname);
      if (!route) throw new ApiError(404, '接口不存在: ' + pathname);
      let user = null;
      if (sess) user = q.one('SELECT * FROM users WHERE id=?', sess.uid);
      if (!user || user.status !== 'active') user = null;
      if (route.perm && !user) throw new ApiError(401, '请先登录');
      let perms = [];
      let scope = { type: 'all' };
      if (user) {
        const pos = user.position_id ? q.one('SELECT * FROM positions WHERE id=?', user.position_id) : null;
        perms = pos ? JSON.parse(pos.perms) : [];
        scope = pos ? JSON.parse(pos.scope) : { type: 'all' };
        if (route.perm && !perms.includes(route.perm)) throw new ApiError(403, `缺少权限「${route.perm}」，请联系校长分配`);
      }
      let body = {};
      if (req.method === 'POST') {
        const rawBuf = await readBody(req); // 413 在此抛出，原样透传
        try { body = JSON.parse(rawBuf.toString('utf8') || '{}'); }
        catch { throw new ApiError(400, '请求体不是合法 JSON'); }
      }
      const query = Object.fromEntries(u.searchParams.entries());
      const ctx = {
        req, res, user, body, query, sid, ip,
        setCookie: (v) => res.setHeader('Set-Cookie', `lenen_sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${A.SESSION_MS / 1000}`),
        clearCookie: () => res.setHeader('Set-Cookie', 'lenen_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'),
        rawOut: (status, text, type, download) => {
          let buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
          const headers = { 'Content-Type': type, 'Cache-Control': 'no-store',
            ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(download)}` } : {}) };
          if (res.__gz && !download && gzable(type) && buf.length > 1024) {
            buf = zlib.gzipSync(buf);
            headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
          }
          headers['Content-Length'] = buf.length;
          res.writeHead(status, headers);
          res.end(buf);
        },
      };
      if (user) user.perms = perms, user._scope = scope;
      if (sess && sess._renewed) { sess._renewed = false; ctx.setCookie(sid); }
      // 首登强制改密的服务端强制：改密/登出/自身信息放行，其余接口一律 403（修复：原来仅前端拦截）
      if (user && user.must_change && !['/api/me', '/api/logout', '/api/my/password'].includes(pathname))
        throw new ApiError(403, '首次登录，请先修改初始密码再操作');
      const reqId = req.method === 'POST' && user ? String(req.headers['x-req-id'] || '').trim().slice(0, 64) : '';
      if (reqId) {
        const dup = q.one('SELECT status, resp FROM req_dedupe WHERE req_id=? AND uid=? AND path=?', reqId, user.id, pathname);
        if (dup) return json(res, dup.status, JSON.parse(dup.resp));
      }
      const writeAudit = () => {
        if (route.audit && user) {
          const brief = {};
          for (const [k2, v2] of Object.entries(body)) {
            if (k2.endsWith('_b64') || k2 === 'b64' || k2 === 'password' || k2 === 'new' || k2 === 'old') continue;
            brief[k2] = typeof v2 === 'string' && v2.length > 40 ? v2.slice(0, 40) + '…' : v2;
          }
          dbm.audit(user.username, route.audit, String(body.idcard || body.student_id || body.id || ''), JSON.stringify(brief).slice(0, 400));
        }
      };
      let out;
      if (req.method === 'POST' && route.h && !route.async) {
        out = dbm.tx(() => {
          const r = route.h(ctx);
          if (!(r && r.__done) && !(r && r.__raw)) {
            writeAudit();
            if (reqId) q.run('INSERT OR REPLACE INTO req_dedupe(req_id,uid,path,status,resp,at) VALUES(?,?,?,200,?,?)', reqId, user.id, pathname, JSON.stringify(r), Date.now());
          }
          return r;
        });
      } else {
        out = route.h ? await route.h(ctx) : route.raw(ctx);
        if (!(out && out.__done) && !(out && out.__raw || route.raw)) {
          writeAudit();
          if (reqId) q.run('INSERT OR REPLACE INTO req_dedupe(req_id,uid,path,status,resp,at) VALUES(?,?,?,200,?,?)', reqId, user.id, pathname, JSON.stringify(out), Date.now());
        }
      }
      if (out && out.__done) return;
      if (out && out.__raw || route.raw) return ctx.rawOut(200, out.text, out.type, out.download);
      return json(res, 200, out);
    }
    // ---- 静态文件（gzip + 分级缓存：vendor/带版本=长期缓存，入口页 no-cache）----
    let file = pathname === '/' ? '/index.html' : pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) throw new ApiError(403, 'forbidden');
    const isIndex = !fs.existsSync(full) || !fs.statSync(full).isFile(); // SPA 回退
    const real = isIndex ? path.join(PUBLIC_DIR, 'index.html') : full;
    const type = isIndex ? MIME['.html'] : (MIME[path.extname(real)] || 'application/octet-stream');
    const entryPage = isIndex || real === path.join(PUBLIC_DIR, 'index.html');
    const cacheCtl = entryPage ? 'no-cache'
      : (/\bv=\d+/.test(req.url) || real.includes(path.join('vendor', '')) ? 'public, max-age=2592000, immutable' : 'public, max-age=3600');
    const st = fs.statSync(real);
    let body = fs.readFileSync(real), headers = { 'Content-Type': type, 'Cache-Control': cacheCtl };
    if (entryPage) headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'";
    if (res.__gz && gzable(type) && body.length > 1024) {
      const key = real;
      const hit = GZ_CACHE.get(key);
      if (hit && hit.mtimeMs === st.mtimeMs) body = hit.gz;
      else { body = zlib.gzipSync(body); GZ_CACHE.set(key, { mtimeMs: st.mtimeMs, gz: body }); if (GZ_CACHE.size > 60) GZ_CACHE.delete(GZ_CACHE.keys().next().value); }
      headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    if (e instanceof ApiError) return json(res, e.status, { error: e.message });
    console.error('[lenen] 500', pathname, e);
    errLog('500 ' + pathname, e);
    return json(res, 500, { error: '服务器内部错误，请稍后重试；若反复出现请联系管理员检查服务端日志' });
  }
});

server.on('error', (e) => {
  console.error('[lenen] 服务监听失败（请检查端口 ' + PORT + ' 是否已被占用）:', e.message);
  errLog('listen_error', e);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[lenen] 乐恩报道管理系统已启动: http://0.0.0.0:${PORT}  数据目录: ${DATA_DIR}`);
  console.log('[lenen] 默认校长账号 admin / change-me-on-first-login（首次登录后请立即改密码）');
});

/* 进程级兜底（goldbergyoni/nodebestpractices 2.6/2.7）：未知错误必须可观测，日志落盘 */
process.on('uncaughtException', (e) => { console.error('[lenen] uncaughtException:', e); errLog('uncaughtException', e); });
process.on('unhandledRejection', (e) => { console.error('[lenen] unhandledRejection:', e); errLog('unhandledRejection', e); });
function shutdown(sig) {
  console.log('[lenen] 收到 ' + sig + '，正在关闭…');
  server.close(() => { try { dbm.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
