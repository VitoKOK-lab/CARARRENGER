'use strict';
/**
 * 安全相關的後端測試:密碼政策、登入/救援碼限流、不洩漏帳號是否存在、
 * 改密碼後舊 token 失效、救援碼用過即換新、儲存 API 權限、SETUP_TOKEN、安全標頭、救援碼格式。
 * 用暫存資料庫與獨立程序,不影響 test_api.js 的限流計數。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), 'sched-sec-' + Date.now() + '.db');
process.env.DB_PATH = tmpDb;
process.env.JWT_SECRET = 'test-secret';
process.env.SETUP_TOKEN = 'let-me-in';
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4'; // 測試用,加快雜湊速度

const target = require('./lib/target');

let pass = 0, fail = 0;
async function check(name, fn){
  try { await fn(); console.log('✅ ' + name); pass++; }
  catch(e){ console.log('❌ ' + name + ' → ' + e.message); fail++; }
}

(async function run(){
  const running = await target.start();
  const base = running.base;
  const req = async (method, url, { token, body, raw } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(base + url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch(e){}
    return { status: res.status, data, headers: res.headers };
  };

  let adminToken, adminCode;

  await check('SETUP_TOKEN 已設定時:沒帶口令不能建立第一個管理者(403)', async () => {
    const r = await req('POST', '/api/auth/setup', { body: { username: 'admin', password: 'longenough1' } });
    assert.strictEqual(r.status, 403);
    const st = await req('GET', '/api/auth/status');
    assert.strictEqual(st.data.needsSetup, true);
    assert.strictEqual(st.data.setupTokenRequired, true);
  });

  await check('密碼少於 8 字元會被拒(400),即使口令正確', async () => {
    const r = await req('POST', '/api/auth/setup', { body: { username: 'admin', password: 'short', setupToken: 'let-me-in' } });
    assert.strictEqual(r.status, 400);
  });

  await check('口令正確 + 密碼合格 → 可建立管理者', async () => {
    const r = await req('POST', '/api/auth/setup', { body: { username: 'admin', password: 'longenough1', setupToken: 'let-me-in' } });
    assert.strictEqual(r.status, 200);
    adminToken = r.data.token; adminCode = r.data.recoveryCode;
  });

  await check('救援碼為 4 段 ×4 碼,且字元不含易混淆的 I L O 0 1', async () => {
    assert.ok(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/.test(adminCode), adminCode);
  });

  await check('救援碼每次不同(沒有重複)', async () => {
    const { makeRecoveryCode } = require('../shared/policy');
    const rnd = target.isWorker ? require('../worker/src/crypto').randomInt : (n) => require('crypto').randomInt(n);
    const codes = new Set();
    for (let i = 0; i < 5000; i++) codes.add(makeRecoveryCode(rnd));
    assert.strictEqual(codes.size, 5000);
  });

  await check('建立使用者時密碼太短 → 400', async () => {
    const r = await req('POST', '/api/users', { token: adminToken, body: { username: 'n0', password: '1234567' } });
    assert.strictEqual(r.status, 400);
  });

  // 兩個測試帳號:editor(有護理編輯權)、viewer(純檢視)
  let editorToken, viewerToken, viewerId;
  await check('建立 editor / viewer 帳號並登入', async () => {
    await req('POST', '/api/users', { token: adminToken, body: { username: 'editor', password: 'editorpw1', editRoles: ['nursing'], viewRoles: ['nursing'] } });
    const v = await req('POST', '/api/users', { token: adminToken, body: { username: 'viewer', password: 'viewerpw1', editRoles: [], viewRoles: ['nursing'] } });
    viewerId = v.data.user.id;
    editorToken = (await req('POST', '/api/auth/login', { body: { username: 'editor', password: 'editorpw1' } })).data.token;
    viewerToken = (await req('POST', '/api/auth/login', { body: { username: 'viewer', password: 'viewerpw1' } })).data.token;
    assert.ok(editorToken && viewerToken);
  });

  // ---- 儲存 API 權限 ----
  await check('純檢視帳號不能寫班表(403),但可以讀', async () => {
    const w = await req('PUT', '/api/storage/schedule-month:2026-10', { token: viewerToken, body: { value: '{}' } });
    assert.strictEqual(w.status, 403);
    const r = await req('GET', '/api/storage/schedule-month:2026-10', { token: viewerToken });
    assert.strictEqual(r.status, 200);
  });

  await check('純檢視帳號不能刪除資料(403)', async () => {
    const d = await req('DELETE', '/api/storage/schedule-month:2026-10', { token: viewerToken });
    assert.strictEqual(d.status, 403);
  });

  await check('有編輯權的帳號可寫班表、草稿、休假登記、人員順序', async () => {
    for (const k of ['schedule-month:2026-10', 'schedule-draft:2026-10', 'leave-request:2026-10', 'staff-data-v3']) {
      const w = await req('PUT', '/api/storage/' + k, { token: editorToken, body: { value: '{"a":1}' } });
      assert.strictEqual(w.status, 200, k);
    }
  });

  await check('一般編輯者不能改設定類資料(規則/行事曆/代碼,403),超級管理者可以', async () => {
    for (const k of ['schedule-rules', 'annual-cal-org', 'custom-shift-codes', 'solution-library']) {
      const w = await req('PUT', '/api/storage/' + k, { token: editorToken, body: { value: '[]' } });
      assert.strictEqual(w.status, 403, k);
      const a = await req('PUT', '/api/storage/' + k, { token: adminToken, body: { value: '[]' } });
      assert.strictEqual(a.status, 200, k);
    }
  });

  await check('merged-view-sel 只有本人能寫', async () => {
    const mine = await req('PUT', '/api/storage/merged-view-sel:' + viewerId, { token: viewerToken, body: { value: '[]' } });
    assert.strictEqual(mine.status, 200);
    const others = await req('PUT', '/api/storage/merged-view-sel:' + viewerId, { token: editorToken, body: { value: '[]' } });
    assert.strictEqual(others.status, 403);
  });

  await check('不合法的儲存名稱(含路徑/空白/特殊字元)被拒(400)', async () => {
    const r = await req('GET', '/api/storage/' + encodeURIComponent('../etc/passwd'), { token: adminToken });
    assert.strictEqual(r.status, 400);
    const r2 = await req('PUT', '/api/storage/' + encodeURIComponent('a b'), { token: adminToken, body: { value: 'x' } });
    assert.strictEqual(r2.status, 400);
  });

  // ---- 不洩漏帳號 / 救援碼用過即換 / token 失效 ----
  await check('recover:帳號不存在與救援碼錯誤的回應完全相同', async () => {
    const a = await req('POST', '/api/auth/recover', { body: { username: 'nobody', recoveryCode: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'newpassword1' } });
    const b = await req('POST', '/api/auth/recover', { body: { username: 'viewer', recoveryCode: 'AAAA-AAAA-AAAA-AAAA', newPassword: 'newpassword1' } });
    assert.strictEqual(a.status, 401); assert.strictEqual(b.status, 401);
    assert.deepStrictEqual(a.data, b.data);
  });

  await check('用救援碼重設密碼後:舊 token 失效、舊救援碼作廢、回傳新救援碼', async () => {
    const before = await req('GET', '/api/auth/me', { token: adminToken });
    assert.strictEqual(before.status, 200);
    const r = await req('POST', '/api/auth/recover', { body: { username: 'admin', recoveryCode: adminCode, newPassword: 'changedpass1' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.recoveryCode && r.data.recoveryCode !== adminCode);
    const after = await req('GET', '/api/auth/me', { token: adminToken });
    assert.strictEqual(after.status, 401, '改密碼後舊 token 應失效');
    const again = await req('POST', '/api/auth/recover', { body: { username: 'admin', recoveryCode: adminCode, newPassword: 'anotherpass1' } });
    assert.strictEqual(again.status, 401, '舊救援碼不可再用');
    const login = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'changedpass1' } });
    assert.strictEqual(login.status, 200);
    adminToken = login.data.token;
  });

  await check('管理者改別人密碼後,對方舊 token 失效', async () => {
    const before = await req('GET', '/api/auth/me', { token: editorToken });
    assert.strictEqual(before.status, 200);
    const list = await req('GET', '/api/users', { token: adminToken });
    const ed = list.data.users.find(u => u.username === 'editor');
    const up = await req('PUT', '/api/users/' + ed.id, { token: adminToken, body: { password: 'neweditorpw1' } });
    assert.strictEqual(up.status, 200);
    const after = await req('GET', '/api/auth/me', { token: editorToken });
    assert.strictEqual(after.status, 401);
  });

  // ---- 安全標頭 ----
  await check('回應帶有 CSP / X-Frame-Options / nosniff,且不洩漏 X-Powered-By', async () => {
    const r = await req('GET', '/api/health');
    assert.ok((r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-powered-by'), null);
  });

  await check('非儲存 API 的請求內容上限 100KB(超過 413)', async () => {
    const r = await req('POST', '/api/auth/login', { body: { username: 'a', password: 'x'.repeat(200 * 1024) } });
    assert.strictEqual(r.status, 413);
  });

  // ---- 限流(放最後,會把這個 IP 鎖住) ----
  await check('登入連續失敗 8 次後,第 9 次回 429(連正確密碼也會被擋)並帶 Retry-After', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await req('POST', '/api/auth/login', { body: { username: 'editor', password: 'wrong-password-' + i } });
      assert.strictEqual(r.status, 401, '第 ' + (i + 1) + ' 次應為 401');
    }
    const blocked = await req('POST', '/api/auth/login', { body: { username: 'editor', password: 'neweditorpw1' } });
    assert.strictEqual(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });

  await check('限流是依「帳號」計算:同 IP 登入另一個帳號不受影響', async () => {
    const r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'changedpass1' } });
    assert.strictEqual(r.status, 200);
  });

  await check('recover 連續猜救援碼 8 次後被鎖(429)', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await req('POST', '/api/auth/recover', { body: { username: 'admin', recoveryCode: 'BBBB-BBBB-BBBB-B' + String(i).padStart(3, 'B'), newPassword: 'newpassword1' } });
      assert.strictEqual(r.status, 401);
    }
    const blocked = await req('POST', '/api/auth/recover', { body: { username: 'admin', recoveryCode: 'BBBB-BBBB-BBBB-BBBB', newPassword: 'newpassword1' } });
    assert.strictEqual(blocked.status, 429);
  });

  running.close();
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suf); } catch(e){} }
  console.log('\n通過 ' + pass + ' / 失敗 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
