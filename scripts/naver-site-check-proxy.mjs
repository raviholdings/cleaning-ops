import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

export async function createSiteCheckHttpClient({
	projectRoot,
	proxyFileEnvNames = [],
	enabledEnvNames = [],
	timeoutMs = 15000
}) {
	const enabledValue = firstEnv([...enabledEnvNames, 'NAVER_SITE_CHECK_PROXY_ENABLED']);
	const proxyFileValue = firstEnv([...proxyFileEnvNames, 'NAVER_SITE_CHECK_PROXY_FILE']);
	const webshareApiKey = firstEnv([
		'NAVER_SITE_CHECK_WEBSHARE_API_KEY',
		'NAVER_INDEX_WEBSHARE_API_KEY',
		'WEBSHARE_API_KEY'
	]);
	const webshareEnabled = firstEnv(['NAVER_SITE_CHECK_WEBSHARE_ENABLED', 'NAVER_INDEX_WEBSHARE_ENABLED']);
	const requireProxy = firstEnv(['NAVER_SITE_CHECK_PROXY_REQUIRE', 'NAVER_INDEX_PROXY_REQUIRE']) === '1';
	const nativeFetch = globalThis.fetch.bind(globalThis);

	if (enabledValue === '0') {
		return {
			enabled: false,
			proxyCount: 0,
			proxyFile: '',
			proxySource: 'disabled',
			fetch: nativeFetch
		};
	}

	if ((webshareEnabled === '0' && !proxyFileValue) || (!webshareApiKey && !proxyFileValue)) {
		if (requireProxy) throw new Error('NAVER_SITE_CHECK_PROXY_REQUIRE=1 but no proxy source is configured.');
		return {
			enabled: false,
			proxyCount: 0,
			proxyFile: '',
			proxySource: 'disabled',
			fetch: nativeFetch
		};
	}

	let proxyFile = '';
	let proxySource = '';
	let proxies = [];
	if (webshareApiKey && webshareEnabled !== '0') {
		try {
			proxies = await loadWebshareProxies(webshareApiKey, timeoutMs);
			proxySource = 'webshare-api';
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[site-check-proxy] failed to load Webshare proxies from API: ${message}`);
			if (process.env.NAVER_SITE_CHECK_WEBSHARE_FALLBACK_TO_FILE === '0') throw error;
		}
	}

	if (proxies.length === 0 && proxyFileValue) {
		proxyFile = resolve(projectRoot, proxyFileValue);
		proxies = existsSync(proxyFile) ? loadProxies(proxyFile) : [];
		proxySource = 'file';
	}

	if (proxies.length === 0) {
		const proxyTarget = webshareApiKey && webshareEnabled !== '0' ? 'Webshare API' : proxyFile;
		console.warn(`[site-check-proxy] proxy source is empty or missing: ${proxyTarget}`);
		if (requireProxy) throw new Error(`NAVER_SITE_CHECK_PROXY_REQUIRE=1 but no proxies were loaded from ${proxyTarget}.`);
		return {
			enabled: false,
			proxyCount: 0,
			proxyFile,
			proxySource: proxySource || 'empty',
			fetch: nativeFetch
		};
	}

	const proxyTotalCount = proxies.length;
	const activeLimit = activeProxyLimit(proxyTotalCount);
	const reserveProxies = proxies.slice(activeLimit);
	proxies = proxies.slice(0, activeLimit);
	let nextProxyIndex = 0;
	const badProxyIndexes = new Set();
	const maxProxyAttempts = Math.max(1, Math.min(proxies.length, numberEnv('NAVER_SITE_CHECK_PROXY_MAX_ATTEMPTS', 8)));
	const retireProxy = (index, reason) => {
		const oldProxy = proxies[index];
		if (!oldProxy) return false;
		const replacement = reserveProxies.shift();
		if (replacement) {
			proxies[index] = replacement;
			badProxyIndexes.delete(index);
			console.warn(`[site-check-proxy] retired proxy=${oldProxy.id} reason=${reason}; promoted=${replacement.id} active=${proxies.length} reserve=${reserveProxies.length}`);
			return true;
		}
		badProxyIndexes.add(index);
		console.warn(`[site-check-proxy] marked bad proxy=${oldProxy.id} reason=${reason}; reserve=0 active=${proxies.length} bad=${badProxyIndexes.size}`);
		return true;
	};
	const retireProxyById = (proxyId, reason) => {
		if (!proxyId) return false;
		const index = proxies.findIndex((proxy) => proxy.id === proxyId);
		if (index === -1) return false;
		return retireProxy(index, reason);
	};
	const pickProxy = () => {
		for (let attempt = 0; attempt < proxies.length; attempt += 1) {
			const index = nextProxyIndex % proxies.length;
			nextProxyIndex += 1;
			if (!badProxyIndexes.has(index) || badProxyIndexes.size >= proxies.length) {
				return { proxy: proxies[index], index };
			}
		}
		const index = nextProxyIndex % proxies.length;
		nextProxyIndex += 1;
		return { proxy: proxies[index], index };
	};

	return {
		enabled: true,
		proxyCount: proxies.length,
		proxyTotalCount,
		get proxyReserveCount() {
			return reserveProxies.length;
		},
		proxyFile,
		proxySource,
		markProxyBlocked(proxyId, reason = 'naver-block') {
			return retireProxyById(proxyId, reason);
		},
		async fetch(url, options = {}) {
			let lastError = null;
			for (let attempt = 1; attempt <= maxProxyAttempts; attempt += 1) {
				const { proxy, index } = pickProxy();
				try {
					return await fetchViaProxy(url, proxy, { ...options, timeoutMs });
				} catch (error) {
					lastError = error;
					console.warn(`[site-check-proxy] proxy failed attempt=${attempt}/${maxProxyAttempts} proxy=${proxy.id}: ${error.message}`);
					retireProxy(index, error.message);
				}
			}
			throw lastError;
		}
	};
}

function activeProxyLimit(proxyTotalCount) {
	const configured = numberEnv('NAVER_SITE_CHECK_PROXY_ACTIVE_LIMIT', numberEnv('NAVER_INDEX_PROXY_ACTIVE_LIMIT', 0));
	if (!Number.isFinite(configured) || configured <= 0) return proxyTotalCount;
	return Math.max(1, Math.min(proxyTotalCount, configured));
}

async function loadWebshareProxies(apiKey, timeoutMs) {
	const pageSize = Math.max(1, Math.min(1000, numberEnv('NAVER_SITE_CHECK_WEBSHARE_PAGE_SIZE', 250)));
	const maxPages = Math.max(1, numberEnv('NAVER_SITE_CHECK_WEBSHARE_MAX_PAGES', 20));
	const planId = firstEnv(['NAVER_SITE_CHECK_WEBSHARE_PLAN_ID', 'NAVER_INDEX_WEBSHARE_PLAN_ID']);
	const proxies = [];
	let page = 1;

	while (page <= maxPages) {
		const url = new URL('https://proxy.webshare.io/api/v2/proxy/list/');
		url.searchParams.set('mode', 'direct');
		url.searchParams.set('valid', 'true');
		url.searchParams.set('page_size', String(pageSize));
		url.searchParams.set('page', String(page));
		if (planId) url.searchParams.set('plan_id', planId);

		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort(new Error(`Webshare proxy list timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		let response;
		let text;
		try {
			response = await fetch(url, {
				signal: controller.signal,
				headers: {
					authorization: `Token ${apiKey}`,
					accept: 'application/json',
					connection: 'close'
				}
			});
			text = await response.text();
		} finally {
			clearTimeout(timer);
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`Webshare proxy list returned non-JSON status=${response.status}`);
		}
		if (!response.ok) {
			const detail = data && (data.detail || data.code || data.non_field_errors);
			throw new Error(`Webshare proxy list failed status=${response.status} detail=${JSON.stringify(detail || data).slice(0, 200)}`);
		}

		const results = Array.isArray(data.results) ? data.results : [];
		for (const item of results) {
			const proxy = webshareProxyFromApiResult(item);
			if (proxy) proxies.push(proxy);
		}
		if (!data.next || results.length === 0) break;
		page += 1;
	}

	return proxies.map((proxy, index) => ({ ...proxy, id: `p${String(index + 1).padStart(3, '0')}` }));
}

