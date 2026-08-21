import { hostname } from 'node:os';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

export function buildCrawlRunId(reportPath) {
	return path.basename(reportPath).replace(/\.json(?:\.[^.]+)?$/, '');
}

export async function connectCrawlRequestDb({ env = process.env } = {}) {
	const connectionString = env.DATABASE_URL || env.DIRECT_URL;
	if (!connectionString) return null;

	const client = new Client(dbConfig(connectionString));
	await client.connect();
	// 역할 기본 2분은 DB 혼잡 시 부족하다. config 는 서버에 안 닿는다 — SET 으로 (2026-08-21).
	await client.query(`set statement_timeout = '600s'`);
	return client;
}

export async function upsertCrawlRequestRun(client, {
	runId,
	targetProject = 'watermelon-piping',
	triggerType = 'manual',
	status = 'running',
	options = {},
	report = {},
	queueDoc = {},
	error = null,
	sourcePayload = {}
}) {
	const summary = summarizeReport(report);
	const firstResultAt = firstTimestamp(report.results);
	const lastResultAt = lastTimestamp(report.results);
	const startedAt = firstResultAt || report.updatedAt || new Date().toISOString();
	const finishedAt = status === 'running'
		? null
		: lastResultAt || report.updatedAt || new Date().toISOString();

	await client.query(
		`
			insert into public.naver_searchadvisor_crawl_request_runs (
				run_id,
				target_project,
				account_id,
				trigger_type,
				status,
				queue_path,
				report_path,
				queue_order,
				submit_mode,
				dry_run,
				headless,
				batch_size,
				concurrency,
				next_index,
				total_tasks,
				processed_count,
				submitted_count,
				already_present_count,
				submitted_or_present_count,
				skipped_missing_count,
				skipped_reserved_path_count,
				quota_stop_count,
				failed_count,
				unknown_count,
				blocked_count,
				host_quota_stop_count,
				started_at,
				finished_at,
				last_result_at,
				runner_host,
				runner_cwd,
				error,
				source_payload,
				updated_at
			)
			values (
				$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
				$14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
				$25, $26, $27::timestamptz, $28::timestamptz, $29::timestamptz,
				$30, $31, $32, $33::jsonb, now()
			)
			on conflict (run_id) do update set
				target_project = excluded.target_project,
				account_id = excluded.account_id,
				trigger_type = excluded.trigger_type,
				status = excluded.status,
				queue_path = excluded.queue_path,
				report_path = excluded.report_path,
				queue_order = excluded.queue_order,
				submit_mode = excluded.submit_mode,
				dry_run = excluded.dry_run,
				headless = excluded.headless,
				batch_size = excluded.batch_size,
				concurrency = excluded.concurrency,
				next_index = excluded.next_index,
				total_tasks = excluded.total_tasks,
				processed_count = excluded.processed_count,
				submitted_count = excluded.submitted_count,
				already_present_count = excluded.already_present_count,
				submitted_or_present_count = excluded.submitted_or_present_count,
				skipped_missing_count = excluded.skipped_missing_count,
				skipped_reserved_path_count = excluded.skipped_reserved_path_count,
				quota_stop_count = excluded.quota_stop_count,
				failed_count = excluded.failed_count,
				unknown_count = excluded.unknown_count,
				blocked_count = excluded.blocked_count,
				host_quota_stop_count = excluded.host_quota_stop_count,
				started_at = coalesce(public.naver_searchadvisor_crawl_request_runs.started_at, excluded.started_at),
				finished_at = excluded.finished_at,
				last_result_at = excluded.last_result_at,
				runner_host = excluded.runner_host,
				runner_cwd = excluded.runner_cwd,
				error = excluded.error,
				source_payload = excluded.source_payload,
				updated_at = now()
		`,
		[
			runId,
			targetProject,
			options.accountId || report.account || '',
			triggerType,
			status,
			options.queuePath || '',
			options.reportPath || '',
			report.order || queueDoc.order || options.queueOrder || '',
			options.submitMode || '',
			Boolean(options.dryRun),
			Boolean(options.headless),
			options.batchSize || null,
			options.concurrency || null,
			Number.isInteger(report.nextIndex) ? report.nextIndex : 0,
			Number.isInteger(report.totalTasks) ? report.totalTasks : 0,
			summary.processed,
			summary.submitted,
			summary.alreadyPresent,
			summary.submittedOrPresent,
			summary.skippedMissing,
			summary.skippedReservedPath,
			summary.quotaStop,
			summary.failed,
			summary.unknown,
			summary.blocked,
			Object.keys(report.hostQuotaStops || {}).length,
			startedAt,
			finishedAt,
			lastResultAt,
			hostname(),
			process.cwd(),
			error,
			JSON.stringify({
				queueSeed: queueDoc.seed || report.seed || null,
				hostQuotaStops: report.hostQuotaStops || {},
				...sourcePayload
			})
		]
	);
}

