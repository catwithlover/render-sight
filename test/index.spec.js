import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';

const TEST_TEAM_DOMAIN = 'https://test.cloudflareaccess.com';
const TEST_AUDIENCE = 'test-access-application-audience';
const TEST_KEY_ID = 'test-access-key';
const TEST_R2_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const TEST_R2_BUCKET_NAME = 'test-screenshots';
const TEST_R2_ACCESS_KEY_ID = 'test-r2-access-key';
const TEST_R2_SECRET_ACCESS_KEY = 'test-r2-secret-key';
const TEST_R2_SIGNING_ENV = {
	R2_ACCOUNT_ID: TEST_R2_ACCOUNT_ID,
	R2_BUCKET_NAME: TEST_R2_BUCKET_NAME,
	R2_ACCESS_KEY_ID: TEST_R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY: TEST_R2_SECRET_ACCESS_KEY,
};
const RENDER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_BYTES = new TextEncoder().encode('png');

let accessPrivateKey;
let validAccessJwt;
let fetchSpy;
let consoleLogSpy;

async function createAccessJwt({
	audience = TEST_AUDIENCE,
	issuer = TEST_TEAM_DOMAIN,
	subject = 'employee-id',
} = {}) {
	const jwt = new SignJWT({ email: 'employee@example.com' })
		.setProtectedHeader({ alg: 'RS256', kid: TEST_KEY_ID })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt()
		.setExpirationTime('5m');

	if (subject !== null) {
		jwt.setSubject(subject);
	}

	return jwt.sign(accessPrivateKey);
}

function createPngResponse() {
	return new Response(PNG_BYTES.slice(), { headers: { 'content-type': 'image/png' } });
}

function createR2Object(record, includeBody) {
	const object = {
		key: record.key,
		version: 'test-version',
		size: record.bytes.byteLength,
		etag: 'test-etag',
		httpEtag: '"test-etag"',
		uploaded: record.uploaded,
		httpMetadata: record.httpMetadata,
		customMetadata: record.customMetadata,
		storageClass: 'Standard',
		writeHttpMetadata(headers) {
			if (record.httpMetadata.contentType) {
				headers.set('content-type', record.httpMetadata.contentType);
			}
			if (record.httpMetadata.contentDisposition) {
				headers.set('content-disposition', record.httpMetadata.contentDisposition);
			}
			if (record.httpMetadata.cacheControl) {
				headers.set('cache-control', record.httpMetadata.cacheControl);
			}
		},
	};

	if (!includeBody) {
		return object;
	}

	return {
		...object,
		body: new Response(record.bytes.slice()).body,
		arrayBuffer: async () => record.bytes.slice().buffer,
	};
}

function createR2Bucket() {
	const objects = new Map();
	return {
		objects,
		put: vi.fn(async (key, value, options = {}) => {
			const bytes = new Uint8Array(await new Response(value).arrayBuffer());
			const record = {
				key,
				bytes,
				uploaded: new Date(),
				httpMetadata: options.httpMetadata ?? {},
				customMetadata: options.customMetadata ?? {},
			};
			objects.set(key, record);
			return createR2Object(record, false);
		}),
		get: vi.fn(async (key) => {
			const record = objects.get(key);
			return record ? createR2Object(record, true) : null;
		}),
	};
}

beforeAll(async () => {
	const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
	accessPrivateKey = privateKey;
	validAccessJwt = await createAccessJwt();

	const publicJwk = await exportJWK(publicKey);
	const jwks = {
		keys: [{ ...publicJwk, alg: 'RS256', kid: TEST_KEY_ID, use: 'sig' }],
	};

	fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (url === `${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`) {
			return Response.json(jwks);
		}

		throw new Error(`Unexpected fetch in test: ${url}`);
	});
});

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	consoleLogSpy.mockRestore();
});

async function sendMcpRequest(
	method,
	params,
	env = {},
	accessJwt = validAccessJwt,
	protocolVersion = '2025-06-18',
) {
	const headers = {
		host: 'localhost',
		accept: 'application/json, text/event-stream',
		'content-type': 'application/json',
	};

	if (accessJwt) {
		headers['cf-access-jwt-assertion'] = accessJwt;
	}
	if (protocolVersion) {
		headers['mcp-protocol-version'] = protocolVersion;
	}

	const request = new Request('http://localhost/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{
			TEAM_DOMAIN: TEST_TEAM_DOMAIN,
			POLICY_AUD: TEST_AUDIENCE,
			...env,
		},
		ctx,
	);
	await waitOnExecutionContext(ctx);

	const body = await response.text();
	const match = /^data: (.+)$/m.exec(body);
	return { body, response, message: match ? JSON.parse(match[1]) : undefined };
}

