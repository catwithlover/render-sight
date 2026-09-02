import { DEFAULT_RENDER_WAIT_TIMEOUT_MS, RENDER_ACTION_TIMEOUT_BUFFER_MS, RENDER_REPAINT_TIMEOUT_BUFFER_MS } from './constants.js';

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

export function createRenderReadinessOptions({ html, waitForFonts, waitForSelector, waitForTimeout }) {
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
