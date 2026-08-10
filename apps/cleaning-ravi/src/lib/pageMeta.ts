import { ADMIN_DIVISION_EXPANSIONS } from './adminDivisions.ts';
import { MAIN_KEYWORDS, subKeywordsFor } from './keywords.ts';
import {
  FAQ_POOL, REVIEW_AUTHORS, REVIEW_TEXTS, SERVICE_CATEGORIES_TEMPLATE, VENDOR_TIPS_POOL,
} from './content.ts';

/**
 * 축약된 행정구역명을 정식 명칭으로 편다.
 *   서울 동작 흑석동      -> 서울 동작구 흑석동
 *   경기 수원 장안구 파장동 -> 경기 수원시 장안구 파장동
 *
 * 첫 토큰(시도)과 마지막 토큰(동/리)은 건드리지 않는다. 가운데만 편다.
 *
 * ⚠ 이 함수의 결과를 해시 입력으로 쓰면 안 된다.
 * rollout-locations.json 에는 "서울 종로 청운동" 과 "서울 종로구 청운동" 이
 * 서로 다른 항목으로 들어 있고, 카탈로그는 둘을 다른 페이지에 배정한다.
 * 정규화한 문자열로 해시를 돌리면 두 페이지의 제목·FAQ·후기가 통째로
 * 같아진다(지역의 10%가 이런 쌍이다). 표시할 때만 펴고, 해시는 항상 원본
 * 문자열로 돌린다. 그래야 같은 동네를 가리키는 두 페이지가 서로 다른
 * 문장을 갖는다.
 */
