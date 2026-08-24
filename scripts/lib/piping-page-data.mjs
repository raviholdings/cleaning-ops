/**
 * 배관 페이지 데이터 빌더.
 *
 * 청소/이사에서 검증된 FNV-1a 해시 회전 및 JSON-LD 구조화 데이터 패턴을 따른다.
 * micro-template 과의 호환성을 위해 결측치 없이 모든 토큰을 생성한다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let ADMIN_EXPANSIONS = null;
async function loadAdminExpansions(root) {
  if (!ADMIN_EXPANSIONS) {
    try {
      const mod = await import(pathToFileURL(join(root, 'apps/cleaning-ravi/src/lib/adminDivisions.ts')).href);
      ADMIN_EXPANSIONS = mod.ADMIN_DIVISION_EXPANSIONS || {};
    } catch {
      ADMIN_EXPANSIONS = {};
    }
  }
  return ADMIN_EXPANSIONS;
}

const EXTRA_EXPANSIONS = { 대: '대구' };

export function normalizePipingLocation(raw, expansions = {}) {
  return String(raw)
    .replace(/\([^)]*\)/g, '')
    .replace(/[·.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => EXTRA_EXPANSIONS[token] ?? expansions[token] ?? token)
    .join(' ');
}

export function pathLocation(location) {
  const tokens = String(location).trim().split(/\s+/).filter(Boolean);
  return tokens.slice(-2).join('-');
}

export function lastToken(location) {
  const tokens = String(location).trim().split(/\s+/).filter(Boolean);
  return tokens[tokens.length - 1] || location;
}

export function pipingPagePath(location, mainKeyword) {
  const locSlug = pathLocation(location);
  return `/배관/${locSlug}/${mainKeyword}`;
}

export function pipingPageUrl(siteUrl, location, mainKeyword) {
  const base = String(siteUrl).replace(/\/+$/, '');
  return `${base}${pipingPagePath(location, mainKeyword)}`;
}

function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function pickRotated(list, count, index) {
  const size = list.length;
  if (!size) return [];
  let step = 1 + ((index * 2) % Math.max(1, size - 1));
  while (gcd(step, size) !== 1) step += 1;
  const start = (index * 3) % size;
  const out = [];
  for (let i = 0; i < size && out.length < count; i += 1) {
    const v = list[(start + i * step) % size];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 페이즈 슬롯 표. config.pages.perSitePhase 를 연속 대역으로 편다.
 *   막힘 110장 -> 1..110, 수전 30장 -> 111..140, 누수 60장 -> 141..200
 */
export function phaseSlots(config) {
  const names = config.keywordPhases || ['막힘', '수전', '누수'];
  const per = (config.pages && config.pages.perSitePhase) || {};
  const slots = [];
  let start = 1;
  for (const name of names) {
    const count = Number(per[name] || 0);
    if (count > 0) slots.push({ name, start, end: start + count - 1, count });
    start += count;
  }
  return slots;
}

function slotFor(slots, requestId) {
  for (const slot of slots) if (requestId >= slot.start && requestId <= slot.end) return slot;
  return slots[slots.length - 1];
}

/*
 * (사이트, 페이지) -> (지역, 키워드) 배정. 전역 중복 0 을 보장한다.
 *
 *   키워드 = 슬롯번호 j 로만 정한다 (j < 키워드수 이므로 한 사이트 안에서 안 겹친다)
 *   지역   = (siteIndex * LOC_STRIDE + j * SLOT_STRIDE) % 지역수
 *
 * LOC_STRIDE 가 지역수와 서로소라, 같은 키워드(=같은 j)를 쓰는 사이트들끼리 지역이
 * 절대 겹치지 않는다. j 가 다르면 키워드가 달라 URL 이 다르다. 따라서 (지역, 키워드)
 * 쌍은 20,000 사이트 전체에서 단 한 번만 나온다 — 자체 네트워크 내 중복 콘텐츠 0.
 *
 * 옛 방식((s*31 + r*7), (s*13 + r-1))은 두 식이 같은 r 에 함께 묶여 4.5%(18만 장)가
 * 겹쳤다. 2026-08-24 실측 후 교체.
 */
const LOC_STRIDE = 30011;
const SLOT_STRIDE = 601;

