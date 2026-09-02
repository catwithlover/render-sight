# mcp-browser-screenshot-service

![mcp-browser-screenshot-service logo](docs/assets/repo-logo.png)

以 Cloudflare Workers 與 Browser Rendering 建立的無狀態 MCP server。

## Tools

- `render`：將 HTML 渲染為 PNG 圖片，並以内嵌圖片、暫存下載 URL 或兩者回傳。

### Render options

| 參數 | 說明 |
| --- | --- |
| `html` | 必填，要渲染的 HTML。 |
| `width`、`height` | viewport 尺寸，預設為 `800x800`，各自限制在 `1` 到 `4096` pixels。 |
| `omitBackground` | 是否使用透明背景，預設為 `false`。 |
| `waitForFonts` | 截圖前等待 `document.fonts.ready` 與兩次 repaint，預設為 `true`。 |
| `waitForSelector` | 可選的 readiness 條件，包含 CSS `selector`、`attached \| visible \| hidden` state，以及最長 30 秒的 selector/font readiness 時間預算。 |
| `waitForTimeout` | readiness 完成後的額外固定等待，範圍為 `0` 到 `10000` ms，預設為 `0`。 |
| `output` | `inline`、`url` 或 `both`，預設為 `both`。 |
| `filename` | 下載時顯示的檔名；未提供 `.png` 時會自動補上。 |

服務會在 supplied HTML 的 doctype 後、其餘 document markup 與 CSP meta 前注入內部 readiness marker script；接著依序等待指定 selector、webfont、額外 delay 與兩次 animation frame 後才截圖。等待條件逾時時會回傳 tool error，不會以未完成的畫面繼續。以 loading overlay 為例：

```json
{
  "waitForSelector": {
    "selector": "#loading-overlay",
    "state": "hidden",
    "timeout": 15000
  },
  "waitForTimeout": 200
}
```

等待只能消除載入競態；若 font URL 發生 CORS、權限或網路錯誤，仍需改用可公開存取的 self-hosted font，或將 WOFF2 直接嵌入 HTML。

輸出模式：

| 模式 | 行為 |
| --- | --- |
| `inline` | 回傳 MCP image content，不寫入 R2。 |
| `url` | 將 Browser Rendering response body 直接串流至 R2，只回傳文字 presigned URL 與 resource metadata。 |
| `both` | 同時回傳 MCP image content 與暫存 presigned URL。未超過 inline 上限時，R2 寫入或簽署失敗會降級為 `inline`；圖片超過 inline 上限且 R2 寫入成功時則降級為 `url`。 |

所有成功結果都會提供 `output`、`filename`、`mimeType`、`width`、`height` 與 `byteLength` structured metadata。已儲存的結果另有 `renderId`、`downloadUrl` 與 `expiresAt`。

為避免超過 Workers 的 128 MB isolate memory limit，`inline` 與 `resources/read` 最多編碼 8 MiB。純 `inline` 圖片超過上限時會回傳 tool error；`both` 在 R2 寫入成功時會保留下載 URL 並改回 `output: "url"`，若 R2 同時無法寫入則回傳 tool error。

暫存 URL 是僅允許讀取單一 object、有效 24 小時的 R2 S3 presigned URL。它直接使用 `<ACCOUNT_ID>.r2.cloudflarestorage.com`，所以 agent 讀取圖片時不需再通過 Cloudflare Access 或 OAuth。MCP `2025-06-18` 以上會同時收到 `resource_link` content；較舊版本仍可從 text content 與 structured metadata 取得 URL。

Presigned URL 是 bearer token，任何取得完整 URL 的人都能在到期前重複讀取該圖片，因此不可寫入 log 或分享給非預期接收者。R2 presigned URL 不支援 custom domain。

## R2 retention

`url` 與 `both` 需要下列設定：

- `BUCKET_SCREENSHOT`：寫入截圖的 R2 binding。
- `R2_BUCKET_NAME`：與 binding 指向相同的 bucket 名稱，已在 `wrangler.jsonc` 設定。
- `R2_ACCOUNT_ID`：Cloudflare Account ID。
- `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`：限制於此 bucket 的 R2 S3 API credentials。由於 Worker 仍透過 binding 寫入，這組 credentials 只需物件讀取權限。

在 Dashboard 的 **R2 object storage** > **Manage API tokens** 建立 bucket-scoped token，取得 Access Key ID 與 Secret Access Key 後，將 deployment-specific values 設為 Worker secrets：

