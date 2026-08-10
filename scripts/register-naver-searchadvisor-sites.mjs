#!/usr/bin/env node
/**
 * 서치어드바이저에 서브도메인을 등록하고 HTML 태그 인증키를 받아 DB 에 넣는다.
 * 소유확인은 여기서 하지 않는다. 메타태그를 배포한 뒤 별도 단계로 진행한다.
 *
 *   node scripts/register-naver-searchadvisor-sites.mjs --account lguxp4nlw --limit 5
 *   node scripts/register-naver-searchadvisor-sites.mjs --accounts 1-10
 *   node scripts/register-naver-searchadvisor-sites.mjs --accounts 1-10 --show   # 창을 보면서
 *
 * 브라우저는 실제로 뜨지만 기본값은 화면 밖에 둬서 눈에 안 보인다.
 * headless 로 돌리면 네이버가 콘솔 대신 첫 화면을 내주는 계정이 있어서다.
 *
 * 계정이 바뀔 때마다 HaiIP 로 그 계정의 검증 IP 로 전환하고, 실제로 그 IP 가
 * 됐는지 curl 로 확인한 뒤에만 진행한다. (PowerShell 의 Invoke-RestMethod 는
 * 연결을 재사용해 옛 IP 를 돌려주는 일이 있어 쓰지 않는다.)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';
import {
  logProxyBanner,
  playwrightProxy,
  resolveProxyConfig,
  shouldSkipHaiIp,
} from './lib/naver-proxy.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const perSiteDelayMs = Number(options.delayMs || 3000);

const proxyConfig = resolveProxyConfig({
  cliFlag: Boolean(options.useProxy || options.useBrightdata),
  projectRoot,
});
logProxyBanner(proxyConfig, 'site registration');
const haiIpSkip = shouldSkipHaiIp(proxyConfig, Boolean(options.noHaiip));
const skipHaiIp = haiIpSkip.skip;
if (skipHaiIp) console.log(`[haiip] IP 전환을 건너뜁니다 (${haiIpSkip.reason}).`);
const limit = options.limit ? Number(options.limit) : null;
const groupKey = options.groupKey || 'cleaning-ravi';
const tmpRoot = resolve(projectRoot, 'tmp/naver-login');
const haiIpScript = resolve(projectRoot, 'scripts/haiip-windows-ui-control.ps1');

const BOARD_URL = 'https://searchadvisor.naver.com/console/board';
const TOKEN_PATTERN = /naver-site-verification[^\s"']*["']?\s*content=["']?([0-9a-f]{20,})/i;

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const accounts = await loadAccounts();
  console.log(JSON.stringify({ phase: 'plan', accounts: accounts.map((a) => a.account_id), dryRun, perSiteDelayMs }));

  const summary = [];
  for (const [index, account] of accounts.entries()) {
    console.log(`\n===== [${index + 1}/${accounts.length}] ${account.account_id} =====`);
    try {
      summary.push(await registerForAccount(account));
    } catch (error) {
      console.error(`  ✗ 계정 실패: ${error.message}`);
      summary.push({
        accountId: account.account_id,
        ok: false,
        error: error.message,
        ...(error.needsRecapture ? { needsRecapture: true } : {}),
      });
    }
  }
  console.log(`\n${JSON.stringify({ phase: 'summary', summary }, null, 2)}`);

  // 재캡처가 필요한 계정을 마지막에 한 줄로 모아준다.
  // 30개 계정 로그를 눈으로 훑어 계정 ID 를 골라내는 건 실수하기 쉽다.
  const needRecapture = summary.filter((s) => s.needsRecapture).map((s) => s.accountId);
  if (needRecapture.length) {
    console.log(`\n===== 세션 재캡처가 필요한 계정 ${needRecapture.length}개 =====`);
    for (const id of needRecapture) {
      console.log(`  node scripts/capture-naver-session.mjs --account ${id} --no-auto-click --force`);
    }
    console.log('\n재캡처 뒤 같은 등록 명령을 다시 돌리면 남은 것만 이어서 합니다.');
  }

  if (summary.some((s) => !s.ok)) process.exitCode = 1;
} finally {
  await client.end();
  // browser.close() 를 해도 Chrome 자식 프로세스가 남아 stdout 파이프를 붙들고 있어,
  // 부모(PowerShell)의 WaitForExit 가 끝나지 않는 일이 있다. 실제로 등록을 다 마치고
  // 요약까지 찍은 뒤 20분 넘게 매달려 있었다. 할 일은 끝났으니 명시적으로 내린다.
  process.exit(process.exitCode || 0);
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
    `select account_id, account_order, status,
            searchadvisor_session_secret_id,
            host(searchadvisor_session_validated_public_ip) as validated_ip
       from public.naver_searchadvisor_accounts ${where.clause} order by account_order`,
    where.params,
  );
  if (!result.rowCount) throw new Error('대상 계정이 없습니다.');
  return result.rows;
}

async function registerForAccount(account) {
  if (account.status !== 'active') throw new Error(`계정 상태가 active 가 아닙니다: ${account.status}`);
  if (!account.searchadvisor_session_secret_id) throw new Error('저장된 세션이 없습니다. 먼저 세션을 캡처하세요.');
  if (!account.validated_ip) throw new Error('검증 IP 가 없습니다.');

  // --- IP 를 그 계정 것으로 맞춘다. 여기서 틀리면 아무것도 하지 않는다. ---
  await ensureAccountIp(account);

  const domains = await client.query(
    `select id, host, site_url, naver_registration_status, naver_verification_token
       from public.naver_project_domains
      where group_key = $1 and naver_account_id = $2
      order by (source_payload->>'globalSiteOrder')::int
      ${limit ? 'limit ' + Number(limit) : ''}`,
    [groupKey, account.account_id],
  );
  // 토큰 유무로 판단하면 안 된다. 네이버는 등록하지 않은 사이트에도 토큰을 내준다.
  // 실제로 목록에 올라갔는지는 등록 상태로만 판단한다.
  const targets = domains.rows.filter((d) => options.force || d.naver_registration_status !== 'registered');
  console.log(`  대상 ${targets.length}건 (전체 ${domains.rowCount}건, 이미 등록 ${domains.rowCount - targets.length}건)`);
  if (!targets.length) return { accountId: account.account_id, ok: true, registered: 0, skipped: domains.rowCount };
  if (dryRun) {
    console.log('  (dry-run: 브라우저를 띄우지 않습니다)');
    return { accountId: account.account_id, ok: true, dryRun: true, wouldRegister: targets.length };
  }

  const statePath = resolve(tmpRoot, `${account.account_id}.storage.json`);
  mkdirSync(tmpRoot, { recursive: true });
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', account.account_id, '--output', statePath,
  ], { stdio: 'pipe' });

  // 진짜 브라우저를 띄우되, 기본은 화면 밖에 둔다.
  //
  // headless 로 돌리면 같은 세션·같은 IP 인데도 콘솔 대신 첫 화면이 뜨는
  // 계정이 있다(VM2, 2026-08-10). 저장된 쿠키는 정상 계정과 완전히 동일했고
  // 창을 띄우니 바로 열렸다. 그래서 headless 로는 되돌리지 않는다.
  //
  // 대신 창 위치를 화면 밖으로 보낸다. 네이버가 보는 건 그대로 일반 브라우저고,
  // 사람 눈에만 안 보인다. 작업 중에 창이 계속 튀어나오면 다른 일을 못 한다.
  //   --show      화면에 띄운다 (문제 생겼을 때 눈으로 보려고)
  //   --headless  진짜 헤드리스. 위 이유로 권하지 않는다.
  const offscreen = !options.show && !options.headless;
  const browser = await chromium.launch({
    headless: Boolean(options.headless),
    channel: 'chrome',
    ...(offscreen ? { args: ['--window-position=-2400,-2400', '--window-size=1280,900'] } : {}),
    ...(playwrightProxy(proxyConfig) ? { proxy: playwrightProxy(proxyConfig) } : {}),
  });
  let registered = 0;
  const failures = [];
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
    const page = await context.newPage();

    // 사이트 등록 화면이 실제로 뜨는지 먼저 본다.
    //
    // 예전에는 이 확인 없이 바로 100건을 돌렸다. 세션이 죽었거나 계정이 100개
    // 상한에 걸리면 URL 입력창이 없어서 도메인마다 15초씩 타임아웃이 나고,
    // "locator.click: Timeout 15000ms exceeded" 만 100줄 찍힌 뒤 25분이 날아갔다.
    // 원인도 화면을 안 남겨서 알 수 없었다. 한 번만 보고 판단한다.
    const board = await inspectBoard(page);
    if (!board.ok) {
      const error = new Error(`사이트 등록 화면을 열 수 없습니다 — ${board.reason}\n    화면: ${board.snippet}`);
      // 마지막 요약에서 재캡처 명령을 뽑아주기 위해 플래그를 실어 보낸다.
      error.needsRecapture = Boolean(board.needsRecapture);
      throw error;
    }
    console.log(`  등록 화면 확인 ✅ (등록된 사이트 ${board.siteCount ?? '?'}개)`);

    for (const [index, domain] of targets.entries()) {
      try {
        const token = await registerOne(page, domain.site_url);
        await client.query(
          `update public.naver_project_domains
              set naver_registration_status = 'registered',
                  naver_registered_at = now(),
                  naver_verification_token = $2,
                  naver_meta_tag = $3,
                  naver_console_url = $4,
                  updated_at = now()
            where id = $1`,
          [
            domain.id,
            token,
            `<meta name="naver-site-verification" content="${token}" />`,
            `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(domain.site_url)}`,
          ],
        );
        registered += 1;
      } catch (error) {
        failures.push({ host: domain.host, error: error.message.split('\n')[0] });
        console.log(`  ✗ ${domain.host}: ${error.message.split('\n')[0]}`);
      }
      if ((index + 1) % 10 === 0 || index + 1 === targets.length) {
        console.log(`  진행 ${index + 1}/${targets.length}  성공 ${registered}  실패 ${failures.length}`);
      }
      await sleep(perSiteDelayMs);
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(statePath, { force: true });
  }

  return { accountId: account.account_id, ok: failures.length === 0, registered, failed: failures.length, failures: failures.slice(0, 5) };
}

/**
 * 사이트 등록 화면 상태를 한 번에 판정한다.
 *
 * 클릭이 타임아웃 났을 때 "왜" 를 남기기 위한 것이다. URL 입력창이 없는
 * 이유는 여러 가지인데, 화면 글자를 보면 대부분 구분된다.
 *
 *   - 저장된 세션이 죽음      -> 로그인 화면이나 "로그인에 문제가 발생"
 *   - 계정이 100개 상한       -> "등록 가능한 사이트 수" 안내
 *   - 네이버 일시 오류        -> "문제가 발생"
 *
 * 어디에도 안 걸리면 화면 앞부분을 그대로 돌려준다. 추측해서 틀린 원인을
 * 적어두면 다음 사람이 엉뚱한 데를 판다.
 */
