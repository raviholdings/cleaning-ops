#!/usr/bin/env node
/**
 * 서치어드바이저 소유확인. 등록과 메타태그 배포가 끝난 뒤에 돌린다.
 *
 *   node scripts/verify-naver-searchadvisor-sites.mjs --account lguxp4nlw --limit 5
 *   node scripts/verify-naver-searchadvisor-sites.mjs --accounts 1-10
 *
 * 흐름은 레거시 naver_ownership_only.py 와 같다.
 *   1. console/verify?site=... 로 이동
 *   2. input[type=radio] 의 두 번째(HTML 태그) 선택
 *   3. "소유확인" 버튼 클릭
 *   4. 성공하면 보드 목록에서 그 사이트가 "소유확인 진행" 에서 빠진다
 *
 * 계정이 바뀔 때마다 HaiIP 로 그 계정의 검증 IP 로 옮기고 curl 로 확인한다.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium } from 'playwright';
import {
  logProxyBanner,
  playwrightProxy,
  resolveCdpUrl,
  resolveProxyConfig,
  shouldSkipHaiIp,
} from './lib/naver-proxy.mjs';
import { solveCaptchaWithAntiCaptcha } from './lib/anti-captcha-solver.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const dryRun = Boolean(options.dryRun);
const perSiteDelayMs = Number(options.delayMs || 3000);
const limit = options.limit ? Number(options.limit) : null;
const groupKey = options.groupKey || 'cleaning-ravi';
const metaCheckConcurrency = Number(options.metaCheckConcurrency || 6);
const execFileAsync = promisify(execFile);
const tmpRoot = resolve(projectRoot, 'tmp/naver-login');
const haiIpScript = resolve(projectRoot, 'scripts/haiip-windows-ui-control.ps1');

// 반자동 모드: 브라우저를 눈에 보이게 띄우고, 캡차가 뜨면 사람이 직접 입력한다.
// 네이버가 "프로그램을 이용한 자동등록 방지"로 건 장치라 사람이 푸는 것 외에는 길이 없다.
const semiAuto = Boolean(options.interactive || options.semiAuto);
const captchaWaitMs = Number(options.captchaTimeoutMs || 10 * 60 * 1000);
const cdpUrl = resolveCdpUrl(options);

const proxyConfig = resolveProxyConfig({
  cliFlag: Boolean(options.useProxy || options.useBrightdata),
  projectRoot,
});
logProxyBanner(proxyConfig, 'site verification', cdpUrl);
const haiIpSkip = shouldSkipHaiIp(proxyConfig, Boolean(options.noHaiip), cdpUrl);
const skipHaiIp = haiIpSkip.skip;
if (skipHaiIp) console.log(`[haiip] IP 전환을 건너뜁니다 (${haiIpSkip.reason}).`);

const rl = semiAuto ? createInterface({ input, output }) : null;

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
      summary.push(await verifyForAccount(account));
    } catch (error) {
      console.error(`  ✗ 계정 실패: ${error.message}`);
      summary.push({ accountId: account.account_id, ok: false, error: error.message });
    }
  }
  console.log(`\n${JSON.stringify({ phase: 'summary', summary }, null, 2)}`);
  if (summary.some((s) => !s.ok)) process.exitCode = 1;
} finally {
  rl?.close();
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

async function verifyForAccount(account) {
  if (account.status !== 'active') throw new Error(`계정 상태가 active 가 아닙니다: ${account.status}`);
  if (!account.searchadvisor_session_secret_id) throw new Error('저장된 세션이 없습니다.');
  if (!account.validated_ip) throw new Error('검증 IP 가 없습니다.');

  await ensureAccountIp(account);

  const domains = await client.query(
    `select id, host, site_url, naver_verification_token
       from public.naver_project_domains
      where group_key = $1 and naver_account_id = $2
        and naver_registration_status = 'registered'
        and naver_verification_token is not null
      order by (source_payload->>'globalSiteOrder')::int
      ${limit ? 'limit ' + Number(limit) : ''}`,
    [groupKey, account.account_id],
  );
  console.log(`  소유확인 대상 ${domains.rowCount}건`);
  if (!domains.rowCount) return { accountId: account.account_id, ok: true, verified: 0 };

  // 메타태그가 실제로 배포됐는지 전 도메인을 미리 훑는다.
  // 예전에는 첫 도메인 하나만 보고 계정 전체를 중단시켰다. 그래서 죽은 도메인
  // 하나가 순번 맨 앞에 오면 멀쩡한 나머지 수십 건까지 통째로 막혔다.
  const { live, skipped, unreachable } = await filterLiveDomains(domains.rows);
  console.log(`  메타태그 확인: ${live.length}/${domains.rowCount}건 진행${skipped.length ? `, ${skipped.length}건 건너뜀` : ' ✅'}`);
  for (const item of skipped.slice(0, 10)) console.log(`    - 건너뜀 ${item.host}: ${item.reason}`);
  if (skipped.length > 10) console.log(`    - ... 외 ${skipped.length - 10}건`);
  if (unreachable.length) {
    console.log(`    ℹ️ ${unreachable.length}건은 이 PC 회선에서 접속이 막혀 확인만 못 했습니다 (그대로 진행).`);
    for (const item of unreachable.slice(0, 5)) console.log(`       - ${item.host}`);
    if (unreachable.length > 5) console.log(`       - ... 외 ${unreachable.length - 5}건`);
  }
  if (!live.length) {
    throw new Error(`메타태그가 살아 있는 도메인이 없습니다 (${domains.rowCount}건 전부 접속 불가). 배포/DNS 확인이 필요합니다.`);
  }

  if (dryRun) {
    console.log('  (dry-run: 브라우저를 띄우지 않습니다)');
    return { accountId: account.account_id, ok: true, dryRun: true, wouldVerify: live.length, skipped: skipped.length };
  }

  const statePath = resolve(tmpRoot, `${account.account_id}.storage.json`);
  mkdirSync(tmpRoot, { recursive: true });
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', account.account_id, '--output', statePath,
  ], { stdio: 'pipe' });

  const browser = cdpUrl
    ? await chromium.connectOverCDP(cdpUrl)
    : await chromium.launch({
        headless: !semiAuto,
        channel: 'chrome',
        ...(playwrightProxy(proxyConfig) ? { proxy: playwrightProxy(proxyConfig) } : {}),
      });
  let verified = 0;
  const failures = [];
  try {
    const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
    const page = await context.newPage();

    for (const [index, domain] of live.entries()) {
      try {
        await verifyOne(page, domain.site_url, `[${index + 1}/${live.length}] ${domain.host}`);
        await client.query(
          `update public.naver_project_domains
              set naver_registration_status = 'verified', naver_verified_at = now(), updated_at = now()
            where id = $1`,
          [domain.id],
        );
        verified += 1;
      } catch (error) {
        failures.push({ host: domain.host, error: error.message.split('\n')[0].slice(0, 120) });
        console.log(`  ✗ ${domain.host}: ${error.message.split('\n')[0].slice(0, 100)}`);
      }
      if ((index + 1) % 10 === 0 || index + 1 === live.length) {
        console.log(`  진행 ${index + 1}/${live.length}  성공 ${verified}  실패 ${failures.length}`);
      }
      await sleep(perSiteDelayMs);
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(statePath, { force: true });
  }

  return {
    accountId: account.account_id,
    ok: failures.length === 0,
    verified,
    failed: failures.length,
    skipped: skipped.length,
    skippedHosts: skipped.slice(0, 5).map((item) => item.host),
    failures: failures.slice(0, 5),
  };
}

/**
 * 계정의 도메인 중 메타태그가 실제로 살아 있는 것만 골라낸다.
 * 죽은 도메인은 사유와 함께 건너뛴다 (전체를 중단시키지 않는다).
 */
