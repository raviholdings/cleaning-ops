#!/usr/bin/env node
/**
 * plan-cleaning-subdomains.mjs 가 만든 계획을 naver_project_domains 에 적용한다.
 *
 *   node scripts/apply-cleaning-subdomains.mjs --plan reports/cleaning-subdomain-plan-batch3.json --dry-run
 *   node scripts/apply-cleaning-subdomains.mjs --plan reports/cleaning-subdomain-plan-batch3.json
 *
 * 전부 한 트랜잭션이다. --dry-run 이면 넣어본 뒤 롤백한다.
 *
 * post_url_pattern 을 반드시 넣는다. 비워두면 크롤 스크립트의 buildPostUrl 이
 * `/1/` 형태로 URL 을 만드는데, 우리 정적 빌드는 `/1.html` 이라 전부 404 가 된다.
 *
 * 2026-08-06 git reset 사고로 원본이 사라져 다시 작성했다. 그때 신규 1,000행이
 * 통째로 사라졌는데 언제 어떻게 없어졌는지 추적할 근거가 전혀 없었다. 그래서
 * 실행 전후 행수를 찍고, 예상과 다르면 커밋하지 않는다.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const planPath = resolve(projectRoot, options.plan || 'reports/cleaning-subdomain-plan.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const POST_URL_PATTERN = '/:postId.html';
const SOURCE_TABLE = 'cleaning-ops-subdomain-plan';

if (!Array.isArray(plan.sites) || !plan.sites.length) throw new Error(`${planPath} 에 sites[] 가 없습니다.`);
const groupKey = plan.generatedFor || 'cleaning-ravi';
const pageCount = Number(plan.pageCountPerSite || 100);

for (const [i, s] of plan.sites.entries()) {
  for (const key of ['host', 'siteUrl', 'accountId', 'globalSiteOrder', 'accountSiteOrder', 'domainRoot', 'subdomain']) {
    if (s[key] === undefined || s[key] === null || s[key] === '') throw new Error(`sites[${i}].${key} 가 없습니다.`);
  }
}

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

let started = false;
try {
  await client.query('begin');
  started = true;

  const beforeRow = await client.query('select count(*)::int n from public.naver_project_domains');
  const beforeTotal = beforeRow.rows[0].n;
  console.log(JSON.stringify({ phase: 'before', totalRows: beforeTotal, planSites: plan.sites.length, plan: planPath }));

  // 계획 호스트가 이미 있으면 중단한다. 덮어쓰면 기존 토큰·소유확인 상태가 날아간다.
  const planHosts = plan.sites.map((s) => s.host);
  const clash = await client.query(
    'select host from public.naver_project_domains where host = any($1::text[])',
    [planHosts],
  );
  if (clash.rowCount) {
    throw new Error(`계획의 호스트가 이미 존재합니다(${clash.rowCount}건): ${clash.rows.slice(0, 5).map((r) => r.host).join(', ')}`);
  }

  // 계정이 실제로 있는지 확인한다. 없는 계정으로 넣으면 FK 로 막히지만
  // 어느 계정인지 알려주는 편이 낫다.
  const accountIds = [...new Set(plan.sites.map((s) => s.accountId))];
  const known = await client.query(
    'select account_id from public.naver_searchadvisor_accounts where account_id = any($1::text[])',
    [accountIds],
  );
  const knownSet = new Set(known.rows.map((r) => r.account_id));
  const missing = accountIds.filter((a) => !knownSet.has(a));
  if (missing.length) throw new Error(`DB 에 없는 계정: ${missing.join(', ')}`);

  let inserted = 0;
  const batchSize = 200;
  for (let offset = 0; offset < plan.sites.length; offset += batchSize) {
    const batch = plan.sites.slice(offset, offset + batchSize);
    const payload = batch.map((s) => ({
      host: s.host,
      site_url: s.siteUrl,
      account_id: s.accountId,
      page_count: pageCount,
      payload: {
        word1: s.word1,
        word2: s.word2,
        subdomain: s.subdomain,
        domainRoot: s.domainRoot,
        accountOrder: s.accountOrder,
        globalSiteOrder: s.globalSiteOrder,
        accountSiteOrder: s.accountSiteOrder,
      },
    }));

    const res = await client.query(
      `insert into public.naver_project_domains (
         group_key, project_key, target_project, host, site_url, naver_account_id,
         deployment_status, is_visible, page_count, post_url_pattern,
         subdomain_generation_strategy, naver_registration_status, source_table, source_payload
       )
       select $1, $1, $1, input.host, input.site_url, input.account_id,
              'active', true, input.page_count, $2,
              'random-two-words', 'pending', $3, input.payload
         from jsonb_to_recordset($4::jsonb) as input(
           host text, site_url text, account_id text, page_count integer, payload jsonb
         )`,
      [groupKey, POST_URL_PATTERN, SOURCE_TABLE, JSON.stringify(payload)],
    );
    inserted += res.rowCount;
  }

  const afterRow = await client.query('select count(*)::int n from public.naver_project_domains');
  const afterTotal = afterRow.rows[0].n;
  const expected = beforeTotal + inserted;
  if (afterTotal !== expected) {
    throw new Error(`행수가 예상과 다릅니다: 이전 ${beforeTotal} + 삽입 ${inserted} = ${expected} 인데 ${afterTotal} 입니다.`);
  }

  const verify = await client.query(
    `select count(*)::int total,
            count(*) filter (where post_url_pattern = $1)::int with_pattern,
            count(distinct naver_account_id)::int accounts,
            sum(page_count)::int pages
       from public.naver_project_domains where group_key = $2`,
    [POST_URL_PATTERN, groupKey],
  );

  console.log(JSON.stringify({
    phase: dryRun ? 'dry-run' : 'complete',
    insertedSubdomains: inserted,
    totalRows: afterTotal,
    verify: verify.rows[0],
  }, null, 2));

  if (dryRun) {
    await client.query('rollback');
    started = false;
    console.log('\n(dry-run: 롤백했습니다. DB 는 변경되지 않았습니다.)');
  } else {
    await client.query('commit');
    started = false;
  }
} catch (error) {
  if (started) await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

function parseOptions(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { result[key] = next; i += 1; } else { result[key] = true; }
  }
  return result;
}

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