async function inspectBoard(page) {
  // 콘솔은 Vue SPA 라 첫 렌더가 늦을 때가 있다. 한 번 더 열어보고 판단한다.
  let state = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      if (attempt === 2) {
        return { ok: false, reason: `콘솔 페이지 로딩 실패: ${error.message.split('\n')[0]}`, snippet: '' };
      }
      continue;
    }
    // 입력창이 뜨면 바로 통과. 안 뜨면 최대 12초까지 기다렸다가 상태를 읽는다.
    try {
      await page.locator('input[type=text]').first().waitFor({ state: 'visible', timeout: 12_000 });
    } catch { /* 아래에서 화면 상태로 원인을 가린다 */ }

    state = await page.evaluate(() => ({
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').trim(),
      url: location.href,
      textInputs: document.querySelectorAll('input[type=text]').length,
      // 등록된 사이트 목록은 표로 그려진다. 개수만 세어 상한 판단에 쓴다.
      rows: document.querySelectorAll('tbody tr').length,
    }));
    if (state.textInputs > 0) break;
    if (attempt === 1) await page.waitForTimeout(2000);
  }

  const snippet = state.body.slice(0, 160);

  // ⚠ 로그인 화면 판정이 입력창 판정보다 **먼저**다.
  // 네이버 로그인 화면에도 아이디·비밀번호 input[type=text] 가 있어서,
  // 입력창 개수만 보면 로그인 화면을 "콘솔 열림" 으로 통과시킨다.
  // 실제로 계정 #6, #17 이 로그인 화면인데 정상으로 나왔다(2026-08-10).
  if (/로그인에 문제가 발생|아이디 또는 전화번호|NAVER 로그인|QR 코드 로그인|로그인 상태 유지/.test(state.body)
      || /nid\.naver\.com/.test(state.url)) {
    return { ok: false, reason: '저장된 세션이 만료됐습니다 — 로그인 화면으로 튕김 (재캡처 필요)', snippet, needsRecapture: true };
  }

  // 콘솔 안에서만 보이는 글자 + 입력창이 함께 있어야 진짜 등록 화면이다.
  //
  // 사이트 100개 상한은 여기서 판단하지 않는다. 전에 시도했다가
  // "사이트 등록 error 최대 100개 사이트를 등록할 수 있습니다" 를 상한으로
  // 오판했는데, 그건 입력창 아래 고정 안내문이었고 error 는 Material 아이콘
  // 이름이 innerText 로 읽힌 것이었다. 상한은 실제로 등록해봐야 안다.
  if (state.textInputs > 0 && /사이트 관리|사이트 등록|간단체크/.test(state.body)) {
    return { ok: true, siteCount: state.rows, snippet };
  }

  const loggedIn = /power_settings_new/.test(state.body);
  if (/문제가 발생|접근권한이 없습니다/.test(state.body)) {
    return { ok: false, reason: '네이버가 오류 화면을 돌려줬습니다 (잠시 후 재시도)', snippet };
  }
  if (/웹마스터 가이드/.test(state.body)) {
    return loggedIn
      ? { ok: false, reason: '로그인은 됐는데 콘솔 대신 첫 화면이 떴습니다 — --headed 로 다시 시도해 보세요', snippet }
      : { ok: false, reason: '로그아웃 상태입니다 — 콘솔 대신 첫 화면이 떴습니다 (재캡처 필요)', snippet, needsRecapture: true };
  }
  return { ok: false, reason: 'URL 입력창이 화면에 없습니다 (원인 불명)', snippet };
}

