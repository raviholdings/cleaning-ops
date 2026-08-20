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
 * 브랜드명(" | 이사프렌즈", 8자)은 여유가 있을 때만 붙인다. 긴 지역에서
 * 브랜드를 넣겠다고 지역명을 자르면 본말이 전도된다.
 */
export function buildTitle(location: string, main: string, vendorCount: number): string {
  const full = String(location).trim();
  const two = tailTwo(full);
  const one = lastToken(full);

  return fit([
    `${full} ${main} 업체 ${vendorCount}곳 비교 | 이사프렌즈`,
    `${full} ${main} 업체 ${vendorCount}곳 비교`,
    `${two} ${main} 업체 ${vendorCount}곳 비교`,
    `${full} ${main} ${vendorCount}곳 비교`,
    `${two} ${main} ${vendorCount}곳 비교`,
    `${one} ${main} 업체 ${vendorCount}곳 비교`,
    `${one} ${main} ${vendorCount}곳 비교`,
    `${one} ${main} 비교`,
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
