import { createSign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const projectRoot = process.cwd();
const schemaPath = resolve(projectRoot, 'supabase/migrations/20260630093000_create_naver_index_check_registry.sql');

loadLocalEnv(`${projectRoot}/.env`);

const explicitRunId = getArgValue('--run-id')
	|| process.env.NAVER_INDEX_CHECK_RUN_ID
	|| '';
const forceBootstrap = process.env.NAVER_INDEX_FORCE_BOOTSTRAP === '1';
const shareEmails = splitEnv(process.env.NAVER_INDEX_GOOGLE_SHEET_SHARE_EMAILS || '');
const skipIfUnconfigured = process.env.NAVER_INDEX_GOOGLE_SHEET_SKIP_IF_UNCONFIGURED !== '0';
const allowPartialRun = process.env.NAVER_INDEX_GOOGLE_SHEET_ALLOW_PARTIAL !== '0';
const dryRun = process.env.NAVER_INDEX_GOOGLE_SHEET_DRY_RUN === '1';
const allowBootstrapOnMissingRun = process.env.NAVER_INDEX_ALLOW_BOOTSTRAP_ON_MISSING_RUN === '1';
const updateCrawlValues = process.env.NAVER_INDEX_GOOGLE_SHEET_UPDATE_CRAWL !== '0';
const ignoreGroupHostSuffix = process.env.NAVER_INDEX_IGNORE_GROUP_HOST_SUFFIX === '1';
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const targetPageCount = numberEnv('NAVER_INDEX_PAGE_COUNT', numberEnv('NAVER_INDEX_NUMERIC_PAGE_COUNT', 2750));
let domainGroupKey = getArgValue('--group') || process.env.NAVER_INDEX_GROUP_KEY || process.env.NAVER_INDEX_DOMAIN_GROUP_KEY || '';
let targetProject = process.env.NAVER_INDEX_TARGET_PROJECT || '';
let deploymentAccountIds = splitEnv(process.env.NAVER_INDEX_DEPLOYMENT_ACCOUNT_IDS || '');
let targetHostSuffix = normalizeHostSuffix(process.env.NAVER_INDEX_HOST_SUFFIX || '');
let targetDomainKind = normalizeDomainKind(process.env.NAVER_INDEX_DOMAIN_KIND || '');
let tableProject = process.env.NAVER_INDEX_TABLE_PROJECT || '';
let sheetStatePath = '';
let sheetState = {};
let sheetId = '';
let spreadsheetTitle = '';
let sheetName = '';
let reportTitle = '';

function getArgValue(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return '';
	return process.argv[index + 1] || '';
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

function splitEnv(value) {
	return String(value || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function numberEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isFinite(value) ? value : fallback;
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

function loadSheetState(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return {};
	}
}

function saveSheetState(data) {
	mkdirSync(dirname(sheetStatePath), { recursive: true });
	writeFileSync(sheetStatePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function applyGroupConfig(client) {
	if (!domainGroupKey) {
		throw new Error('NAVER_INDEX_GROUP_KEY or NAVER_INDEX_DOMAIN_GROUP_KEY is required.');
	}

	const { rows } = await client.query(
		`
			select group_key, target_project, spreadsheet_id, sheet_title, sheet_name, display_name, settings
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
	if (!ignoreGroupHostSuffix) {
		targetHostSuffix = targetHostSuffix || normalizeHostSuffix(settings.hostSuffix || settings.domainRoot || '');
	}
	if (deploymentAccountIds.length === 0 && Array.isArray(settings.accountIds)) {
		deploymentAccountIds = settings.accountIds.map((item) => String(item)).filter(Boolean);
	}

	sheetStatePath = resolve(
		projectRoot,
		process.env.NAVER_INDEX_GOOGLE_SHEET_STATE_PATH
			|| settings.spreadsheetStatePath
			|| `reports/naver-site-search/${runIdPrefix()}-index-google-sheet.json`
	);
	sheetState = loadSheetState(sheetStatePath);
	sheetId = process.env.NAVER_INDEX_GOOGLE_SHEET_ID || group.spreadsheet_id || sheetState.sheetId || '';
	sheetName = process.env.NAVER_INDEX_GOOGLE_SHEET_NAME || group.sheet_name || sheetState.sheetName || domainGroupKey;
	spreadsheetTitle = process.env.NAVER_INDEX_GOOGLE_SHEET_TITLE || group.sheet_title || sheetState.title || `${sheetName} 네이버 색인 현황`;
	reportTitle = process.env.NAVER_INDEX_REPORT_TITLE || group.sheet_title || `${sheetName} 네이버 색인 현황`;

	if (!targetProject) throw new Error(`target_project is missing for group: ${domainGroupKey}`);
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

function loadServiceAccount() {
	const rawJson = process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON
		|| process.env.GOOGLE_SERVICE_ACCOUNT_JSON
		|| '';
	if (rawJson) return JSON.parse(rawJson);

	const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
		|| process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE
		|| '';
	if (credentialsPath) return JSON.parse(readFileSync(credentialsPath, 'utf8'));

	return null;
}

function base64Url(value) {
	return Buffer.from(value)
		.toString('base64')
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

async function getAccessToken(serviceAccount) {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claim = {
		iss: serviceAccount.client_email,
		scope: [
			'https://www.googleapis.com/auth/spreadsheets',
			'https://www.googleapis.com/auth/drive'
		].join(' '),
		aud: 'https://oauth2.googleapis.com/token',
		exp: now + 3600,
		iat: now
	};
	const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
	const signer = createSign('RSA-SHA256');
	signer.update(unsigned);
	const signature = signer.sign(serviceAccount.private_key, 'base64')
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
	const assertion = `${unsigned}.${signature}`;

	const response = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion
		})
	});
	const payload = await response.json();
	if (!response.ok) throw new Error(`Google OAuth failed status=${response.status} body=${JSON.stringify(payload)}`);
	return payload.access_token;
}

async function requestJson(url, { token, method = 'GET', body = null }) {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await response.text();
	const payload = text ? JSON.parse(text) : {};
	if (!response.ok) throw new Error(`Google API failed status=${response.status} body=${text}`);
	return payload;
}

async function googleFetch(path, { token, method = 'GET', body = null }) {
	if (!sheetId) throw new Error('Google Sheet ID is not set.');
	return requestJson(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, { token, method, body });
}

async function createSpreadsheet(token) {
	const payload = await requestJson('https://sheets.googleapis.com/v4/spreadsheets', {
		token,
		method: 'POST',
		body: {
			properties: { title: spreadsheetTitle },
			sheets: [{ properties: { title: sheetName } }]
		}
	});
	sheetId = payload.spreadsheetId;
	const state = {
		sheetId,
		sheetName,
		title: spreadsheetTitle,
		spreadsheetUrl: payload.spreadsheetUrl,
		createdAt: new Date().toISOString()
	};
	saveSheetState(state);
	return state;
}

async function ensureSpreadsheet(token) {
	if (sheetId) {
		let metadata = await googleFetch('?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))', { token });
		const hasSheet = metadata.sheets?.some((item) => item.properties?.title === sheetName);
		if (!hasSheet) {
			await googleFetch(':batchUpdate', {
				token,
				method: 'POST',
				body: {
					requests: [
						{
							addSheet: {
								properties: { title: sheetName }
							}
						}
					]
				}
			});
			metadata = await googleFetch('?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))', { token });
		}
		saveSheetState({
			...sheetState,
			sheetId,
			sheetName,
			title: metadata.properties?.title || spreadsheetTitle,
			spreadsheetUrl: metadata.spreadsheetUrl,
			checkedAt: new Date().toISOString()
		});
		return {
			sheetId,
			sheetName,
			title: metadata.properties?.title || spreadsheetTitle,
			spreadsheetUrl: metadata.spreadsheetUrl
		};
	}
	return createSpreadsheet(token);
}

async function shareSpreadsheet(token, emails) {
	if (!emails.length) return [];
	const shared = [];
	for (const email of emails) {
		try {
			const permission = await requestJson(
				`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?sendNotificationEmail=false`,
				{
					token,
					method: 'POST',
					body: {
						type: 'user',
						role: 'writer',
						emailAddress: email
					}
				}
			);
			shared.push({ email, permissionId: permission.id || null, status: 'shared' });
		} catch (error) {
			shared.push({ email, permissionId: null, status: 'skipped', error: error.message });
		}
	}
	return shared;
}

function sheetRange(range) {
	return `'${sheetName.replaceAll("'", "''")}'!${range}`;
}

function kst(value) {
	const date = new Date(value);
	return new Intl.DateTimeFormat('ko-KR', {
		timeZone: 'Asia/Seoul',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	}).format(date);
}

async function loadIndexRun(client) {
	if (forceBootstrap) return loadBootstrapIndexRun(client);

	let runSql = explicitRunId
		? `
			select *
			from public.naver_index_check_runs
			where run_id = $1
				and group_key = $2
			limit 1
		`
		: `
			select *
			from public.naver_index_check_runs
			where status in ('succeeded', 'partial')
				and group_key = $1
				and target_project = $2
			order by finished_at desc nulls last, updated_at desc
			limit 1
		`;
	let runValues = explicitRunId ? [explicitRunId, domainGroupKey] : [domainGroupKey, targetProject];
	const runResult = await client.query(runSql, runValues);
	const run = runResult.rows[0];
	if (!run) {
		if (explicitRunId) throw new Error(`index check run not found: ${explicitRunId}`);
		if (allowBootstrapOnMissingRun) return loadBootstrapIndexRun(client);
		throw new Error(`completed index check run not found for group=${domainGroupKey} targetProject=${targetProject}`);
	}
	if (!allowPartialRun && run.status !== 'succeeded') {
		throw new Error(`refusing to update sheet from non-succeeded index check run: ${run.run_id} status=${run.status}`);
	}
	return loadRegistryIndexRun(client, run);
}

async function loadRegistryIndexRun(client, run) {
	const result = await client.query(
		`
			with target_rows as (
				select distinct on (target.host)
					target.host as domain,
					target.site_url,
					target.naver_account_id as city_slug,
					coalesce(target.region_label, target.area_name, target.display_name) as region_label,
					coalesce(nullif(target.page_count, 0), $2)::integer as page_count,
					target.sitemap_url_count,
					target.deployed_at,
					null::timestamptz as updated_at
				from public.naver_index_check_target_domains target
				where target.group_key = $4
					and target.target_project = $3
					and (coalesce(array_length($5::text[], 1), 0) = 0 or target.naver_account_id = any($5::text[]))
					and (
						$6::text = 'all'
						or ($6::text = 'netlify' and lower(target.host) like '%.netlify.app')
						or ($6::text = 'non-netlify' and lower(target.host) not like '%.netlify.app')
					)
					and (
						$7::text = ''
						or lower(target.host) = $7::text
						or lower(target.host) like concat('%.', $7::text)
					)
				order by target.host, target.deployed_at desc nulls last
			),
			crawl as (
				select
					latest.host,
					count(*) filter (where latest.status in ('submitted', 'already-present'))::integer as crawl_submitted_or_present,
					count(*)::integer as crawl_processed_count,
					max(latest.requested_at) as crawl_last_requested_at
				from (
					select distinct on (result.host, result.url)
						result.host,
						result.url,
						result.status,
						result.requested_at,
						result.id
					from public.naver_searchadvisor_crawl_request_results result
					join public.naver_searchadvisor_crawl_request_runs run
						on run.run_id = result.run_id
					join target_rows target
						on target.domain = result.host
					where $8::boolean
						and run.target_project = $3
					order by result.host, result.url, result.requested_at desc, result.id desc
				) latest
				group by latest.host
			),
			deployments as (
				select
					target.domain,
					target.site_url,
					target.city_slug,
					target.region_label,
					target.page_count,
					target.sitemap_url_count,
					target.deployed_at,
					target.updated_at,
					coalesce(crawl.crawl_submitted_or_present, 0)::integer as crawl_submitted_or_present,
					coalesce(crawl.crawl_processed_count, 0)::integer as crawl_processed_count,
					crawl.crawl_last_requested_at
				from target_rows target
				left join crawl
					on crawl.host = target.domain
				order by target.domain
			)
			select
				deployments.domain,
				deployments.region_label,
				deployments.page_count,
				coalesce(effective_result.indexed_post_count, 0)::integer as indexed_post_count,
				coalesce(effective_result.indexed_static_url_count, 0)::integer as indexed_static_url_count,
				coalesce(effective_result.source_payload, '{}'::jsonb) || jsonb_build_object(
					'checked', current_result.id is not null and current_result.error is null,
					'partialFallback', current_result.error is not null and effective_result.run_id is distinct from current_result.run_id,
					'currentRunError', current_result.error,
					'crawlSubmittedOrPresent', deployments.crawl_submitted_or_present,
					'crawlProcessedCount', deployments.crawl_processed_count,
					'crawlLastRequestedAt', deployments.crawl_last_requested_at,
					'searchCapReached', coalesce(effective_result.search_cap_reached, false)
				) as source_payload
			from deployments
			left join public.naver_index_check_results current_result
				on current_result.run_id = $1
				and current_result.domain = deployments.domain
			left join lateral (
				(
					select current_result.*, 0 as priority
					where current_result.id is not null
						and current_result.error is null
				)
				union all
				(
					select previous_result.*, 1 as priority
					from public.naver_index_check_results previous_result
					join public.naver_index_check_runs previous_run
						on previous_run.run_id = previous_result.run_id
					where previous_result.group_key = $4
						and previous_result.domain = deployments.domain
						and previous_result.error is null
						and previous_result.run_id <> $1
						and previous_run.status in ('succeeded', 'partial')
					order by previous_result.checked_at desc, previous_result.id desc
					limit 1
				)
				order by priority
				limit 1
			) effective_result on true
			order by deployments.domain
		`,
		[
			run.run_id,
			targetPageCount,
			targetProject,
			domainGroupKey,
			deploymentAccountIds,
			targetDomainKind,
			targetHostSuffix,
			updateCrawlValues
		]
	);
	return { run, results: result.rows };
}

async function loadBootstrapIndexRun(client) {
	const result = await client.query(
		`
			with target_rows as (
				select distinct on (target.host)
					target.host as domain,
					coalesce(target.region_label, target.area_name, target.display_name) as region_label,
					coalesce(nullif(target.page_count, 0), $1)::integer as page_count,
					target.run_order
				from public.naver_index_check_target_domains target
				where target.group_key = $3
					and target.target_project = $2
					and (coalesce(array_length($4::text[], 1), 0) = 0 or target.naver_account_id = any($4::text[]))
					and (
						$5::text = 'all'
						or ($5::text = 'netlify' and lower(target.host) like '%.netlify.app')
						or ($5::text = 'non-netlify' and lower(target.host) not like '%.netlify.app')
					)
					and (
						$6::text = ''
						or lower(target.host) = $6::text
						or lower(target.host) like concat('%.', $6::text)
					)
				order by target.host, target.deployed_at desc nulls last
			),
			crawl as (
				select
					latest.host,
					count(*) filter (where latest.status in ('submitted', 'already-present'))::integer as crawl_submitted_or_present,
					count(*)::integer as crawl_processed_count,
					max(latest.requested_at) as crawl_last_requested_at
				from (
					select distinct on (result.host, result.url)
						result.host,
						result.url,
						result.status,
						result.requested_at,
						result.id
					from public.naver_searchadvisor_crawl_request_results result
					join public.naver_searchadvisor_crawl_request_runs run
						on run.run_id = result.run_id
					join target_rows target
						on target.domain = result.host
					where $7::boolean
						and run.target_project = $2
					order by result.host, result.url, result.requested_at desc, result.id desc
				) latest
				group by latest.host
				)
				select
					target.domain,
					target.region_label,
				target.page_count,
				0::integer as indexed_post_count,
				jsonb_build_object(
					'checked', false,
					'bootstrap', true,
					'crawlSubmittedOrPresent', coalesce(crawl.crawl_submitted_or_present, 0),
					'crawlProcessedCount', coalesce(crawl.crawl_processed_count, 0),
					'crawlLastRequestedAt', crawl.crawl_last_requested_at,
					'searchCapReached', false
				) as source_payload
				from target_rows target
				left join crawl
					on crawl.host = target.domain
				order by target.run_order, target.domain
			`,
			[
				targetPageCount,
				targetProject,
				domainGroupKey,
				deploymentAccountIds,
				targetDomainKind,
				targetHostSuffix,
				updateCrawlValues
			]
		);
	const now = new Date().toISOString();
	return {
		run: {
			run_id: `${runIdPrefix()}-sheet-bootstrap`,
			status: 'partial',
			finished_at: now,
			updated_at: now,
			target_domain_count: result.rows.length,
			indexed_domain_count: 0,
			not_indexed_domain_count: result.rows.length,
			indexed_post_total: 0
		},
		results: result.rows
	};
}

function buildRows({ run, results }) {
	const totalPages = results.reduce((sum, row) => sum + Number(row.page_count || 0), 0);
	const totalCrawl = results.reduce((sum, row) => (
		sum + Number(row.source_payload?.crawlSubmittedOrPresent || 0)
	), 0);
	const searchCapReachedDomainCount = results.filter((row) => row.source_payload?.searchCapReached).length;
	const indexedDomainCount = results.filter((row) => (
		Number(row.indexed_post_count || 0) > 0 || Number(row.indexed_static_url_count || 0) > 0
	)).length;
	const indexedPostTotal = results.reduce((sum, row) => sum + Number(row.indexed_post_count || 0), 0);
	const rows = [
		[reportTitle],
		['마지막 갱신(KST)', kst(new Date())],
		['확인 기준', 'site:https://도메인/'],
		['전체 도메인수', results.length],
		['색인 확인 도메인수', indexedDomainCount],
		['미색인 도메인수', results.length - indexedDomainCount],
		['전체 페이지수', totalPages],
		['수집요청 완료 페이지수', totalCrawl],
		['색인 페이지수', indexedPostTotal],
		['10페이지 상한 도메인수', searchCapReachedDomainCount],
		['비고', `${sheetName} 탭입니다. 네이버 검색 결과가 10페이지까지 꽉 찬 도메인은 수집요청 완료 페이지수 기준으로 색인 페이지수를 반영했습니다.`],
		[],
		['No', '지역', '도메인', '페이지수', '수집요청 완료', '색인 페이지수']
	];
	results.forEach((row, index) => {
		rows.push([
			index + 1,
			row.region_label || '',
			domainLink(row.domain),
			Number(row.page_count || 0),
			Number(row.source_payload?.crawlSubmittedOrPresent || 0),
			Number(row.indexed_post_count || 0)
		]);
	});
	return rows;
}

function domainLink(domain) {
	const host = normalizeHostValue(domain);
	if (!host) return '';
	const url = `https://${host}`;
	return `=HYPERLINK("${url.replaceAll('"', '""')}","${host.replaceAll('"', '""')}")`;
}

async function loadExistingSheetRows(token) {
	try {
		const payload = await googleFetch(`/values/${encodeURIComponent(sheetRange('A:Z'))}`, { token });
		return payload.values || [];
	} catch (error) {
		console.warn(`[sheet] could not load existing rows to preserve crawl values: ${error.message}`);
		return [];
	}
}

function applyExistingCrawlValues(rows, existingRows) {
	if (!existingRows.length) return rows;

	const summaryRow = existingRows.find((row) => String(row?.[0] || '').trim() === '수집요청 완료 페이지수');
	const nextSummaryRow = rows.find((row) => String(row?.[0] || '').trim() === '수집요청 완료 페이지수');
	if (summaryRow && nextSummaryRow && summaryRow[1] !== undefined) {
		nextSummaryRow[1] = summaryRow[1];
	}

	const headerIndex = existingRows.findIndex((row) => (
		String(row?.[2] || '').trim() === '도메인'
		&& String(row?.[4] || '').trim() === '수집요청 완료'
	));
	if (headerIndex < 0) return rows;

	const crawlByDomain = new Map();
	for (const row of existingRows.slice(headerIndex + 1)) {
		const host = extractDomainFromSheetCell(row?.[2]);
		if (!host) continue;
		crawlByDomain.set(host, row?.[4] ?? '');
	}

	for (const row of rows) {
		const host = extractDomainFromSheetCell(row?.[2]);
		if (!host || !crawlByDomain.has(host)) continue;
		row[4] = crawlByDomain.get(host);
	}

	return rows;
}

function extractDomainFromSheetCell(value) {
	const text = String(value || '').trim();
	if (!text) return '';
	const urlMatch = text.match(/https?:\/\/([^/",)]+)/i);
	if (urlMatch) return normalizeHostValue(urlMatch[1]);
	const formulaLabelMatch = text.match(/,\s*"([^"]+)"\s*\)$/);
	if (formulaLabelMatch) return normalizeHostValue(formulaLabelMatch[1]);
	return normalizeHostValue(text);
}

async function updateSheet(rows, token) {
	await googleFetch(`/values/${encodeURIComponent(sheetRange('A:Z'))}:clear`, {
		token,
		method: 'POST',
		body: {}
	});
	const updateResult = await googleFetch(`/values/${encodeURIComponent(sheetRange('A1'))}?valueInputOption=USER_ENTERED`, {
		token,
		method: 'PUT',
		body: { values: rows }
	});

	const metadata = await googleFetch('?fields=sheets(properties(sheetId,title))', { token });
	const sheet = metadata.sheets?.find((item) => item.properties?.title === sheetName);
	if (sheet) {
		const sheetIdNumber = sheet.properties.sheetId;
		await googleFetch(':batchUpdate', {
			token,
			method: 'POST',
			body: {
				requests: [
					{
						updateSheetProperties: {
							properties: { sheetId: sheetIdNumber, gridProperties: { frozenRowCount: 13 } },
							fields: 'gridProperties.frozenRowCount'
						}
					},
					{
						repeatCell: {
							range: { sheetId: sheetIdNumber, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
							cell: { userEnteredFormat: { textFormat: { bold: true } } },
							fields: 'userEnteredFormat.textFormat.bold'
						}
					},
					{
						repeatCell: {
							range: { sheetId: sheetIdNumber, startRowIndex: 12, endRowIndex: 13, startColumnIndex: 0, endColumnIndex: 6 },
							cell: { userEnteredFormat: { textFormat: { bold: true } } },
							fields: 'userEnteredFormat.textFormat.bold'
						}
					},
					{
						autoResizeDimensions: {
							dimensions: { sheetId: sheetIdNumber, dimension: 'COLUMNS', startIndex: 0, endIndex: 6 }
						}
					}
				]
			}
		});
	}
	return updateResult;
}

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	await ensureSchema(client);
	await applyGroupConfig(client);
	const indexRun = await loadIndexRun(client);
	const rows = buildRows(indexRun);
	if (dryRun) {
		console.log(JSON.stringify({
			ok: true,
			dryRun: true,
			runId: indexRun.run.run_id,
			groupKey: domainGroupKey,
			targetProject,
			sheetId,
			sheetName,
			rowCount: rows.length,
			firstRows: rows.slice(0, 15)
		}, null, 2));
	} else {
		const serviceAccount = loadServiceAccount();
		if (!serviceAccount) {
			const message = 'Google Sheets service account credentials are not configured; skipped sheet update.';
			if (skipIfUnconfigured) {
				console.log(JSON.stringify({ ok: true, skipped: true, reason: message, groupKey: domainGroupKey, sheetName }));
			} else {
				throw new Error(message);
			}
		} else {
			const token = await getAccessToken(serviceAccount);
			const spreadsheet = await ensureSpreadsheet(token);
			const shared = await shareSpreadsheet(token, shareEmails);
			if (!updateCrawlValues) {
				applyExistingCrawlValues(rows, await loadExistingSheetRows(token));
			}
			const updateResult = await updateSheet(rows, token);
			saveSheetState({
				...sheetState,
				...spreadsheet,
				shareEmails,
				lastRunId: indexRun.run.run_id,
				lastUpdatedAt: new Date().toISOString()
			});
			console.log(JSON.stringify({
				ok: true,
				runId: indexRun.run.run_id,
				sheetId,
				sheetName,
				spreadsheetUrl: spreadsheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
				shared,
				crawlValuesUpdated: updateCrawlValues,
				rowCount: rows.length,
				updatedRange: updateResult.updatedRange || null
			}, null, 2));
		}
	}
} finally {
	await client.end();
}

async function ensureSchema(client) {
	await client.query(readFileSync(schemaPath, 'utf8'));
}
