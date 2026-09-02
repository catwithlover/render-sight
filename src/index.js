import {
	McpServer,
	ProtocolError,
	ProtocolErrorCode,
	ResourceNotFoundError,
	ResourceTemplate,
} from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { AwsClient } from 'aws4fetch';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const MAX_VIEWPORT_DIMENSION = 4096;
const PNG_MIME_TYPE = 'image/png';
const RENDER_TTL_SECONDS = 24 * 60 * 60;
const RENDER_TTL_MS = RENDER_TTL_SECONDS * 1000;
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RENDER_WAIT_TIMEOUT_MS = 15_000;
const MAX_RENDER_WAIT_TIMEOUT_MS = 30_000;
const MAX_RENDER_SETTLE_TIME_MS = 10_000;
const RENDER_REPAINT_TIMEOUT_BUFFER_MS = 1_000;
const RENDER_ACTION_TIMEOUT_BUFFER_MS = 5_000;
const RENDER_PATH_PREFIX = '/renders/';
const RESOURCE_LINK_MIN_PROTOCOL_VERSION = '2025-06-18';
const RENDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RENDER_PATH_PATTERN = /^\/renders\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.png$/;
const viewportDimensionSchema = z.number().int().positive().max(MAX_VIEWPORT_DIMENSION);
const renderOutputSchema = z.enum(['inline', 'url', 'both']);
const renderFilenameSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[^"\\/\x00-\x1f\x7f]+$/, 'filename must not contain path separators, quotes, or control characters');
const renderWaitForSelectorSchema = z.object({
	selector: z
		.string()
		.trim()
		.min(1)
		.max(500)
		.describe('CSS selector that indicates when page-specific content is ready.'),
	state: z
		.enum(['attached', 'visible', 'hidden'])
		.default('visible')
		.describe(
			'Required selector state. Use attached when presence is enough, visible for rendered content, or hidden for a loading overlay that must disappear.',
		),
	timeout: z
		.number()
		.int()
		.positive()
		.max(MAX_RENDER_WAIT_TIMEOUT_MS)
		.default(DEFAULT_RENDER_WAIT_TIMEOUT_MS)
		.describe('Maximum selector and font readiness time budget in milliseconds. Defaults to 15000.'),
}).describe('Optional page-specific readiness condition evaluated before fonts and repaint settle.');
const accessJwksByTeamDomain = new Map();

class InlineImageTooLargeError extends Error {
	constructor() {
		super('The rendered PNG exceeds the 8 MiB inline response limit. Use output "url" instead.');
		this.name = 'InlineImageTooLargeError';
	}
}

function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';

	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}

	return btoa(binary);
}

function concatenateChunks(chunks, byteLength) {
	const image = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		image.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return image.buffer;
}

async function readInlineImage(body) {
	if (!body) {
		throw new Error('Browser Rendering returned an empty image response.');
	}

	const reader = body.getReader();
	const chunks = [];
	let byteLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			byteLength += value.byteLength;
			if (byteLength > MAX_INLINE_IMAGE_BYTES) {
				await reader.cancel().catch(() => {});
				throw new InlineImageTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return concatenateChunks(chunks, byteLength);
}

function continueStream(bufferedChunks, reader) {
	let chunkIndex = 0;
	let released = false;
	const releaseReader = () => {
		if (!released) {
			released = true;
			reader.releaseLock();
		}
	};

	return new ReadableStream({
		async pull(controller) {
			if (chunkIndex < bufferedChunks.length) {
				const chunk = bufferedChunks[chunkIndex];
				bufferedChunks[chunkIndex] = undefined;
				chunkIndex += 1;
				controller.enqueue(chunk);
				return;
			}

			try {
				const { done, value } = await reader.read();
				if (done) {
					releaseReader();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				releaseReader();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				releaseReader();
			}
		},
	});
}

async function prepareBothImage(body) {
	if (!body) {
		throw new Error('Browser Rendering returned an empty image response.');
	}

	const reader = body.getReader();
	const chunks = [];
	let byteLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				const imageBuffer = concatenateChunks(chunks, byteLength);
				reader.releaseLock();
				return { imageBuffer };
			}

			chunks.push(value);
			byteLength += value.byteLength;
			if (byteLength > MAX_INLINE_IMAGE_BYTES) {
				return { storageBody: continueStream(chunks, reader) };
			}
		}
	} catch (error) {
		reader.releaseLock();
		throw error;
	}
}

