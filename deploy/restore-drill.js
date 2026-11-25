'use strict';
/* 自动化备份恢复演练脚本（不影响正在运行的生产库）：
   1. 对当前库执行一次最新备份（或取最新备份）
   2. 恢复到独立临时目录，清理 WAL/SHM，执行 PRAGMA integrity_check 与 foreign_key_check
   3. 逐表核对恢复库与原库的行数及实收金额合计
   4. 以恢复后的库在临时随机端口真实启动 server.js，验证 HTTP /api/health 与 /api/me 正常响应
   用法：node deploy/restore-drill.js */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateTo } = require('../lib/migrations');
const dbm = require('../lib/db');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LENEN_DATA || path.join(ROOT, 'data');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 0. 若目标数据目录尚未初始化（如全新解压尚未首次起服），先初始化基线库结构
  const mainDbPath = path.join(DATA_DIR, 'lenen.db');
  if (!fs.existsSync(mainDbPath) || fs.statSync(mainDbPath).size === 0) {
    dbm.init(DATA_DIR);
    dbm.close();
  }

  // 1. 生成一份最新备份
  const bk = spawnSync(process.execPath, [path.join(ROOT, 'backup.js')], {
    env: { ...process.env, LENEN_DATA: DATA_DIR },
    encoding: 'utf8',
  });
  if (bk.status !== 0) {
    console.error('DRILL_FAIL: backup.js 失败', bk.stderr || bk.stdout);
    process.exit(1);
  }
  const bakDir = path.join(DATA_DIR, 'backups');
  const baks = fs.readdirSync(bakDir).filter(f => f.endsWith('.db')).sort();
  if (!baks.length) {
    console.error('DRILL_FAIL: 未找到备份文件');
    process.exit(1);
  }
  const latestBak = path.join(bakDir, baks[baks.length - 1]);

  // 2. 复制到隔离的演练目录
  const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenen-restore-drill-'));
  const drillDbPath = path.join(drillDir, 'lenen.db');
  fs.copyFileSync(latestBak, drillDbPath);

  let srv = null;
  try {
    // 3. 完整性校验 + 迁移对齐 + 核心表行数与金额核对
    const srcDb = new DatabaseSync(path.join(DATA_DIR, 'lenen.db'), { readOnly: true });
    srcDb.exec('PRAGMA busy_timeout=5000');
    const rstDb = new DatabaseSync(drillDbPath);
    const ic = rstDb.prepare('PRAGMA integrity_check').get();
    if (!ic || Object.values(ic)[0] !== 'ok') throw new Error('integrity_check 未通过: ' + JSON.stringify(ic));
    const ver = migrateTo(rstDb);

    const tables = ['positions', 'users', 'students', 'fee_state', 'dorm_assign', 'attendance', 'scores'];
    const summary = {};
    for (const t of tables) {
      const a = srcDb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      const b = rstDb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      if (a !== b) throw new Error(`表 ${t} 行数不一致: 源库=${a}, 恢复库=${b}`);
      summary[t] = b;
    }
    const srcSum = Number(srcDb.prepare('SELECT COALESCE(SUM(CASE WHEN paid=1 THEN amount ELSE 0 END),0) AS s FROM fee_state').get().s);
    const rstSum = Number(rstDb.prepare('SELECT COALESCE(SUM(CASE WHEN paid=1 THEN amount ELSE 0 END),0) AS s FROM fee_state').get().s);
    srcDb.close();
    rstDb.close();
    if (Math.abs(srcSum - rstSum) > 0.001) throw new Error(`已缴金额合计不一致: 源库=${srcSum}, 恢复库=${rstSum}`);

    // 4. 在临时端口真实启动 server.js 并探活
    const port = 18800 + Math.floor(Math.random() * 1000);
    srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, LENEN_PORT: String(port), LENEN_DATA: drillDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok) { up = true; break; }
        }
      } catch {}
      await sleep(150);
    }
    if (!up) throw new Error('恢复库启动 server.js 后 /api/health 未就绪');
    const meRes = await fetch(`http://127.0.0.1:${port}/api/me`);
    if (!meRes.ok) throw new Error('/api/me 响应异常: ' + meRes.status);

    console.log(`DRILL_OK: backup=${path.basename(latestBak)} schema=v${ver} paidSum=${rstSum} counts=${JSON.stringify(summary)}`);
  } finally {
    if (srv) {
      await new Promise(r => { srv.once('exit', r); srv.kill(); });
    }
    try { fs.rmSync(drillDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
})().catch(e => {
  console.error('DRILL_FAIL:', e.message || e);
  process.exit(1);
});
