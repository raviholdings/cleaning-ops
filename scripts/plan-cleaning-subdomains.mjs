#!/usr/bin/env node
/**
 * 서브도메인 배치 계획을 만든다. DB 는 읽기만 하고 쓰지 않는다.
 *
 * 레거시(bbungbbung)와 같은 방식:
 *   - random-two-words 후보를 시드로 결정적 셔플
 *   - 루트 도메인을 라운드로빈으로 배정  -> 루트마다 같은 수
 *   - 계정은 그 목록을 100개씩 연속으로 잘라 가져감
 *     (라운드로빈 덕분에 계정마다 모든 루트에 고르게 분산된다)
 *
 * 결과는 JSON 으로만 내보내고, 적용은 별도 스크립트가 한다.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRandomTwoWordCandidates, pickAvailableRandomSubdomains } from './lib/bbungbbung-random-subdomains.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const seed = options.seed || 'cleaning-ravi-random-two-words-v1';
const sitesPerAccount = Number(options.sitesPerAccount || 100);
const accountCount = Number(options.accounts || 10);
const fromOrder = Number(options.fromOrder || 1);
const totalSites = sitesPerAccount * accountCount;
const groupKey = options.groupKey || 'cleaning-ravi';
const outputPath = resolve(projectRoot, options.output || 'reports/cleaning-subdomain-plan.json');

const DOMAIN_ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];

const raw = JSON.parse(readFileSync(resolve(projectRoot, 'data/randomSubdomainWords.json'), 'utf8'));
const words = Array.isArray(raw) ? raw : (raw.words || Object.values(raw)[0]);

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

let plan;
try {
  // 이미 쓰이고 있는 host 는 절대 재사용하지 않는다.
  const existing = await client.query('select host from public.naver_project_domains');
  const usedHosts = new Set(existing.rows.map((row) => row.host));

  // 2차 확장부터는 이미 쓰고 있는 계정을 건너뛰어야 한다. --from-order 로 시작 지점을 준다.
  const toOrder = fromOrder + accountCount - 1;
  const accounts = await client.query(
    `select account_id, account_order, status
       from public.naver_searchadvisor_accounts
      where account_order between $1 and $2
      order by account_order`,
    [fromOrder, toOrder],
  );
  if (accounts.rowCount !== accountCount) {
    throw new Error(`Expected ${accountCount} accounts with account_order ${fromOrder}..${toOrder}, found ${accounts.rowCount}.`);
  }
  const alreadyUsed = await client.query(
    `select a.account_order, count(*)::int n
       from public.naver_project_domains d
       join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where a.account_order between $1 and $2
      group by 1 order by 1`,
    [fromOrder, toOrder],
  );
  if (alreadyUsed.rowCount) {
    throw new Error(`이미 도메인이 배정된 계정이 범위에 있습니다: ${alreadyUsed.rows.map((r) => `#${r.account_order}(${r.n}건)`).join(', ')}`);
  }
  const blocked = accounts.rows.filter((row) => row.status !== 'active');
  if (blocked.length) {
    throw new Error(`Non-active accounts in range: ${blocked.map((row) => row.account_id).join(', ')}`);
  }

  // 호스트명에 "fast" 가 들어가면 이 PC 회선이 무조건 끊는다(fast.com, breakfast.com 까지).
  // 사이트 자체는 멀쩡하지만 우리가 확인·점검을 못 하니 애초에 뽑지 않는다.
  const candidates = createRandomTwoWordCandidates(words, seed)
    .filter((candidate) => !/fast/i.test(candidate.subdomain));
  const selected = pickAvailableRandomSubdomains({
    candidates,
    count: totalSites,
    domainRoots: DOMAIN_ROOTS,
    usedHosts: new Set(usedHosts),
  });
  if (selected.length !== totalSites) {
    throw new Error(`Expected ${totalSites} subdomains, picked ${selected.length}.`);
  }

  // globalSiteOrder 는 전 배치를 통틀어 유일해야 한다.
  // PUBLIC_SITE_INDEX = globalSiteOrder - 1 이 페이지 내용을 정하기 때문에,
  // 값이 겹치면 새 사이트가 기존 사이트의 글자까지 똑같은 복제본이 된다.
  // 2차 배치에서 실제로 1~1000 이 겹쳐 배포 직전에 잡았다(2026-08-06).
  const maxUsed = await client.query(
    `select coalesce(max((source_payload->>'globalSiteOrder')::int), 0) as m
       from public.naver_project_domains`,
  );
  const orderOffset = Number(maxUsed.rows[0].m);
  console.log(`globalSiteOrder 시작값: ${orderOffset + 1} (기존 최대 ${orderOffset})`);

  const sites = selected.map((candidate, index) => {
    const account = accounts.rows[Math.floor(index / sitesPerAccount)];
    return {
      globalSiteOrder: orderOffset + index + 1,
      accountOrder: account.account_order,
      accountId: account.account_id,
      accountSiteOrder: (index % sitesPerAccount) + 1,
      domainRoot: candidate.domainRoot,
      subdomain: candidate.subdomain,
      host: candidate.host,
      siteUrl: `https://${candidate.host}`,
      word1: candidate.firstWord,
      word2: candidate.secondWord,
    };
  });

  plan = {
    generatedFor: groupKey,
    seed,
    accountCount,
    sitesPerAccount,
    totalSites,
    pageCountPerSite: Number(options.pageCount || 100),
    domainRoots: DOMAIN_ROOTS,
    reusedExistingHosts: [...usedHosts].filter((host) => sites.some((site) => site.host === host)),
    sites,
  };
} finally {
  await client.end();
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);

// ---- 요약 출력 ----
const byRoot = new Map();
const byAccount = new Map();
for (const site of plan.sites) {
  byRoot.set(site.domainRoot, (byRoot.get(site.domainRoot) || 0) + 1);
  const key = `${site.accountOrder}:${site.accountId}`;
  if (!byAccount.has(key)) byAccount.set(key, { total: 0, roots: new Set() });
  const entry = byAccount.get(key);
  entry.total += 1;
  entry.roots.add(site.domainRoot);
}

console.log(JSON.stringify({
  phase: 'plan',
  seed,
  totalSites: plan.totalSites,
  totalPages: plan.totalSites * plan.pageCountPerSite,
  uniqueHosts: new Set(plan.sites.map((site) => site.host)).size,
  uniqueSubdomains: new Set(plan.sites.map((site) => site.subdomain)).size,
  perRoot: Object.fromEntries(byRoot),
  perAccount: Object.fromEntries(
    [...byAccount].map(([key, value]) => [key, `${value.total}개 / 루트 ${value.roots.size}종`]),
  ),
  output: outputPath,
}, null, 2));

console.log('\n--- 샘플 20개 ---');
for (const site of plan.sites.slice(0, 20)) {
  console.log(`  ${String(site.globalSiteOrder).padStart(4)}  acct${String(site.accountOrder).padStart(2)}  ${site.host}`);
}

function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { result[key] = next; index += 1; } else { result[key] = true; }
  }
  return result;
}

function loadEnv(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
