#!/usr/bin/env node
/**
 * naver_project_page_crawl_state 를 이미 연결된 제출 기록에서 통째로 재구축한다.
 *
 *   node scripts/rebuild-page-crawl-state.mjs --dry-run
 *   node scripts/rebuild-page-crawl-state.mjs
 *
 * 왜 필요한가
 *   러너는 자기 실행의 결과에 대해서만 state 를 갱신한다
 *   (naver-searchadvisor-crawl-db.mjs 의 hydrateCrawlResultPageLinks).
 *   옛 실행 기록은 백필로 페이지 연결(page_domain_id)이 뒤늦게 채워졌으므로
 *   state 를 한 번 통째로 만들어 줘야 한다. 이게 차면:
 *     - 관리자 카드의 done(완료) 카운트가 0 에서 벗어난다
 *     - 색인 체커의 무거운 crawl-stats CTE 가 not exists 로 건너뛰어진다
 *
 * 의미론은 hydrateCrawlResultPageLinks 의 upsert 와 동일하다:
 *   last_*        마지막 시도 (requested_at, id 내림차순 첫 행)
 *   last_done_*   done 상태(submitted/already-present/skipped 계열) 중 마지막
 *   last_success_* submitted/already-present 중 마지막
 *   on conflict 는 greatest 병합이라 러너와 동시에 돌아도 안전하다.
 *
 * 실행 순서: 카탈로그 동기화 → 백필 → 이 스크립트. FK 가
 * naver_project_pages(domain_id, request_id) 를 가리켜서 순서가 어긋나면 죽는다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const projectRoot = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchDomains = Math.max(100, Number((args[args.indexOf('--batch') + 1] || 0)) || 500);

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const connectionString = process.env.DATABASE_URL || env.DATABASE_URL || env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
// 역할 기본 2분으로는 부족하다. config 가 아니라 SET 이어야 서버에 닿는다.
await client.query(`set statement_timeout = '600s'`);

const DONE = `('submitted','already-present','skipped','skipped-missing','skipped-reserved-path')`;
const SUCCESS = `('submitted','already-present')`;

try {
  const { rows: [range] } = await client.query(`
    select min(id)::bigint as lo, max(id)::bigint as hi
    from public.naver_project_domains`);
  const lo = Number(range.lo), hi = Number(range.hi);
  console.log(`도메인 id ${lo}~${hi}, 배치당 ${batchDomains}개 (dryRun=${dryRun})`);

  let total = 0;
  for (let start = lo; start <= hi; start += batchDomains) {
    const end = Math.min(start + batchDomains - 1, hi);
    if (dryRun) {
      const { rows: [c] } = await client.query(`
        select count(distinct (page_domain_id, page_request_id))::int as n
        from public.naver_searchadvisor_crawl_request_results
        where page_domain_id between $1 and $2 and page_request_id is not null`, [start, end]);
      total += c.n;
      continue;
    }
    const started = Date.now();
    const result = await client.query(`
      with linked as (
        select id, run_id, account, status, requested_at, page_domain_id, page_request_id
        from public.naver_searchadvisor_crawl_request_results
        where page_domain_id between $1 and $2 and page_request_id is not null
      ),
      att as (
        select distinct on (page_domain_id, page_request_id) *
        from linked order by page_domain_id, page_request_id, requested_at desc, id desc
      ),
      done as (
        select distinct on (page_domain_id, page_request_id) *
        from linked where status in ${DONE}
        order by page_domain_id, page_request_id, requested_at desc, id desc
      ),
      succ as (
        select distinct on (page_domain_id, page_request_id) *
        from linked where status in ${SUCCESS}
        order by page_domain_id, page_request_id, requested_at desc, id desc
      )
      insert into public.naver_project_page_crawl_state (
        domain_id, request_id,
        last_result_id, last_run_id, last_account_id, last_status, last_attempt_at,
        last_done_result_id, last_done_run_id, last_done_at,
        last_success_result_id, last_success_run_id, last_success_at,
        updated_at
      )
      select
        a.page_domain_id, a.page_request_id,
        a.id, a.run_id, a.account, a.status, a.requested_at,
        d.id, d.run_id, d.requested_at,
        s.id, s.run_id, s.requested_at,
        now()
      from att a
      left join done d on d.page_domain_id = a.page_domain_id and d.page_request_id = a.page_request_id
      left join succ s on s.page_domain_id = a.page_domain_id and s.page_request_id = a.page_request_id
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
    `, [start, end]);
    total += result.rowCount;
    console.log(`  도메인 ${start}~${end}: ${result.rowCount.toLocaleString()}행 (${Math.round((Date.now() - started) / 1000)}초, 누적 ${total.toLocaleString()})`);
  }

  if (dryRun) {
    console.log(`[dry-run] 만들어질 state 행: ${total.toLocaleString()}`);
  } else {
    const { rows: [c] } = await client.query(`select count(*)::bigint n from public.naver_project_page_crawl_state`);
    console.log(`완료. state 총 ${Number(c.n).toLocaleString()}행`);
  }
} finally {
  await client.end();
}
