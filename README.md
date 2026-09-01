# mcp-test

以 Cloudflare Workers 與 Browser Rendering 建立的無狀態 MCP server。

## Tools

- `hello`：回傳問候文字。
- `render`：將 HTML 渲染為 PNG 圖片；viewport 預設為 `800x800`，寬高皆限制在 `1` 到 `4096` pixels。

`render` 的圖片以 MCP image content 回傳，並提供 `mimeType`、`width`、`height` structured metadata。

## Development

需求：Node.js 22+、已啟用 Browser Rendering 的 Cloudflare 帳號，以及完成登入的 Wrangler CLI。

```bash
npm install
npm run dev
```

本機 MCP endpoint 為 `http://localhost:8787/mcp`。

```bash
npm test -- --run
npm run deploy
```