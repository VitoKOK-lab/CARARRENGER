'use strict';
/**
 * 線東大眾護理之家 機構排班系統 —— 後端伺服器進入點。
 *
 * 這支程式做兩件事：
 *   1. 提供 /api/... 的資料與帳號 API（後端 + 資料庫 + 真正的登入）
 *   2. 把 public/ 裡的前端網頁送給瀏覽器
 *
 * 啟動方式：npm start（或 node server/index.js）
 */
const path = require('path');
const express = require('express');
const config = require('./config');

// 先載入 db，確保資料庫與資料表在伺服器起來前就建立好
require('./db');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const storageRoutes = require('./routes/storage');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

// --- 安全標頭 ---
// 前端是單檔 HTML(含行內 script/style 與 data: 圖片),所以 CSP 需允許 'unsafe-inline',
// 但仍擋掉外部腳本、外部連線、被別站嵌入(clickjacking)與 <base>/<object> 注入。
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// 排班資料可能較大（多月份/多人員），只有儲存 API 放寬到 25MB;其餘 API(登入等)限 100KB,避免未登入就被大封包吃記憶體
app.use('/api/storage', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '100kb' }));

// --- API ---
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/storage', storageRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 沒有帳號且沒設 SETUP_TOKEN 時,提醒:第一個連上來的人能建立管理者
if (require('./models').Users.count() === 0 && !config.setupToken) {
  console.warn('[提醒] 目前還沒有任何帳號,且未設定 SETUP_TOKEN:第一個連上網頁的人可以建立管理者帳號。請儘快自己完成設定,或在 .env 設定 SETUP_TOKEN。');
}

// --- 前端靜態檔案 ---
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    // HTML 每次都跟伺服器重新驗證，確保更新程式後瀏覽器一定拿到新版（避免看到舊快取）；
    // vendor 的大型函式庫等其他靜態檔仍可正常快取。
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// 其他非 /api 的路徑都回傳前端首頁（單頁應用）
app.get(/^(?!\/api).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// --- 統一錯誤處理 ---
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // 請求內容相關的錯誤：回清楚的 4xx，而不是一律籠統的 500
  if (err && err.type === 'entity.too.large') {
    console.warn('請求內容過大：', err.message);
    return res.status(413).json({ error: '這次要儲存的資料太大,超過伺服器上限,請稍後再試或聯絡系統維護者' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn('請求內容不是合法 JSON：', err.message);
    return res.status(400).json({ error: '送出的資料格式有誤(不是合法 JSON),請重新整理頁面後再試一次' });
  }
  console.error('伺服器錯誤：', err);
  res.status(500).json({ error: '伺服器內部錯誤' });
});

// 只有「直接執行這支檔案」時才真的開始監聽埠號;
// 被測試 require 進來時不會自動綁埠,方便測試各自開自己的伺服器。
if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log('====================================================');
    console.log('  線東大眾護理之家 機構排班系統 已啟動');
    console.log('  本機開啟： http://localhost:' + config.port);
    console.log('  同一區網的其他電腦：http://<這台電腦的IP>:' + config.port);
    console.log('  資料庫檔案：' + config.dbPath);
    console.log('  結束請按 Ctrl+C');
    console.log('====================================================');
  });

  // 埠號被占用時，給看得懂的提示，而不是一大串英文錯誤堆疊
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('\n====================================================');
      console.error('  無法啟動：埠號 ' + config.port + ' 已經被占用');
      console.error('  最可能的原因：排班系統已經在「另一個黑色視窗」執行中。');
      console.error('');
      console.error('  怎麼辦（擇一）：');
      console.error('   1. 直接用瀏覽器開啟： http://localhost:' + config.port);
      console.error('   2. 或先關掉另一個正在執行的黑色視窗，再重新啟動這一個。');
      console.error('====================================================\n');
      process.exit(1);
    }
    throw err;
  });

  // 讓 Docker / 系統可以優雅關閉
  const shutdown = () => {
    console.log('\n正在關閉伺服器…');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
