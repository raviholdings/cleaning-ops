#!/usr/bin/env node
/**
 * 네이버 계정 세션(Playwright storage-state)을 잡아 Vault + DB 에 저장한다.
 * 계정당 한 번만 하면 되고, 그 뒤로는 수집요청·소유확인이 이 세션을 쓴다.
 *
 *   node scripts/capture-naver-session.mjs --account lguxp4nlw
 *   node scripts/capture-naver-session.mjs --accounts 1-10
 *   node scripts/capture-naver-session.mjs --account lguxp4nlw --dry-run
 *
 * 흐름 (사람이 하는 건 5번뿐)
 *   1. DB 에서 계정·비밀번호·배정 IP 조회
 *   2. HaiIP 로 그 계정의 IP 로 전환 (배정 IP 가 없으면 무작위 변경 후 기록)
 *   3. 공인 IP 가 다른 계정에 쓰이고 있지 않은지 확인
 *   4. 전용 임시 프로필로 Chrome 을 띄우고 아이디/비밀번호를 채워 넣는다
 *   5. ← 캡차·2단계 인증이 뜨면 사람이 처리한다
 *   6. 로그인 완료를 감지하면 storage-state 를 뽑는다
 *   7. NID_AUT/NID_SES 확인 + 서치어드바이저 진입 검증
 *   8. Vault + DB 저장, 임시 파일 삭제
 *
 * 반드시 지켜야 하는 두 가지 (레거시에서 실제로 겪은 함정)
 *   - 캡처는 --user-data-dir, 사용은 --load-storage. 둘을 같이 쓰면 인증 쿠키가
 *     프로필에 반영되지 않아 "세션이 잘못 저장된 것처럼" 보인다.
 *   - 브라우저를 강제 종료하면 storage-state 가 안 써진다. 그래서 여기서는
 *     Playwright 컨텍스트에서 직접 뽑아 그 문제를 아예 없앤다.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const skipHaiIp = Boolean(options.noHaiip);
const tmpRoot = resolve(projectRoot, 'tmp/naver-login');
const haiIpScript = resolve(projectRoot, 'scripts/haiip-windows-ui-control.ps1');

const SEARCH_ADVISOR_URL = 'https://searchadvisor.naver.com/console/board';
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fsearchadvisor.naver.com%2Fconsole%2Fboard';
const LOGIN_TIMEOUT_MS = Number(options.loginTimeoutMs || 300_000);
// 값만 채우고 로그인 버튼은 사람이 누른다. IP보안·로그인유지를 직접 고를 수 있고,
// 반복 자동 로그인으로 추가 인증이 걸리는 것도 줄어든다.
const noAutoClick = Boolean(options.noAutoClick);

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const accounts = await loadAccounts();
  console.log(JSON.stringify({ phase: 'plan', accounts: accounts.map((a) => a.account_id), dryRun }));

  const results = [];
  for (const [index, account] of accounts.entries()) {
    console.log(`\n===== [${index + 1}/${accounts.length}] ${account.account_id} =====`);
    try {
      results.push(await captureOne(account));
    } catch (error) {
      console.error(`  ✗ 실패: ${error.message}`);
      results.push({ accountId: account.account_id, ok: false, error: error.message });
    }
  }

  console.log(`\n${JSON.stringify({ phase: 'summary', results }, null, 2)}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exitCode = 1;
} finally {
  await client.end();
}

async function loadAccounts() {
  if (options.account) {
    // 쉼표로 여러 개를 받는다. 세션이 죽은 계정만 골라 다시 잡는 일이 잦은데,
    // 순번 범위(--accounts)로 주면 멀쩡한 계정까지 --force 로 덮어쓰게 된다.
    // 살아 있는 세션을 굳이 다시 잡으면 네이버가 추가 인증을 걸 위험만 는다.
    const ids = String(options.account).split(',').map((s) => s.trim()).filter(Boolean);
    const result = await client.query(
      accountQuery('where account_id = any($1::text[]) order by account_order'),
      [ids],
    );
    const found = new Set(result.rows.map((r) => r.account_id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`계정을 찾을 수 없습니다: ${missing.join(', ')}`);
    return result.rows;
  }
  const range = String(options.accounts || '').match(/^(\d+)-(\d+)$/);
  if (!range) throw new Error('--account <id> 또는 --accounts <시작>-<끝> 이 필요합니다.');
  const result = await client.query(
    accountQuery('where account_order between $1 and $2 order by account_order'),
    [Number(range[1]), Number(range[2])],
  );
  if (!result.rowCount) throw new Error(`account_order ${range[1]}~${range[2]} 범위에 계정이 없습니다.`);
  return result.rows;
}

function accountQuery(whereClause) {
  return `
    select account_id, account_order, password_plain, status,
           searchadvisor_session_secret_id,
           host(searchadvisor_session_validated_public_ip) as validated_ip
      from public.naver_searchadvisor_accounts
    ${whereClause}
  `;
}

async function captureOne(account) {
  if (account.status !== 'active') throw new Error(`계정 상태가 active 가 아닙니다: ${account.status}`);
  if (!account.password_plain) throw new Error('DB 에 비밀번호가 없습니다.');
  if (account.searchadvisor_session_secret_id && !options.force) {
    console.log('  이미 세션이 있습니다. 다시 잡으려면 --force 를 붙이세요. 건너뜁니다.');
    return { accountId: account.account_id, ok: true, skipped: 'already-has-session' };
  }

  // --- 1~2. IP 확보 ---
  let publicIp = await currentPublicIp();
  if (!skipHaiIp) {
    publicIp = await ensureIpForAccount(account, publicIp);
  }
  console.log(`  공인 IP: ${publicIp}`);

  // --- 3. 다른 계정이 쓰는 IP 인지 ---
  const conflict = await client.query(
    `select account_id from public.naver_searchadvisor_accounts
      where account_id <> $1
        and (host(searchadvisor_session_validated_public_ip) = $2
             or host(searchadvisor_session_saved_public_ip) = $2)`,
    [account.account_id, publicIp],
  );
  if (conflict.rowCount) {
    throw new Error(`IP ${publicIp} 는 이미 ${conflict.rows.map((r) => r.account_id).join(', ')} 가 씁니다.`);
  }

  if (dryRun) {
    console.log('  (dry-run: 브라우저를 띄우지 않고 여기서 멈춥니다)');
    return { accountId: account.account_id, ok: true, publicIp, dryRun: true };
  }

  // --- 4~6. 로그인 ---
  const profileDir = resolve(tmpRoot, `${account.account_id}-profile`);
  const statePath = resolve(tmpRoot, `${account.account_id}.storage.json`);
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  let storageState;
  // 네이버 로그인은 자동화 브라우저를 감지하면 오류 없이 폼만 초기화하고 아무 일도
  // 일어나지 않는다. Playwright 가 기본으로 붙이는 표식을 최대한 지운다.
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--lang=ko-KR',
    ],
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 자동 입력. 한 글자씩 치면 네이버 쪽 스크립트가 중간에 끊어 값이 잘린다
    // (실제로 lguxp4nlw 가 lgux 로 잘렸다). 값을 직접 넣고 확인될 때까지 다시 시도한다.
    const filled = { id: false, pw: false, clicked: false };
    try {
      await page.waitForSelector('#id', { timeout: 15_000 });
      filled.id = await fillAndVerify(page, '#id', account.account_id);
      filled.pw = await fillAndVerify(page, '#pw', account.password_plain);
      // 네이버가 반복 로그인을 감지하면 영수증 금액 계산 같은 추가 인증을 띄운다.
      // 사람이 IP보안·로그인유지를 먼저 고르고 직접 누르는 편이 덜 걸린다.
      // --no-auto-click 이면 값만 채워두고 클릭은 사람에게 맡긴다.
      if (noAutoClick) {
        console.log('  아이디·비밀번호만 채웠습니다. 브라우저에서 직접 로그인해 주세요.');
      } else if (filled.id && filled.pw) {
        // 버튼 셀렉터가 안 잡히는 경우가 있어 엔터로 물러선다.
        try {
          await page.click('#log\\.login, .btn_login, button[type=submit]', { timeout: 8000 });
        } catch {
          await page.keyboard.press('Enter').catch(() => {});
        }
        filled.clicked = true;
      } else {
        console.log('  자동 입력이 확인되지 않아 로그인 버튼을 누르지 않았습니다. 직접 입력해 주세요.');
      }
    } catch (error) {
      console.log(`  자동 입력 중 문제: ${error.message.split('\n')[0]}`);
    }
    console.log(`  자동 입력: 아이디=${filled.id ? 'OK' : '실패'} 비밀번호=${filled.pw ? 'OK' : '실패'} 로그인클릭=${filled.clicked ? 'OK' : '안함'}`);

    console.log('  ▶ 브라우저에서 로그인을 완료해 주세요 (캡차·추가 인증이 뜨면 처리).');
    console.log(`    최대 ${Math.round(LOGIN_TIMEOUT_MS / 1000)}초 기다립니다.`);

    // 두 번째 인자는 페이지 함수에 넘길 값이고, 옵션은 세 번째다. 자리를 바꾸면
    // timeout 이 무시되고 기본 30초가 적용된다.
    try {
      await page.waitForFunction(
        () => !location.hostname.includes('nid.naver.com'),
        null,
        { timeout: LOGIN_TIMEOUT_MS, polling: 2000 },
      );
    } catch (error) {
      // 왜 못 넘어갔는지 알아야 다음 계정을 시도할 수 있다. 화면과 문구를 남긴다.
      const diagDir = resolve(projectRoot, 'reports/naver-login');
      mkdirSync(diagDir, { recursive: true });
      const shot = resolve(diagDir, `${account.account_id}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
      })).catch(() => ({}));
      console.log(`  진단 URL   : ${info.url || '?'}`);
      console.log(`  진단 제목  : ${info.title || '?'}`);
      console.log(`  화면 문구  : ${info.text || '?'}`);
      console.log(`  스크린샷   : ${shot}`);
      throw new Error(`로그인이 끝나지 않았습니다 (${info.title || 'unknown'})`);
    }

    await page.goto(SEARCH_ADVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    await acceptSearchAdvisorTerms(page);

    storageState = await context.storageState();
  } finally {
    await context.close().catch(() => {});
  }

  // --- 7. 검증 ---
  const names = new Set((storageState.cookies || []).map((c) => c.name));
  if (!names.has('NID_AUT') || !names.has('NID_SES')) {
    throw new Error(`네이버 인증 쿠키가 없습니다 (쿠키 ${storageState.cookies?.length ?? 0}개). 로그인이 끝나지 않았습니다.`);
  }
  writeFileSync(statePath, JSON.stringify(storageState));
  chmodSync(statePath, 0o600);

  const verified = await verifySearchAdvisor(statePath);
  if (!verified.ok) {
    rmSync(statePath, { force: true });
    rmSync(profileDir, { recursive: true, force: true });
    throw new Error(`서치어드바이저 접근 검증 실패: ${verified.reason}`);
  }
  console.log(`  ✓ 검증 통과 (쿠키 ${storageState.cookies.length}개, ${verified.title})`);

  // --- 8. 저장 ---
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/upsert-naver-searchadvisor-session.mjs'),
    '--account', account.account_id,
    '--storage-state', statePath,
    '--saved-ip', publicIp,
    '--validated-ip', publicIp,
    '--status', 'valid',
  ], { stdio: 'inherit' });

  rmSync(statePath, { force: true });
  rmSync(profileDir, { recursive: true, force: true });
  console.log('  ✓ Vault/DB 저장 완료, 임시 파일 삭제');

  return {
    accountId: account.account_id,
    ok: true,
    publicIp,
    cookieCount: storageState.cookies.length,
  };
}

/**
 * 서치어드바이저를 처음 쓰는 계정은 "이용 동의" 모달을 먼저 통과해야
 * 사이트 관리 화면으로 들어갈 수 있다. 계정당 1회만 뜬다.
 * 운영자 지시로 자동 동의한다.
 */