function supportsResourceLinks(protocolVersion) {
	return typeof protocolVersion === 'string' && protocolVersion >= RESOURCE_LINK_MIN_PROTOCOL_VERSION;
}

function createRenderReadinessScript({ readyToken, waitForFonts, waitForSelector, waitForTimeout }) {
	const config = JSON.stringify({
		readyToken,
		selector: waitForSelector?.selector ?? null,
		state: waitForSelector?.state ?? 'attached',
		waitForFonts,
		waitForTimeout,
	}).replaceAll('<', '\\u003c');

	return `(() => {
	const config = ${config};
	const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
	const isVisible = (element) => {
		if (!element) return false;
		const style = getComputedStyle(element);
		const bounds = element.getBoundingClientRect();
		return (
			style.display !== 'none' &&
			!['hidden', 'collapse'].includes(style.visibility) &&
			bounds.width > 0 &&
			bounds.height > 0
		);
	};
	const requestedSelectorIsReady = () => {
		const element = document.querySelector(config.selector);
		if (config.state === 'hidden') return !element || !isVisible(element);
		if (config.state === 'visible') return isVisible(element);
		return Boolean(element);
	};
	const waitUntilReady = async () => {
		if (document.readyState !== 'complete') {
			await new Promise((resolve) => addEventListener('load', resolve, { once: true }));
		}
		if (config.selector) {
			while (!requestedSelectorIsReady()) await nextFrame();
		}
		if (config.waitForFonts && document.fonts) await document.fonts.ready;
		if (config.waitForTimeout > 0) {
			await new Promise((resolve) => setTimeout(resolve, config.waitForTimeout));
		}
		await nextFrame();
		await nextFrame();
		document.documentElement.setAttribute('data-mcp-render-ready', config.readyToken);
	};
	waitUntilReady().catch((error) => {
		document.documentElement.setAttribute(
			'data-mcp-render-error',
			error instanceof Error ? error.message : String(error),
		);
	});
})();`;
}

function getInitialDoctypeEnd(html) {
	let offset = html.charCodeAt(0) === 0xfeff ? 1 : 0;

	while (offset < html.length) {
		while (/\s/.test(html[offset])) offset += 1;
		if (!html.startsWith('<!--', offset)) break;

		const commentEnd = html.indexOf('-->', offset + 4);
		if (commentEnd === -1) return 0;
		offset = commentEnd + 3;
	}

	if (!/^<!doctype(?:\s|>)/i.test(html.slice(offset))) return 0;

	let quote;
	for (let index = offset; index < html.length; index += 1) {
		const character = html[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === '>') {
			return index + 1;
		}
	}

	return 0;
}

function injectRenderReadinessScript(html, script) {
	const scriptTag = `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`;
	const insertionPoint = getInitialDoctypeEnd(html);
	if (insertionPoint > 0) {
		return `${html.slice(0, insertionPoint)}${scriptTag}${html.slice(insertionPoint)}`;
	}

	return `${scriptTag}${html}`;
}

function createRenderReadinessOptions({ html, waitForFonts, waitForSelector, waitForTimeout }) {
	const options = {
		bestAttempt: false,
		gotoOptions: { waitUntil: 'load' },
		html,
	};
	const shouldWaitForReadiness = waitForFonts || Boolean(waitForSelector) || waitForTimeout > 0;
	let readinessTimeout = 0;

	if (shouldWaitForReadiness) {
		const readyToken = crypto.randomUUID();
		readinessTimeout = waitForSelector?.timeout ?? DEFAULT_RENDER_WAIT_TIMEOUT_MS;
		const readinessScript = createRenderReadinessScript({
			readyToken,
			waitForFonts,
			waitForSelector,
			waitForTimeout,
		});
		options.html = injectRenderReadinessScript(html, readinessScript);
		options.waitForSelector = {
			selector: `html[data-mcp-render-ready="${readyToken}"]`,
			timeout: readinessTimeout + waitForTimeout + RENDER_REPAINT_TIMEOUT_BUFFER_MS,
		};
		options.actionTimeout = options.waitForSelector.timeout + RENDER_ACTION_TIMEOUT_BUFFER_MS;
	}

	return options;
}

function getRenderFilename(filename) {
	const value = filename ?? 'render.png';
	return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
}

