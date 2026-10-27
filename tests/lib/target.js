'use strict';
/**
 * 測試目標:同一組 API 測試可以打 Node 版(預設)或 Cloudflare Workers 版(TARGET=worker)。
 * Workers 版在 Node 內執行(worker/src/index.js 的 fetch),D1 用 better-sqlite3 做一個相容的小替身。
 * 這樣不需要登入 Cloudflare,也能驗證 Workers 版的 API 行為與 Node 版一致。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');

const isWorker = process.env.TARGET === 'worker' || process.argv.includes('--worker');

// 最小 D1 替身:prepare().bind().first()/all()/run()
function makeD1(file) {
  const db = new Database(file);
  db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'migrations', '0001_init.sql'), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: (sql) => stmt(sql), _db: db };
}

async function start(opts = {}) {
  if (!isWorker) {
    const app = require('../../server/index');
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    return { base: 'http://127.0.0.1:' + server.address().port, close: () => server.close() };
  }
  const worker = require('../../worker/src/index.js');
  const env = {
    DB: makeD1(process.env.DB_PATH),
    JWT_SECRET: process.env.JWT_SECRET,
    SETUP_TOKEN: process.env.SETUP_TOKEN || '',
    // 測試用:沒設 SETUP_TOKEN 時開放建立管理者(正式環境不會設這個)
    ALLOW_OPEN_SETUP: process.env.SETUP_TOKEN ? undefined : '1',
    ...(opts.env || {}),
    ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) },
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request('http://127.0.0.1' + req.url, {
      method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) || body.length === 0 ? undefined : body,
    });
    const response = await worker.fetch(request, env, {});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, r));
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => { server.close(); env.DB._db.close(); } };
}

module.exports = { start, isWorker };
