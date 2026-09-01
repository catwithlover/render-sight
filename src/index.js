import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';

const MAX_VIEWPORT_DIMENSION = 4096;
const viewportDimensionSchema = z.number().int().positive().max(MAX_VIEWPORT_DIMENSION);

function createServer(env) {
	const server = new McpServer({
		name: 'hello-server',
		version: '1.0.0',
	});

	server.registerTool(
		'hello',
		{
			description: 'Return a greeting',
			inputSchema: { name: z.string().optional() },
			outputSchema: { greeting: z.string() },
		},
		async ({ name }) => {
			const greeting = `Hello, ${name ?? 'World'}!`;

			return {
				content: [{ type: 'text', text: greeting }],
				structuredContent: { greeting },
			};
		},
	);

	server.registerTool(
		'render',
		{
			description: 'Render an HTML page',
			inputSchema: {
				html: z.string(),
				width: viewportDimensionSchema.optional(),
				height: viewportDimensionSchema.optional(),
			},
			outputSchema: {
				mimeType: z.string(),
				width: viewportDimensionSchema,
				height: viewportDimensionSchema,
			},
		},
		async ({ html, width, height }) => {
			const viewport = {
				width: width ?? 800,
				height: height ?? 800,
			};

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
					html,
					viewport,
					screenshotOptions: {
						encoding: 'base64',
						omitBackground: false,
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

				const dataUri = await response.text();
				const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri);

				if (!match) {
					return {
						content: [
							{
								type: 'text',
								text: 'Rendering failed: Browser Rendering returned an unexpected response.',
							},
						],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: 'image',
							data: match[2],
							mimeType: match[1],
						},
					],
					structuredContent: {
						mimeType: match[1],
						width: viewport.width,
						height: viewport.height,
					},
				};
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
	fetch(request, env, ctx) {
		return createMcpHandler(() => createServer(env))(request, env, ctx);
	},
};
