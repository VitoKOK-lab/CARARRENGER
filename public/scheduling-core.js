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

  /* ---------- 排班健檢(純函式) ----------
   * 每條規則一個 check_xxx(p, codes, c, add) 函式;add(ruleKey, title, staffName, dateLabel, staffObj) 由呼叫端提供
   * (呼叫端負責依規則啟用/適用對象過濾、附上建議)。c: 見 checkSchedule 的 ctx。
   */
  function check_eligibility(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    if(c.isNursing){
      const whiteCodes=['Di','2Di','3Di','D8','2D8','3D8','Dp'], eveningCodes=['E','Ep'], nightCodes=['N','E8'];
      codes.forEach((v, idx)=>{
        if(!v) return;
        const day = idx+1, label = `${mon}/${day}`;
        if(whiteCodes.includes(v) && !p.eligWhite) add('eligibility', `${v} 需要白班資格,但該同仁未勾選白班`, p.name, label, p);
        if(eveningCodes.includes(v) && !p.eligEvening) add('eligibility', `${v} 需要小夜資格,但該同仁未勾選小夜`, p.name, label, p);
        if(nightCodes.includes(v) && !p.eligNight) add('eligibility', `${v} 需要大夜資格,但該同仁未勾選大夜`, p.name, label, p);
      });
      if(p.partTime){
        codes.forEach((v, idx)=>{
          const day = idx+1;
          const d = new Date(c.year, c.month, day);
          const wd = d.getDay();
          if((v==='Dp'||v==='Ep') && !(p.partTimeDays||[]).includes(wd)){
            add('parttime_days', `${v} 排在非固定到班星期(週${c.weekdayNames[wd]})`, p.name, `${mon}/${day}`, p);
          }
        });
      }
    }
  }

  function check_restInterval(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const minGap = parseFloat(params.rest_interval) || 12;
    for(let day=1; day<nDays; day++){
      const v1 = codes[day-1], v2 = codes[day];
      const gap = gapHours(v1, v2);
      if(gap!==null && gap < minGap){
        add('rest_interval', `${v1}(${mon}/${day}) 接 ${v2}(${mon}/${day+1}),休息僅 ${gap} 小時`, p.name, `${mon}/${day}-${day+1}`, p);
      }
    }
  }

  function check_consecutive(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const maxConsec = parseInt(params.consecutive_days) || 5;
    let streak = 0, streakStart = null;
    for(let day=1; day<=nDays; day++){
      const v = codes[day-1];
      if(leave.isWorkCode(v)){
        if(streak===0) streakStart = day;
        streak++;
      } else {
        if(streak > maxConsec) add('consecutive_days', `連續上班 ${streak} 天(超過上限 ${maxConsec} 天)`, p.name, `${mon}/${streakStart}-${day-1}`, p);
        streak = 0;
      }
    }
    if(streak > maxConsec) add('consecutive_days', `連續上班 ${streak} 天(超過上限 ${maxConsec} 天)`, p.name, `${mon}/${streakStart}-${nDays}`, p);
  }

  function check_biweekly(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const minBiweekly = parseInt(params.biweekly_rest) || 2;
    for(let start=1; start+13<=nDays; start++){
      let restCount = 0;
      for(let day=start; day<start+14; day++){ if(leave.isRestCode(codes[day-1])) restCount++; }
      if(restCount < minBiweekly){
        add('biweekly_rest', `${mon}/${start}-${start+13} 這14天內只有 ${restCount} 個例假(至少需要${minBiweekly}個)`, p.name, `${mon}/${start}-${start+13}`, p);
        break;
      }
    }
  }

  function check_fourWeek(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const minFourWeek = parseInt(params.four_week_rest_total) || 8;
    for(let start=1; start+27<=nDays; start++){
      let restCount = 0;
      for(let day=start; day<start+28; day++){ if(leave.isRestCode(codes[day-1])) restCount++; }
      if(restCount < minFourWeek){
        add('four_week_rest_total', `${mon}/${start}-${start+27} 這4週(28天)內只有 ${restCount} 天休假(例假+休息日,至少需要${minFourWeek}天)`, p.name, `${mon}/${start}-${start+27}`, p);
        break;
      }
    }
  }

  function check_overtime(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const maxOvertime = parseInt(params.monthly_overtime_hours) || 46;
    let totalWorkHours = 0;
    codes.forEach(v=>{
      if(SHIFT_TIME_RANGE[v]){ totalWorkHours += (SHIFT_TIME_RANGE[v][1]-SHIFT_TIME_RANGE[v][0]); }
    });
    const restDaysForOvertimeCalc = codes.filter(v=>leave.isRestCode(v)).length;
    const normalBaselineHours = (nDays - restDaysForOvertimeCalc) * 8;
    const estOvertime = Math.max(0, totalWorkHours - normalBaselineHours);
    if(estOvertime > maxOvertime){
      add('monthly_overtime_hours', `本月估計工時 ${totalWorkHours} 小時,推估加班約 ${estOvertime} 小時,超過上限 ${maxOvertime} 小時(此為概估,Dp/Ep兼職時數未固定不計入)`, p.name, `本月`, p);
    }
  }

  function check_monthlyRest(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    const calMinFromCalendar = c.calendarMinRest;
    const minMonthly = (calMinFromCalendar!==null && !isNaN(calMinFromCalendar)) ? calMinFromCalendar : (parseInt(params.monthly_rest_days) || 10);
    const restTotal = codes.filter(v=>leave.isRestCode(v)).length;
    if(restTotal < minMonthly){
      const source = calMinFromCalendar!==null ? '(依年度行事曆機構實休天數)' : '(依排班規則設定的參數)';
      add('monthly_rest_days', `本月休假天數 ${restTotal} 天,少於門檻 ${minMonthly} 天 ${source}`, p.name, `本月`, p);
    }
  }

  function check_weekend(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    if(c.isNursing && p.weekendPref){
      const weekends = [];
      for(let day=1; day<=nDays; day++){
        const wd = new Date(c.year, c.month, day).getDay();
        if(wd===6){
          // 星期六一定配對「隔天」的星期日,這樣才會是同一個週末
          const sunDay = day+1;
          const sunRest = sunDay<=nDays ? leave.isRestCode(codes[sunDay-1]) : null;
          weekends.push({sat: leave.isRestCode(codes[day-1]), sun: sunRest});
        } else if(wd===0 && day===1){
          // 當月第一天就是星期日,這個月沒有對應的星期六,單獨算一個週末
          weekends.push({sat: null, sun: leave.isRestCode(codes[day-1])});
        }
      }
      // 全月每日是否休假(給 w3/w4 判斷連休用)
      const restOn = {};
      for(let day=1; day<=nDays; day++) restOn[day] = leave.isRestCode(codes[day-1]);
      // 完整六日連休(六、日都休)的週末數,給 w2 用
      const fullRestWeekends = weekends.filter(w=> w.sat===true && w.sun===true).length;

      if(p.weekendPref==='w1' && weekends.some(w=> !(w.sat||w.sun)))
        add('weekend_pref', `週末需求「六日至少休一天」未被滿足`, p.name, `本月`, p);

      if(p.weekendPref==='w5' && weekends.some(w=> w.sat===false || w.sun===false))
        add('weekend_pref', `週末需求「六日都休息」未被滿足`, p.name, `本月`, p);

      if(p.weekendPref==='w2'){
        if(fullRestWeekends===0)
          add('weekend_pref', `週末需求「每月至少一次六日連休」未被滿足(本月沒有任何一個完整的六日連休)`, p.name, `本月`, p);
        else if(fullRestWeekends>=2)
          add('weekend_pref', `週末需求「其餘週末至少上一天」未被滿足(本月有 ${fullRestWeekends} 個週末六日皆休,超過希望的一次)`, p.name, `本月`, p);
      }

      if(p.weekendPref==='w3'){
        // 找出「孤立單日休假」:當天休假,但前一天與後一天都不是休假
        const isolated = [];
        for(let day=1; day<=nDays; day++){
          if(!restOn[day]) continue;
          const prevRest = day>1 && restOn[day-1];
          const nextRest = day<nDays && restOn[day+1];
          if(!prevRest && !nextRest) isolated.push(day);
        }
        if(isolated.length)
          add('weekend_pref', `休假偏好「希望兩日連休」未被滿足(有 ${isolated.length} 天單日休假沒有連著另一天:${isolated.map(d=>d+'號').join('、')})`, p.name, `本月`, p);
      }

      if(p.weekendPref==='w4'){
        // 找出「連續兩天(含)以上的休假」
        const runs = [];
        let start=null;
        for(let day=1; day<=nDays+1; day++){
          const r = (day<=nDays) && restOn[day];
          if(r && start===null) start=day;
          else if(!r && start!==null){ if((day-1) - start >= 1) runs.push([start, day-1]); start=null; }
        }
        if(runs.length)
          add('weekend_pref', `休假偏好「不要安排連休」未被滿足(有連續休假:${runs.map(r=>r[0]+'–'+r[1]+'號').join('、')})`, p.name, `本月`, p);
      }
    }
  }

  function check_leaveReq(p, codes, c, add) {
    const { nDays, params, leave, leaveReq } = c; const mon = c.month + 1;
    if(leaveReq[p.id]!==undefined){
      const reqEntry = leaveReq[p.id];
      const specialCountForReq = codes.filter(v=>leave.isSpecialLeaveCode(v)).length;
      const compCountForReq = codes.filter(v=>leave.isCompLeaveCode(v)).length;
      const reqSpecial = c.leaveReqAmount(reqEntry, 'special');
      const reqComp = c.leaveReqAmount(reqEntry, 'comp');
      if(reqSpecial!==undefined && reqSpecial!==null && specialCountForReq < reqSpecial){
        add('leave_request_fulfillment', `登記的特休需求 ${reqSpecial} 天,目前只排了 ${specialCountForReq} 天特休`, p.name, `本月`, p);
      }
      if(reqComp!==undefined && reqComp!==null && compCountForReq < reqComp){
        add('leave_request_fulfillment', `登記的補休需求 ${reqComp} 天,目前只排了 ${compCountForReq} 天補休`, p.name, `本月`, p);
      }
    }
  }

  function check_staffing(c, add) {
    const { items } = c; const mon = c.month + 1;
  if(c.isNursing){
    for(let day=1; day<=c.nDays; day++){
      const ds = dateKey(c.year, c.month, day);
      const count2Di = c.items.filter(p=> c.monthData[p.id] && ['2Di','2D8'].includes(c.monthData[p.id][ds])).length;
      const count3Di = c.items.filter(p=> c.monthData[p.id] && ['3Di','3D8'].includes(c.monthData[p.id][ds])).length;
      const countE = c.items.filter(p=> c.monthData[p.id] && ['E','E8','Ep'].includes(c.monthData[p.id][ds])).length;
      const label = `${mon}/${day}`;
      if(count2Di===0) add('staffing_min', `2樓白班(2Di)當天無人力`, '—', label);
      if(count3Di===0) add('staffing_min', `3樓白班(3Di)當天無人力`, '—', label);
      if(countE===0) add('staffing_min', `小夜班當天無人力`, '—', label);
    }
  }
  }

  /* ctx: { items, monthData, year, month(0-11), nDays, isNursing, leaveReq, leaveReqAmount, weekdayNames,
   *        params:{rest_interval,consecutive_days,biweekly_rest,four_week_rest_total,monthly_overtime_hours,monthly_rest_days},
   *        calendarMinRest: 機構行事曆實休天數(沒有則 null), leave:{isWorkCode,isRestCode,isSpecialLeaveCode,isCompLeaveCode} }
   */
  function checkSchedule(ctx, add) {
    const checks = [check_eligibility, check_restInterval, check_consecutive, check_biweekly, check_fourWeek,
                    check_overtime, check_monthlyRest, check_weekend, check_leaveReq];
    ctx.items.forEach(p => {
      const codes = [];
      for (let day = 1; day <= ctx.nDays; day++) {
        codes.push((ctx.monthData[p.id] && ctx.monthData[p.id][dateKey(ctx.year, ctx.month, day)]) || '');
      }
      checks.forEach(fn => fn(p, codes, ctx, add));
    });
    if (ctx.isNursing) check_staffing(ctx, add);
  }

  return {
    SHIFT_TIME_RANGE, gapHours,
    ROTATION_SEQUENCE, isPureWhiteRotationStaff, rotationCategoryForMonth,
    EVENT_COLORS, eventColor, contrastTextColor, tintBg, resolveColor, presetToHex,
    makeLeaveHelpers, dateKey, autoScheduleMonth, checkSchedule,
  };
});