function getContentDisposition(filename) {
	const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_');
	return `inline; filename="${asciiFilename}"`;
}

function getRenderObjectKey(renderId) {
	return `renders/${renderId}.png`;
}

function getR2SigningConfig(env) {
	const accountId = typeof env.R2_ACCOUNT_ID === 'string' ? env.R2_ACCOUNT_ID.trim() : '';
	const bucketName = typeof env.R2_BUCKET_NAME === 'string' ? env.R2_BUCKET_NAME.trim() : '';
	const accessKeyId = typeof env.R2_ACCESS_KEY_ID === 'string' ? env.R2_ACCESS_KEY_ID.trim() : '';
	const secretAccessKey = typeof env.R2_SECRET_ACCESS_KEY === 'string' ? env.R2_SECRET_ACCESS_KEY.trim() : '';

	if (!/^[0-9a-f]{32}$/i.test(accountId) || !bucketName || !accessKeyId || !secretAccessKey) {
		throw new Error('R2 presigned URL signing is not configured.');
	}

	return { accountId, bucketName, accessKeyId, secretAccessKey };
}

async function createPresignedRenderUrl({ accountId, bucketName, accessKeyId, secretAccessKey }, objectKey, signedAt) {
	const objectUrl = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
	objectUrl.pathname = `/${[bucketName, ...objectKey.split('/')].map(encodeURIComponent).join('/')}`;
	objectUrl.searchParams.set('X-Amz-Expires', String(RENDER_TTL_SECONDS));

	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
	});
	const signedRequest = await signer.sign(objectUrl, {
		method: 'GET',
		aws: {
			datetime: signedAt.toISOString().replace(/[:-]|\.\d{3}/g, ''),
			signQuery: true,
		},
	});

	return signedRequest.url;
}

async function storeRenderedImage(env, value, { subject, filename }) {
	if (!env.BUCKET_SCREENSHOT || typeof env.BUCKET_SCREENSHOT.put !== 'function') {
		throw new Error('R2 screenshot storage is not configured.');
	}

	const signingConfig = getR2SigningConfig(env);
	const renderId = crypto.randomUUID();
	const objectKey = getRenderObjectKey(renderId);
	const signedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	const expiresAt = new Date(signedAt.getTime() + RENDER_TTL_MS).toISOString();
	const downloadUrl = await createPresignedRenderUrl(signingConfig, objectKey, signedAt);
	const object = await env.BUCKET_SCREENSHOT.put(objectKey, value, {
		httpMetadata: {
			contentType: PNG_MIME_TYPE,
			contentDisposition: getContentDisposition(filename),
			cacheControl: 'private, no-store',
		},
		customMetadata: {
			ownerSubject: subject,
			expiresAt,
			filename,
		},
	});

	return {
		renderId,
		downloadUrl,
		expiresAt,
		byteLength: object.size,
	};
}

async function getStoredRender(env, renderId, subject) {
	if (!env.BUCKET_SCREENSHOT || typeof env.BUCKET_SCREENSHOT.get !== 'function') {
		return { status: 'unavailable' };
	}

	const object = await env.BUCKET_SCREENSHOT.get(getRenderObjectKey(renderId));
	if (!object || object.customMetadata?.ownerSubject !== subject) {
		return { status: 'not_found' };
	}

	const expiresAt = object.customMetadata.expiresAt;
	const expirationTime = Date.parse(expiresAt);
	if (!Number.isFinite(expirationTime)) {
		return { status: 'not_found' };
	}

	if (expirationTime <= Date.now()) {
		return { status: 'expired' };
	}

	return {
		status: 'available',
		object,
		expiresAt,
		filename: object.customMetadata.filename || 'render.png',
	};
}

