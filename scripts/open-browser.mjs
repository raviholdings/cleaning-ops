#!/usr/bin/env node
/**
 * 빈 크롬을 띄워 사람이 직접 로그인해 보는 도구. 쿠키·계정을 미리 넣지 않는다.
 * 로그인 테스트를 하면서 **세션과 이동 경로를 남겨** 나중에 분석할 수 있게 한다.
 *
 *   node scripts/open-browser.mjs
 *   node scripts/open-browser.mjs --url https://searchadvisor.naver.com/console/board
 *   node scripts/open-browser.mjs --account ftcgwnr90        # 닫을 때 그 계정 세션으로 DB 에 저장
 *   node scripts/open-browser.mjs --keep-profile --minutes 120
 *
 * 남기는 것 (reports/browser-test/)
 *   <label>-<시각>.json          이동 경로, 쿠키 이름·도메인, 로그인 성공 여부, IP
 *   <label>-<시각>.storage.json  storageState 원본 (쿠키 값 포함 — 취급 주의)
 * --account 를 주면 upsert-naver-searchadvisor-session.mjs 로 DB(Vault)에도 넣는다.
 * DB 를 읽지도 쓰지도 않는 게 기본이다. 창을 닫으면 끝난다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1]; };
const url = valueOf('--url', 'https://searchadvisor.naver.com/console/board');
const minutes = Number(valueOf('--minutes', 90));
const keepProfile = args.includes('--keep-profile');
const account = valueOf('--account', '');
const label = String(valueOf('--label', account || 'manual')).replace(/[^a-zA-Z0-9_-]/g, '') || 'manual';
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
const outDir = resolve(projectRoot, 'reports/browser-test');
const reportPath = resolve(outDir, `${label}-${stamp}.json`);
const statePath = resolve(outDir, `${label}-${stamp}.storage.json`);

const publicIp = () => {
  try { return execFileSync('curl', ['-s', '--max-time', '15', `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const startIp = publicIp();
console.log(`현재 공인 IP : ${startIp || '(확인 실패)'}`);
console.log(`여는 주소    : ${url}`);
if (account) console.log(`저장 대상 계정: ${account} (창을 닫을 때 DB 에 세션 저장)`);

/*
 * --profile <경로|auto> : 기존 크롬 프로필을 그대로 다시 쓴다.
 *
 * 네이버는 프로필(쿠키·기기 식별자)이 같으면 같은 기기로 본다. 새 프로필로 매번
 * 로그인하면 매번 "새 기기 + 새 IP" 가 되어 보호조치를 부른다. auto 를 주면
 * tmp/naver-login 에서 그 계정(label)의 최신 프로필을 찾아 쓴다.
 */
const profileOpt = valueOf('--profile', '');
let profileDir;
let reusedProfile = false;
if (profileOpt && profileOpt !== 'auto') {
  profileDir = resolve(projectRoot, profileOpt);
  reusedProfile = existsSync(profileDir);
} else if (profileOpt === 'auto') {
  const base = resolve(projectRoot, 'tmp/naver-login');
  const found = existsSync(base)
    ? readdirSync(base).filter((n) => n.startsWith(`_${label}-`)).sort().pop()
    : null;
  if (found) { profileDir = resolve(base, found); reusedProfile = true; }
  else { profileDir = resolve(base, `_${label}-${stamp}`); }
} else {
  profileDir = resolve(projectRoot, `tmp/naver-login/_${label}-${stamp}`);
}
console.log(reusedProfile ? `기존 프로필 재사용: ${profileDir}` : `새 프로필: ${profileDir}`);
mkdirSync(profileDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const trail = [];
const note = (kind, detail) => {
  const row = { at: new Date().toISOString(), kind, ...detail };
  trail.push(row);
  return row;
};

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome',
  viewport: null,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--lang=ko-KR'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
});

const page = ctx.pages()[0] || await ctx.newPage();
// 이동 경로를 빠짐없이 남긴다 (리다이렉트 체인 분석용).
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) note('navigate', { url: frame.url() });
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
note('opened', { url: page.url(), startIp });
console.log(`\n브라우저를 띄웠습니다. 현재 화면: ${page.url()}`);
console.log(`직접 로그인해 보세요. 창을 닫으면 끝납니다 (최대 ${minutes}분).`);
console.log('자동으로 아무것도 누르지 않습니다. 이동 경로와 세션을 기록합니다.');

let closed = false;
ctx.on('close', () => { closed = true; });

