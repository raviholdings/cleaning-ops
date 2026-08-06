import { subKeywordsFor } from './keywords.ts';
import { FAQ_POOL, REVIEW_POOL, SERVICE_CATEGORIES_TEMPLATE, VENDOR_TIPS_POOL } from './content.ts';

const GU_ABBREVIATIONS = new Set([
  '중', '남', '동', '북', '서',
  '처인', '수지', '기흥',
  '분당', '수정', '중원',
  '만안', '동안',
  '덕양', '일산동', '일산서',
  '상록', '단원',
  '팔달', '영통', '장안', '권선',
  '성산', '의창', '마산합포', '마산회원', '진해',
  '완산', '덕진',
  '상당', '서원', '흥덕', '청원',
  '동남', '서북',
]);

/**
 * 축약된 구 명칭(예: 울산 중 북정동 -> 울산 중구 북정동)을 정형화한다.
 */
export function normalizeLocation(location: string): string {
  if (!location) return '';
  const tokens = location.trim().split(/s+/);
  if (tokens.length <= 1) return location;

  const normalized = tokens.map((token, idx) => {
    if (idx > 0 && idx < tokens.length - 1 && GU_ABBREVIATIONS.has(token)) {
      return token + '구';
    }
    return token;
  });
  return normalized.join(' ');
}

/**
 * (지역, 메인키워드) 해시를 사용하여 3대 약속 문구를 다변화한다.
 * 비트 연산자(>>) 음수 인덱스 버그를 제거하고 방어적 널리시 병합(??)을 적용한다.
 */
export function pickPromises(location: string, main: string) {
  const mainName = main && main.trim().length > 0 ? main.trim() : '청소';

  const seed = hash(`promises|${location}|${main}`);

  const timeTitles = ['시간 엄수 & 당일 배정', '정확한 방문 & 빠른 상담', '약속 시간 철저 준수'] as const;
  const priceTitles = ['투명한 정찰제 안내', '사전 확정 합리적 견적', '현장 추가금 제로 지향'] as const;
  const asTitles = ['100% 품질 보증 AS', '검증팀 책임 시공', '피해보상 보험 및 사후 케어'] as const;

  const tIdx = seed % timeTitles.length;
  const pIdx = Math.floor(seed / 3) % priceTitles.length;
  const aIdx = Math.floor(seed / 7) % asTitles.length;

  const promise1Title = timeTitles[tIdx] ?? '시간 엄수 & 당일 배정';
  const promise2Title = priceTitles[pIdx] ?? '투명한 정찰제 안내';
  const promise3Title = asTitles[aIdx] ?? '100% 품질 보증 AS';

  return [
    {
      badge: '⏱️',
      title: promise1Title,
      desc: `전담 검증팀이 약속 일시를 엄수하며 30초 내 맞춤 ${mainName} 업체를 연결해 드립니다.`,
      checklist: ['30초 간편 접수', '당일 긴급 방문 상담', '정확한 일정 준수'],
    },
    {
      badge: '💰',
      title: promise2Title,
      desc: `현장 무단 추가금 없는 사전 확정 정찰제로 거품 없는 ${mainName} 비용을 제안합니다.`,
      checklist: ['상세 항목 사전 안내', '무료 맞춤 견적', '부담 없는 정찰제'],
    },
    {
      badge: '🎖️',
      title: promise3Title,
      desc: `전담 시공팀이 직접 작업하며, 만족도 미흡 시 24시간 내 재청소를 보장합니다.`,
      checklist: ['신원 검증 전문 인력', '품질 만족 보장', '전문 장비 운용'],
    },
  ];
}


/**
 * (지역, 메인키워드) 기반 확인 팁 추출 (지역명 제외, 키워드 주입).
 */
