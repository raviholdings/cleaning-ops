#!/usr/bin/env node
/**
 * 배관 신규 서브도메인 1만 개 배치 계획. **DB 는 읽기만 하고 쓰지 않는다.**
 *
 * 청소(plan-cleaning-subdomains)와 같은 방식이되 두 가지가 다르다.
 *   1. 하이픈 없는 단어붙여쓰기 — shark-cotton(청소) 대신 amberwriter(배관)
 *   2. globalSiteOrder 를 10,001 부터 매긴다
 *      렌더러가 siteIndex(=globalSiteOrder-1)로 지역·키워드를 배정하는데,
 *      기존 1만(1~10,000)과 겹치면 같은 페이지가 두 번 나온다.
 *
 *   node scripts/plan-piping-subdomains.mjs
 *   node scripts/plan-piping-subdomains.mjs --accounts 100 --from-order 201
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const seed = valueOf('--seed', 'piping-ravi-joined-words-v1');
const sitesPerAccount = Number(valueOf('--sites-per-account', 100));
const accountCount = Number(valueOf('--accounts', 100));
const fromOrder = Number(valueOf('--from-order', 201));
const groupKey = valueOf('--group-key', 'piping-ravi');
const startOrder = Number(valueOf('--start-order', 10001));
const outputPath = resolve(projectRoot, valueOf('--output', 'reports/piping-subdomain-plan.json'));
const totalSites = sitesPerAccount * accountCount;

const DOMAIN_ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];

const raw = JSON.parse(readFileSync(resolve(projectRoot, 'data/randomSubdomainWords.json'), 'utf8'));
const words = Array.isArray(raw) ? raw : (raw.words || Object.values(raw)[0]);

/* 시드 고정 셔플 — 같은 시드면 언제 돌려도 같은 계획이 나온다. */
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function shuffle(list, seedText) {
  let state = hash32(seedText) || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set statement_timeout = '60s'");

let plan;
try {
  // 이미 쓰이는 host 는 그룹과 무관하게 전부 피한다.
  const used = new Set((await client.query('select host from public.naver_project_domains')).rows.map((r) => r.host));
  const usedSub = new Set([...used].map((h) => h.split('.')[0]));

  const toOrder = fromOrder + accountCount - 1;
  const accounts = (await client.query(
    `select account_id, account_order, status
       from public.naver_searchadvisor_accounts
      where account_order between $1 and $2
      order by account_order`,
    [fromOrder, toOrder],
  )).rows;
  if (accounts.length !== accountCount) {
    throw new Error(`계정 ${fromOrder}~${toOrder} 는 ${accountCount}개여야 하는데 ${accounts.length}개다.`);
  }
  const blocked = accounts.filter((a) => a.status === 'blocked');
  if (blocked.length) {
    throw new Error(`정지된 계정이 섞여 있다: ${blocked.map((a) => a.account_order).join(', ')}`);
  }
  const withDomains = (await client.query(
    `select count(*)::int n from public.naver_project_domains d
       join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where a.account_order between $1 and $2`, [fromOrder, toOrder],
  )).rows[0].n;
  if (withDomains) throw new Error(`계정 ${fromOrder}~${toOrder} 에 이미 도메인 ${withDomains}개가 붙어 있다.`);

  const maxOrder = (await client.query(
    "select coalesce(max((source_payload->>'globalSiteOrder')::int), 0) mx from public.naver_project_domains",
  )).rows[0].mx;
  if (startOrder <= maxOrder) {
    throw new Error(`globalSiteOrder 시작값 ${startOrder} 이 기존 최대 ${maxOrder} 이하다 — 페이지가 겹친다.`);
  }

  /* 후보: 하이픈 없는 두 단어 조합 */
  const candidates = [];
  for (const a of words) for (const b of words) if (a !== b) candidates.push({ word1: a, word2: b, subdomain: `${a}${b}` });
  shuffle(candidates, seed);

  const picked = [];
  const seen = new Set();
  for (const c of candidates) {
    if (picked.length >= totalSites) break;
    if (seen.has(c.subdomain) || usedSub.has(c.subdomain)) continue;
    seen.add(c.subdomain);
    picked.push(c);
  }
  if (picked.length < totalSites) throw new Error(`후보가 모자란다: ${picked.length}/${totalSites}`);

  /* 루트를 라운드로빈으로 — 루트마다 정확히 같은 수, 계정마다 모든 루트에 고루 퍼진다 */
  const domains = picked.map((c, i) => {
    const root = DOMAIN_ROOTS[i % DOMAIN_ROOTS.length];
    const account = accounts[Math.floor(i / sitesPerAccount)];
    const host = `${c.subdomain}.${root}`;
    if (used.has(host)) throw new Error(`이미 쓰는 host: ${host}`);
    return {
      host,
      site_url: `https://${host}`,
      group_key: groupKey,
      project_key: groupKey,
      target_project: groupKey,
      naver_account_id: account.account_id,
      deployment_status: 'active',
      is_visible: true,
      naver_registration_status: 'pending',
      page_count: 200,
      subdomain_generation_strategy: 'joined-two-words',
      source_payload: {
        word1: c.word1,
        word2: c.word2,
        subdomain: c.subdomain,
        domainRoot: root,
        accountOrder: account.account_order,
        globalSiteOrder: startOrder + i,
        accountSiteOrder: (i % sitesPerAccount) + 1,
      },
    };
  });

  const byRoot = {};
  for (const d of domains) byRoot[d.source_payload.domainRoot] = (byRoot[d.source_payload.domainRoot] || 0) + 1;
  const perAccount = new Set(Object.values(domains.reduce((m, d) => {
    m[d.source_payload.accountOrder] = (m[d.source_payload.accountOrder] || 0) + 1; return m;
  }, {})));

  plan = {
    seed,
    groupKey,
    generatedFor: '배관 신규 서브도메인',
    accounts: `${fromOrder}~${toOrder}`,
    sitesPerAccount,
    totalSites: domains.length,
    globalSiteOrderRange: [startOrder, startOrder + domains.length - 1],
    perRoot: byRoot,
    perAccountCounts: [...perAccount],
    subdomainLength: {
      min: Math.min(...domains.map((d) => d.source_payload.subdomain.length)),
      max: Math.max(...domains.map((d) => d.source_payload.subdomain.length)),
    },
    domains,
  };
} finally {
  await client.end();
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(plan, null, 2), 'utf8');

const { domains, ...summary } = plan;
console.log(JSON.stringify(summary, null, 2));
console.log('\n예시 12개:');
for (const d of domains.slice(0, 6)) console.log(`  ${d.host.padEnd(34)} 계정 ${d.source_payload.accountOrder}  order ${d.source_payload.globalSiteOrder}`);
console.log('  ...');
for (const d of domains.slice(-6)) console.log(`  ${d.host.padEnd(34)} 계정 ${d.source_payload.accountOrder}  order ${d.source_payload.globalSiteOrder}`);
console.log(`\n계획서: ${outputPath}  (DB 에는 아무것도 쓰지 않았다)`);
