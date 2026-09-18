#!/usr/bin/env node
/**
 * 브랜드 5종(ia_48) 수집요청용 네이버 세션을 만든다.
 *
 *   node scripts/capture-brand-session.mjs
 *
 * 브라우저가 뜨면 **직접 로그인**하시면 된다. 로그인이 끝나 서치어드바이저
 * 화면이 뜨는 것을 스크립트가 알아서 감지하고 쿠키를 파일로 저장한 뒤 닫는다.
 *
 * 왜 capture-naver-session.mjs 를 안 쓰나 —
 * 그쪽은 대포 계정 풀 전용이다. 계정마다 HaiIP 로 배정 IP 를 만들어 로그인하고,
 * 그 IP 를 DB 에 박아 다음 실행이 다시 그 IP 를 찾아간다. 유동 IP 라 그 IP 는
 * 곧 사라지고, 결국 매번 새 IP 에서 로그인하게 된다 — 2026-09-17 에 그렇게
 * 94개가 한꺼번에 죽었다. 실명 계정에 그 위험을 지울 이유가 없다.
 *
 * 그래서 여기서는 IP 를 건드리지 않는다. 지금 나가는 IP 로 사람이 로그인하고,
 * 쿠키만 파일로 남긴다. 비밀번호는 저장하지 않는다.
 * ttureo 쪽(capture-ttureo-session.mjs)과 같은 방식이고, 파일만 따로 쓴다.
 *
 * ⚠ HaiIP 를 쓰지 않는다 (운영자 결정 2026-09-18). 집 회선 IP 그대로 간다.
 *   브랜드는 하루 250건이라 IP 를 돌릴 이유가 없고, IP 가 안 바뀌면 네이버 눈에
 *   늘 같은 기기·같은 위치라 보호조치를 부를 일도 없다. ttureo 와 같은 방식이다.
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.BRAND_SESSION_PATH
  || 'C:/Users/LD/Desktop/ravi/_secure/brand-naver-session.json';
const CONSOLE_URL = 'https://searchadvisor.naver.com/console/board';
const LOGIN_URL = 'https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsearchadvisor.naver.com%2Fconsole%2Fboard';
const TIMEOUT_MS = 10 * 60 * 1000; // 로그인·캡차·보호조치에 넉넉히

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
const hasLogin = state.cookies.some((c) => c.name === 'NID_AUT')
  && state.cookies.some((c) => c.name === 'NID_SES');
await browser.close();

console.log(`✓ 저장 완료 — 쿠키 ${state.cookies.length}개 (네이버 도메인 ${naverCookies.length}개)`);
console.log('  ' + OUT);
if (!hasLogin) {
  // 이게 없으면 제출이 전부 "로그인이 필요합니다" 로 떨어진다. 미리 잡는다.
  console.log('⚠ NID_AUT/NID_SES 로그인 쿠키가 없습니다. 로그인이 덜 된 상태입니다 — 다시 돌려 주세요.');
  process.exitCode = 1;
} else if (naverCookies.length < 5) {
  console.log('⚠ 쿠키가 적습니다. 확인 후 다시 돌려 주세요.');
}
