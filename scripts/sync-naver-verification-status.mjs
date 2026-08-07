#!/usr/bin/env node
/**
 * 서치어드바이저의 실제 소유확인 상태를 읽어 DB 에 반영한다.
 *
 *   node scripts/sync-naver-verification-status.mjs --account lguxp4nlw --dry-run
 *   node scripts/sync-naver-verification-status.mjs --accounts 1-10
 *
 * DB 를 임의로 verified 로 표시하지 않는다. 네이버 API 가 verified=true 로
 * 준 사이트만 갱신한다. 근거는 api-board/list 응답이다.
 *
 *   GET /api-board/list/{encId}
 *   items[] = { site, verified, ownCheckYn, ownCheckDateTime, ... }
 *
 * 계정 세션을 쓰므로 검증 IP 와 현재 IP 가 같아야 한다(프록시 모드면 생략).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';
import { playwrightProxy, resolveProxyConfig, logProxyBanner } from './lib/naver-proxy.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const groupKey = options.groupKey || 'cleaning-ravi';
const requireIp = !options.noRequireIp;
const tmpRoot = resolve(projectRoot, 'tmp/naver-login');

const proxyConfig = resolveProxyConfig({
  cliFlag: Boolean(options.useProxy),
  projectRoot,
});
logProxyBanner(proxyConfig, 'verification status sync');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const accounts = await loadAccounts();
  console.log(JSON.stringify({ phase: 'plan', accounts: accounts.map((a) => a.account_id), dryRun }));

  const summary = [];
  for (const account of accounts) {
    console.log(`\n===== ${account.account_id} =====`);
    try {
      summary.push(await syncAccount(account));
    } catch (error) {
      console.error(`  ✗ ${error.message}`);
      summary.push({ accountId: account.account_id, ok: false, error: error.message });
    }
  }
  console.log(`\n${JSON.stringify({ phase: 'summary', dryRun, summary }, null, 2)}`);
} finally {
  await client.end();
}

async function loadAccounts() {
  const where = options.account
    ? { clause: 'where account_id = $1', params: [options.account] }
    : (() => {
      const range = String(options.accounts || '').match(/^(\d+)-(\d+)$/);
      if (!range) throw new Error('--account <id> 또는 --accounts <시작>-<끝> 이 필요합니다.');
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

async function syncAccount(account) {
  if (!account.searchadvisor_session_secret_id) throw new Error('저장된 세션이 없습니다.');

  if (requireIp && !proxyConfig.enabled) {
    const current = publicIp();
    if (current !== account.validated_ip) {
      throw new Error(`IP 불일치: 현재 ${current}, 필요 ${account.validated_ip}. `
        + `HaiIP 로 전환하거나 --no-require-ip 를 쓰세요.`);
    }
    console.log(`  IP 확인: ${current}`);
  }

  mkdirSync(tmpRoot, { recursive: true });
  const statePath = resolve(tmpRoot, `${account.account_id}.sync.json`);
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', account.account_id, '--output', statePath,
  ], { stdio: 'pipe' });

  const proxy = playwrightProxy(proxyConfig);
  const browser = await chromium.launch({ headless: true, channel: 'chrome', ...(proxy ? { proxy } : {}) });
  let items = [];
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
    const page = await context.newPage();

    // 보드에 들어가야 enc_id 가 확정되고 세션 쿠키가 갱신된다.
    const listPromise = page.waitForResponse(
      (res) => /\/api-board\/list\//.test(res.url()) && res.status() === 200,
      { timeout: 45_000 },
    );
    await page.goto('https://searchadvisor.naver.com/console/board', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const listResponse = await listPromise;
    const body = await listResponse.json();
    if (body?.code !== 0) throw new Error(`api-board/list 응답 코드 ${body?.code}: ${body?.message}`);
    items = Array.isArray(body.items) ? body.items : [];
  } finally {
    await browser.close().catch(() => {});
    rmSync(statePath, { force: true });
  }

  const verifiedHosts = new Set();
  for (const item of items) {
    const isVerified = item?.verified === true || item?.ownCheckYn === 'Y';
    if (!isVerified) continue;
    try { verifiedHosts.add(new URL(item.site).host); } catch { /* 무시 */ }
  }
  console.log(`  네이버 사이트 목록 ${items.length}건, 그중 소유확인 완료 ${verifiedHosts.size}건`);

  const dbRows = await client.query(
    `select id, host, naver_registration_status
       from public.naver_project_domains
      where group_key = $1 and naver_account_id = $2`,
    [groupKey, account.account_id],
  );

  const toVerify = dbRows.rows.filter((row) => verifiedHosts.has(row.host) && row.naver_registration_status !== 'verified');
  const alreadyVerified = dbRows.rows.filter((row) => row.naver_registration_status === 'verified').length;
  const notVerifiedOnNaver = dbRows.rows.filter((row) => !verifiedHosts.has(row.host)).length;
  const onNaverNotInDb = [...verifiedHosts].filter((host) => !dbRows.rows.some((row) => row.host === host));

  console.log(`  DB ${dbRows.rowCount}건 | 갱신 대상 ${toVerify.length}건 | 이미 verified ${alreadyVerified}건 | 네이버에서 미확인 ${notVerifiedOnNaver}건`);
  if (onNaverNotInDb.length) console.log(`  ⚠ 네이버에는 있는데 DB 에 없는 호스트 ${onNaverNotInDb.length}건: ${onNaverNotInDb.slice(0, 3).join(', ')}`);

  if (!dryRun && toVerify.length) {
    await client.query(
      `update public.naver_project_domains
          set naver_registration_status = 'verified',
              naver_verified_at = coalesce(naver_verified_at, now()),
              updated_at = now()
        where id = any($1::bigint[])`,
      [toVerify.map((row) => row.id)],
    );
    console.log(`  ✅ ${toVerify.length}건을 verified 로 갱신했습니다.`);
  } else if (dryRun && toVerify.length) {
    console.log(`  (dry-run: ${toVerify.length}건을 갱신하지 않았습니다)`);
  }

  return {
    accountId: account.account_id,
    ok: true,
    naverListed: items.length,
    naverVerified: verifiedHosts.size,
    dbRows: dbRows.rowCount,
    updated: dryRun ? 0 : toVerify.length,
    wouldUpdate: dryRun ? toVerify.length : undefined,
    alreadyVerified,
    notVerifiedOnNaver,
  };
}

function publicIp() {
  const out = execFileSync('curl', ['-s', '--max-time', '15', `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) throw new Error(`공인 IP 를 못 읽었습니다: ${out}`);
  return out;
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
