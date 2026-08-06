#!/usr/bin/env node
/**
 * 서치어드바이저 "검색 노출/클릭" 리포트의 내부 API 엔드포인트를 찾는 탐침.
 *
 * 수집요청은 이미 /api-console/request/crawl 을 직접 호출하고 있는데(=mode=api),
 * 리포트 쪽 엔드포인트는 코드에 없다. 콘솔을 열어 오가는 XHR 을 그대로 받아적어
 * 어떤 주소로 무엇을 주고받는지 확인한다.
 *
 * 읽기 전용. 제출/변경 요청은 하지 않는다. HaiIP 도 건드리지 않으므로
 * 반드시 "지금 IP 가 물려 있는 계정"으로 돌려야 한다.
 *
 *   node scripts/probe-naver-searchadvisor-report.mjs --account <id> [--site https://host]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const accountId = options.account;
if (!accountId) throw new Error('--account 는 필수입니다.');

const outDir = resolve(projectRoot, 'tmp/ctr-probe');
mkdirSync(outDir, { recursive: true });

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
let site = options.site;
try {
  if (!site) {
    const { rows } = await client.query(
      `select site_url from public.naver_project_domains
        where naver_account_id = $1 and naver_registration_status = 'verified'
        order by (source_payload->>'globalSiteOrder')::int limit 1`,
      [accountId],
    );
    if (!rows.length) throw new Error(`계정 ${accountId} 에 소유확인된 도메인이 없습니다.`);
    site = rows[0].site_url;
  }
} finally {
  await client.end();
}
console.log(`계정 ${accountId} / 사이트 ${site}`);

const statePath = resolve(projectRoot, 'tmp/naver-login', `${accountId}.storage.json`);
mkdirSync(dirname(statePath), { recursive: true });
execFileSync(process.execPath, [
  resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
  '--account', accountId, '--output', statePath,
], { stdio: 'pipe' });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
const page = await context.newPage();

// 오가는 요청을 전부 기록한다. 리포트는 XHR 로 데이터를 받아오므로
// 그중 JSON 응답만 추려보면 엔드포인트가 드러난다.
const calls = [];
page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('searchadvisor.naver.com')) return;
  if (/\.(js|css|png|jpg|gif|svg|woff2?|ico)(\?|$)/i.test(url)) return;
  let body = '';
  try { body = (await response.text()).slice(0, 1500); } catch { body = '(본문 읽기 실패)'; }
  calls.push({
    method: response.request().method(),
    status: response.status(),
    url,
    postData: response.request().postData()?.slice(0, 500) || null,
    body,
  });
});

const visited = [];
try {
  const encoded = encodeURIComponent(site);
  // 리포트 계열로 알려진 경로들을 차례로 두드려 본다.
  const candidates = [
    `https://searchadvisor.naver.com/console/board`,
    `https://searchadvisor.naver.com/console/site/summary?site=${encoded}`,
    `https://searchadvisor.naver.com/console/site/inflow/search?site=${encoded}`,
    `https://searchadvisor.naver.com/console/site/inflow/keyword?site=${encoded}`,
    `https://searchadvisor.naver.com/console/site/report/inflow?site=${encoded}`,
  ];

  for (const url of candidates) {
    try {
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 40_000 });
      await page.waitForTimeout(2500);
      const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
      visited.push({ url, status: res?.status() ?? null, textHead: text.slice(0, 400) });
      console.log(`\n[${res?.status()}] ${url}\n  ${text.slice(0, 200)}`);
    } catch (error) {
      visited.push({ url, status: null, error: error.message.split('\n')[0] });
      console.log(`\n[ERR] ${url}\n  ${error.message.split('\n')[0]}`);
    }
  }

  // 콘솔 좌측 메뉴의 실제 링크를 긁어 리포트 경로를 확인한다.
  await page.goto(`https://searchadvisor.naver.com/console/site/summary?site=${encoded}`,
    { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
    .map((a) => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.getAttribute('href') }))
    .filter((x) => x.href && x.href.includes('/console/')));
  writeFileSync(resolve(outDir, 'menu.json'), JSON.stringify(menu, null, 2));
  console.log(`\n=== 콘솔 메뉴 링크 ${menu.length}개 (tmp/ctr-probe/menu.json) ===`);
  for (const item of menu.slice(0, 40)) console.log(`  ${item.text || '(빈 텍스트)'}  ->  ${item.href}`);
} finally {
  writeFileSync(resolve(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
  writeFileSync(resolve(outDir, 'visited.json'), JSON.stringify(visited, null, 2));
  console.log(`\n=== 네트워크 호출 ${calls.length}건 (tmp/ctr-probe/calls.json) ===`);
  for (const call of calls) {
    if (!/json/i.test(call.body.slice(0, 60)) && !call.body.trim().startsWith('{')) continue;
    console.log(`  ${call.method} [${call.status}] ${call.url}`);
  }
  await browser.close();
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
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
