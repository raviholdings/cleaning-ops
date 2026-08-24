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
 *   5. ← 캡차·2단계 인증·보호조치가 뜨면 사람이 처리한다
 *        보호조치 화면이 보이면 기다리는 시간을 20분으로 늘리고, 그래도
 *        못 끝내면 창을 열어둔 채 Enter 를 기다린다. 창이 닫혀버리면
 *        처음부터 다시 해야 해서 그게 제일 아깝다.
 *        --protection-timeout-ms 로 조절, --no-pause 로 끌 수 있다.
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
import { createInterface } from 'node:readline/promises';
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

/*
 * 아래 상수들은 반드시 최상위 실행 블록(try { ... captureOne ... })보다 위에 있어야 한다.
 *
 * 이 파일은 함수 정의 사이에 최상위 실행이 끼어 있는 구조라, 실행 지점보다 아래에
 * 선언한 const 는 실행 시점에 아직 초기화되지 않는다(TDZ). 그런데 대부분 async 함수
 * 안에서 쓰여서 예외가 조용한 거절로 바뀌는 바람에, 기능이 안 도는 걸 모르고 지나갔다:
 *   · CHALLENGE_PATTERN  -> waitForLogin 이 즉시 실패 = 보호조치 대기가 아예 안 걸리고
 *                           매번 진단 + Enter 대기로 빠졌다 ("지혼자 넘어간다"의 정체)
 *   · TERMS_BUTTON_TEXTS -> 약관 자동 동의가 항상 실패해서 사람이 직접 눌러야 했다
 *   · isSearchAdvisorConsole -> 동기 호출이라 그대로 터졌다
 *     ("Cannot access 'isSearchAdvisorConsole' before initialization", 2026-08-24)
 * 함수 선언(function …)은 호이스팅되니 상관없지만, const 는 여기에 둔다.
 */

/** 보호조치·본인확인 화면인지 본다. 이게 뜨면 사람이 오래 붙어야 한다. */
const CHALLENGE_PATTERN = /보호조치|이용 제한|본인 확인|본인확인|인증번호|새로운 기기|자동입력 방지|일시적으로 제한|비정상적인 접근|2단계 인증/;

/*
 * 콘솔이든 최초 이용 동의 화면이든, 로그인이 끝난 뒤의 화면이면 참.
 *
 * 예전에는 여기에 `웹마스터 가이드|약관|동의` 가 들어 있었다. 그런데 그 글자들은
 * **로그아웃 상태의 서치어드바이저 첫 화면**에도 있다 (메뉴의 '웹마스터 가이드',
 * 푸터의 '이용약관'). 그래서 로그인도 안 됐는데 다음 단계로 넘어갔다.
 * 로그인 뒤에만 보이는 글자로만 판정한다.
 */
const CONSOLE_OR_TERMS = /사이트 관리|사이트 등록|간단체크|이용약관에 동의|약관에 동의|동의합니다/;

/** 로그아웃 상태의 서치어드바이저 첫 화면. 이게 보이면 아직 로그인 전이다. */
const LOGGED_OUT_SEARCH_ADVISOR = /웹마스터 가이드|웹마스터 도구/;

/** 콘솔 안에서만 보이는 글자로 판정한다 ('웹마스터 도구'는 첫 화면에도 있어서 쓰면 안 된다). */
const CONSOLE_ONLY = /사이트 관리|사이트 등록|간단체크/;