let planChecked = false;
function assertPlan(slots, keywordsData, locationCount) {
  if (planChecked) return;
  if (gcd(LOC_STRIDE, locationCount) !== 1) {
    throw new Error(`LOC_STRIDE(${LOC_STRIDE})가 지역 수(${locationCount})와 서로소가 아니다 — 사이트 간 지역이 겹친다.`);
  }
  for (const slot of slots) {
    const available = (keywordsData.keywords[slot.name] || []).length;
    if (slot.count > available) {
      throw new Error(`${slot.name} 페이즈: 페이지 ${slot.count}장 > 키워드 ${available}개 — 한 사이트 안에서 URL 이 겹친다.`);
    }
  }
  planChecked = true;
}

export function selectLocationKeyword({ siteIndex, requestId, slots, keywordsData, locationCount }) {
  const slot = slotFor(slots, requestId);
  const keywords = keywordsData.keywords[slot.name] || [];
  const j = requestId - slot.start;
  const kwIndex = j % keywords.length;
  return {
    phase: slot.name,
    keywords,
    kwIndex,
    keyword: keywords[kwIndex],
    locIndex: (siteIndex * LOC_STRIDE + j * SLOT_STRIDE) % locationCount,
  };
}

/*
 * 메인 키워드와 같은 계열인 키워드를 우선으로 골라 준다.
 *
 * 키워드에 들어 있는 대상 토큰(싱크대·하수구·화장실…)이 계열을 가른다.
 * 같은 토큰을 가진 것을 앞에, 나머지를 뒤에 두고 결정적으로 회전 선택한다.
 * 예) '하수구막힘' -> 하수도배관청소 · 막힌하수구 · 하수구뚫기 …
 */
const KEYWORD_TOKENS = [
  '싱크대', '씽크대', '개수대', '주방', '화장실', '변기', '소변기', '욕실', '욕조',
  '세면대', '세면기', '세탁기', '세탁실', '하수구', '하수도', '하수관', '배수구',
  '배수관', '배수로', '오수', '정화조', '집수정', '맨홀', '우수', '횡주관', '상수',
  '고압', '내시경', '수도꼭지', '수도', '수전', '샤워', '보일러', '난방', '천장',
  '베란다', '옥상', '지붕', '아파트', '빌라', '상가', '누수', '배관',
];

