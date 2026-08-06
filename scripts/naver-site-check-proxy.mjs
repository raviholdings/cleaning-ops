import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import {
	NAVER_INDEX_CLASSIFIER_VERSION,
	classifyUrls,
	postIdFromUrl
} from './lib/naver-index-url-classifier.mjs';
import { loadNaverIndexRegistryTargets } from './lib/naver-index-target-query.mjs';
import { createSiteCheckHttpClient } from './naver-site-check-proxy.mjs';

const { Client } = pg;

const projectRoot = process.cwd();
const schemaPath = resolve(projectRoot, 'supabase/migrations/20260630093000_create_naver_index_check_registry.sql');
loadLocalEnv(resolve(projectRoot, '.env'));

const outputDir = resolve(projectRoot, process.env.NAVER_INDEX_CHECK_OUTPUT_DIR || 'reports/naver-site-search');
const importJsonPath = getArgValue('--import-json') || process.env.NAVER_INDEX_CHECK_IMPORT_JSON || '';
const explicitRunId = getArgValue('--run-id') || process.env.NAVER_INDEX_CHECK_RUN_ID || '';
const triggerType = getArgValue('--trigger') || process.env.NAVER_INDEX_CHECK_TRIGGER || (importJsonPath ? 'import' : 'manual');
const maxPages = numberEnv('NAVER_INDEX_MAX_PAGES', 9);
const requestDelayMs = numberEnv('NAVER_INDEX_REQUEST_DELAY_MS', 5000);
const hostDelayMs = numberEnv('NAVER_INDEX_HOST_DELAY_MS', 10000);
const delayJitterMs = numberEnv('NAVER_INDEX_DELAY_JITTER_MS', 0);
const blockBackoffMs = numberEnv('NAVER_INDEX_BLOCK_BACKOFF_MS', 0);
const blockMaxAttempts = numberEnv('NAVER_INDEX_BLOCK_MAX_ATTEMPTS', 5);
const noResultRetries = numberEnv('NAVER_INDEX_NO_RESULT_RETRIES', 1);
const noResultRetryDelayMs = numberEnv('NAVER_INDEX_NO_RESULT_RETRY_DELAY_MS', 2500);
const capPageFullThreshold = numberEnv('NAVER_INDEX_CAP_PAGE_FULL_THRESHOLD', 20);
let capPageFirst = process.env.NAVER_INDEX_CAP_PAGE_FIRST !== '0';
const queryModes = splitEnv(process.env.NAVER_INDEX_QUERY_MODES || 'https');
const explicitHosts = new Set(splitEnv(process.env.NAVER_INDEX_CHECK_HOSTS).map(normalizeHostValue));
let targetHostSuffix = normalizeHostSuffix(process.env.NAVER_INDEX_HOST_SUFFIX || '');
let targetProject = process.env.NAVER_INDEX_TARGET_PROJECT || '';
let domainGroupKey = getArgValue('--group') || process.env.NAVER_INDEX_GROUP_KEY || process.env.NAVER_INDEX_DOMAIN_GROUP_KEY || '';
let deploymentAccountIds = splitEnv(process.env.NAVER_INDEX_DEPLOYMENT_ACCOUNT_IDS || '');
let tableProject = process.env.NAVER_INDEX_TABLE_PROJECT || '';
let targetDomainKind = normalizeDomainKind(process.env.NAVER_INDEX_DOMAIN_KIND || '');
let reportNamePrefix = process.env.NAVER_INDEX_REPORT_PREFIX || '';
let reportTitle = process.env.NAVER_INDEX_REPORT_TITLE || '';
const targetLimit = numberEnv('NAVER_INDEX_CHECK_LIMIT', 0);
const checkConcurrency = Math.max(1, numberEnv('NAVER_INDEX_CHECK_CONCURRENCY', numberEnv('NAVER_SITE_CHECK_CONCURRENCY', 1)));
const resumeExisting = process.env.NAVER_INDEX_CHECK_RESUME !== '0';
const pageStarts = splitEnv(process.env.NAVER_INDEX_PAGE_STARTS || '1,21,41,61,81,101,121,141,161')
	.map((value) => Number(value))
	.filter(Number.isFinite)
	.slice(0, Math.max(1, maxPages));
const writeReports = process.env.NAVER_INDEX_CHECK_WRITE_REPORTS !== '0';
const userAgent = process.env.NAVER_SITE_CHECK_USER_AGENT
	|| 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const siteCheckHttp = await createSiteCheckHttpClient({
	projectRoot,
	proxyFileEnvNames: ['NAVER_INDEX_PROXY_FILE'],
	enabledEnvNames: ['NAVER_INDEX_PROXY_ENABLED'],
	timeoutMs: numberEnv('NAVER_INDEX_PROXY_TIMEOUT_MS', numberEnv('NAVER_SITE_CHECK_PROXY_TIMEOUT_MS', 15000))
});
const effectiveCheckConcurrency = Math.max(1, siteCheckHttp.enabled ? Math.min(checkConcurrency, siteCheckHttp.proxyCount) : checkConcurrency);
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const targetPageCount = numberEnv('NAVER_INDEX_PAGE_COUNT', numberEnv('NAVER_INDEX_NUMERIC_PAGE_COUNT', 2750));
const retryErrorResults = process.env.NAVER_INDEX_RETRY_ERRORS === '1';
const classifierVersion = NAVER_INDEX_CLASSIFIER_VERSION;