const TERMS_BUTTON_TEXTS = ['확인', '전체 동의', '동의하기', '동의', '시작하기', '다음'];
const CONSENT_LABEL = /이용약관에 동의|약관에 동의|동의합니다/;

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

    // 보호조치·본인확인이 걸리면 5분 안에 못 끝낸다. 문자 받고 번호 넣고
    // 하다 보면 10분도 넘어가는데, 그때 창이 닫혀버리면 처음부터 다시 해야
    // 한다. 그래서 그런 화면이 보이면 기다리는 시간을 늘린다.
    try {
      await waitForLogin(page, account.account_id);
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

      // 창을 바로 닫지 않는다. 보호조치를 푸는 중이었다면 여기서 닫히는 게
      // 제일 아깝다. Enter 를 받을 때까지 열어두고, 그 사이에 로그인이
      // 끝나면 그대로 진행한다. --no-pause 면 예전처럼 바로 접는다.
      if (!options.noPause) {
        console.log('\n  ⏸ 창을 열어둡니다. 보호조치·본인확인을 처리하신 뒤');
        console.log('     로그인까지 끝내고 이 창에서 Enter 를 눌러주세요. (건너뛰려면 그냥 Enter)');
        await waitForEnter();
        if (await isLoggedIn(page)) {
          console.log('  ✅ 로그인이 확인됐습니다. 계속 진행합니다.');
        } else {
          throw new Error(`로그인이 끝나지 않았습니다 (${info.title || 'unknown'})`);
        }
      } else {
        throw new Error(`로그인이 끝나지 않았습니다 (${info.title || 'unknown'})`);
      }
    }

    await page.goto(SEARCH_ADVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // 화면이 그려지는 즉시 진행한다 (약관 체크박스든 콘솔이든).
    await settle(page, async () => (await page.locator('input[type=checkbox]').count()) > 0
      || CONSOLE_OR_TERMS.test(await page.evaluate(() => document.body?.innerText || '')), 8000);
    await acceptSearchAdvisorTerms(page);

    // 콘솔까지 들어갔는지 본다. 아직 약관 화면이면 여기서 사람에게 넘긴다 —
    // 그냥 지나가면 검증 단계에서 "콘솔에 못 들어갑니다"로 실패하고 세션이 버려진다.
    /*
     * 콘솔이 실제로 그려질 때까지 기다린다.
     *
     * 3초만 주니 로그인 직후 콘솔이 뜨기도 전에 세션을 뽑고 창을 닫았다. 그 세션은
     * 아직 서치어드바이저 인증이 안 끝난 상태라, 검증에서 "로그인 화면"으로 나온다
     * (2026-08-24 운영자: "콘솔창 로딩 되기도 전에 닫히고 저렇게 떠").
     */
    let inConsole = await settle(page, () => isSearchAdvisorConsole(page), 25_000);
    if (!inConsole && !options.noPause) {
      console.log('\n  ⏸ 서치어드바이저 콘솔까지 못 들어갔습니다 (동의가 남았을 수 있습니다).');
      console.log('     브라우저에서 동의를 눌러 콘솔 화면까지 띄워주세요.');
      console.log('     **창은 닫지 마세요** (닫으면 세션을 못 뽑습니다). 끝나면 이 콘솔에서 Enter.');
      await waitForEnter();
      inConsole = await settle(page, () => isSearchAdvisorConsole(page), 15_000);
    }
    if (!inConsole) {
      throw new Error('서치어드바이저 콘솔까지 들어가지 못해 세션을 저장하지 않습니다.');
    }

    // 콘솔이 떴어도 인증 쿠키가 다 내려오기 전일 수 있다. 통신이 잦아들 때까지 둔다.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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

  // 사람이 몇 분씩 붙어서 만든 세션이다. 간격을 두고 두 번 더 보고 버린다.
  let verified = await verifySearchAdvisor(statePath);
  for (let attempt = 2; !verified.ok && attempt <= 3; attempt += 1) {
    console.log(`  검증 실패(${verified.reason}) — ${attempt}번째 확인합니다.`);
    await new Promise((r) => setTimeout(r, 3000));
    verified = await verifySearchAdvisor(statePath);
  }
  if (!verified.ok) {
    // 왜 안 되는지 좁히려면 저장된 쿠키가 어떤 모양인지 봐야 한다.
    const cookies = storageState.cookies || [];
    const naver = cookies.filter((c) => String(c.domain).includes('naver'));
    console.log(`  저장된 쿠키 ${cookies.length}개 (naver ${naver.length}개): `
      + naver.map((c) => `${c.name}@${c.domain}`).slice(0, 12).join(', '));
  }
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
 * 로그인이 끝날 때까지 기다린다.
 *
 * 기본은 LOGIN_TIMEOUT_MS(5분)이지만, 보호조치나 본인확인 화면이 보이면
 * 기한을 늘린다. 문자 받고 번호 넣고 하다 보면 5분은 금방 넘어가는데,
 * 그때 창이 닫히면 처음부터 다시 해야 한다.
 *
 * --protection-timeout-ms 로 조절한다. 기본 20분.
 */
async function waitForLogin(page, accountId) {
  const protectionTimeoutMs = Number(options.protectionTimeoutMs || 1_200_000);
  let deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let extended = false;
  let lastNotice = 0;

  for (;;) {
    if (await isLoggedIn(page)) return;

    const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');

    if (!extended && CHALLENGE_PATTERN.test(body)) {
      extended = true;
      deadline = Date.now() + protectionTimeoutMs;
      console.log(`\n  🔐 추가 인증 화면이 보입니다 (${accountId}).`);
      console.log(`     ${body.slice(0, 100)}`);
      console.log(`     기다리는 시간을 ${Math.round(protectionTimeoutMs / 60000)}분으로 늘립니다. 천천히 처리하세요.\n`);
    }

    if (Date.now() > deadline) throw new Error('timeout');

    // 30초마다 남은 시간을 알려준다. 아무 표시도 없으면 멈춘 줄 안다.
    if (Date.now() - lastNotice > 30_000) {
      lastNotice = Date.now();
      console.log(`    대기 중... 남은 ${Math.round((deadline - Date.now()) / 1000)}초`);
    }
    await page.waitForTimeout(2000);
  }
}

/**
 * 로그인이 실제로 끝났는지 본다.
 *
 * 예전에는 `주소가 nid.naver.com 을 벗어났으면 성공`으로 봤는데, 캡차·본인확인
 * 단계에서 네이버가 잠깐 다른 주소로 튕기기만 해도 성공으로 오인해 사람이 아직
 * 아무것도 안 눌렀는데 다음 단계로 넘어가 버렸다 (2026-08-24 운영자 보고).
 * 인증 쿠키가 실제로 생겼는지로 판정한다.
 */
async function isLoggedIn(page) {
  if (page.url().includes('nid.naver.com')) return false;

  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  // 콘솔에 들어갔거나, 최초 이용 동의 화면이면 로그인은 끝난 것이다.
  if (CONSOLE_ONLY.test(body) || CONSENT_LABEL.test(body)) return true;
  // 서치어드바이저 로그아웃 화면이면 아직이다. 쿠키만 보면 여길 통과해버린다
  // (2026-08-24 uwzmoykotr2: 쿠키는 있는데 화면은 "로그인 - 네이버 서치어드바이저").
  if (LOGGED_OUT_SEARCH_ADVISOR.test(body)) return false;

  // 그 밖의 화면이면 판단할 근거가 없으니 쿠키로 본다.
  const cookies = await page.context().cookies().catch(() => []);
  const names = new Set(cookies.filter((c) => c.value).map((c) => c.name));
  return names.has('NID_AUT') && names.has('NID_SES');
}

/** 콘솔에서 Enter 한 줄을 기다린다. */
async function waitForEnter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('');
  } finally {
    rl.close();
  }
}

