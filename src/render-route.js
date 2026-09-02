import { PNG_MIME_TYPE, RENDER_PATH_PATTERN } from './constants.js';
import { getContentDisposition, getStoredRender } from './render-storage.js';

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

export async function serveStoredRender(request, env, subject) {
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