async function filterLiveDomains(rows) {
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const live = [];
  const skipped = [];
  const unreachable = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      const state = await metaTagState(row.site_url, row.naver_verification_token);
      if (state.ok) {
        live.push(row);
      } else if (state.unreachable) {
        // 여기서 안 보인다고 죽은 게 아니다. 판단은 네이버에 맡기고 그대로 진행한다.
        live.push(row);
        unreachable.push({ host: row.host, reason: state.reason });
      } else {
        skipped.push({ host: row.host, reason: state.reason });
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(metaCheckConcurrency, rows.length) },
    worker,
  ));

  live.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { live, skipped, unreachable };
}

/** 캡차(보안문자) 모달이 떠 있는지. 네이버는 v-dialog 로 띄운다. */
async function captchaVisible(page) {
  try {
    const dialog = page.locator('.v-dialog, [role=dialog]').first();
    if (!await dialog.count()) return false;
    if (!await dialog.isVisible().catch(() => false)) return false;
    const text = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/자동입력방지|자동등록|보이는 글자|보안문자/.test(text)) return false;
    const hasInput = (await dialog.locator('input[type=text], input:not([type=hidden])').count()) > 0;
    return hasInput && hasImg;
  } catch {
    return false;
  }
}

async function verifyOne(page, siteUrl, label = '') {
  // 보드 목록 페이지를 먼저 열고, 거기서 소유확인 링크를 클릭하여 진입 (Vue 상태 유지)
  await page.goto('https://searchadvisor.naver.com/console/board', { waitUntil: 'domcontentloaded', timeout: 40_000 });
  await page.waitForTimeout(1000);

  const siteLink = page.locator(`a[href*="${encodeURIComponent(siteUrl)}"]`).first();
  if (await siteLink.count() && await siteLink.isVisible().catch(() => false)) {
    await siteLink.click();
  } else {
    await page.goto(`https://searchadvisor.naver.com/console/verify?site=${encodeURIComponent(siteUrl)}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  }

  // 캡차 답이 틀리면 네이버는 모달만 닫고 폼을 초기 상태로 되돌린다(라디오 해제).
  // 그래서 제출 동작을 함수로 빼서 그때 그대로 다시 쏠 수 있게 한다.
  const submitVerifyForm = async () => {
    await page.waitForSelector("input[type='radio']", { timeout: 15_000 });
    const radios = page.locator("input[type='radio']");
    if (await radios.count() >= 2) {
      await radios.nth(1).click({ force: true });
      await page.waitForTimeout(400);
    }

    const submitBtn = page.locator("button:has-text('소유확인'), a:has-text('소유확인')").first();
    await submitBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await submitBtn.click();
  };

  await submitVerifyForm();

  const hasAntiCaptcha = Boolean(process.env.ANTI_CAPTCHA_API_KEY);
  let deadline = Date.now() + (semiAuto || hasAntiCaptcha ? 60_000 : 20_000);
  let asked = false;
  let captchaAttempts = 0;
  let captchaMisses = 0;
  const maxCaptchaAttempts = Number(options.captchaRetries || 5);
  const maxCaptchaMisses = 5;
  // 캡차 답을 넣고 [확인]을 누른 뒤 결과를 기다리는 중인지. 결과 대신 빈 폼이
  // 돌아오면 오답이었다는 뜻이므로 폼을 다시 제출해 캡차를 새로 띄운다.
  let awaitingCaptchaResult = false;
  let idleTicks = 0;
  // 정답이면 이 안에 성공 화면이 뜬다. 루프가 1초에 한 번 도니 초 단위와 같다.
  const captchaResultGraceTicks = 6;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);

    const state = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, .v-dialog, .v-dialog__content'));
      const dialogText = dialogs.map(d => d.innerText || '').join(' ');
      const allText = body + ' ' + dialogText;

      const success = /소유\s*확인(이)?\s*완료|소유\s*확인\s*완료|소유확인\s*완료|완료되었습니다/.test(allText);
      const failed = /소유\s*확인(에)?\s*실패|소유확인\s*실패|확인에\s*실패/.test(allText);
      
      // 캡차 이미지는 <img> 가 아니라 Vuetify v-img 의 CSS background-image 로 그려진다.
      //   <div class="v-image__image" style="background-image: url(https://captcha.nid.naver.com/nhncaptchav4.gif?key=...)">
      // 그래서 img/canvas 만 찾으면 캡차가 떠 있어도 못 본다.
      const captchaUrlPattern = /captcha\.nid\.naver\.com|nhncaptcha/i;
      const hasCaptchaImage = (root) => Array.from(root.querySelectorAll('*')).some((el) => {
        const matched = (el.tagName === 'IMG' && captchaUrlPattern.test(el.currentSrc || el.src || ''))
          || captchaUrlPattern.test(el.getAttribute('style') || '')
          || captchaUrlPattern.test(getComputedStyle(el).backgroundImage || '');
        if (!matched) return false;
        // 닫히는 중이거나 DOM 에 껍데기로 남은 다이얼로그는 크기가 0 이다.
        // 캡처 쪽과 같은 조건을 써야 "감지는 되는데 캡처는 안 되는" 무한 루프가 안 생긴다.
        const box = el.getBoundingClientRect();
        return box.width >= 30 && box.height >= 15;
      });

      const captchaOpen = dialogs.some(d => {
        const text = (d.innerText || '').replace(/\s+/g, ' ');
        if (!/자동입력방지|자동등록|보이는 글자|보안문자/i.test(text)) return false;
        return hasCaptchaImage(d);
      });

      // 오답 뒤에는 모달이 통째로 사라지고 소유확인 폼이 초기 상태로 되돌아간다.
      // 다이얼로그 엘리먼트는 껍데기로 DOM 에 남기 때문에 존재 여부로는 판별이 안 되고,
      // 라디오 선택이 풀렸는지를 봐야 한다. Vuetify 는 실제 input 과 아이콘 리거처를
      // 따로 관리하므로 둘 다 확인한다.
      const radioChecked = Array.from(document.querySelectorAll("input[type='radio']"))
        .some((r) => r.checked) || /radio_button_checked/.test(body);
      const onVerifyForm = /소유\s*확인\s*방법을\s*선택/.test(body);

      return {
        success,
        failed,
        captchaOpen,
        radioChecked,
        onVerifyForm,
        leftVerify: !location.href.includes('/verify') && location.href.includes('/console'),
      };
    });

    if (state.success || state.leftVerify) {
      const okBtn = page.locator('.v-dialog button:has-text("확인"), [role=dialog] button:has-text("확인")').first();
      if (await okBtn.count() && await okBtn.isVisible().catch(() => false)) {
        await okBtn.click().catch(() => {});
      }
      return;
    }

    if (state.failed) {
      throw new Error('소유확인 실패');
    }

    // 캡차를 제출했는데 성공도 실패도 아니고 모달마저 사라졌다면 오답이다.
    // 예전에는 여기서 데드라인까지 그냥 기다리다 "판단하지 못했습니다"로 끝났고,
    // 캡차가 다시 뜨지 않으니 재시도 횟수도 영영 1/N 에 멈춰 있었다.
    // 캡차를 제출했는데 성공도 실패도 아니고 캡차도 사라졌다면 오답이다.
    // 네이버는 오답 시 모달만 닫고 폼을 되돌려 놓기 때문에 아무 신호도 주지 않는다.
    // (라디오 선택 상태는 쓸 수 없다. 화면 아이콘은 해제로 보여도 내부 input.checked
    //  는 true 로 남아 있어서 radioChecked 로는 리셋을 구분하지 못한다.)
    // 그래서 "캡차 낸 뒤 결과 없이 흐른 시간"을 신호로 쓴다.
    if (awaitingCaptchaResult && !state.captchaOpen && state.onVerifyForm) {
      idleTicks += 1;
      if (idleTicks >= captchaResultGraceTicks) {
        awaitingCaptchaResult = false;
        idleTicks = 0;
        if (captchaAttempts >= maxCaptchaAttempts) {
          throw new Error(`캡차 오답으로 ${maxCaptchaAttempts}회 재제출했지만 소유확인에 실패했습니다.`);
        }
        console.log(`  ↻ 캡차 오답으로 보입니다 — 소유확인을 다시 제출합니다 (${captchaAttempts}/${maxCaptchaAttempts} 사용).`);
        await submitVerifyForm();
        deadline = Date.now() + 60_000;
        continue;
      }
    }

    if (state.captchaOpen) {
      awaitingCaptchaResult = false;
      const antiCaptchaApiKey = process.env.ANTI_CAPTCHA_API_KEY;
      if (antiCaptchaApiKey && captchaAttempts < maxCaptchaAttempts) {
        captchaAttempts += 1;
        console.log(`\n  🔐 보안문자 감지 — Anti-Captcha 자동 해독 시도 ${captchaAttempts}/${maxCaptchaAttempts}${label ? ` (${label})` : ''}`);
        try {
          // 캡차 이미지 엘리먼트와 그 다이얼로그에 표식을 달아 Playwright 로 정확히 집는다.
          const marked = await page.evaluate(() => {
            const pattern = /captcha\.nid\.naver\.com|nhncaptcha/i;
            document.querySelectorAll('[data-captcha-target]').forEach((el) => el.removeAttribute('data-captcha-target'));
            document.querySelectorAll('[data-captcha-dialog]').forEach((el) => el.removeAttribute('data-captcha-dialog'));

            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, .v-dialog, .v-dialog__content'));
            const roots = dialogs.length ? dialogs : [document.body];
            for (const root of roots) {
              for (const el of root.querySelectorAll('*')) {
                const inline = el.getAttribute('style') || '';
                const bg = pattern.test(inline) ? inline : (getComputedStyle(el).backgroundImage || '');
                const src = el.tagName === 'IMG' ? (el.currentSrc || el.src || '') : '';
                if (!pattern.test(bg) && !pattern.test(src)) continue;
                const box = el.getBoundingClientRect();
                if (box.width < 30 || box.height < 15) continue;
                (el.closest('.v-image') || el).setAttribute('data-captcha-target', '1');
                const dialog = el.closest('.v-dialog, [role=dialog], .v-dialog__content');
                if (dialog) dialog.setAttribute('data-captcha-dialog', '1');
                const url = (bg.match(/url\(["']?([^"')]+)["']?\)/) || [])[1] || src;
                return { url, width: Math.round(box.width), height: Math.round(box.height), hasDialog: Boolean(dialog) };
              }
            }
            return null;
          });

          if (!marked) {
            captchaAttempts -= 1; // 일시적으로 못 찾은 것뿐이니 시도 횟수를 까먹지 않는다
            captchaMisses += 1;
            if (captchaMisses >= maxCaptchaMisses) {
              // 감지는 되는데 캡처가 계속 안 되면 데드라인까지 같은 로그만 반복한다.
              // 시간 낭비 대신 여기서 끊고, 내일 원인을 볼 수 있게 다이얼로그 내용을 남긴다.
              const dump = await page.evaluate(() => Array.from(
                document.querySelectorAll('[role="dialog"], dialog, .v-dialog, .v-dialog__content'),
              ).map((d) => `[${d.className}] visible=${d.getBoundingClientRect().width > 0} :: ${(d.innerText || '').replace(/\s+/g, ' ').slice(0, 200)}`).join(' | ')).catch(() => '');
              console.warn(`  [DEBUG] 다이얼로그 상태: ${dump.slice(0, 600) || '(없음)'}`);
              const fatal = new Error(`캡차 이미지를 ${maxCaptchaMisses}회 연속으로 찾지 못했습니다.`);
              fatal.fatalCaptcha = true; // 아래 catch 가 삼키고 다시 루프에 들어가지 않게 표시한다
              throw fatal;
            }
            console.warn(`  ⚠️ 캡차 이미지 엘리먼트를 찾지 못해 대기 후 재시도합니다 (${captchaMisses}/${maxCaptchaMisses}).`);
            await page.waitForTimeout(1000);
            continue;
          }
          captchaMisses = 0;

          const dialog = marked.hasDialog
            ? page.locator('[data-captcha-dialog="1"]').first()
            : page.locator('.v-dialog, [role=dialog]').first();
          await dialog.waitFor({ timeout: 5000 });

          // 2회차부터는 직전 답이 틀렸다는 뜻이니 새 이미지를 받아서 푼다.
          if (captchaAttempts > 1) {
            const refreshBtn = dialog.locator('button:has-text("새로고침")').first();
            if (await refreshBtn.count() && await refreshBtn.isVisible().catch(() => false)) {
              await refreshBtn.click().catch(() => {});
              await page.waitForTimeout(1500);
            }
          }

          // canvas.toDataURL 은 크로스 오리진(captcha.nid.naver.com) 이라 SecurityError 로 죽는다.
          // 화면에 그려진 엘리먼트를 그대로 스크린샷 찍는 쪽이 안전하고 픽셀도 정확하다.
          let base64Image = null;
          try {
            const shot = await page.locator('[data-captcha-target="1"]').first().screenshot({ type: 'png' });
            base64Image = shot.toString('base64');
          } catch (shotError) {
            console.warn(`  ⚠️ 엘리먼트 스크린샷 실패(${shotError.message.split('\n')[0].slice(0, 80)}) — 이미지 URL 직접 요청으로 대체합니다.`);
          }
          if (!base64Image && marked.url) {
            const res = await page.request.get(marked.url, { headers: { referer: page.url() } });
            if (!res.ok()) throw new Error(`캡차 이미지 요청 실패: HTTP ${res.status()}`);
            base64Image = (await res.body()).toString('base64');
          }
          if (!base64Image) throw new Error('캡차 이미지를 가져오지 못했습니다.');

          deadline = Date.now() + 90_000; // 해독 왕복(최대 30초) 동안 루프가 끝나버리지 않게 연장
          const solutionText = await solveCaptchaWithAntiCaptcha(base64Image, antiCaptchaApiKey);

          const inputEl = dialog.locator('input[type=text], input:not([type=hidden])').first();
          await inputEl.fill(solutionText);
          await inputEl.dispatchEvent('input').catch(() => {});
          await inputEl.dispatchEvent('change').catch(() => {});

          const confirmBtn = dialog.locator('button:has-text("확인"), a:has-text("확인")').first();
          await confirmBtn.click();
          await page.waitForTimeout(2500);
          awaitingCaptchaResult = true;
          idleTicks = 0;
          deadline = Date.now() + 60_000;
          continue;
        } catch (solveError) {
          if (solveError.fatalCaptcha) throw solveError;
          console.error(`  ✗ Anti-Captcha 해독 실패: ${solveError.message}`);
          if (captchaAttempts >= maxCaptchaAttempts && !semiAuto) throw solveError;
          await page.waitForTimeout(1000);
          continue;
        }
      }

      if (antiCaptchaApiKey && captchaAttempts >= maxCaptchaAttempts && !semiAuto) {
        throw new Error(`캡차 자동 해독 ${maxCaptchaAttempts}회 모두 실패했습니다.`);
      }

      if (!semiAuto) {
        throw new Error('캡차(보안문자)가 표시되었습니다. --semi-auto 로 실행해 직접 입력하세요.');
      }
      if (!asked) {
        asked = true;
        console.log(`\n  🔐 보안문자가 떴습니다${label ? ` — ${label}` : ''}.`);
        console.log('     브라우저에서 보안문자를 입력하고 [확인]을 누르세요.');
        console.log('     끝나면 Enter, 이 사이트를 건너뛰려면 s + Enter.');
        const answer = String(await rl.question('     > ') || '').trim().toLowerCase();
        if (answer === 's') throw new Error('operator skipped');
        asked = false; // 입력이 틀려 캡차가 다시 뜨면 한 번 더 물어본다
      }
    }
  }

  const debugText = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');
  console.log(`  [DEBUG] 최종 화면 텍스트: "${debugText.slice(0, 300)}"`);
  await page.screenshot({ path: 'verify_debug.png' }).catch(() => {});

  throw new Error(semiAuto
    ? '시간 안에 소유확인이 완료되지 않았습니다.'
    : '소유확인 결과를 판단하지 못했습니다 (캡차일 수 있습니다. --semi-auto 로 실행하세요).');
}

/**
 * 배포된 페이지에 인증 메타태그가 실제로 들어 있는지 확인한다.
 * "태그가 없다" 와 "사이트가 아예 안 뜬다" 는 원인이 완전히 다르므로 구분해서 알려준다.
 */
async function metaTagState(siteUrl, token) {
  try {
    const { stdout } = await execFileAsync('curl', ['-s', '--max-time', '20', '-A',
      'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)', siteUrl],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (stdout.includes(token)) return { ok: true };
    // 응답이 왔는데 토큰이 없으면 그건 진짜 배포 문제다.
    if (stdout.trim()) return { ok: false, reason: '메타태그 없음 (재배포 필요)' };
    return { ok: false, unreachable: true, reason: '빈 응답' };
  } catch (error) {
    // 이 PC 회선은 호스트명에 "fast" 가 들어가면 무조건 끊는다. 우리 도메인만이 아니라
    // fast.com, breakfast.com 까지 막힌다. 같은 주소가 EC2 와 휴대폰 통신사에서는
    // 정상으로 열리는 걸 확인했다(2026-08-05).
    // 즉 "여기서 못 본다"는 "사이트가 죽었다"가 아니다. 네이버 크롤러는 잘 들어간다.
    // 이걸 죽은 것으로 단정해 건너뛰는 바람에 멀쩡한 도메인 93개가 소유확인에서 빠졌었다.
    const code = String(error.stderr || error.message || '').match(/curl: \((\d+)\)/);
    return { ok: false, unreachable: true, reason: `이 PC에서 접속 불가 (curl ${code ? code[1] : '?'})` };
  }
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
  if (skipHaiIp) throw new Error(`IP 불일치: 현재 ${current}, 필요 ${target}`);

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

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