function getArgValue(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return '';
	return process.argv[index + 1] || '';
}

function numberEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) ? value : fallback;
}

function splitEnv(value) {
	return String(value || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeHostValue(value) {
	const trimmed = String(value || '').trim().toLowerCase();
	if (!trimmed) return '';
	try {
		const url = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
		return url.host;
	} catch {
		return trimmed.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	}
}

function normalizeHostSuffix(value) {
	return normalizeHostValue(value).replace(/^\*\./, '');
}

function normalizeDomainKind(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (['all', 'any', '*'].includes(normalized)) return 'all';
	if ([
		'custom',
		'cloudflare',
		'cloudflare-ec2',
		'ec2',
		'non_netlify',
		'non-netlify'
	].includes(normalized)) return 'non-netlify';
	return 'netlify';
}

async function applyGroupConfig(client) {
	if (!domainGroupKey) {
		throw new Error('NAVER_INDEX_GROUP_KEY or NAVER_INDEX_DOMAIN_GROUP_KEY is required.');
	}

	const { rows } = await client.query(
		`
			select group_key, target_project, sheet_name, display_name, settings
			from public.naver_project_groups
			where group_key = $1
			limit 1
		`,
		[domainGroupKey]
	);
	const group = rows[0];
	if (!group) throw new Error(`naver_project_groups row not found: ${domainGroupKey}`);

	const settings = group.settings || {};
	targetProject = targetProject || group.target_project;
	tableProject = tableProject || targetProject;
	targetDomainKind = normalizeDomainKind(process.env.NAVER_INDEX_DOMAIN_KIND || settings.domainKind || 'all');
	targetHostSuffix = targetHostSuffix || normalizeHostSuffix(settings.hostSuffix || settings.domainRoot || '');
	if (process.env.NAVER_INDEX_CAP_PAGE_FIRST === undefined && settings.capPageFirst !== undefined) {
		capPageFirst = settings.capPageFirst !== false && settings.capPageFirst !== '0';
	}
	reportNamePrefix = reportNamePrefix || String(group.group_key || domainGroupKey).replaceAll('_', '-');
	reportTitle = reportTitle || `${group.display_name || group.sheet_name || group.group_key} Naver Site Index Post Count`;

	if (!targetProject) throw new Error(`target_project is missing for group: ${domainGroupKey}`);
}

function runIdPrefix() {
	return String(domainGroupKey || targetProject || 'naver-index').replaceAll('_', '-');
}

function loadLocalEnv(path) {
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (error && error.code === 'ENOENT') return;
		throw error;
	}

	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match || process.env[match[1]] !== undefined) continue;

		let value = match[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[match[1]] = value.replace(/\\n/g, '\n');
	}
}

function createClientConfig(value) {
	const url = new URL(value);
	const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
	url.searchParams.delete('sslmode');
	url.searchParams.delete('ssl');

	return {
		connectionString: url.toString(),
		ssl: requiresSsl ? { rejectUnauthorized: false } : undefined
	};
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(ms) {
	const base = Math.max(0, Number(ms) || 0);
	const jitter = Math.max(0, Number(delayJitterMs) || 0);
	if (base === 0 && jitter === 0) return 0;
	return base + (jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0);
}

async function sleepWithJitter(ms) {
	const delay = jitteredDelay(ms);
	if (delay > 0) await sleep(delay);
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatStamp(date) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function datePart(date) {
	return date.toISOString().slice(0, 10);
}

function naverUrl(host, pageInfo, queryMode) {
	const url = new URL('https://search.naver.com/search.naver');
	url.searchParams.set('nso', '');
	url.searchParams.set('query', siteQuery(host, queryMode));
	url.searchParams.set('sm', 'tab_pge');
	url.searchParams.set('ssc', 'tab.ur.all');
	url.searchParams.set('start', String(pageInfo.start));
	url.searchParams.set('page', String(pageInfo.page));
	return url.toString();
}

function siteQuery(host, queryMode) {
	if (queryMode === 'host') return `site:${host}`;
	if (queryMode === 'http') return `site:http://${host}/`;
	return `site:https://${host}/`;
}

function pageInfoFromStart(start) {
	return {
		start,
		page: start === 1 ? 2 : Math.floor((start - 1) / 20) + 2
	};
}

function normalizeResultUrl(raw) {
	const clean = raw.replaceAll('\\/', '/').replaceAll('&amp;', '&');
	const url = new URL(clean);
	return `${url.origin}${url.pathname}`;
}

function extractHostUrls(host, html) {
	const urls = new Set();
	const escapedHost = escapeRegExp(host);
	const patterns = [
		new RegExp(`https?://` + escapedHost + `[^"'<>)\\s]*`, 'g'),
		new RegExp(`https?:\\\\/\\\\/` + escapedHost + `[^"\\\\]*`, 'g')
	];

	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) {
			try {
				const normalized = normalizeResultUrl(match[0]);
				const url = new URL(normalized);
				if (url.host.toLowerCase() === host) urls.add(normalized);
			} catch {
				// Ignore broken script snippets.
			}
		}
	}

	return Array.from(urls);
}

