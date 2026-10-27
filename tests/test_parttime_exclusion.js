// 驗證「兼職同仁完全不參與自動排班補位」:
// 兼職白班/小夜/大夜都不該被補進 2Di/3Di/E/N,也不該在 Pass C 被自動填入休/Di。
// 直接測正式的 autoScheduleMonth(public/scheduling-core.js)。
const { autoScheduleMonth, dateKey, makeLeaveHelpers } = require('../public/scheduling-core.js');

let pass=0, fail=0;
function test(name, cond){
  if(cond){ pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

// 跑正式的 autoScheduleMonth。預先填好的格子用 prefill[id][day] 指定;回傳 {data, log, code(p,day)}
function run(items, { prefill = {}, nDays = 10, random = () => 1, defaultMonthlyRest = 4 } = {}) {
  const year = 2026, month = 7; // 2026-08
  const monthData = {};
  items.forEach(p => { monthData[p.id] = {}; });
  Object.entries(prefill).forEach(([id, days]) => Object.entries(days).forEach(([d, c]) => { monthData[id][dateKey(year, month, +d)] = c; }));
  const leave = makeLeaveHelpers(() => []);
  const log = autoScheduleMonth({ items, monthData, year, month, nDays, maxConsec: 5, minGap: 11, defaultMonthlyRest, leave, random });
  return { data: monthData, log, code: (p, d) => monthData[p.id][dateKey(year, month, d)] || '' };
}

const A = {id:'A', name:'全職白班', eligWhite:true, partTime:false};
const B = {id:'B', name:'兼職白班', eligWhite:true, partTime:true};
const C = {id:'C', name:'兼職小夜', eligEvening:true, partTime:true};
const D = {id:'D', name:'兼職大夜', eligNight:true, partTime:true};
const E = {id:'E', name:'全職小夜', eligEvening:true, partTime:false};
const F = {id:'F', name:'全職大夜', eligNight:true, partTime:false};
const items = [A,B,C,D,E,F];
const r = run(items, { nDays:10 });
const allCodes = (p) => Array.from({length:10}, (_, i) => r.code(p, i+1));

test('兼職白班(B)整月維持空白,不被補位或塞休/Di', allCodes(B).every(v=>v===''));
test('兼職小夜(C)整月維持空白', allCodes(C).every(v=>v===''));
test('兼職大夜(D)整月維持空白', allCodes(D).every(v=>v===''));
test('全職小夜(E)正常被排到E班,不會被誤排除', allCodes(E).includes('E'));
test('全職大夜(F)正常被排到N班', allCodes(F).includes('N'));
test('全職白班(A)正常被排班(不是整月空白)', allCodes(A).some(v=>v!==''));
test('Pass C 之後全職同仁沒有空白格', [A,E,F].every(p=>allCodes(p).every(v=>v!=='')));

console.log(`\n通過 ${pass} / 失敗 ${fail}`);
process.exit(fail>0?1:0);
