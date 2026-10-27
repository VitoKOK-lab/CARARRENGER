'use strict';
/**
 * Workers 版的密碼學工具(WebCrypto,沒有 Node 專屬套件)。
 * - 密碼雜湊:PBKDF2-SHA256,100,000 次(Workers 上限就是 100,000)。bcrypt 的純 JS 版在 Workers 太吃 CPU。
 * - JWT:HS256,自己簽發與驗證(只需要這一種演算法)。
 */
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;

function b64(bytes) {
  let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(str) { return unb64(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=')); }

// 固定時間比較(避免從耗時差異猜出內容)
function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a, y = typeof b === 'string' ? enc.encode(b) : b;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(String(plain), salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

async function verifyPassword(plain, stored) {
  try {
    const [scheme, iter, salt, hash] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const got = await pbkdf2(String(plain), unb64(salt), Math.min(parseInt(iter, 10) || PBKDF2_ITERATIONS, PBKDF2_ITERATIONS));
    return timingSafeEqual(got, unb64(hash));
  } catch (e) { return false; }
}

let dummyHash;
// 帳號不存在時也做一次雜湊比對,避免用耗時差異列舉帳號
async function dummyVerify(plain) {
  dummyHash = dummyHash || await hashPassword('dummy-password-for-timing');
  await verifyPassword(plain, dummyHash);
}

async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 密碼版本:密碼雜湊一變就跟著變,讓舊 token 立刻失效
async function passwordVersion(passwordHash) { return (await sha256Hex(String(passwordHash))).slice(0, 16); }

// 密碼學安全的 [0, n) 隨機整數(拒絕取樣,無偏差)
function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}
function genId() {
  const r = crypto.getRandomValues(new Uint8Array(5));
  return 'u' + Date.now().toString(36) + [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signJwt(payload, secret, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
async function verifyJwt(token, secret) {
  try {
    const [head, body, sig] = String(token).split('.');
    if (!head || !body || !sig) return null;
    const h = JSON.parse(new TextDecoder().decode(unb64url(head)));
    if (h.alg !== 'HS256') return null; // 只接受 HS256,擋掉 alg:none 之類的偽造
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordVersion, randomInt, genId, signJwt, verifyJwt, timingSafeEqual };