function createStoredRenderResult({
	output,
	storedRender,
	filename,
	viewport,
	imageData,
	warning,
	includeResourceLink,
}) {
	const content = [];
	if (warning) {
		content.push({ type: 'text', text: warning });
	}
	content.push({
		type: 'text',
		text: `Rendered PNG available until ${storedRender.expiresAt}: ${storedRender.downloadUrl}`,
	});

	if (imageData) {
		content.push({
			type: 'image',
			data: imageData,
			mimeType: PNG_MIME_TYPE,
		});
	}

	if (includeResourceLink) {
		content.push({
			type: 'resource_link',
			uri: storedRender.downloadUrl,
			name: filename,
			description: `Rendered PNG image; available until ${storedRender.expiresAt}`,
			mimeType: PNG_MIME_TYPE,
			size: storedRender.byteLength,
		});
	}

	return {
		content,
		structuredContent: {
			renderId: storedRender.renderId,
			output,
			filename,
			mimeType: PNG_MIME_TYPE,
			width: viewport.width,
			height: viewport.height,
			byteLength: storedRender.byteLength,
			downloadUrl: storedRender.downloadUrl,
			expiresAt: storedRender.expiresAt,
			...(warning ? { warning } : {}),
		},
	};
}

function renderHttpError(status, message, extraHeaders = {}) {
	return new Response(message, {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
			...extraHeaders,
		},
	});
}

async function serveStoredRender(request, env, subject) {
	if (request.method !== 'GET') {
		return renderHttpError(405, 'Method Not Allowed', { allow: 'GET' });
	}

	const renderId = RENDER_PATH_PATTERN.exec(new URL(request.url).pathname)?.[1];
	if (!renderId) {
		return renderHttpError(404, 'Not Found');
	}

	try {
		const storedRender = await getStoredRender(env, renderId, subject);
		if (storedRender.status === 'unavailable') {
			return renderHttpError(503, 'Render storage is unavailable.');
		}

		if (storedRender.status === 'expired') {
			return renderHttpError(410, 'Rendered image has expired.');
		}

		if (storedRender.status !== 'available') {
			return renderHttpError(404, 'Not Found');
		}

		const headers = new Headers();
		storedRender.object.writeHttpMetadata(headers);
		headers.set('cache-control', 'private, no-store');
		headers.set('content-disposition', getContentDisposition(storedRender.filename));
		headers.set('content-length', String(storedRender.object.size));
		headers.set('content-type', PNG_MIME_TYPE);
		headers.set('etag', storedRender.object.httpEtag);
		headers.set('x-content-type-options', 'nosniff');

		return new Response(storedRender.object.body, { status: 200, headers });
	} catch (error) {
		console.error(
			JSON.stringify({
				message: 'Failed to serve rendered image',
				error: error instanceof Error ? error.message : String(error),
				renderId,
			}),
		);
		return renderHttpError(500, 'Failed to load rendered image.');
	}
}

function getTeamDomain(value) {
	if (typeof value !== 'string') {
		return null;
	}

	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
			return null;
		}

		return url.origin;
	} catch {
		return null;
	}
}

function getAccessJwks(teamDomain) {
	let jwks = accessJwksByTeamDomain.get(teamDomain);

	if (!jwks) {
		jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain));
		accessJwksByTeamDomain.set(teamDomain, jwks);
	}

	return jwks;
}

function authenticationError(status, message) {
	return new Response(message, {
		status,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	});
}

async function authenticateAccessRequest(request, env) {
	const teamDomain = getTeamDomain(env.TEAM_DOMAIN);
	const audience = typeof env.POLICY_AUD === 'string' ? env.POLICY_AUD.trim() : '';

	if (!teamDomain || !audience) {
		console.error(JSON.stringify({ message: 'Cloudflare Access authentication is not configured' }));
		return authenticationError(500, 'Authentication is not configured.');
	}

	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) {
		return authenticationError(403, 'Forbidden');
	}

	try {
		const { payload } = await jwtVerify(token, getAccessJwks(teamDomain), {
			algorithms: ['RS256'],
			audience,
			issuer: teamDomain,
			requiredClaims: ['exp', 'sub'],
		});
		if (typeof payload.sub !== 'string' || !payload.sub) {
			throw new Error('Access JWT subject is missing.');
		}

		return {
			subject: payload.sub,
			user: typeof payload.email === 'string' && payload.email ? payload.email : null,
		};
	} catch (error) {
		console.warn(
			JSON.stringify({
				message: 'Cloudflare Access JWT validation failed',
				error: error instanceof Error ? error.name : 'UnknownError',
			}),
		);
		return authenticationError(403, 'Forbidden');
	}
}

