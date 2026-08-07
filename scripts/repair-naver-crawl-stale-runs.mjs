#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

loadEnv('.env.local');
loadEnv('.env');

const args = parseArgs(process.argv.slice(2));
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
const targetProject = args.project || process.env.NAVER_CRAWL_TARGET_PROJECT || '';
const accountId = args.account || process.env.NAVER_CRAWL_ACCOUNT_ID || '';
const runId = args.runId || '';
const dryRun = Boolean(args.dryRun);
const olderThanMinutes = Math.max(1, Number.parseInt(args.olderThanMinutes || process.env.NAVER_CRAWL_STALE_RUN_MINUTES || '15', 10));

if (!connectionString) fail('DATABASE_URL or DIRECT_URL is required.');
if (!targetProject && !runId) fail('missing --project or --run-id');

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
  const candidates = await loadStaleRuns();
  if (dryRun) {
    print({ dryRun: true, olderThanMinutes, staleRuns: candidates });
    process.exit(0);
  }

  const repaired = [];
  for (const row of candidates) {
    repaired.push(await repairRun(row));
  }

  print({
    dryRun: false,
    olderThanMinutes,
    candidateCount: candidates.length,
    repairedCount: repaired.length,
    repaired,
  });
} finally {
  await client.end().catch(() => {});
}

async function loadStaleRuns() {
  const filters = ['run.status = \'running\''];
  const values = [olderThanMinutes];
  filters.push(`run.updated_at < now() - ($${values.length}::int * interval '1 minute')`);

  if (runId) {
    values.push(runId);
    filters.push(`run.run_id = $${values.length}`);
  }
  if (targetProject) {
    values.push(targetProject);
    filters.push(`run.target_project = $${values.length}`);
  }
  if (accountId) {
    values.push(accountId);
    filters.push(`run.account_id = $${values.length}`);
  }

  const { rows } = await client.query(
    `
      select
        run.run_id,
        run.target_project,
        run.account_id,
        run.status,
        run.next_index,
        run.total_tasks,
        run.updated_at,
        run.error,
        coalesce(agg.result_rows, 0)::int as result_rows,
        coalesce(agg.submitted_count, 0)::int as submitted_count,
        coalesce(agg.already_present_count, 0)::int as already_present_count,
        coalesce(agg.skipped_missing_count, 0)::int as skipped_missing_count,
        coalesce(agg.skipped_reserved_path_count, 0)::int as skipped_reserved_path_count,
        coalesce(agg.quota_stop_count, 0)::int as quota_stop_count,
        coalesce(agg.failed_count, 0)::int as failed_count,
        coalesce(agg.unknown_count, 0)::int as unknown_count,
        coalesce(agg.blocked_count, 0)::int as blocked_count,
        coalesce(agg.host_quota_stop_count, 0)::int as host_quota_stop_count,
        agg.first_result_at,
        agg.last_result_at,
        agg.max_result_index
      from public.naver_searchadvisor_crawl_request_runs run
      left join lateral (
        select
          count(*)::int as result_rows,
          count(*) filter (where result.status = 'submitted')::int as submitted_count,
          count(*) filter (where result.status = 'already-present')::int as already_present_count,
          count(*) filter (where result.status = 'skipped-missing')::int as skipped_missing_count,
          count(*) filter (where result.status = 'skipped-reserved-path')::int as skipped_reserved_path_count,
          count(*) filter (where result.status = 'quota-stop')::int as quota_stop_count,
          count(*) filter (where result.status = 'failed')::int as failed_count,
          count(*) filter (where result.status = 'unknown')::int as unknown_count,
          count(*) filter (where result.status = 'blocked')::int as blocked_count,
          count(distinct result.host) filter (where result.status = 'quota-stop')::int as host_quota_stop_count,
          min(result.requested_at) as first_result_at,
          max(result.requested_at) as last_result_at,
          max(result.result_index)::int as max_result_index
        from public.naver_searchadvisor_crawl_request_results result
        where result.run_id = run.run_id
      ) agg on true
      where ${filters.join('\n        and ')}
      order by run.updated_at
    `,
    values,
  );

  return rows.map(normalizeRunRow);
}