/*
 * 창이 닫힌 뒤에는 아무것도 못 꺼내므로 주기적으로 떠 둔다.
 *
 * ⚠ ctx.storageState() 를 짧은 간격으로 부르면 안 된다. localStorage 를 읽으려고
 * 원본마다 임시 탭을 열었다 닫아서 화면이 계속 깜박인다 (2026-09-14 실제로 겪음).
 * 쿠키만 있으면 세션은 복원되므로 평소에는 ctx.cookies() 로 뜬다 — 탭을 안 연다.
 * localStorage 까지 담은 storageState 는 로그인이 처음 확인된 순간 딱 한 번만 부른다.
 */
let lastState = null;
let lastPageText = '';
let fullStateTaken = false;
const deadline = Date.now() + minutes * 60_000;
while (!closed && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const cookies = await ctx.cookies();
    lastState = { cookies, origins: lastState?.origins || [] };
    const names = new Set(cookies.map((c) => c.name));
    if (!fullStateTaken && names.has('NID_AUT') && names.has('NID_SES')) {
      fullStateTaken = true;
      try {
        const full = await ctx.storageState();
        lastState = full;
        note('login-detected', { cookieCount: full.cookies?.length ?? 0 });
        console.log('  로그인 확인됨 — 세션을 떠 뒀습니다. 작업을 마치면 창을 닫으세요.');
      } catch { /* 무시 */ }
    }
    const p = ctx.pages()[0];
    if (p) {
      const text = await p.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
      if (text && text !== lastPageText) { lastPageText = text; note('screen', { url: p.url(), text: text.slice(0, 300) }); }
    }
  } catch { /* 창이 닫히는 중 */ }
}
if (!closed) { console.log('시간이 지나 창을 닫습니다.'); try { lastState = await ctx.storageState(); } catch {} await ctx.close().catch(() => {}); }

const endIp = publicIp();
const cookies = lastState?.cookies || [];
const names = new Set(cookies.map((c) => c.name));
const loggedIn = names.has('NID_AUT') && names.has('NID_SES');
const report = {
  label,
  account: account || null,
  startedAt: trail[0]?.at || new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  startIp,
  endIp,
  ipChanged: Boolean(startIp && endIp && startIp !== endIp),
  openedUrl: url,
  loggedIn,
  cookieCount: cookies.length,
  naverCookies: cookies.filter((c) => String(c.domain).includes('naver')).map((c) => `${c.name}@${c.domain}`),
  navigations: trail.filter((t) => t.kind === 'navigate').map((t) => ({ at: t.at, url: t.url })),
  screens: trail.filter((t) => t.kind === 'screen').slice(-12),
};
writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n분석 기록: ${reportPath}`);
console.log(`  로그인 성공(NID_AUT+NID_SES): ${loggedIn ? '예' : '아니오'} | 쿠키 ${cookies.length}개 | 이동 ${report.navigations.length}회`);
if (report.ipChanged) console.log(`  ⚠ IP 가 도중에 바뀌었습니다: ${startIp} → ${endIp}`);

if (lastState) {
  writeFileSync(statePath, JSON.stringify(lastState), 'utf8');
  try { chmodSync(statePath, 0o600); } catch {}
  console.log(`  세션 파일: ${statePath}`);
  if (account && loggedIn) {
    try {
      execFileSync(process.execPath, [
        resolve(projectRoot, 'scripts/upsert-naver-searchadvisor-session.mjs'),
        '--account', account,
        '--storage-state', statePath,
        '--saved-ip', endIp || startIp,
        '--validated-ip', endIp || startIp,
        '--status', 'valid',
        '--note', `open-browser 수동 로그인 ${stamp}`,
      ], { stdio: 'inherit', env: process.env });
      console.log(`  DB 저장 완료: ${account}`);
    } catch (e) {
      console.log(`  DB 저장 실패: ${e.message.split('\n')[0]}`);
    }
  } else if (account) {
    console.log('  로그인 쿠키가 없어 DB 에는 저장하지 않았습니다.');
  }
}
if (!keepProfile) {
  rmSync(profileDir, { recursive: true, force: true });
} else {
  /*
   * 프로필을 남길 때는 캐시부터 지운다. 계정 100개면 프로필도 100개인데,
   * 로그인 유지에 필요한 건 쿠키·설정 몇십 KB 뿐이고 나머지는 대부분 캐시다
   * (실측: 전체 28MB 중 캐시 15MB). 캐시는 크롬이 다음에 알아서 다시 만든다.
   */
  const junk = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnCache',
    'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
    'GrShaderCache', 'ShaderCache', 'component_crx_cache', 'Default/optimization_guide_model_store'];
  for (const rel of junk) rmSync(resolve(profileDir, rel), { recursive: true, force: true });
  console.log(`  프로필 보관: ${profileDir} (캐시 정리함)`);
}
console.log('종료했습니다.');