async function sendHttpRequest(url, env = {}, accessJwt = validAccessJwt, init = {}) {
	const headers = new Headers(init.headers);
	if (accessJwt) {
		headers.set('cf-access-jwt-assertion', accessJwt);
	}

	const request = new Request(url, { ...init, headers });
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		request,
		{
			TEAM_DOMAIN: TEST_TEAM_DOMAIN,
			POLICY_AUD: TEST_AUDIENCE,
			...env,
		},
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('Cloudflare Access authentication', () => {
	it('fails closed when authentication is not configured', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { body, response } = await sendMcpRequest(
			'tools/list',
			{},
			{ POLICY_AUD: undefined, TEAM_DOMAIN: undefined },
		);

		expect(response.status).toBe(500);
		expect(body).toBe('Authentication is not configured.');
		consoleError.mockRestore();
	});

	it('rejects requests without an Access JWT', async () => {
		const { body, response } = await sendMcpRequest('tools/list', {}, {}, null);

		expect(response.status).toBe(403);
		expect(body).toBe('Forbidden');
		expect(consoleLogSpy).not.toHaveBeenCalled();
	});

	it('logs the user and subject for an authenticated request', async () => {
		const { response } = await sendMcpRequest('tools/list', {});

		expect(response.status).toBe(200);
		expect(consoleLogSpy).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({
				message: 'Authenticated request',
				user: 'employee@example.com',
				sub: 'employee-id',
				method: 'POST',
				path: '/mcp',
			}),
		);
	});

	it('rejects a tampered Access JWT before invoking a tool', async () => {
		const quickAction = vi.fn();
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const [header, payload, signature] = validAccessJwt.split('.');
		const replacement = signature[0] === 'A' ? 'B' : 'A';
		const tamperedJwt = `${header}.${payload}.${replacement}${signature.slice(1)}`;
		const { body, response } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>' },
			},
			{ BROWSER: { quickAction } },
			tamperedJwt,
		);

		expect(response.status).toBe(403);
		expect(body).toBe('Forbidden');
		expect(quickAction).not.toHaveBeenCalled();
		consoleWarn.mockRestore();
	});

	it('rejects an Access JWT for a different application', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const token = await createAccessJwt({ audience: 'different-application' });
		const { response } = await sendMcpRequest('tools/list', {}, {}, token);

		expect(response.status).toBe(403);
		consoleWarn.mockRestore();
	});

	it('rejects an Access JWT without a subject', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const token = await createAccessJwt({ subject: null });
		const { response } = await sendMcpRequest('tools/list', {}, {}, token);

		expect(response.status).toBe(403);
		consoleWarn.mockRestore();
	});
});