function parsePage(host, html) {
	const blocked = html.includes('검색 서비스 이용이 제한되었습니다') || html.includes('비정상적인 움직임이 발견');
	const noResult = html.includes('api_noresult_wrap') || html.includes('검색결과가 없습니다');
	const webItemCount = (html.match(/templateId":"webItem/g) || []).length;
	const disabledNext = /class="btn_next"[^>]*aria-disabled="true"/.test(html);
	const enabledNext = /class="btn_next"[^>]*aria-disabled="false"/.test(html);
	const labels = Array.from(html.matchAll(/aria-label="(\d+)페이지"/g))
		.map((match) => Number(match[1]))
		.filter(Number.isFinite);
	const urls = extractHostUrls(host, html);

	return { blocked, noResult, webItemCount, disabledNext, enabledNext, labels, urls };
}

async function fetchPage(host, pageInfo, queryMode) {
	const url = naverUrl(host, pageInfo, queryMode);
	let lastError = null;

	for (let attempt = 1; attempt <= blockMaxAttempts; attempt += 1) {
		try {
			const response = await siteCheckHttp.fetch(url, {
				headers: {
					'user-agent': userAgent,
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
				}
			});
			const html = await response.text();
			const parsed = parsePage(host, html);

			const isBlocked = response.status === 403 || parsed.blocked;
			if (isBlocked) siteCheckHttp.markProxyBlocked?.(response.proxyId, `naver-block status=${response.status}`);
			if (isBlocked && attempt < blockMaxAttempts) {
				console.log(`[index-check] naver blocked host=${host} mode=${queryMode} start=${pageInfo.start} status=${response.status} proxy=${response.proxyId || 'none'} attempt=${attempt}; retry with another proxy`);
				if (blockBackoffMs > 0) await sleep(blockBackoffMs);
				continue;
			}

			return { status: response.status, html, url, parsed };
		} catch (error) {
			lastError = error;
			await sleep(2000 * attempt);
		}
	}

	throw lastError || new Error(`failed to fetch ${url}`);
}

async function checkHostForQueryMode(target, queryMode) {
	const postUrls = new Set();
	const staticUrls = new Set();
	const pages = [];
	let indexed = false;
	let noResult = false;
	let stoppedBy = 'checked-visible-pages';
	let searchCapReached = false;
	const pageInfos = pageStarts.map(pageInfoFromStart);
	const capPage = pageInfos.at(-1);
	const fetchedCache = new Map();

	if (capPageFirst && capPage) {
		const capFetched = await fetchPage(target.domain, capPage, queryMode);
		if (capFetched.status === 403 || capFetched.parsed.blocked) {
			throw new Error(`naver blocked at cap page mode=${queryMode} start=${capPage.start}`);
		}
		const capClassified = classifyUrls(capFetched.parsed.noResult ? [] : capFetched.parsed.urls);
		fetchedCache.set(capPage.start, { fetched: capFetched, parsed: capFetched.parsed, classified: capClassified });

		if (capClassified.posts.size >= capPageFullThreshold) {
			searchCapReached = true;
			stoppedBy = 'page10-full';
			for (const url of capClassified.posts) postUrls.add(url);
			for (const url of capClassified.staticUrls) staticUrls.add(url);
			pages.push(pageSample({
				pageInfo: capPage,
				queryMode,
				fetched: capFetched,
				parsed: capFetched.parsed,
				classified: capClassified,
				postTotal: postUrls.size,
				staticTotal: staticUrls.size
			}));
			indexed = postUrls.size > 0 || staticUrls.size > 0;
			return queryModeResult({ target, queryMode, postUrls, staticUrls, pages, indexed, noResult, stoppedBy, searchCapReached });
		}
	}

	for (const pageInfo of pageInfos) {
		const before = postUrls.size + staticUrls.size;
		let cached = fetchedCache.get(pageInfo.start);
		if (!cached) {
			const fetched = await fetchPage(target.domain, pageInfo, queryMode);
			const parsed = fetched.parsed;
			const classified = classifyUrls(parsed.noResult ? [] : parsed.urls);
			cached = { fetched, parsed, classified };
			fetchedCache.set(pageInfo.start, cached);
		}
		let { fetched, parsed, classified } = cached;

		if (pageInfo.start === 1 && parsed.noResult && noResultRetries > 0) {
			for (let retry = 1; retry <= noResultRetries; retry += 1) {
				await sleep(noResultRetryDelayMs);
				const retriedFetched = await fetchPage(target.domain, pageInfo, queryMode);
				const retriedParsed = retriedFetched.parsed;
				const retriedClassified = classifyUrls(retriedParsed.noResult ? [] : retriedParsed.urls);
				if (retriedFetched.status === 403 || retriedParsed.blocked) {
					throw new Error(`naver blocked mode=${queryMode} start=${pageInfo.start} retry=${retry}`);
				}
				fetched = retriedFetched;
				parsed = retriedParsed;
				classified = retriedClassified;
				cached = { fetched, parsed, classified };
				fetchedCache.set(pageInfo.start, cached);
				if (!parsed.noResult || classified.posts.size > 0 || classified.staticUrls.size > 0) break;
			}
		}

		if (fetched.status === 403 || parsed.blocked) throw new Error(`naver blocked mode=${queryMode} start=${pageInfo.start}`);

		if (!parsed.noResult) {
			for (const url of classified.posts) postUrls.add(url);
			for (const url of classified.staticUrls) staticUrls.add(url);
		}

		indexed = indexed || (!parsed.noResult && (parsed.webItemCount > 0 || postUrls.size > 0 || staticUrls.size > 0));
		noResult = noResult || parsed.noResult;
		pages.push(pageSample({
			pageInfo,
			queryMode,
			fetched,
			parsed,
			classified,
			postTotal: postUrls.size,
			staticTotal: staticUrls.size
		}));

		await sleepWithJitter(requestDelayMs);

		if (parsed.noResult) {
			stoppedBy = 'no-result';
			break;
		}
		if (fetched.status >= 400) {
			stoppedBy = `http-${fetched.status}`;
			break;
		}
		if (classified.posts.size === 0 && classified.staticUrls.size === 0) {
			stoppedBy = pageInfo.start === 1 ? 'empty-page' : 'last-visible-page';
			break;
		}
		if (postUrls.size + staticUrls.size === before && pages.length > 1) {
			stoppedBy = 'no-new-urls';
			break;
		}
	}

	return queryModeResult({ target, queryMode, postUrls, staticUrls, pages, indexed, noResult, stoppedBy, searchCapReached });
}

