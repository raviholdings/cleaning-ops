/**
 * 지역 → URL 슬러그. 하림배관 방식(평면·비의미 슬러그)을 따른다.
 *
 *   /drainpapa/  /mshjhjy/  /drainkim/  /drain/     ← 레퍼런스 실물
 *
 * 규칙 셋을 지킨다.
 *
 * 1. 결정적 — 같은 (사이트, 지역)이면 언제 돌려도 같은 슬러그가 나온다.
 *    한 번 제출한 URL 이 재빌드로 바뀌면 그 페이지는 통째로 날아간다.
 *
 * 2. 사이트마다 다름 — salt 에 도메인을 넣는다. 같은 강동구가 다섯 사이트에서
 *    같은 슬러그를 가지면 그것만으로 한 운영자로 묶인다.
 *
 * 3. 규칙이 안 드러남 — 계층도 지역명도 안 쓴다. 로마자 지역명(/gangdong/)이
 *    273개 늘어서 있으면 자동 생성이 한눈에 보인다.
 *
 * 읽을 수 있게 자음+모음을 번갈아 만들고, 일부에만 업종 단어를 붙여
 * 손으로 지은 것처럼 결이 고르지 않게 둔다 (레퍼런스가 그렇다).
 */

const CONS = 'bdgjkmnprstw';
const VOWL = 'aeiou';
/** 일부 슬러그 앞에 붙는 업종 단어. 사이트마다 다른 묶음을 쓰는 게 좋다. */
export const DEFAULT_WORDS = ['drain', 'pipe', 'clog', 'flow', 'duct'];

/** 문자열 → 32비트 정수. 같은 입력이면 항상 같은 값. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** hash 를 씨앗으로 하는 결정적 난수열. */
function rng(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function pronounceable(rand, syllables) {
  let out = '';
  for (let i = 0; i < syllables; i += 1) {
    out += CONS[Math.floor(rand() * CONS.length)];
    out += VOWL[Math.floor(rand() * VOWL.length)];
    // 가끔 받침을 붙여 결을 흐트러뜨린다
    if (rand() < 0.35) out += CONS[Math.floor(rand() * CONS.length)];
  }
  return out;
}

/**
 * @param {string} siteKey  사이트 구분자 (도메인). 사이트마다 슬러그가 갈리는 근거.
 * @param {string} regionKey 지역 구분자 (법정동코드 앞 5자리 등). 지역명이 아니라 코드를 쓴다.
 * @param {object} [opts]
 * @param {string[]} [opts.words] 앞에 붙일 업종 단어 묶음
 * @param {number} [opts.wordRatio] 단어가 붙는 비율 (0~1)
 */
export function regionSlug(siteKey, regionKey, opts = {}) {
  const words = opts.words || DEFAULT_WORDS;
  const wordRatio = opts.wordRatio ?? 0.4;
  const rand = rng(hash(`${siteKey}|${regionKey}`));

  const useWord = rand() < wordRatio;
  if (useWord) {
    const w = words[Math.floor(rand() * words.length)];
    // drain / drainkim / drainpapa 처럼 단어만이거나 뒤에 한두 음절이 붙는다
    const tail = rand() < 0.25 ? '' : pronounceable(rand, 1 + Math.floor(rand() * 2));
    return (w + tail).slice(0, 14);
  }
  return pronounceable(rand, 3 + Math.floor(rand() * 2)).slice(0, 14);
}

/**
 * 지역 목록 전체에 슬러그를 매긴다. 충돌이 나면 씨앗을 바꿔 다시 뽑는다
 * (충돌을 숫자 접미사로 때우면 -2 -3 이 붙어 규칙이 드러난다).
 */
export function assignSlugs(siteKey, regionKeys, opts = {}) {
  const taken = new Set();
  const map = new Map();
  for (const key of regionKeys) {
    let slug = regionSlug(siteKey, key, opts);
    let salt = 0;
    while (taken.has(slug)) {
      salt += 1;
      slug = regionSlug(siteKey, `${key}#${salt}`, opts);
    }
    taken.add(slug);
    map.set(key, slug);
  }
  return map;
}
