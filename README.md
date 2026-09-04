<div align="center">
  <img src="docs/assets/repo-logo.svg" alt="RenderSight" width="180" />
  <h1>RenderSight</h1>
  <p><em>Let ChatGPT see the web pages it builds — an MCP screenshot service deployed on Cloudflare Workers</em></p>
  <p><a href="https://catwithlover.github.io/render-sight/"><strong>Website</strong></a></p>
  <p>English · <a href="README.zh-Hant.md" lang="zh-Hant">繁體中文</a></p>
</div>

**RenderSight** is a stateless MCP server deployed on Cloudflare Workers that lets ChatGPT present, inspect, and screenshot the web pages its agent creates and edits inside its own execution environment.

## Why this service exists

ChatGPT's chat and work environments ship with a built-in cloud browser, but that browser runs in an environment isolated from the agent: after the agent produces or modifies HTML, CSS, and JavaScript in its own execution environment, it has no way to hand those results to that browser to load, so it can't present, inspect, or screenshot the pages it built — the agent can't see its own work and can only edit blind.

This service fills that gap over MCP: the agent hands page content to the `render` tool, and Cloudflare Browser Run (formerly Browser Rendering) renders it in the cloud and returns a PNG screenshot. From then on, the agent can "see" the pages it writes and iterate on them, for example:

- Visually inspect generated landing pages, email templates, or report layouts.
- Iterate on UI with a screenshot → inspect → fix → screenshot loop.
- Wrap rendering results into temporary links for sharing.

## How it works

```text
ChatGPT ──Managed OAuth──▶ MCP server (Cloudflare Workers)
                              ├─▶ Browser Run: renders HTML, waits for content and webfonts to be ready, captures a screenshot
                              └─▶ R2: stages the PNG, returns a presigned download URL valid for 24 hours
```

- The Worker is protected by Cloudflare Access Managed OAuth; only users passing the Access Policy can connect.
- Screenshots can be returned inline as MCP image content, stored in R2 with a temporary download URL, or both at once.

## Tools

### render

Renders HTML to a PNG image, returned as an inline image, a temporary download URL, or both.

Parameters:

| Parameter         | Description                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `html`            | Required. The HTML to render.                                                                                                    |
| `width`, `height` | Viewport size, default `800x800`, each clamped to `1`–`4096` pixels.                                                             |
| `omitBackground`  | Whether to use a transparent background, default `false`.                                                                        |
| `waitForFonts`    | Waits for `document.fonts.ready` and two repaints before capture, default `true`.                                                |
| `waitForSelector` | Optional readiness condition: a CSS `selector`, an `attached \| visible \| hidden` state, and a 30-second readiness time budget. |
| `waitForTimeout`  | Extra fixed wait after readiness completes, `0`–`10000` ms, default `0`.                                                         |
| `output`          | `inline`, `url`, or `both`, default `both`.                                                                                      |
| `filename`        | Filename shown on download; `.png` is appended automatically if missing.                                                         |

The service injects an internal readiness marker script into the supplied HTML — right after the doctype, before the rest of the document markup and any CSP meta. It then waits, in order, for the specified selector, webfonts, an extra delay, and two animation frames before capturing. When a wait condition times out, a tool error is returned instead of continuing with an unfinished page. Example with a loading overlay:

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

Waiting only removes loading races. If a font URL fails due to CORS, permission, or network errors, switch to a publicly accessible self-hosted font, or embed the WOFF2 directly into the HTML.

Output modes:

| Mode     | Behavior                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline` | Returns MCP image content; nothing is written to R2.                                                                                                                                                                              |
| `url`    | Streams the Browser Run response body straight to R2 and returns only a text presigned URL and resource metadata.                                                                                                                 |
| `both`   | Returns both MCP image content and a temporary presigned URL. When under the inline cap, R2 write or signing failures degrade to `inline`; when the image exceeds the inline cap and the R2 write succeeds, it degrades to `url`. |

Every successful result carries `output`, `filename`, `mimeType`, `width`, `height`, and `byteLength` structured metadata. Stored results additionally include `renderId`, `downloadUrl`, and `expiresAt`.

To stay under the Workers 128 MB isolate memory limit, `inline` and `resources/read` encode at most 8 MiB. Pure `inline` images over the cap return a tool error; `both` keeps the download URL and switches back to `output: "url"` when the R2 write succeeds, and returns a tool error if R2 cannot be written either.

The temporary URL is an R2 S3 presigned URL that only allows reading a single object and is valid for 24 hours. It hits `<ACCOUNT_ID>.r2.cloudflarestorage.com` directly, so the agent doesn't need to go through Cloudflare Access or OAuth again when reading the image. MCP `2025-06-18` and above also receive `resource_link` content; older versions can still get the URL from the text content and structured metadata.

Presigned URLs are bearer tokens: anyone holding the full URL can read the image repeatedly until it expires, so never write it into logs or share it with unintended recipients. R2 presigned URLs do not support custom domains.

## Deployment & configuration

For R2 temporary download configuration, Cloudflare Access and Managed OAuth setup, and the steps to create a connector in ChatGPT, see [docs/deployment.md](docs/deployment.md).

## Development

Requirements: Node.js 22+, a Cloudflare account with Browser Run enabled, and a logged-in Wrangler CLI.

```bash
npm install
npm run dev
```

The local MCP endpoint is `http://localhost:8787/mcp`.

Direct local calls don't go through Cloudflare Access, so they return `403` when the assertion is missing. Tests sign JWTs with a temporary RSA key pair and mock the JWKS endpoint; no Cloudflare connection is needed.

```bash
npm test -- --run
npm run deploy
```
