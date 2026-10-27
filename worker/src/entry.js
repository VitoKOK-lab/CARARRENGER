// Workers 入口(ES module)。實際邏輯在 index.js(CommonJS,方便 Node 測試直接 require)。
import worker from './index.js';
export default worker;