/**
 * 반드시 사이트 관리 폼으로 제출해야 목록에 올라간다.
 *
 * /console/verify?site=... 를 그냥 열면 등록하지 않은 사이트에도 인증키를
 * 내주지만 목록에는 추가되지 않는다. 실제로 그 지름길 때문에 토큰만 96개
 * 모으고 사이트는 하나도 등록되지 않은 적이 있다. 지름길을 쓰지 않는다.
 */
async function registerOne(page, siteUrl) {
  // ⚠️ 아래 지름길은 기본적으로 꺼져 있다. 반드시 이유를 알고 켤 것.
  //
  // /console/verify?site=... 는 "등록되지 않은" 사이트에도 인증키를 내준다.
  // 그래서 이 경로로만 돌면 토큰만 쌓이고 사이트 목록에는 아무것도 안 올라간다.
  // (실제로 토큰 96개를 모으고 등록은 0건이었던 사고가 있었다.)
  //
  // 다만 "이미 등록은 끝났는데 DB 의 토큰만 잃어버린" 복구 상황에서는 이게 유일한
  // 회수 수단이다. 계정이 100개 상한에 차 있으면 등록 버튼이 아예 안 눌리기 때문이다.
  // (2026-08-06: DB 도메인 행이 사라져 토큰 1,000개를 다시 받아야 했다.)
  //
  // 그런 복구 작업일 때만 NAVER_REGISTER_TOKEN_RECOVERY=1 로 켠다.
  if (process.env.NAVER_REGISTER_TOKEN_RECOVERY === '1') {
    const existing = await tokenFromVerifyPage(
      page,
      `https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`,
    );
    if (existing) return existing;
  }

  await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1200);

  // URL 입력창은 렌더링마다 id 가 바뀌므로(#input-141 등) 위치로 잡는다.
  const input = page.locator('input[type=text]').first();
  await input.click({ timeout: 15_000 });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  for (const char of siteUrl) {
    await page.keyboard.type(char, { delay: 0 });
    await page.waitForTimeout(8 + Math.floor(Math.random() * 20));
  }
  if ((await input.inputValue()) !== siteUrl) throw new Error('URL 입력이 잘렸습니다.');

  await page.locator('i:has-text("exit_to_app")').first().click({ timeout: 15_000 });

  // 제출이 받아들여지면 소유확인 화면으로 넘어간다. 이미 등록된 사이트는
  // 화면이 안 바뀌고 안내 문구만 뜨는데, 그것도 성공으로 본다.
  try {
    await page.waitForURL(/\/console\/verify\?site=/, { timeout: 25_000 });
  } catch {
    const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
    if (!/이미 등록|등록된 사이트/.test(body)) {
      throw new Error(`제출 후 소유확인 화면으로 넘어가지 않았습니다: ${body.slice(0, 120)}`);
    }
    await page.goto(`https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(700);
    const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
    const match = body.match(TOKEN_PATTERN);
    if (match) return match[1];
  }
  throw new Error('소유확인 화면에서 인증키를 못 찾았습니다.');
}

async function ensureAccountIp(account) {
  // 프록시 모드에서는 나가는 IP 를 프록시가 정한다. 로컬 공인 IP 는 의미가 없다.
  if (proxyConfig.enabled) {
    console.log('  IP 확인: 프록시 모드 — 로컬 IP 검사를 건너뜁니다.');
    return;
  }

  const target = account.validated_ip;
  let current = publicIp();
  if (current === target) {
    console.log(`  IP 확인: ${current} (이미 일치)`);
    return;
  }
  if (skipHaiIp) throw new Error(`IP 불일치: 현재 ${current}, 필요 ${target} (--no-haiip 라 전환하지 않음)`);

  console.log(`  IP 전환: ${current} -> ${target}`);
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', haiIpScript,
    '-Command', 'change', '-PreferredIp', target, '-CheckPreferredResult',
    '-PreferredWaitSeconds', '30', '-PreferredActivationRetries', '3',
  ], { stdio: 'pipe', timeout: 240_000 });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(2500);
    current = publicIp();
    if (current === target) {
      console.log(`  IP 확인: ${current} ✅`);
      return;
    }
  }
  throw new Error(`IP 전환 실패: 목표 ${target}, 현재 ${current}`);
}

/** curl 로 확인한다. 새 연결을 열기 때문에 전환 직후에도 옛 IP 를 안 준다. */
function publicIp() {
  const out = execFileSync('curl', ['-s', '--max-time', '15', `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) throw new Error(`공인 IP 를 못 읽었습니다: ${out}`);
  return out;
}

// 함수 선언으로 둔다. const 화살표로 두면 위쪽 async 함수에서 먼저 불릴 때
// "Cannot access 'sleep' before initialization" 이 난다.
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 이미 등록된 사이트인지 소유확인 화면을 열어 확인한다. 없으면 null. */
async function tokenFromVerifyPage(page, verifyUrl) {
  try {
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Vue 로 그려지는 화면이라 domcontentloaded 직후에는 아직 비어 있다.
    // 인증키가 나타날 때까지 몇 번 더 본다.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.waitForTimeout(700);
      const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
      const match = body.match(TOKEN_PATTERN);
      if (match) return match[1];
      // 등록 안 된 사이트면 소유확인 화면 자체가 안 뜬다. 더 기다릴 필요 없다.
      if (attempt >= 2 && !/사이트 소유확인/.test(body)) return null;
    }
    return null;
  } catch {
    return null;
  }
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
