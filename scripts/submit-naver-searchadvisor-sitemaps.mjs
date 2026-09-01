#!/usr/bin/env node
/**
 * 서치어드바이저에 사이트맵을 제출한다. 소유확인이 끝난 도메인만 대상이다.
 *
 *   node scripts/submit-naver-searchadvisor-sitemaps.mjs --accounts 1-20 --dry-run
 *   node scripts/submit-naver-searchadvisor-sitemaps.mjs --account lguxp4nlw --limit 5
 *   node scripts/submit-naver-searchadvisor-sitemaps.mjs --accounts 1-20
 *
 * 사이트맵 자체는 배포 때 이미 올라가 있다 (호스트당 101개 URL: 홈 + 1~100.html).
 * 여기서 하는 일은 "그 주소를 네이버에 알려주는 것" 하나뿐이다.
 *
 * 2026-08-13 에 다시 씀. 이전 판에는 이런 문제가 있었다.
 *   1. 세션을 tmp/naver-crawl-runtime/{계정}-cleaning-ravi.storage.json 에서 찾았는데
 *      수집요청 러너는 실행별 하위 폴더에 만들고 끝나면 지운다. 즉 항상 없었다.
 *      쿠키가 빈 채로 POST 가 나가고, 로그인 페이지 HTML 에 "완료"·"이미" 같은
 *      글자가 섞이면 그걸 성공으로 셌다. 실패를 성공으로 보고하는 구조였다.
 *   2. 계정 범위 인자가 없어 verified 전량(58계정)을 무조건 돌렸다.
 *   3. group_key 필터가 없어 다른 프로젝트까지 딸려 들어갈 수 있었다.
 *   4. 계정별 검증 IP 로 맞추지 않고 그때 PC 의 IP 로 그냥 나갔다.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const groupKey = options.groupKey || 'cleaning-ravi';
/*
 * 제출할 사이트맵 경로. 기본값은 지금까지와 같다 — 청소·배관 1만은 바뀌지 않는다.
 * 브랜드는 /sitemap_index.xml 이 색인이다 (/sitemap.xml 도 같은 내용을 준다).
 */
const sitemapPath = options.sitemapPath || '/sitemap.xml';
const limit = options.limit ? Number(options.limit) : null;
const perSiteDelayMs = Number(options.delayMs || 250);
const skipHaiIp = Boolean(options.noHaiip);
const tmpRoot = resolve(projectRoot, 'tmp/naver-sitemap');
const haiIpScript = resolve(projectRoot, 'scripts/haiip-windows-ui-control.ps1');
const reportDir = resolve(projectRoot, 'reports/naver-sitemap');

/** 한 계정에서 이만큼 연달아 실패하면 그 계정은 중단한다. 세션이 죽은 것이다. */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const summary = [];
try {
  const accounts = await loadAccounts();
  console.log(`대상 계정 ${accounts.length}개 (group=${groupKey}, dryRun=${dryRun})`);

  for (const account of accounts) {
    console.log(`\n▶ #${account.account_order} ${account.account_id}`);
    try {
      summary.push(await submitForAccount(account));
    } catch (error) {
      console.log(`  ✗ 중단: ${error.message}`);
      summary.push({
        accountId: account.account_id,
        accountOrder: account.account_order,
        ok: false,
        error: error.message,
        submitted: 0,
        already: 0,
        failed: 0,
        unknown: 0,
        total: 0,
      });
    }
  }
} finally {
  await client.end();
}

printSummary();
writeReport();

// ---------------------------------------------------------------- 계정 단위

