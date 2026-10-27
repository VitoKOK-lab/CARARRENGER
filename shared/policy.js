'use strict';
/**
 * 前後端、Node 版與 Cloudflare Workers 版共用的「規則」(純函式,不碰 I/O、不碰 crypto 實作)。
 * 兩個後端都從這裡取規則,避免各寫一份後行為慢慢分岔。
 */

const MIN_PASSWORD_LENGTH = 8;

function validatePassword(plain) {
  if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    return `密碼至少需要 ${MIN_PASSWORD_LENGTH} 個字元`;
  }
  return null;
}

// 救援碼:XXXX-XXXX-XXXX-XXXX,去掉易混淆字元(無 I L O 0 1)。亂數由呼叫端提供(必須是密碼學安全亂數)
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeRecoveryCode(randomInt) {
  const seg = () => Array.from({ length: 4 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}
function normalizeRecovery(code) {
  return String(code || '').trim().toUpperCase();
}

// 登入 / 救援碼 / 建立管理者的失敗次數限制
const RATE_LIMIT = { perAccountMax: 8, perIpMax: 40, windowMs: 15 * 60 * 1000 };

// 儲存 API 的 key 規則與寫入權限
const KEY_PATTERN = /^[A-Za-z0-9:_.\-]{1,120}$/;
const EDITOR_PREFIXES = ['schedule-month:', 'schedule-draft:', 'leave-request:'];
const EDITOR_KEYS = ['staff-data-v3'];

function canWriteStorage(user, key) {
  if (user.isSuperAdmin) return true;
  if (key.startsWith('merged-view-sel:')) return key === 'merged-view-sel:' + user.id;
  const isEditorKey = EDITOR_KEYS.includes(key) || EDITOR_PREFIXES.some((p) => key.startsWith(p));
  if (!isEditorKey) return false;
  return Array.isArray(user.editRoles) && user.editRoles.length > 0;
}

module.exports = {
  MIN_PASSWORD_LENGTH, validatePassword,
  RECOVERY_ALPHABET, makeRecoveryCode, normalizeRecovery,
  RATE_LIMIT, KEY_PATTERN, canWriteStorage,
};
