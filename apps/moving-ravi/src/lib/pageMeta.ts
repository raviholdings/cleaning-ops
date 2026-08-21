/**
 * 이사 페이지의 제목·설명.
 *
 * 네이버 권장 길이를 넘지 않게 만든다.
 *   제목 / og:title        40자 이내
 *   설명 / og:description  80자 이내
 *
 * 지역명이 최대 22자라(예: "전남 신안군 흑산면 가거도리") 긴 지역에서는
 * 전체 지역명을 그대로 쓰면 제목이 넘친다. 그래서 후보를 긴 것부터 짧은 것
 * 순으로 만들어 두고, 한도에 들어오는 첫 후보를 고른다.
 *
 * 자르지 않고 후보를 바꾸는 이유: 중간에서 자르면 "전남 신안군 흑산…" 처럼
 * 지역명이 깨진다. 그러면 그 페이지가 노리는 검색어와 제목이 어긋난다.
 */

export const TITLE_LIMIT = 40;
export const DESC_LIMIT = 80;

/** "전남 신안군 흑산면 가거도리" -> "가거도리" */
export function lastToken(location: string): string {
  const tokens = String(location).trim().split(/\s+/);
  return tokens[tokens.length - 1] || location;
}

/** "전남 신안군 흑산면 가거도리" -> "흑산면 가거도리" (뒤 두 토큰) */
function tailTwo(location: string): string {
  const tokens = String(location).trim().split(/\s+/);
  return tokens.slice(-2).join(' ');
}

/** 후보 중 한도에 들어오는 첫 번째를 고른다. 다 넘치면 가장 짧은 것. */
function fit(candidates: string[], limit: number): string {
  for (const c of candidates) if (c.length <= limit) return c;
  return candidates.reduce((a, b) => (a.length <= b.length ? a : b));
}

/**
 * 제목. 40자 이내.
 *
 * 청소 제목처럼 서브키워드를 섞고 꼬리(견적/비교)를 페이지별로 회전시킨다.
 * "업체 5곳 비교 | 이사프렌즈" 같은 고정 틀은 50만 장이 전부 한 네트워크로
 * 보이게 만들어서 뺐다 (2026-08-21 운영자 지시). 브랜드명도 넣지 않는다.
 *
 * 어떤 서브를 몇 개 넣을지는 길이가 정한다 — 긴 지역은 서브가 빠지고,
 * 짧은 지역은 서브 2개까지 들어가 자연스럽게 페이지마다 달라진다.
 */
const TITLE_TAILS = ['견적', '비교', '안내', '후기', '가격'];

export function buildTitle(location: string, main: string, subs: string[] = [], seed = 0): string {
  const full = String(location).trim();
  const two = tailTwo(full);
  const one = lastToken(full);
  const pool = subs.length ? subs : [main];
  const s1 = pool[seed % pool.length] || '';
  const s2 = pool[(seed + 1) % pool.length] || '';
  // 서브키워드가 어미와 같은 말로 끝나면("포장이사견적 견적") 다음 어미로 넘긴다.
  let tail = '';
  for (let i = 0; i < TITLE_TAILS.length; i += 1) {
    tail = TITLE_TAILS[(seed + i) % TITLE_TAILS.length];
    if (!s1.endsWith(tail) && !s2.endsWith(tail)) break;
  }

  return fit([
    `${full} ${main} ${s1} ${s2} ${tail}`,
    `${full} ${main} ${s1} ${tail}`,
    `${two} ${main} ${s1} ${s2} ${tail}`,
    `${two} ${main} ${s1} ${tail}`,
    `${full} ${main} ${tail}`,
    `${two} ${main} ${tail}`,
    `${one} ${main} ${s1} ${tail}`,
    `${one} ${main} ${tail}`,
  ], TITLE_LIMIT);
}

/**
 * 설명. 80자 이내.
 *
 * 서브 키워드를 한두 개 녹여 페이지마다 문장이 달라지게 한다. 다만 길이가
 * 먼저다 — 넘치면 서브를 뺀 후보로 내려간다.
 */
export function buildDescription(
  location: string,
  main: string,
  vendorCount: number,
  subs: string[] = [],
): string {
  const full = String(location).trim();
  const two = tailTwo(full);
  const one = lastToken(full);
  const s1 = subs[0] || '';
  const s2 = subs[1] || '';

  return fit([
    `${full} ${main} 업체 ${vendorCount}곳의 견적을 무료로 비교하세요. ${s1} ${s2}까지 한 번에 확인할 수 있습니다.`,
    `${full} ${main} 업체 ${vendorCount}곳 견적을 무료로 비교하세요. ${s1}까지 한 번에 확인됩니다.`,
    `${two} ${main} 업체 ${vendorCount}곳 견적을 무료로 비교하세요. ${s1}까지 함께 확인하세요.`,
    `${full} ${main} 업체 ${vendorCount}곳의 견적을 무료로 비교해 드립니다.`,
    `${two} ${main} 업체 ${vendorCount}곳 견적을 무료로 비교해 드립니다.`,
    `${one} ${main} 업체 ${vendorCount}곳 견적을 무료로 비교해 드립니다.`,
    `${one} ${main} 견적을 무료로 비교해 드립니다.`,
  ], DESC_LIMIT);
}
