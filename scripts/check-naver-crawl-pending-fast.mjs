#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { resolveCrawlExposureStatuses } from './lib/naver-crawl-exposure-statuses.mjs';

const { Client } = pg;

loadEnv('.env.local');
loadEnv('.env');

const args = parseArgs(process.argv.slice(2));
const accountId = args.account || process.env.NAVER_CRAWL_ACCOUNT_ID || '';
const targetProject = args.project || process.env.NAVER_CRAWL_TARGET_PROJECT || 'watermelon-piping';
const exposureStatuses = resolveCrawlExposureStatuses({
  project: targetProject,
  configuredStatuses: process.env.NAVER_CRAWL_EXPOSURE_STATUSES,
  unexposedOnlyProjects: process.env.NAVER_WINDOWS_CRAWL_UNEXPOSED_ONLY_PROJECTS
    ?? process.env.NAVER_CRAWL_UNEXPOSED_ONLY_PROJECTS
    ?? '',
});
const catalogProjects = new Set(splitEnv(
  process.env.NAVER_WINDOWS_CRAWL_CATALOG_PROJECTS
    || process.env.NAVER_CRAWL_CATALOG_PROJECTS
    || 'bbungbbung-piping,gosim,recovery-law',
));
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;

if (!accountId) fail('missing --account or NAVER_CRAWL_ACCOUNT_ID');
if (!connectionString) fail('missing DATABASE_URL or DIRECT_URL');

if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const client = new Client({ connectionString });

