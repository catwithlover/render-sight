import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src';

async function sendMcpRequest(method, params, env = {}) {
	const request = new Request('http://localhost/mcp', {
		method: 'POST',
		headers: {
			host: 'localhost',
			accept: 'application/json, text/event-stream',
			'content-type': 'application/json',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	const match = /^data: (.+)$/m.exec(await response.text());
	return { response, message: match ? JSON.parse(match[1]) : undefined };
}

describe('render tool viewport limits', () => {
	it('advertises input and output schemas', async () => {
		const { response, message } = await sendMcpRequest('tools/list', {});
		const helloTool = message.result.tools.find(({ name }) => name === 'hello');
		const renderTool = message.result.tools.find(({ name }) => name === 'render');

		expect(response.status).toBe(200);
		expect(helloTool.outputSchema.properties.greeting.type).toBe('string');
		expect(renderTool.inputSchema.properties.width.maximum).toBe(4096);
		expect(renderTool.inputSchema.properties.height.maximum).toBe(4096);
		expect(renderTool.outputSchema.properties).toMatchObject({
			mimeType: { type: 'string' },
			width: { type: 'integer', maximum: 4096 },
			height: { type: 'integer', maximum: 4096 },
		});
	});

	it('returns structured greeting data', async () => {
		const { message } = await sendMcpRequest('tools/call', {
			name: 'hello',
			arguments: { name: 'Ada' },
		});

		expect(message.result.structuredContent).toEqual({ greeting: 'Hello, Ada!' });
	});

	it('rejects oversized dimensions without invoking Browser Rendering', async () => {
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
		const quickAction = vi.fn().mockResolvedValue(new Response('data:image/png;base64,cG5n'));
		const { message } = await sendMcpRequest(
			'tools/call',
			{
				name: 'render',
				arguments: { html: '<p>test</p>', width: 1200 },
			},
			{ BROWSER: { quickAction } },
		);

		expect(message.result.content).toEqual([{ type: 'image', data: 'cG5n', mimeType: 'image/png' }]);
		expect(message.result.structuredContent).toEqual({
			mimeType: 'image/png',
			width: 1200,
			height: 800,
		});
		expect(message.result.structuredContent).not.toHaveProperty('data');
	});
});
