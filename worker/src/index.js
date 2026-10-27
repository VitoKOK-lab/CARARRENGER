'use strict';
/**
 * Cloudflare Workers 版後端(Workers + D1)。API 行為與 Node 版 server/ 完全對應,
 * 規則(密碼、救援碼、儲存權限、限流參數)一律取自 shared/policy.js。
 *
 * 靜態網頁(public/)由 Workers Static Assets 提供;這支程式先接手所有請求,
 * 負責 /api/*、加上安全標頭,其餘交給 env.ASSETS。
 *
 * 需要的設定:D1 綁定 DB、Secret JWT_SECRET;選填 SETUP_TOKEN、JWT_EXPIRES_IN(秒)。
 */
const policy = require('../../shared/policy');
const C = require('./crypto');

const ROLE_ALL = 'all';
const MAX_BODY_API = 100 * 1024;          // 與 Node 版一致
const MAX_VALUE_STORAGE = 1800 * 1024;    // D1 單列上限約 2MB,留一點餘裕

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com", "connect-src 'self'", "object-src 'none'",
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error { constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; } }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const nowIso = () => new Date().toISOString();

/* ---------------- D1 資料存取 ---------------- */
const toPublicUser = (row) => row && ({
  id: row.id, username: row.username,
  editRoles: JSON.parse(row.edit_roles || '[]'), viewRoles: JSON.parse(row.view_roles || '[]'),
  isSuperAdmin: !!row.is_super_admin,
});