try {
  await client.connect();

  const targetResult = await client.query(
    `
      select count(*)::int as domain_count,
             count(distinct host)::int as host_count,
             coalesce(sum(page_count), 0)::int as page_count
      from public.naver_crawl_request_target_domains
      where naver_account_id = $1
        and target_project = $2
    `,
    [accountId, targetProject],
  );
  const target = targetResult.rows[0] || {};
  const domainCount = Number(target.domain_count || 0);
  const hostCount = Number(target.host_count || 0);
  const pageCount = Number(target.page_count || 0);
  if (domainCount <= 0) {
    print({ skip: false, reason: 'no-target-domains', accountId, targetProject });
    process.exit(0);
  }

  const quotaDeferredResult = await client.query(
    `
      with target_hosts as (
        select distinct host
        from public.naver_crawl_request_target_domains
        where naver_account_id = $1
          and target_project = $2
          and host is not null
      ),
      deferred_hosts as (
        select distinct result.host
        from public.naver_searchadvisor_crawl_request_results result
        join public.naver_searchadvisor_crawl_request_runs run
          on run.run_id = result.run_id
        join target_hosts target
          on target.host = result.host
        where run.target_project = $2
          and (run.account_id = $1 or result.account = $1)
          and result.status = 'quota-stop'
          and result.requested_at >= $3::timestamptz
      )
      select
        (select count(*)::int from target_hosts) as target_host_count,
        (select count(*)::int from deferred_hosts) as quota_deferred_host_count,
        coalesce((select array_agg(host order by host) from deferred_hosts), array[]::text[]) as quota_deferred_hosts
    `,
    [accountId, targetProject, currentKstDayStartIso()],
  );
  const quotaDeferredHostCount = Number(quotaDeferredResult.rows[0]?.quota_deferred_host_count || 0);
  const quotaDeferredHosts = quotaDeferredResult.rows[0]?.quota_deferred_hosts || [];
  const targetHostCount = Number(quotaDeferredResult.rows[0]?.target_host_count || hostCount || 0);
  if (targetHostCount > 0 && quotaDeferredHostCount >= targetHostCount) {
    print({
      skip: true,
      reason: 'all-target-hosts-quota-deferred-today',
      accountId,
      targetProject,
      domainCount,
      hostCount,
      pageCount,
      targetHostCount,
      quotaDeferredHostCount,
      quotaDeferredSince: currentKstDayStartIso(),
    });
    process.exit(0);
  }

  /*
   * 재수집 모드 (NAVER_CRAWL_DONE_SINCE, 2026-08-23): 기준선 이전 완료는 무효라
   * "다 끝났다" 계열 스킵 판정이 전부 틀리게 된다. 오늘 한도 소진 스킵(위)만
   * 남기고 나머지 판정은 건너뛴다 — 실제 후보 선정은 러너의 catalog 쿼리가
   * 같은 기준선으로 한다.
   */
  if (process.env.NAVER_CRAWL_DONE_SINCE) {
    print({
      skip: false,
      reason: 'redo-mode-done-since',
      doneSince: process.env.NAVER_CRAWL_DONE_SINCE,
      accountId,
      targetProject,
      domainCount,
      pageCount,
      quotaDeferredHostCount,
    });
    process.exit(0);
  }

  if (catalogProjects.has(targetProject)) {
    const pendingResult = await client.query(
      `
        select
          exists (
            select 1
            from public.naver_crawl_request_page_candidates candidate
            where candidate.naver_account_id = $1
              and candidate.target_project = $2
              and candidate.last_done_at is null
              and (cardinality($3::text[]) = 0 or candidate.exposure_status = any($3::text[]))
              and not (candidate.host = any($4::text[]))
            limit 1
          ) as has_pending_page
      `,
      [accountId, targetProject, exposureStatuses, quotaDeferredHosts],
    );
    const hasPendingPage = pendingResult.rows[0]?.has_pending_page === true;

    let hasPendingRoot = false;
    if (!hasPendingPage && exposureStatuses.length === 0) {
      const rootPendingResult = await client.query(
        `
          select exists (
            select 1
            from public.naver_crawl_request_target_domains target
            where target.naver_account_id = $1
              and target.target_project = $2
              and $2 = any($3::text[])
              and not (target.host = any($4::text[]))
              and not exists (
                select 1
                from public.naver_searchadvisor_crawl_request_results result
                join public.naver_searchadvisor_crawl_request_runs run
                  on run.run_id = result.run_id
                where run.target_project = $2
                  and (run.account_id = $1 or result.account = $1)
                  and result.status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path')
                  and result.url in (rtrim(target.site_url, '/'), rtrim(target.site_url, '/') || '/')
              )
            limit 1
          ) as has_pending_root
        `,
        [accountId, targetProject, ['bbungbbung-piping', 'woodrel-piping'], quotaDeferredHosts],
      );
      hasPendingRoot = rootPendingResult.rows[0]?.has_pending_root === true;
    }
    const skip = !hasPendingPage && !hasPendingRoot;

    print({
      skip,
      reason: skip
        ? 'page-catalog-has-no-pending-targets-in-scope'
        : 'page-catalog-has-pending-targets-in-scope',
      accountId,
      targetProject,
      exposureStatuses,
      domainCount,
      hostCount,
      pageCount,
      hasPendingPage,
      hasPendingRoot,
      quotaDeferredHostCount,
    });
    process.exit(0);
  }

  const unresolvedResult = await client.query(
    `
      with bad as (
        select result.url,
               coalesce(result.requested_at, result.created_at) as bad_at
        from public.naver_searchadvisor_crawl_request_results result
        join public.naver_searchadvisor_crawl_request_runs run
          on run.run_id = result.run_id
        where run.account_id = $1
          and run.target_project = $2
          and result.status in ('failed', 'unknown')
      )
      select count(*)::int as unresolved_count
      from bad
      where not exists (
        select 1
        from public.naver_searchadvisor_crawl_request_results ok
        join public.naver_searchadvisor_crawl_request_runs ok_run
          on ok_run.run_id = ok.run_id
        where ok_run.account_id = $1
          and ok_run.target_project = $2
          and ok.url = bad.url
          and ok.status in ('submitted', 'already-present')
          and coalesce(ok.requested_at, ok.created_at) > bad.bad_at
      )
    `,
    [accountId, targetProject],
  );
  const unresolvedCount = Number(unresolvedResult.rows[0]?.unresolved_count || 0);
  if (unresolvedCount > 0) {
    print({
      skip: false,
      reason: 'unresolved-failed-or-unknown-results',
      accountId,
      targetProject,
      domainCount,
      pageCount,
      unresolvedCount,
    });
    process.exit(0);
  }

  const completedResult = await client.query(
    `
      select count(distinct result.url)::int as completed_url_count
      from public.naver_searchadvisor_crawl_request_results result
      join public.naver_searchadvisor_crawl_request_runs run
        on run.run_id = result.run_id
      where run.account_id = $1
        and run.target_project = $2
        and result.status in ('submitted', 'already-present')
    `,
    [accountId, targetProject],
  );
  const completedUrlCount = Number(completedResult.rows[0]?.completed_url_count || 0);

  const runResult = await client.query(
    `
      select run_id,
             status,
             next_index,
             total_tasks,
             processed_count,
             submitted_count,
             quota_stop_count,
             unknown_count,
             failed_count,
             finished_at
      from public.naver_searchadvisor_crawl_request_runs
      where account_id = $1
        and target_project = $2
        and status = 'succeeded'
        and finished_at is not null
      order by finished_at desc
      limit 1
    `,
    [accountId, targetProject],
  );
  const latest = runResult.rows[0];
  if (!latest) {
    print({ skip: false, reason: 'no-successful-run', accountId, targetProject, domainCount, pageCount });
    process.exit(0);
  }

  const totalTasks = Number(latest.total_tasks || 0);
  const nextIndex = Number(latest.next_index || 0);
  const failedCount = Number(latest.failed_count || 0);
  const unknownCount = Number(latest.unknown_count || 0);
  const expectedFloor = estimateExpectedTaskFloor(targetProject, domainCount, pageCount);
  const skip = nextIndex >= totalTasks
    && totalTasks >= expectedFloor
    && completedUrlCount >= totalTasks
    && failedCount === 0
    && unknownCount === 0;

  print({
    skip,
    reason: skip ? 'latest-successful-run-exhausted-current-targets' : 'latest-run-not-exhausted-completed-urls-or-has-problems',
    accountId,
    targetProject,
    domainCount,
    pageCount,
    expectedFloor,
    completedUrlCount,
    latestRunId: latest.run_id,
    latestNextIndex: nextIndex,
    latestTotalTasks: totalTasks,
    latestFailedCount: failedCount,
    latestUnknownCount: unknownCount,
    latestFinishedAt: latest.finished_at,
    unresolvedCount,
  });
} finally {
  await closeClientFast(client);
}

function estimateExpectedTaskFloor(project, domainCount, pageCount) {
  if (['bbungbbung-piping', 'woodrel-piping'].includes(project)) {
    return pageCount + domainCount;
  }
  return pageCount;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--account') parsed.account = argv[++index] || '';
    else if (arg === '--project') parsed.project = argv[++index] || '';
  }
  return parsed;
}

function splitEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

function currentKstDateKey() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function currentKstDayStartIso() {
  return new Date(`${currentKstDateKey()}T00:00:00+09:00`).toISOString();
}

async function closeClientFast(pgClient) {
  let timedOut = false;
  const endPromise = pgClient.end().catch(() => {});
  await Promise.race([
    endPromise,
    new Promise((resolve) => {
      setTimeout(() => {
        timedOut = true;
        pgClient.connection?.stream?.destroy?.();
        resolve();
      }, 3000);
    }),
  ]);
  if (timedOut) {
    process.stderr.write('[crawl-fast-skip] DB close timeout; destroyed socket\n');
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