function pageSample({ pageInfo, queryMode, fetched, parsed, classified, postTotal, staticTotal }) {
	return {
		page: pageInfo.page,
		start: pageInfo.start,
		queryMode,
		status: fetched.status,
		webItemCount: parsed.webItemCount,
		urlCount: parsed.noResult ? 0 : parsed.urls.length,
		postPageCount: classified.posts.size,
		numericPageCount: classified.posts.size,
		staticPageCount: classified.staticUrls.size,
		postTotal,
		numericTotal: postTotal,
		staticTotal,
		enabledNext: parsed.enabledNext,
		disabledNext: parsed.disabledNext,
		labels: parsed.labels,
		noResult: parsed.noResult,
		blocked: parsed.blocked
	};
}

function queryModeResult({ target, queryMode, postUrls, staticUrls, pages, indexed, noResult, stoppedBy, searchCapReached }) {
	const visibleIndexedPostCount = postUrls.size;
	const requestedCount = Number(target.crawl_submitted_or_present || 0);
	const pageCount = Number(target.page_count || 0);
	const reportIndexedPostCount = searchCapReached && requestedCount > 0
		? Math.min(requestedCount, pageCount || requestedCount)
		: visibleIndexedPostCount;
	return {
		...target,
		checked_at: new Date().toISOString(),
		indexed,
		no_result: noResult,
		indexed_post_count: reportIndexedPostCount,
		visible_indexed_post_count: visibleIndexedPostCount,
		search_cap_reached: searchCapReached,
		query_mode: queryMode,
		indexed_static_url_count: staticUrls.size,
		indexed_url_count: reportIndexedPostCount + staticUrls.size,
		indexed_post_urls: Array.from(postUrls).sort(routeSort),
		indexed_post_urls_sample: Array.from(postUrls).sort(routeSort).slice(0, 20),
		indexed_static_urls: Array.from(staticUrls).sort(routeSort),
		pages_checked: pages.length,
		stopped_by: stoppedBy,
		page_samples: pages
	};
}

async function checkHost(target) {
	const modeResults = [];
	for (const queryMode of queryModes) {
		const row = await checkHostForQueryMode(target, queryMode);
		modeResults.push(row);
		if (row.search_cap_reached) break;
		await sleepWithJitter(requestDelayMs);
	}
	const best = modeResults
		.slice()
		.sort((a, b) => (
			Number(b.search_cap_reached) - Number(a.search_cap_reached)
			|| (b.visible_indexed_post_count || 0) - (a.visible_indexed_post_count || 0)
			|| (b.indexed_post_count || 0) - (a.indexed_post_count || 0)
		))[0];
	return {
		...best,
		source_payload: {
			...(best.source_payload || {}),
			queryModesChecked: modeResults.map((row) => ({
				queryMode: row.query_mode,
				indexedPostCount: row.indexed_post_count,
				visibleIndexedPostCount: row.visible_indexed_post_count,
				searchCapReached: row.search_cap_reached,
				pagesChecked: row.pages_checked,
				stoppedBy: row.stopped_by
			}))
		}
	};
}

function checkErrorResult(target, error) {
	const message = error?.message || String(error || 'unknown error');
	return {
		...target,
		checked_at: new Date().toISOString(),
		indexed: false,
		no_result: false,
		indexed_post_count: 0,
		visible_indexed_post_count: 0,
		search_cap_reached: false,
		query_mode: queryModes[0] || '',
		indexed_static_url_count: 0,
		indexed_url_count: 0,
		indexed_post_urls: [],
		indexed_post_urls_sample: [],
		indexed_static_urls: [],
		pages_checked: 0,
		stopped_by: 'error',
		page_samples: [],
		error: message,
		source_payload: {
			...(target.source_payload || {}),
			error: message,
			errorName: error?.name || null
		}
	};
}

function routeSort(a, b) {
	const ra = routeNumber(a);
	const rb = routeNumber(b);
	return ra - rb || a.localeCompare(b);
}

