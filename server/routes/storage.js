'use strict';
/**
 * 共用資料的儲存路由（需登入）。這一層取代了原本 Claude.ai 的 window.storage：
 *   GET    /api/storage/:key  —— 讀一筆共用資料
 *   PUT    /api/storage/:key  —— 寫一筆共用資料
 *   DELETE /api/storage/:key  —— 刪一筆共用資料
 *
 * 所有登入者共用同一份資料（等同原本 shared=true 的行為），
 * 這樣不同電腦、不同人看到的排班表才會是同一份、即時同步。
 *
 * 權限(伺服器端強制,不只靠前端隱藏):
 *   讀取:任何登入者。
 *   寫入/刪除:
 *     - 班表類資料(schedule-month / schedule-draft / leave-request / staff-data-v3[調整人員順序])
 *       需要至少有一個職務的編輯權限(或超級管理者),純檢視帳號不可寫。
 *     - merged-view-sel:<帳號id> 只有本人可寫。
 *     - 其餘(規則、行事曆、代碼、解決方案庫…)只有超級管理者可寫。
 *   班表資料目前是「整份存成一個 key」,無法在伺服器端細分到單一職務;
 *   所以編輯權限只能擋到「有沒有任何編輯權」這一層。
 */
const express = require('express');
const router = express.Router();
const { KV } = require('../models');
const { requireAuth } = require('../middleware');
const { KEY_PATTERN, canWriteStorage: canWrite } = require('../../shared/policy');

router.use(requireAuth);

router.param('key', (req, res, next, key) => {
  if (!KEY_PATTERN.test(key)) return res.status(400).json({ error: '儲存的名稱格式不正確' });
  next();
});

router.get('/:key', (req, res) => {
  const value = KV.get(req.params.key);
  res.json({ key: req.params.key, value: value == null ? null : value });
});

router.put('/:key', (req, res) => {
  if (!canWrite(req.user, req.params.key)) {
    return res.status(403).json({ error: '您的帳號沒有修改這項資料的權限' });
  }
  const { value } = req.body || {};
  // value 一律以字串儲存（前端傳進來的本來就是 JSON.stringify 過的字串）
  const toStore = value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value));
  KV.set(req.params.key, toStore);
  res.json({ ok: true });
});

router.delete('/:key', (req, res) => {
  if (!canWrite(req.user, req.params.key)) {
    return res.status(403).json({ error: '您的帳號沒有刪除這項資料的權限' });
  }
  KV.delete(req.params.key);
  res.json({ ok: true });
});

module.exports = router;
