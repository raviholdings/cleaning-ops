// 확장자를 명시한다. Vite 는 물론이고 Node 가 이 파일을 직접 import 할 때도
// 해석되어야 한다 (scripts/sync-naver-project-page-catalog.mjs 가 site.mjs 를 통해
// 이 모듈을 그대로 읽는다). 확장자가 없으면 Node ESM 이 못 찾는다.
import { MAIN_KEYWORDS } from './keywords.ts';

/**
 * globalSlot → (지역, 메인키워드) 배정.
 *
 * 레거시 apps/bbungbbung-piping/src/site.mjs 의 공식을 그대로 옮긴 것이다.
 * 조합수와 서로소인 step 을 쓰면 slot 을 1씩 늘려도 조합이 겹치지 않고
 * 전체를 한 바퀴 돈다. 덕분에 한 사이트의 100개 페이지가 특정 지역에
 * 몰리지 않고 전국으로 흩어진다.
 *
 * 같은 slot 은 언제 계산해도 같은 조합을 돌려주므로, 재빌드해도 URL 과
 * 콘텐츠의 매핑이 바뀌지 않는다.
 */

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

/** 조합수와 서로소인 보폭. 레거시와 동일한 알고리즘. */
export function coprimeStep(size: number): number {
  if (size <= 1) return 1;
  let step = Math.min(size - 1, 1299709);
  if (step % 2 === 0) step -= 1;
  while (step > 1 && greatestCommonDivisor(step, size) !== 1) {
    step -= 2;
  }
  return Math.max(1, step);
}

export interface CatalogEntry {
  locationIndex: number;
  keywordIndex: number;
  location: string;
  mainKeyword: string;
}

export interface CatalogInput {
  /** naver_page_locations 의 rollout_order 순서 목록 */
  locations: readonly string[];
  /** 사이트 순번 (0-based) */
  siteIndex: number;
  /** 사이트 안에서의 페이지 번호 (1-based, URL 의 N) */
  requestId: number;
  /** 사이트당 페이지 수 */
  pageCount: number;
  /** 시작점을 그룹마다 다르게 하는 시드 */
  seed?: string;
}

export function catalogEntry({
  locations,
  siteIndex,
  requestId,
  pageCount,
  seed = 'cleaning-ravi-location-keyword-v1',
}: CatalogInput): CatalogEntry {
  const comboCount = locations.length * MAIN_KEYWORDS.length;
  if (comboCount === 0) throw new Error('페이지 카탈로그 차원이 비어 있습니다.');

  const globalSlot = siteIndex * pageCount + (requestId - 1);
  const offset = hashString(seed) % comboCount;
  const step = coprimeStep(comboCount);

  const comboIndex = (offset + (globalSlot % comboCount) * step) % comboCount;
  const locationIndex = Math.floor(comboIndex / MAIN_KEYWORDS.length);
  const keywordIndex = comboIndex % MAIN_KEYWORDS.length;

  return {
    locationIndex,
    keywordIndex,
    location: locations[locationIndex],
    mainKeyword: MAIN_KEYWORDS[keywordIndex],
  };
}

/** URL 경로. route_style 'slashless' = /N.html */
export function pagePath(requestId: number): string {
  return `/${Math.max(1, Math.trunc(requestId))}.html`;
}
