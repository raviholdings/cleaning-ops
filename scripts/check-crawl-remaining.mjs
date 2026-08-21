#!/usr/bin/env node
/**
 * 계정별 수집요청 잔여를 계산한다. 어느 기계에서 뭘 돌렸는지 기억할 필요 없다 —
 * 제출 기록이 URL 단위로 DB(naver_searchadvisor_crawl_request_results)에 남고,
 * dedup 이 그걸 보므로 러너를 그냥 다시 돌리면 안 한 것만 나간다.
 *
 *   node scripts/check-crawl-remaining.mjs            # 청소 (page_count 기준)
 *   node scripts/check-crawl-remaining.mjs --all      # 잔여 0 계정도 표시
 *
 * 이사(moving-ravi)는 완료 기준이 다르다(사이트맵 50 URL) — 아직 이 스크립트가
 * 세지 않는다. 이사 수집요청이 본격화되면 url ~ '/이사/' 조건으로 별도 집계를 붙일 것.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const projectRoot = process.cwd();
const showAll = process.argv.includes('--all');

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const connectionString = process.env.DATABASE_URL || env.DATABASE_URL || env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');

/*
 * 결과 테이블 130만 행의 distinct 집계라, 세 기계가 동시에 제출 중이거나
 * 색인 루프가 도는 시간대엔 느려져 타임아웃이 날 수 있다 (2026-08-20 실제로
 * 57014 발생). 러너들이 쉬는 때 돌리면 몇 초면 끝난다.
 */
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
// config 의 statement_timeout 은 서버 세션에 반영되지 않는다 (실측) — SET 이어야 한다.
await client.query(`set statement_timeout = '600s'`);

try {
  const { rows } = await client.query(`
    with done as (
      select host, count(distinct url)::int done_pages, max(requested_at) as last_at
      from public.naver_searchadvisor_crawl_request_results
      where status in ('submitted','already-present','skipped','skipped-missing','skipped-reserved-path')
        -- 이사 URL 은 퍼센트 인코딩이라 한글 패턴으로는 안 걸러진다. run 조인이 정확하다.
        and run_id in (select run_id from public.naver_searchadvisor_crawl_request_runs
                        where target_project = 'cleaning-ravi')
      group by host
    ),
    dom as (
      select d.host, d.page_count, a.account_order, d.naver_registration_status
      from public.naver_project_domains d
      join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where d.group_key = 'cleaning-ravi' and d.deployment_status = 'active' and d.is_visible = true
    )
    select account_order as "계정",
           count(*)::int as "도메인",
           count(*) filter (where naver_registration_status <> 'verified')::int as "미소유확인",
           sum(greatest(page_count - coalesce(done_pages, 0), 0))::int as "잔여",
           to_char(max(last_at) + interval '9 hours', 'MM-DD HH24:MI') as "마지막제출KST"
    from dom left join done dn using (host)
    group by 1
    ${showAll ? '' : 'having sum(greatest(page_count - coalesce(done_pages, 0), 0)) > 0'}
    order by "잔여" desc, "계정"
  `);
  console.table(rows);
  const total = rows.reduce((a, r) => a + r['잔여'], 0);
  console.log(`청소 총 잔여: ${total.toLocaleString()}건`);
  console.log('사이트당 하루 50건(00시 리셋) — 도메인당 잔여가 50을 넘으면 이틀 이상 걸린다.');
} finally {
  await client.end();
}
