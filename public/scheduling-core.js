'use strict';
/**
 * 排班核心邏輯（純函式，不碰 DOM、不碰全域狀態）。
 * 瀏覽器：由 index.html 以 <script src> 載入，掛在 window.SchedulingCore。
 * Node：測試以 require('../public/scheduling-core.js') 載入同一份程式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SchedulingCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------- 班別時段與休息間隔 ---------- */
  // [開始時, 結束時]；跨日的結束時用 24 以上表示（例如 N: 24~32 即當日24:00到隔日08:00）
  const SHIFT_TIME_RANGE = {'Di':[8,16],'2Di':[8,16],'3Di':[8,16],'2D8':[8,20],'3D8':[8,20],'D8':[8,20],'E':[16,24],'E8':[20,32],'N':[24,32]};

  // 前一天班別結束到隔天班別開始之間的小時數；任一代碼沒有時段（休、兼職等）回傳 null
  function gapHours(prevCode, nextCode) {
    if (!SHIFT_TIME_RANGE[prevCode] || !SHIFT_TIME_RANGE[nextCode]) return null;
    return (24 + SHIFT_TIME_RANGE[nextCode][0]) - SHIFT_TIME_RANGE[prevCode][1];
  }

  /* ---------- 純白班同仁的3個月輪調:2Di / 3Di / 貼班(白班) 循環 ---------- */
  const ROTATION_SEQUENCE = ['2Di','3Di','float'];

  function isPureWhiteRotationStaff(p) {
    return p.rotationTrack === 'rotate' && p.eligWhite && !p.eligEvening && !p.eligNight && !p.partTime;
  }

  function rotationCategoryForMonth(p, monthCursorDate) {
    if (!p.rotationStartMonth || !p.rotationStartShift) return null;
    const [sy, sm] = p.rotationStartMonth.split('-').map(Number);
    if (!sy || !sm) return null;
    const startIdx = ROTATION_SEQUENCE.indexOf(p.rotationStartShift);
    if (startIdx === -1) return null;
    const monthsElapsed = (monthCursorDate.getFullYear() * 12 + monthCursorDate.getMonth()) - (sy * 12 + (sm - 1));
    if (monthsElapsed < 0) return null; // hasn't started yet
    const stepsForward = Math.floor(monthsElapsed / 3);
    const idx = (startIdx + stepsForward) % ROTATION_SEQUENCE.length;
    return ROTATION_SEQUENCE[idx];
  }

  /* ---------- 顏色 ---------- */
  const EVENT_COLORS = [
    {v:'blue', t:'藍', bg:'#DCEBFB', fg:'#1D5FA8'},
    {v:'green', t:'綠', bg:'#DCEEDC', fg:'#2E7D32'},
    {v:'orange', t:'橘', bg:'#FBE7CE', fg:'#B5651D'},
    {v:'red', t:'紅', bg:'#FBDCDC', fg:'#C1573A'},
    {v:'purple', t:'紫', bg:'#EAE0F5', fg:'#6A3FA0'},
    {v:'gray', t:'灰', bg:'#E6E6E0', fg:'#5C5C52'},
  ];

  function eventColor(v) { return EVENT_COLORS.find(c => c.v === v) || EVENT_COLORS[3]; }

  function contrastTextColor(hex) {
    const h = hex.replace('#', '');
    if (h.length !== 6) return '#000';
    const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
    const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
    return luminance > 0.6 ? '#1F2A1D' : '#FFFFFF';
  }

  function tintBg(hex) {
    // 淺化顏色當作背景色底,文字用原色的深一點版本,讓表格看起來仍是「淺底深字」風格
    const h = hex.replace('#', '');
    if (h.length !== 6) return {bg: hex, fg: contrastTextColor(hex)};
    const r = parseInt(h.substr(0,2),16), g = parseInt(h.substr(2,2),16), b = parseInt(h.substr(4,2),16);
    const mix = (c) => Math.round(c + (255 - c) * 0.78);
    const bg = `#${[mix(r),mix(g),mix(b)].map(n => n.toString(16).padStart(2,'0')).join('')}`;
    return {bg, fg: hex};
  }

  function resolveColor(v) {
    if (!v) return EVENT_COLORS[3];
    const preset = EVENT_COLORS.find(c => c.v === v);
    if (preset) return preset;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
      const t = tintBg(v);
      return {v, t: v, bg: t.bg, fg: t.fg};
    }
    return EVENT_COLORS[3];
  }

  function presetToHex(v) {
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) return v;
    const p = EVENT_COLORS.find(c => c.v === v);
    return p ? p.fg : '#5AA94E';
  }

  /* ---------- 休假分類 ----------
   * getCustomCodes: () => 自訂班別代碼陣列（每次呼叫取最新值，因為使用者可能在後台修改）
   */
  function makeLeaveHelpers(getCustomCodes) {
    function customLeaveCategory(v) {
      const c = getCustomCodes().find(c => c.code === v);
      return c ? (c.leaveCategory || '') : '';
    }
    function isSpecialLeaveCode(v) { return customLeaveCategory(v) === 'special'; }
    function isCompLeaveCode(v) { return customLeaveCategory(v) === 'comp'; }
    function isRegularLeaveCodeOnly(v) {
      // 注意:'R' 本身不是內建代碼(只有 R1/R2 是),不可在此硬編碼判斷,
      // 否則會蓋掉使用者自訂代碼(例如自訂了一個代碼字面上就是「R」)的「計入休假統計」設定,
      // 導致自訂的補休/特休代碼被誤算成一般休假天數。一律以 customLeaveCategory 為準。
      if (v === '休' || v === 'R1' || v === 'R2') return true;
      const cat = customLeaveCategory(v);
      if (cat) return cat === 'regular';
      return false;
    }
    function isWorkCode(v) {
      if (!v) return false;
      if (v === '休' || v === 'R1' || v === 'R2' || v === '/') return false;
      return customLeaveCategory(v) === '';
    }
    function isRestCode(v) {
      if (v === '休' || v === 'R1' || v === 'R2') return true;
      const cat = customLeaveCategory(v);
      return cat === 'special' || cat === 'comp' || cat === 'regular';
    }
    return { customLeaveCategory, isSpecialLeaveCode, isCompLeaveCode, isRegularLeaveCodeOnly, isWorkCode, isRestCode };
  }

  return {
    SHIFT_TIME_RANGE, gapHours,
    ROTATION_SEQUENCE, isPureWhiteRotationStaff, rotationCategoryForMonth,
    EVENT_COLORS, eventColor, contrastTextColor, tintBg, resolveColor, presetToHex,
    makeLeaveHelpers,
  };
});