export async function upsertCrawlRequestResults(client, {
	runId,
	rows,
	startIndex = 0
}) {
	if (!rows.length) return;

	const payload = rows.map((row, offset) => ({
		result_index: startIndex + offset,
		account: row.account || null,
		host: row.host || hostFromUrl(row.url),
		post_id: Number.isInteger(row.postId) ? row.postId : null,
		page_domain_id: integerOrNull(row.pageDomainId ?? row.domainId),
		page_request_id: integerOrNull(row.pageRequestId),
		url: row.url,
		status: row.status,
		note: row.note || null,
		requested_at: row.at || new Date().toISOString(),
		mode: row.mode || null,
		api_code: Number.isInteger(row.apiCode) ? row.apiCode : null,
		api_message: row.apiMessage || null,
		api_response: row.apiResponse || null
	}));

	await client.query(
		`
			with incoming as (
				select *
				from jsonb_to_recordset($2::jsonb) as row_data (
					result_index integer,
					account text,
					host text,
					post_id integer,
					page_domain_id bigint,
					page_request_id integer,
					url text,
					status text,
					note text,
					requested_at text,
					mode text,
					api_code integer,
					api_message text,
					api_response text
				)
				), upserted as (
			insert into public.naver_searchadvisor_crawl_request_results (
				run_id,
				result_index,
				account,
				host,
				post_id,
				page_domain_id,
				page_request_id,
				url,
				status,
				note,
				requested_at,
				mode,
				api_code,
				api_message,
				api_response,
				updated_at
			)
			select
				$1,
				result_index,
				account,
				host,
				post_id,
				page_domain_id,
				page_request_id,
				url,
				status,
				note,
				coalesce(nullif(requested_at, '')::timestamptz, now()),
				mode,
				api_code,
				api_message,
				api_response,
				now()
			from incoming
			on conflict (run_id, result_index) do update set
				account = excluded.account,
				host = excluded.host,
				post_id = excluded.post_id,
				page_domain_id = excluded.page_domain_id,
				page_request_id = excluded.page_request_id,
				url = excluded.url,
				status = excluded.status,
				note = excluded.note,
				requested_at = excluded.requested_at,
				mode = excluded.mode,
				api_code = excluded.api_code,
				api_message = excluded.api_message,
				api_response = excluded.api_response,
				updated_at = now()
			returning
				id,
				run_id,
				account,
				status,
				requested_at,
				page_domain_id,
				page_request_id
			)
			insert into public.naver_project_page_crawl_state (
				domain_id,
				request_id,
				last_result_id,
				last_run_id,
				last_account_id,
				last_status,
				last_attempt_at,
				last_done_result_id,
				last_done_run_id,
				last_done_at,
				last_success_result_id,
				last_success_run_id,
				last_success_at,
				updated_at
			)
			select
				page_domain_id,
				page_request_id,
				id,
				run_id,
				account,
				status,
				requested_at,
				case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then id end,
				case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then run_id end,
				case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then requested_at end,
				case when status in ('submitted', 'already-present') then id end,
				case when status in ('submitted', 'already-present') then run_id end,
				case when status in ('submitted', 'already-present') then requested_at end,
				now()
			from upserted
			where page_domain_id is not null
			  and page_request_id is not null
			on conflict (domain_id, request_id) do update set
				last_result_id = case
					when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz)
					then excluded.last_result_id else public.naver_project_page_crawl_state.last_result_id end,
				last_run_id = case
					when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz)
					then excluded.last_run_id else public.naver_project_page_crawl_state.last_run_id end,
				last_account_id = case
					when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz)
					then excluded.last_account_id else public.naver_project_page_crawl_state.last_account_id end,
				last_status = case
					when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz)
					then excluded.last_status else public.naver_project_page_crawl_state.last_status end,
				last_attempt_at = greatest(public.naver_project_page_crawl_state.last_attempt_at, excluded.last_attempt_at),
				last_done_result_id = case
					when excluded.last_done_at >= coalesce(public.naver_project_page_crawl_state.last_done_at, '-infinity'::timestamptz)
					then excluded.last_done_result_id else public.naver_project_page_crawl_state.last_done_result_id end,
				last_done_run_id = case
					when excluded.last_done_at >= coalesce(public.naver_project_page_crawl_state.last_done_at, '-infinity'::timestamptz)
					then excluded.last_done_run_id else public.naver_project_page_crawl_state.last_done_run_id end,
				last_done_at = greatest(public.naver_project_page_crawl_state.last_done_at, excluded.last_done_at),
				last_success_result_id = case
					when excluded.last_success_at >= coalesce(public.naver_project_page_crawl_state.last_success_at, '-infinity'::timestamptz)
					then excluded.last_success_result_id else public.naver_project_page_crawl_state.last_success_result_id end,
				last_success_run_id = case
					when excluded.last_success_at >= coalesce(public.naver_project_page_crawl_state.last_success_at, '-infinity'::timestamptz)
					then excluded.last_success_run_id else public.naver_project_page_crawl_state.last_success_run_id end,
				last_success_at = greatest(public.naver_project_page_crawl_state.last_success_at, excluded.last_success_at),
				updated_at = now()
		`,
		[runId, JSON.stringify(payload)]
	);
}