async function acceptSearchAdvisorTerms(page) {
  const checkbox = page.locator('input[type=checkbox]').first();
  const confirm = page.locator('button:has-text("확인")').first();
  if (!(await checkbox.count()) || !(await confirm.count())) return false;

  await checkbox.check({ force: true }).catch(() => {});
  if (!(await checkbox.isChecked().catch(() => false))) return false;
  await confirm.click().catch(() => {});
  await page.waitForTimeout(4000);
  console.log(`  이용약관 자동 동의 완료 (${await page.title()})`);
  return true;
}

/**
 * 값이 실제로 들어갈 때까지 다시 시도한다.
 * 네이버 로그인 폼은 한 글자씩 타이핑하면 중간에 잘리는 경우가 있어
 * fill 로 먼저 넣고, 안 되면 타이핑으로 물러선다.
 */
async function fillAndVerify(page, selector, value, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.click(selector).catch(() => {});
    // 기존 값은 fill 이 아니라 전체선택+삭제로 지운다. fill 은 값을 통째로 꽂아서
    // 사람 입력처럼 보이지 않는다.
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});

    // 한 글자씩, 간격을 매번 다르게 준다. 일정한 간격도 봇 신호가 된다.
    for (const char of value) {
      await page.keyboard.type(char, { delay: 0 }).catch(() => {});
      await page.waitForTimeout(60 + Math.floor(Math.random() * 110));
    }
    await page.waitForTimeout(250 + Math.floor(Math.random() * 250));

    if ((await page.inputValue(selector).catch(() => '')) === value) return true;
    console.log(`  ${selector} 입력이 잘렸습니다. 다시 시도 (${attempt}/${attempts})`);
  }
  return false;
}