/**
 * 서치어드바이저를 처음 쓰는 계정은 "이용 동의" 모달을 먼저 통과해야
 * 사이트 관리 화면으로 들어갈 수 있다. 계정당 1회만 뜬다.
 * 운영자 지시로 자동 동의한다.
 */
/**
 * 조건이 만족되면 바로 넘어가고, 안 되면 cap 까지만 기다린다.
 *
 * 예전에는 3초·4초·1.5초씩 무조건 쉬었다. 계정당 10초가 그냥 날아가서
 * 100계정이면 17분이다 (2026-08-24 운영자: "동의하는 게 너무 느리다").
 * 최악의 경우에만 cap 까지 기다리므로 느려질 일은 없다.
 */
async function settle(page, predicate, capMs = 6000, stepMs = 250) {
  const deadline = Date.now() + capMs;
  for (;;) {
    if (await predicate().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(stepMs);
  }
}


/**
 * 서치어드바이저 콘솔 안까지 들어갔는지.
 *
 * 화살표 const 로 두면 최상위 실행보다 아래라 TDZ 에 걸린다. 함수 선언은
 * 호이스팅되니 위치와 무관하게 안전하다.
 */
async function isSearchAdvisorConsole(page) {
  return CONSOLE_ONLY.test(await page.evaluate(() => document.body?.innerText || ''));
}

/*
 * 서치어드바이저 최초 이용 동의.
 *
 * 예전에는 `input[type=checkbox]` + `button:has-text("확인")` 딱 하나만 봤다.
 * 실제 화면이 그 형태가 아니면 조용히 false 를 돌려주고 지나가서, 사람이 직접
 * 동의를 누르고 Enter 를 쳐야 했다 (2026-08-24 운영자 보고).
 *
 * 그래서 (1) 체크박스는 라벨 클릭까지 폴백하고 (2) 버튼 문구 후보를 여러 개
 * 시도하고 (3) iframe 안도 뒤지고 (4) 그래도 못 찾으면 화면에 보이는 버튼
 * 문구를 찍어 남긴다. 다음 실행 때 그 로그만 보면 셀렉터를 맞출 수 있다.
 */

async function acceptSearchAdvisorTerms(page) {
  for (const scope of [page, ...page.frames()]) {
    const boxes = scope.locator('input[type=checkbox]');
    const count = await boxes.count().catch(() => 0);
    if (!count) continue;

    /*
     * 사람이 하는 순서 그대로 간다: "이용약관에 동의합니다." 를 누르고 → "확인".
     *
     * 체크박스 input 이 숨겨져 있고 화면에 보이는 건 라벨인 경우가 많다.
     * 그때 input 에 force check 를 하면 DOM 값만 바뀌고 사이트 스크립트는
     * 모르기 때문에 "확인" 버튼이 계속 비활성으로 남는다. 그래서 보이는
     * 글자를 실제로 클릭하는 걸 먼저 시도한다.
     */
    const labelHit = scope.getByText(CONSENT_LABEL).first();
    if (await labelHit.count().catch(() => 0)) {
      await labelHit.click({ force: true }).catch(() => {});
    }

    for (let i = 0; i < count; i += 1) {
      const box = boxes.nth(i);
      if (await box.isChecked().catch(() => true)) continue;
      const id = await box.getAttribute('id').catch(() => null);
      if (id) await scope.locator(`label[for="${id}"]`).click({ force: true }).catch(() => {});
      if (await box.isChecked().catch(() => true)) continue;
      await box.check({ force: true }).catch(() => {});
    }

    for (const text of TERMS_BUTTON_TEXTS) {
      const button = scope.locator(`button:has-text("${text}"), a:has-text("${text}"), input[type=submit][value*="${text}"]`).first();
      if (!(await button.count().catch(() => 0))) continue;
      if (!(await button.isVisible().catch(() => false))) continue;
      // 체크가 먹어야 버튼이 살아난다. 잠깐 기다렸다가 누른다.
      await settle(page, () => button.isEnabled().catch(() => false), 3000, 200);
      await button.click({ force: true }).catch(() => {});
      const gone = await settle(page, async () => (await page.locator('input[type=checkbox]').count()) === 0, 8000);
      if (!gone) continue;   // 화면이 그대로면 다른 버튼 문구를 시도한다
      console.log(`  이용약관 자동 동의 완료 ("${text}" 클릭, ${await page.title()})`);
      return true;
    }
  }

  // 못 찾았다. 무엇이 보이는지 남겨야 다음에 고칠 수 있다.
  const seen = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('button, a[role=button], input[type=submit]')]
      .map((el) => (el.innerText || el.value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 12);
    return {
      title: document.title,
      checkboxes: document.querySelectorAll('input[type=checkbox]').length,
      buttons: labels,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    };
  }).catch(() => null);
  // 체크박스가 실제로 있을 때만 약관 화면으로 본다. '이용약관'은 로그아웃 화면
  // 푸터에도 있어서, 글자만 보고 판단하면 엉뚱한 경고가 뜬다.
  if (seen && seen.checkboxes > 0) {
    console.log('  ⚠ 약관 화면 같은데 자동 동의에 실패했습니다. 브라우저에서 직접 동의해 주세요.');
    console.log(`     제목: ${seen.title}`);
    console.log(`     체크박스 ${seen.checkboxes}개 / 버튼: ${seen.buttons.join(' | ')}`);
    console.log(`     문구: ${seen.text}`);
  }
  return false;
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
  /*
   * 캡처는 실제 크롬(headless 아님)으로 하면서 검증만 headless 로 띄웠다.
   * 네이버는 자동화 브라우저를 감지하면 콘솔 대신 로그인 화면을 내준다.
   * 그래서 멀쩡히 로그인된 세션인데 "로그인 - 네이버 서치어드바이저" 제목이
   * 나와 검증에 실패하고, 사람이 5분 넘게 붙어서 만든 세션을 버렸다
   * (2026-08-24 운영자 로그: fbzfr23i69stg).
   * 캡처와 똑같은 조건으로 띄우되 창만 화면 밖에 둔다.
   */
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--lang=ko-KR',
      '--window-position=-2400,-2400',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
  });
  try {
    const context = await browser.newContext({
      storageState: statePath,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
    const page = await context.newPage();
    const response = await page.goto(SEARCH_ADVISOR_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    /*
     * 결론이 나는 글자가 보일 때까지 기다린다.
     *
     * 여기에 `웹마스터 가이드` 를 넣어뒀던 게 화근이었다. 그 글자는 SPA 껍데기가
     * 처음 그려질 때 이미 있어서, 콘솔이 렌더되기도 전에 대기가 끝나고 그 순간의
     * 제목("로그인 - 네이버 서치어드바이저")으로 실패 판정을 내렸다. 쿠키는
     * NID_AUT·NID_SES·SADV 까지 멀쩡한데 검증만 계속 실패한 이유다
     * (2026-08-24 uwzmoykotr2). 캡처 쪽은 고쳤는데 검증 쪽을 빠뜨렸다.
     *
     * 콘솔 내용이 나오거나, 진짜 로그인 폼이 나올 때까지만 본다.
     */
    await settle(page, async () => /사이트 관리|사이트 등록|간단체크|아이디 또는 전화번호|로그인 상태 유지|QR 코드 로그인/
      .test(await page.evaluate(() => document.body?.innerText || '')), 20_000);
    const url = page.url();
    if (url.includes('nid.naver.com')) return { ok: false, reason: '로그인 페이지로 튕겼습니다.' };
    if (response && response.status() >= 400) return { ok: false, reason: `HTTP ${response.status()}` };

    // URL 만 보면 안 된다. searchadvisor 도메인 그대로 로그인 화면을 그리는 경우가 있어,
    // 실제로 "로그인 - 네이버 서치어드바이저" 화면을 통과시켜 깨진 세션을 저장했다.
    // 그 세션이 멀쩡하던 것을 덮어써서 소유확인 1,000건이 통째로 실패했다(2026-08-06).
    // 화면 내용으로 로그인 여부를 확정한다.
    const title = (await page.title()) || '';
    const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');

    // 콘솔 내용이 보이면 통과다. SPA 라 제목이 늦게 바뀌는 경우가 있어, 제목보다
    // 화면 내용을 먼저 본다 (제목만 보고 멀쩡한 세션을 버렸다).
    if (CONSOLE_ONLY.test(body)) return { ok: true, title: title.slice(0, 40) };
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
