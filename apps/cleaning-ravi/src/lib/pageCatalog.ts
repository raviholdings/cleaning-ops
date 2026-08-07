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

/**
 * 최초 배포 때 쓴 사이트당 페이지 수. **절대 바꾸지 말 것.**
 *
 * 슬롯이 `siteIndex * pageCount + (page-1)` 이라, pageCount 를 바꾸면 모든
 * 사이트의 시작점이 밀려 이미 배포·색인된 페이지의 지역·키워드가 통째로
 * 뒤바뀐다. 실제로 100 -> 150 으로 바꾸면 기존 10,000 페이지 중 9,900 개의
 * 조합이 달라진다.
 *
 * 그래서 기준선은 이 값으로 고정하고, 이보다 뒤 페이지는 별도 영역(확장 슬롯)
 * 에서 가져온다. 레거시 bbungbbung-piping 의 expansion 슬롯과 같은 방식이다.
 */
export const BASELINE_PAGE_COUNT = 100;

/**
 * 확장 영역의 시작 슬롯. 기준선 영역과 절대 겹치면 안 된다.
 * 기준선은 `siteIndex * 100` 이므로 사이트 N개면 [0, N*100) 을 쓴다.
 * 여유를 둬 사이트 10,000개(= 슬롯 1,000,000)까지 기준선으로 예약한다.
 */
export const EXPANSION_SLOT_BASE = 1_000_000;

/** 확장 페이지를 사이트마다 몇 개씩 끊어 배정할지. */
export const EXPANSION_INCREMENT = 50;

/**
 * 페이지 번호 -> 전역 슬롯.
 *
 * 기준선 안(1~BASELINE_PAGE_COUNT)이면 예전 그대로 계산한다. 그래야 이미
 * 배포된 페이지의 내용이 유지된다. 그 뒤 페이지만 확장 영역에서 가져온다.
 */
export function globalSlotFor(siteIndex: number, requestId: number): number {
  const pageSlot = requestId - 1;
  if (pageSlot < BASELINE_PAGE_COUNT) {
    return siteIndex * BASELINE_PAGE_COUNT + pageSlot;
  }
  const extra = pageSlot - BASELINE_PAGE_COUNT;
  const round = Math.floor(extra / EXPANSION_INCREMENT);
  const within = extra % EXPANSION_INCREMENT;
  // 라운드마다 전 사이트를 한 바퀴 돈다. 사이트별로 연속 블록을 주면
  // 나중에 사이트가 늘 때 뒤 블록과 겹친다.
  return EXPANSION_SLOT_BASE
    + round * EXPANSION_SLOT_STRIDE
    + siteIndex * EXPANSION_INCREMENT
    + within;
}

/** 한 라운드가 소비하는 슬롯 폭. 예약 사이트 수 × 증가분. */
const EXPANSION_SLOT_STRIDE = 10_000 * EXPANSION_INCREMENT;

export function catalogEntry({
  locations,
  siteIndex,
  requestId,
  pageCount,
  seed = 'cleaning-ravi-location-keyword-v1',
}: CatalogInput): CatalogEntry {
  const comboCount = locations.length * MAIN_KEYWORDS.length;
  if (comboCount === 0) throw new Error('페이지 카탈로그 차원이 비어 있습니다.');

  const globalSlot = globalSlotFor(siteIndex, requestId);

  // 슬롯이 조합수를 넘으면 modulo 로 되감기며 다른 사이트와 같은 조합이 나온다.
  // 그 순간 내용이 통째로 중복되므로 조용히 넘어가지 않고 여기서 멈춘다.
  if (globalSlot >= comboCount) {
    throw new Error(
      `슬롯 ${globalSlot} 이 조합수 ${comboCount} 를 넘었습니다 `
      + `(사이트 #${siteIndex + 1}, 페이지 ${requestId}). `
      + `지역 ${locations.length} × 키워드 ${MAIN_KEYWORDS.length} 로는 여기까지가 한계입니다. `
      + `페이지를 더 늘리려면 키워드나 지역을 늘려야 합니다.`,
    );
  }

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
