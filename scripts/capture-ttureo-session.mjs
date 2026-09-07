#!/usr/bin/env node
/**
 * ttureo.kr 수집요청용 네이버 세션을 만든다.
 *
 *   node scripts/capture-ttureo-session.mjs
 *
 * 브라우저가 뜨면 **직접 로그인**하시면 된다. 로그인이 끝나 서치어드바이저
 * 화면이 뜨는 것을 스크립트가 알아서 감지하고 쿠키를 파일로 저장한 뒤 닫는다.
 *
 * 왜 대포 계정 풀(naver_searchadvisor_accounts)을 안 쓰나 —
 * ttureo.kr 은 운영자 개인 계정으로 소유확인했고 본인이 직접 관리한다.
 * 풀에 넣으면 (1) 러너가 HaiIP 로 IP 를 계속 바꿔 로그인해 정지 위험을 지고
 * (2) 비밀번호·세션이 대포 계정들과 같은 자리에 저장된다. 개인 계정에는
 * 둘 다 치를 이유가 없는 값이다. 그래서 DB 를 안 거치고 쿠키 파일만 쓴다.
 *
 * 비밀번호는 저장하지 않는다 — 쿠키만 저장한다.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.TTUREO_SESSION_PATH
  || 'C:/Users/LD/Desktop/ravi/_secure/ttureo-naver-session.json';
const CONSOLE_URL = 'https://searchadvisor.naver.com/console/board';
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsearchadvisor.naver.com%2Fconsole%2Fboard';
const TIMEOUT_MS = 10 * 60 * 1000; // 로그인·캡차에 넉넉히

const ctxDir = dirname(OUT);
if (!existsSync(ctxDir)) mkdirSync(ctxDir, { recursive: true });

console.log('브라우저를 엽니다. 네이버에 직접 로그인해 주세요.');
console.log('로그인이 끝나면 자동으로 감지해서 저장하고 닫습니다. (최대 10분 대기)');
console.log('저장 위치: ' + OUT);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ locale: 'ko-KR' });
const page = await context.newPage();
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;
while (Date.now() < deadline) {
  // 로그인되면 콘솔로 넘어간다. nid.naver.com 에 머물러 있으면 아직 안 됐다.
  const url = page.url();
  if (url.startsWith('https://searchadvisor.naver.com/') && !url.includes('nidlogin')) {
    // 콘솔이 실제로 뜬 뒤에 저장해야 세션 쿠키가 다 잡힌다.
    await page.waitForTimeout(2500);
    ok = true;
    break;
  }
  await page.waitForTimeout(1000);
}

if (!ok) {
  console.error('✗ 시간 안에 로그인이 확인되지 않았습니다. 다시 실행해 주세요.');
  await browser.close();
  process.exit(1);
}

await page.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(1500);
const state = await context.storageState({ path: OUT });
const naverCookies = state.cookies.filter((c) => /naver\.com$/.test(c.domain.replace(/^\./, '')));
await browser.close();

console.log(`✓ 저장 완료 — 쿠키 ${state.cookies.length}개 (네이버 도메인 ${naverCookies.length}개)`);
console.log('  ' + OUT);
if (naverCookies.length < 5) {
  console.log('⚠ 쿠키가 적습니다. 로그인이 덜 된 상태일 수 있으니 확인 후 다시 돌려 주세요.');
}
