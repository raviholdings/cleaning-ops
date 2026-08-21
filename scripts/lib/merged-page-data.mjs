/**
 * templates-merged/page.html 이 쓰는 추가 데이터.
 *
 * 기존 buildPageData() 는 건드리지 않는다. 이 모듈이 그 결과를 받아 places /
 * gallery / 몇 가지 파생 문자열만 얹어서 돌려준다. 원본 렌더러와 원본 템플릿은
 * 그대로 두고, 새 템플릿을 쓸 때만 이 래퍼를 끼우는 구조다.
 *
 * micro-template 은 strict 라 템플릿이 쓰는 이름이 여기 없으면 렌더 중 던진다.
 * 새 변수를 템플릿에 넣기 전에 반드시 이 파일부터 고쳐야 한다.
 */

/**
 * 네이버 플레이스 분류. 상위(서비스,산업>지원,대행)는 빼고 '청소' 부터 적는다.
 * 레거시(keyword_ranking)의 CATEGORIES 와 같은 형태다:
 *   apps/bbungbbung-piping/src/site.mjs:313
 *   apps/watermelon-piping/src/lib/view.ts:86
 */
export const CLEANING_CATEGORIES = [
  '청소',
  '청소>간판',
  '청소>건물,빌딩',
  '청소>아파트청소',
  '청소>닥트클리닝',
  '청소>카페트,소파',
  '청소>컴퓨터',
  '청소>홈크리닝',
  '청소>종합대행업체>종합대행업체-일반',
];

/** 플레이스 블록 개수. 카테고리(9개)와 달라도 된다. */
export const PLACE_COUNT = 5;

/** 한 블록의 <b> 안에 넣을 연관 키워드 개수. */
const KEYWORDS_PER_PLACE = 7;

/**
 * 키워드 -> 네이버 업종 분류.
 *
 * 판정 규칙과 순서는 scripts/lib/keywords.ts 의 naverCategoryFor() 와 같다.
 * 다만 문자열은 상위(서비스,산업 > 지원,대행)를 빼고 공백 없이 내보낸다.
 *
 * ※ 규칙을 그 파일에서 import 하지 않고 옮겨 적은 이유: keywords.ts 는 아직
 *   커밋 안 된 작업본이고, 거기 상수는 상위를 포함한 긴 형식이라 지시받은
 *   형식과 다르다. 형식이 확정되면 한쪽으로 합칠 것.
 */
/**
 * 어느 규칙에도 안 걸리는 키워드에 회전 배정할 분류.
 *
 * 키워드 73개를 naverCategoryFor 규칙에 태우면 9개 중 3개(간판·닥트클리닝·컴퓨터)가
 * 한 번도 안 나온다. 해당 업종 키워드가 아예 없기 때문이다. 그래서 규칙 미매칭분은
 * 기본값 '청소' 하나로 몰지 않고 이 4개를 레거시식으로 돌려 쓴다.
 */
const FALLBACK_CATEGORIES = [
  '청소',
  '청소>간판',
  '청소>닥트클리닝',
  '청소>컴퓨터',
];

/**
 * @param {string} keyword  이 블록이 노리는 키워드
 * @param {number} rotation 미매칭일 때 쓸 회전값. 레거시와 같게 (pageId + blockIndex).
 */
export function categoryFor(keyword, rotation = 0) {
  const main = String(keyword || '');

  // 네이버 업종 분류는 '장소' 기준이다. '입주/이사/준공' 은 작업 종류라 아파트에도
  // 사무실에도 원룸에도 붙는다. 그래서 장소 토큰을 먼저 본다.
  //
  // keywords.ts 의 naverCategoryFor() 는 순서가 반대라 '사무실입주청소' 가
  // '입주' 에 먼저 걸려 아파트청소로 샌다. 여기서는 순서를 바로잡았다.
  //   아파트    : '아파트준공청소' 가 아래 준공 규칙으로 새지 않도록 맨 앞
  //   건물 계열  : 작업 종류(입주/이사)보다 앞
  //   주거 계열  : 원룸/오피스텔이 '입주' 로 새지 않도록 앞
  //   입주      : 장소가 안 붙은 것만 남는다
  if (main.includes('아파트')) return '청소>아파트청소';
  if (
    main.includes('건물') || main.includes('사무실') || main.includes('준공') || main.includes('상가')
    || main.includes('공장') || main.includes('기숙사') || main.includes('병원') || main.includes('호텔')
    || main.includes('모텔')
  ) {
    return '청소>건물,빌딩';
  }
  if (
    main.includes('집청소') || main.includes('가정') || main.includes('원룸')
    || main.includes('오피스텔') || main.includes('이사')
  ) {
    return '청소>홈크리닝';
  }
  if (main.includes('입주')) return '청소>아파트청소';
  if (main.includes('용역')) return '청소>종합대행업체>종합대행업체-일반';
  if (main.includes('화장실')) return '청소>카페트,소파';
  return FALLBACK_CATEGORIES[Math.abs(Math.trunc(rotation)) % FALLBACK_CATEGORIES.length];
}

