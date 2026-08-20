/**
 * 이사 페이지 카탈로그. (사이트 번호, 페이지 번호) -> (지역, 메인키워드).
 *
 * 청소(apps/cleaning-ravi/src/lib/pageCatalog.ts)와 같은 발상이다. 다른 점은
 * 키워드 목록과 재고 규모뿐이라 계산식은 그대로 옮겼다.
 *
 *   지역 72,938 × 키워드 20 = 1,458,760 조합
 *   사이트 10,000 × 50장    =   500,000 사용 (34%)
 *
 * 청소는 재고의 99.8% 를 써서 131장이 상한이었는데, 이사는 여유가 크다.
 * 그래서 청소처럼 확장 슬롯을 따로 두지 않고 단순한 계산 하나로 끝낸다.
 *
 * 같은 시드면 항상 같은 결과가 나와야 한다. 다시 구워도 페이지 내용이
 * 바뀌면 안 되기 때문이다.
 */

import { MAIN_KEYWORDS } from './keywords.ts';

/** 사이트 하나가 갖는 페이지 수. 늘리려면 이 값만 바꾼다. */
export const PAGE_COUNT = 50;

/** 문자열 -> 32비트 해시. 청소와 같은 계열. */
export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * size 와 서로소인 보폭.
 *
 * 청소와 같은 값을 쓴다. size/3 같은 작은 배수를 쓰면 안 된다 — 슬롯이
 * 그만큼씩 뛰다가 금방 제자리로 돌아와, 한 사이트의 50장이 지역 3곳만
 * 반복하게 된다(처음에 그렇게 짰다가 실제로 그랬다).
 *
 * 큰 소수 근처에서 시작해 내려오며 서로소를 찾으면 한 바퀴가 길어져
 * 사이트 안에서 지역이 골고루 흩어진다.
 */
export function coprimeStep(size: number): number {
  if (size <= 1) return 1;
  let step = Math.min(size - 1, 1299709);
  if (step % 2 === 0) step -= 1;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  while (step > 1 && gcd(step, size) !== 1) step -= 2;
  return Math.max(1, step);
}

export interface CatalogInput {
  locations: string[];
  siteIndex: number;
  requestId: number;
  pageCount?: number;
  seed?: string;
}

export interface CatalogEntry {
  locationIndex: number;
  keywordIndex: number;
  location: string;
  mainKeyword: string;
}

/**
 * 전역 슬롯. 사이트마다 연속된 구간을 준다.
 *
 * 청소는 나중에 페이지를 늘리면서 확장 영역을 따로 붙였는데(그러다 사이트
 * 6,259번부터 슬롯이 모자라 배포가 죽었다), 이사는 재고가 충분하므로
 * 처음부터 연속 배정으로 둔다. 나중에 늘려도 앞 페이지의 내용이 바뀌지
 * 않도록, 사이트당 폭을 넉넉히(100) 잡아 둔다.
 */
const SLOT_STRIDE = 100;

export function globalSlotFor(siteIndex: number, requestId: number): number {
  return siteIndex * SLOT_STRIDE + (requestId - 1);
}

export function catalogEntry({
  locations,
  siteIndex,
  requestId,
  seed = 'moving-ravi-location-keyword-v1',
}: CatalogInput): CatalogEntry {
  const comboCount = locations.length * MAIN_KEYWORDS.length;
  if (comboCount === 0) throw new Error('카탈로그 차원이 비어 있습니다.');

  const globalSlot = globalSlotFor(siteIndex, requestId);
  if (globalSlot >= comboCount) {
    throw new Error(
      `슬롯 ${globalSlot} 이 조합수 ${comboCount} 를 넘었습니다 `
      + `(사이트 #${siteIndex + 1}, 페이지 ${requestId}). `
      + `지역 ${locations.length} × 키워드 ${MAIN_KEYWORDS.length} 로는 여기까지가 한계입니다.`,
    );
  }

  const offset = hashString(seed) % comboCount;
  const step = coprimeStep(comboCount);
  const comboIndex = (offset + globalSlot * step) % comboCount;

  const locationIndex = Math.floor(comboIndex / MAIN_KEYWORDS.length);
  const keywordIndex = comboIndex % MAIN_KEYWORDS.length;

  return {
    locationIndex,
    keywordIndex,
    location: locations[locationIndex],
    mainKeyword: MAIN_KEYWORDS[keywordIndex],
  };
}
