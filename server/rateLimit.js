'use strict';
/**
 * 極簡記憶體內的失敗次數限制（不需額外套件）。
 * 以「key」計算失敗次數，視窗內超過上限就封鎖到視窗結束；成功時可清除該 key。
 * 單一機構、單一程序的規模夠用；重啟後計數歸零。
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> { count, first }

  function prune(now) {
    for (const [k, v] of hits) if (now - v.first >= windowMs) hits.delete(k);
  }
  const timer = setInterval(() => prune(Date.now()), Math.min(windowMs, 60 * 1000));
  if (timer.unref) timer.unref();

  return {
    // 回傳 0 表示可通行；否則回傳需等待的秒數
    retryAfter(key, now = Date.now()) {
      const v = hits.get(key);
      if (!v) return 0;
      if (now - v.first >= windowMs) { hits.delete(key); return 0; }
      return v.count >= max ? Math.ceil((v.first + windowMs - now) / 1000) : 0;
    },
    fail(key, now = Date.now()) {
      const v = hits.get(key);
      if (!v || now - v.first >= windowMs) hits.set(key, { count: 1, first: now });
      else v.count++;
    },
    reset(key) { hits.delete(key); },
  };
}

module.exports = { createLimiter };