/**
 * 세션을 실제로 쓰는 방식과 똑같이 검증한다.
 * 반드시 storageState 만 주입하고 프로필 디렉터리는 쓰지 않는다.
 */
async function verifySearchAdvisor(statePath) {
  // 설치된 크롬을 쓴다. Playwright 번들 브라우저는 따로 내려받아야 해서 없을 수 있다.
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
    const page = await context.newPage();
    const response = await page.goto(SEARCH_ADVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const url = page.url();
    if (url.includes('nid.naver.com')) return { ok: false, reason: '로그인 페이지로 튕겼습니다.' };
    if (response && response.status() >= 400) return { ok: false, reason: `HTTP ${response.status()}` };

    // URL 만 보면 안 된다. searchadvisor 도메인 그대로 로그인 화면을 그리는 경우가 있어,
    // 실제로 "로그인 - 네이버 서치어드바이저" 화면을 통과시켜 깨진 세션을 저장했다.
    // 그 세션이 멀쩡하던 것을 덮어써서 소유확인 1,000건이 통째로 실패했다(2026-08-06).
    // 화면 내용으로 로그인 여부를 확정한다.
    await page.waitForTimeout(1500);
    const title = (await page.title()) || '';
    const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
    if (/아이디 또는 전화번호|로그인 상태 유지|QR 코드 로그인|추가 확인을 해주세요/.test(body)) {
      return { ok: false, reason: '로그인 화면이 그려져 있습니다(추가 인증이 필요할 수 있습니다).' };
    }
    if (/^NAVER 로그인|로그인 - /.test(title)) {
      return { ok: false, reason: `로그인 화면 제목입니다: ${title.slice(0, 40)}` };
    }
    // ⚠ "웹마스터 도구" 를 통과 조건에 넣으면 안 된다.
    // 그 글자는 서치어드바이저 **첫 화면 메뉴**에도 있어서, 콘솔에 못 들어간
    // 계정도 통과해버린다. 실제로 VM2 계정 여러 개가 이것 때문에 "세션 저장
    // 완료"로 찍히고, 나중에 사이트 등록에서 전부 실패했다(2026-08-10).
    //
    // 콘솔 안에서만 보이는 글자로만 판정한다.
    if (!/사이트 관리|사이트 등록|간단체크/.test(body)) {
      // 첫 화면에 걸린 경우를 따로 알려준다. 원인이 세션이 아니라 계정이다.
      const loggedIn = /power_settings_new/.test(body);
      if (/웹마스터 가이드/.test(body)) {
        return {
          ok: false,
          reason: loggedIn
            ? '로그인은 됐지만 콘솔에 못 들어갑니다 — 이 계정으로 서치어드바이저를 한 번도 쓴 적이 없어 최초 이용 동의가 필요할 수 있습니다. 브라우저로 직접 들어가 확인하세요.'
            : `첫 화면(로그아웃 상태)입니다: ${body.slice(0, 60)}`,
        };
      }
      return { ok: false, reason: `서치어드바이저 콘솔 화면이 아닙니다: ${body.slice(0, 60)}` };
    }
    return { ok: true, title: title.slice(0, 40) };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function ensureIpForAccount(account, currentIp) {
  const preferred = account.validated_ip;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', haiIpScript, '-Command', 'change', '-RequireChanged'];
  if (preferred) {
    if (preferred === currentIp) {
      console.log(`  배정 IP ${preferred} 에 이미 있습니다.`);
      return currentIp;
    }
    console.log(`  배정 IP ${preferred} 로 전환합니다.`);
    args.push('-PreferredIp', preferred, '-CheckPreferredResult');
  } else {
    console.log('  배정 IP 가 없어 무작위로 바꾸고 그 IP 를 배정합니다.');
  }
  execFileSync('powershell.exe', args, { stdio: 'pipe', timeout: 180_000 });
  const next = await currentPublicIp();
  if (preferred && next !== preferred) throw new Error(`배정 IP ${preferred} 로 못 갔습니다 (현재 ${next}).`);
  return next;
}

/**
 * IP 변경 직후에 부르면 캐시된 옛 주소가 돌아온다. 타임스탬프를 붙여 캐시를 피한다.
 * (레거시 haiip-windows-ui-control.ps1 의 Get-PublicIp 도 같은 이유로 _ts 를 붙인다.)
 */
async function currentPublicIp() {
  const url = `https://api.ipify.org?format=json&_ts=${Date.now()}`;
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(body.ip || '')) throw new Error(`공인 IP 를 못 읽었습니다: ${JSON.stringify(body)}`);
  return body.ip;
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