async function repairRun(row) {
  const processedCount = row.resultRows;
  const submittedOrPresentCount = row.submittedCount + row.alreadyPresentCount;
  const recoveredIndex = Math.max(row.nextIndex, Number.isInteger(row.maxResultIndex) ? row.maxResultIndex + 1 : 0, processedCount);
  const recoveredTotal = Math.max(row.totalTasks, recoveredIndex);
  const status = processedCount > 0 ? 'partial' : 'failed';
  const finishedAt = row.lastResultAt || row.updatedAt || new Date().toISOString();
  const error = row.error || (
    processedCount > 0
      ? `stale running crawl run repaired from ${processedCount} persisted result row(s)`
      : 'stale running crawl run had no persisted result rows'
  );

  const { rows } = await client.query(
    `
      update public.naver_searchadvisor_crawl_request_runs run
      set status = $2,
          next_index = $3,
          total_tasks = $4,
          processed_count = $5,
          submitted_count = $6,
          already_present_count = $7,
          submitted_or_present_count = $8,
          skipped_missing_count = $9,
          skipped_reserved_path_count = $10,
          quota_stop_count = $11,
          failed_count = $12,
          unknown_count = $13,
          blocked_count = $14,
          host_quota_stop_count = $15,
          finished_at = $16::timestamptz,
          last_result_at = $17::timestamptz,
          error = $18,
          source_payload = coalesce(run.source_payload, '{}'::jsonb)
            || jsonb_build_object(
              'staleRepair',
              jsonb_build_object(
                'repairedAt', now(),
                'reason', 'running row older than threshold',
                'olderThanMinutes', $19::int,
                'resultRows', $5::int,
                'previousStatus', 'running'
              )
            ),
          updated_at = now()
      where run.run_id = $1
        and run.status = 'running'
      returning run_id, target_project, account_id, status, processed_count,
                submitted_or_present_count, failed_count, unknown_count,
                next_index, total_tasks, finished_at, error
    `,
    [
      row.runId,
      status,
      recoveredIndex,
      recoveredTotal,
      processedCount,
      row.submittedCount,
      row.alreadyPresentCount,
      submittedOrPresentCount,
      row.skippedMissingCount,
      row.skippedReservedPathCount,
      row.quotaStopCount,
      row.failedCount,
      row.unknownCount,
      row.blockedCount,
      row.hostQuotaStopCount,
      finishedAt,
      row.lastResultAt || null,
      error,
      olderThanMinutes,
    ],
  );

  return rows[0] || { run_id: row.runId, skipped: true, reason: 'run was no longer running' };
}

function normalizeRunRow(row) {
  return {
    runId: row.run_id,
    targetProject: row.target_project,
    accountId: row.account_id,
    status: row.status,
    nextIndex: Number(row.next_index || 0),
    totalTasks: Number(row.total_tasks || 0),
    updatedAt: row.updated_at,
    error: row.error || '',
    resultRows: Number(row.result_rows || 0),
    submittedCount: Number(row.submitted_count || 0),
    alreadyPresentCount: Number(row.already_present_count || 0),
    skippedMissingCount: Number(row.skipped_missing_count || 0),
    skippedReservedPathCount: Number(row.skipped_reserved_path_count || 0),
    quotaStopCount: Number(row.quota_stop_count || 0),
    failedCount: Number(row.failed_count || 0),
    unknownCount: Number(row.unknown_count || 0),
    blockedCount: Number(row.blocked_count || 0),
    hostQuotaStopCount: Number(row.host_quota_stop_count || 0),
    firstResultAt: row.first_result_at,
    lastResultAt: row.last_result_at,
    maxResultIndex: row.max_result_index == null ? null : Number(row.max_result_index),
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') parsed.project = argv[++index] || '';
    else if (arg === '--account') parsed.account = argv[++index] || '';
    else if (arg === '--run-id') parsed.runId = argv[++index] || '';
    else if (arg === '--older-than-minutes') parsed.olderThanMinutes = argv[++index] || '';
    else if (arg === '--dry-run') parsed.dryRun = true;
  }
  return parsed;
}

function loadEnv(file) {
  const fullPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(fullPath)) return;

  for (const rawLine of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value.replace(/\\n/g, '\n');
  }
}

function createClientConfig(value) {
  const url = new URL(value);
  const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');
  return {
    connectionString: url.toString(),
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
