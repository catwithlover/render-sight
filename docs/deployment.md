# Deployment & configuration

English · [繁體中文](deployment.zh-Hant.md)

This document explains how to deploy render-sight: configuring R2 staged downloads, protecting the Worker with Cloudflare Access, enabling Managed OAuth, and creating a connector in ChatGPT.

## R2 retention

`url` and `both` require the following settings:

- `BUCKET_SCREENSHOT`: the R2 binding screenshots are written to.
- `R2_BUCKET_NAME`: the name of the same bucket the binding points to, already set in `wrangler.jsonc`.
- `R2_ACCOUNT_ID`: the Cloudflare Account ID.
- `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`: R2 S3 API credentials scoped to this bucket. Since the Worker still writes through the binding, these credentials only need object read permission.

In the Dashboard, create a bucket-scoped token under **R2 object storage** > **Manage API tokens** to get the Access Key ID and Secret Access Key, then set the deployment-specific values as Worker secrets:

```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

For local development, write the same names into a `.dev.vars` file that is not committed to version control. When any signing setting is missing, `url` returns a tool error, and `both` degrades to `inline` when the image is under the inline cap.

Objects use the `renders/` prefix. Presigned URLs only restrict access time and do not delete objects; physical deletion in R2 still requires a lifecycle rule configured in the Dashboard:

1. Go to **R2 object storage** and select the `render-sight` bucket.
2. Open **Settings** > **Object Lifecycle Rules** and choose **Add rule**.
3. Set the prefix to `renders/` and configure deletion 1 day after object creation.
4. Save the rule.

R2 lifecycle typically completes physical deletion within 24 hours after `x-amz-expiration`; even if objects have not been cleared yet, R2 rejects the URL after the `expiresAt` in the presigned signature. The original Access-protected `/renders/{renderId}.png` path is kept for existing links and MCP `resources/read`, and checks owner and expiry from object metadata.

## Authentication

This Worker is protected by Cloudflare Access Managed OAuth and does not use `workers-oauth-provider`. Authentication happens in two stages:

```text
ChatGPT -- opaque OAuth access token --> Cloudflare Access
Cloudflare Access -- Cf-Access-Jwt-Assertion --> Worker
```

ChatGPT cannot parse the opaque token issued by Managed OAuth. Cloudflare Access verifies the token, the user identity, and the Access Policy, then passes the signed JWT assertion to the Worker. The Worker verifies the assertion's RS256 signature, issuer, audience, subject, and validity period before handing the request to the MCP handler.

Every successfully authenticated request writes a structured Worker log containing the Access assertion's `email` (recorded as `user`), `sub`, HTTP method, and path; the JWT itself is never written to logs.

The deployment environment requires the following non-secret environment variables:

- `TEAM_DOMAIN`: the Cloudflare One team domain, e.g. `https://<team-name>.cloudflareaccess.com`.
- `POLICY_AUD`: the Access Application Audience (AUD) tag protecting this MCP server.

The values in `wrangler.jsonc` are placeholders only. At deploy time, override them with same-named secrets (secrets take precedence over vars), so real values never need to be committed to version control:

```bash
npx wrangler secret put TEAM_DOMAIN
npx wrangler secret put POLICY_AUD
```

When configuration is missing, the assertion is absent, or JWT verification fails, the request never reaches the MCP handler. Only R2 presigned URLs returned by the render tool can be read directly without OAuth within their 24-hour validity.

### 1. Protect the Worker with Access

1. In the Cloudflare dashboard, go to **Workers & Pages** and select `render-sight`.
2. Open **Access** and choose to protect this Worker.
3. Set the destination to the Worker `render-sight`, with types covering the Worker's production and preview URLs.
4. Add an Access Allow Policy that only allows company members to sign in.
5. Confirm **Domains & Routes** includes the custom domain, e.g. `render-sight.example.com`.

The Worker destination automatically protects the Worker's Custom Domains, routes, `workers.dev` hostname, and previews; there is no need to create a separate hostname-based Access Application.

### 2. Enable Managed OAuth

1. Go to **Zero Trust** > **Access controls** > **Applications**.
2. Open `render-sight - Cloudflare Workers`, then go to **Other settings** > **OAuth**.
3. Enable **Managed OAuth**.
4. In Allowed redirect URIs, first add the full production redirect URI shown by ChatGPT. If you use callback-specific redirects, you can also add:

```text
https://chatgpt.com/connector/oauth/*
```

If ChatGPT uses a stable redirect, also add:

```text
https://chatgpt.com/connector_platform_oauth_redirect
```

`/*` only allows different callback IDs under `chatgpt.com/connector/oauth/`. If you can obtain the exact callback URI, using the precise value is stricter. ChatGPT does not need localhost or `127.0.0.1` callbacks; unless you also test with a local MCP client, you can turn off both of these allow settings.

Keep the Access token lifetime short, e.g. 5 to 15 minutes; the grant session duration can be set to one to several weeks according to company policy. Access re-evaluates the Access Policy when refresh tokens are exchanged for access tokens.

### 3. Create the ChatGPT connector

Create a custom connector in ChatGPT:

- Name: `render-sight`
- Server URL: `https://render-sight.example.com/mcp`
- Authentication: OAuth
- Client registration: Dynamic Client Registration (DCR)
- Base scopes: leave empty
- Default scopes: leave empty
- OAuth endpoints: use automatic discovery, do not override manually

Cloudflare Managed OAuth metadata does not declare custom scopes, so this service leaves authorization to the Access Policy. After creating the connector, the first connection redirects to Cloudflare Access:

1. Sign in with your company identity.
2. Confirm the page shows `render-sight - Cloudflare Workers`, the client is ChatGPT, and the resource is `render-sight.example.com`.
3. Choose **Allow**.
4. Cloudflare redirects the browser back to ChatGPT, which obtains the opaque access token and starts calling MCP tools.

## Official documentation

- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [OpenAI OAuth authentication](https://developers.openai.com/plugins/build/auth)