function webshareProxyFromApiResult(item) {
	const host = String(item?.proxy_address || '').trim();
	const port = Number(item?.port);
	const username = String(item?.username || '');
	const password = String(item?.password || '');
	if (!host || !Number.isFinite(port)) return null;
	return { host, port, username, password };
}

class HttpConnectHttpsAgent extends https.Agent {
	constructor(proxy, connectTimeoutMs) {
		super({ keepAlive: false });
		this.proxy = proxy;
		this.connectTimeoutMs = connectTimeoutMs;
	}

	createConnection(options, callback) {
		const proxy = this.proxy;
		const targetHost = options.host || options.hostname || 'search.naver.com';
		const targetPort = options.port || 443;
		const socket = net.connect(proxy.port, proxy.host);
		let done = false;
		let headerBuffer = Buffer.alloc(0);

		const finish = (error, stream) => {
			if (done) return;
			done = true;
			socket.removeAllListeners('data');
			socket.removeAllListeners('error');
			socket.removeAllListeners('timeout');
			callback(error, stream);
		};

		socket.setTimeout(this.connectTimeoutMs, () => {
			socket.destroy();
			finish(new Error(`proxy connect timeout after ${this.connectTimeoutMs}ms proxy=${proxy.id}`));
		});
		socket.on('error', (error) => finish(error));
		socket.on('connect', () => {
			const headers = [
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
				`Host: ${targetHost}:${targetPort}`,
				'Proxy-Connection: keep-alive'
			];
			if (proxy.username || proxy.password) {
				headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`);
			}
			socket.write(`${headers.join('\r\n')}\r\n\r\n`);
		});
		socket.on('data', (chunk) => {
			headerBuffer = Buffer.concat([headerBuffer, chunk]);
			const headerEnd = headerBuffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) return;
			const headerText = headerBuffer.slice(0, headerEnd).toString('latin1');
			if (!/^HTTP\/1\.[01] 2\d\d\b/i.test(headerText)) {
				socket.destroy();
				finish(new Error(`proxy CONNECT failed proxy=${proxy.id}: ${headerText.split(/\r?\n/)[0] || 'unknown response'}`));
				return;
			}

			socket.setTimeout(0);
			const tlsSocket = tls.connect({
				socket,
				servername: targetHost,
				rejectUnauthorized: true
			});
			tlsSocket.setTimeout(this.connectTimeoutMs, () => {
				tlsSocket.destroy();
				finish(new Error(`proxy TLS timeout after ${this.connectTimeoutMs}ms proxy=${proxy.id}`));
			});
			tlsSocket.once('secureConnect', () => {
				tlsSocket.setTimeout(0);
				finish(null, tlsSocket);
			});
			tlsSocket.once('error', (error) => finish(error));
		});
	}
}

function fetchViaProxy(urlString, proxy, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const url = new URL(urlString);
		const timeoutMs = options.timeoutMs || 15000;
		const agent = new HttpConnectHttpsAgent(proxy, timeoutMs);
		/*
		 * 압축을 받아온다.
		 *
		 * 예전에는 'identity' 로 압축을 꺼놨다. 네이버 검색 결과 HTML 이
		 * 287KB 인데 gzip 하면 31KB 라 9배 차이가 난다. 프록시를 거치는
		 * 경로에서만 압축을 끄고 있었으니, 대역폭이 드는 쪽만 손해였다.
		 * (프록시를 안 쓸 때는 Node 기본 fetch 가 알아서 gzip 을 받는다.)
		 *
		 * 응답을 푸는 건 아래 decodeBody 가 content-encoding 을 보고 처리한다.
		 * 그 코드는 원래 있었고 요청 헤더만 막혀 있었다.
		 */
		const headers = {
			...(options.headers || {}),
			'accept-encoding': 'gzip, deflate'
		};
		let settled = false;
		let request = null;
		const settle = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(hardTimeout);
			agent.destroy();
			callback(value);
		};
		const hardTimeout = setTimeout(() => {
			if (request) request.destroy();
			settle(rejectPromise, new Error(`hard timeout after ${timeoutMs}ms proxy=${proxy.id}`));
		}, timeoutMs + 1000);
		request = https.request(url, {
			method: options.method || 'GET',
			agent,
			timeout: timeoutMs,
			headers
		}, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () => {
				const body = Buffer.concat(chunks);
				settle(resolvePromise, {
					status: response.statusCode || 0,
					statusText: response.statusMessage || '',
					headers: response.headers || {},
					proxyId: proxy.id,
					url: url.toString(),
					async text() {
						return decodeBody(body, response.headers || {});
					}
				});
			});
			response.on('error', (error) => settle(rejectPromise, error));
		});
		request.on('timeout', () => request.destroy(new Error(`timeout after ${timeoutMs}ms proxy=${proxy.id}`)));
		request.on('error', (error) => settle(rejectPromise, error));
		request.end();
	});
}

function decodeBody(body, headers) {
	const encoding = String(headers['content-encoding'] || '').toLowerCase();
	if (encoding.includes('gzip')) return zlib.gunzipSync(body).toString('utf8');
	if (encoding.includes('br')) return zlib.brotliDecompressSync(body).toString('utf8');
	if (encoding.includes('deflate')) return zlib.inflateSync(body).toString('utf8');
	return body.toString('utf8');
}

function loadProxies(filePath) {
	return readFileSync(filePath, 'utf8')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.map(parseProxyLine)
		.map((proxy, index) => ({ ...proxy, id: `p${String(index + 1).padStart(3, '0')}` }));
}

function parseProxyLine(line) {
	if (/^https?:\/\//i.test(line)) {
		const url = new URL(line);
		return {
			host: url.hostname,
			port: Number(url.port || 8080),
			username: decodeURIComponent(url.username || ''),
			password: decodeURIComponent(url.password || '')
		};
	}

	if (line.includes('@')) {
		const url = new URL(`http://${line}`);
		return {
			host: url.hostname,
			port: Number(url.port || 8080),
			username: decodeURIComponent(url.username || ''),
			password: decodeURIComponent(url.password || '')
		};
	}

	const parts = line.split(':');
	if (parts.length >= 4) {
		const [host, port, username, ...passwordParts] = parts;
		return { host, port: Number(port), username, password: passwordParts.join(':') };
	}
	if (parts.length === 2) {
		const [host, port] = parts;
		return { host, port: Number(port), username: '', password: '' };
	}

	throw new Error(`Unsupported proxy line format: ${maskProxyLine(line)}`);
}

function firstEnv(names) {
	for (const name of names) {
		if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
	}
	return '';
}

function numberEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) ? value : fallback;
}

function maskProxyLine(line) {
	return String(line || '').replace(/(:)[^:@]+(@|$)/g, '$1***$2');
}