export async function hydrateCrawlResultPageLinks(client, rows) {
	const payload = rows
		.map((row) => ({
			result_id: integerOrNull(row.resultId ?? row.id),
			page_domain_id: integerOrNull(row.pageDomainId ?? row.domainId),
			page_request_id: integerOrNull(row.pageRequestId),
		}))
		.filter((row) => row.result_id && row.page_domain_id && row.page_request_id);
	if (!payload.length) return 0;

	const result = await client.query(
		`
			with links as (
				select *
				from jsonb_to_recordset($1::jsonb) as row_data (
					result_id bigint,
					page_domain_id bigint,
					page_request_id integer
				)
			), updated as (
				update public.naver_searchadvisor_crawl_request_results result
				set
					page_domain_id = links.page_domain_id,
					page_request_id = links.page_request_id,
					updated_at = now()
				from links
				where result.id = links.result_id
				  and (result.page_domain_id is null or result.page_request_id is null)
				returning
					result.id,
					result.run_id,
					result.account,
					result.status,
					result.requested_at,
					result.page_domain_id,
					result.page_request_id
			), linked as (
				select * from updated
				union all
				select
					result.id,
					result.run_id,
					result.account,
					result.status,
					result.requested_at,
					result.page_domain_id,
					result.page_request_id
				from public.naver_searchadvisor_crawl_request_results result
				join links on links.result_id = result.id
				where result.page_domain_id = links.page_domain_id
				  and result.page_request_id = links.page_request_id
				  and not exists (select 1 from updated where updated.id = result.id)
			), state_rows as (
				insert into public.naver_project_page_crawl_state (
					domain_id,
					request_id,
					last_result_id,
					last_run_id,
					last_account_id,
					last_status,
					last_attempt_at,
					last_done_result_id,
					last_done_run_id,
					last_done_at,
					last_success_result_id,
					last_success_run_id,
					last_success_at,
					updated_at
				)
				select
					page_domain_id,
					page_request_id,
					id,
					run_id,
					account,
					status,
					requested_at,
					case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then id end,
					case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then run_id end,
					case when status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path') then requested_at end,
					case when status in ('submitted', 'already-present') then id end,
					case when status in ('submitted', 'already-present') then run_id end,
					case when status in ('submitted', 'already-present') then requested_at end,
					now()
				from linked
				on conflict (domain_id, request_id) do update set
					last_result_id = case when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz) then excluded.last_result_id else public.naver_project_page_crawl_state.last_result_id end,
					last_run_id = case when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz) then excluded.last_run_id else public.naver_project_page_crawl_state.last_run_id end,
					last_account_id = case when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz) then excluded.last_account_id else public.naver_project_page_crawl_state.last_account_id end,
					last_status = case when excluded.last_attempt_at >= coalesce(public.naver_project_page_crawl_state.last_attempt_at, '-infinity'::timestamptz) then excluded.last_status else public.naver_project_page_crawl_state.last_status end,
					last_attempt_at = greatest(public.naver_project_page_crawl_state.last_attempt_at, excluded.last_attempt_at),
					last_done_result_id = case when excluded.last_done_at >= coalesce(public.naver_project_page_crawl_state.last_done_at, '-infinity'::timestamptz) then excluded.last_done_result_id else public.naver_project_page_crawl_state.last_done_result_id end,
					last_done_run_id = case when excluded.last_done_at >= coalesce(public.naver_project_page_crawl_state.last_done_at, '-infinity'::timestamptz) then excluded.last_done_run_id else public.naver_project_page_crawl_state.last_done_run_id end,
					last_done_at = greatest(public.naver_project_page_crawl_state.last_done_at, excluded.last_done_at),
					last_success_result_id = case when excluded.last_success_at >= coalesce(public.naver_project_page_crawl_state.last_success_at, '-infinity'::timestamptz) then excluded.last_success_result_id else public.naver_project_page_crawl_state.last_success_result_id end,
					last_success_run_id = case when excluded.last_success_at >= coalesce(public.naver_project_page_crawl_state.last_success_at, '-infinity'::timestamptz) then excluded.last_success_run_id else public.naver_project_page_crawl_state.last_success_run_id end,
					last_success_at = greatest(public.naver_project_page_crawl_state.last_success_at, excluded.last_success_at),
					updated_at = now()
				returning 1
			)
			select count(*)::integer as hydrated_count from state_rows
		`,
		[JSON.stringify(payload)]
	);

	return Number(result.rows[0]?.hydrated_count || 0);
}