async function loadAccounts() {
  const where = options.account
    ? { clause: 'where account_id = any($1::text[])', params: [String(options.account).split(',').map((v) => v.trim()).filter(Boolean)] }
    : (() => {
      const range = String(options.accounts || '').match(/^(\d+)-(\d+)$/);
      if (!range) throw new Error('--account <id[,id]> 또는 --accounts <시작>-<끝> 이 필요합니다.');
      return { clause: 'where account_order between $1 and $2', params: [Number(range[1]), Number(range[2])] };
    })();

  const result = await client.query(
    `select account_id, account_order, status, searchadvisor_session_secret_id,
            host(searchadvisor_session_validated_public_ip) as validated_ip
       from public.naver_searchadvisor_accounts ${where.clause} order by account_order`,
    where.params,
  );
  if (!result.rowCount) throw new Error('대상 계정이 없습니다.');
  return result.rows;
}

async function submitForAccount(account) {
  if (account.status !== 'active') throw new Error(`계정 상태가 active 가 아닙니다: ${account.status}`);

  const domains = (await client.query(
    `select id, host, site_url
       from public.naver_project_domains
      where group_key = $1 and naver_account_id = $2
        and naver_registration_status = 'verified'
        and deployment_status = 'active' and is_visible = true
      order by (source_payload->>'globalSiteOrder')::int
      ${limit ? 'limit ' + Number(limit) : ''}`,
    [groupKey, account.account_id],
  )).rows;

  console.log(`  소유확인 완료 도메인 ${domains.length}건`);
  if (!domains.length) {
    return { accountId: account.account_id, accountOrder: account.account_order, ok: true, submitted: 0, already: 0, failed: 0, unknown: 0, total: 0 };
  }

  if (dryRun) {
    console.log(`  [dry-run] 예시: ${domains[0].site_url.replace(/\/+$/, '')}${sitemapPath}`);
    return { accountId: account.account_id, accountOrder: account.account_order, ok: true, dryRun: true, submitted: 0, already: 0, failed: 0, unknown: 0, total: domains.length };
  }

  if (!account.searchadvisor_session_secret_id) throw new Error('저장된 세션이 없습니다.');
  if (!account.validated_ip) throw new Error('검증 IP 가 없습니다.');

  await ensureAccountIp(account);

  let submitted = 0;
  let already = 0;
  let failed = 0;
  let unknown = 0;
  let consecutiveFailures = 0;
  const problems = [];

  const session = await openConsole(account.account_id, domains[0].site_url.replace(/\/+$/, ''));
  try {
    for (const [index, domain] of domains.entries()) {
      const origin = domain.site_url.replace(/\/+$/, '');
      const outcome = await submitOne(session, origin);

      if (outcome.kind === 'session-dead') {
        throw new Error(`세션이 만료됐습니다 (${domain.host}). capture-naver-session.mjs 로 다시 잡아야 합니다.`);
      }

      if (outcome.kind === 'submitted') { submitted += 1; consecutiveFailures = 0; process.stdout.write('.'); }
      else if (outcome.kind === 'already') { already += 1; consecutiveFailures = 0; process.stdout.write('='); }
      else if (outcome.kind === 'unknown') {
        unknown += 1; consecutiveFailures += 1; process.stdout.write('?');
        problems.push({ host: domain.host, status: outcome.status, body: outcome.body });
      } else {
        failed += 1; consecutiveFailures += 1; process.stdout.write('x');
        problems.push({ host: domain.host, status: outcome.status, body: outcome.body });
      }

      if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        console.log('');
        throw new Error(`${ABORT_AFTER_CONSECUTIVE_FAILURES}건 연속 실패로 중단했습니다. 마지막 응답: ${problems.at(-1)?.status} ${String(problems.at(-1)?.body).slice(0, 160)}`);
      }

      if (index < domains.length - 1) await sleep(perSiteDelayMs);
    }
  } finally {
    await session.close();
  }

  console.log('');
  console.log(`  제출 ${submitted} · 이미등록 ${already} · 실패 ${failed} · 판정불가 ${unknown}`);
  for (const problem of problems.slice(0, 5)) {
    console.log(`    - ${problem.host}: HTTP ${problem.status} ${String(problem.body).slice(0, 160)}`);
  }
  if (problems.length > 5) console.log(`    - ... 외 ${problems.length - 5}건`);

  return {
    accountId: account.account_id,
    accountOrder: account.account_order,
    ok: failed === 0 && unknown === 0,
    submitted, already, failed, unknown,
    total: domains.length,
    problems: problems.slice(0, 20),
  };
}