/**
 * 이미지 저장소. apps/cleaning-ravi/public/cleaning/ 에 webp 500장이 있고,
 * 빌드하면 /cleaning/... 로 서빙된다.
 *
 * 파일명 = {전체순번 3자리}_{공간명}_{공간별순번 2자리}.webp
 * 공간 10곳 × 각 50장. 순번 구간은 아래 ROOMS 순서 그대로다
 * (거실 001-050, 주방 051-100, … 전문도구 451-500).
 */
/**
 * 이미지를 어디서 받아올지.
 *
 * 파일은 R2 버킷 한 곳에만 올리고, 루트 도메인마다 커스텀 도메인을 붙여 같은
 * 버킷을 가리킨다. 그래서 사이트는 항상 '자기 루트 도메인'에서 이미지를 받는다.
 *
 *   amunsa.com 계열   -> https://assets.amunsa.com/cleaning/...
 *   uloung.com 계열   -> https://assets.uloung.com/cleaning/...
 *
 * 10,000개 사이트가 자산 도메인 하나를 공유하면 그 문자열 하나로 루트 10개가
 * 한 운영자로 묶인다. 루트별로 나누면 그 연결이 안 생기고, 한 도메인이 죽어도
 * 나머지 루트는 멀쩡하다. 업로드는 여전히 한 번이다.
 *
 * 우선순위: 호출 시 넘긴 assetBase > PUBLIC_ASSET_BASE_URL > 상대경로('/cleaning')
 */
const ENV_ASSET_BASE = String(process.env.PUBLIC_ASSET_BASE_URL || '').replace(/\/+$/, '');

/** 자산 서브도메인 이름. 바꾸려면 PUBLIC_ASSET_SUBDOMAIN 으로 준다. */
const ASSET_SUBDOMAIN = String(process.env.PUBLIC_ASSET_SUBDOMAIN || 'assets');

/**
 * CSS·JS 를 올려둔 경로의 버전.
 *
 * 고정 이름(styles.css)으로 두면 내용을 고쳐도 Cloudflare 와 브라우저 캐시에
 * 옛 파일이 남아 새 페이지와 섞인다. 버전 폴더로 올리고 템플릿이 그 경로를
 * 가리키게 하면, 다음 배포에서 v2 로 바꾸는 것만으로 전부 갈아탄다.
 */
/*
 * 기본값을 최신 버전으로 유지할 것. 기본이 v1 이던 시절, CPA 교체 재배포가
 * env 없이 돌면서 전 사이트가 비콘 없는 v1 자산으로 롤백됐다 (2026-08-20 사고
 * — 청소 유입 신호가 통째로 끊겼다). 새 자산을 올리면 여기 기본값도 같이 올린다.
 */
const ASSET_VERSION = String(process.env.PUBLIC_ASSET_VERSION || 'v4');

/**
 * 사이트 URL -> 그 사이트가 쓸 자산 베이스.
 * 예: https://acorn-echo.neverfoul.com -> https://assets.neverfoul.com
 */
export function assetBaseForSite(siteUrl) {
  try {
    const host = new URL(siteUrl).hostname;
    const root = host.split('.').slice(-2).join('.');
    if (!root.includes('.')) return ENV_ASSET_BASE;
    return `https://${ASSET_SUBDOMAIN}.${root}`;
  } catch {
    return ENV_ASSET_BASE;
  }
}

export const GALLERY = {
  ext: 'webp',
  rooms: ['거실', '주방', '욕실', '침실', '현관', '베란다', '딥클리닝', '원룸', '복도·수납', '전문도구'],
  perRoom: 50,
  count: 9,
};

const POOL_SIZE = GALLERY.rooms.length * GALLERY.perRoom;

/** pageMeta.ts 의 hash 와 같은 계열. 이 모듈만으로 돌게 자체 구현해 둔다. */
function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const pad = (n, width) => String(n).padStart(width, '0');

/** 전체순번(1~500) -> { name, room, no } */
export function imageAt(serial) {
  const index = ((serial - 1) % POOL_SIZE + POOL_SIZE) % POOL_SIZE;
  const room = GALLERY.rooms[Math.floor(index / GALLERY.perRoom)];
  const no = (index % GALLERY.perRoom) + 1;
  return { name: `${pad(index + 1, 3)}_${room}_${pad(no, 2)}`, room, no };
}

/**
 * 저장소에서 겹치지 않게 count 장을 고른다.
 * seed 가 같으면 항상 같은 결과가 나온다 (빌드 재현성).
 */
