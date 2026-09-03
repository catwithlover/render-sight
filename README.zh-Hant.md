<div align="center">
  <img src="docs/assets/repo-logo.svg" alt="RenderSight" width="180" />
  <h1>RenderSight</h1>
  <p><em>讓 ChatGPT 看見它自己做出的網頁——部署在 Cloudflare Workers 上的 MCP 網頁截圖服務</em></p>
  <p><a href="https://catwithlover.github.io/render-sight/"><strong>Website</strong></a></p>
  <p><a href="README.md">English</a> · 繁體中文</p>
</div>

**RenderSight** 是一個部署在 Cloudflare Workers 上的無狀態 MCP server，讓 ChatGPT 能夠呈現、檢視並截圖 agent 在自己執行環境中製作、編修的網頁成果。

## 為什麼需要這個服務

ChatGPT 的 chat 與 work 環境內建雲端瀏覽器，但該瀏覽器運行在與 agent 隔離的環境中：agent 在自己的執行環境裡產出或修改 HTML、CSS、JavaScript 之後，無法把這些成果交給那個瀏覽器載入，因此無法呈現、檢視或截圖自己做出來的網頁——agent 看不見自己的成果，只能盲改。

本服務透過 MCP 補上這塊缺口：agent 將網頁內容交給 `render` tool，由 Cloudflare Browser Run（原名 Browser Rendering）在雲端渲染並回傳 PNG 截圖。agent 從此能「看見」自己寫出來的頁面並據以迭代，例如：

- 視覺化檢查產生的 landing page、電子郵件樣板或報告版面。
- 以「截圖 → 檢視 → 修正 → 再截圖」的循環迭代 UI。
- 把渲染結果包裝成暫存連結分享出去。

## 運作方式

```text
ChatGPT ──Managed OAuth──▶ MCP server（Cloudflare Workers）
                              ├─▶ Browser Run：渲染 HTML，等內容與 webfont 就緒後截圖
                              └─▶ R2：暫存 PNG，回傳 24 小時效期的 presigned 下載 URL
```

- Worker 由 Cloudflare Access Managed OAuth 保護，只有通過 Access Policy 的使用者能連線。
- 截圖能以 MCP image content 內嵌回傳、存入 R2 並回傳暫存下載 URL，或兩者同時回傳。

## Tools

### render

將 HTML 渲染為 PNG 圖片，並以内嵌圖片、暫存下載 URL 或兩者回傳。

參數：

| 參數              | 說明                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `html`            | 必填，要渲染的 HTML。                                                                                                                  |
| `width`、`height` | viewport 尺寸，預設為 `800x800`，各自限制在 `1` 到 `4096` pixels。                                                                     |
| `omitBackground`  | 是否使用透明背景，預設為 `false`。                                                                                                     |
| `waitForFonts`    | 截圖前等待 `document.fonts.ready` 與兩次 repaint，預設為 `true`。                                                                      |
| `waitForSelector` | 可選的 readiness 條件，包含 CSS `selector`、`attached \| visible \| hidden` state，以及最長 30 秒的 selector/font readiness 時間預算。 |
| `waitForTimeout`  | readiness 完成後的額外固定等待，範圍為 `0` 到 `10000` ms，預設為 `0`。                                                                 |
| `output`          | `inline`、`url` 或 `both`，預設為 `both`。                                                                                             |
| `filename`        | 下載時顯示的檔名；未提供 `.png` 時會自動補上。                                                                                         |

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

| 模式     | 行為                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline` | 回傳 MCP image content，不寫入 R2。                                                                                                                             |
| `url`    | 將 Browser Run response body 直接串流至 R2，只回傳文字 presigned URL 與 resource metadata。                                                                     |
| `both`   | 同時回傳 MCP image content 與暫存 presigned URL。未超過 inline 上限時，R2 寫入或簽署失敗會降級為 `inline`；圖片超過 inline 上限且 R2 寫入成功時則降級為 `url`。 |

所有成功結果都會提供 `output`、`filename`、`mimeType`、`width`、`height` 與 `byteLength` structured metadata。已儲存的結果另有 `renderId`、`downloadUrl` 與 `expiresAt`。

為避免超過 Workers 的 128 MB isolate memory limit，`inline` 與 `resources/read` 最多編碼 8 MiB。純 `inline` 圖片超過上限時會回傳 tool error；`both` 在 R2 寫入成功時會保留下載 URL 並改回 `output: "url"`，若 R2 同時無法寫入則回傳 tool error。

暫存 URL 是僅允許讀取單一 object、有效 24 小時的 R2 S3 presigned URL。它直接使用 `<ACCOUNT_ID>.r2.cloudflarestorage.com`，所以 agent 讀取圖片時不需再通過 Cloudflare Access 或 OAuth。MCP `2025-06-18` 以上會同時收到 `resource_link` content；較舊版本仍可從 text content 與 structured metadata 取得 URL。

Presigned URL 是 bearer token，任何取得完整 URL 的人都能在到期前重複讀取該圖片，因此不可寫入 log 或分享給非預期接收者。R2 presigned URL 不支援 custom domain。

## 部署與設定

R2 暫存下載設定、Cloudflare Access 與 Managed OAuth 設定，以及在 ChatGPT 建立 connector 的步驟，請參考 [docs/deployment.md](docs/deployment.md)。

## Development

需求：Node.js 22+、已啟用 Browser Run 的 Cloudflare 帳號，以及完成登入的 Wrangler CLI。

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