describe('render tool', () => {
	it('advertises input and output schemas', async () => {
		const { response, message } = await sendMcpRequest('tools/list', {});
		const renderTool = message.result.tools.find(({ name }) => name === 'render');

		expect(response.status).toBe(200);
		expect(message.result.tools.map(({ name }) => name)).toEqual(['render']);
		expect(renderTool.description).toContain('temporary R2 presigned URL');
		expect(renderTool.inputSchema.properties.width.maximum).toBe(4096);
		expect(renderTool.inputSchema.properties.height.maximum).toBe(4096);
		expect(renderTool.inputSchema.properties.omitBackground.type).toBe('boolean');
		expect(renderTool.inputSchema.properties.waitForFonts).toMatchObject({
			type: 'boolean',
			default: true,
		});
		expect(renderTool.inputSchema.properties.waitForSelector.properties).toMatchObject({
			selector: { type: 'string', minLength: 1, maxLength: 500 },
			state: { type: 'string', enum: ['attached', 'visible', 'hidden'], default: 'visible' },
			timeout: { type: 'integer', maximum: 30000, default: 15000 },
		});
		expect(renderTool.inputSchema.properties.waitForTimeout).toMatchObject({
			type: 'integer',
			minimum: 0,
			maximum: 10000,
			default: 0,
		});
		expect(renderTool.inputSchema.properties.output).toMatchObject({
			type: 'string',
			enum: ['inline', 'url', 'both'],
			default: 'both',
		});
		expect(renderTool.inputSchema.properties.output.description).toContain('accessible without OAuth');
		expect(renderTool.inputSchema.properties.output.description).toContain('bearer token');
		expect(renderTool.outputSchema.properties).toMatchObject({
			output: { type: 'string', enum: ['inline', 'url', 'both'] },
			filename: { type: 'string' },
			mimeType: { type: 'string' },
			width: { type: 'integer', maximum: 4096 },
			height: { type: 'integer', maximum: 4096 },
			byteLength: { type: 'integer', minimum: 0 },
			downloadUrl: { type: 'string' },
			expiresAt: { type: 'string' },
		});
	});

	it('rejects oversized dimensions without invoking Browser Run', async () => {
		const quickAction = vi.fn();
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', width: 4097, height: 800 },
			},
			{ BROWSER: { quickAction } },
		);

		expect(message.result.isError).toBe(true);
		expect(message.result.content[0].text).toContain('<=4096');
		expect(quickAction).not.toHaveBeenCalled();
	});

	it('returns image metadata without duplicating the image data', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: {
					html: '<p>test</p>',
					width: 1200,
					omitBackground: true,
					output: 'inline',
				},
			},
			{ BROWSER: { quickAction } },
		);

		expect(message.result.content).toEqual([{ type: 'image', data: 'cG5n', mimeType: 'image/png' }]);
		expect(message.result.structuredContent).toEqual({
			output: 'inline',
			filename: 'render.png',
			mimeType: 'image/png',
			width: 1200,
			height: 800,
			byteLength: 3,
		});
		expect(message.result.structuredContent).not.toHaveProperty('data');
		expect(quickAction).toHaveBeenCalledWith(
			'screenshot',
			expect.objectContaining({
				html: expect.stringContaining('<p>test</p>'),
				viewport: { width: 1200, height: 800 },
				bestAttempt: false,
				gotoOptions: { waitUntil: 'load' },
				waitForSelector: {
					selector: expect.stringMatching(/^html\[data-mcp-render-ready="[0-9a-f-]{36}"\]$/),
					timeout: 16000,
				},
				actionTimeout: 21000,
				screenshotOptions: { omitBackground: true, type: 'png' },
			}),
		);
		const renderedHtml = quickAction.mock.calls[0][1].html;
		expect(renderedHtml).toContain('document.fonts.ready');
		expect(renderedHtml).toContain('requestAnimationFrame');
		expect(renderedHtml).toContain('"waitForFonts":true');
		expect(renderedHtml).toContain("!['hidden', 'collapse'].includes(style.visibility)");
		expect(quickAction.mock.calls[0][1]).not.toHaveProperty('addScriptTag');
		expect(quickAction.mock.calls[0][1]).not.toHaveProperty('waitForTimeout');
	});

	it('waits for a requested selector, fonts, and an additional settle delay', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: {
					html: '<div id="loading-overlay"></div>',
					waitForSelector: {
						selector: '#loading-overlay',
						state: 'hidden',
						timeout: 7000,
					},
					waitForTimeout: 250,
					output: 'inline',
				},
			},
			{ BROWSER: { quickAction } },
		);

		const screenshotOptions = quickAction.mock.calls[0][1];
		expect(screenshotOptions.waitForSelector).toMatchObject({ timeout: 8250 });
		expect(screenshotOptions.waitForSelector.selector).toMatch(
			/^html\[data-mcp-render-ready="[0-9a-f-]{36}"\]$/,
		);
		expect(screenshotOptions).not.toHaveProperty('waitForTimeout');
		expect(screenshotOptions.actionTimeout).toBe(13250);
		expect(screenshotOptions.html).toContain(
			'"selector":"#loading-overlay","state":"hidden","waitForFonts":true,"waitForTimeout":250',
		);
	});

	it('injects its readiness script after the doctype and before an HTML CSP meta tag', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const html = `<!-- <head> --><!doctype html><html><head data-note="a>b"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head><body>test</body></html>`;
		await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html, output: 'inline' },
			},
			{ BROWSER: { quickAction } },
		);

		const renderedHtml = quickAction.mock.calls[0][1].html;
		expect(renderedHtml).toMatch(/^<!-- <head> --><!doctype html><script>/i);
		expect(renderedHtml.indexOf('<script>')).toBeLessThan(renderedHtml.indexOf('<meta'));
		expect(renderedHtml).toContain("addEventListener('load'");
	});

	it('escapes selector markup before embedding it in the readiness script', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: {
					html: '<div>test</div>',
					waitForFonts: false,
					waitForSelector: { selector: '[data-x="<!--<script>"]', state: 'attached' },
					output: 'inline',
				},
			},
			{ BROWSER: { quickAction } },
		);

		const renderedHtml = quickAction.mock.calls[0][1].html;
		expect(renderedHtml).not.toContain('<!--<script>');
		expect(renderedHtml).toContain('\\u003c!--\\u003cscript>');
		expect(renderedHtml).toContain('</script><div>test</div>');
	});

	it('can disable font readiness waiting', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', waitForFonts: false, output: 'inline' },
			},
			{ BROWSER: { quickAction } },
		);

		const screenshotOptions = quickAction.mock.calls[0][1];
		expect(screenshotOptions).not.toHaveProperty('addScriptTag');
		expect(screenshotOptions).not.toHaveProperty('waitForSelector');
		expect(screenshotOptions).not.toHaveProperty('waitForTimeout');
		expect(screenshotOptions).not.toHaveProperty('actionTimeout');
	});

	it('defaults to both and returns an inline image plus a temporary download resource', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const bucket = createR2Bucket();
		const startedAt = Date.now();
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', width: 1200, filename: 'preview' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);
		const finishedAt = Date.now();
		const structured = message.result.structuredContent;
		const resourceLink = message.result.content.find(({ type }) => type === 'resource_link');

		expect(message.result.content.map(({ type }) => type)).toEqual(['text', 'image', 'resource_link']);
		expect(message.result.content.find(({ type }) => type === 'image')).toEqual({
			type: 'image',
			data: 'cG5n',
			mimeType: 'image/png',
		});
		expect(structured).toMatchObject({
			output: 'both',
			filename: 'preview.png',
			mimeType: 'image/png',
			width: 1200,
			height: 800,
			byteLength: 3,
		});
		expect(structured.renderId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const downloadUrl = new URL(structured.downloadUrl);
		expect(downloadUrl.origin).toBe(`https://${TEST_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
		expect(downloadUrl.pathname).toBe(`/${TEST_R2_BUCKET_NAME}/renders/${structured.renderId}.png`);
		expect(downloadUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
		expect(downloadUrl.searchParams.get('X-Amz-Credential')).toMatch(new RegExp(`^${TEST_R2_ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request$`));
		expect(downloadUrl.searchParams.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/);
		expect(downloadUrl.searchParams.get('X-Amz-Expires')).toBe('86400');
		expect(downloadUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
		expect(downloadUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
		expect(structured.downloadUrl).not.toContain(TEST_R2_SECRET_ACCESS_KEY);
		expect(Date.parse(structured.expiresAt)).toBeGreaterThanOrEqual(startedAt + RENDER_TTL_MS - 1000);
		expect(Date.parse(structured.expiresAt)).toBeLessThanOrEqual(finishedAt + RENDER_TTL_MS);
		expect(resourceLink).toEqual({
			type: 'resource_link',
			uri: structured.downloadUrl,
			name: 'preview.png',
			description: `Rendered PNG image; available until ${structured.expiresAt}`,
			mimeType: 'image/png',
			size: 3,
		});

		const [[key, value, options]] = bucket.put.mock.calls;
		expect(key).toBe(`renders/${structured.renderId}.png`);
		expect(value).toBeInstanceOf(ArrayBuffer);
		expect(options).toMatchObject({
			httpMetadata: {
				contentType: 'image/png',
				contentDisposition: 'inline; filename="preview.png"',
				cacheControl: 'private, no-store',
			},
			customMetadata: {
				ownerSubject: 'employee-id',
				expiresAt: structured.expiresAt,
				filename: 'preview.png',
			},
		});
	});

	it('returns only a link and resource metadata in url mode', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const bucket = createR2Bucket();
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', output: 'url' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);

		expect(message.result.content.map(({ type }) => type)).toEqual(['text', 'resource_link']);
		expect(message.result.structuredContent).toMatchObject({
			output: 'url',
			filename: 'render.png',
			byteLength: 3,
		});
		expect(bucket.put).toHaveBeenCalledOnce();
		expect(bucket.put.mock.calls[0][1]).toBeInstanceOf(ReadableStream);
	});

	it('omits resource links for MCP versions before 2025-06-18', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const bucket = createR2Bucket();
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', output: 'url' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
			validAccessJwt,
			'2025-03-26',
		);

		expect(message.result.content.map(({ type }) => type)).toEqual(['text']);
		expect(message.result.structuredContent.downloadUrl).toMatch(
			new RegExp(`^https://${TEST_R2_ACCOUNT_ID}\\.r2\\.cloudflarestorage\\.com/`),
		);
	});

	it('fails url output before storing when presigned URL signing is not configured', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const bucket = createR2Bucket();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', output: 'url' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket },
		);

		expect(message.result.isError).toBe(true);
		expect(message.result.content[0].text).toBe('Rendering failed: download storage is unavailable.');
		expect(bucket.put).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});

	it('falls back to inline output when storage fails in both mode', async () => {
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bucket = createR2Bucket();
		bucket.put.mockRejectedValueOnce(new Error('R2 unavailable'));
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);

		expect(message.result.isError).not.toBe(true);
		expect(message.result.content.map(({ type }) => type)).toEqual(['text', 'image']);
		expect(message.result.structuredContent).toMatchObject({
			output: 'inline',
			byteLength: 3,
			warning: 'The image was rendered inline, but its download URL could not be created.',
		});
		expect(message.result.structuredContent).not.toHaveProperty('downloadUrl');
		consoleWarn.mockRestore();
	});

	it('rejects images above the inline response limit without buffering them fully', async () => {
		const largeImage = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
		const quickAction = vi.fn().mockImplementation(() => new Response(largeImage.slice()));
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', output: 'inline' },
			},
			{ BROWSER: { quickAction } },
		);

		expect(message.result.isError).toBe(true);
		expect(message.result.content[0].text).toContain('exceeds the 8 MiB inline response limit');
	});

	it('stores a large image but degrades both mode to url output', async () => {
		const chunks = [
			new Uint8Array(4 * 1024 * 1024).fill(1),
			new Uint8Array(4 * 1024 * 1024).fill(2),
			new Uint8Array([3]),
			new Uint8Array([4, 5]),
		];
		const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
		const quickAction = vi.fn().mockImplementation(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							const chunk = chunks.shift();
							if (chunk) {
								controller.enqueue(chunk);
							} else {
								controller.close();
							}
						},
					}),
				),
		);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bucket = createR2Bucket();
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);

		expect(message.result.content.map(({ type }) => type)).toEqual(['text', 'text', 'resource_link']);
		expect(message.result.structuredContent).toMatchObject({
			output: 'url',
			byteLength,
			warning: 'The image is too large to return inline; use the download URL instead.',
		});
		expect(message.result.content).not.toContainEqual(expect.objectContaining({ type: 'image' }));
		const storedBytes = bucket.objects.get(`renders/${message.result.structuredContent.renderId}.png`).bytes;
		expect(storedBytes[0]).toBe(1);
		expect(storedBytes[4 * 1024 * 1024]).toBe(2);
		expect(storedBytes[MAX_INLINE_IMAGE_BYTES]).toBe(3);
		expect(Array.from(storedBytes.slice(-2))).toEqual([4, 5]);
		consoleWarn.mockRestore();
	});

	it('fails promptly when a chunked large image cannot be stored', async () => {
		const chunks = [
			new Uint8Array(4 * 1024 * 1024),
			new Uint8Array(4 * 1024 * 1024),
			new Uint8Array(1),
			new Uint8Array(1),
		];
		const quickAction = vi.fn().mockImplementation(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							const chunk = chunks.shift();
							if (chunk) {
								controller.enqueue(chunk);
							} else {
								controller.close();
							}
						},
					}),
				),
		);
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bucket = createR2Bucket();
		bucket.put.mockRejectedValueOnce(new Error('R2 unavailable'));
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>' },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);

		expect(message.result.isError).toBe(true);
		expect(message.result.content[0].text).toContain(
			'The image is too large to return inline, and its download URL could not be created.',
		);
		expect(bucket.put.mock.calls[0][1]).toBeInstanceOf(ReadableStream);
		consoleWarn.mockRestore();
	});
});

