# 部署到 Cloudflare(Workers + D1)

網址形式:`https://cararrenger.vitokok.workers.dev`。不需要任何電腦一直開著;資料存在 Cloudflare D1。

## 架構
- 網頁(`public/`):Workers Static Assets
- 後端(`worker/src/`):一支 Worker,API 行為與 Node 版 `server/` 相同,規則共用 `shared/policy.js`
- 資料庫:D1(資料表見 `worker/migrations/0001_init.sql`)
- 本機 / Docker 的 Node 版仍可照舊使用,兩邊資料各自獨立,**不會自動同步**

## 一次性設定(在有 Node.js 的電腦上)

```bash
npm install
npx wrangler login                                   # 瀏覽器授權
npx wrangler d1 create linedong-scheduling           # 印出 database_id
```
把印出的 `database_id` 貼進 `wrangler.toml` 的 `database_id`,然後:

```bash
npx wrangler d1 migrations apply linedong-scheduling --remote   # 建資料表
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # 產生一串隨機金鑰
npx wrangler secret put JWT_SECRET      # 貼上剛剛的隨機金鑰
npx wrangler secret put SETUP_TOKEN     # 自訂一組口令,建立第一個管理者時要輸入(強烈建議)
npx wrangler deploy
```
**順序很重要**:先設好 `SETUP_TOKEN` 再部署。沒設的話,部署完到你建立管理者之前,任何知道網址的人都能搶先建立。

部署完開網址,用 `SETUP_TOKEN` 建立第一個管理者並記下救援碼。

## 用 Cloudflare Dashboard 自動部署(選用)
Workers & Pages → `cararrenger` → Settings → Builds → Connect 這個 GitHub repo(分支 `main`)。
Deploy command 用 `npx wrangler deploy`。`JWT_SECRET`、`SETUP_TOKEN` 到 Settings → Variables and Secrets 以 Secret 新增。之後每次合併到 `main` 會自動部署。
(`wrangler.toml` 裡的 `database_id` 仍需填成真正的 ID。)

## 與 Node 版的差異
- **密碼雜湊**:Workers 版用 PBKDF2-SHA256(100,000 次,Workers 上限),Node 版用 bcrypt。兩邊的帳號資料不能直接互相搬。
- **登入限流**存在 D1(`rate_limits`),重新部署不會歸零。
- **單一資料上限約 1.8MB**(D1 單列約 2MB)。一個月的班表與人員資料遠低於此;超過時會回 413。
- **CPU 時間**:Workers 免費方案每次請求 CPU 約 10ms。登入、建立帳號、重設密碼會做 PBKDF2,本機實測整個建立管理者(2 次雜湊)約 40ms 牆鐘時間,但**我無法在本機驗證 Cloudflare 免費方案實際是否計入這段原生運算**。若登入出現 `Exceeded CPU` 或 1102 錯誤,升級 Workers Paid(每月 5 美元)即可。
- 沒有 HTTPS 問題:`workers.dev` 一律 https。

## 驗證方式
```bash
npm test      # 同一組 API 與安全測試會跑兩次:Node 版、Workers 版(D1 以 better-sqlite3 替身)
npx wrangler dev   # 用本機 Workers 執行環境(workerd)實際跑
```
