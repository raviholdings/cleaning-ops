#!/usr/bin/env node
/**
 * plan-piping-subdomains.mjs 가 만든 계획을 naver_project_domains 에 적용한다.
 *
 *   node scripts/apply-piping-subdomains.mjs --dry-run     # 넣어보고 롤백
 *   node scripts/apply-piping-subdomains.mjs               # 실제 적용
 *
 * 전부 한 트랜잭션이다. 실행 전후 행수를 대조해서 예상과 다르면 커밋하지 않는다
 * (2026-08-06 청소 때 신규 1,000행이 통째로 사라졌는데 추적할 근거가 없었다).
 *
 * post_url_pattern 은 비워 둔다. 배관 URL 은 `/배관/{구-동}/{키워드}` 라서 postId
 * 치환식으로 표현할 수 없고, 수집요청은 사이트맵 모드(`/배관/sitemap.xml`)로 URL 을
 * 읽기 때문에 이 칸을 보지 않는다. 다만 사이트맵 모드가 아닌 채로 돌리면 buildPostUrl
 * 이 `/1/` 같은 주소를 만들어 전부 404 가 되므로, 그룹 설정에 postUrlStyle=sitemap 을
 * 반드시 넣어야 한다 (그룹 마이그레이션에서 처리).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
};
const dryRun = args.includes('--dry-run');
const planPath = resolve(projectRoot, valueOf('--plan', 'reports/piping-subdomain-plan.json'));
const SOURCE_TABLE = 'piping-ops-subdomain-plan';
const CHUNK = 500;

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const domains = plan.domains;
if (!Array.isArray(domains) || !domains.length) throw new Error(`${planPath} 에 domains[] 가 없다.`);

/* 계획서 자체 검사 — DB 를 건드리기 전에 막는다. */
const hosts = new Set();
for (const [i, d] of domains.entries()) {
  for (const key of ['host', 'site_url', 'group_key', 'naver_account_id', 'page_count']) {
    if (d[key] === undefined || d[key] === null || d[key] === '') throw new Error(`domains[${i}].${key} 가 없다.`);
  }
  if (hosts.has(d.host)) throw new Error(`계획서 안에 host 중복: ${d.host}`);
  hosts.add(d.host);
  const order = d.source_payload?.globalSiteOrder;
  if (!Number.isSafeInteger(order) || order < 1) throw new Error(`domains[${i}].globalSiteOrder 가 없다.`);
}

const groupKey = plan.groupKey;
console.log(JSON.stringify({
  phase: 'start', dryRun, planPath, groupKey,
  domains: domains.length, accounts: plan.accounts,
  globalSiteOrderRange: plan.globalSiteOrderRange,
}));

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set statement_timeout = '180s'");

let committed = false;
try {
  await client.query('begin');

  const beforeTotal = (await client.query('select count(*)::int n from public.naver_project_domains')).rows[0].n;
  const beforeGroup = (await client.query('select count(*)::int n from public.naver_project_domains where group_key = $1', [groupKey])).rows[0].n;

  // 트랜잭션 안에서 한 번 더 충돌을 본다 (계획을 뽑은 뒤 다른 작업이 끼어들었을 수 있다).
  const clash = (await client.query(
    'select host from public.naver_project_domains where host = any($1) limit 5', [[...hosts]],
  )).rows;
  if (clash.length) throw new Error(`이미 쓰는 host 가 있다: ${clash.map((r) => r.host).join(', ')}`);

  const maxOrder = (await client.query(
    "select coalesce(max((source_payload->>'globalSiteOrder')::int), 0) mx from public.naver_project_domains",
  )).rows[0].mx;
  const planMin = plan.globalSiteOrderRange[0];
  if (planMin <= maxOrder) throw new Error(`globalSiteOrder 시작값 ${planMin} 이 기존 최대 ${maxOrder} 이하다 — 페이지가 겹친다.`);

  let inserted = 0;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const rows = domains.slice(i, i + CHUNK).map((d) => ({
      host: d.host,
      site_url: d.site_url,
      account_id: d.naver_account_id,
      page_count: d.page_count,
      strategy: d.subdomain_generation_strategy,
      payload: d.source_payload,
    }));
    const res = await client.query(
      `insert into public.naver_project_domains (
         group_key, project_key, target_project, host, site_url, naver_account_id,
         deployment_status, is_visible, page_count,
         subdomain_generation_strategy, naver_registration_status, source_table, source_payload
       )
       select $1, $1, $1, input.host, input.site_url, input.account_id,
              'active', true, input.page_count,
              input.strategy, 'pending', $2, input.payload
         from jsonb_to_recordset($3::jsonb) as input(
           host text, site_url text, account_id text, page_count integer,
           strategy text, payload jsonb
         )`,
      [groupKey, SOURCE_TABLE, JSON.stringify(rows)],
    );
    inserted += res.rowCount;
  }

  const afterTotal = (await client.query('select count(*)::int n from public.naver_project_domains')).rows[0].n;
  const afterGroup = (await client.query('select count(*)::int n from public.naver_project_domains where group_key = $1', [groupKey])).rows[0].n;

  if (inserted !== domains.length) throw new Error(`삽입 건수가 다르다: ${inserted}/${domains.length}`);
  if (afterTotal !== beforeTotal + inserted) {
    throw new Error(`전체 행수가 예상과 다르다: ${beforeTotal} + ${inserted} = ${beforeTotal + inserted} 인데 ${afterTotal} 이다.`);
  }

  const verify = (await client.query(
    `select count(*)::int total,
            count(distinct naver_account_id)::int accounts,
            count(distinct split_part(host, '.', 2) || '.' || split_part(host, '.', 3))::int roots,
            count(*) filter (where naver_registration_status = 'pending')::int pending,
            min((source_payload->>'globalSiteOrder')::int) min_order,
            max((source_payload->>'globalSiteOrder')::int) max_order
       from public.naver_project_domains where group_key = $1`, [groupKey],
  )).rows[0];

  console.log(JSON.stringify({
    phase: 'verify',
    rowsBefore: beforeTotal, rowsAfter: afterTotal, inserted,
    groupBefore: beforeGroup, groupAfter: afterGroup,
    check: verify,
  }, null, 2));

  if (dryRun) {
    await client.query('rollback');
    console.log(JSON.stringify({ phase: 'dry-run', note: '롤백했다. DB 는 그대로다.' }));
  } else {
    await client.query('commit');
    committed = true;
    console.log(JSON.stringify({ phase: 'committed', inserted }));
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  console.error(JSON.stringify({ phase: 'failed', error: error.message }));
  process.exitCode = 1;
} finally {
  await client.end();
  if (!committed && !dryRun && process.exitCode !== 1) {
    console.log(JSON.stringify({ phase: 'not-committed' }));
  }
}
