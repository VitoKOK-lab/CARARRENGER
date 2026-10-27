// 驗證「週末需求健檢誤判」bug 的修正。
// 問題:原本用 Math.ceil((day + firstWd) / 7) 幫星期六/日分組,
// 在某些月份起始星期下,會把同一個週末的六跟日拆到不同組別,導致誤判「六日都沒休」。
// 修正:改成「星期六一定跟隔天的星期日配對」,不再用公式硬算分組。
// 直接測正式的 checkSchedule(public/scheduling-core.js)。

const { checkSchedule, makeLeaveHelpers, dateKey } = require('../public/scheduling-core.js');

// 2026-09:1號是星期二(對照使用者實際回報問題的月份起始星期)
// 回傳 true = 該週末/休假偏好被滿足(健檢沒有產生 weekend_pref 問題)
function checkWeekendPref(codes, nDays, prefType){
  const year = 2026, month = 8;
  const p = {id:'P', name:'測試', weekendPref: prefType};
  const monthData = {P:{}};
  codes.slice(0, nDays).forEach((c, i)=>{ if(c) monthData.P[dateKey(year, month, i+1)] = c; });
  const findings = [];
  checkSchedule({
    items:[p], monthData, year, month, nDays, isNursing:true, leaveReq:{}, leaveReqAmount:()=>undefined, weekdayNames:[],
    params:{}, calendarMinRest:0, leave: makeLeaveHelpers(()=>[]),
  }, (key)=>{ if(key==='weekend_pref') findings.push(key); });
  return findings.length===0;
}

let pass=0, fail=0;
function test(name, cond){
  if(cond){ pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

// ---- 案例1:使用者實際回報的情境(劉婷貞,8月,1號=星期二) ----
// 每個週末六或日至少有一天是R(休假),理論上應該「滿足」w1需求
const codes1 = ['R1','3Di','3Di','3Di','3Di','R1','3Di','3Di','R1','3Di','3Di','3Di','R1','3Di','3Di','R1','3Di','3Di','3Di','R1','3Di','3Di','R1','3Di','3Di','R1','3Di','3Di','R1','R1'];
test('案例1:六日至少休一天,實際上每週末都有休,應判定為「滿足」', checkWeekendPref(codes1, codes1.length, 'w1'));

// ---- 案例2:真的沒有滿足的情況,應該要抓出來(不能改過頭變成都不檢查) ----
// 故意讓某個週末六日都上班
const codes2 = codes1.slice();
codes2[4] = '3Di';  // day5(六) 改成上班
codes2[5] = '3Di';  // day6(日) 改成上班,這個週末六日都沒休
test('案例2:真的有一個週末六日都沒休,應該判定為「未滿足」', !checkWeekendPref(codes2, codes2.length, 'w1'));

// ---- 案例3:w5(六日都要休),驗證同樣的分組修正也適用 ----
const codes3 = codes1.map(v=> (v==='3Di') ? '休' : v); // 假設全部白班日都改休,週末應該都符合w5
test('案例3:六日都休息(w5),全部休假的情境應判定為「滿足」', checkWeekendPref(codes3, codes3.length, 'w5'));

// ---- w2:每月至少一次六日連休,其餘週末至少上一天 ----
// 週末配對(day1=週二):六=5,12,19,26;日=6,13,20,27
function base30(){ return Array.from({length:30}, ()=>'3Di'); }
const w2ok = base30(); w2ok[4]='休'; w2ok[5]='休'; // 只有 5/6(六日)連休一次,其餘週末都上班
test('w2:恰好一次六日連休,其餘週末都上班 → 滿足', checkWeekendPref(w2ok, 30, 'w2'));
const w2none = base30(); w2none[4]='休'; // 只有週六休、週日上,沒有任何完整連休
test('w2:完全沒有六日連休 → 未滿足', !checkWeekendPref(w2none, 30, 'w2'));
const w2two = base30(); w2two[4]='休'; w2two[5]='休'; w2two[11]='休'; w2two[12]='休'; // 兩個週末都連休
test('w2:六日連休超過一次(其餘沒上班) → 未滿足', !checkWeekendPref(w2two, 30, 'w2'));

// ---- w3:休假希望兩日連休(不能有孤立單日休假) ----
const w3ok = Array.from({length:14}, ()=>'3Di'); w3ok[2]='休'; w3ok[3]='休'; w3ok[9]='休'; w3ok[10]='休';
test('w3:休假都是兩天連著 → 滿足', checkWeekendPref(w3ok, 14, 'w3'));
const w3bad = Array.from({length:14}, ()=>'3Di'); w3bad[2]='休'; // 第3天單獨一天休
test('w3:有孤立單日休假 → 未滿足', !checkWeekendPref(w3bad, 14, 'w3'));

// ---- w4:休假希望不要連休(不能有連續兩天休假) ----
const w4ok = Array.from({length:14}, ()=>'3Di'); w4ok[2]='休'; w4ok[6]='休'; w4ok[10]='休'; // 都隔開
test('w4:休假都分開安排 → 滿足', checkWeekendPref(w4ok, 14, 'w4'));
const w4bad = Array.from({length:14}, ()=>'3Di'); w4bad[2]='休'; w4bad[3]='休'; // 連續兩天休
test('w4:有連續兩天休假 → 未滿足', !checkWeekendPref(w4bad, 14, 'w4'));

console.log(`\n通過 ${pass} / 失敗 ${fail}`);
process.exit(fail>0?1:0);
