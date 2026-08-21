/**
 * 이사 페이지 한 장에 들어갈 값을 전부 만든다.
 *
 * 청소의 merged-page-data.mjs 와 같은 역할이다. 따로 둔 이유는 하나다 —
 * 청소 파일을 고치면 이미 나가 있는 131만 장이 같이 흔들린다. 업체 수,
 * 플레이스 분류, 캐러셀 기준이 서로 달라 분기가 계속 늘어나므로 나눈다.
 *
 * micro-template 은 strict 라, 템플릿이 쓰는 이름이 여기 없으면 렌더 중
 * 던진다. 템플릿에 변수를 넣기 전에 이 파일부터 고쳐야 한다.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const appLib = (root) => join(root, 'apps/moving-ravi/src/lib');
const importLib = (root, file) => import(pathToFileURL(join(appLib(root), file)).href);

/**
 * 지역명 정규화. 한자 병기 제거 + 축약 행정구역 복원.
 *
 * 지역 풀은 "대전 서구 기성동"과 "대전 서 기성동" 같은 축약 변형을 별개
 * 항목으로 담고 있다. 청소는 표시 직전에 adminDivisions 복원표로 펴는데,
 * 이사를 만들 때 이 단계를 빠뜨려 "/이사/서-기성동/…" 같은 주소가 나갔다
 * (2026-08-20, 50만 장 중 URL 오염 22,326장).
 *
 * 청소의 normalizeLocation 은 가운데 토큰만 펴지만, 이사는 지역명이 URL이
 * 되므로 "서 기성동"(첫 토큰), "부산시 북"(끝 토큰)도 펴야 한다. 복원표에
 * 있는 토큰은 위치와 무관하게 전부 편다 — 복원표 키는 축약형뿐이라 정식
 * 명칭을 잘못 건드릴 일이 없다. 펴서 변형이 합쳐져도 한 사이트 안 경로
 * 충돌은 0건임을 전수 확인했다.
 */
let ADMIN_EXPANSIONS = null;
async function loadAdminExpansions(root) {
  if (!ADMIN_EXPANSIONS) {
    const mod = await import(pathToFileURL(join(root, 'apps/cleaning-ravi/src/lib/adminDivisions.ts')).href);
    ADMIN_EXPANSIONS = mod.ADMIN_DIVISION_EXPANSIONS;
  }
  return ADMIN_EXPANSIONS;
}
function normalizeMovingLocation(raw, expansions) {
  return String(raw)
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => expansions[token] ?? token)
    .join(' ');
}

/** 업체 5곳. 순서·링크·이미지는 운영자가 확정한 값이다. */
export const VENDORS = [
  { name: '이사타임', link: 'https://replyalba.com/pt/DpJPm14nB5', image: 'compare1.webp',
    stars: '★★★★★', rating: '4.9', reviews: '2,150+',
    feats: ['출발·도착지 입력만으로 실시간 견적 비교', '포장·반포장·원룸이사 전 항목 신청 가능'] },
  { name: '포장이사 24번가', link: 'https://replyalba.com/pt/ELDSfIhN3C', image: 'compare2.webp',
    stars: '★★★★★', rating: '4.7', reviews: '980+',
    feats: ['숙련된 포장 인력과 파손 보상 시스템', '사다리차·엘리베이터 이사 모두 대응'] },
  { name: '다이사', link: 'https://replyalba.com/pt/TvEscQQdOx', image: 'compare3.webp',
    stars: '★★★★★', rating: '4.7', reviews: '1,560+',
    feats: ['국내 최다 이사업체 네트워크 보유', '원룸부터 사무실까지 규모별 매칭'] },
  { name: '서경석의 이사방', link: 'https://replyalba.com/pt/10OydhStxiu', image: 'compare4.webp',
    stars: '★★★★★', rating: '4.8', reviews: '2,780+',
    feats: ['전담 매니저 1:1 이사 컨설팅', '포장·보관·폐기물까지 통합 진행'] },
  { name: '모두이사', link: 'https://replyalba.com/pt/H4VMTQ4Rha', image: 'compare5.webp',
    stars: '★★★★★', rating: '4.9', reviews: '870+',
    feats: ['이사 국내 최대 플랫폼, 업체 1~3곳 가격 비교', '이사·청소 24시간 온라인 접수 가능'] },
];

