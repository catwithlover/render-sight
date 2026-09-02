import { MAX_INLINE_IMAGE_BYTES } from './constants.js';

export class InlineImageTooLargeError extends Error {
	constructor() {
		super('The rendered PNG exceeds the 8 MiB inline response limit. Use output "url" instead.');
		this.name = 'InlineImageTooLargeError';
	}
}

export function arrayBufferToBase64(buffer) {
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

export async function readInlineImage(body) {
	if (!body) {
		throw new Error('Browser Run returned an empty image response.');
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

export async function prepareBothImage(body) {
	if (!body) {
		throw new Error('Browser Run returned an empty image response.');
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
