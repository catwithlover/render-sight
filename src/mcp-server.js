import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import pkg from '../package.json';
import {
	DEFAULT_RENDER_WAIT_TIMEOUT_MS,
	MAX_INLINE_IMAGE_BYTES,
	MAX_RENDER_SETTLE_TIME_MS,
	MAX_RENDER_WAIT_TIMEOUT_MS,
	MAX_VIEWPORT_DIMENSION,
	PNG_MIME_TYPE,
	RENDER_ID_PATTERN,
	RENDER_PATH_PREFIX,
	RESOURCE_LINK_MIN_PROTOCOL_VERSION,
} from './constants.js';
import { arrayBufferToBase64, prepareBothImage, readInlineImage } from './image-streams.js';
import { createRenderReadinessOptions } from './render-readiness.js';
import { getStoredRender, storeRenderedImage } from './render-storage.js';

const viewportDimensionSchema = z.number().int().positive().max(MAX_VIEWPORT_DIMENSION);
const renderOutputSchema = z.enum(['inline', 'url', 'both']);
const renderFilenameSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[^"\\/\x00-\x1f\x7f]+$/, 'filename must not contain path separators, quotes, or control characters');
const renderWaitForSelectorSchema = z
	.object({
		selector: z.string().trim().min(1).max(500).describe('CSS selector that indicates when page-specific content is ready.'),
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
	})
	.describe('Optional page-specific readiness condition evaluated before fonts and repaint settle.');

function supportsResourceLinks(protocolVersion) {
	return typeof protocolVersion === 'string' && protocolVersion >= RESOURCE_LINK_MIN_PROTOCOL_VERSION;
}

function getRenderFilename(filename) {
	const value = filename ?? 'render.png';
	return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
}

function createStoredRenderResult({ output, storedRender, filename, viewport, imageData, warning, includeResourceLink }) {
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

export function createServer(env, { origin, subject, protocolVersion }) {
	const server = new McpServer({
		name: pkg.name,
		version: pkg.version,
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
						'Complete HTML document or fragment to render. External stylesheets, images, and fonts must be accessible from Cloudflare Browser Run.',
					),
				width: viewportDimensionSchema.optional().describe('Viewport width in CSS pixels from 1 to 4096. Defaults to 800.'),
				height: viewportDimensionSchema.optional().describe('Viewport height in CSS pixels from 1 to 4096. Defaults to 800.'),
				omitBackground: z.boolean().optional().describe('Use a transparent background instead of the default page background.'),
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
		async ({ html, width, height, omitBackground, waitForFonts, waitForSelector, waitForTimeout, output, filename }) => {
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
					throw new Error('Browser Run returned an empty response.');
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
						content: [{ type: 'image', data: arrayBufferToBase64(bytes), mimeType: PNG_MIME_TYPE }],
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