```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

本機開發可將相同名稱寫入不納入版本控制的 `.dev.vars`。缺少任一簽署設定時，`url` 會回傳 tool error，`both` 則在圖片未超過 inline 上限時降級成 `inline`。

物件使用 `renders/` prefix。Presigned URL 只限制存取時間，不會刪除 object；R2 實體刪除仍需在 Dashboard 設定 lifecycle rule：

1. 前往 **R2 object storage**，選擇 `mcp-browser-screenshot-service` bucket。
2. 開啟 **Settings** > **Object Lifecycle Rules**，選擇 **Add rule**。
3. 將 prefix 設為 `renders/`，並設定物件建立 1 天後刪除。
4. 儲存規則。

R2 lifecycle 通常會在 `x-amz-expiration` 後 24 小時內完成實體刪除；即使物件尚未清除，R2 也會在 presigned signature 的 `expiresAt` 後拒絕使用該 URL。原有受 Access 保護的 `/renders/{renderId}.png` 路徑仍保留給既有連結與 MCP `resources/read`，並會依 object metadata 檢查 owner 與期限。

## Authentication

此 Worker 由 Cloudflare Access Managed OAuth 保護，不使用 `workers-oauth-provider`。驗證流程分成兩段：

```text
ChatGPT -- opaque OAuth access token --> Cloudflare Access
Cloudflare Access -- Cf-Access-Jwt-Assertion --> Worker
```

ChatGPT 無法解析 Managed OAuth 發出的 opaque token。Cloudflare Access 會驗證該 token、使用者身分與 Access Policy，再將已簽章的 JWT assertion 傳給 Worker。Worker 會驗證 assertion 的 RS256 簽章、issuer、audience、subject 與有效期限，成功後才將請求交給 MCP handler。

每個驗證成功的請求都會寫入結構化 Worker log，包含 Access assertion 的 `email`（記為 `user`）、`sub`、HTTP method 與 path；JWT 本身不會寫入 log。

部署環境需要設定以下非機密環境變數：

- `TEAM_DOMAIN`：Cloudflare One team domain，例如 `https://<team-name>.cloudflareaccess.com`。
- `POLICY_AUD`：保護此 MCP server 的 Access Application Audience (AUD) tag。

缺少設定、缺少 assertion 或 JWT 驗證失敗時，請求不會進入 MCP handler。只有 render tool 回傳的 R2 presigned URL 可在其 24 小時效期內不經 OAuth 直接讀取對應圖片。

### 1. Protect the Worker with Access

1. 在 Cloudflare dashboard 前往 **Workers & Pages**，選擇 `mcp-test`。
2. 開啟 **Access**，選擇保護此 Worker。
3. 將目的地設為 Worker `mcp-test`，類型選擇 Worker 的 production 與 preview URLs。
4. 加入只允許公司成員登入的 Access Allow Policy。
5. 確認 **Domains & Routes** 包含 `mcp-browser-screenshot-service.example.com`。

Worker destination 會自動保護該 Worker 的 Custom Domains、routes、`workers.dev` hostname 與 previews，不需要再建立獨立的 hostname-based Access Application。

### 2. Enable Managed OAuth

1. 前往 **Zero Trust** > **Access controls** > **Applications**。
2. 開啟 `mcp-test - Cloudflare Workers`，進入 **Other settings** > **OAuth**。
3. 啟用 **Managed OAuth**。
4. 在 Allowed redirect URIs 優先加入 ChatGPT 顯示的完整 production redirect URI。若使用 callback-specific redirect，亦可加入：

```text
https://chatgpt.com/connector/oauth/*
```

若 ChatGPT 使用 stable redirect，再加入：

```text
https://chatgpt.com/connector_platform_oauth_redirect
```

`/*` 只允許 `chatgpt.com/connector/oauth/` 下的不同 callback ID。若能取得完整 callback URI，使用精確值會更嚴格。ChatGPT 不需要 localhost 或 `127.0.0.1` callback；除非還要使用本機 MCP client 測試，否則可關閉這兩項允許設定。

Access token lifetime 建議維持短時間，例如 5 至 15 分鐘；grant session duration 可依公司政策設定為一至數週。Access 會在 refresh token 換發 access token 時重新評估 Access Policy。

### 3. Create the ChatGPT connector

在 ChatGPT 建立自訂 connector：

- Name：`mcp-browser-screenshot-service`
- Server URL：`https://mcp-browser-screenshot-service.example.com/mcp`
- Authentication：OAuth
- Client registration：Dynamic Client Registration (DCR)
- Base scopes：留白
- Default scopes：留白
- OAuth endpoints：使用自動 discovery，不手動覆寫

Cloudflare Managed OAuth 的 metadata 未宣告自訂 scopes，因此此服務將授權交由 Access Policy 控制。建立 connector 後，首次連線會跳轉至 Cloudflare Access：

1. 使用公司身分完成登入。
2. 確認頁面顯示 `mcp-test - Cloudflare Workers`、client 為 ChatGPT，且 resource 為 `mcp-browser-screenshot-service.example.com`。
3. 選擇 **Allow**。
4. Cloudflare 將瀏覽器導回 ChatGPT，ChatGPT 取得 opaque access token 並開始呼叫 MCP tools。


官方文件：

- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [OpenAI OAuth authentication](https://developers.openai.com/plugins/build/auth)

## Development

需求：Node.js 22+、已啟用 Browser Rendering 的 Cloudflare 帳號，以及完成登入的 Wrangler CLI。

```bash
npm install
npm run dev
```

本機 MCP endpoint 為 `http://localhost:8787/mcp`。

本機直接呼叫不會經過 Cloudflare Access，因此缺少 assertion 時會回傳 `403`。測試會使用臨時 RSA key pair 簽發 JWT 並 mock JWKS endpoint，不需要連線至 Cloudflare。

```bash
npm test -- --run
npm run deploy
```
