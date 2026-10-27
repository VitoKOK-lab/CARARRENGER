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

  /* ---------- 自動排班(護理) ----------
   * 純函式:直接修改 ctx.monthData(代碼寫入 monthData[人員id][YYYY-MM-DD]),回傳「系統無法自動決定」的提示清單。
   * ctx: { items, monthData, year, month(0-11), nDays, maxConsec, minGap, defaultMonthlyRest,
   *        leave:{isWorkCode,isRestCode}, random?:()=>number }
   */
  function dateKey(year, month, day) {
    return `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  function makeScheduleState(ctx) {
    const st = Object.assign({ log: [], random: Math.random }, ctx);
    st.items.forEach(p => { if (!st.monthData[p.id]) st.monthData[p.id] = {}; });
    st.getCode = (p, day) => st.monthData[p.id][dateKey(st.year, st.month, day)] || '';
    st.setCode = (p, day, code) => { st.monthData[p.id][dateKey(st.year, st.month, day)] = code; };
    st.isEmpty = (p, day) => !st.getCode(p, day);
    st.label = (day) => `${st.month + 1}/${day}`;
    st.consecutiveStreakBefore = (p, day) => {
      let streak = 0;
      for (let d = day - 1; d >= 1; d--) { if (st.leave.isWorkCode(st.getCode(p, d))) streak++; else break; }
      return streak;
    };
    st.restIntervalOk = (p, day, newCode) => {
      const prev = day > 1 ? st.getCode(p, day - 1) : '';
      const gapBefore = gapHours(prev, newCode);
      if (gapBefore !== null && gapBefore < st.minGap) return false;
      const next = day < st.nDays ? st.getCode(p, day + 1) : '';
      const gapAfter = gapHours(newCode, next);
      if (gapAfter !== null && gapAfter < st.minGap) return false;
      return true;
    };
    st.weekendForcesRest = (p, day) => {
      if (!p.weekendPref) return false;
      const wd = new Date(st.year, st.month, day).getDay();
      return p.weekendPref === 'w5' && (wd === 0 || wd === 6);
    };
    st.restCountSoFar = (p) => {
      let n = 0;
      for (let day = 1; day <= st.nDays; day++) { if (!st.isEmpty(p, day) && st.leave.isRestCode(st.getCode(p, day))) n++; }
      return n;
    };
    return st;
  }

  // Pass A 前半:找出本月固定輪到 2Di / 3Di 的純白班輪調同仁
  function pickRotationRegulars(st) {
    const regulars = {};
    st.items.filter(isPureWhiteRotationStaff).forEach(p => {
      const cat = rotationCategoryForMonth(p, new Date(st.year, st.month, 1));
      if (cat === '2Di' || cat === '3Di') {
        if (!regulars[cat]) regulars[cat] = p;
        else st.log.push(`${cat} 這個月有兩位以上同仁輪調起始設定衝突到同一格,已用「${regulars[cat].name}」,「${p.name}」需要你手動安排`);
      } else if (cat === null) {
        st.log.push(`${p.name} 有勾選三個月輪調,但輪調起始月份/班別尚未設定,這個人本月沒有被自動排班`);
      }
    });
    return regulars;
  }

  // Pass A 後半:固定樓層同仁整月排滿(必要時插入休假)
  function fillRegularSlots(st, regulars) {
    ['2Di','3Di'].forEach(cat => {
      const p = regulars[cat];
      if (!p) { st.log.push(`本月沒有同仁固定輪到「${cat}」,如果沒有其他白班同仁可以補位,這個位置會需要你手動安排`); return; }
      for (let day = 1; day <= st.nDays; day++) {
        if (!st.isEmpty(p, day)) continue;
        const streak = st.consecutiveStreakBefore(p, day);
        const remainingDays = st.nDays - day + 1;
        const remainingRestNeeded = Math.max(0, st.defaultMonthlyRest - st.restCountSoFar(p));
        let shouldRest = false;
        if (streak >= st.maxConsec) shouldRest = true;
        else if (st.weekendForcesRest(p, day)) shouldRest = true;
        else if (remainingRestNeeded >= remainingDays) shouldRest = true;
        else if (remainingRestNeeded > 0 && streak >= 2 && st.random() < (remainingRestNeeded / remainingDays)) shouldRest = true;

        if (shouldRest) st.setCode(p, day, '休');
        else if (st.restIntervalOk(p, day, cat)) st.setCode(p, day, cat);
        else st.setCode(p, day, '休');
      }
    });
  }

  // Pass B:其餘同仁補白班樓層 / 小夜 / 大夜的缺口。
  // 補位池排除兼職(partTime)——兼職只能在自己固定到班星期上Dp/Ep,完全交給使用者手動安排。
  function fillCoverageGaps(st, regulars) {
    const { items } = st;
    const floorFillPool = items.filter(p => p.eligWhite && !p.partTime && p !== regulars['2Di'] && p !== regulars['3Di']);
    const eveningPool = items.filter(p => p.eligEvening && !p.partTime);
    const nightPool = items.filter(p => p.eligNight && !p.partTime);
    const floorCount = {}, eCount = {}, nCount = {};
    items.forEach(p => { floorCount[p.id] = 0; eCount[p.id] = 0; nCount[p.id] = 0; });

    const pick = (pool, day, code, counter) => {
      const candidates = pool.filter(p => st.isEmpty(p, day) && st.consecutiveStreakBefore(p, day) < st.maxConsec && !st.weekendForcesRest(p, day) && st.restIntervalOk(p, day, code));
      candidates.sort((a, b) => counter[a.id] - counter[b.id]);
      if (!candidates.length) return false;
      st.setCode(candidates[0], day, code);
      counter[candidates[0].id]++;
      return true;
    };

    for (let day = 1; day <= st.nDays; day++) {
      ['2Di','3Di'].forEach(cat => {
        const covered = items.some(p => st.getCode(p, day) === cat || st.getCode(p, day) === (cat === '2Di' ? '2D8' : '3D8'));
        if (covered) return;
        if (!pick(floorFillPool, day, cat, floorCount)) st.log.push(`${st.label(day)} 找不到人選可補 ${cat} 白班,需要你手動安排`);
      });
      if (!items.some(p => ['E','E8','Ep'].includes(st.getCode(p, day)))) {
        if (!pick(eveningPool, day, 'E', eCount)) st.log.push(`${st.label(day)} 找不到人選可排小夜(E),需要你手動安排`);
      }
      if (!items.some(p => ['N','E8'].includes(st.getCode(p, day)))) {
        if (!pick(nightPool, day, 'N', nCount)) st.log.push(`${st.label(day)} 找不到人選可排大夜(N),需要你手動安排`);
      }
    }
  }

  // Pass C:剩下空著的格子 → 先休假湊到每月額度,滿了才排 Di(白班資格)或維持休假。兼職同仁整批跳過。
  function fillRemaining(st) {
    st.items.forEach(p => {
      if (p.partTime) return;
      let restDays = st.restCountSoFar(p);
      for (let day = 1; day <= st.nDays; day++) {
        if (!st.isEmpty(p, day)) continue;
        if (restDays < st.defaultMonthlyRest) { st.setCode(p, day, '休'); restDays++; }
        else if (p.eligWhite) st.setCode(p, day, 'Di');
        else { st.setCode(p, day, '休'); restDays++; }
      }
    });
  }

  function autoScheduleMonth(ctx) {
    const st = makeScheduleState(ctx);
    const regulars = pickRotationRegulars(st);
    fillRegularSlots(st, regulars);
    fillCoverageGaps(st, regulars);
    fillRemaining(st);
    return st.log;
  }

  return {
    SHIFT_TIME_RANGE, gapHours,
    ROTATION_SEQUENCE, isPureWhiteRotationStaff, rotationCategoryForMonth,
    EVENT_COLORS, eventColor, contrastTextColor, tintBg, resolveColor, presetToHex,
    makeLeaveHelpers, dateKey, autoScheduleMonth,
  };
});