export function normalizeLocation(location: string): string {
  if (!location) return '';
  const tokens = location.trim().split(/\s+/);
  if (tokens.length <= 1) return location;

  return tokens
    .map((token, index) => {
      if (index === 0 || index === tokens.length - 1) return token;
      return ADMIN_DIVISION_EXPANSIONS[token] ?? token;
    })
    .join(' ');
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
  const size = REVIEW_TEXTS.length;
  if (size === 0) return [];
  const take = Math.min(count, size);

  const seed = hash(`review|${location}|${main}`);
  let step = (seed % (size - 1)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const fill = fillTokens(location, main);
  const services = reviewServices(seed, take, main);

  const picked: {
    author: string; rating: number; date: string; text: string; service: string;
  }[] = [];

  for (let i = 0; i < take; i += 1) {
    const idx = (seed + i * step) % size;
    const text = REVIEW_TEXTS[idx];
    if (!text) continue;

    // 성씨와 본문을 따로 고른다. 짝을 고정하지 않아야 조합 수가 늘어난다.
    const author = REVIEW_AUTHORS[(seed + i * 31 + idx * 7) % REVIEW_AUTHORS.length] ?? '김**';

    // 별점은 5점 위주로 하되 가끔 4점을 섞는다. 전부 5점이면 오히려 조작처럼 보인다.
    const rating = (seed + i * 13) % 7 === 0 ? 4 : 5;

    const daysAgo = ((seed + i * 7 + idx) % 30) + 1;

    picked.push({
      author,
      rating,
      date: getRecentReviewDate(daysAgo),
      text: fill(text),
      // 이름 옆에 붙는 서비스명. 이 페이지의 지역이 아니라 우리가 다루는
      // 서비스 종류를 보여준다 (입주청소 · 이사청소 · 사무실청소 …).
      service: services[i] ?? main,
    });
  }
  return picked;
}

/**
 * 후기 옆에 붙일 서비스명 목록. 서로 겹치지 않게 고른다.
 *
 * 첫 번째는 이 페이지의 메인 키워드를 그대로 쓴다. 페이지 주제와 후기가
 * 완전히 따로 놀면 어색하다. 나머지는 다른 서비스로 채워, 우리가 청소 전반을
 * 다룬다는 것을 보여준다.
 */
function reviewServices(seed: number, count: number, main: string): string[] {
  const size = MAIN_KEYWORDS.length;
  const out: string[] = [main];
  const used = new Set<string>([main]);

  let index = seed % size;
  while (out.length < count && used.size < size) {
    const candidate = MAIN_KEYWORDS[index % size];
    if (candidate && !used.has(candidate)) {
      out.push(candidate);
      used.add(candidate);
    }
    index += 1;
  }
  return out;
}

/**
 * 지역명에서 상위 행정구역(시/군/구)만 떼어낸다.
 *   충남 예산군 신암면 중예리 -> 충남 예산군 신암면
 *   서울 동작구 흑석동       -> 서울 동작구
 * 마지막 토큰(동/리)만 빼면 된다.
 */
function parentArea(location: string): string {
  const tokens = normalizeLocation(location).trim().split(/\s+/);
  return tokens.length <= 1 ? tokens.join(' ') : tokens.slice(0, -1).join(' ');
}

interface LocationIndex {
  /** 지역 문자열 -> 배열 위치 */
  positionOf: Map<string, number>;
  /** 상위 행정구역(예: 충남 예산군 신암면) -> 그 안의 배열 위치들 */
  byParent: Map<string, number[]>;
  /** 시도(예: 충남) -> 그 안의 배열 위치들 */
  byProvince: Map<string, number[]>;
  /**
   * 끝 동/리 이름 -> 그 이름이 속한 상위 구역.
   *
   * 지역 목록에는 "차용동" 처럼 시도·시군구 없이 동 이름만 있는 항목이
   * 8,966건(12%) 있다. 그것만 보면 어디인지 알 수 없어서 인근 지역이
   * 엉뚱한 도시로 나왔다. 같은 이름이 들어간 전체 표기를 찾아 상위 구역을
   * 되짚는다.
   */
  parentOfLeaf: Map<string, string>;
}

/**
 * 지역 목록 인덱스. 목록은 7만 건이라 페이지마다 훑으면 안 된다.
 *
 * 실제로 그렇게 짰다가 렌더가 1,150 페이지/초에서 42 페이지/초로 떨어졌다.
 * 30만 페이지면 27배 차이라 배포 시간이 2분에서 2시간이 된다.
 * 목록은 빌드 내내 같은 배열이므로 WeakMap 으로 한 번만 만들어 재사용한다.
 */
const locationIndexCache = new WeakMap<readonly string[], LocationIndex>();

function locationIndex(locations: readonly string[]): LocationIndex {
  const cached = locationIndexCache.get(locations);
  if (cached) return cached;

  const built: LocationIndex = {
    positionOf: new Map(),
    byParent: new Map(),
    byProvince: new Map(),
    parentOfLeaf: new Map(),
  };

  locations.forEach((raw, position) => {
    if (!built.positionOf.has(raw)) built.positionOf.set(raw, position);

    const tokens = normalizeLocation(raw).trim().split(/\s+/);
    if (tokens.length <= 1) return;

    const parent = tokens.slice(0, -1).join(' ');
    const bucket = built.byParent.get(parent);
    if (bucket) bucket.push(position); else built.byParent.set(parent, [position]);

    const province = tokens[0]!;
    const pBucket = built.byProvince.get(province);
    if (pBucket) pBucket.push(position); else built.byProvince.set(province, [position]);

    // 가장 자세한 표기를 남긴다. "차용동" 을 "경남 창원시 성산구" 로 되짚기 위해서다.
    // 같은 동 이름이 여러 시에 있으면 먼저 나온 것을 쓴다. 어차피 하나를 골라야 한다.
    const leaf = tokens[tokens.length - 1]!;
    const known = built.parentOfLeaf.get(leaf);
    if (!known || parent.split(' ').length > known.split(' ').length) {
      built.parentOfLeaf.set(leaf, parent);
    }
  });

  locationIndexCache.set(locations, built);
  return built;
}

/**
 * 주변 동네 목록.
 *
 * 예전에는 지역 배열 순서만 보고 일정 보폭으로 건너뛰며 골랐다. 그 배열은
 * 지리 순서가 아니라서 "충남 예산군" 페이지에 "충남 태안군" 이 이웃으로
 * 나왔다. 차로 한 시간 거리다. 방문 가능하다고 적어놓고 못 가면 거짓말이다.
 *
 * 그래서 같은 상위 행정구역(면/읍/구)을 먼저 채우고, 모자라면 같은 시도,
 * 그래도 모자라면 예전 방식으로 채운다.
 */
export function pickNearbyLocations(location: string, locations: readonly string[], count = 4): string[] {
  if (!locations || locations.length === 0) return [];

  const index = locationIndex(locations);
  const at = index.positionOf.get(location);
  const baseIndex = at ?? hash(location) % locations.length;
  const seed = hash(`nearby|${location}`);

  const picked: string[] = [];
  const pickedShorts = new Set<string>([shortLocation(normalizeLocation(location))]);

  const take = (candidate: string | undefined): void => {
    if (!candidate || picked.length >= count) return;
    const norm = normalizeLocation(candidate);
    const short = shortLocation(norm);
    if (pickedShorts.has(short)) return;
    picked.push(norm);
    pickedShorts.add(short);
  };

  const tokens = normalizeLocation(location).trim().split(/\s+/);
  // 동 이름만 있는 항목("차용동")은 전체 표기에서 상위 구역을 되짚는다.
  const parent = tokens.length > 1
    ? tokens.slice(0, -1).join(' ')
    : (index.parentOfLeaf.get(tokens[0] ?? '') ?? '');
  const province = tokens.length > 1 ? (tokens[0] ?? '') : (parent.split(' ')[0] ?? '');

  // 버킷 안에서 내 위치 근처부터 양옆으로 퍼져 나간다. 배열 순서가 대체로
  // 행정 코드 순이라, 가까운 순번이 실제로도 가까운 동네다.
  const sweep = (bucket: number[] | undefined) => {
    if (!bucket || bucket.length === 0 || picked.length >= count) return;
    // 이진 탐색으로 내 위치의 삽입 지점을 찾는다.
    let lo = 0, hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid]! < baseIndex) lo = mid + 1; else hi = mid;
    }
    for (let offset = 0; offset < bucket.length && picked.length < count; offset += 1) {
      for (const direction of [1, -1]) {
        const cursor = direction === 1 ? lo + offset : lo - 1 - offset;
        if (cursor < 0 || cursor >= bucket.length) continue;
        take(locations[bucket[cursor]!]);
        if (picked.length >= count) break;
      }
    }
  };

  sweep(index.byParent.get(parent));
  sweep(index.byProvince.get(province));

  // 그래도 모자라면 (지역이 하나뿐인 시/군) 예전 방식으로 채운다.
  const step = (seed % 17) + 7;
  for (let i = 1; i <= locations.length && picked.length < count; i += 1) {
    take(locations[(baseIndex + i * step) % locations.length]);
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
  return lastLocationToken(norm);
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

/**
 * 이 페이지가 노려야 할 연관 검색어 묶음.
 *
 * 서브키워드는 메인당 평균 3.3개(최소 1, 최대 8)뿐이라, 자기 것만 쓰면
 * 페이지가 걸리는 검색어가 두세 개에서 끝난다. 모자라는 만큼 다른 메인의
 * 서브를 빌려온다. 어차피 우리가 전부 다루는 서비스라 문맥도 맞는다.
 *
 * 한 URL 이 여러 롱테일 검색어에 걸리게 하는 것이 목적이다. 페이지 수를
 * 늘리는 것보다 이쪽이 싸다.
 */
export function relatedKeywords(location: string, main: string, count = 8): string[] {
  const picked: string[] = [];
  const seen = new Set<string>([main]);

  const add = (candidate: string | undefined) => {
    if (!candidate || seen.has(candidate) || picked.length >= count) return;
    picked.push(candidate);
    seen.add(candidate);
  };

  // 1순위: 자기 서브키워드 전부
  for (const sub of subKeywordsFor(main)) add(sub);

  // 2순위: 다른 메인의 서브. 페이지마다 다른 곳에서 시작해 겹침을 줄인다.
  const seed = hash(`related|${location}|${main}`);
  const mains = MAIN_KEYWORDS;
  for (let round = 0; round < 2 && picked.length < count; round += 1) {
    for (let i = 0; i < mains.length && picked.length < count; i += 1) {
      const other = mains[(seed + i) % mains.length];
      if (!other || other === main) continue;
      const pool = subKeywordsFor(other);
      // 1회차는 각 메인에서 하나씩, 2회차에 더 가져온다. 한 메인에 쏠리지 않게.
      const takeCount = round === 0 ? 1 : pool.length;
      for (let j = 0; j < takeCount && picked.length < count; j += 1) {
        add(pool[(seed + j) % Math.max(1, pool.length)]);
      }
      if (round === 0) add(other); // 메인 키워드 자체도 연관어로 쓸 만하다
    }
  }

  return picked;
}

/**
 * 지도 검색 링크.
 *
 * 좌표를 붙이지 않는다. 우리는 특정 업체가 아니라 지역을 가리키므로 주소
 * 문자열 검색이면 충분하고, 좌표를 지어내면 오히려 틀린 위치를 가리킨다.
 * 페이지마다 다른 외부 링크가 생겨 지역성 신호가 붙는다.
 */
export function mapLinks(location: string, main: string) {
  const norm = normalizeLocation(location);
  const query = `${norm} ${main}`;
  return {
    naver: `https://map.naver.com/v5/search/${encodeURIComponent(query)}`,
    google: `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
    query,
  };
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

/**
 * 제목 뒷부분에 붙는 표현들.
 *
 * 네이버는 검색어를 토큰으로 쪼개서 맞춘다. '나성동 하수구 막힘' 으로 검색해도
 * 제목에 '하수구막힘' 이 있으면 '막힘' 토큰이 걸려 노출된다. 그래서 제목이
 * 길수록, 서로 다른 단어가 많이 들어갈수록 걸리는 검색어가 늘어난다.
 *
 * 다만 같은 단어를 반복하면 반대로 감점이다. 조합을 흔들어 페이지마다 다른
 * 단어 묶음이 나오게 한다.
 */
const TITLE_TAILS = ['업체 비교 추천', '전문업체 비교', '업체 추천 순위', '업체 비교 견적'] as const;
const TITLE_HOOKS = ['무료 견적', '비용 견적', '가격 비교', '견적 문의'] as const;

/**
 * 제목 상한. 네이버 검색결과는 대략 이 길이에서 잘리지만, 잘린 뒤 글자도
 * 색인에는 들어간다. 그래서 잘림을 감수하고 토큰을 더 넣는다.
 */
const TITLE_MAX = 78;

export function buildTitle(location: string, main: string, variant: TitleVariant = 'A'): string {
  const norm = normalizeLocation(location);
  const { verb, count } = cta(location, main);

  if (variant === 'B') {
    const seed = hash(`title|${location}|${main}`);
    const subs = pickSubKeywords(norm, main, 2);
    const sub = subs[0] ?? main;
    const tail = TITLE_TAILS[seed % TITLE_TAILS.length] ?? TITLE_TAILS[0];
    const hook = TITLE_HOOKS[Math.floor(seed / 5) % TITLE_HOOKS.length] ?? TITLE_HOOKS[0];

    // 서브를 둘 다 넣는다. '입주청소' 로 검색하든 '입주청소비용' 으로 검색하든
    // '신축입주청소' 로 검색하든 같은 페이지가 걸리게 하는 것이 목적이다.
    const sub2 = secondKeyword(location, main, sub);
    const short = lastLocationToken(norm);

    const patterns = [
      `${norm} ${main} ${sub} ${tail} ${count}곳 | ${sub2} ${hook}`,
      `${norm} ${main} ${tail} ${count}곳 · ${sub} ${sub2} ${hook}`,
      `${norm} ${main} 잘하는곳 ${count}곳 | ${sub} ${sub2} ${tail}`,
      `${norm} ${main} ${verb} ${count}곳 · ${short} ${sub} ${sub2} ${hook}`,
    ];
    const picked = patterns[Math.floor(seed / 11) % patterns.length] ?? patterns[0];

    // 지역명이 긴 곳(세종특별자치시 …)은 길이 순서대로 한 단계씩 줄인다.
    // 마지막 것은 어떤 지역이 와도 상한을 넘지 않는다.
    for (const candidate of [
      picked,
      `${norm} ${main} ${sub} ${tail} ${count}곳 | ${hook}`,
      `${norm} ${main} ${sub} ${tail} ${count}곳`,
      `${norm} ${main} ${sub} ${tail}`,
    ]) {
      if (candidate.length <= TITLE_MAX) return candidate;
    }
    return `${norm} ${main} ${sub}`;
  }

  const base = `${shortLocation(norm)} ${main}`;
  for (const candidate of [`${base} ${verb} ${count}곳`, `${base} ${verb}`, base]) {
    if (candidate.length <= TITLE_BUDGET) return candidate;
  }
  return base;
}

const DESC_OPENERS = [
  '{location} {main} 업체를 비용·작업범위·후기로 한 번에 비교하세요.',
  '{location} 지역 {main} 업체 조건을 모아 비교해 드립니다.',
  '{location} {main}, 여러 곳에 전화 돌릴 필요 없이 한 번만 접수하세요.',
  '{location} {main} 업체 견적을 나란히 놓고 비교할 수 있습니다.',
] as const;

const DESC_CLOSERS = [
  '{sub} {sub2} 포함 여부까지 확인하고 30초 무료 견적을 받아보세요.',
  '{sub} 비용과 {sub2} 조건을 함께 안내해 드립니다. 상담은 무료입니다.',
  '{sub} 가격대와 AS 조건까지 비교한 뒤 결정하시면 됩니다.',
  '{sub} 및 {sub2} 작업이 가능한 업체만 추려 드립니다. 무료 접수 30초.',
] as const;

export function buildDescription(location: string, main: string, variant: TitleVariant = 'A'): string {
  const norm = normalizeLocation(location);

  if (variant === 'B') {
    const seed = hash(`desc|${location}|${main}`);
    const fill = fillTokens(norm, main);
    const opener = DESC_OPENERS[seed % DESC_OPENERS.length] ?? DESC_OPENERS[0];
    const closer = DESC_CLOSERS[Math.floor(seed / 7) % DESC_CLOSERS.length] ?? DESC_CLOSERS[0];
    return fill(`${opener} ${closer}`);
  }

  const short = shortLocation(norm);
  const candidate = `${short} ${main} 업체를 비용과 후기로 비교하고 무료 견적을 받으세요`;
  return candidate.length <= 45
    ? candidate
    : `${short} ${main} 업체 비교, 무료 견적 신청`;
}

/**
 * 본문 곳곳에 흩뿌릴 문장들.
 *
 * 주변 지역명과 서브 키워드를 본문에 자연스럽게 넣기 위한 것이다. 지역명을
 * 제목에만 넣으면 그 지역 검색어 하나에만 걸리지만, 본문에 인근 동네가 같이
 * 있으면 옆 동네 검색에도 잡힌다. 같은 문장이 30만 장에 그대로 깔리면 역효과라
 * (지역, 키워드) 해시로 표현을 바꾼다.
 *
 * @param nearby pickNearbyLocations 결과. 비어 있어도 동작한다.
 */
export function buildBodyCopy(location: string, main: string, nearby: readonly string[] = []) {
  const norm = normalizeLocation(location);
  const seed = hash(`body|${location}|${main}`);
  const fill = fillTokens(norm, main);

  // 인근 지역은 전부 나열하지 않는다. 문장마다 다른 개수를 쓴다.
  const near = nearby.filter(Boolean);
  const nearList = near.length ? near.join(', ') : norm;
  const nearOne = near[seed % Math.max(1, near.length)] ?? norm;
  const nearTwo = near.slice(0, 2).join('·') || norm;

  const pick = <T,>(pool: readonly T[], salt: number): T => pool[Math.floor(seed / salt) % pool.length] ?? pool[0]!;

  return {
    /** 히어로 아래 리드 문장 */
    lede: fill(pick([
      `{main} 업체를 비용과 조건으로 비교해, {location} 요청하신 내용에 가장 맞는 곳을 연결해 드립니다. 여러 곳에 따로 문의하실 필요 없이 한 번만 접수하시면 됩니다.`,
      `{location}에서 {main} 알아보고 계신가요. {sub} 포함 여부까지 확인해 조건에 맞는 업체만 추려 드립니다. 접수는 30초면 끝납니다.`,
      `혼자 알아보면 시간도 오래 걸리고 가격 비교도 어렵습니다. {location} 방문이 가능한 {main} 업체 견적을 한 번에 모아 비교해 드립니다.`,
      `{location} {main} 업체마다 포함 항목과 금액이 다릅니다. {sub}와 {sub2}까지 같은 기준으로 맞춰 비교해 드립니다.`,
    ], 3)),

    /** 비교 섹션 설명 */
    compareNote: fill(pick([
      `{location} 조건에 맞는 우수 업체를 찾았습니다. 후기와 특징을 비교해보고 견적을 신청하세요.`,
      `{location} 및 ${nearTwo} 지역에 방문 가능한 업체입니다. 조건을 비교한 뒤 선택하시면 됩니다.`,
      `{sub} 작업까지 가능한 곳으로 추렸습니다. 금액과 작업 범위를 나란히 확인해 보세요.`,
      `{location} 지역 담당 업체입니다. 견적과 일정을 비교하고 마음에 드는 곳으로 진행하세요.`,
    ], 5)),

    /** 서비스 지역 안내 문단 */
    areaNote: fill(pick([
      `{location} 지역을 포함하여 ${nearList} 등 인근 동네까지 전담 검증팀이 직접 방문합니다.`,
      `${josa(norm, '은/는')} 물론 ${nearOne} 방면까지 같은 팀이 담당합니다. 경계 지역이라도 방문이 가능한지 확인해 드립니다.`,
      `${josa(norm, '과/와')} ${nearTwo} 일대를 함께 커버합니다. 이사 전후로 두 지역을 오가는 경우에도 한 번에 처리됩니다.`,
      `{location} 중심으로 ${nearList} 범위까지 배정합니다. 위치를 알려주시면 가장 가까운 팀으로 연결해 드립니다.`,
    ], 13)),

    /** 인근 지역 나열 (템플릿에서 굵게 처리) */
    nearbyList: nearList,
    nearbyOne: nearOne,

    /** FAQ 위에 놓을 한 줄 */
    faqNote: fill(pick([
      `{location} {main} 문의에서 가장 많이 나온 질문을 모았습니다.`,
      `{main}${hasFinalConsonant(main) ? '과' : '와'} {sub} 관련해 자주 받는 질문입니다.`,
      `{location} 지역 접수 전에 확인하시면 좋은 내용입니다. {sub} 관련 문의도 함께 담았습니다.`,
      `{main} 견적 비교 전에 많이 물어보시는 항목입니다. {sub2} 조건도 확인해 보세요.`,
    ], 17)),

    /** 내부 링크 섹션 위 한 줄 */
    linksNote: fill(pick([
      `${nearOne} 등 인근 지역과 다른 청소 항목도 함께 확인해 보세요.`,
      `{location} 주변 지역 및 {sub} 관련 페이지입니다.`,
      `가까운 지역의 {main} 정보도 같이 보실 수 있습니다.`,
      `${nearTwo} 방면 및 {sub2} 항목 안내입니다.`,
    ], 19)),

    // ── 아래는 h1/h2 용 소제목 ────────────────────────────────────
    // 검색엔진은 제목 태그의 단어에 더 무게를 둔다. 지역·메인·서브를
    // 소제목마다 다르게 섞어, 어떤 조합으로 검색해도 걸리게 한다.

    /** h1 */
    heroHeading: fill(pick([
      `{location} {main} 업체`,
      `{location} {main} · {sub}`,
      `{location} {sub} {main} 업체`,
      `{location} {main} 전문업체`,
    ], 23)),

    /** 비교 섹션 h2 */
    compareHeading: fill(pick([
      `{location} {main}, 어느 업체가 나에게 맞을까요?`,
      `{location} {sub} 업체 비교, 어디가 나을까요?`,
      `{main}·{sub} 업체를 나란히 비교해 보세요`,
      `{location} {main} 업체 {sub} 조건 비교`,
    ], 29)),

    /** 견적 폼 섹션 h2 */
    formHeading: fill(pick([
      `30초면 끝! {location} {main} 무료 비교 견적 신청`,
      `{location} {sub} 무료 견적 30초 신청`,
      `{main} {sub} 견적, 지금 한 번에 받아보세요`,
      `{location} {main} 견적 비교 신청 (무료)`,
    ], 31)),

    /** 후기 섹션 h2 */
    reviewHeading: fill(pick([
      `{location} 먼저 이용해본 고객들의 이야기`,
      `{location} {main} 이용 후기`,
      `{main}·{sub} 비교하고 진행한 분들의 후기`,
      `{location} {sub} 이용 고객 후기`,
    ], 37)),

    /** 진행 절차 섹션 h2 */
    processHeading: fill(pick([
      `상담부터 완료까지, 5단계로 진행됩니다`,
      `{main} 신청부터 마무리까지 5단계`,
      `{location} {main} 진행 절차 5단계`,
      `{sub}까지 한 번에, 5단계 진행 안내`,
    ], 41)),

    /** 갤러리 섹션 h2 */
    galleryHeading: fill(pick([
      `이런 공간을 이렇게 청소합니다`,
      `{main} 작업 범위 미리 보기`,
      `{location} {main} 시공 사례`,
      `{sub} 포함 작업 예시`,
    ], 43)),

    /** FAQ 섹션 h2 */
    faqHeading: fill(pick([
      `자주 묻는 질문`,
      `{location} {main} 자주 묻는 질문`,
      `{main}·{sub} 관련 자주 묻는 질문`,
      `{location} 접수 전 자주 묻는 질문`,
    ], 47)),

    /** 지역/링크 섹션 h2 */
    areaHeading: fill(pick([
      `{location} 및 인근 지역 서비스 안내`,
      `{location} {main} 서비스 가능 지역`,
      `{location} 주변 지역 {sub} 안내`,
      `{location} 인근 방문 가능 지역`,
    ], 53)),
  };
}

export function buildHeading(location: string, main: string): string {
  const norm = normalizeLocation(location);
  return `${norm} ${main} 업체 비교`;
}

/**
 * FAQ 를 고른다.
 *
 * 주제를 고르는 것으로 끝나지 않고, 주제 안의 질문·답변 변형까지 페이지마다
 * 다르게 뽑는다. 30만 페이지가 같은 문장을 그대로 쓰면 중복 문서로 묶이기
 * 때문이다. 질문과 답변의 변형 번호를 서로 다른 해시로 굴려서, 같은 질문에
 * 늘 같은 답이 붙는 패턴도 생기지 않게 했다.
 */
export function pickFaqs(location: string, main: string, count = 5) {
  const pool = FAQ_POOL;
  const size = pool.length;
  if (size === 0) return [];
  const take = Math.min(count, size);

  const seed = hash(`faq|${location}|${main}`);
  let step = (seed % (size - 1)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const fill = fillTokens(location, main);

  const picked: { q: string; a: string }[] = [];
  for (let i = 0; i < take; i += 1) {
    const topicIndex = (seed + i * step) % size;
    const topic = pool[topicIndex];
    if (!topic) continue;

    const qVariant = topic.q[(seed + topicIndex * 3 + i) % topic.q.length];
    const aVariant = topic.a[(seed + topicIndex * 11 + i * 5) % topic.a.length];
    if (!qVariant || !aVariant) continue;

    picked.push({ q: fill(qVariant), a: fill(aVariant) });
  }
  return picked;
}

/**
 * 콘텐츠 풀의 치환 자리를 채우는 함수를 만든다.
 *
 *   {location}  전체 지역명 (예: 충남 공주 정안면 내문리)
 *   {short}     끝 동/리 이름만 (예: 내문리)
 *   {main}      메인 키워드
 *   {sub}       연관 서브 키워드 1
 *   {sub2}      연관 서브 키워드 2
 *
 * 서브 키워드가 없는 메인(공장청소·기숙사청소)은 메인으로 되돌린다. 빈 문자열이
 * 들어가면 "와 를 같이 되나요?" 같은 문장이 나간다.
 */
function fillTokens(location: string, main: string) {
  const full = normalizeLocation(location);
  const subs = pickSubKeywords(location, main, 2);
  const sub = subs[0] ?? main;
  const sub2 = secondKeyword(location, main, sub);

  return (text: string) => text
    .replaceAll('{location}', full)
    .replaceAll('{short}', lastLocationToken(full))
    .replaceAll('{main}', main)
    .replaceAll('{sub2}', sub2)
    .replaceAll('{sub}', sub);
}

/**
 * 한글 조사 선택.
 *
 * "중예리은 물론" 처럼 받침을 무시하면 바로 티가 난다. 30만 페이지에 깔리는
 * 문장이라 지역명 끝글자를 보고 골라야 한다.
 *
 * 한글 음절은 유니코드에서 (초성×21 + 중성)×28 + 종성 순으로 배열돼 있다.
 * 그래서 (코드 - 0xAC00) % 28 이 0 이 아니면 받침이 있다.
 * 숫자로 끝나는 지명(대성동1가)도 있어서 숫자 발음의 받침까지 본다.
 */
const DIGIT_HAS_FINAL: Record<string, boolean> = {
  // 일(ㄹ) 삼(ㅁ) 육(ㄱ) 칠(ㄹ) 팔(ㄹ) 십(ㅂ) 은 받침 있음, 나머지는 없음
  '0': true, '1': true, '2': false, '3': true, '4': false,
  '5': false, '6': true, '7': true, '8': true, '9': false,
};

export function hasFinalConsonant(word: string): boolean {
  const last = word.trim().slice(-1);
  if (!last) return false;
  if (/[0-9]/.test(last)) return DIGIT_HAS_FINAL[last] ?? false;

  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false; // 한글 음절이 아니면 없는 것으로
  return (code - 0xac00) % 28 !== 0;
}

/** `josa('중예리', '은/는')` -> '중예리는' */
export function josa(word: string, pair: string): string {
  const [withFinal, withoutFinal] = pair.split('/');
  return word + (hasFinalConsonant(word) ? withFinal : withoutFinal);
}

/**
 * 두 번째 연관 키워드.
 *
 * 서브 키워드가 하나뿐인 메인(병원청소·호텔청소·모텔청소·오피스텔청소)은
 * 그냥 두면 {sub} 와 {sub2} 가 같아져서 "병원청소업체 병원청소업체 포함
 * 여부까지" 같은 문장이 나간다. 그럴 때는 다른 메인 키워드를 빌려온다.
 * 어차피 우리가 다 다루는 서비스라 문맥도 맞는다.
 */
function secondKeyword(location: string, main: string, sub: string): string {
  const own = pickSubKeywords(location, main, 2);
  if (own[1] && own[1] !== sub) return own[1];

  const seed = hash(`sub2|${location}|${main}`);
  const size = MAIN_KEYWORDS.length;
  for (let offset = 0; offset < size; offset += 1) {
    const candidate = MAIN_KEYWORDS[(seed + offset) % size];
    if (candidate && candidate !== main && candidate !== sub) return candidate;
  }
  return sub;
}

/**
 * 지역명의 마지막 토큰(동/리/읍/면).
 *
 * shortLocation() 은 쓰지 않는다. 그 함수의 정규식이 `/s+/` 라 공백이 아니라
 * 알파벳 s 로 나뉘고, 한글 지역명에는 s 가 없어 전체 문자열이 그대로 나온다.
 * 이미 배포·색인된 30만 페이지의 title 이 그 동작에 묶여 있어 여기서 고치지
 * 않고, 본문용으로만 제대로 자른 값을 따로 만든다.
 */
function lastLocationToken(location: string): string {
  const parts = location.trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? location;
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
