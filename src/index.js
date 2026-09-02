import { createMcpHandler } from 'agents/mcp/server';
import { authenticateAccessRequest } from './auth.js';
import { RENDER_PATH_PREFIX } from './constants.js';
import { createServer } from './mcp-server.js';
import { serveStoredRender } from './render-route.js';

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