/**
 * 플레이스 블록의 업종 분류.
 *
 * 네이버 플레이스의 실제 분류에는 '이사-일반', '포장이사-일반' 둘뿐이라
 * 그것만 쓰면 5블록이 전부 같아진다. 운영자가 고른 4종을 돌려 쓴다.
 */
export const PLACE_CATEGORIES = [
  '지원,대행>이사',
  '지원,대행>포장이사',
  '화물운송>화물운송',
  '화물운송>용달',
];

const PLACE_COUNT = 5;
const GALLERY_COUNT = 9;

/**
 * 이미지 저장소. 25종 × 20장 = 500장.
 *
 * 순서가 R2 에 올라간 파일 이름과 정확히 같아야 한다. 파일명이 곧
 * "001_포장이사_01" 처럼 유형을 품고 있어서, 목록이 어긋나면 없는 이름을
 * 만들어 404 가 난다.
 *
 * 처음엔 손으로 적었다가 학교이전·병원이전·공장이전 셋을 빠뜨렸다. 그
 * 뒤가 전부 20씩 밀려 399번을 '주말이사' 로 계산했는데 실제 파일은
 * '일반이사' 였다. 바꿀 일이 있으면 renamed/ 폴더에서 다시 뽑아 맞출 것.
 */
const GALLERY = {
  ext: 'webp',
  types: ['포장이사', '원룸이사', '가정이사', '사무실이사', '소형이사',
    '신혼이사', '장거리이사', '지방이사', '보관이사', '용달이사',
    '기업이전', '상가이전', '학교이전', '병원이전', '공장이전',
    '아파트이사', '빌라이사', '오피스텔이사', '반포장이사', '일반이사',
    '긴급이사', '당일이사', '주말이사', '가구이전', '안심이사'],
  perType: 20,
};
const POOL_SIZE = 500;

const IMAGE_DIR = String(process.env.PUBLIC_MOVING_IMAGE_DIR || 'moving');
const ASSET_VERSION = String(process.env.PUBLIC_MOVING_ASSET_VERSION || 'moving-v3');
const ASSET_SUBDOMAIN = String(process.env.PUBLIC_ASSET_SUBDOMAIN || 'assets');

/** 사이트 URL -> 그 사이트가 쓸 자산 베이스 (https://assets.<루트>) */
export function assetBaseForSite(siteUrl) {
  try {
    const host = new URL(siteUrl).hostname;
    const root = host.split('.').slice(-2).join('.');
    return `https://${ASSET_SUBDOMAIN}.${root}`;
  } catch {
    return '';
  }
}

function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const pad = (n, w) => String(n).padStart(w, '0');
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** 전체순번(1~500) -> 파일 이름 (001_포장이사_01) */
function imageName(serial) {
  const i = ((serial - 1) % POOL_SIZE + POOL_SIZE) % POOL_SIZE;
  const type = GALLERY.types[Math.floor(i / GALLERY.perType)] || GALLERY.types[0];
  return `${pad(i + 1, 3)}_${type}_${pad((i % GALLERY.perType) + 1, 2)}`;
}

/** 겹치지 않게 count 장을 고른다. 시드가 같으면 항상 같은 결과. */
function pickImages(seed, count) {
  let step = (seed % (POOL_SIZE - 1)) + 1;
  while (gcd(step, POOL_SIZE) !== 1) step += 1;
  return Array.from({ length: count }, (_, i) => imageName(((seed + i * step) % POOL_SIZE) + 1));
}

