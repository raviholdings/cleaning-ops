export const NAVER_INDEX_CLASSIFIER_VERSION = 'semantic-post-path-v2';

const ROOT_STATIC_HTML_STEMS = new Set([
	'404',
	'about',
	'contact',
	'formm-submit',
	'gallery',
	'index',
	'notice',
	'privacy',
	'privacy-policy',
	'terms',
	'terms-of-service'
]);

export function classifyUrls(urls) {
	const posts = new Set();
	const staticUrls = new Set();

	for (const value of urls) {
		try {
			const url = new URL(value);
			const post = indexedPostUrl(url);
			if (post) {
				posts.add(post);
			} else if (!isIgnoredStaticPath(url.pathname)) {
				staticUrls.add(`${url.origin}${url.pathname}`);
			}
		} catch {
			// Ignore malformed URLs.
		}
	}

	return { posts, staticUrls };
}

export function indexedPostUrl(url) {
	const parsedUrl = url instanceof URL ? url : new URL(url);
	const pathname = normalizePathname(parsedUrl.pathname);
	const numericMatch = pathname.match(/^\/(\d+)(?:\.html)?\/?$/i);
	if (numericMatch) {
		const postId = Number(numericMatch[1]);
		if (postId === 404) return '';
		return pathname.toLowerCase().endsWith('.html')
			? `${parsedUrl.origin}${pathname}`
			: `${parsedUrl.origin}/${postId}/`;
	}
	if (!isSemanticPostPath(pathname)) return '';
	return `${parsedUrl.origin}${pathname}`;
}

export function postIdFromUrl(url) {
	try {
		const parsedUrl = url instanceof URL ? url : new URL(url);
		const match = parsedUrl.pathname.match(/^\/(\d+)(?:\.html)?\/?$/i);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

export function normalizePathname(pathname) {
	const normalized = String(pathname || '/').split('?')[0].replace(/\/+$/, '');
	return normalized || '/';
}

export function isSemanticPostPath(pathname) {
	if (isIgnoredStaticPath(pathname)) return false;
	const normalized = normalizePathname(pathname);
	const lower = normalized.toLowerCase();
	if (lower.includes('.') && !lower.endsWith('.html') && !lower.endsWith('.htm')) return false;

	const parts = normalized.split('/').filter(Boolean);
	const leaf = parts.at(-1) || '';
	if (parts.length === 1) {
		const rootHtmlMatch = leaf.match(/^(.+)\.html?$/i);
		if (!rootHtmlMatch) return false;
		const stem = rootHtmlMatch[1].toLowerCase();
		return stem.includes('-') && !ROOT_STATIC_HTML_STEMS.has(stem);
	}

	if (parts.length < 2) return false;
	return leaf.includes('-');
}

export function isIgnoredStaticPath(pathname) {
	const normalized = normalizePathname(pathname).toLowerCase();
	if (normalized === '/icon.svg') return true;
	if (/^\/(?:naver|google|bing|yandex)[a-z0-9_-]+\.html?$/i.test(normalized)) return true;
	if (/^\/(?:robots|sitemap)(?:-[a-z0-9_-]+)?\.(?:txt|xml)$/i.test(normalized)) return true;
	if (/^\/(?:favicon|apple-touch-icon|android-chrome|mstile)/i.test(normalized)) return true;
	return [
		'/_astro/',
		'/_next/',
		'/assets/',
		'/api/',
		'/backgrounds/',
		'/carousel/',
		'/css/',
		'/embed/',
		'/fonts/',
		'/go/',
		'/images/',
		'/img/',
		'/js/',
		'/static/'
	].some((prefix) => normalized.startsWith(prefix));
}
