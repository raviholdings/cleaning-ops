/**
 * 계정별 크롬 프로필 재사용.
 *
 * 왜 필요한가 (2026-09-14 실측):
 *   쿠키만 새 브라우저에 주입하면 네이버 눈에는 매번 "처음 보는 기기"다.
 *   VPN IP 까지 매번 다르니 로그인마다 "새 기기 + 새 위치" 가 되어 보호조치를 부른다.
 *   실제로 계정 여러 개가 두 번째 로그인에서 죽었다.
 *   처음 로그인한 크롬 프로필을 그대로 보관해 두고 다시 쓰면 로그인 화면 자체가 안 뜬다
 *   (dlvt794 · ihpuz90 로 확인: nid.naver.com 을 거치지 않고 콘솔로 바로 들어감).
 *
 * 프로필 위치: tmp/naver-login/ 아래
 *   _<계정>-<시각>   open-browser.mjs --keep-profile 이 만든 것
 *   <계정>-view      open-naver-console.mjs 가 만든 것
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--lang=ko-KR'];

/**
 * 쓸 프로필 폴더를 찾는다.
 * @param {string} projectRoot
 * @param {string} account   계정 아이디
 * @param {string} profileOpt  'auto' | 경로 | '' (안 씀)
 * @returns {string|null}
 */
export function findProfileDir(projectRoot, account, profileOpt, { create = false } = {}) {
  if (!profileOpt) return null;
  if (profileOpt !== 'auto') {
    const dir = resolve(projectRoot, profileOpt);
    return existsSync(dir) ? dir : null;
  }
  const base = resolve(projectRoot, 'tmp/naver-login');
  const candidates = existsSync(base)
    ? readdirSync(base)
      .filter((name) => name === `${account}-view` || name.startsWith(`_${account}-`) || name === `${account}-profile`)
      .sort()                                  // 이름에 시각이 들어가 있어 마지막이 최신
    : [];
  if (candidates.length) return resolve(base, candidates[candidates.length - 1]);
  /*
   * 없으면 새로 만든다 (create). 이번 실행은 어차피 DB 세션 쿠키를 주입해 돌아가고,
   * 끝나면 프로필이 남아 다음 실행부터 "같은 기기" 가 된다. 지금 안 만들면
   * 계정마다 영원히 새 기기로 남는다.
   */
  if (!create) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  return resolve(base, `_${account}-${stamp}`);
}

/**
 * 프로필로 브라우저를 연다. 저장된 세션 쿠키도 덮어써 넣는다
 * (프로필 쿠키가 오래됐어도 DB 세션으로 살아나도록).
 *
 * @returns {{ context, page, close: () => Promise<void>, profileDir: string }}
 */
export async function openWithProfile({ chromium, profileDir, statePath = '', headless = false, offscreen = false, proxy = null }) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: Boolean(headless),
    channel: 'chrome',
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: [
      ...STEALTH_ARGS,
      ...(offscreen && !headless ? ['--window-position=-2400,-2400', '--window-size=1280,900'] : ['--start-maximized']),
    ],
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    ...(proxy ? { proxy } : {}),
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  if (statePath && existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (state.cookies?.length) await context.addCookies(state.cookies);
    } catch { /* 프로필 쿠키만으로 진행 */ }
  }
  const page = context.pages()[0] || await context.newPage();
  return {
    context,
    page,
    profileDir,
    close: async () => { await context.close().catch(() => {}); },
  };
}