/** list 에서 index 마다 다른 시작점·보폭으로 count 개를 뽑는다. */
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
 * 페이지 한 장의 데이터.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot  레포 루트
 * @param {string} opts.siteUrl      https://호스트
 * @param {number} opts.siteIndex    0-based
 * @param {number} opts.requestId    1-based
 * @param {string[]} opts.locations
 * @param {object} opts.lib          미리 import 해 둔 앱 lib (없으면 여기서 부른다)
 * @param {string} opts.naverSiteVerification
 */
export async function buildMovingPageData(opts) {
  const root = opts.projectRoot;
  const lib = opts.lib || {
    catalog: await importLib(root, 'pageCatalog.ts'),
    keywords: await importLib(root, 'keywords.ts'),
    meta: await importLib(root, 'pageMeta.ts'),
    path: await importLib(root, 'pagePath.ts'),
    content: await importLib(root, 'content.ts'),
  };

  const { locations, siteIndex, requestId, siteUrl } = opts;
  const entry = lib.catalog.catalogEntry({ locations, siteIndex, requestId });

  // 표시용 지역명. 줄임말을 펴고 한자 병기를 걷는다.
  const expansions = await loadAdminExpansions(root);
  const rawLocation = entry.location;
  const location = normalizeMovingLocation(rawLocation, expansions);
  const main = entry.mainKeyword;
  const short = lib.meta.lastToken(location);
  const subs = lib.keywords.subKeywordsFor(main);
  const seed = hash(`moving|${siteUrl}|${requestId}|${main}`);

  const base = opts.assetBase || assetBaseForSite(siteUrl);
  const canonical = lib.path.movingPageUrl(siteUrl, location, main);

  const vendorCount = VENDORS.length;
  const title = lib.meta.buildTitle(location, main, vendorCount);
  const description = lib.meta.buildDescription(location, main, vendorCount, subs);

  // ── 갤러리 (화면 캐러셀) ─────────────────────────────────
  const gallery = pickImages(seed, GALLERY_COUNT).map((name, i) => ({
    src: `${base}/${IMAGE_DIR}/${encodeURIComponent(name)}.${GALLERY.ext}`,
    alt: `${short} ${main} 시공 ${i + 1}`,
    title: `${short} ${main} 시공`,
    activeClass: i === 0 ? ' active' : '',
  }));

  // ── 업체 (화면 카드 + 구조화 데이터 ItemList) ─────────────
  const vendors = VENDORS.map((v, i) => ({
    ...v,
    num: i + 1,
    bestClass: i === 0 ? ' best' : '',
    // micro-template 의 {{#isBest}} 는 값이 있을 때만 블록을 그린다.
    isBest: i === 0 ? [{}] : [],
    image: `${base}/${IMAGE_DIR}/${v.image}`,
    feat1: v.feats[0],
    feat2: v.feats[1],
  }));

  // ── 플레이스 5블록 ────────────────────────────────────────
  const mains = lib.keywords.MAIN_KEYWORDS;
  const descPool = lib.content.PLACE_DESC_POOL;
  const places = Array.from({ length: PLACE_COUNT }, (_, i) => {
    const k1 = mains[(seed + i * 3) % mains.length];
    const k2 = mains[(seed + i * 3 + 7) % mains.length];
    const k3 = mains[(seed + i * 3 + 13) % mains.length];
    return {
      rank: i + 1,
      name: `${short} 지역 ${k1} ${k2}`,
      category: PLACE_CATEGORIES[(seed + i) % PLACE_CATEGORIES.length],
      address: `${location} ${((seed + i * 37) % 900) + 100}`,
      keywordText: [k1, k2, k3].join(' '),
      desc: descPool[(seed + i * 3) % descPool.length]
        .replace(/\{kw1\}/g, k1).replace(/\{kw2\}/g, k2),
      naverMap: `https://map.naver.com/p/search/${encodeURIComponent(`${short} ${k1}`)}`,
      googleMap: `https://www.google.com/maps/search/${encodeURIComponent(`${short} ${k1}`)}`,
    };
  });

  // ── FAQ. 첫 블록은 항상 맨 앞 (운영자 지시) ───────────────
  const pool = lib.content.FAQ_POOL;
  const pinned = lib.content.FAQ_PINNED_INDEX ?? 0;
  const rest = pool.map((_, i) => i).filter((i) => i !== pinned);
  const order = [pinned, ...pickRotated(rest, 4, seed % Math.max(1, rest.length))];
  const faqs = order.map((bi, i) => {
    const blk = pool[bi];
    const fill = (t) => t.replace(/\{location\}/g, location).replace(/\{main\}/g, main);
    return {
      q: fill(blk.q[(seed + i * 5) % blk.q.length]),
      a: fill(blk.a[(seed + i * 7) % blk.a.length]),
    };
  });

  // ── 후기 3개 ──────────────────────────────────────────────
  const { REVIEW_AUTHORS: A, REVIEW_SERVICES: S, REVIEW_TEXTS: T } = lib.content;
  const reviews = Array.from({ length: 3 }, (_, i) => ({
    stars: '★★★★★',
    text: T[(seed + i * 11) % T.length],
    author: A[(seed + i * 13) % A.length],
    service: S[(seed + i * 17) % S.length],
  }));

  // ── 해시태그 (연관 검색어) ────────────────────────────────
  const related = pickRotated([...subs, ...mains.filter((m) => m !== main)], 8, seed % 7)
    .map((word) => ({ word }));

  // ── 인근 지역 링크 + 이전/다음 ────────────────────────────
  const linkIds = Array.from({ length: 15 }, (_, i) => i + 1)
    .map((o) => ((requestId - 1 + o * 7) % opts.pageCount) + 1)
    .filter((id) => id !== requestId)
    .slice(0, 10);
  const linkTo = (id) => {
    const e = lib.catalog.catalogEntry({ locations, siteIndex, requestId: id });
    const loc = normalizeMovingLocation(e.location, expansions);
    return {
      href: lib.path.movingPagePath(loc, e.mainKeyword),
      label: `${lib.meta.lastToken(loc)} ${e.mainKeyword}`,
    };
  };
  const links = linkIds.map(linkTo);
  const prevId = requestId === 1 ? opts.pageCount : requestId - 1;
  const nextId = requestId === opts.pageCount ? 1 : requestId + 1;

  // ── 구조화 데이터 ─────────────────────────────────────────
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: title,
        description, isPartOf: { '@id': `${siteUrl}/#website` },
        primaryImageOfPage: { '@id': `${canonical}#primaryimage` },
        image: { '@id': `${canonical}#primaryimage` },
        thumbnailUrl: gallery[0].src,
        breadcrumb: { '@id': `${canonical}#breadcrumb` }, inLanguage: 'ko-KR' },
      { '@type': 'ImageObject', '@id': `${canonical}#primaryimage`, inLanguage: 'ko-KR',
        url: gallery[0].src, contentUrl: gallery[0].src, caption: gallery[0].alt },
      // 네이버 가이드: "홈" 같은 일반 단어를 쓰지 말고 넓은 범위 -> 구체적 순서로.
      { '@type': 'BreadcrumbList', '@id': `${canonical}#breadcrumb`, itemListElement: [
        { '@type': 'ListItem', position: 1,
          item: { '@id': `${siteUrl}${lib.path.movingPagePath(location, main).split('/').slice(0, 3).join('/')}`, name: lib.path.pathLocation(location) } },
        { '@type': 'ListItem', position: 2, item: { '@id': canonical, name: main } },
      ] },
      /*
       * 캐러셀. 업체 5곳을 항목으로 넣는다.
       * image 필수 · 썸네일 말고 원본 · 로고 금지 · url 은 절대 경로 ·
       * 한 페이지에 ItemList 는 하나. 전부 네이버 가이드 그대로다.
       */
      { '@type': 'ItemList', '@id': `${canonical}#carousel`,
        itemListElement: vendors.map((v, i) => ({
          '@type': 'ListItem', position: String(i + 1),
          name: v.name, image: v.image, url: v.link })) },
      { '@type': 'Service', '@id': `${canonical}#service`, serviceType: main,
        name: `${location} ${main}`, description, url: canonical,
        areaServed: { '@type': 'AdministrativeArea', name: location },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', bestRating: '5',
          ratingCount: '2150', reviewCount: '2150' } },
      { '@type': 'FAQPage', '@id': `${canonical}#faq`, mainEntity: faqs.map((f) => ({
        '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
      { '@type': 'Organization', '@id': `${siteUrl}/#organization`, name: '이사프렌즈', url: siteUrl },
      { '@type': 'WebSite', '@id': `${siteUrl}/#website`, url: siteUrl, name: '이사프렌즈',
        publisher: { '@id': `${siteUrl}/#organization` }, inLanguage: 'ko-KR' },
    ],
  };

  return {
    // 사이트 공통
    siteUrl,
    assetBase: base,
    assetVersion: ASSET_VERSION,
    naverSiteVerification: opts.naverSiteVerification || '',
    form: {
      src: 'https://replyalba.com/intros/_frm/index.php?code=H4VMTQ4Rha',
      jquery: 'https://replyalba.com/js/jquery-1.11.0.min.js',
      iframeResizer: 'https://replyalba.com/js/iframeResizer.min.js',
    },

    // 이 페이지
    pageId: requestId,
    pagePath: lib.path.movingPagePath(location, main),
    filePath: lib.path.movingFilePath(location, main),
    canonical,
    title,
    description,
    location,
    shortLocation: short,
    mainKeyword: main,
    mainKeywordText: [main, subs[0]].filter(Boolean).join(' '),
    subKeywordText: subs.slice(1, 3).join(' ') || main,
    vendorCount,
    vendors,
    places,
    gallery: { count: gallery.length, first: gallery[0], items: gallery },
    faqs,
    reviews,
    related,
    links,
    nearbyCount: links.length,
    prev: linkTo(prevId),
    next: linkTo(nextId),
    jsonLd: JSON.stringify(jsonLd),
  };
}

export function loadLocations(projectRoot) {
  const path = join(projectRoot, 'data/locations/rollout-locations.json');
  return JSON.parse(readFileSync(path, 'utf8')).locations;
}

/**
 * 한 사이트의 이사 사이트맵 <loc> 목록을 로컬에서 생성한다.
 *
 * 배포 사이트맵과 같은 파이프라인(catalogEntry -> 복원 -> movingPagePath ->
 * encodeURI)이라 문자 그대로 일치한다. one-qfast.com 처럼 국내망에서
 * Cloudflare 엣지 IP 가 막혀 사이트맵 fetch 가 안 되는 호스트의 수집요청
 * 폴백으로 쓴다 (2026-08-21 — 계정마다 one-qfast 10호스트가 스킵되던 원인).
 */
export async function movingSitemapUrlsForSite({ projectRoot, lib, locations, siteIndex, siteUrl, pageCount }) {
  const expansions = await loadAdminExpansions(projectRoot);
  const count = Number(pageCount) || lib.catalog.PAGE_COUNT;
  const urls = [];
  for (let requestId = 1; requestId <= count; requestId += 1) {
    const entry = lib.catalog.catalogEntry({ locations, siteIndex, requestId });
    const location = normalizeMovingLocation(entry.location, expansions);
    urls.push(`${siteUrl}${encodeURI(lib.path.movingPagePath(location, entry.mainKeyword))}`);
  }
  return urls;
}

export async function loadMovingLib(projectRoot) {
  return {
    catalog: await importLib(projectRoot, 'pageCatalog.ts'),
    keywords: await importLib(projectRoot, 'keywords.ts'),
    meta: await importLib(projectRoot, 'pageMeta.ts'),
    path: await importLib(projectRoot, 'pagePath.ts'),
    content: await importLib(projectRoot, 'content.ts'),
  };
}
