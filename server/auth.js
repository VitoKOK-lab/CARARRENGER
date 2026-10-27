'use strict';
/**
 * 認證相關工具：bcrypt 密碼雜湊、JWT 簽發與驗證、Express 中介層。
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');

// 12 輪(約 0.3 秒/次);測試環境用 BCRYPT_ROUNDS 調低以加快速度
const BCRYPT_ROUNDS = Math.max(4, parseInt(process.env.BCRYPT_ROUNDS, 10) || 12);
const { MIN_PASSWORD_LENGTH, validatePassword } = require('../shared/policy');
// 帳號不存在時也跑一次 bcrypt 比對,避免用回應時間猜出帳號是否存在
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch (e) {
    return false;
  }
}

// 密碼版本:密碼雜湊一變(改密碼、救援碼重設)就跟著變,讓舊 token 立刻失效
function passwordVersion(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

function signToken(user, pv) {
  // token 內只放最小必要資訊；權限每次都以資料庫為準重新查詢。
  return jwt.sign(
    { sub: user.id, username: user.username, pv },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return null;
  }
}

function extractToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

module.exports = {
  DUMMY_HASH,
  passwordVersion,
  validatePassword,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  extractToken,
};
