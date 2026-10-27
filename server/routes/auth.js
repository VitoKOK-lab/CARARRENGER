'use strict';
/**
 * 認證路由：
 *   GET  /api/auth/status  —— 是否還沒有任何帳號（要不要顯示「設定第一個管理者」）
 *   POST /api/auth/setup   —— 建立第一個超級管理者（只有在完全沒有帳號時可用；可用 SETUP_TOKEN 保護）
 *   POST /api/auth/login   —— 帳號密碼登入，成功回傳 JWT
 *   POST /api/auth/recover —— 帳號 + 救援碼重設密碼
 *   GET  /api/auth/me      —— 用 token 換回目前使用者資訊（用於重新整理後自動登入）
 *
 * login / recover / setup 都有失敗次數限制(同一 IP+帳號 8 次、同一 IP 40 次 / 15 分鐘),
 * 且「帳號不存在」與「密碼/救援碼錯誤」回相同訊息與相近的耗時,避免被用來列舉帳號。
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const config = require('../config');
const { Users } = require('../models');
const { verifyPassword, signToken, passwordVersion, validatePassword, DUMMY_HASH } = require('../auth');
const { requireAuth } = require('../middleware');
const { createLimiter } = require('../rateLimit');

const ROLE_ALL = 'all';
const WINDOW_MS = 15 * 60 * 1000;
const perAccount = createLimiter({ max: 8, windowMs: WINDOW_MS });
const perIp = createLimiter({ max: 40, windowMs: WINDOW_MS });

// 回傳 true 表示已回應 429(呼叫端直接 return)
function blocked(res, keys) {
  const wait = Math.max(...keys.map((k) => (k.limiter.retryAfter(k.key))));
  if (!wait) return false;
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: `嘗試次數過多,請 ${Math.ceil(wait / 60)} 分鐘後再試` });
  return true;
}
function limiterKeys(req, username) {
  const ip = req.ip || 'unknown';
  return [
    { limiter: perIp, key: ip },
    { limiter: perAccount, key: ip + '|' + String(username || '').trim().toLowerCase() },
  ];
}
function recordFailure(keys) { keys.forEach((k) => k.limiter.fail(k.key)); }
function recordSuccess(keys) { keys[1].limiter.reset(keys[1].key); }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

router.get('/status', (req, res) => {
  res.json({ needsSetup: Users.count() === 0, setupTokenRequired: !!config.setupToken });
});

router.post('/setup', (req, res) => {
  if (Users.count() > 0) {
    return res.status(409).json({ error: '系統已經有帳號了，請直接登入' });
  }
  const keys = limiterKeys(req, '__setup__');
  if (blocked(res, keys)) return;
  const { username, password, setupToken } = req.body || {};
  if (config.setupToken && !safeEqual(setupToken || '', config.setupToken)) {
    recordFailure(keys);
    return res.status(403).json({ error: '建立口令不正確(請向系統安裝者索取 SETUP_TOKEN)' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const pwErr = validatePassword(String(password));
  if (pwErr) return res.status(400).json({ error: pwErr });
  // 第一個帳號自動成為擁有全部權限的超級管理者
  const { user, recoveryCode } = Users.create({
    username: String(username).trim(),
    password: String(password),
    editRoles: [ROLE_ALL],
    viewRoles: [ROLE_ALL],
    isSuperAdmin: true,
  });
  const token = signToken(user, passwordVersion(Users.findById(user.id).password_hash));
  // recoveryCode 只在這一次回傳（之後查不到），前端要提示使用者記下
  res.json({ token, user, recoveryCode });
});

// 忘記密碼：用帳號 + 救援碼重設密碼（不需登入）
router.post('/recover', (req, res) => {
  const { username, recoveryCode, newPassword } = req.body || {};
  if (!username || !recoveryCode || !newPassword) {
    return res.status(400).json({ error: '請把帳號、救援碼、新密碼都填寫完整' });
  }
  const keys = limiterKeys(req, username);
  if (blocked(res, keys)) return;
  const pwErr = validatePassword(String(newPassword));
  if (pwErr) return res.status(400).json({ error: pwErr });
  const result = Users.resetPasswordByRecovery(username, recoveryCode, newPassword);
  if (!result.ok) {
    recordFailure(keys);
    // 帳號不存在與救援碼錯誤回相同訊息
    return res.status(401).json({ error: '帳號或救援碼不正確。忘記救援碼的話,請有後台權限的人幫你重設' });
  }
  recordSuccess(keys);
  res.json({ ok: true, recoveryCode: result.recoveryCode });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const keys = limiterKeys(req, username);
  if (blocked(res, keys)) return;
  const row = Users.findByUsername(String(username).trim());
  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) {
    recordFailure(keys);
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  recordSuccess(keys);
  const user = {
    id: row.id,
    username: row.username,
    editRoles: JSON.parse(row.edit_roles || '[]'),
    viewRoles: JSON.parse(row.view_roles || '[]'),
    isSuperAdmin: !!row.is_super_admin,
  };
  const token = signToken(user, passwordVersion(row.password_hash));
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
