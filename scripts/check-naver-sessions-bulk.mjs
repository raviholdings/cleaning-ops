#!/usr/bin/env node
/**
 * 저장된 세션으로 서치어드바이저 콘솔이 열리는지 계정별로 확인한다.
 *
 *   node scripts/check-naver-sessions-bulk.mjs --accounts 51-80
 *   node scripts/check-naver-sessions-bulk.mjs --account aaa,bbb,ccc
 *   node scripts/check-naver-sessions-bulk.mjs --accounts 51-80 --show
 *
 * **로그인을 시도하지 않는다.** 이미 저장된 세션을 그대로 써서 콘솔 화면만
 * 열어보고 끝낸다. 보호조치가 걸린 상태에서 로그인을 반복하면 더 잠긴다.
 * DB 도 읽기만 한다.
 *
 * 기존 check-naver-session-alive.mjs 는 계정 하나씩만 되고, IP 를 안 맞추고,
 * headless 로 열어서 멀쩡한 세션도 죽었다고 나왔다. 세 가지를 다 고쳤다.
 *   - 계정마다 HaiIP 로 그 계정의 검증 IP 로 전환 (안 맞으면 네이버가 거부한다)
 *   - 브라우저를 실제로 띄운다 (화면 밖). headless 면 콘솔 대신 첫 화면이 뜬다
 *   - 콘솔 안에서만 보이는 글자로 판정 ("웹마스터 도구" 는 첫 화면에도 있다)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const tmpRoot = resolve(projectRoot, 'tmp/naver-login');
const haiIpScript = resolve(projectRoot, 'scripts/haiip-windows-ui-control.ps1');
const skipHaiIp = Boolean(options.noHaiip);
const BOARD_URL = 'https://searchadvisor.naver.com/console/board';

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const results = [];
try {
  const accounts = await loadAccounts();
  console.log(JSON.stringify({ phase: 'plan', accounts: accounts.length }));

  for (const [index, account] of accounts.entries()) {
    console.log(`\n===== [${index + 1}/${accounts.length}] ${account.account_id} (#${account.account_order}) =====`);
    try {
      results.push(await checkOne(account));
    } catch (error) {
      const reason = error.message.split('\n')[0];
      console.log(`  ✗ ${reason}`);
      results.push({ order: account.account_order, accountId: account.account_id, ok: false, reason });
    }
  }
} finally {
  await client.end();
}

const ok = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);

console.log(`\n${'='.repeat(60)}`);
console.log(`정상 ${ok.length}개 / 문제 ${bad.length}개 / 전체 ${results.length}개\n`);
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} #${String(r.order).padEnd(4)} ${r.accountId.padEnd(20)} ${r.ok ? `사이트 ${r.siteCount}개` : r.reason}`);
}

if (bad.length) {
  console.log(`\n----- 문제 있는 계정 ${bad.length}개 -----`);
  console.log(bad.map((r) => r.accountId).join(','));
  const recapture = bad.filter((r) => r.needsRecapture);
  if (recapture.length) {
    console.log(`\n----- 그중 재캡처가 필요한 ${recapture.length}개 -----`);
    console.log(`node scripts/capture-naver-session.mjs --force --no-auto-click --account \\\n${recapture.map((r) => r.accountId).join(',')}`);
  }
}

process.exitCode = bad.length ? 1 : 0;

async function checkOne(account) {
  if (!account.searchadvisor_session_secret_id) {
    return { order: account.account_order, accountId: account.account_id, ok: false, reason: '저장된 세션이 없습니다', needsRecapture: true };
  }
  if (!account.validated_ip) {
    return { order: account.account_order, accountId: account.account_id, ok: false, reason: '검증 IP 가 없습니다', needsRecapture: true };
  }

  await ensureAccountIp(account);

  const statePath = resolve(tmpRoot, `${account.account_id}.check.json`);
  mkdirSync(tmpRoot, { recursive: true });
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', account.account_id, '--output', statePath,
  ], { stdio: 'pipe' });

  // headless 로 열면 콘솔 대신 첫 화면이 뜨는 계정이 있다. 실제로 띄우되
  // 화면 밖에 둔다.
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    ...(options.show ? {} : { args: ['--window-position=-2400,-2400', '--window-size=1280,900'] }),
  });
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
    const page = await context.newPage();
    await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.locator('input[type=text]').first().waitFor({ state: 'visible', timeout: 12_000 });
    } catch { /* 아래에서 화면으로 원인을 가린다 */ }

    // 등록된 사이트 목록은 입력창보다 늦게 그려진다. 안 기다리고 읽으면
    // 100개를 등록해둔 계정도 "0개" 로 나온다(실제로 #6, #10 이 그랬다).
    // 목록이 뜰 때까지 잠깐 더 본다. 진짜 0개인 계정은 이 시간을 그냥 쓴다.
    await page.locator('tbody tr').first().waitFor({ state: 'attached', timeout: 6_000 }).catch(() => {});

    const state = await page.evaluate(() => ({
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
      url: location.href,
      textInputs: document.querySelectorAll('input[type=text]').length,
      rows: document.querySelectorAll('tbody tr').length,
    }));

    const base = { order: account.account_order, accountId: account.account_id };

    if (state.textInputs > 0) {
      console.log(`  ✅ 콘솔 열림 (등록된 사이트 ${state.rows}개)`);
      return { ...base, ok: true, siteCount: state.rows };
    }

    const snippet = state.body.slice(0, 100);
    if (/로그인에 문제가 발생|아이디 또는 전화번호|NAVER 로그인/.test(state.body) || /nid\.naver\.com/.test(state.url)) {
      console.log(`  ❌ 로그인 화면으로 튕김`);
      return { ...base, ok: false, reason: '로그인 화면으로 튕김 (재캡처 필요)', needsRecapture: true };
    }
    if (/보호조치|이용 제한|잠금|비정상적인 접근|본인 확인/.test(state.body)) {
      console.log(`  ❌ 보호조치: ${snippet}`);
      return { ...base, ok: false, reason: `보호조치가 걸렸습니다 — ${snippet}` };
    }
    if (/웹마스터 가이드/.test(state.body)) {
      const loggedIn = /power_settings_new/.test(state.body);
      console.log(`  ❌ 콘솔 대신 첫 화면 (${loggedIn ? '로그인됨' : '로그아웃'})`);
      return loggedIn
        ? { ...base, ok: false, reason: '로그인은 됐는데 콘솔이 안 열림' }
        : { ...base, ok: false, reason: '로그아웃 상태 (재캡처 필요)', needsRecapture: true };
    }
    console.log(`  ❌ 알 수 없음: ${snippet}`);
    return { ...base, ok: false, reason: `원인 불명 — ${snippet}` };
  } finally {
    await browser.close().catch(() => {});
    rmSync(statePath, { force: true });
  }
}