describe('stored render access', () => {
	async function createStoredRender(filename = 'result.png') {
		const bucket = createR2Bucket();
		const quickAction = vi.fn().mockImplementation(createPngResponse);
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', filename },
			},
			{ BROWSER: { quickAction }, BUCKET_SCREENSHOT: bucket, ...TEST_R2_SIGNING_ENV },
		);
		const structured = message.result.structuredContent;

		return {
			bucket,
			structured,
			authenticatedUrl: `http://localhost/renders/${structured.renderId}.png`,
		};
	}

	it('serves an unexpired image to its owner', async () => {
		const { authenticatedUrl, bucket } = await createStoredRender();
		const response = await sendHttpRequest(authenticatedUrl, { BUCKET_SCREENSHOT: bucket });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('content-length')).toBe('3');
		expect(response.headers.get('content-disposition')).toBe('inline; filename="result.png"');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
	});

	it.each([
		{
			filename: '本寶寶.png',
			expected: `inline; filename="___.png"; filename*=UTF-8''%E6%9C%AC%E5%AF%B6%E5%AF%B6.png`,
		},
		{
			filename: 'レンダー.png',
			expected: `inline; filename="____.png"; filename*=UTF-8''%E3%83%AC%E3%83%B3%E3%83%80%E3%83%BC.png`,
		},
		{
			filename: '圖片 🎨.png',
			expected: `inline; filename="__ __.png"; filename*=UTF-8''%E5%9C%96%E7%89%87%20%F0%9F%8E%A8.png`,
		},
		{
			filename: "it's (1)*.png",
			expected: `inline; filename="it's (1)*.png"`,
		},
	])('preserves a unicode filename ($filename) via RFC 5987 without breaking Headers', async ({ filename, expected }) => {
		const { authenticatedUrl, bucket, structured } = await createStoredRender(filename);

		expect(structured.filename).toBe(filename);

		const [[, , putOptions]] = bucket.put.mock.calls;
		expect(putOptions.customMetadata.filename).toBe(filename);
		const storedDisposition = putOptions.httpMetadata.contentDisposition;
		expect(storedDisposition).toBe(expected);
		expect([...storedDisposition].every((char) => char.charCodeAt(0) <= 255)).toBe(true);

		const response = await sendHttpRequest(authenticatedUrl, { BUCKET_SCREENSHOT: bucket });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toBe(storedDisposition);
	});

	it('does not expose an image to another Access subject', async () => {
		const { authenticatedUrl, bucket } = await createStoredRender();
		const otherUserJwt = await createAccessJwt({ subject: 'other-employee' });
		const response = await sendHttpRequest(
			authenticatedUrl,
			{ BUCKET_SCREENSHOT: bucket },
			otherUserJwt,
		);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('Not Found');
	});

	it('returns 410 after the exact application expiry', async () => {
		const { authenticatedUrl, bucket, structured } = await createStoredRender();
		const key = `renders/${structured.renderId}.png`;
		bucket.objects.get(key).customMetadata.expiresAt = new Date(Date.now() - 1).toISOString();
		const response = await sendHttpRequest(authenticatedUrl, { BUCKET_SCREENSHOT: bucket });

		expect(response.status).toBe(410);
		expect(await response.text()).toBe('Rendered image has expired.');
		expect(bucket.objects.has(key)).toBe(true);
	});

	it('reads the authenticated resource through MCP resources/read', async () => {
		const { authenticatedUrl, bucket } = await createStoredRender();
		const { message } = await sendMcpRequest(
			'resources/read',
			{ uri: authenticatedUrl },
			{ BUCKET_SCREENSHOT: bucket },
		);

		expect(message.result.contents).toEqual([
			{
				uri: authenticatedUrl,
				mimeType: 'image/png',
				blob: 'cG5n',
			},
		]);
	});

	it('rejects resources above the MCP inline resource limit', async () => {
		const { authenticatedUrl, bucket, structured } = await createStoredRender();
		const key = `renders/${structured.renderId}.png`;
		bucket.objects.get(key).bytes = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
		const { message } = await sendMcpRequest(
			'resources/read',
			{ uri: authenticatedUrl },
			{ BUCKET_SCREENSHOT: bucket },
		);

		expect(message.error.code).toBe(-32602);
		expect(message.error.message).toContain('exceeds the 8 MiB MCP resource limit');
	});
});