// ---------------------------------------------------------------- 제출 한 건

/**
 * 실제 콘솔이 보내는 요청은 이렇다 (2026-08-13 에 브라우저에서 캡처).
 *
 *   POST /api-console/request/sitemap/{계정해시}
 *   { "url": "https://호스트/sitemap.xml", "_csrf": "<토큰>" }
 *   → HTTP 200, 본문 없음
 *
 * 계정해시(enc_id)와 _csrf 는 콘솔을 한 번 띄우면 둘 다 얻어진다. 사이트별이
 * 아니라 계정·세션 단위라서, 계정당 페이지를 한 번만 열고 100건을 다 보낼 수 있다.
 *
 * 이전 판은 `/api-console/request/sitemap` 에 `{site, sitemap}` 을 보냈다.
 * 그건 CSRF 도 경로도 틀려서 403/404 만 받았다. 즉 한 번도 제출된 적이 없다.
 */
async function submitOne(session, origin) {
  const result = await session.page.evaluate(async ([encId, csrf, url]) => {
    try {
      const res = await fetch(`/api-console/request/sitemap/${encId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          'csrf-token': csrf,
        },
        body: JSON.stringify({ url, _csrf: csrf }),
        credentials: 'include',
      });
      return { status: res.status, body: (await res.text()).slice(0, 200) };
    } catch (error) {
      return { status: 0, body: String(error && error.message) };
    }
  }, [session.encId, session.csrf, `${origin}${sitemapPath}`]);

  return classify(result.status, result.body);
}

function classify(status, body) {
  if (status === 401 || status === 403) return { kind: 'session-dead', status, body };
  if (status === 200) return { kind: 'submitted', status, body };
  // 409 는 그 사이트에 사이트맵이 이미 등록돼 있을 때 나온다. 재실행해도 안전하다.
  if (status === 409 || /이미|already|duplicate/i.test(body)) return { kind: 'already', status, body };
  if (status === 0 || status >= 500) return { kind: 'failed', status, body };
  return { kind: 'unknown', status, body };
}

// ---------------------------------------------------------------- 세션 / IP

/**
 * 저장된 세션으로 서치어드바이저 콘솔을 띄우고, 거기서 계정해시와 CSRF 토큰을 얻는다.
 * 순수 fetch 로는 CSRF 를 못 넘어서 브라우저가 필요하다.
 */
async function openConsole(accountId, firstOrigin) {
  mkdirSync(tmpRoot, { recursive: true });
  const statePath = resolve(tmpRoot, `${accountId}.storage.json`);
  await execFileAsync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', accountId,
    '--output', statePath,
  ], { cwd: projectRoot });

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const names = new Set((state.cookies || []).map((cookie) => cookie.name));
  if (!names.has('NID_AUT') || !names.has('NID_SES')) {
    rmSync(statePath, { force: true });
    throw new Error('세션에 로그인 쿠키(NID_AUT/NID_SES)가 없습니다.');
  }

  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
    .catch(() => chromium.launch({ headless: true }));
  const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
  rmSync(statePath, { force: true });
  const page = await context.newPage();

  let csrf = '';
  let encId = '';
  page.on('request', (request) => {
    const token = request.headers()['csrf-token'];
    if (token && !csrf) csrf = token;
    const match = request.url().match(/\/api-console\/request\/sitemap\/([0-9a-f]{64})/);
    if (match && !encId) encId = match[1];
  });

  const close = async () => { await browser.close().catch(() => {}); };
  try {
    await page.goto(
      `https://searchadvisor.naver.com/console/site/request/sitemap?site=${encodeURIComponent(firstOrigin)}`,
      { waitUntil: 'networkidle', timeout: 60_000 },
    );
    if (page.url().includes('nid.naver.com')) throw new Error('로그인 페이지로 튕겼습니다. 세션이 죽었습니다.');
    await page.waitForTimeout(1500);

    // enc_id 는 Nuxt 상태에도 들어 있다. 요청 가로채기가 실패했을 때의 대비책.
    if (!encId) {
      encId = await page.evaluate(() => {
        const found = JSON.stringify(window.__NUXT__ || {}).match(/"enc_id"\s*:\s*"([0-9a-f]{64})"/);
        return found ? found[1] : '';
      });
    }
    if (!csrf || !encId) throw new Error(`콘솔에서 토큰을 못 얻었습니다 (csrf=${Boolean(csrf)}, encId=${Boolean(encId)}).`);
    console.log(`  콘솔 준비 완료 (계정해시 ${encId.slice(0, 8)}…)`);
    return { browser, context, page, csrf, encId, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** 계정마다 등록된 검증 IP 로 옮긴다. 소유확인·수집요청과 같은 방식이다. */
async function ensureAccountIp(account) {
  const target = account.validated_ip;
  let current = publicIp();
  if (current === target) {
    console.log(`  IP 확인: ${current} (이미 일치)`);
    return;
  }
  if (skipHaiIp) {
    console.log(`  ⚠️ IP 불일치(현재 ${current}, 필요 ${target}) — --no-haiip 라 그대로 진행합니다.`);
    return;
  }

  console.log(`  IP 전환: ${current} -> ${target}`);
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', haiIpScript,
    '-Command', 'change', '-PreferredIp', target, '-CheckPreferredResult',
    '-PreferredWaitSeconds', '30', '-PreferredActivationRetries', '3',
  ], { stdio: 'pipe', timeout: 240_000 });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(2500);
    current = publicIp();
    if (current === target) { console.log(`  IP 확인: ${current} ✅`); return; }
  }
  throw new Error(`IP 전환 실패: 목표 ${target}, 현재 ${current}`);
}

function publicIp() {
  const out = execFileSync('curl', ['-s', '--max-time', '15', `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) throw new Error(`공인 IP 를 못 읽었습니다: ${out}`);
  return out;
}

// ---------------------------------------------------------------- 마무리

function printSummary() {
  const total = summary.reduce((acc, row) => ({
    submitted: acc.submitted + row.submitted,
    already: acc.already + row.already,
    failed: acc.failed + row.failed,
    unknown: acc.unknown + row.unknown,
    domains: acc.domains + row.total,
  }), { submitted: 0, already: 0, failed: 0, unknown: 0, domains: 0 });

  console.log('\n=== 요약 ===');
  for (const row of summary) {
    const mark = row.error ? '✗' : row.ok ? '✅' : '⚠️';
    console.log(`  ${mark} #${String(row.accountOrder).padStart(3)} ${row.accountId.padEnd(18)} 제출 ${String(row.submitted).padStart(4)} / 이미 ${String(row.already).padStart(4)} / 실패 ${String(row.failed).padStart(4)} / 판정불가 ${String(row.unknown).padStart(4)}${row.error ? '  ' + row.error : ''}`);
  }
  console.log(`  ---`);
  console.log(`  대상 ${total.domains} · 제출 ${total.submitted} · 이미등록 ${total.already} · 실패 ${total.failed} · 판정불가 ${total.unknown}`);
}

function writeReport() {
  if (dryRun) return;
  mkdirSync(reportDir, { recursive: true });
  const path = resolve(reportDir, `sitemap-submit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify({ groupKey, accounts: summary }, null, 2), 'utf8');
  console.log(`\n리포트: ${path}`);
}

// ---------------------------------------------------------------- 유틸

function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { result[key] = next; index += 1; } else { result[key] = true; }
  }
  return result;
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms); });
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