export function pickVendorTips(location: string, main: string, count = 6): string[] {
  const pool = VENDOR_TIPS_POOL;
  const size = pool.length;
  if (size === 0) return [];
  const take = Math.min(count, size);

  const seed = hash(`tips|${location}|${main}`);
  let step = (seed % (size - 1)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const fill = (text: string) => text.replaceAll('{main}', main);

  const picked: string[] = [];
  for (let i = 0; i < take; i += 1) {
    const item = pool[(seed + i * step) % size];
    if (item) picked.push(fill(item));
  }
  return picked;
}

/**
 * (지역, 메인키워드) 기반 서비스 카테고리 추출 (지역명 제외).
 */
export function pickServiceCategories(location: string, main: string) {
  return SERVICE_CATEGORIES_TEMPLATE.map((cat) => ({
    name: cat.name,
    detail: cat.detail.replaceAll('{main}', main),
    items: cat.items,
  }));
}

/**
 * 진행 절차 추출 (텍스트 내 순번 1. 2. 제거, CSS 스텝 카운터 전용).
 */
export function pickProcessSteps(location: string, main: string): string[] {
  return [
    `원하시는 ${main} 조건에 맞춰 30초 간편 신청서를 작성합니다.`,
    `접수된 내용을 확인하여 방문 가능한 검증 전담팀을 배정합니다.`,
    `상세 견적 및 서비스 조건 안내를 전화나 문자로 확인합니다.`,
    `청소 완료 후 현장 검수를 진행하며 미흡한 곳은 즉시 보완합니다.`,
  ];
}

function getRecentReviewDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 페이지마다 다른 이용 후기 조합을 고른다.
 * (지역, 메인키워드) 기반 해시로 어뷰징 방지 및 텍스트 렌더링.
 * 배포/생성 시점 기준 1일~30일 이내 최신 작성 날짜 자동 부여.
 */
export function pickReviews(location: string, main: string, count = 3) {
  const pool = REVIEW_POOL;
  const size = pool.length;
  if (size === 0) return [];
  const take = Math.min(count, size);

  const seed = hash(`review|${location}|${main}`);
  let step = (seed % (size - 1)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const fill = (text: string) => text.replaceAll('{main}', main).replaceAll('{location}', shortLocation(location));

  const picked: { author: string; rating: number; date: string; text: string }[] = [];
  for (let i = 0; i < take; i += 1) {
    const idx = (seed + i * step) % size;
    const item = pool[idx];
    if (!item) continue;

    const daysAgo = ((seed + i * 7 + idx) % 30) + 1;
    const reviewDate = getRecentReviewDate(daysAgo);

    picked.push({
      author: item.author,
      rating: item.rating,
      date: reviewDate,
      text: fill(item.text),
    });
  }
  return picked;
}

/**
 * 주어진 위치 근처의 주변 동네 목록을 중복 없이 추출한다.
 * 동일한 끝 동/리(shortLocation)명이 중복 출력되지 않도록 필터링한다.
 */
export function pickNearbyLocations(location: string, locations: readonly string[], count = 4): string[] {
  if (!locations || locations.length === 0) return [];
  const index = locations.indexOf(location);
  const baseIndex = index >= 0 ? index : hash(location) % locations.length;
  const targetShort = shortLocation(location);

  const picked: string[] = [];
  const pickedShorts = new Set<string>([targetShort]);

  const seed = hash(`nearby|${location}`);
  const step = (seed % 17) + 7;

  for (let i = 1; i <= locations.length && picked.length < count; i += 1) {
    const candidateIndex = (baseIndex + i * step) % locations.length;
    const nearby = locations[candidateIndex];
    if (!nearby) continue;

    const normNearby = normalizeLocation(nearby);
    const nearbyShort = shortLocation(normNearby);
    if (!pickedShorts.has(nearbyShort)) {
      picked.push(normNearby);
      pickedShorts.add(nearbyShort);
    }
  }

  if (picked.length < count) {
    for (let i = 1; i <= locations.length && picked.length < count; i += 1) {
      const nearby = locations[(baseIndex + i) % locations.length];
      if (!nearby) continue;

      const normNearby = normalizeLocation(nearby);
      const nearbyShort = shortLocation(normNearby);
      if (!pickedShorts.has(nearbyShort)) {
        picked.push(normNearby);
        pickedShorts.add(nearbyShort);
      }
    }
  }

  return picked;
}

export type TitleVariant = 'A' | 'B';

const CTA_VERBS = ['비교', '추천', '순위', '견적'] as const;
const CTA_COUNTS = [7, 9, 10] as const;

const TITLE_BUDGET = 15;

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shortLocation(location: string): string {
  const norm = normalizeLocation(location);
  return norm.trim().split(/s+/).pop() ?? norm;
}

export function pickSubKeywords(location: string, main: string, count = 2): string[] {
  const pool = subKeywordsFor(main);
  if (pool.length === 0) return [];
  if (pool.length <= count) return [...pool];

  const seed = hash(`${location}|${main}`);
  const picked: string[] = [];
  let index = seed % pool.length;
  while (picked.length < count) {
    const candidate = pool[index % pool.length];
    if (candidate && !picked.includes(candidate)) picked.push(candidate);
    index += 1;
  }
  return picked;
}

function cta(location: string, main: string) {
  const seed = hash(`${location}|${main}`);
  const verbIdx = seed % CTA_VERBS.length;
  const countIdx = Math.floor(seed / 7) % CTA_COUNTS.length;
  return {
    verb: CTA_VERBS[verbIdx] ?? CTA_VERBS[0],
    count: CTA_COUNTS[countIdx] ?? CTA_COUNTS[0],
  };
}

export function buildTitle(location: string, main: string, variant: TitleVariant = 'A'): string {
  const norm = normalizeLocation(location);
  const { verb, count } = cta(norm, main);

  if (variant === 'B') {
    return `${norm} ${main} ${verb} ${count}곳`;
  }

  const base = `${shortLocation(norm)} ${main}`;
  for (const candidate of [`${base} ${verb} ${count}곳`, `${base} ${verb}`, base]) {
    if (candidate.length <= TITLE_BUDGET) return candidate;
  }
  return base;
}

export function buildDescription(location: string, main: string, variant: TitleVariant = 'A'): string {
  const norm = normalizeLocation(location);
  const subs = pickSubKeywords(norm, main);

  if (variant === 'B') {
    return `${norm} ${main} 업체 비교. ${subs.join(' ')} 정보와 무료 견적을 한 번에 확인하세요.`;
  }

  const short = shortLocation(norm);
  const candidate = `${short} ${main} 업체를 비용과 후기로 비교하고 무료 견적을 받으세요`;
  return candidate.length <= 45
    ? candidate
    : `${short} ${main} 업체 비교, 무료 견적 신청`;
}

export function buildHeading(location: string, main: string): string {
  const norm = normalizeLocation(location);
  return `${norm} ${main} 업체 비교`;
}

export function pickFaqs(location: string, main: string, count = 5) {
  const pool = FAQ_POOL;
  const size = pool.length;
  if (size === 0) return [];
  const take = Math.min(count, size);

  const seed = hash(`faq|${location}|${main}`);
  let step = (seed % (size - 1)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const sub = pickSubKeywords(location, main, 1)[0] ?? main;
  const fill = (text: string) => text.replaceAll('{main}', main).replaceAll('{sub}', sub);

  const picked: { q: string; a: string }[] = [];
  for (let i = 0; i < take; i += 1) {
    const item = pool[(seed + i * step) % size];
    if (item) picked.push({ q: fill(item.q), a: fill(item.a) });
  }
  return picked;
}

export function ctaLabel(location: string, main: string): string {
  const { verb, count } = cta(location, main);
  return `${verb} ${count}곳`;
}

export function heroSubCopy(location: string, main: string): string {
  const seed = hash(`hero|${location}|${main}`);
  const count = (seed % 17) + 4;
  return `30초 만에 ${count}곳 검증 업체 조건 확인 및 맞춤 연결`;
}

export function buildIndexMeta(siteUrl: string, locations: readonly string[], main: string) {
  const seed = hash(`indexMeta|${siteUrl}`);
  const topLocationRaw = locations[seed % Math.max(1, locations.length)] ?? locations[0] ?? '';
  const topLocation = normalizeLocation(topLocationRaw);
  const topShort = shortLocation(topLocation);

  const titlePool = [
    `${topShort} ${main} 전문 업체 추천 순위 및 견적 비교`,
    `${topShort} 인근 ${main} 비용 비교 및 맞춤 연결`,
    `${main} 전문 업체 비교 추천 (${topShort} 외 전국)`,
    `${topLocation} ${main} 견적 비교 및 안심 서비스`,
  ];

  const descPool = [
    `전국 ${main} 전문 업체의 서비스 조건과 비용을 비교하고, ${topShort} 등 내 지역에 딱 맞는 검증 업체를 30초 만에 연결받으세요.`,
    `${main} 비용 및 고객 후기 비교. ${topShort} 등 지역별 우수 검증팀이 방문하여 무단 추가금 없이 안심 시공을 진행합니다.`,
    `${topShort} 인근 ${main} 전문 전담팀 30초 무료 맞춤 견적 신청. 현장 검수 및 AS 보장 서비스를 지금 확인하세요.`,
    `${main} 추천 순위 및 비용 안내. ${topShort} 지역 포함 전국 검증팀의 실시간 조건 비교 서비스를 제공합니다.`,
  ];

  const tIdx = seed % titlePool.length;
  const dIdx = Math.floor(seed / 3) % descPool.length;

  return {
    title: titlePool[tIdx] ?? titlePool[0],
    description: descPool[dIdx] ?? descPool[0],
    topLocation,
  };
}