function summarizeReport(report) {
	const results = Array.isArray(report.results) ? report.results : [];
	const count = (status) => results.filter((result) => result.status === status).length;
	const submitted = count('submitted');
	const alreadyPresent = count('already-present');

	return {
		processed: results.length,
		submitted,
		alreadyPresent,
		submittedOrPresent: submitted + alreadyPresent,
		skippedMissing: count('skipped-missing'),
		skippedReservedPath: count('skipped-reserved-path'),
		quotaStop: count('quota-stop'),
		failed: count('failed'),
		unknown: count('unknown'),
		blocked: count('blocked')
	};
}

function firstTimestamp(results = []) {
	return timestampFromRows(results, false);
}

function lastTimestamp(results = []) {
	return timestampFromRows(results, true);
}

function timestampFromRows(results, last) {
	const values = results
		.map((result) => result?.at)
		.filter(Boolean)
		.sort();
	return last ? values.at(-1) || null : values[0] || null;
}

function hostFromUrl(url) {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

function integerOrNull(value) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dbConfig(raw) {
	const url = new URL(raw);
	const sslMode = url.searchParams.get('sslmode');
	const sslParam = url.searchParams.get('ssl');
	url.searchParams.delete('sslmode');
	url.searchParams.delete('ssl');
	return {
		connectionString: url.toString(),
		ssl: (sslMode === 'require' || sslParam === 'true') ? { rejectUnauthorized: false } : undefined
	};
}