function createServer(env, { origin, subject, protocolVersion }) {
	const server = new McpServer({
		name: 'render-sight',
		version: '1.0.0',
	});
	const includeResourceLink = supportsResourceLinks(protocolVersion);
	const renderResourceTemplate = new ResourceTemplate(`${origin}${RENDER_PATH_PREFIX}{renderId}.png`, {
		list: undefined,
	});

	server.registerResource(
		'rendered-image',
		renderResourceTemplate,
		{
			title: 'Rendered image',
			description: 'A temporary PNG image created by the render tool.',
			mimeType: PNG_MIME_TYPE,
			cacheHint: { ttlMs: 0, cacheScope: 'private' },
		},
		async (uri, variables) => {
			const renderId = typeof variables.renderId === 'string' ? variables.renderId : '';
			if (!RENDER_ID_PATTERN.test(renderId)) {
				throw new ResourceNotFoundError(uri.href);
			}

			const storedRender = await getStoredRender(env, renderId, subject);
			if (storedRender.status === 'unavailable') {
				throw new Error('Render storage is unavailable.');
			}

			if (storedRender.status !== 'available') {
				throw new ResourceNotFoundError(uri.href, 'Rendered image was not found or has expired.');
			}
			if (storedRender.object.size > MAX_INLINE_IMAGE_BYTES) {
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					'The rendered PNG exceeds the 8 MiB MCP resource limit; use its authenticated download URL instead.',
				);
			}

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: PNG_MIME_TYPE,
						blob: arrayBufferToBase64(await storedRender.object.arrayBuffer()),
					},
				],
			};
		},
	);

	server.registerTool(
		'render',
		{
			description:
				'Render an HTML page after its requested content and webfonts are ready, returning inline PNG data and/or a temporary R2 presigned URL.',
			inputSchema: {
				html: z
					.string()
					.describe(
						'Complete HTML document or fragment to render. External stylesheets, images, and fonts must be accessible from Cloudflare Browser Rendering.',
					),
				width: viewportDimensionSchema
					.optional()
					.describe('Viewport width in CSS pixels from 1 to 4096. Defaults to 800.'),
				height: viewportDimensionSchema
					.optional()
					.describe('Viewport height in CSS pixels from 1 to 4096. Defaults to 800.'),
				omitBackground: z
					.boolean()
					.optional()
					.describe('Use a transparent background instead of the default page background.'),
				waitForFonts: z
					.boolean()
					.default(true)
					.describe('Wait for document.fonts.ready and two repaint frames before taking the screenshot.'),
				waitForSelector: renderWaitForSelectorSchema.optional(),
				waitForTimeout: z
					.number()
					.int()
					.min(0)
					.max(MAX_RENDER_SETTLE_TIME_MS)
					.default(0)
					.describe('Additional settle delay in milliseconds after selector and font readiness. Defaults to 0.'),
				output: renderOutputSchema
					.default('both')
					.describe(
						'Response delivery mode: inline returns MCP image content; url stores the PNG in R2 and returns a 24-hour presigned URL accessible without OAuth; both returns both when possible. Treat the URL as a bearer token. Defaults to both.',
					),
				filename: renderFilenameSchema
					.optional()
					.describe('Filename shown for stored downloads. The .png extension is added when omitted.'),
			},
			outputSchema: {
				renderId: z.string().optional(),
				output: renderOutputSchema,
				filename: z.string(),
				mimeType: z.string(),
				width: viewportDimensionSchema,
				height: viewportDimensionSchema,
				byteLength: z.number().int().nonnegative(),
				downloadUrl: z.string().optional(),
				expiresAt: z.string().optional(),
				warning: z.string().optional(),
			},
		},
		async ({
			html,
			width,
			height,
			omitBackground,
			waitForFonts,
			waitForSelector,
			waitForTimeout,
			output,
			filename,
		}) => {
			const viewport = {
				width: width ?? 800,
				height: height ?? 800,
			};
			const resolvedFilename = getRenderFilename(filename);

			if (
				!Number.isInteger(viewport.width) ||
				viewport.width < 1 ||
				viewport.width > MAX_VIEWPORT_DIMENSION ||
				!Number.isInteger(viewport.height) ||
				viewport.height < 1 ||
				viewport.height > MAX_VIEWPORT_DIMENSION
			) {
				return {
					content: [
						{
							type: 'text',
							text: `Rendering failed: width and height must be integers between 1 and ${MAX_VIEWPORT_DIMENSION}.`,
						},
					],
					isError: true,
				};
			}

			try {
				const response = await env.BROWSER.quickAction('screenshot', {
					...createRenderReadinessOptions({ html, waitForFonts, waitForSelector, waitForTimeout }),
					viewport,
					screenshotOptions: {
						omitBackground: omitBackground ?? false,
						type: 'png',
					},
				});

				if (!response.ok) {
					return {
						content: [
							{
								type: 'text',
								text: `Rendering failed (${response.status}): ${await response.text()}`,
							},
						],
						isError: true,
					};
				}
				if (!response.body) {
					throw new Error('Browser Rendering returned an empty response.');
				}

				if (output === 'url') {
					try {
						const storedRender = await storeRenderedImage(env, response.body, {
							subject,
							filename: resolvedFilename,
						});
						return createStoredRenderResult({
							output,
							storedRender,
							filename: resolvedFilename,
							viewport,
							includeResourceLink,
						});
					} catch (error) {
						console.error(
							JSON.stringify({
								message: 'Failed to store rendered image',
								error: error instanceof Error ? error.message : String(error),
							}),
						);
						return {
							content: [{ type: 'text', text: 'Rendering failed: download storage is unavailable.' }],
							isError: true,
						};
					}
				}

				if (output === 'inline') {
					const bytes = await readInlineImage(response.body);
					return {
						content: [
							{ type: 'image', data: arrayBufferToBase64(bytes), mimeType: PNG_MIME_TYPE },
						],
						structuredContent: {
							output,
							filename: resolvedFilename,
							mimeType: PNG_MIME_TYPE,
							width: viewport.width,
							height: viewport.height,
							byteLength: bytes.byteLength,
						},
					};
				}

				const preparedImage = await prepareBothImage(response.body);
				if (preparedImage.imageBuffer) {
					try {
						const storedRender = await storeRenderedImage(env, preparedImage.imageBuffer, {
							subject,
							filename: resolvedFilename,
						});
						return createStoredRenderResult({
							output,
							storedRender,
							filename: resolvedFilename,
							viewport,
							imageData: arrayBufferToBase64(preparedImage.imageBuffer),
							includeResourceLink,
						});
					} catch (error) {
						console.warn(
							JSON.stringify({
								message: 'Failed to store rendered image; returning inline image only',
								error: error instanceof Error ? error.message : String(error),
							}),
						);
						const warning = 'The image was rendered inline, but its download URL could not be created.';
						return {
							content: [
								{ type: 'text', text: warning },
								{
									type: 'image',
									data: arrayBufferToBase64(preparedImage.imageBuffer),
									mimeType: PNG_MIME_TYPE,
								},
							],
							structuredContent: {
								output: 'inline',
								filename: resolvedFilename,
								mimeType: PNG_MIME_TYPE,
								width: viewport.width,
								height: viewport.height,
								byteLength: preparedImage.imageBuffer.byteLength,
								warning,
							},
						};
					}
				}

				try {
					const storedRender = await storeRenderedImage(env, preparedImage.storageBody, {
						subject,
						filename: resolvedFilename,
					});
					return createStoredRenderResult({
						output: 'url',
						storedRender,
						filename: resolvedFilename,
						viewport,
						warning: 'The image is too large to return inline; use the download URL instead.',
						includeResourceLink,
					});
				} catch (error) {
					await preparedImage.storageBody.cancel(error).catch(() => {});
					console.warn(
						JSON.stringify({
							message: 'Failed to store oversized rendered image',
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					throw new Error('The image is too large to return inline, and its download URL could not be created.');
				}
			} catch (error) {
				return {
					content: [
						{
							type: 'text',
							text: `Rendering failed: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	return server;
}

export default {
	async fetch(request, env, ctx) {
		const authentication = await authenticateAccessRequest(request, env);
		if (authentication instanceof Response) {
			return authentication;
		}

		const url = new URL(request.url);
		console.log(
			JSON.stringify({
				message: 'Authenticated request',
				user: authentication.user,
				sub: authentication.subject,
				method: request.method,
				path: url.pathname,
			}),
		);
		if (url.pathname.startsWith(RENDER_PATH_PREFIX)) {
			return serveStoredRender(request, env, authentication.subject);
		}

		return createMcpHandler(() =>
			createServer(env, {
				origin: url.origin,
				subject: authentication.subject,
				protocolVersion: request.headers.get('mcp-protocol-version'),
			}),
		)(request, env, ctx);
	},
};