async function loadAccounts() {
  const select = (where) => `
    select account_id, account_order, status,
           searchadvisor_session_secret_id,
           host(searchadvisor_session_validated_public_ip) as validated_ip
      from public.naver_searchadvisor_accounts ${where}`;

  if (options.account) {
    const ids = String(options.account).split(',').map((s) => s.trim()).filter(Boolean);
    const { rows } = await client.query(select('where account_id = any($1::text[]) order by account_order'), [ids]);
    if (!rows.length) throw new Error(`계정을 찾을 수 없습니다: ${ids.join(', ')}`);
    return rows;
  }
  const range = String(options.accounts || '').match(/^(\d+)-(\d+)$/);
  if (!range) throw new Error('--accounts <시작>-<끝> 또는 --account <id[,id...]> 가 필요합니다.');
  const { rows } = await client.query(
    select('where account_order between $1 and $2 order by account_order'),
    [Number(range[1]), Number(range[2])],
  );
  if (!rows.length) throw new Error(`순번 ${range[1]}~${range[2]} 에 계정이 없습니다.`);
  return rows;
}

async function ensureAccountIp(account) {
  const target = account.validated_ip;
  let current = publicIp();
  if (current === target) {
    console.log(`  IP 확인: ${current} (이미 일치)`);
    return;
  }
  if (skipHaiIp) throw new Error(`IP 불일치: 현재 ${current}, 필요 ${target} (--no-haiip)`);

  console.log(`  IP 전환: ${current} -> ${target}`);
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', haiIpScript,
    '-Command', 'change', '-PreferredIp', target, '-CheckPreferredResult',
    '-PreferredWaitSeconds', '30', '-PreferredActivationRetries', '3',
  ], { stdio: 'pipe', timeout: 240_000 });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await new Promise((r) => { setTimeout(r, 2500); });
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
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch { /* .env 없으면 환경변수로 준 것을 쓴다 */ }
}