function routeNumber(value) {
	try {
		const pathname = new URL(value).pathname;
		if (pathname === '/') return 0;
		const match = pathname.match(/^\/(\d+)(?:\.html)?\/?$/i);
		if (match) return Number(match[1]);
		return Number.MAX_SAFE_INTEGER;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function csvValue(value) {
	const text = String(value ?? '');
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function summarize(results, targetCount, startedAt, finishedAt = new Date()) {
	return {
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		target_domain_count: targetCount,
		checked_domain_count: results.length,
		indexed_domain_count: results.filter((row) => row.indexed).length,
		indexed_with_posts_domain_count: results.filter((row) => (row.indexed_post_count || 0) > 0).length,
		not_indexed_domain_count: results.filter((row) => row.indexed === false).length,
		indexed_post_total: results.reduce((sum, row) => sum + (row.indexed_post_count || 0), 0),
		visible_indexed_post_total: results.reduce((sum, row) => sum + (row.visible_indexed_post_count || 0), 0),
		search_cap_reached_domain_count: results.filter((row) => row.search_cap_reached).length,
		indexed_static_url_total: results.reduce((sum, row) => sum + (row.indexed_static_url_count || 0), 0),
		indexed_url_total: results.reduce((sum, row) => sum + (row.indexed_url_count || 0), 0),
		error_domain_count: results.filter((row) => row.error).length,
		max_pages: maxPages,
		request_delay_ms: requestDelayMs,
		host_delay_ms: hostDelayMs,
		delay_jitter_ms: delayJitterMs
	};
}

function reportPaths(startedAt) {
	const stamp = formatStamp(startedAt);
	return {
		jsonPath: resolve(outputDir, `${reportNamePrefix}-naver-site-index-posts-${stamp}.json`),
		csvPath: resolve(outputDir, `${reportNamePrefix}-naver-site-index-posts-${stamp}.csv`),
		mdPath: resolve(outputDir, `${reportNamePrefix}-naver-site-index-posts-${stamp}.md`)
	};
}

function saveReports({ summary, results, paths, complete }) {
	if (!writeReports) return;
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(paths.jsonPath, JSON.stringify({ summary: { ...summary, complete }, results }, null, 2));

	const csvRows = [
		[
			'domain',
			'region_label',
			'query_mode',
			'indexed',
			'indexed_post_count',
			'visible_indexed_post_count',
			'search_cap_reached',
			'crawl_submitted_or_present',
			'crawl_processed_count',
			'indexed_static_url_count',
			'indexed_url_count',
			'pages_checked',
			'stopped_by',
			'error',
			'page_count',
			'sitemap_url_count',
			'crawl_last_requested_at',
			'deployed_at'
		].join(','),
		...results.map((row) => [
			row.domain,
			row.region_label,
			row.query_mode,
			row.indexed,
			row.indexed_post_count,
			row.visible_indexed_post_count,
			row.search_cap_reached,
			row.crawl_submitted_or_present,
			row.crawl_processed_count,
			row.indexed_static_url_count,
			row.indexed_url_count,
			row.pages_checked,
			row.stopped_by,
			row.error,
			row.page_count,
			row.sitemap_url_count,
			row.crawl_last_requested_at,
			row.deployed_at
		].map(csvValue).join(','))
	];
	writeFileSync(paths.csvPath, `${csvRows.join('\n')}\n`);

	const top = Array.from(results)
		.sort((a, b) => (b.indexed_post_count || 0) - (a.indexed_post_count || 0))
		.slice(0, 40);
	const md = [
		`# ${reportTitle}`,
		'',
		`- Started: \`${summary.started_at}\``,
		`- Updated: \`${summary.finished_at}\``,
		`- Complete: \`${complete}\``,
		`- Target domains: \`${summary.target_domain_count}\``,
		`- Checked domains: \`${summary.checked_domain_count}\``,
		`- Indexed domains: \`${summary.indexed_domain_count}\``,
		`- Indexed domains with posts: \`${summary.indexed_with_posts_domain_count}\``,
		`- Indexed posts total: \`${summary.indexed_post_total}\``,
		`- Visible posts total: \`${summary.visible_indexed_post_total}\``,
		`- Search cap reached domains: \`${summary.search_cap_reached_domain_count}\``,
		`- Error domains: \`${summary.error_domain_count || 0}\``,
		`- Indexed static URLs total: \`${summary.indexed_static_url_total}\``,
		'',
		'## Top Domains',
		'',
		'| Domain | Region | Query | Reported Posts | Visible Posts | Crawl Submitted | Cap | Pages Checked | Stop |',
		'| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |',
		...top.map((row) => `| \`${row.domain}\` | ${row.region_label || ''} | ${row.query_mode || ''} | ${row.indexed_post_count || 0} | ${row.visible_indexed_post_count || 0} | ${row.crawl_submitted_or_present || 0} | ${row.search_cap_reached ? 'Y' : ''} | ${row.pages_checked || 0} | ${row.stopped_by || ''} |`)
	].join('\n');
	writeFileSync(paths.mdPath, `${md}\n`);
}

async function ensureSchema(client) {
	await client.query(readFileSync(schemaPath, 'utf8'));
}

async function loadTargets(client) {
	return loadNaverIndexRegistryTargets(client, {
		domainGroupKey,
		targetProject,
		targetPageCount,
		deploymentAccountIds,
		targetHostSuffix,
		targetDomainKind,
		explicitHosts,
		targetLimit
	});
}


function runPayload({ paths, complete }) {
	return {
		script: 'scripts/check-naver-indexed-posts.mjs',
		complete,
		targetProject,
		domainGroupKey,
		tableProject,
		targetDomainKind,
		targetHostSuffix,
		deploymentAccountIds,
		importJsonPath: importJsonPath || null,
		naverWhere: 'web',
		queryModes,
		pageStarts,
		capPageFirst,
		capPageFullThreshold,
		checkConcurrency,
		proxyEnabled: siteCheckHttp.enabled,
		proxyCount: siteCheckHttp.proxyCount,
		proxyTotalCount: siteCheckHttp.proxyTotalCount || siteCheckHttp.proxyCount,
		proxyReserveCount: siteCheckHttp.proxyReserveCount || 0,
		proxySource: siteCheckHttp.proxySource || null,
		proxyFile: siteCheckHttp.proxyFile || null,
		noResultRetries,
		noResultRetryDelayMs,
		classifierVersion,
		explicitHosts: Array.from(explicitHosts),
		targetLimit,
		resumeExisting,
		retryErrorResults
	};
}

async function loadExistingResults(client, runId) {
	if (!runId || !resumeExisting) return [];
	const { rows } = await client.query(
		`
			select *
			from public.naver_index_check_results
			where run_id = $1
			order by checked_at, id
		`,
		[runId]
	);
	return rows.map((row) => {
		const payload = row.source_payload || {};
		return {
			...row,
			visible_indexed_post_count: payload.visibleIndexedPostCount || 0,
			search_cap_reached: Boolean(payload.searchCapReached),
			query_mode: payload.queryMode || null,
			crawl_submitted_or_present: payload.crawlSubmittedOrPresent || 0,
			crawl_processed_count: payload.crawlProcessedCount || 0,
			crawl_last_requested_at: payload.crawlLastRequestedAt || null,
			indexed_post_urls_sample: row.indexed_post_urls_sample || [],
			indexed_static_urls: row.indexed_static_urls || [],
			page_samples: row.page_samples || [],
			source_payload: payload
		};
	});
}

async function upsertRun(client, { runId, status, summary, paths, error = null, complete = false }) {
	await client.query(
		`
			insert into public.naver_index_check_runs (
				run_id,
				group_key,
				target_project,
				source,
				trigger_type,
				status,
				check_date,
				started_at,
				finished_at,
				target_domain_count,
				checked_domain_count,
				indexed_domain_count,
				indexed_with_posts_domain_count,
				not_indexed_domain_count,
				indexed_post_total,
				visible_indexed_post_total,
				indexed_static_url_total,
				indexed_url_total,
				search_cap_reached_domain_count,
				error_domain_count,
				max_pages,
				request_delay_ms,
				host_delay_ms,
				check_concurrency,
				runner_host,
				runner_cwd,
				output_json_path,
				output_csv_path,
				output_md_path,
				error,
				source_payload,
				updated_at
			)
			values (
					$1, $2, $3, 'naver-site-search', $4, $5, $6::date, $7::timestamptz, $8::timestamptz,
					$9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
					$19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::jsonb, now()
				)
			on conflict (run_id) do update set
				group_key = excluded.group_key,
				target_project = excluded.target_project,
				trigger_type = excluded.trigger_type,
				status = excluded.status,
				check_date = excluded.check_date,
				started_at = excluded.started_at,
				finished_at = excluded.finished_at,
				target_domain_count = excluded.target_domain_count,
				checked_domain_count = excluded.checked_domain_count,
				indexed_domain_count = excluded.indexed_domain_count,
				indexed_with_posts_domain_count = excluded.indexed_with_posts_domain_count,
				not_indexed_domain_count = excluded.not_indexed_domain_count,
				indexed_post_total = excluded.indexed_post_total,
				visible_indexed_post_total = excluded.visible_indexed_post_total,
				indexed_static_url_total = excluded.indexed_static_url_total,
				indexed_url_total = excluded.indexed_url_total,
				search_cap_reached_domain_count = excluded.search_cap_reached_domain_count,
				error_domain_count = excluded.error_domain_count,
				max_pages = excluded.max_pages,
				request_delay_ms = excluded.request_delay_ms,
				host_delay_ms = excluded.host_delay_ms,
				check_concurrency = excluded.check_concurrency,
				runner_host = excluded.runner_host,
				runner_cwd = excluded.runner_cwd,
				output_json_path = excluded.output_json_path,
				output_csv_path = excluded.output_csv_path,
				output_md_path = excluded.output_md_path,
				error = excluded.error,
				source_payload = excluded.source_payload,
				updated_at = now()
		`,
		[
			runId,
			domainGroupKey,
			targetProject,
			triggerType,
			status,
			datePart(new Date(summary.started_at)),
			summary.started_at,
			summary.finished_at || null,
			summary.target_domain_count || 0,
			summary.checked_domain_count || 0,
			summary.indexed_domain_count || 0,
			summary.indexed_with_posts_domain_count || 0,
			summary.not_indexed_domain_count || 0,
			summary.indexed_post_total || 0,
			summary.visible_indexed_post_total || 0,
			summary.indexed_static_url_total || 0,
			summary.indexed_url_total || 0,
			summary.search_cap_reached_domain_count || 0,
			summary.error_domain_count || 0,
			summary.max_pages ?? maxPages,
			summary.request_delay_ms ?? requestDelayMs,
			summary.host_delay_ms ?? hostDelayMs,
			checkConcurrency,
			hostname(),
			projectRoot,
			paths.jsonPath || null,
			paths.csvPath || null,
			paths.mdPath || null,
			error,
			JSON.stringify(runPayload({ paths, complete }))
		]
	);
}

async function upsertResult(client, runId, row) {
	await client.query(
		`
			insert into public.naver_index_check_results (
				run_id,
				group_key,
				target_project,
				domain,
				site_url,
				naver_account_id,
				city_slug,
				region_label,
				page_count,
				sitemap_url_count,
				deployed_at,
				checked_at,
				indexed,
				no_result,
				indexed_post_count,
				visible_indexed_post_count,
				search_cap_reached,
				indexed_static_url_count,
				indexed_url_count,
				pages_checked,
				stopped_by,
				error,
				indexed_post_urls_sample,
				indexed_static_urls,
				page_samples,
				source_payload,
				updated_at
				)
				values (
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13, $14,
					$15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb, now()
				)
			on conflict (run_id, domain) do update set
				group_key = excluded.group_key,
				target_project = excluded.target_project,
				site_url = excluded.site_url,
				naver_account_id = excluded.naver_account_id,
				city_slug = excluded.city_slug,
				region_label = excluded.region_label,
				page_count = excluded.page_count,
				sitemap_url_count = excluded.sitemap_url_count,
				deployed_at = excluded.deployed_at,
				checked_at = excluded.checked_at,
				indexed = excluded.indexed,
				no_result = excluded.no_result,
				indexed_post_count = excluded.indexed_post_count,
				visible_indexed_post_count = excluded.visible_indexed_post_count,
				search_cap_reached = excluded.search_cap_reached,
				indexed_static_url_count = excluded.indexed_static_url_count,
				indexed_url_count = excluded.indexed_url_count,
				pages_checked = excluded.pages_checked,
				stopped_by = excluded.stopped_by,
				error = excluded.error,
				indexed_post_urls_sample = excluded.indexed_post_urls_sample,
				indexed_static_urls = excluded.indexed_static_urls,
				page_samples = excluded.page_samples,
				source_payload = excluded.source_payload,
				updated_at = now()
		`,
		[
			runId,
			domainGroupKey,
			targetProject,
			row.domain,
			row.site_url || null,
			row.naver_account_id || row.city_slug || null,
			row.city_slug || null,
			row.region_label || null,
			row.page_count || 0,
			row.sitemap_url_count || 0,
			row.deployed_at || null,
			row.checked_at || new Date().toISOString(),
			Boolean(row.indexed),
			Boolean(row.no_result),
			row.indexed_post_count || 0,
			row.visible_indexed_post_count || 0,
			Boolean(row.search_cap_reached),
			row.indexed_static_url_count || 0,
			row.indexed_url_count || 0,
			row.pages_checked || 0,
			row.stopped_by || null,
			row.error || null,
			JSON.stringify(row.indexed_post_urls_sample || []),
			JSON.stringify(row.indexed_static_urls || []),
			JSON.stringify(row.page_samples || []),
			JSON.stringify({
				...(row.source_payload || {}),
				pageCount: row.page_count || 0,
				sitemapUrlCount: row.sitemap_url_count || 0,
				crawlSubmittedOrPresent: row.crawl_submitted_or_present || 0,
				crawlProcessedCount: row.crawl_processed_count || 0,
				crawlLastRequestedAt: row.crawl_last_requested_at || null,
				queryMode: row.query_mode || null,
				classifierVersion,
				searchCapReached: Boolean(row.search_cap_reached),
				visibleIndexedPostCount: row.visible_indexed_post_count || 0
			})
		]
	);
	await upsertIndexUrls(client, runId, row);
}

async function upsertIndexUrls(client, runId, row) {
	const indexedPostUrls = row.indexed_post_urls || row.indexed_post_urls_sample || [];
	const indexedStaticUrls = row.indexed_static_urls || [];
	const indexedUrls = [
		...indexedPostUrls.map((url) => ({
			url,
			post_id: postIdFromUrl(url),
			url_type: 'post'
		})),
		...indexedStaticUrls.map((url) => ({
			url,
			post_id: null,
			url_type: 'static'
		}))
	];

	await client.query(
		`
			delete from public.naver_index_check_urls
			where run_id = $1
				and domain = $2
		`,
		[runId, row.domain]
	);

	if (!indexedUrls.length) return;

	await client.query(
		`
			insert into public.naver_index_check_urls (
				run_id,
				group_key,
				target_project,
				domain,
				url,
				post_id,
				url_type,
				checked_at,
				source_payload,
				updated_at
			)
			select
				$1,
				$2,
				$3,
				$4,
				item.url,
				item.post_id,
				item.url_type,
				$5::timestamptz,
				$6::jsonb,
				now()
			from jsonb_to_recordset($7::jsonb) as item(url text, post_id integer, url_type text)
			on conflict (run_id, url) do update set
				group_key = excluded.group_key,
				target_project = excluded.target_project,
				domain = excluded.domain,
				post_id = excluded.post_id,
				url_type = excluded.url_type,
				checked_at = excluded.checked_at,
				source_payload = excluded.source_payload,
				updated_at = now()
		`,
		[
			runId,
			domainGroupKey,
			targetProject,
			row.domain,
			row.checked_at || new Date().toISOString(),
			JSON.stringify({
				script: 'scripts/check-naver-indexed-posts.mjs',
				queryMode: row.query_mode || null,
				classifierVersion,
				searchCapReached: Boolean(row.search_cap_reached)
			}),
			JSON.stringify(indexedUrls)
		]
	);
}

async function importJson(client, path) {
	const parsed = JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
	const startedAt = new Date(parsed.summary?.started_at || new Date());
	const results = parsed.results || [];
	const summary = {
		...summarize(results, parsed.summary?.target_domain_count || results.length, startedAt, new Date(parsed.summary?.finished_at || new Date())),
		...parsed.summary
	};
	const paths = {
		jsonPath: resolve(projectRoot, path),
		csvPath: parsed.summary?.output_csv_path || '',
		mdPath: parsed.summary?.output_md_path || ''
	};
	const runId = explicitRunId || `${runIdPrefix()}-site-index-${formatStamp(startedAt)}`;

	await upsertRun(client, {
		runId,
		status: parsed.summary?.complete === false ? 'partial' : 'succeeded',
		summary,
		paths,
		complete: parsed.summary?.complete !== false
	});

	for (const row of results) await upsertResult(client, runId, row);

	return { runId, summary, results, paths };
}

async function runCheck(client) {
	const startedAt = new Date();
	const paths = reportPaths(startedAt);
	const runId = explicitRunId || `${runIdPrefix()}-site-index-${formatStamp(startedAt)}`;
	const targets = await loadTargets(client);
	const existingRows = await loadExistingResults(client, runId);
	const versionedExistingRows = existingRows.filter((row) => row.source_payload?.classifierVersion === classifierVersion);
	const reusableExistingRows = retryErrorResults
		? versionedExistingRows.filter((row) => !row.error)
		: versionedExistingRows;
	const existingByDomain = new Map(reusableExistingRows.map((row) => [normalizeHostValue(row.domain), row]));
	const results = targets
		.map((target) => existingByDomain.get(normalizeHostValue(target.domain)))
		.filter(Boolean);
	const pendingTargets = targets.filter((target) => !existingByDomain.has(normalizeHostValue(target.domain)));
	let summary = summarize(results, targets.length, startedAt);

	console.log(JSON.stringify({
		runId,
		startedAt: startedAt.toISOString(),
		targetCount: targets.length,
		maxPages,
		requestDelayMs,
		hostDelayMs,
		delayJitterMs,
		queryModes,
		pageStarts,
		capPageFirst,
		capPageFullThreshold,
		noResultRetries,
		noResultRetryDelayMs,
		explicitHosts: Array.from(explicitHosts),
		targetLimit,
		checkConcurrency,
		effectiveCheckConcurrency,
		proxyEnabled: siteCheckHttp.enabled,
		proxyCount: siteCheckHttp.proxyCount,
		proxyTotalCount: siteCheckHttp.proxyTotalCount || siteCheckHttp.proxyCount,
		proxyReserveCount: siteCheckHttp.proxyReserveCount || 0,
		proxySource: siteCheckHttp.proxySource || null,
			proxyFile: siteCheckHttp.proxyFile || null,
			resumeExisting,
			resumedCount: results.length,
			retryErrorResults,
			retryErrorCount: retryErrorResults ? existingRows.length - reusableExistingRows.length : 0,
			pendingCount: pendingTargets.length,
		jsonPath: paths.jsonPath,
		csvPath: paths.csvPath,
		mdPath: paths.mdPath
	}, null, 2));

	await upsertRun(client, { runId, status: 'running', summary, paths, complete: false });
	saveReports({ summary, results, paths, complete: false });
	const persistRow = async (row) => {
		results.push(row);
		await upsertResult(client, runId, row);
		summary = summarize(results, targets.length, startedAt);
		await upsertRun(client, { runId, status: 'running', summary, paths, complete: false });
		saveReports({ summary, results, paths, complete: false });
		console.log(`[index-check] ${results.length}/${targets.length} ${row.domain} indexed=${row.indexed ? 'Y' : 'N'} posts=${row.indexed_post_count} static=${row.indexed_static_url_count} pages=${row.pages_checked} stop=${row.stopped_by}${row.error ? ` error=${row.error}` : ''} totalPosts=${summary.indexed_post_total}`);
	};
	let persistQueue = Promise.resolve();
	const queuePersistRow = (row) => {
		persistQueue = persistQueue.then(() => persistRow(row));
		return persistQueue;
	};

	let complete = false;
	try {
		let nextPendingIndex = 0;
		const workerCount = Math.min(effectiveCheckConcurrency, pendingTargets.length || 1);
		await Promise.all(Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextPendingIndex;
				nextPendingIndex += 1;
				if (index >= pendingTargets.length) break;
				const target = pendingTargets[index];
				try {
					const row = await checkHost(target);
					await queuePersistRow(row);
				} catch (error) {
					await queuePersistRow(checkErrorResult(target, error));
				}
				if (index < pendingTargets.length - 1) await sleepWithJitter(hostDelayMs);
			}
		}));
		await persistQueue;
		complete = true;
		summary = summarize(results, targets.length, startedAt);
		await upsertRun(client, {
			runId,
			status: summary.error_domain_count > 0 ? 'partial' : 'succeeded',
			summary,
			paths,
			error: summary.error_domain_count > 0 ? `${summary.error_domain_count} domain(s) failed` : null,
			complete
		});
		saveReports({ summary, results, paths, complete });
	} catch (error) {
		summary = summarize(results, targets.length, startedAt);
		await upsertRun(client, {
			runId,
			status: results.length > 0 ? 'partial' : 'failed',
			summary,
			paths,
			error: error.message,
			complete: false
		});
		saveReports({ summary, results, paths, complete: false });
		throw error;
	}

	return { runId, summary, results, paths };
}

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	await ensureSchema(client);
	await applyGroupConfig(client);
	const outcome = importJsonPath
		? await importJson(client, importJsonPath)
		: await runCheck(client);
	console.log(JSON.stringify({
		runId: outcome.runId,
		summary: outcome.summary,
		paths: outcome.paths
	}, null, 2));
	if ((outcome.summary?.error_domain_count || 0) > 0) {
		process.exitCode = 1;
	}
} finally {
	await client.end();
}
