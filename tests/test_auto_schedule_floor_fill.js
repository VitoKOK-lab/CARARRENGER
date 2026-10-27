// 驗證「自動排班 bug 修正」:
// 沒有設定三個月輪調、但有白班資格的護理人員,應該要能被排入 2Di/3Di 實際班別,
// 而不是像修正前那樣整個月只拿到休假。直接測正式的 autoScheduleMonth(public/scheduling-core.js)。
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

// ---- 情境:1位固定2Di(已預填), 1位一般白班無輪調, 1位小夜資格 ----
const nDays = 10;
const A = {id:'A', name:'固定2Di(輪調)', eligWhite:true, rotationTrack:'rotate', rotationStartMonth:'2026-08', rotationStartShift:'2Di'};
const B = {id:'B', name:'一般白班(無輪調)', eligWhite:true};
const C = {id:'C', name:'小夜資格', eligEvening:true};
const G = {id:'G', name:'另一位一般白班', eligWhite:true};
const prefillA = {};
for(let d=1; d<=nDays; d++) prefillA[d] = (d%6===0) ? '休' : '2Di';
const r = run([A,B,C,G], { prefill:{A:prefillA}, nDays });

const bCodes = []; for(let d=1; d<=nDays; d++) bCodes.push(r.code(B,d));
test('B(一般白班,無輪調)本月有被排到至少一次3Di或2Di', bCodes.some(v=>v==='2Di'||v==='3Di'));
test('B不應整月只有休假或空白(修正前的bug)', !bCodes.every(v=>!v || v==='休'));
const cCodes = []; for(let d=1; d<=nDays; d++) cCodes.push(r.code(C,d));
test('C(小夜資格)本月至少被排一次E班', cCodes.some(v=>v==='E'));
test('A第6天休假,2Di缺口應該被其他人補上', [B,G].some(p=>r.code(p,6)==='2Di'));

console.log(`\n通過 ${pass} / 失敗 ${fail}`);
process.exit(fail>0?1:0);