function pickImages(seed, count, offset = 0) {
  // POOL_SIZE(500) 과 서로소인 step 을 골라야 한 바퀴 안에서 안 겹친다.
  let step = (seed % (POOL_SIZE - 1)) + 1;
  while (gcd(step, POOL_SIZE) !== 1) step += 1;

  const picked = [];
  for (let i = 0; i < count; i += 1) {
    const serial = ((seed + offset + i * step) % POOL_SIZE) + 1;
    picked.push(imageAt(serial));
  }
  return picked;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * list 에서 count 개를, 블록(index)마다 다른 시작점·보폭으로 뽑는다.
 * 시작점만 바꾸면 순서가 같아 보이므로 보폭도 함께 돌린다.
 */
function pickRotated(list, count, index) {
  const size = list.length;
  if (size === 0) return [];
  if (size === 1) return [list[0]];

  let step = 1 + ((index * 2) % (size - 1));
  while (gcd(step, size) !== 1) step += 1;

  const start = (index * 3) % size;
  const picked = [];
  for (let i = 0; i < size && picked.length < count; i += 1) {
    const word = list[(start + i * step) % size];
    if (!picked.includes(word)) picked.push(word);
  }
  return picked;
}

/**
 * 특정 공간에서 한 장 고른다. alt 문구가 공간을 지칭할 때 쓴다
 * (예: "욕실 청소 전후" 자리에는 욕실 사진이 와야 한다).
 */
function pickInRoom(seed, room, offset = 0) {
  const roomIndex = GALLERY.rooms.indexOf(room);
  if (roomIndex < 0) return imageAt((Math.abs(seed + offset) % POOL_SIZE) + 1);
  const no = Math.abs(seed + offset) % GALLERY.perRoom;
  return imageAt(roomIndex * GALLERY.perRoom + no + 1);
}

/**
 * 두 번째 메인 키워드.
 *
 * 한 페이지의 메인 키워드는 카탈로그가 하나만 준다. 제목·h1 에 메인을 둘 넣으려면
 * 나머지 18개 중에서 하나를 더 골라야 한다. 고를 때 두 가지를 피한다.
 *   - 같은 키워드
 *   - 어간이 겹치는 것 (입주청소 / 아파트입주청소 처럼 한쪽이 다른 쪽을 품는 경우)
 * 겹치면 "입주청소 아파트입주청소" 같은 제목이 나와서 앞서 지적받은 중복이 된다.
 */
function secondMain(main, pool, seed) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  for (let step = 0; step < pool.length; step += 1) {
    const candidate = pool[(seed + step * 7) % pool.length];
    if (!candidate || candidate === main) continue;
    if (candidate.includes(main) || main.includes(candidate)) continue;
    return candidate;
  }
  return '';
}

/**
 * 제목을 "지역명 + 메인 2 + 서브 2" 로 만든다.
 *
 * 원본 buildTitle() 은 메인을 하나만 넣는다. 그 함수는 pageMeta.ts 에 있고
 * 기존 templates/ 도 같이 쓰므로 건드리지 않고, 새 템플릿에서만 여기로 덮어쓴다.
 *
 * 패턴을 여러 개 두고 해시로 고르는 이유는 70만 페이지의 제목이 한 틀로
 * 찍히면 중복 판정에 걸리기 때문이다. 원본 buildTitle 도 같은 방식이다.
 */
