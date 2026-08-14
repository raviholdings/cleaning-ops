#!/usr/bin/env node
/**
 * 이미 쌓인 수집요청 결과를 페이지 카탈로그에 연결한다.
 *
 *   node scripts/backfill-crawl-result-page-links.mjs --dry-run
 *   node scripts/backfill-crawl-result-page-links.mjs
 *   node scripts/backfill-crawl-result-page-links.mjs --batch 20000
 *
 * 왜 필요한가
 *   naver_searchadvisor_crawl_request_results 에 page_domain_id 와
 *   page_request_id 칼럼이 있는데 전부 비어 있다. cleaning-ravi 는 URL 을
 *   page_count 로 직접 만드는 auto 모드로 돌아서(catalog 모드가 아니다),
 *   결과 행이 페이지에 연결되지 않는다.
 *
 *   그래서 naver_project_page_crawl_state 가 0행이고, 색인 확인 리포트의
 *   "요청 대비 색인" 칼럼이 항상 0 으로 나온다.
 *
 * 어떻게 채우나
 *   URL 에 페이지 번호가 들어 있다.  https://호스트/20.html -> 20
 *   호스트로 도메인을 찾고, 번호가 곧 request_id 다.
 *
 *   외래키가 naver_project_pages(domain_id, request_id) 를 가리키므로
 *   카탈로그가 먼저 채워져 있어야 한다. 없는 조합은 건너뛴다.
 *
 * 안전장치
 *   - 한 번에 다 쓰지 않고 배치로 나눈다. 60만 행을 한 트랜잭션에 묶으면
 *     락이 오래 걸려 수집요청이 밀린다.
 *   - 이미 채워진 행은 건드리지 않는다. 몇 번을 다시 돌려도 같다.
 *   - --dry-run 은 몇 건이 채워질지만 세고 아무것도 안 쓴다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const batchSize = Math.max(1000, Number(valueOf('--batch') || 20000));
const groupKey = valueOf('--group') || 'cleaning-ravi';

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

/*
 * 연결 가능한 행을 고르는 조건.
 *
 *   - 아직 안 채워진 행만 (page_domain_id is null)
 *   - URL 이 https://호스트/숫자.html 형태인 것만. 홈(/)이나 sitemap.xml 은
 *     페이지 행이 없으므로 대상이 아니다.
 *   - 그 (도메인, 번호) 조합이 카탈로그에 실제로 있는 것만. 없으면 외래키가 막는다.
 */
const MATCH = `
  from public.naver_searchadvisor_crawl_request_results r
  join public.naver_project_domains d
    on d.host = r.host and d.group_key = $1
  join public.naver_project_pages p
    on p.domain_id = d.id
   and p.request_id = (regexp_match(r.url, '/([0-9]+)\\.html$'))[1]::int
 where r.page_domain_id is null
   and r.url ~ '/[0-9]+\\.html$'
`;

try {
  console.log(`=== 수집요청 결과 → 페이지 연결 (group=${groupKey}, dryRun=${dryRun}) ===`);

  const before = (await client.query(
    `select count(*)::bigint total,
            count(page_domain_id)::bigint linked
       from public.naver_searchadvisor_crawl_request_results`,
  )).rows[0];
  console.log(`  전체 ${n(before.total)}행 · 이미 연결 ${n(before.linked)}행`);

  const target = (await client.query(`select count(*)::bigint c ${MATCH}`, [groupKey])).rows[0].c;
  console.log(`  연결 가능 ${n(target)}행`);

  const orphan = (await client.query(
    `select count(*)::bigint c
       from public.naver_searchadvisor_crawl_request_results r
       join public.naver_project_domains d on d.host = r.host and d.group_key = $1
      where r.page_domain_id is null
        and r.url ~ '/[0-9]+\\.html$'
        and not exists (
          select 1 from public.naver_project_pages p
           where p.domain_id = d.id
             and p.request_id = (regexp_match(r.url, '/([0-9]+)\\.html$'))[1]::int)`,
    [groupKey],
  )).rows[0].c;
  if (Number(orphan) > 0) {
    console.log(`  ⚠️ 카탈로그에 해당 페이지가 없어 못 채우는 행 ${n(orphan)}건`);
    console.log('     sync-naver-project-page-catalog.mjs 를 먼저 돌려야 합니다.');
  }

  if (dryRun) {
    console.log('\n[dry-run] 아무것도 쓰지 않았습니다.');
  } else if (Number(target) === 0) {
    console.log('\n채울 것이 없습니다.');
  } else {
    let done = 0;
    const started = Date.now();
    for (;;) {
      const res = await client.query(
        `with pick as (
           select r.id, d.id as domain_id,
                  (regexp_match(r.url, '/([0-9]+)\\.html$'))[1]::int as request_id
             ${MATCH}
            limit ${batchSize}
         )
         update public.naver_searchadvisor_crawl_request_results t
            set page_domain_id = pick.domain_id,
                page_request_id = pick.request_id,
                updated_at = now()
           from pick
          where t.id = pick.id`,
        [groupKey],
      );
      if (!res.rowCount) break;
      done += res.rowCount;
      const sec = Math.round((Date.now() - started) / 1000);
      console.log(`  ${n(done)} / ${n(target)}  (${sec}초)`);
    }
    console.log(`\n연결 완료 ${n(done)}행`);
  }

  const after = (await client.query(
    `select count(page_domain_id)::bigint linked from public.naver_searchadvisor_crawl_request_results`,
  )).rows[0];
  console.log(`\n최종: 연결된 행 ${n(after.linked)}`);
  console.log(`page_crawl_state: ${n((await client.query('select count(*)::bigint c from public.naver_project_page_crawl_state')).rows[0].c)}행`);
} finally {
  await client.end();
}

function n(value) { return Number(value).toLocaleString(); }

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] || '');
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}