export function relatedKeywords(mainKeyword, pool, count, seed) {
  const token = KEYWORD_TOKENS.find((t) => mainKeyword.includes(t));
  const rest = pool.filter((k) => k !== mainKeyword);
  const near = token ? rest.filter((k) => k.includes(token)) : [];
  const far = token ? rest.filter((k) => !k.includes(token)) : rest;
  const ordered = [...near, ...far];
  if (!ordered.length) return [];

  const out = [];
  const start = seed % ordered.length;
  // 같은 계열이 충분하면 그 안에서만 회전한다.
  const span = near.length >= count ? near.length : ordered.length;
  for (let i = 0; i < span && out.length < count; i += 1) {
    const item = ordered[(start + i) % span];
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/*
 * 인근 지역 색인. "경기 성남시 분당구 수내2동" -> 같은 구의 다른 동들.
 *
 * 페이지마다 7만 개 지역을 훑으면 400만 장에서 감당이 안 된다. 앞부분(시·구)을 키로
 * 한 번만 색인해 두고 재사용한다.
 */
let NEARBY_INDEX = null;
function nearbyIndex(locations) {
  if (NEARBY_INDEX) return NEARBY_INDEX;
  NEARBY_INDEX = new Map();
  for (const raw of locations) {
    const tokens = String(raw).trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const prefix = tokens.slice(0, -1).join(' ');
    if (!NEARBY_INDEX.has(prefix)) NEARBY_INDEX.set(prefix, []);
    NEARBY_INDEX.get(prefix).push(raw);
  }
  return NEARBY_INDEX;
}

/** 기준 지역과 같은 구에 있는 인근 지역 count 개. 1토큰 지역이면 자기 자신으로 채운다. */
export function nearbyLocations(rawLocation, locations, count, seed) {
  const tokens = String(rawLocation).trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    const siblings = (nearbyIndex(locations).get(tokens.slice(0, -1).join(' ')) || [])
      .filter((l) => l !== rawLocation);
    if (siblings.length) {
      const picked = pickRotated(siblings, count, seed);
      while (picked.length < count) picked.push(picked[picked.length % Math.max(1, picked.length)] || rawLocation);
      return picked;
    }
  }
  return Array.from({ length: count }, () => rawLocation);
}

export function assetBaseForSite(siteUrl, subdomain = 'assets') {
  try {
    const host = new URL(siteUrl).hostname;
    const root = host.split('.').slice(-2).join('.');
    return `https://${subdomain}.${root}`;
  } catch {
    return '';
  }
}

export function loadLocations(projectRoot) {
  const path = join(projectRoot, 'data/locations/rollout-locations.json');
  return JSON.parse(readFileSync(path, 'utf8')).locations;
}

export function loadPipingData(projectRoot) {
  const config = JSON.parse(readFileSync(join(projectRoot, 'config/piping.json'), 'utf8'));
  const keywordsData = JSON.parse(readFileSync(join(projectRoot, 'data/keywords/piping-keywords.json'), 'utf8'));
  const faqData = JSON.parse(readFileSync(join(projectRoot, 'data/piping-faq-pool.json'), 'utf8'));
  return { config, keywordsData, faqData };
}

/**
 * 페이지 한 장의 데이터 컨텍스트 생성.
 */
export async function buildPipingPageData(opts) {
  const {
    projectRoot,
    locations,
    siteIndex = 0,
    requestId = 1,
    siteUrl,
    pageCount = 200,
    naverSiteVerification = '',
    pipingData,
  } = opts;

  const { config, keywordsData, faqData } = pipingData || loadPipingData(projectRoot);
  const expansions = await loadAdminExpansions(projectRoot);

  // 1~2. 페이즈 · 지역 · 키워드 배정 (전역 중복 0 — selectLocationKeyword 주석 참고)
  const slots = phaseSlots(config);
  assertPlan(slots, keywordsData, locations.length);

  const picked = selectLocationKeyword({
    siteIndex, requestId, slots, keywordsData, locationCount: locations.length,
  });
  const currentPhase = picked.phase;
  const phaseKeywords = picked.keywords;
  const allMains = [
    ...(keywordsData.keywords['막힘'] || []),
    ...(keywordsData.keywords['수전'] || []),
    ...(keywordsData.keywords['누수'] || []),
  ];

  const location = normalizePipingLocation(locations[picked.locIndex], expansions);
  const shortLocation = lastToken(location);

  const kwIndex = picked.kwIndex;
  const mainKeyword = picked.keyword;
  const subKw1 = phaseKeywords[(kwIndex + 1) % phaseKeywords.length];
  const subKw2 = phaseKeywords[(kwIndex + 3) % phaseKeywords.length];

  const seed = hash(`piping|${siteUrl}|${requestId}|${location}|${mainKeyword}`);
  const assetBase = opts.assetBase || assetBaseForSite(siteUrl);
  const assetVersion = config.assetVersion || 'piping-v1';
  const canonical = pipingPageUrl(siteUrl, location, mainKeyword);

  // 3. 메타 정보
  const title = `${location} ${mainKeyword} ${subKw1} ${subKw2} 상담 업체 찾기`;
  const description = `${location} ${mainKeyword} 관련 업체를 찾는 사용자를 위해 ${mainKeyword}, ${subKw1}, ${subKw2} 정보를 한 화면에 정리했습니다. 24시간 긴급 출동 및 무료 상담.`;
  const keywords = `${location}, ${mainKeyword}, ${subKw1}, ${subKw2}, 하수구막힘, 수전교체, 누수탐지, 긴급출동`;

  // 4. 본문 헤더 & 요약
  const headline = `${location} ${mainKeyword} ${subKw1} ${subKw2} 상담 업체 찾기`;
  const subheadline = `${location} 인근 ${mainKeyword} 관련 업체들의 위치와 상담 정보를 한 번에 비교해 볼 수 있습니다.`;
  const summaryTitle = `${location} ${mainKeyword} 위치 정보 및 관련 업체 안내`;
  const summaryText = `${location} 일대에서 10개 키워드를 기준으로 검색된 곳은 총 27곳이며, 지도 확인에 참고하기 좋은 주소 카드를 최대 6곳까지 정리했습니다.`;
  const categoryLabel = config.placeCategories[(seed % config.placeCategories.length)] || '건설업>배관,냉난방공사';

  // 5. 상단 스트립 (7개)
  const carouselPool = config.images.carousel;
  const strip = carouselPool.map((c, i) => ({
    src: `${siteUrl}/img/piping/${c.file}`,
    alt: `${location} ${mainKeyword} 상담 이미지 ${i + 1}`,
    label: c.label,
  }));

  /*
   * 6. 플레이스 6장.
   *
   * 첫 장은 이 페이지의 메인 키워드를 그대로 쓰고, 나머지는 같은 계열(메인 키워드와
   * 토큰을 공유하는) 키워드를 우선 배치한다. 전 업종 키워드에서 아무거나 뽑으면
   * '하수구막힘' 페이지에 '수전교체'가 붙어 문맥이 어긋난다.
   * 업체명(…상담센터)은 붙이지 않는다 — 운영자 확정 2026-08-24.
   */
  /*
   * 6. 플레이스 6장 — 제목은 "지역명 + 메인키워드 2개 + 서브키워드 2개" (운영자 확정).
   *
   *   지역명      : 같은 구의 인근 동으로 분산 (카드마다 다른 동네 = 다른 업체처럼 보인다)
   *   메인키워드 2 : 이 페이지의 메인 + 같은 계열 1개 — 문맥을 잡는다
   *   서브키워드 2 : 페이즈 풀 전체에서 흩어 뽑는다 — 계열에서만 뽑으면 후보가
   *                 9~15개뿐이라 같은 말이 6줄 반복된다
   */
  const placeCategories = config.placeCategories;
  const mainPartners = relatedKeywords(mainKeyword, phaseKeywords, 6, seed);
  const subPool = phaseKeywords.filter((k) => k !== mainKeyword && !mainPartners.includes(k));
  const subs = pickRotated(subPool, 12, seed);
  const spots = nearbyLocations(locations[picked.locIndex], locations, 6, seed);

  const places = Array.from({ length: 6 }, (_, i) => {
    const spotFull = normalizePipingLocation(spots[i], expansions);
    const spot = lastToken(spotFull);
    const main2 = mainPartners[i % mainPartners.length] || mainKeyword;
    const sub1 = subs[(i * 2) % subs.length];
    const sub2 = subs[(i * 2 + 1) % subs.length];
    return {
      rank: i + 1,
      name: `${spot} ${mainKeyword} ${main2} ${sub1} ${sub2}`,
      category: placeCategories[(seed + i) % placeCategories.length],
      address: spotFull,
      keywordText: `#${mainKeyword} #${main2} #긴급출동`,
      desc: `${spot} 일대 ${sub1} 문의와 ${mainKeyword} 현장 점검을 함께 확인할 수 있습니다.`,
      naverMap: `https://map.naver.com/v5/search/${encodeURIComponent(`${spotFull} ${main2} 업체`)}`,
      googleMap: `https://www.google.com/maps/search/${encodeURIComponent(`${spotFull} ${main2}`)}`,
    };
  });

  // 7. 프로모 배너 (누르면 전화 연결). 업체명은 넣지 않는다 — 운영자 확정.
  const promoBanners = [
    {
      src: `${siteUrl}/img/piping/${config.images.promo}`,
      alt: `${shortLocation} 하수구 막힘 변기 막힘 싱크대 막힘 24시간 신속 출동`,
      wide: true,
    },
  ];

  // 8. FAQ (4개 선택 - 첫 번째 블록은 고정, 나머지 3개 회전)
  const allBlocks = faqData.blocks || [];
  const combinedBlocks = allBlocks.filter((b) => b.phase === currentPhase || b.phase === '공통');
  const restIndices = combinedBlocks.map((_, idx) => idx).filter((idx) => idx !== 0);
  const pickedIndices = [
    0,
    ...pickRotated(restIndices, 3, seed % Math.max(1, restIndices.length)),
  ];

  const faqs = pickedIndices.map((bIdx, i) => {
    const blk = combinedBlocks[bIdx] || combinedBlocks[0];
    const fill = (t) => t.replace(/\{location\}/g, location).replace(/\{shortLocation\}/g, shortLocation).replace(/\{main\}/g, mainKeyword);
    const qList = blk.q || [];
    const aList = blk.a || [];
    return {
      q: fill(qList[(seed + i * 7) % qList.length] || ''),
      a: fill(aList[(seed + i * 11) % aList.length] || ''),
    };
  });

  // 9. 페이지네이션 (10개)
  // 링크 대상 페이지도 같은 배정 함수로 계산한다. 페이즈가 다른 페이지를 현재
  // 페이즈 키워드로 링크하면 없는 URL 이 나온다 (2026-08-24 실측 2.8% 깨짐).
  const linkTo = (pageNum) => {
    const t = selectLocationKeyword({
      siteIndex, requestId: pageNum, slots, keywordsData, locationCount: locations.length,
    });
    return pipingPagePath(normalizePipingLocation(locations[t.locIndex], expansions), t.keyword);
  };

  const windowSize = 10;
  const startPage = Math.max(1, Math.min(requestId - 4, pageCount - windowSize + 1));
  const pager = Array.from({ length: Math.min(windowSize, pageCount) }, (_, i) => {
    const pageNum = startPage + i;
    const isCur = pageNum === requestId;
    return {
      href: linkTo(pageNum),
      label: String(pageNum),
      activeClass: isCur ? ' active' : '',
      isActive: isCur,
    };
  });

  const nextTarget = Math.min(pageCount, startPage + windowSize);
  const pagerNext = { href: linkTo(nextTarget), label: 'Next 10' };

  // 10. 하단 썸네일 (7개)
  const thumbs = carouselPool.map((c, i) => ({
    src: `${siteUrl}/img/piping/${c.file}`,
    alt: `${location} ${mainKeyword} 현장 사진 ${i + 1}`,
  }));

  // 11. 하단 리소스 링크 (4개)
  const resourceTitles = [
    '욕실 하수구 악취 해결 상담 안내',
    '화장실 물내림 불량과 배관 흐름 점검',
    '변기막힘 비용 문의와 현장 상황 상담',
    '배관 장비 투입이 필요한 막힘 상담',
  ];
  const resources = resourceTitles.map((rt, i) => ({
    thumb: `${siteUrl}/img/piping/${carouselPool[(i + 1) % carouselPool.length].file}`,
    title: rt,
  }));

  // 12. 구조화 데이터 JSON-LD
  const locTokens = location.split(' ').filter(Boolean);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: locTokens[0] || '전국', item: siteUrl },
          { '@type': 'ListItem', position: 2, name: locTokens.slice(0, 2).join(' '), item: canonical },
          { '@type': 'ListItem', position: 3, name: `${shortLocation} ${mainKeyword}`, item: canonical },
        ],
      },
      {
        '@type': 'Service',
        name: `${location} ${mainKeyword} 긴급출동`,
        serviceType: '배관설비공사',
        provider: { '@type': 'LocalBusiness', name: `${location} ${mainKeyword}`, telephone: config.phone },
        areaServed: { '@type': 'AdministrativeArea', name: location },
      },
      {
        '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  /*
   * 네이버 검색결과 이미지 리스트(캐러셀)용 독립 블록.
   *
   * 배관 페이지에는 캐러셀 위젯이 없다 — 검색결과 노출은 전적으로 이 블록이 맡는다.
   * 청소·이사에서 실측 검증한 요건을 그대로 지킨다.
   *   · @graph 밖 독립 스크립트 블록, 페이지당 ItemList 는 이 하나뿐
   *   · image 필수 · url 절대경로 · 이미지는 same-origin(/img/piping/)
   *   · ImageObject 로 폭·높이를 정확히 적는다 (로봇이 크기를 보고 후보를 고른다.
   *     참고 페이지의 450x450 을 그대로 베끼면 실제 1254x1254 와 어긋나 후보에서
   *     빠질 수 있어 config 의 실측값을 쓴다)
   *   · 여기 적은 이미지는 모두 본문에도 실제로 존재해야 한다 (스트립·썸네일에 있음)
   * 대표 이미지 한 장으로 고정되지 않도록 og:image 는 두지 않는다.
   */
  const itemListJson = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: carouselPool.map((c, i) => {
      const src = `${siteUrl}/img/piping/${c.file}`;
      const caption = `${location} ${mainKeyword} ${c.label}`;
      return {
        '@type': 'ListItem',
        position: i + 1,
        name: caption,
        image: src,
        url: canonical,
        item: {
          '@type': 'ImageObject',
          url: src,
          contentUrl: src,
          name: caption,
          caption,
          width: c.width || 1254,
          height: c.height || 1254,
        },
      };
    }),
  };

  const pagePath = pipingPagePath(location, mainKeyword);
  const filePath = `배관/${pathLocation(location)}/${mainKeyword}.html`;

  return {
    title,
    description,
    keywords,
    canonical,
    naverSiteVerification,
    rssHref: '',
    sitemapHref: '',
    assetBase,
    assetVersion,
    location,
    shortLocation,
    mainKeyword,
    headline,
    subheadline,
    leadApi: config.leadApi,
    leadProject: config.leadProject,
    heroImage: {
      src: `${siteUrl}/img/piping/${config.images.hero}`,
      alt: `${location} ${mainKeyword} 24시간 긴급출동 상담 안내`,
    },
    summaryTitle,
    summaryText,
    categoryLabel,
    strip,
    places,
    promoBanners,
    faqs,
    pager,
    pagerNext,
    thumbs,
    resources,
    jsonLd: JSON.stringify(jsonLd),
    itemListJson: JSON.stringify(itemListJson),
    pagePath,
    filePath,
  };
}