function composeTitle(location, mains, subs, seed) {
  const mainText = mains.filter(Boolean).join(' ');
  const subText = subs.filter(Boolean).join(' ');
  const counts = [3, 5, 7, 9, 10];
  const count = counts[seed % counts.length];

  const patterns = [
    `${location} ${mainText} 비교 ${count}곳 | ${subText} 업체 추천`,
    `${location} ${mainText} ${count}곳 가격 비교 · ${subText} 견적`,
    `${location} ${mainText} 잘하는곳 ${count}곳 | ${subText} 순위`,
    `${location} ${mainText} 전문업체 ${count}곳 비교 · ${subText} 상담`,
  ];
  // 서브가 없으면 꼬리가 " | 업체 추천" 처럼 비어 보이므로 정리한다.
  return patterns[Math.floor(seed / 3) % patterns.length]
    .replace(/\s*[|·]\s*(업체 추천|견적|순위|상담)\s*$/, (m) => (subText ? m : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * 이미지가 들어 있는 폴더 이름.
 *
 * R2 버킷 안에서 사업별로 나뉜다 (cleaning/ · moving/ · …).
 * 기본값이 'cleaning' 이라 청소는 종전과 같다.
 */
const IMAGE_DIR = String(process.env.PUBLIC_IMAGE_DIR || 'cleaning');

/** 한글이 섞인 파일명이라 경로는 인코딩해서 내보낸다. */
function imageSrc(name, base) {
  return `${base}/${IMAGE_DIR}/${encodeURIComponent(name)}.${GALLERY.ext}`;
}

/** "세종특별자치시 나성동" -> "나성동". 헤드라인이 길어지는 걸 막는다. */
function lastToken(location) {
  const tokens = String(location).trim().split(/\s+/);
  return tokens[tokens.length - 1] || location;
}

/**
 * 지번주소 표기.
 *
 * 번지는 만들지 않는다. 레거시(watermelon-piping 의 regionalAddressForCard)도
 * 번지를 지어내지 않고 지역명을 동/읍/면/리 단위까지만 잘라 쓴다. rollout-locations
 * 자체가 이미 리/동 단위라 그대로 쓰면 그게 지번주소 표기가 된다.
 *
 * 카드마다 같은 문자열이 5번 반복되면 부자연스러워서, 레거시(site.mjs:1607)처럼
 * 4의 배수 인덱스만 전체 주소를 쓰고 나머지는 마지막 행정단위를 뗀다.
 */
function regionalAddress(location, index = 0) {
  const full = String(location || '').trim().replace(/\s+/g, ' ');
  if (index % 4 === 0) return full;
  const trimmed = full.replace(/\s+\S+(?:동|리|가|읍|면)$/u, '');
  return trimmed || full;
}

const unique = (list) => [...new Set(list.filter((v) => typeof v === 'string' && v.trim()))];

function mapUrls(location, keyword) {
  const query = `${location} ${keyword}`;
  return {
    naverMap: `https://map.naver.com/v5/search/${encodeURIComponent(query)}`,
    googleMap: `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
  };
}

/**
 * buildPageData() 결과에 places / gallery 등을 얹는다.
 *
 * @param {object} data buildPageData() 가 돌려준 객체
 * @returns {object} 같은 객체 (제자리 확장)
 */
export function extendPageData(data, opts = {}) {
  const base = opts.assetBase ?? assetBaseForSite(data.siteUrl) ?? ENV_ASSET_BASE;
  // 템플릿이 CSS·JS 주소를 직접 만들 수 있게 내보낸다.
  // 예전에는 CSS 21KB 와 JS 2KB 가 페이지마다 통째로 박혀 나갔다.
  data.assetBase = base;
  data.assetVersion = ASSET_VERSION;
  const location = data.location;
  const short = lastToken(location);
  const main = data.mainKeyword;
  const id = Number(data.pageId) || 0;
  const seed = hash(`merged|${location}|${main}|${id}`);

  // 플레이스 썸네일과 캐러셀이 같은 사진을 쓰지 않도록 오프셋을 벌려 둔다.
  const placeImages = pickImages(seed, PLACE_COUNT);
  const galleryImages = pickImages(seed, GALLERY.count, Math.floor(POOL_SIZE / 2));

  data.shortLocation = short;
  data.vendorCount = 3;
  // 메인 2개 + 서브 2개. h1·배지가 이 두 문자열을 쓴다.
  data.mainKeyword2 = secondMain(main, opts.mainKeywords, seed);
  /*
   * 키워드는 공백으로 잇는다.
   *
   * 예전에는 ' · ' 로 이었다. h1 과 배지에 그대로 찍히는데, 가운뎃점이
   * 들어가면 한 덩어리 제목이 아니라 나열처럼 읽힌다. 운영자 지시로 뺐다.
   * (title 쪽 구분자는 composeTitle 이 따로 관리한다.)
   */
  data.mainKeywordText = [main, data.mainKeyword2].filter(Boolean).join(' ');
  const subs = (data.subKeywords || []).slice(0, 2);
  data.subKeywordText = subs.join(' ') || main;
  data.placeCount = PLACE_COUNT;

  // title 도 h1 과 같은 "지역명 + 메인 2 + 서브 2" 로 맞춘다.
  data.title = composeTitle(location, [main, data.mainKeyword2], subs, seed);

  /**
   * 이 페이지가 실제로 노리는 키워드들. 레거시 view.ts 의 placeKeywordPool 과
   * 같은 발상이다 — 플레이스를 고정 문구로 박지 않고 페이지 키워드에서 뽑는다.
   * 그래야 100장이 서로 다른 플레이스를 갖고, 분류도 페이지 주제와 맞는다.
   */
  const keywordPool = unique([
    main,
    ...(data.subKeywords || []),
    ...(data.related || []).map((item) => item.word),
  ]);

  data.places = Array.from({ length: PLACE_COUNT }, (_, index) => {
    const searchKeyword = keywordPool[index % keywordPool.length];
    const others = keywordPool.filter((word) => word !== searchKeyword);

    // <b> 안에 넣을 연관 키워드.
    //
    // 시작점만 밀면 5개 블록이 "순서만 돌아간 같은 줄"로 보인다. 보폭(step)도
    // 블록마다 바꿔서 나열 순서 자체를 다르게 만든다. 보폭이 길이와 서로소여야
    // 한 바퀴 도는 동안 안 겹친다.
    const keywords = pickRotated(others, KEYWORDS_PER_PLACE, index);

    const image = placeImages[index];
    return {
      headline: searchKeyword,
      keywordText: keywords.join(' '),
      // 분류는 그 블록의 키워드에서 결정된다. 규칙에 안 걸리는 키워드만
      // FALLBACK_CATEGORIES 를 (id + index) 로 회전 배정한다.
      category: categoryFor(searchKeyword, id + index),
      // 홈 템플릿은 플레이스마다 지역이 달라서 항목 안에 넣는다.
      // 하위 페이지에서는 바깥 {{shortLocation}} 과 같은 값이라 표시가 안 바뀐다.
      shortLocation: short,
      image: imageSrc(image.name, base),
      alt: `${short} ${searchKeyword}`,
      address: regionalAddress(location, index),
      ...mapUrls(short, searchKeyword),
    };
  });

  const items = galleryImages.map((image, index) => ({
    src: imageSrc(image.name, base),
    alt: `${short} ${main} ${image.room} ${pad(image.no, 2)}`,
    title: `${short} ${main} ${image.room}`,
    // 첫 썸네일만 active. 클래스 문자열을 데이터로 넘겨 템플릿 분기를 없앤다.
    activeClass: index === 0 ? ' active' : '',
  }));

  data.gallery = buildGallery(galleryImages, short, main, base);

  /*
   * 시공 사진 4장. 홈에만 있던 갤러리 그리드를 하위에도 넣으면서 필요해졌다.
   * alt 가 공간을 지칭하므로 해당 공간에서 뽑는다. 홈과 같은 규칙이다.
   *
   * 순환용 showcasePool 은 안 만든다. 4.2초마다 사진이 바뀌던 효과를 걷어내
   * 쓰는 데가 없어졌다.
   */
  data.showcase = [
    ['욕실', '욕실 청소 전후'],
    ['원룸', '이사 후 빈 방 청소'],
    ['거실', '깨끗한 거실 공간'],
    ['전문도구', '청소 도구와 장비'],
  ].map(([room, alt], index) => ({
    src: imageSrc(pickInRoom(seed, room, 100 + index * 13).name, base),
    alt,
  }));

  /*
   * 업체 썸네일. 홈에만 있던 비교 그리드를 하위 문서에도 넣으면서 필요해졌다.
   * 홈과 같은 R2 /compare/ 이미지를 쓴다 (320x320).
   */
  data.vendorImages = ['새집느낌', '이사방청소', '24번가 입주청소'].map((name, index) => ({
    src: `${base}/compare/compare${index + 1}.webp`,
    alt: `${name} 청소 업체`,
  }));

  /*
   * og:image 를 이 페이지의 첫 갤러리 사진으로 바꾼다.
   *
   * 예전에는 10,000 개 사이트가 전부 /img/hero-1120.webp 하나를 가리켰다.
   * 같은 대표 이미지가 131만 장에 붙어 있으면 문서를 구별하는 신호가 못 된다.
   * 페이지마다 다른 사진을 가리키게 한다.
   */
  if (data.gallery?.first?.src) data.ogImage = data.gallery.first.src;

  data.jsonLd = addImageJsonLd(data.jsonLd, data.gallery, data.canonical, short);

  return data;
}

function buildGallery(images, short, main, base) {
  const items = images.map((image, index) => ({
    src: imageSrc(image.name, base),
    alt: `${short} ${main} ${image.room} ${pad(image.no, 2)}`,
    title: `${short} ${main} ${image.room}`,
    activeClass: index === 0 ? ' active' : '',
  }));

  return {
    path: `${base}/${IMAGE_DIR}`,
    ext: GALLERY.ext,
    pool: POOL_SIZE,
    count: items.length,
    names: images.map((image) => image.name).join(','),
    first: items[0],
    items,
  };
}

/**
 * 홈(index) 용 확장.
 *
 * 홈에는 location / subKeywords / related 가 없다. 대신 이 사이트가 실제로
 * 가진 하위 페이지 조합(catalogEntry)을 앞에서부터 뽑아 플레이스로 쓴다.
 * 그래서 홈의 플레이스 5개는 지역도 키워드도 서로 다르고, 전부 이 사이트에
 * 실제 페이지가 있는 조합이다.
 *
 * @param {object} data     buildIndexData() 결과
 * @param {object} ctx      { catalogEntry, locations, siteIndex, pageCount, normalizeLocation, pickFaqs, pickReviews }
 */
export function extendIndexData(data, ctx) {
  const base = ctx.assetBase ?? assetBaseForSite(data.siteUrl) ?? ENV_ASSET_BASE;
  data.assetBase = base;
  data.assetVersion = ASSET_VERSION;
  const main = data.mainKeyword;
  const seed = hash(`merged-home|${data.siteUrl}|${main}`);

  const entries = Array.from({ length: PLACE_COUNT }, (_, index) =>
    ctx.catalogEntry({
      locations: ctx.locations,
      siteIndex: ctx.siteIndex,
      requestId: index + 1,
      pageCount: ctx.pageCount,
    }));

  const placeImages = pickImages(seed, PLACE_COUNT);
  const galleryImages = pickImages(seed, GALLERY.count, Math.floor(POOL_SIZE / 2));

  data.vendorCount = 3;
  data.placeCount = PLACE_COUNT;
  // 홈 h1 도 "지역명 + 메인 2 + 서브 2" 로 간다. buildIndexData 는 서브를 안 주므로 여기서 만든다.
  data.subKeywords = typeof ctx.subKeywordsFor === 'function' ? ctx.subKeywordsFor(main).slice(0, 2) : [];
  data.subKeywordText = data.subKeywords.join(' ') || main;
  data.mainKeyword2 = secondMain(main, ctx.mainKeywords, seed);
  data.mainKeywordText = [main, data.mainKeyword2].filter(Boolean).join(' ');

  /*
   * 홈은 하위 100장 중 어느 것과도 겹치지 않는 지역을 쓴다.
   *
   * 1번 페이지의 지역을 그대로 쓰면 홈과 1.html 이 같은 지역으로 title·FAQ·본문이
   * 겹친다. 한 사이트가 지역 100개를 덮는 구조라 홈은 101번째 지역이어야 한다.
   * siteUrl 이 시드라 재빌드해도 같은 지역이 나온다.
   */
  const usedLocations = new Set();
  for (let requestId = 1; requestId <= ctx.pageCount; requestId += 1) {
    usedLocations.add(ctx.catalogEntry({
      locations: ctx.locations,
      siteIndex: ctx.siteIndex,
      requestId,
      pageCount: ctx.pageCount,
    }).location);
  }

  const all = ctx.locations;
  let homeRaw = entries[0].location;
  for (let step = 0; step < all.length; step += 1) {
    const candidate = all[(seed + step * 7919) % all.length];
    // 시·도 단위처럼 토큰이 1~2개뿐인 이름은 페이지 문구가 어색해져서 건너뛴다.
    if (!candidate || candidate.trim().split(/\s+/).length < 3) continue;
    if (usedLocations.has(candidate)) continue;
    homeRaw = candidate;
    break;
  }
  const seedLocation = ctx.normalizeLocation(homeRaw);

  /*
   * 홈 플레이스는 홈 지역과 그 인근으로 채운다.
   *
   * 예전에는 카탈로그 1~5번 페이지를 그대로 썼는데, 그 조합은 전국으로 흩어져
   * 있어서 홈 지역이 경북인데 플레이스는 부천·김포·대전이 나왔다. 한 화면에
   * 붙어 있으면 서로 무관해 보인다. pickNearbyLocations 는 같은 상위 구역
   * 안에서 행정코드 순으로 가까운 동네를 준다.
   */
  const nearbyForPlaces = typeof ctx.pickNearbyLocations === 'function'
    ? ctx.pickNearbyLocations(seedLocation, ctx.locations, PLACE_COUNT - 1)
    : [];
  const placeLocations = [seedLocation, ...nearbyForPlaces].slice(0, PLACE_COUNT);
  while (placeLocations.length < PLACE_COUNT) placeLocations.push(seedLocation);

  // 지역이 붙어 있으니 키워드는 흩어 준다. 같은 동네에 같은 업종만 5개면 어색하다.
  const homeKeywordPool = unique([
    main,
    data.mainKeyword2,
    ...(data.subKeywords || []),
    ...(ctx.mainKeywords || []),
  ]);

  data.places = placeLocations.map((full, index) => {
    const short = lastToken(full);
    const keyword = homeKeywordPool[index % homeKeywordPool.length];
    const image = placeImages[index];
    const others = homeKeywordPool.filter((word) => word !== keyword);

    return {
      shortLocation: short,
      headline: keyword,
      keywordText: (ctx.subKeywordsFor(keyword).slice(0, KEYWORDS_PER_PLACE).join(' ')
        || pickRotated(others, 5, index).join(' ')
        || keyword),
      category: categoryFor(keyword, index),
      image: imageSrc(image.name, base),
      alt: `${short} ${keyword}`,
      address: regionalAddress(full, index),
      ...mapUrls(short, keyword),
    };
  });

  data.gallery = buildGallery(galleryImages, '전국', main, base);

  /*
   * 홈 상단의 업체 썸네일 3장과 갤러리 4장.
   *
   * 원본 템플릿은 unsplash CDN 을 직접 물고 있었다. 사이트가 10,000개라
   * 외부 CDN 이 핫링크를 막거나 레이트 리밋을 걸면 전 사이트가 동시에 깨지고,
   * 같은 URL 을 공유하는 것 자체가 루트 10개를 묶는 지문이 된다. 그래서 R2 로 옮긴다.
   *
   * alt 문구가 공간을 지칭하므로 해당 공간에서 뽑는다. 사이트마다 시드가 달라
   * 홈 7장이 전부 같은 사진으로 도배되지 않는다.
   */
  // 업체 썸네일은 지정된 compare 이미지를 쓴다 (R2 /compare/, 320x320 로 리사이즈해 업로드).
  data.vendorImages = ['새집느낌', '이사방청소', '24번가 입주청소'].map((name, index) => ({
    src: `${base}/compare/compare${index + 1}.webp`,
    alt: `${name} 청소 업체`,
  }));

  /*
   * 갤러리는 4칸이 풀에서 돌아간다. 처음 4장은 alt 문구에 맞는 공간에서 뽑고,
   * 풀에는 그 공간들에서 더 뽑아 채운다. 화면에 한 번에 4장, 순환은 12장.
   */
  const showcaseRooms = [
    ['욕실', '욕실 청소 전후'],
    ['원룸', '이사 후 빈 방 청소'],
    ['거실', '깨끗한 거실 공간'],
    ['전문도구', '청소 도구와 장비'],
  ];
  data.showcase = showcaseRooms.map(([room, alt], index) => ({
    src: imageSrc(pickInRoom(seed, room, 100 + index * 13).name, base),
    alt,
  }));

  const pool = [];
  for (let round = 0; round < 3; round += 1) {
    showcaseRooms.forEach(([room], index) => {
      pool.push(imageSrc(pickInRoom(seed, room, 100 + index * 13 + round * 37).name, base));
    });
  }
  data.showcasePool = unique(pool).join(',');

  /*
   * buildIndexData 는 pickFaqs(site.siteUrl, main) 처럼 지역 자리에 URL 을 넘긴다.
   * FAQ_POOL 의 {location} 토큰이 그 값으로 치환돼 본문에 "https://... 입주청소
   * 비용은" 같은 문장이 그대로 나간다. 홈에도 지역이 필요하니 첫 카탈로그 항목의
   * 지역을 시드로 다시 뽑아 덮어쓴다. 원본 렌더러는 건드리지 않는다.
   */
  /*
   * 홈은 하위 100장 중 어느 것과도 겹치지 않는 지역을 쓴다.
   *
   * 이전에는 1번 페이지의 지역을 그대로 썼는데, 그러면 홈과 1.html 이 같은
   * 지역으로 title·FAQ·본문이 겹친다. 한 사이트가 지역 100개를 덮는 구조라
   * 홈은 101번째 지역을 갖는 셈이 되어야 한다.
   *
   * 이 사이트가 쓰는 100개를 먼저 모아두고, 전체 지역 목록에서 그 밖의 것을
   * 해시로 고른다. siteUrl 이 시드라 재빌드해도 같은 지역이 나온다.
   */
  // 홈 지역은 위(함수 앞부분)에서 이미 정했다. 여기서는 그 값을 쓰기만 한다.
  data.location = seedLocation;
  data.shortLocation = lastToken(seedLocation);

  /*
   * 연관 검색어. 홈에도 해시태그 줄을 넣으면서 필요해졌다.
   *
   * buildPageData 는 related 를 만들어 주지만 buildIndexData 는 안 만든다.
   * 그래서 홈에서는 kw-row 가 빈 div 로 나갔다. 렌더러가 넘겨준 함수로
   * 하위와 같은 규칙으로 만든다.
   */
  if (!Array.isArray(data.related) || !data.related.length) {
    data.related = typeof ctx.relatedKeywords === 'function'
      ? ctx.relatedKeywords(data.location || '', main, 8).map((word) => ({ word }))
      : [];
  }


  /*
   * 홈 title 도 하위 페이지와 같은 "지역명 + 메인 + 서브" 패턴으로 맞춘다.
   * buildIndexMeta 가 만든 기본 title 은 지역이 거의 안 들어간다.
   * title 을 바꾸면 og:title 과 JSON-LD 의 name 도 같이 움직여야 해서 함께 고친다.
   */
  if (typeof ctx.buildDescription === 'function') {
    data.description = ctx.buildDescription(seedLocation, main, 'B');
  }

  // 홈 title 도 하위와 같은 "지역명 + 메인 2 + 서브 2".
  // 지역이 확정된 뒤여야 하므로 여기서 만든다. og:title 과 JSON-LD 의 name 도 같이 움직인다.
  data.title = composeTitle(seedLocation, [main, data.mainKeyword2], data.subKeywords, seed);
  data.jsonLd = syncSiteMeta(data.jsonLd, data.title, data.description);

  data.faqs = ctx.pickFaqs(seedLocation, main);
  data.reviews = ctx.pickReviews(seedLocation, main, 3)
    .map((review) => ({ ...review, stars: '★'.repeat(review.rating) }));

  // jsonLd 는 위 override 전에 만들어져서 옛 FAQ(=URL 이 박힌 문장)를 들고 있다.
  // 화면과 구조화 데이터가 어긋나면 검색엔진이 불일치로 본다. 같은 값으로 맞춘다.
  data.jsonLd = syncFaqJsonLd(data.jsonLd, data.faqs);

  if (data.gallery?.first?.src) data.ogImage = data.gallery.first.src;
  data.jsonLd = addImageJsonLd(data.jsonLd, data.gallery, data.canonical, seedLocation);

  return data;
}

/*
 * 갤러리 이미지를 구조화 데이터에 선언한다.
 *
 * 페이지에는 1080x1350 짜리 청소 사진이 여러 장 깔려 있는데, JSON-LD 는
 * 그 존재를 한 번도 말하지 않았다. BreadcrumbList·Service·FAQPage 어디에도
 * image 속성이 없어서, 검색로봇이 구조화 데이터만 보면 이미지가 하나도
 * 없는 문서다.
 *
 * 네이버 문서는 "정상 마크업이어도 노출을 보장하지 않는다"고 못 박는다.
 * 그래도 지금은 요건 자체를 안 갖춰 후보에도 못 든다. 두 가지를 넣는다.
 *
 *   1. Service·WebSite 의 image  — 이 문서의 대표 이미지가 무엇인지
 *   2. ImageGallery + ItemList   — 여러 장이 한 벌이라는 것
 *
 * ItemList 를 쓰는 이유는 캐러셀이 "여러 항목의 나열"로 해석되기 때문이다.
 * ImageObject 로 폭·높이·설명까지 적어야 로봇이 크기를 알고 후보로 삼는다.
 */
function addImageJsonLd(jsonLd, gallery, canonical, locationName) {
  const items = (gallery?.items || []).filter((item) => item?.src);
  if (!items.length) return jsonLd;

  try {
    const parsed = JSON.parse(jsonLd);
    const graph = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [];

    const imageObject = (item, index) => ({
      '@type': 'ImageObject',
      '@id': `${canonical}#image-${index + 1}`,
      contentUrl: item.src,
      url: item.src,
      // 실제 원본 규격. 네이버 최소 요건(150x150)과 비율 3:1 을 모두 만족한다.
      width: 1080,
      height: 1350,
      name: item.title || item.alt,
      description: item.alt,
      caption: item.alt,
      representativeOfPage: index === 0,
    });

    const images = items.map(imageObject);
    const urls = items.map((item) => item.src);

    for (const node of graph) {
      // 대표 이미지는 URL 배열로 준다. 로봇이 첫 장을 대표로 읽는다.
      if (node['@type'] === 'WebSite' || node['@type'] === 'Service') node.image = urls;
    }

    graph.push({
      '@type': 'ImageGallery',
      '@id': `${canonical}#gallery`,
      name: `${locationName} 청소 시공 사진`,
      url: canonical,
      image: images,
    });

    graph.push({
      '@type': 'ItemList',
      '@id': `${canonical}#imagelist`,
      name: `${locationName} 청소 시공 사진 ${items.length}장`,
      numberOfItems: items.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: imageObject(item, index),
      })),
    });

    parsed['@graph'] = graph;
    return JSON.stringify(parsed);
  } catch {
    return jsonLd;
  }
}

/** title/description 을 바꿨으면 JSON-LD 의 WebSite·Service 쪽도 같이 맞춘다. */
function syncSiteMeta(jsonLd, title, description) {
  try {
    const parsed = JSON.parse(jsonLd);
    for (const node of (parsed['@graph'] || [])) {
      if (node['@type'] === 'WebSite') {
        node.name = title;
        node.description = description;
      }
      if (node['@type'] === 'Service') node.description = description;
    }
    return JSON.stringify(parsed);
  } catch {
    return jsonLd;
  }
}

function syncFaqJsonLd(jsonLd, faqs) {
  try {
    const parsed = JSON.parse(jsonLd);
    const graph = Array.isArray(parsed['@graph']) ? parsed['@graph'] : [];
    for (const node of graph) {
      if (node['@type'] !== 'FAQPage') continue;
      node.mainEntity = faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.q,
        acceptedAnswer: { '@type': 'Answer', text: faq.a },
      }));
    }
    return JSON.stringify(parsed);
  } catch {
    // 형태가 바뀌었으면 건드리지 않는다. 깨진 JSON-LD 를 내보내는 것보다 낫다.
    return jsonLd;
  }
}
