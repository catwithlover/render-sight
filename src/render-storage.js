import { AwsClient } from 'aws4fetch';
import { PNG_MIME_TYPE, RENDER_TTL_MS, RENDER_TTL_SECONDS } from './constants.js';

export function getContentDisposition(filename) {
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

export async function storeRenderedImage(env, value, { subject, filename }) {
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

export async function getStoredRender(env, renderId, subject) {
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
