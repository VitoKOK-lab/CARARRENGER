// 驗證顏色選擇從固定6色升級成完整色票(任意hex色碼)後的相容邏輯。
// 舊資料存的是像 'blue'/'green' 這種代號,新資料存的是像 '#3A7BD5' 這種hex色碼,
// resolveColor() 要兩種都能正確處理,不能讓舊資料顯示壞掉。

const { EVENT_COLORS, contrastTextColor, tintBg, resolveColor, presetToHex } = require('../public/scheduling-core.js');

let pass=0, fail=0;
function test(name, cond){
  if(cond){ pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

// ---- 舊資料相容性(存的是代號,不是hex) ----
test('舊資料"blue"仍能正確解析成藍色系樣式', resolveColor('blue').bg==='#DCEBFB' && resolveColor('blue').fg==='#1D5FA8');
test('舊資料"red"仍能正確解析', resolveColor('red').fg==='#C1573A');
test('presetToHex把舊代號轉成色票初始值(給color input用)', presetToHex('green')==='#2E7D32');
test('presetToHex遇到已經是hex的值,原樣傳回', presetToHex('#3A7BD5')==='#3A7BD5');

// ---- 新資料(使用者自己用色票選的hex) ----
const custom = resolveColor('#3A7BD5');
test('新的hex色碼能被正確辨識、不會被誤判成預設紅色', custom.fg==='#3A7BD5');
test('hex色碼會自動算出一個淺色底(tint background)', /^#[0-9A-Fa-f]{6}$/.test(custom.bg) && custom.bg!=='#3A7BD5');

// ---- 對比色計算 ----
test('淺色(接近白色)背景應該配深色文字', contrastTextColor('#F5F5F0')==='#1F2A1D');
test('深色背景應該配白色文字', contrastTextColor('#1A1A1A')==='#FFFFFF');

// ---- 異常輸入不應該報錯,要有合理fallback ----
test('空值不報錯,回傳預設(紅色系)', resolveColor('').fg==='#C1573A');
test('格式不對的字串(不是hex也不是預設代號)不報錯,回傳預設', resolveColor('not-a-color').fg==='#C1573A');
test('3碼簡寫hex(不符合完整6碼規則)視為無效,回傳預設', resolveColor('#fff').fg==='#C1573A');

console.log(`\n通過 ${pass} / 失敗 ${fail}`);
process.exit(fail>0?1:0);