function makeStore(db) {
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  return {
    async count() { return (await one('SELECT COUNT(*) AS n FROM users')).n; },
    async list() { return (await db.prepare('SELECT * FROM users ORDER BY created_at ASC').all()).results.map(toPublicUser); },
    findById: (id) => one('SELECT * FROM users WHERE id = ?', id),
    findByUsername: (name) => one('SELECT * FROM users WHERE username = ? COLLATE NOCASE', name),
    async create({ username, password, editRoles = [], viewRoles = [], isSuperAdmin = false }) {
      const id = C.genId(), ts = nowIso();
      const recoveryCode = policy.makeRecoveryCode(C.randomInt);
      await run(`INSERT INTO users (id, username, password_hash, edit_roles, view_roles, is_super_admin, recovery_code, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, username, await C.hashPassword(password), JSON.stringify(editRoles), JSON.stringify(viewRoles), isSuperAdmin ? 1 : 0,
        await C.hashPassword(policy.normalizeRecovery(recoveryCode)), ts, ts);
      return { user: toPublicUser(await this.findById(id)), recoveryCode };
    },
    async resetPasswordByRecovery(username, code, newPassword) {
      const row = await this.findByUsername(String(username || '').trim());
      const normalized = policy.normalizeRecovery(code);
      const ok = row && row.recovery_code ? await C.verifyPassword(normalized, row.recovery_code) : (await C.dummyVerify(normalized), false);
      if (!ok) return { ok: false };
      const newCode = policy.makeRecoveryCode(C.randomInt); // 用過即換新
      await run('UPDATE users SET password_hash=?, recovery_code=?, updated_at=? WHERE id=?',
        await C.hashPassword(String(newPassword)), await C.hashPassword(policy.normalizeRecovery(newCode)), nowIso(), row.id);
      return { ok: true, recoveryCode: newCode };
    },
    async resetRecoveryCode(id) {
      if (!(await this.findById(id))) return null;
      const code = policy.makeRecoveryCode(C.randomInt);
      await run('UPDATE users SET recovery_code=?, updated_at=? WHERE id=?', await C.hashPassword(policy.normalizeRecovery(code)), nowIso(), id);
      return code;
    },
    async update(id, { username, password, editRoles, viewRoles, isSuperAdmin }) {
      const e = await this.findById(id);
      if (!e) return null;
      await run(`UPDATE users SET username=?, password_hash=?, edit_roles=?, view_roles=?, is_super_admin=?, updated_at=? WHERE id=?`,
        username != null ? username : e.username,
        password ? await C.hashPassword(password) : e.password_hash,
        editRoles != null ? JSON.stringify(editRoles) : e.edit_roles,
        viewRoles != null ? JSON.stringify(viewRoles) : e.view_roles,
        (isSuperAdmin != null ? isSuperAdmin : !!e.is_super_admin) ? 1 : 0, nowIso(), id);
      return toPublicUser(await this.findById(id));
    },
    remove: async (id) => (await run('DELETE FROM users WHERE id = ?', id)).meta.changes > 0,
    async kvGet(key) { const r = await one('SELECT value FROM kv WHERE key = ?', key); return r ? r.value : null; },
    kvSet: (key, value) => run(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
                                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, key, value, nowIso()),
    kvDelete: (key) => run('DELETE FROM kv WHERE key = ?', key),
  };
}

/* ---------------- 失敗次數限制(存在 D1,跨 isolate 有效) ---------------- */
function makeLimiter(db, { max, windowMs }) {
  return {
    async retryAfter(key, now = Date.now()) {
      const v = await db.prepare('SELECT count, first_ts FROM rate_limits WHERE key = ?').bind(key).first();
      if (!v) return 0;
      if (now - v.first_ts >= windowMs) { await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run(); return 0; }
      return v.count >= max ? Math.ceil((v.first_ts + windowMs - now) / 1000) : 0;
    },
    async fail(key, now = Date.now()) {
      await db.prepare(`INSERT INTO rate_limits (key, count, first_ts) VALUES (?, 1, ?)
                        ON CONFLICT(key) DO UPDATE SET
                          count = CASE WHEN ? - first_ts >= ? THEN 1 ELSE count + 1 END,
                          first_ts = CASE WHEN ? - first_ts >= ? THEN ? ELSE first_ts END`)
        .bind(key, now, now, windowMs, now, windowMs, now).run();
    },
    reset: (key) => db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run(),
  };
}

/* ---------------- 共用小工具 ---------------- */
async function readJson(request, limit) {
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  if (len > limit) throw new HttpError(413, '這次要儲存的資料太大,超過伺服器上限,請稍後再試或聯絡系統維護者');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '這次要儲存的資料太大,超過伺服器上限,請稍後再試或聯絡系統維護者');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new HttpError(400, '送出的資料格式有誤(不是合法 JSON),請重新整理頁面後再試一次'); }
}

function requireSecret(env) {
  if (!env.JWT_SECRET) throw new HttpError(500, '伺服器尚未設定 JWT_SECRET(請用 wrangler secret put JWT_SECRET 設定)');
  return env.JWT_SECRET;
}
const expiresIn = (env) => parseInt(env.JWT_EXPIRES_IN, 10) || 7 * 24 * 3600;

async function authenticate(request, env, store) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw new HttpError(401, '尚未登入');
  const payload = await C.verifyJwt(header.slice(7).trim(), requireSecret(env));
  if (!payload) throw new HttpError(401, '登入已過期，請重新登入');
  const row = await store.findById(payload.sub);
  if (!row) throw new HttpError(401, '帳號已不存在');
  if (payload.pv !== await C.passwordVersion(row.password_hash)) throw new HttpError(401, '登入已失效,請重新登入');
  return toPublicUser(row);
}
function requireSuper(user) {
  if (!user.isSuperAdmin) throw new HttpError(403, '您的帳號沒有後台管理權限');
}

function limiterSet(env, request, username) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  return {
    perIp: { l: makeLimiter(env.DB, { max: policy.RATE_LIMIT.perIpMax, windowMs: policy.RATE_LIMIT.windowMs }), key: 'ip:' + ip },
    perAccount: { l: makeLimiter(env.DB, { max: policy.RATE_LIMIT.perAccountMax, windowMs: policy.RATE_LIMIT.windowMs }), key: 'acct:' + ip + '|' + String(username || '').trim().toLowerCase() },
  };
}
async function assertNotBlocked(keys) {
  const waits = await Promise.all([keys.perIp, keys.perAccount].map((k) => k.l.retryAfter(k.key)));
  const wait = Math.max(...waits);
  if (wait) throw new HttpError(429, `嘗試次數過多,請 ${Math.ceil(wait / 60)} 分鐘後再試`, { 'Retry-After': String(wait) });
}
const recordFailure = (keys) => Promise.all([keys.perIp, keys.perAccount].map((k) => k.l.fail(k.key)));

/* ---------------- 路由 ---------------- */
async function handleApi(request, env, url) {
  const store = makeStore(env.DB);
  const method = request.method;
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (path === '/api/health') return json({ ok: true });

  /* ---- /api/auth ---- */
  if (seg[1] === 'auth') {
    const action = seg[2];
    if (action === 'status' && method === 'GET') {
      return json({ needsSetup: (await store.count()) === 0, setupTokenRequired: !!env.SETUP_TOKEN });
    }
    if (action === 'setup' && method === 'POST') {
      if ((await store.count()) > 0) return json({ error: '系統已經有帳號了，請直接登入' }, 409);
      // 公開網址上,沒設 SETUP_TOKEN 就拒絕建立第一個管理者(否則任何知道網址的人都能搶先建立)。
      // ALLOW_OPEN_SETUP=1 只給測試用,正式環境不要設。
      if (!env.SETUP_TOKEN && env.ALLOW_OPEN_SETUP !== '1') {
        return json({ error: '尚未設定 SETUP_TOKEN,為了安全暫不開放建立管理者。請先在 Cloudflare 設定 SETUP_TOKEN 這個 Secret。' }, 503);
      }
      requireSecret(env); // 先確認 JWT_SECRET 已設定,避免帳號建立後才因簽發 token 失敗
      const keys = limiterSet(env, request, '__setup__');
      await assertNotBlocked(keys);
      const { username, password, setupToken } = await readJson(request, MAX_BODY_API);
      if (env.SETUP_TOKEN && !C.timingSafeEqual(String(setupToken || ''), String(env.SETUP_TOKEN))) {
        await recordFailure(keys);
        return json({ error: '建立口令不正確(請向系統安裝者索取 SETUP_TOKEN)' }, 403);
      }
      if (!username || !password) return json({ error: '請輸入帳號與密碼' }, 400);
      const pwErr = policy.validatePassword(String(password));
      if (pwErr) return json({ error: pwErr }, 400);
      const { user, recoveryCode } = await store.create({ username: String(username).trim(), password: String(password), editRoles: [ROLE_ALL], viewRoles: [ROLE_ALL], isSuperAdmin: true });
      const token = await C.signJwt({ sub: user.id, username: user.username, pv: await C.passwordVersion((await store.findById(user.id)).password_hash) }, requireSecret(env), expiresIn(env));
      return json({ token, user, recoveryCode });
    }
    if (action === 'recover' && method === 'POST') {
      const { username, recoveryCode, newPassword } = await readJson(request, MAX_BODY_API);
      if (!username || !recoveryCode || !newPassword) return json({ error: '請把帳號、救援碼、新密碼都填寫完整' }, 400);
      const keys = limiterSet(env, request, username);
      await assertNotBlocked(keys);
      const pwErr = policy.validatePassword(String(newPassword));
      if (pwErr) return json({ error: pwErr }, 400);
      const result = await store.resetPasswordByRecovery(username, recoveryCode, newPassword);
      if (!result.ok) {
        await recordFailure(keys);
        return json({ error: '帳號或救援碼不正確。忘記救援碼的話,請有後台權限的人幫你重設' }, 401);
      }
      await keys.perAccount.l.reset(keys.perAccount.key);
      return json({ ok: true, recoveryCode: result.recoveryCode });
    }
    if (action === 'login' && method === 'POST') {
      const { username, password } = await readJson(request, MAX_BODY_API);
      if (!username || !password) return json({ error: '請輸入帳號與密碼' }, 400);
      const keys = limiterSet(env, request, username);
      await assertNotBlocked(keys);
      const row = await store.findByUsername(String(username).trim());
      const ok = row ? await C.verifyPassword(password, row.password_hash) : (await C.dummyVerify(String(password)), false);
      if (!row || !ok) { await recordFailure(keys); return json({ error: '帳號或密碼錯誤' }, 401); }
      await keys.perAccount.l.reset(keys.perAccount.key);
      const user = toPublicUser(row);
      const token = await C.signJwt({ sub: user.id, username: user.username, pv: await C.passwordVersion(row.password_hash) }, requireSecret(env), expiresIn(env));
      return json({ token, user });
    }
    if (action === 'me' && method === 'GET') return json({ user: await authenticate(request, env, store) });
    return json({ error: '找不到這個功能' }, 404);
  }

  /* ---- /api/users (超級管理者) ---- */
  if (seg[1] === 'users') {
    const me = await authenticate(request, env, store);
    requireSuper(me);
    const id = seg[2];
    const countSupers = async () => (await store.list()).filter((u) => u.isSuperAdmin).length;

    if (!id && method === 'GET') return json({ users: await store.list() });
    if (!id && method === 'POST') {
      const { username, password, editRoles, viewRoles, isSuperAdmin } = await readJson(request, MAX_BODY_API);
      const name = (username || '').trim();
      if (!name) return json({ error: '請輸入帳號' }, 400);
      if (!password) return json({ error: '請輸入密碼' }, 400);
      const pwErr = policy.validatePassword(String(password));
      if (pwErr) return json({ error: pwErr }, 400);
      if (await store.findByUsername(name)) return json({ error: '這個帳號名稱已經有人用了' }, 409);
      const { user, recoveryCode } = await store.create({ username: name, password: String(password), editRoles: Array.isArray(editRoles) ? editRoles : [], viewRoles: Array.isArray(viewRoles) ? viewRoles : [], isSuperAdmin: !!isSuperAdmin });
      return json({ user, recoveryCode }, 201);
    }
    if (id && seg[3] === 'reset-recovery' && method === 'POST') {
      if (!(await store.findById(id))) return json({ error: '找不到這個帳號' }, 404);
      return json({ recoveryCode: await store.resetRecoveryCode(id) });
    }
    if (id && method === 'PUT') {
      const target = await store.findById(id);
      if (!target) return json({ error: '找不到這個帳號' }, 404);
      const { username, password, editRoles, viewRoles, isSuperAdmin } = await readJson(request, MAX_BODY_API);
      const name = username != null ? String(username).trim() : null;
      if (name === '') return json({ error: '帳號不能空白' }, 400);
      if (password) { const pwErr = policy.validatePassword(String(password)); if (pwErr) return json({ error: pwErr }, 400); }
      if (name) {
        const clash = await store.findByUsername(name);
        if (clash && clash.id !== target.id) return json({ error: '這個帳號名稱已經有人用了' }, 409);
      }
      const willBeSuper = isSuperAdmin != null ? !!isSuperAdmin : !!target.is_super_admin;
      if (target.is_super_admin && !willBeSuper && (await countSupers()) <= 1) return json({ error: '至少要保留一個有後台管理權限的帳號' }, 400);
      const user = await store.update(id, {
        username: name != null ? name : undefined, password: password || undefined,
        editRoles: Array.isArray(editRoles) ? editRoles : undefined, viewRoles: Array.isArray(viewRoles) ? viewRoles : undefined,
        isSuperAdmin: isSuperAdmin != null ? !!isSuperAdmin : undefined,
      });
      return json({ user });
    }
    if (id && method === 'DELETE') {
      const target = await store.findById(id);
      if (!target) return json({ error: '找不到這個帳號' }, 404);
      if ((await store.count()) <= 1) return json({ error: '至少要保留一個帳號' }, 400);
      if (target.is_super_admin && (await countSupers()) <= 1) return json({ error: '至少要保留一個有後台管理權限的帳號' }, 400);
      await store.remove(id);
      return json({ ok: true });
    }
    return json({ error: '找不到這個功能' }, 404);
  }

  /* ---- /api/storage ---- */
  if (seg[1] === 'storage') {
    const me = await authenticate(request, env, store);
    let key;
    try { key = decodeURIComponent(seg[2] || ''); } catch (e) { key = ''; }
    if (!policy.KEY_PATTERN.test(key)) return json({ error: '儲存的名稱格式不正確' }, 400);
    if (method === 'GET') { const v = await store.kvGet(key); return json({ key, value: v == null ? null : v }); }
    if (method === 'PUT') {
      if (!policy.canWriteStorage(me, key)) return json({ error: '您的帳號沒有修改這項資料的權限' }, 403);
      const { value } = await readJson(request, 25 * 1024 * 1024);
      const toStore = value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value));
      if (toStore && toStore.length > MAX_VALUE_STORAGE) throw new HttpError(413, '這次要儲存的資料太大,超過伺服器上限,請稍後再試或聯絡系統維護者');
      await store.kvSet(key, toStore);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      if (!policy.canWriteStorage(me, key)) return json({ error: '您的帳號沒有刪除這項資料的權限' }, 403);
      await store.kvDelete(key);
      return json({ ok: true });
    }
  }
  return json({ error: '找不到這個功能' }, 404);
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    try { return await handleApi(request, env, url); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e.headers);
      console.error('伺服器錯誤:', e && e.stack || e);
      return json({ error: '伺服器內部錯誤' }, 500);
    }
  }
  // 其餘:靜態網頁(單頁應用,找不到的路徑回 index.html 由 wrangler 的 not_found_handling 處理)
  const res = await env.ASSETS.fetch(request);
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    const h = new Response(res.body, res);
    h.headers.set('Cache-Control', 'no-cache');
    return h;
  }
  return res;
}

module.exports = {
  async fetch(request, env, ctx) {
    const res = await handle(request, env);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};
