#!/usr/bin/env node
/**
 * 브랜드 사이트 굽기 — 대량 배포(청소·이사·배관)와 다른 계통이다.
 *
 *   node scripts/build-brand-site.mjs --site dream [--host example.co.kr] [--out tmp/brands]
 *
 * 대량 배포는 한 템플릿으로 수만 장을 찍어 색인 면적을 넓히는 것이고,
 * 이쪽은 **실제로 운영할 업체 사이트 5개**다. 그래서 규칙이 반대다.
 *
 *   - 사이트마다 카피·디자인이 다르다 (data/brands/<key>.json)
 *   - URL 에 규칙이 드러나면 안 된다 → scripts/lib/region-slug.mjs
 *   - 자산은 R2 가 아니라 사이트 자신이 들고 간다 (/assets/<version>/)
 *
 * 만드는 것
 *   /                     홈
 *   /area/                서비스 지역 목록 (시도별로 묶은 256개 링크)
 *   /<slug>/              시군구 페이지 × 256
 *   /sitemap.xml  /robots.txt  /assets/<version>/{style.css,app.js}
 */

import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, rmSync, statSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { assignSlugs } from './lib/region-slug.mjs';
import { romanize, romanizeUnique } from './lib/romanize.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const siteKey = valueOf('--site', 'dream');
const outRoot = resolve(projectRoot, valueOf('--out', 'tmp/brands'));

const site = JSON.parse(readFileSync(resolve(projectRoot, `data/brands/${siteKey}.json`), 'utf8'));
const pools = JSON.parse(readFileSync(resolve(projectRoot, `data/brands/${siteKey}-pools.json`), 'utf8'));
const regions = JSON.parse(readFileSync(resolve(projectRoot, 'data/hub/regions.json'), 'utf8'));

/*
 * 서비스 상세는 5종이 고정이고, 작업사례는 실제로 있었던 일만 넣는다.
 * 사례 파일이 없거나 비어 있으면 사례 페이지를 아예 만들지 않는다 —
 * 지어낸 이야기를 실제 업체 사이트에 사례로 올릴 수는 없다.
 */
const servicesPath = resolve(projectRoot, `data/brands/${siteKey}-services.json`);
const services = JSON.parse(readFileSync(servicesPath, 'utf8')).services;
const casesPath = resolve(projectRoot, `data/brands/${siteKey}-cases.json`);
const realCases = existsSync(casesPath)
  ? (JSON.parse(readFileSync(casesPath, 'utf8')).cases || []).filter((c) => c.title && c.body)
  : [];

/*
 * 3단계 구조(클린배관형). /{시도}/{시군구}/{키워드} 로 접히는 사이트만 해당한다.
 * 평면 슬러그 대신 로마자를 쓰고, 시군구 페이지 아래에 키워드 상세가 붙는다.
 * 다른 사이트는 지금까지대로 평면이다 — 그게 사이트마다 구조가 다르다는 뜻이다.
 */
const TIERED = site.structure === 'tiered';
/*
 * 블로그형(하수구박사). 지역 페이지 대신 {구}{키워드} 조합 글을 깐다.
 * 슬러그가 한글이고 평면 1단계다 — 3단계(클린배관형)와 정반대.
 */
const BLOG = site.structure === 'blog';
const blogData = BLOG
  ? JSON.parse(readFileSync(resolve(projectRoot, `data/brands/${siteKey}-blog.json`), 'utf8'))
  : null;
const keywordData = TIERED
  ? JSON.parse(readFileSync(resolve(projectRoot, `data/brands/${siteKey}-keywords.json`), 'utf8'))
  : null;
const keywords = keywordData ? keywordData.keywords : [];

const host = valueOf('--host', site.host);
const siteUrl = `https://${host}`.replace(/\/+$/, '');

/*
 * 템플릿은 사이트마다 따로다. 다섯이 한 회사로 안 보이려면 색만 바꿔서는 안 되고
 * 레이아웃·폰트·구성까지 갈라야 한다 (site.template 으로 지정, 기본은 사이트 키).
 */
const templateDir = resolve(projectRoot, `apps/brand-static/${site.template || siteKey}-template`);
/*
 * 템플릿 주석은 굽는 사람 보라고 쓴 것이지 방문자 보라고 쓴 게 아니다.
 * 그대로 두면 소스보기에 우리 내부 구조(어디로 보내는지, 무슨 테이블인지)가
 * 258장 전부에 실려 나간다. 파싱 전에 걷어낸다.
 */
const rawTemplates = {};
const tpl = (name) => {
  const src = readFileSync(join(templateDir, name), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  rawTemplates[name] = src;
  return parseTemplate(src, name);
};
const optional = (name, key) => (existsSync(join(templateDir, name)) ? { [key]: tpl(name) } : {});
const templates = {
  layout: tpl('layout.html'),
  home: tpl('home.html'),
  areaHub: tpl('area-hub.html'),
  region: tpl('region.html'),
  estimate: tpl('partials/estimate-form.html'),
  service: tpl('service.html'),
  caseList: tpl('case-list.html'),
  caseOne: tpl('case.html'),
  ...optional('sido-hub.html', 'sidoHub'),
  // 3단계 구조 전용. 없는 사이트에서는 만들지 않는다.
  ...optional('kw-list.html', 'kwList'),
  ...optional('kw-hub.html', 'kwHub'),
  ...optional('sigungu-hub.html', 'sigunguHub'),
  ...optional('detail.html', 'detail'),
  // 블로그형 전용
  ...optional('post.html', 'post'),
  ...optional('blog-index.html', 'blogIndex'),
  ...optional('blog-hub.html', 'blogHub'),
  ...optional('privacy.html', 'privacy'),
};

/* ────────────────────────────────────────────────────────────
   지역 정리
   ──────────────────────────────────────────────────────────── */

/*
 * 전남·광주 통합(코드 12)은 원본에 "전남광주통합특별시" 한 덩어리로 들어온다.
 * 그대로 쓰면 "광주 여수시" 가 되는데, 여수를 광주라고 부르는 사람은 없다.
 * 검색어 기준으로 옛 광주광역시 5개 자치구(12210~12330)만 "광주",
 * 나머지는 "전남" 으로 표기한다. 행정 계층이 아니라 표기만 나눈다.
 */
const GWANGJU_GU = new Set(['12210', '12240', '12270', '12300', '12330']);
function sidoLabelFor(sido, sgg) {
  if (sido.code.slice(0, 2) !== '12') return sido.shortName;
  return GWANGJU_GU.has(sgg.code.slice(0, 5)) ? '광주' : '전남';
}

/** 모든 시군구를 한 줄로 편다. 슬러그가 평면이라 목록도 평면이 편하다. */
const allRegions = [];
for (const sido of regions.sido) {
  for (const sgg of sido.sigungu) {
    allRegions.push({
      code: sgg.code.slice(0, 5),
      sidoLabel: sidoLabelFor(sido, sgg),
      sigunguLabel: sgg.shortName,
      repDong: sgg.repDong,
      dongCount: sgg.dongCount,
    });
  }
}

/*
 * 슬러그 씨앗은 도메인이 아니라 site.key 다 — 도메인을 바꿔도 URL 이 살아 있어야 한다.
 * 지역·서비스·사례를 한 번에 배정한다. 따로 부르면 지역 슬러그와 서비스 슬러그가
 * 같은 값으로 나올 수 있고, 그러면 한쪽이 다른 쪽을 덮어쓴다.
 */
const SIDO_KEYS = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산',
  '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const slugKeys = [
  ...allRegions.map((r) => `r:${r.code}`),
  ...services.map((s2) => `s:${s2.key}`),
  ...realCases.map((c, i) => `c:${c.id || i}`),
  ...SIDO_KEYS.map((n) => `p:${n}`),
  'c:index',
];
const slugs = assignSlugs(siteKey, slugKeys, { words: site.slugWords });
for (const r of allRegions) r.slug = slugs.get(`r:${r.code}`);
for (const s2 of services) s2.slug = slugs.get(`s:${s2.key}`);
realCases.forEach((c, i) => { c.slug = slugs.get(`c:${c.id || i}`); });
const casesIndexSlug = slugs.get('c:index');

/*
 * 3단계에서는 URL 이 의미를 갖는다 (/seoul/gangnamgu/toilet-clog).
 * 평면 사이트의 난수 슬러그와 정반대다. 시군구 이름이 여러 시도에 겹치면
 * (중구·동구·고성군) 상위 지역을 앞에 붙여 가른다.
 */
if (TIERED) {
  const sidoSlugOf = new Map();
  for (const sd of regions.sido) sidoSlugOf.set(sd.shortName, romanize(sd.shortName));
  const romanMap = romanizeUnique(allRegions.map((r) => ({
    key: r.code, name: r.sigunguLabel, prefix: r.sidoLabel,
  })));
  for (const r of allRegions) {
    r.slug = romanMap.get(r.code);
    r.sidoSlug = sidoSlugOf.get(r.sidoLabel) || romanize(r.sidoLabel);
  }
  const bad = allRegions.filter((r) => !r.slug || !r.sidoSlug);
  if (bad.length) throw new Error(`로마자 슬러그가 빈 지역: ${bad.slice(0, 3).map((r) => r.sigunguLabel).join(', ')}`);
}

/** 지역 페이지 주소. 3단계면 /{시도}/{시군구}/, 평면이면 /{슬러그}/. */
/*
 * 시군구 이름은 여러 시도에 겹친다 — 중구가 5곳, 동구가 5곳, 고성군이 2곳이다.
 * 이름만으로 주소를 만들면 서울 중구 글이 부산 중구 글에 덮인다 (실제로 79장이 사라졌다).
 * 겹치는 이름에만 시도를 붙인다. 안 겹치는 이름은 그대로 둔다 — 검색어가 길어지면 손해다.
 */
const dupSigungu = new Set();
{
  const cnt = new Map();
  for (const r of allRegions) cnt.set(r.sigunguLabel, (cnt.get(r.sigunguLabel) || 0) + 1);
  for (const [name, n] of cnt) if (n > 1) dupSigungu.add(name);
}
const blogLabel = (r) => (dupSigungu.has(r.sigunguLabel)
  ? `${r.sidoLabel} ${r.sigunguLabel}`
  : r.sigunguLabel);
/* 주소와 해시태그에는 공백을 남길 수 없다 — "수원시 영통구" 처럼 띄어 쓴 이름이 있다. */
const blogSlugLabel = (r) => blogLabel(r).replace(/\s+/g, '');

/*
 * 블로그형의 글 주소. 슬러그를 만드는 곳이 두 군데(목록·본문)라 여기 한 번만 적는다 —
 * 두 곳에서 따로 만들면 한 글자만 어긋나도 링크가 죽는다.
 */
function blogPostSlug(r, kw, kind) {
  const seed = hash(`${siteKey}|${r.code}|${kw.slug}|${kind.slug}`);
  const work = blogData.works[seed % blogData.works.length];
  return `${blogSlugLabel(r)}${kw.slug}-${work}-${kind.slug}`;
}

/** 지역 대표 주소. 블로그형은 지역 페이지가 없으므로 그 구의 첫 글로 보낸다. */
const regionHref = (r) => {
  if (TIERED) return `/${r.sidoSlug}/${r.slug}/`;
  if (BLOG) return `/${blogPostSlug(r, blogData.keywords[0], blogData.kinds[0])}/`;
  return `/${r.slug}/`;
};

/** 표기 기준으로 다시 묶는다 (전남/광주가 갈린 뒤의 순서). */
const SIDO_ORDER = ['서울', '경기', '인천', '부산', '대구', '광주', '대전', '울산',
  '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const byLabel = new Map();
for (const r of allRegions) {
  if (!byLabel.has(r.sidoLabel)) byLabel.set(r.sidoLabel, []);
  byLabel.get(r.sidoLabel).push(r);
}
const sidoGroups = SIDO_ORDER
  .filter((label) => byLabel.has(label))
  .map((label) => ({
    label,
    items: byLabel.get(label),
    // 3단계는 로마자(/seoul/), 평면은 난수 슬러그
    slug: TIERED ? romanize(label) : slugs.get(`p:${label}`),
  }));
if (sidoGroups.length !== byLabel.size) {
  const missing = [...byLabel.keys()].filter((l) => !SIDO_ORDER.includes(l));
  throw new Error(`SIDO_ORDER 에 없는 시도: ${missing.join(', ')}`);
}

/* ────────────────────────────────────────────────────────────
   결정적 선택 — 같은 입력이면 늘 같은 결과. 재빌드로 페이지가 흔들리면 안 된다.
   ──────────────────────────────────────────────────────────── */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const pick = (arr, seed) => arr[hash(seed) % arr.length];

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * 풀에서 count 개를 겹치지 않게 뽑는다. 시작점과 보폭을 둘 다 시드로 바꾸므로
 * 인접한 지역끼리도 같은 조합이 잘 안 나온다 (배관 렌더러와 같은 방식).
 */
function pickRotated(list, count, seed) {
  const size = list.length;
  if (!size) return [];
  let step = 1 + ((seed * 2) % Math.max(1, size - 1));
  while (gcd(step, size) !== 1) step += 1;
  const start = (seed * 3) % size;
  const out = [];
  for (let i = 0; i < size && out.length < count; i += 1) {
    const v = list[(start + i * step) % size];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/*
 * 사진 고르기는 pickRotated 를 쓰면 안 된다. 보폭이 시드에 따라 몇 가지로만
 * 갈려서, 10장을 넣어도 서로 다른 조합이 20가지밖에 안 나오고 같은 석 장이
 * 24개 페이지에 똑같이 붙는다. 조합에 번호를 매겨 시드로 곧장 고르면
 * 10장으로 105가지가 나오고 같은 조합은 최대 5장까지만 겹친다.
 */
function nCk(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
function combinationAt(n, k, index) {
  const out = [];
  let rest = index;
  for (let i = 0; i < n && out.length < k; i += 1) {
    const c = nCk(n - i - 1, k - out.length - 1);
    if (rest < c) out.push(i); else rest -= c;
  }
  return out;
}
/** 풀에서 count 장을 시드로 고른다. 조합이 고르게 퍼진다. */
/*
 * 목록이 크면 조합 방식이 못 쓴다. nCk(3072,40) 이 1e91 이라 seed % 그 값 이
 * 사실상 seed 자신이 되고, 늘 첫 조합(= 앞에서 40개)만 나온다. 실제로 최근 글
 * 40편이 전부 서울로 쏠렸다. 그럴 때는 목록 전체를 고르게 훑는다.
 */
function pickSpread(list, count, seed) {
  const n = list.length;
  if (!n) return [];
  if (n <= count) return list.slice();
  const step = Math.floor(n / count);
  const start = seed % n;
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < count; i += 1) {
    const idx = (start + i * step + (seed % step)) % n;
    if (seen.has(idx)) { if (seen.size >= n) break; continue; }
    seen.add(idx);
    out.push(list[idx]);
  }
  return out;
}

function pickCombination(list, count, seed) {
  const n = list.length;
  if (!n) return [];
  if (n <= count) return list.slice();
  const total = nCk(n, count);
  return combinationAt(n, count, seed % total).map((i) => list[i]);
}

/** 풀 문자열의 {지역} {구} {시도} {동} 자리를 채운다. */
function fillPlaceholders(text, vars) {
  return String(text).replace(/\{(지역|구|시도|동|동2|동3|키워드)\}/g, (m, k) => vars[k] ?? m);
}
const fillDeep = (value, vars) => {
  if (typeof value === 'string') return fillPlaceholders(value, vars);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)]));
  }
  return value;
};

/* ────────────────────────────────────────────────────────────
   페이지
   ──────────────────────────────────────────────────────────── */

/*
 * nav 는 페이지 종류마다 다르다. 지역 페이지에서 "서비스" 를 눌렀을 때 홈으로
 * 튕기면 어렵게 들어온 지역 맥락이 날아간다 — 그 페이지에 그 섹션이 있으면
 * 제자리 앵커로, 없으면 홈으로 보낸다.
 */
/*
 * 페이지에 실제로 있는 구역은 템플릿에서 읽는다. 목록을 손으로 관리하면
 * 구역 순서를 바꿀 때마다 nav 가 조용히 어긋난다(있는 구역인데 홈으로 튕긴다).
 */
const idsIn = (...names) => new Set(names.flatMap((n) => [
  ...(rawTemplates[n] || '').matchAll(/id="([a-z]+)"/g),
].map((m) => m[1])));
const EST = 'partials/estimate-form.html';
const SECTIONS = {
  home: idsIn('home.html', EST),
  region: idsIn('region.html', EST),
  service: idsIn('service.html', EST),
  caseOne: idsIn('case.html', EST),
  caseList: idsIn('case-list.html'),
  area: idsIn('area-hub.html'),
  sido: idsIn('sido-hub.html'),
};

/*
 * ─────────────────────────────────────────────────────────────
 * nav 모델 — 다섯 사이트가 서로 다른 정보 구조를 갖는 지점.
 *
 * 색·글꼴·구역 순서만 바꾸는 것으로는 "같은 사람이 만든 다섯 개" 를 못 벗어난다.
 * 실제 업체 사이트들이 갈리는 곳은 **메뉴가 무엇을 가리키느냐** 다.
 *   하림배관  메뉴에 지역(구)이 들어간 허브형
 *   누수도사  메뉴에 메인 키워드가 들어간 키워드형
 * 그래서 site.navModel 로 사이트마다 다른 모델을 쓴다.
 *
 *   sections  구역 앵커 (원페이지형)
 *   services  서비스 키워드 5종이 메뉴
 *   sido      시도가 메뉴 (시도 허브 페이지 17장이 따로 생긴다)
 *   mixed     목적별 혼합 (요금·사례·지역·접수)
 * ─────────────────────────────────────────────────────────────
 */
/*
 * 메뉴는 계층으로 짠다. 레퍼런스(하림배관)가 드롭다운으로 지역과 서비스를 묶는데,
 * 우리는 링크를 평평하게 늘어놓기만 해서 드림은 nav 한 줄에 14개가 깔렸다.
 * 항목에 children 이 있으면 layout 이 <details> 로 편다 — 자바스크립트 없이
 * 터치·키보드에서 다 열린다.
 */
const link = (href, label) => ({ href, label, isGroup: false });
const group = (label, children) => ({ href: '', label, isGroup: true, children });

/** 서비스 13종을 성격별로 묶는다. 목록이 길어지면 묶어야 눈에 들어온다. */
function serviceGroups() {
  const by = (...keys) => keys
    .map((k) => services.find((s2) => s2.key === k))
    .filter(Boolean)
    .map((s2) => link(`/${s2.slug}/`, s2.name));
  const groups = [
    ['막힘', by('toilet', 'drain', 'sink', 'basin')],
    ['청소·세척', by('jet', 'stack', 'sewer', 'rain')],
    ['점검·교체', by('scope', 'odor', 'trap', 'swap', 'leak')],
  ].filter(([, items]) => items.length);
  // 아직 5종뿐인 사이트는 묶을 것이 없다. 그때는 한 덩어리로 둔다.
  if (services.length <= 6) return [group('서비스', services.map((s2) => link(`/${s2.slug}/`, s2.name)))];
  return groups.map(([label, items]) => group(label, items));
}

/*
 * 지역 묶음은 레퍼런스의 계층을 그대로 따른다.
 *   서울 구 단위 / 경기 시·구 단위 / 인천 구 단위 / 대전·세종·충청권 / 그 외
 */
const SIDO_BUNDLES = [
  ['서울', ['서울']],
  ['경기', ['경기']],
  ['인천', ['인천']],
  ['충청권', ['대전', '세종', '충북', '충남']],
  ['영남권', ['부산', '대구', '울산', '경북', '경남']],
  ['호남·강원·제주', ['광주', '전남', '전북', '강원', '제주']],
];

function sidoNav() {
  const found = (name) => sidoGroups.find((g) => g.label === name);
  return SIDO_BUNDLES.map(([label, names]) => {
    const gs = names.map(found).filter(Boolean);
    if (!gs.length) return null;
    // 시도 하나짜리 묶음은 그 시도의 시군구를 바로 편다 (서울 -> 25개 구)
    if (gs.length === 1) {
      return group(label, [
        link(`/${gs[0].slug}/`, `${gs[0].label} 전체`),
        ...gs[0].items.map((r) => link(`/${r.slug}/`, r.sigunguLabel)),
      ]);
    }
    return group(label, gs.map((g) => link(`/${g.slug}/`, `${g.label} ${g.items.length}곳`)));
  }).filter(Boolean);
}

function navFor(kind) {
  const here = SECTIONS[kind] || new Set();
  const anchor = (a, label) => link(here.has(a) ? `#${a}` : `/#${a}`, label);

  /*
   * 3단계는 메뉴도 계층이다. 키워드 13종을 묶어서 하나, 시도 17개를 묶어서 하나.
   * 동 단위는 넣지 않는다 — 운영자 지시대로 구까지만 내려간다.
   */
  if (TIERED) {
    const byGroup = new Map();
    for (const k of keywords) {
      if (!byGroup.has(k.group)) byGroup.set(k.group, []);
      byGroup.get(k.group).push(k);
    }
    const kwGroups = [...byGroup.entries()].map(([g, ks]) => group(
      keywordData.groups[g].what,
      ks.map((k) => link(`/services/${k.slug}/`, k.label)),
    ));
    return [
      // 묶음은 /services/<키워드>/ 로 바로 간다. 목록 자체로 가는 길이 없으면
      // /services/ 가 고립된다 (실제로 그랬다).
      link('/services/', '하는 일'),
      ...kwGroups,
      group(site.navAreaLabel || '지역',
        sidoGroups.map((g) => link(`/${g.slug}/`, `${g.label} ${g.items.length}곳`))),
      link('/area/', '전체 지역'),
    ];
  }

  switch (site.navModel) {
    case 'services':
      return [...serviceGroups(), link('/area/', site.navAreaLabel || '지역')];

    /*
     * 하림배관형. 서비스 묶음 옆에 지역이 계층으로 붙는다 —
     * [지역 ▾] 을 열면 시도가 나오고, 시도를 열면 그 시도의 시군구가 나온다.
     * 동 단위는 넣지 않는다 (운영자 지시: 구까지만, 키워드만).
     * 2단계 메뉴라 이 모델을 쓰는 템플릿의 layout 이 중첩을 그릴 수 있어야 한다.
     */
    case 'harim':
      return [
        ...serviceGroups(),
        group(site.navAreaLabel || '지역',
          sidoGroups.map((g) => group(`${g.label} ${g.items.length}`,
            g.items.map((r) => link(regionHref(r), r.sigunguLabel))))),
        link('/area/', '전체 보기'),
      ];

    case 'sido':
      return [...sidoNav(), link('/area/', site.navAreaLabel || '전체 지역')];

    /*
     * 키워드 나열형(하수구박사). 서비스를 묶지 않고 전부 최상위에 편다.
     * 드림의 묶음형과 정반대 — 메뉴 자체가 키워드 목록 역할을 한다.
     */
    case 'keywords':
      return [
        // 블로그형은 글이 본체다. 메뉴에서 바로 갈 수 있어야 한다.
        ...(BLOG ? [link('/blog/', '배관 정보 글')] : []),
        ...services.map((s2) => link(`/${s2.slug}/`, s2.name)),
        ...(realCases.length ? [link(`/${casesIndexSlug}/`, '공사실적')] : []),
        link('/area/', site.navAreaLabel || '출동지역'),
      ];

    case 'mixed':
      return [
        ...(realCases.length ? [link(`/${casesIndexSlug}/`, '작업 사례')] : []),
        anchor('price', '요금'),
        ...serviceGroups(),
        link('/area/', site.navAreaLabel || '지역'),
        anchor('estimate', '접수'),
      ];

    case 'sections':
    default:
      return site.nav
        .filter((n) => !(n.homeOnly && kind !== 'home') && !(n.regionOnly && kind !== 'region'))
        .filter((n) => n.href || here.has(n.anchor) || SECTIONS.home.has(n.anchor))
        .map((n) => (n.href ? link(n.href, n.label) : anchor(n.anchor, n.label)));
  }
}

/*
 * 블로그형은 글 목록을 먼저 만들어 둔다. 글끼리 이어 주려면 옆 글의 주소와
 * 제목을 알아야 하는데, 쓰면서 만들면 아직 안 만든 글은 주소를 모른다.
 * 홈에서도 최근 글을 걸어야 해서 홈보다 앞에 둔다.
 *
 * 링크가 없으면 검색으로 한 장에 들어온 사람이 나머지 3,071장을 못 보고,
 * 크롤러도 /area/ 를 거치지 않으면 못 찾는다.
 */
/*
 * 목록 위 지역 탭. 시도 17개를 그대로 늘어놓으면 탭이 화면을 넘어간다.
 * 권역으로 묶되 서울·경기인천은 물량이 많아 따로 둔다.
 */
const BLOG_ZONES = [
  { key: 'seoul', label: '서울', sido: ['서울'] },
  { key: 'gyeongin', label: '경기·인천', sido: ['경기', '인천'] },
  { key: 'chungcheong', label: '충청', sido: ['대전', '세종', '충북', '충남'] },
  { key: 'yeongnam', label: '영남', sido: ['부산', '대구', '울산', '경북', '경남'] },
  { key: 'honam', label: '호남', sido: ['광주', '전남', '전북'] },
  { key: 'gangwonjeju', label: '강원·제주', sido: ['강원', '제주'] },
];
const zoneOf = (sidoLabel) => (BLOG_ZONES.find((z) => z.sido.includes(sidoLabel)) || {}).key || 'etc';

/*
 * 게시일. 업장을 2026년 3월에 열었으므로 그때부터 오늘까지 흩뿌린다.
 * 실제 작업 날짜가 아니라 글을 올린 날이다 (운영자 확인 2026-08-31).
 * 고르게 나누지 않고 시드로 흩는다 — 매일 같은 편수가 올라오는 블로그는 없다.
 */
const BLOG_OPEN = Date.UTC(2026, 2, 1);          // 2026-03-01
const BLOG_LAST = Date.UTC(2026, 7, 31);         // 오늘
const BLOG_DAYS = Math.round((BLOG_LAST - BLOG_OPEN) / 86400000);
function postedAt(seed) {
  // 날짜와 시각을 따로 흩는다. 같은 날에 여러 편이 몰리기도 하고 비는 날도 생긴다.
  const day = hash(`d|${seed}`) % (BLOG_DAYS + 1);
  const hour = 8 + (hash(`h|${seed}`) % 13);     // 08~20시
  const min = hash(`m|${seed}`) % 60;
  return new Date(BLOG_OPEN + day * 86400000 + hour * 3600000 + min * 60000);
}
const ymd = (d) => `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  + `.${String(d.getUTCDate()).padStart(2, '0')}`;

const blogPosts = [];
const postsByRegion = new Map();
const postsByKeyword = new Map();
if (BLOG) {
  for (const r of allRegions) {
    for (const kw of blogData.keywords) {
      for (const kind of blogData.kinds) {
        const seed = hash(`${siteKey}|${r.code}|${kw.slug}|${kind.slug}`);
        const work = blogData.works[seed % blogData.works.length];
        blogPosts.push({
          r, kw, kind, work, seed,
          slug: blogPostSlug(r, kw, kind),
          title: `${blogLabel(r)}${kw.label} ${work} ${kind.label}`,
          zone: zoneOf(r.sidoLabel),
          area: `${r.sidoLabel} ${r.sigunguLabel}`,
          at: postedAt(seed),
        });
      }
    }
  }
  // 최신순. 이러면 지역이 자연스럽게 섞이고 게시판처럼 읽힌다.
  blogPosts.sort((a, b) => b.at - a.at);
  for (const t of blogPosts) {
    if (!postsByRegion.has(t.r.code)) postsByRegion.set(t.r.code, []);
    postsByRegion.get(t.r.code).push(t);
    if (!postsByKeyword.has(t.kw.slug)) postsByKeyword.set(t.kw.slug, []);
    postsByKeyword.get(t.kw.slug).push(t);
  }
}

/** 어느 페이지에서든 5종 서비스로 갈 수 있게 한다. 내부 링크의 뼈대다. */
const serviceLinks = TIERED
  ? keywords.map((k) => ({ href: `/services/${k.slug}/`, label: k.label }))
  : services.map((s2) => ({ href: `/${s2.slug}/`, label: s2.name }));

/*
 * 로고 마크는 사이트마다 가로세로가 다르다(마스코트 모양이 달라 잘린 크기가 다르다).
 * width/height 를 고정값으로 박으면 그림이 눌리거나 자리가 밀린다. 파일에서 읽는다.
 */
const markSize = (() => {
  const buf = readFileSync(join(templateDir, 'assets', 'img', 'logo-mark.png'));
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('logo-mark.png 가 PNG 가 아닙니다.');
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
})();

const base = {
  siteUrl,
  // og:site_name. 레퍼런스는 여기에 키워드와 전화번호를 통째로 넣는다.
  // 다섯이 다 그러면 또 한 회사로 보이므로 두 곳만 그렇게 쓴다.
  siteName: site.siteName || site.brand,
  markW: markSize.w,
  markH: markSize.h,
  brand: site.brand,
  brandHead: site.brandHead,
  brandTail: site.brandTail,
  phone: site.phone,
  phoneRaw: site.phoneRaw,
  assetVersion: site.assetVersion,
  fontHref: site.fontHref,
  strip: site.strip,
  endHeading: site.endHeading,
  endLede: site.endLede,
  badges: site.badges,
  footerNote: site.footerNote,
  year: new Date().getFullYear(),
  regionCount: allRegions.length,
  serviceLinks,
  hasCases: realCases.length > 0,
  casesHref: `/${casesIndexSlug}/`,
};

/**
 * 접수 폼. 지역 페이지에서는 시/도·시/군/구를 미리 채워 연다 — 그 지역을 보고
 * 들어온 사람에게 같은 걸 또 고르게 할 이유가 없다.
 */
function estimateForm({
  no, heading, lede, sido = '', sigungu = '',
}) {
  return renderTemplate(templates.estimate, {
    estimateNo: no,
    estimateHeading: heading,
    estimateLede: lede,
    leadApi: site.leadApi,
    leadProject: site.leadProject,
    leadArea: [sido, sigungu].filter(Boolean).join(' '),
    selectedSido: sido,
    selectedSigungu: sigungu,
    phone: site.phone,
    phoneRaw: site.phoneRaw,
    formHomeTypes: site.formHomeTypes || [],
    formSpaces: site.formSpaces || [],
    formWhen: site.formWhen || [],
  });
}

/*
 * "01 — 서비스" 같은 구역 번호를 화면에 나온 순서대로 다시 매긴다.
 * 템플릿에 숫자를 박아두면 구역 순서를 바꿀 때마다 번호가 어긋난다.
 */
function renumberSections(html) {
  let n = 0;
  return html.replace(/>(\d{2}) — /g, () => {
    n += 1;
    return `>${String(n).padStart(2, '0')} — `;
  });
}

/*
 * 구조화 데이터. 레퍼런스(하수구박사)를 그대로 따라간다 —
 * WebPage · BreadcrumbList · WebSite 를 @graph 하나에 묶고, 거기에 그 페이지의
 * 본체(LocalBusiness / Service / BlogPosting)를 더한다.
 *
 * 안 넣는 것
 *   FAQPage                        운영자 지시 (2026-08-31)
 *   Organization·PostalAddress     사업자 정보를 넣지 않기로 했다.
 *                                  레퍼런스도 구조화 데이터에는 안 넣는다
 *   AggregateRating·Review         실제 후기가 없다
 */
const BUILT_AT = new Date().toISOString();

function buildGraph({ canonical, title, description, jsonLd, crumbs, published, modified }) {
  const graph = [{
    '@type': 'WebPage',
    '@id': canonical,
    url: canonical,
    name: title,
    description,
    isPartOf: { '@id': `${siteUrl}/#website` },
    // 글이면 그 글의 게시일. 아니면 굽는 시각.
    ...(published ? { datePublished: published } : {}),
    dateModified: modified || published || BUILT_AT,
    inLanguage: 'ko-KR',
    ...(crumbs && crumbs.length ? { breadcrumb: { '@id': `${canonical}#breadcrumb` } } : {}),
  }];
  if (crumbs && crumbs.length) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': `${canonical}#breadcrumb`,
      itemListElement: crumbs.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: c.name,
        // 마지막 조각(현재 페이지)에는 item 을 붙이지 않는다 — 스키마 권장이다
        ...(c.href ? { item: `${siteUrl}${c.href}` } : {}),
      })),
    });
  }
  graph.push({
    '@type': 'WebSite',
    '@id': `${siteUrl}/#website`,
    url: `${siteUrl}/`,
    name: site.siteName || site.brand,
    description: site.siteDescription || site.h1sub || site.brand,
    inLanguage: 'ko-KR',
  });
  if (jsonLd) graph.push(jsonLd);
  return { '@context': 'https://schema.org', '@graph': graph };
}

function page({
  path, kind, title, description, main, jsonLd, crumbs, ogType, published, modified,
}) {
  const canonical = `${siteUrl}${path}`;
  const html = renderTemplate(templates.layout, {
    ...base,
    nav: navFor(kind),
    title,
    description,
    canonical,
    // 홈·목록은 website, 글 성격의 페이지는 article (레퍼런스와 같다)
    ogType: ogType || (kind === 'home' ? 'website' : 'article'),
    publishedTime: published || '',
    hasPublished: published ? [{ t: published }] : [],
    modifiedTime: modified || published || BUILT_AT,
    jsonLd: JSON.stringify(buildGraph({
      canonical, title, description, jsonLd, crumbs, published, modified,
    })),
    main: renumberSections(main),
  });
  const dir = join(outRoot, siteKey, path === '/' ? '' : path.replace(/^\/|\/$/g, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  return canonical;
}

/*
 * 사진. 등록만 하고 파일을 안 넣으면 258장에 깨진 이미지가 박히므로 여기서 멈춘다.
 * 풀이 비어 있으면(아직 사진을 못 받았으면) 사진 구역 자체를 내보내지 않는다 —
 * 자리표시자 회색 상자를 실제 사이트에 띄우지는 않는다.
 */
const resolveImages = (list, what) => (list || []).map((img) => {
  const local = join(templateDir, 'assets', 'img', img.file);
  if (!existsSync(local)) throw new Error(`${what}이 없습니다: assets/img/${img.file}`);
  return { ...img, src: `/assets/${site.assetVersion}/img/${img.file}` };
});

/*
 * 사진 풀이 두 갈래다.
 *   pool   지역·서비스·홈에서 3장씩 돌려 쓰는 사진
 *   cases  작업사례 전용. 문제확인 → 원인진단 → 작업완료 로 이어지는 단계 컷이라
 *          지역 페이지에 한 장씩 떼어 놓으면 문맥이 없다. 그래서 섞지 않는다.
 */
const imagePool = resolveImages(site.images?.pool, '이미지');
const casePool = resolveImages(site.images?.cases, '사례 이미지');

const orgLd = {
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name: site.brand,
  telephone: site.phone,
  url: siteUrl,
  areaServed: { '@type': 'Country', name: '대한민국' },
  openingHours: 'Mo-Su 00:00-24:00',
};

/*
 * 굽기 전에 지난 산출물을 비운다. 슬러그가 바뀌면 옛 폴더가 그대로 남아
 * 사이트맵에 없는 유령 페이지가 웹루트에 쌓인다(실제로 256장이 남아 510장이 됐다).
 * 지우는 범위는 이 사이트의 출력 폴더 하나뿐이고, 우리 산출물인지 확인한 뒤에만 지운다.
 */
const siteOut = join(outRoot, siteKey);
if (existsSync(siteOut)) {
  const entries = readdirSync(siteOut);
  const ours = entries.every((e) => ['index.html', 'sitemap.xml', 'robots.txt', 'assets'].includes(e)
    || statSync(join(siteOut, e)).isDirectory());
  if (!ours) {
    throw new Error(`${siteOut} 에 우리 산출물이 아닌 파일이 있습니다. 확인 후 직접 지우세요.`);
  }
  rmSync(siteOut, { recursive: true, force: true });
}

const urls = [];

/* ── 홈 ── */
urls.push(page({
  path: '/',
  kind: 'home',
  title: `${site.brand} — 변기·하수구 막힘 24시간 출동`,
  description: `${site.h1sub} ${site.brand}. 전국 출동, 현장 확인 후 견적.`,
  jsonLd: orgLd,
  main: renderTemplate(templates.home, {
    ...base,
    kicker: site.kicker,
    h1a: site.h1a,
    h1b: site.h1b,
    h1sub: site.h1sub,
    boardTitle: site.boardTitle,
    board: site.board,
    serviceHeading: site.serviceHeading,
    serviceLede: site.serviceLede,
    jobs: site.jobs,
    causeHeading: site.causeHeading,
    causeLede: site.causeLede,
    causes: site.causes,
    priceHeading: site.priceHeading,
    price: site.price,
    priceNote: site.priceNote,
    caseHeading: site.caseHeading,
    cases: site.cases,
    faqHeading: site.faqHeading,
    faq: site.faq,
    areaHeading: site.areaHeading,
    areaLede: site.areaLede,

    /*
     * 브리프(template.md)가 요구하는 구역들. 사이트마다 쓰는 것이 다르고,
     * 템플릿이 안 쓰면 그냥 무시된다. 데이터가 없으면 구역을 안 만든다 —
     * 후기·장비·사업자 정보를 지어내지 않기 위해서다.
     */
    /*
     * 홈 사진. 지금까지 홈에는 사진이 하나도 없었다 — 지역 페이지에만 붙였다.
     * 첫 화면에 현장이 안 보이면 실제로 일하는 곳인지 알 수가 없다.
     * 히어로 한 장 + 아래 띠 세 장으로 나눠 쓴다.
     */
    /* 히어로 배경. 글자가 위에 얹히므로 어둡게 덮는 층은 CSS 가 깐다. */
    heroBg: site.heroImage
      ? [{ ...site.heroImage,
          src: `/assets/${site.assetVersion}/img/${site.heroImage.file}`,
          alt: `${site.brand} ${site.heroImage.label}` }]
      : [],
    hasPhotos: imagePool.length > 0,
    heroShot: imagePool.length
      ? [{ ...imagePool[0], alt: `${site.brand} ${imagePool[0].label}` }]
      : [],
    homeShots: pickCombination(imagePool, 3, hash(`${siteKey}|home|shots`))
      .map((img) => ({ ...img, alt: `${site.brand} ${img.label}` })),
    // 블로그형 홈에만 쓰인다. 다른 템플릿은 이 값을 안 읽는다.
    postHeading: site.postHeading || '',
    postLede: site.postLede || '',
    homePosts: pickSpread(blogPosts, 8, hash(`${siteKey}|home|posts`))
      .map((t) => ({ href: `/${t.slug}/`, title: t.title })),
    ctaCall: site.ctaCall,
    ctaForm: site.ctaForm,
    heroPromises: site.heroPromises,
    heroPhoto: site.heroPhoto
      ? [{ ...site.heroPhoto, alt: `${site.brand} ${site.heroPhoto.label || ''}`.trim() }]
      : [],
    symptomHeading: site.symptomHeading,
    symptomLede: site.symptomLede,
    // 증상 선택 UI — 서비스에 symptom 이 달린 것만 나온다
    symptoms: services.filter((s2) => s2.symptom)
      .map((s2) => ({ q: s2.symptom, href: `/${s2.slug}/` })),
    promiseHeading: site.promiseHeading,
    promiseLede: site.promiseLede,
    promises: site.promises,
    processHeading: site.processHeading,
    processLede: site.processLede,
    process: site.process,
    reviewHeading: site.reviewHeading,
    reviewPending: site.reviewPending,
    formHomeTypes: site.formHomeTypes,
    formSpaces: site.formSpaces,
    formWhen: site.formWhen,
    estimateForm: estimateForm({
      no: '04', heading: site.estimateHeading, lede: site.estimateLede,
    }),
    // 홈에는 시도마다 대표로 한 곳씩만 건다. 256개를 홈에 다 걸면 링크가 묽어진다.
    areaLinks: sidoGroups.map((g) => {
      const r = pick(g.items, `${siteKey}|home|${g.label}`);
      return { href: regionHref(r), label: `${g.label} ${r.sigunguLabel}` };
    }),
  }),
}));

/* ── /area/ ── */
urls.push(page({
  path: '/area/',
  kind: 'area',
  crumbs: [{ name: '홈', href: '/' }, { name: site.hubHeadingPlain || '서비스 지역' }],
  title: `서비스 지역 — ${site.brand}`,
  description: `${site.brand} 출동 지역 ${allRegions.length}곳. 시·군·구별 안내.`,
  jsonLd: orgLd,
  main: renderTemplate(templates.areaHub, {
    ...base,
    hubHeading: site.hubHeading,
    hubLede: site.hubLede,
    sido: sidoGroups.map((g) => ({
      label: g.label,
      count: g.items.length,
      items: g.items.map((r) => ({ href: regionHref(r), label: r.sigunguLabel })),
    })),
  }),
}));

/* ── /privacy/ ──
   접수폼을 받는 이상 별도 페이지가 있어야 한다. 문구는 배관 프로젝트에서
   쓰던 것을 그대로 가져왔다 — 새로 지으면 어느 쪽이 맞는지 알 수 없게 된다. */
if (templates.privacy) {
  urls.push(page({
    path: '/privacy/',
    kind: 'privacy',
    crumbs: [{ name: '홈', href: '/' }, { name: '개인정보 수집 및 이용 동의' }],
    title: `개인정보 수집 및 이용 동의 — ${site.brand}`,
    description: `${site.brand} 개인정보 수집항목·이용목적·보유기간 안내.`,
    jsonLd: orgLd,
    main: renderTemplate(templates.privacy, { ...base }),
  }));
}

/* ── 시군구 × 256 ── */
const DONG_LIMIT = 60;   // 레퍼런스(하림배관)가 한 페이지에 62조합을 쓴다
const NEAR_LIMIT = 12;

/*
 * 지역 페이지는 256장이 서로 다른 글이어야 한다. 같은 문단이 256번 반복되면
 * 사람이 봐도 기계가 봐도 한 장을 복사한 것이다. 그래서 문단·항목을 전부 풀에서
 * 뽑는다 — 뽑는 기준은 (사이트키, 지역코드) 시드라서 재빌드해도 같은 글이 나온다.
 */
for (const r of (TIERED || BLOG ? [] : allRegions)) {
  const full = `${r.sidoLabel} ${r.sigunguLabel}`;
  const seed = hash(`${siteKey}|${r.code}`);
  const dongPick = pickRotated(r.repDong, 3, seed);
  const vars = {
    지역: full,
    구: r.sigunguLabel,
    시도: r.sidoLabel,
    동: dongPick[0] || r.sigunguLabel,
    동2: dongPick[1] || dongPick[0] || r.sigunguLabel,
    동3: dongPick[2] || dongPick[0] || r.sigunguLabel,
  };
  const one = (poolName, offset = 0) => fillPlaceholders(
    pools[poolName][(seed + offset) % pools[poolName].length], vars,
  );
  const many = (poolName, count, offset = 0) => fillDeep(
    pickRotated(pools[poolName], count, seed + offset), vars,
  );

  const kws = site.regionKeywords;
  const dongs = r.repDong.slice(0, DONG_LIMIT).map((name) => {
    // 동마다 다른 키워드 두 개. 같은 페이지 안에서 문구가 반복되지 않게 한다.
    const a = hash(`${siteKey}|${r.code}|${name}`) % kws.length;
    const b = (a + 1 + (hash(`${name}|${r.code}`) % (kws.length - 1))) % kws.length;
    return { name, kw: `${name} ${kws[a]} · ${name} ${kws[b]}` };
  });

  const group = sidoGroups.find((g) => g.label === r.sidoLabel).items;
  const others = group.filter((x) => x.code !== r.code);
  const start = others.length ? hash(`${siteKey}|near|${r.code}`) % others.length : 0;
  const near = [];
  for (let i = 0; i < Math.min(NEAR_LIMIT, others.length); i += 1) {
    const n = others[(start + i) % others.length];
    near.push({ href: `/${n.slug}/`, label: n.sigunguLabel });
  }

  const jobs = many('jobs', 4).map((j, i) => ({ ...j, no: String(i + 1).padStart(2, '0') }));
  const cases = many('cases', 3).map((c, i) => ({ ...c, id: `CASE ${String(i + 1).padStart(3, '0')}` }));

  urls.push(page({
    path: `/${r.slug}/`,
    kind: 'region',
    crumbs: [{ name: '홈', href: '/' }, { name: `${r.sidoLabel} ${r.sigunguLabel}` }],
    title: `${r.sigunguLabel}${kws[0]} ${r.sigunguLabel}${kws[1]} ${kws[2]} - ${site.brand}`,
    description: `${full} 하수구·변기 막힘 24시간 출동. `
      + `${dongPick.join(' · ')} 등 ${r.repDong.length}개 동네. 현장 확인 후 견적.`,
    jsonLd: {
      ...orgLd,
      areaServed: { '@type': 'AdministrativeArea', name: full },
      url: `${siteUrl}/${r.slug}/`,
    },
    main: renderTemplate(templates.region, {
      ...base,
      sidoLabel: r.sidoLabel,
      sigunguLabel: r.sigunguLabel,
      /*
       * H1 은 "지역 + 키워드 나열" 이다. 레퍼런스(하림배관)가 H1 을 그렇게 쓴다.
       * 브랜드 문구를 H1 에 넣으면 검색엔진이 보는 가장 강한 자리에 키워드가 없어진다.
       * 붙여쓰기(강남구하수구막힘)를 앞에 두는 것도 레퍼런스와 같다 — 실제로 그렇게 검색한다.
       */
      regionH1: `${r.sigunguLabel}${kws[0]} ${r.sigunguLabel} ${kws[1]} ${kws[2]}`,
      regionTagline: one('heroTaglines'),
      regionLede: one('heroLedes'),
      dongCount: r.dongCount,
      board: site.board,
      serviceHeading: one('serviceHeadings'),
      serviceLede: one('serviceLedes', 1),
      jobs,
      dongHeading: one('dongHeadings'),
      dongLede: one('dongLedes', 2),
      dongs,
      causeHeading: one('causeHeadings'),
      causeLede: one('causeLedes', 3),
      causes: many('causes', 4, 5),
      priceHeading: one('priceHeadings'),
      /*
       * 요금은 회전시키지 않는다. 실제 금액이 들어간 뒤로는 페이지마다 항목이
       * 달라지면 안 된다 — 어떤 지역에서는 "변기 석션 10만원" 이 아예 안 보이게 된다.
       */
      price: fillDeep(pools.price, vars),
      priceNote: one('priceNotes', 4),
      faqHeading: one('faqHeadings'),
      faq: many('faq', 5, 11),
      hasPhotos: imagePool.length > 0,
      photoHeading: imagePool.length ? one('photoHeadings', 19) : '',
      /*
       * alt 에 지역명을 넣지 않는다. 같은 사진이 256개 구 페이지를 도는데
       * "인천 부평구 꺼낸 이물질" 이라고 적으면 거기서 찍은 사진이라는 말이 된다.
       * 사진에 실제로 있는 것만 적는다.
       */
      photos: pickCombination(imagePool, 3, hash(`${siteKey}|photo|${r.code}`)).map((img) => ({
        ...img, alt: `${site.brand} ${img.label}`,
      })),
      caseHeading: one('caseHeadings'),
      cases,
      estimateForm: estimateForm({
        no: '05',
        heading: one('estimateHeadings', 13),
        lede: one('estimateLedes', 17),
        sido: r.sidoLabel,
        sigungu: r.sigunguLabel,
      }),
      /*
       * 지역 페이지 본문. 레퍼런스(하림배관 5,300~7,000자 / 하수구박사 4,500~5,000자)에
       * 견주면 우리가 2,400자로 얇았다. 아래 다섯 구역이 그 차이를 메운다.
       * 지역별 특성(건물 연식 등)은 근거 데이터가 없으므로 만들지 않는다 —
       * 256개 구에 대해 지어내면 반드시 틀린 것이 섞인다.
       */
      /*
       * 지역 × 키워드 묶음. 빠져 있던 자리다 — 사람들은 "강남구 하수구막힘" 으로 검색하는데
       * 그 말이 제목에만 있고 본문 헤딩에는 하나도 없었다. 키워드마다 H3 를 세워
       * "{구} {키워드}" 가 본문에 실제로 박히게 한다. 레퍼런스가 하는 방식이다.
       */
      keywordHeading: fillPlaceholders(pools.keywordHeading, vars),
      keywordLede: fillPlaceholders(pools.keywordLede, vars),
      keywordBlurbs: pools.keywordBlurbs.map((b) => ({
        kw: b.kw,
        h: `${r.sigunguLabel} ${b.kw}`,
        body: fillPlaceholders(b.body, vars),
      })),
      preventHeading: fillPlaceholders(pools.preventHeading, vars),
      preventLede: fillPlaceholders(pools.preventLede, vars),
      prevent: many('prevent', 4, 29),
      buildingHeading: fillPlaceholders(pools.buildingHeading, vars),
      buildingLede: fillPlaceholders(pools.buildingLede, vars),
      building: fillDeep(pools.building, vars),
      seasonHeading: fillPlaceholders(pools.seasonHeading, vars),
      season: fillDeep(pools.season, vars),
      methodHeading: fillPlaceholders(pools.methodHeading, vars),
      methodLede: fillPlaceholders(pools.methodLede, vars),
      method: fillDeep(pools.method, vars),
      beforeHeading: fillPlaceholders(pools.beforeHeading, vars),
      beforeLede: fillPlaceholders(pools.beforeLede, vars),
      before: pools.before.map((t) => ({ text: fillPlaceholders(t, vars) })),
      nearHeading: `${r.sidoLabel} 다른 지역`,
      near,
    }),
  }));
}

/* ── 서비스 상세 × 5 ── */
const SERVICE_REGION_COUNT = 16;   // 서비스 -> 지역 링크. 시도마다 한 곳씩.
for (const svc of (TIERED ? [] : services)) {
  const seed = hash(`${siteKey}|svc|${svc.key}`);
  // 서비스 페이지마다 다른 지역으로 링크를 건다. 한 곳에 링크가 몰리지 않게.
  const spots = sidoGroups.map((g, i) => {
    const r = g.items[(seed + i * 7) % g.items.length];
    return { href: regionHref(r), label: `${g.label} ${r.sigunguLabel}` };
  }).slice(0, SERVICE_REGION_COUNT);

  urls.push(page({
    path: `/${svc.slug}/`,
    kind: 'service',
    crumbs: [{ name: '홈', href: '/' }, { name: '하는 일', href: '/area/' }, { name: svc.name }],
    title: `${svc.name} — ${site.brand}`,
    description: `${svc.lede} ${site.brand} ${svc.name}. 전국 출동.`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: svc.name,
      provider: { '@type': 'LocalBusiness', name: site.brand, telephone: site.phone },
      areaServed: { '@type': 'Country', name: '대한민국' },
      url: `${siteUrl}/${svc.slug}/`,
    },
    main: renderTemplate(templates.service, {
      ...base,
      svcName: svc.name,
      svcTitle: svc.title,
      svcLede: svc.lede,
      when: svc.when.map((t) => ({ text: t })),
      steps: svc.steps.map((st, i) => ({ ...st, no: String(i + 1).padStart(2, '0') })),
      avoid: svc.avoid.map((t) => ({ text: t })),
      svcNote: svc.note,
      faq: svc.faq,
      others: serviceLinks.filter((l) => l.href !== `/${svc.slug}/`),
      spots,
      estimateForm: estimateForm({
        no: '05', heading: site.estimateHeading, lede: site.estimateLede,
      }),
    }),
  }));
}

/* ── 작업사례 ──
   실제 사례가 없으면 목록도 개별 페이지도 만들지 않는다. 빈 목록 페이지를
   내보내는 것보다 아예 없는 편이 낫고, 지어낸 사례를 올릴 수는 없다. */
if (realCases.length) {
  urls.push(page({
    path: `/${casesIndexSlug}/`,
    kind: 'caseList',
    crumbs: [{ name: '홈', href: '/' }, { name: '작업 사례' }],
    title: `작업 사례 — ${site.brand}`,
    description: `${site.brand} 작업 사례 ${realCases.length}건. 어떤 증상이었고 무엇이 원인이었는지 정리했습니다.`,
    jsonLd: orgLd,
    main: renderTemplate(templates.caseList, {
      ...base,
      caseCount: realCases.length,
      cases: realCases.map((c) => ({
        href: `/${c.slug}/`, title: c.title, area: c.area || '', summary: c.summary || c.body.slice(0, 60),
      })),
    }),
  }));

  for (const c of realCases) {
    urls.push(page({
      path: `/${c.slug}/`,
      kind: 'caseOne',
      crumbs: [{ name: '홈', href: '/' }, { name: '작업 사례', href: `/${casesIndexSlug}/` }, { name: c.title }],
      title: `${c.title} — ${site.brand} 작업 사례`,
      description: `${c.area ? `${c.area} ` : ''}${c.title}. ${c.body.slice(0, 80)}`,
      jsonLd: orgLd,
      main: renderTemplate(templates.caseOne, {
        ...base,
        caseTitle: c.title,
        caseArea: c.area || '',
        caseBody: c.body,
        detail: [
          c.symptom && { k: '접수 내용', v: c.symptom },
          c.cause && { k: '실제 원인', v: c.cause },
          c.work && { k: '처리', v: c.work },
          c.took && { k: '걸린 시간', v: c.took },
        ].filter(Boolean),
        photos: (c.photos || []).map((f) => {
          const img = casePool.find((x) => x.file === f);
          if (!img) throw new Error(`사례 사진이 풀에 없습니다: ${f} (${c.title})`);
          return { ...img, alt: `${site.brand} ${img.label}` };
        }),
        hasPhotos: (c.photos || []).length > 0,
        others: realCases.filter((x) => x.slug !== c.slug).slice(0, 6)
          .map((x) => ({ href: `/${x.slug}/`, label: x.title })),
        estimateForm: estimateForm({
          no: '03', heading: site.estimateHeading, lede: site.estimateLede,
        }),
      }),
    }));
  }
}

/* ── 시도 허브 (하림배관형) ──
   메뉴가 지역으로 짜인 사이트만 만든다. 다른 사이트에는 이 계층이 없다 —
   그게 사이트마다 구조가 다르다는 뜻이다. */
if (site.navModel === 'sido' && !TIERED) {
  for (const g of sidoGroups) {
    const seed = hash(`${siteKey}|sido|${g.label}`);
    urls.push(page({
      path: `/${g.slug}/`,
      kind: 'sido',
      crumbs: [{ name: '홈', href: '/' }, { name: g.label }],
      title: `${g.label} 하수구막힘 변기막힘 — ${site.brand}`,
      description: `${g.label} 전 지역 출동. ${g.items.slice(0, 5).map((r) => r.sigunguLabel).join(' · ')} 등 `
        + `${g.items.length}개 시·군·구.`,
      jsonLd: {
        ...orgLd,
        areaServed: { '@type': 'AdministrativeArea', name: g.label },
        url: `${siteUrl}/${g.slug}/`,
      },
      main: renderTemplate(templates.sidoHub, {
        ...base,
        nav: navFor('sido'),
        sidoLabel: g.label,
        sidoCount: g.items.length,
        sidoLede: fillPlaceholders(
          pools.heroLedes[seed % pools.heroLedes.length],
          {
            지역: g.label, 구: g.label, 시도: g.label,
            동: g.items[0].sigunguLabel,
            동2: g.items[1] ? g.items[1].sigunguLabel : g.items[0].sigunguLabel,
            동3: g.items[2] ? g.items[2].sigunguLabel : g.items[0].sigunguLabel,
          },
        ),
        items: g.items.map((r) => ({ href: regionHref(r), label: r.sigunguLabel })),
        others: sidoGroups.filter((x) => x.label !== g.label)
          .map((x) => ({ href: `/${x.slug}/`, label: x.label })),
        estimateForm: estimateForm({
          no: '03', heading: site.estimateHeading, lede: site.estimateLede,
        }),
      }),
    }));
  }
}


/* ══════════════════════════════════════════════════════════════
   3단계 구조 (클린배관형) — /{시도}/{시군구}/{키워드}

     /services/            키워드 13종 목록
     /services/<키워드>/   전국 키워드 안내 + 시도 링크        × 13
     /<시도>/              시군구 링크 + 키워드 링크           × 17
     /<시도>/<시군구>/     그 지역 키워드 13 + 동네            × 256
     /<시도>/<시군구>/<키워드>/  상세                          × 3,328

   말단이 3,328장이라 문장을 그대로 반복하면 한 장을 복사한 것이 된다.
   그래서 뽑는 씨앗을 (사이트키, 지역코드, 키워드)로 잡는다 — 같은 지역이라도
   키워드마다, 같은 키워드라도 지역마다 다른 조합이 나온다.
   ══════════════════════════════════════════════════════════════ */
if (TIERED) {
  const kwByGroup = keywordData.groups;
  const kwOf = new Map(keywords.map((k) => [k.slug, k]));

  /** 그 지역에서 키워드 상세로 가는 주소. */
  const detailHref = (r, k) => `/${r.sidoSlug}/${r.slug}/${k.slug}/`;

  /* ── /services/ — 키워드 목록 ── */
  urls.push(page({
    path: '/services/',
    kind: 'kwList',
    crumbs: [{ name: '홈', href: '/' }, { name: '하는 일' }],
    title: `하는 일 — ${site.brand}`,
    description: `${site.brand}가 하는 일 ${keywords.length}가지. `
      + `${keywords.slice(0, 4).map((k) => k.label).join(' · ')} 등.`,
    jsonLd: orgLd,
    main: renderTemplate(templates.kwList, {
      ...base,
      kwListHeading: site.kwListHeading || '하는 일',
      kwListLede: site.kwListLede || '',
      groups: Object.entries(kwByGroup).map(([g, v]) => ({
        what: v.what,
        items: keywords.filter((k) => k.group === g)
          .map((k) => ({ href: `/services/${k.slug}/`, label: k.label })),
      })),
    }),
  }));

  /* ── /services/<키워드>/ × 13 — 전국 안내 ── */
  for (const k of keywords) {
    const g = kwByGroup[k.group];
    const seed = hash(`${siteKey}|kw|${k.slug}`);
    const vars = { 키워드: k.label, 지역: '전국', 구: '전국', 시도: '전국' };
    urls.push(page({
      path: `/services/${k.slug}/`,
      kind: 'kwHub',
      crumbs: [{ name: '홈', href: '/' }, { name: '하는 일', href: '/services/' }, { name: k.label }],
      title: `${k.label} — ${site.brand}`,
      description: `${k.label} 전국 출동. ${g.symptoms[0].t}, ${g.symptoms[1].t} 같은 상태면 연락 주십시오.`,
      jsonLd: {
        ...orgLd,
        '@type': 'Service',
        serviceType: k.label,
        provider: { '@type': 'LocalBusiness', name: site.brand, telephone: site.phone },
        areaServed: { '@type': 'Country', name: '대한민국' },
        url: `${siteUrl}/services/${k.slug}/`,
      },
      main: renderTemplate(templates.kwHub, {
        ...base,
        kwLabel: k.label,
        kwH1: fillPlaceholders(keywordData.h1[k.angle][seed % keywordData.h1[k.angle].length], vars),
        kwLede: fillPlaceholders(keywordData.lede[k.angle][seed % keywordData.lede[k.angle].length], vars),
        symptomHeading: g.symptomHeading,
        symptoms: g.symptoms,
        causeHeading: g.causeHeading,
        causes: g.causes,
        methodHeading: g.methodHeading,
        method: g.method.map((m, i) => ({ ...m, no: String(i + 1).padStart(2, '0') })),
        dontHeading: g.dontHeading,
        dont: g.dont,
        faqHeading: '자주 묻는 것',
        faq: g.faq,
        price: fillDeep(pools.price, vars),
        priceHeading: pools.priceHeadings[seed % pools.priceHeadings.length],
        priceNote: pools.priceNotes[seed % pools.priceNotes.length],
        hasPhotos: imagePool.length > 0,
        photos: pickCombination(imagePool, 3, seed).map((img) => ({
          ...img, alt: `${site.brand} ${img.label}`,
        })),
        sido: sidoGroups.map((sg) => ({
          href: `/${sg.slug}/`, label: sg.label, count: sg.items.length,
        })),
        estimateForm: estimateForm({
          no: '08',
          heading: pools.estimateHeadings[seed % pools.estimateHeadings.length],
          lede: pools.estimateLedes[seed % pools.estimateLedes.length],
        }),
      }),
    }));
  }

  /* ── /<시도>/ × 17 ── */
  for (const sg of sidoGroups) {
    const seed = hash(`${siteKey}|sido|${sg.label}`);
    const vars = { 지역: sg.label, 구: sg.label, 시도: sg.label, 키워드: '배관막힘' };
    urls.push(page({
      path: `/${sg.slug}/`,
      kind: 'sido',
      crumbs: [{ name: '홈', href: '/' }, { name: sg.label }],
      title: `${sg.label} 하수구막힘 변기막힘 출동 — ${site.brand}`,
      description: `${sg.label} 전 지역 출동. `
        + `${sg.items.slice(0, 5).map((r) => r.sigunguLabel).join(' · ')} 등 ${sg.items.length}개 시·군·구.`,
      jsonLd: {
        ...orgLd,
        areaServed: { '@type': 'AdministrativeArea', name: sg.label },
        url: `${siteUrl}/${sg.slug}/`,
      },
      main: renderTemplate(templates.sidoHub, {
        ...base,
        sidoLabel: sg.label,
        sidoCount: sg.items.length,
        sidoLede: fillPlaceholders(pools.heroLedes[seed % pools.heroLedes.length], vars),
        /*
         * 시도 허브는 목록이다. 레퍼런스(클린배관)도 본문이 50자뿐이고 링크만 240개다.
         * 여기에 긴 글을 쓰면 아래 시군구 페이지와 내용이 겹친다.
         */
        spots: sg.items.map((r) => ({
          href: regionHref(r),
          label: r.sigunguLabel,
          items: keywords.slice(0, 6).map((k) => ({
            href: detailHref(r, k), label: `${r.sigunguLabel} ${k.label}`,
          })),
        })),
        kwLinks: keywords.map((k) => ({ href: `/services/${k.slug}/`, label: k.label })),
      }),
    }));
  }

  /* ── /<시도>/<시군구>/ × 256 ── */
  for (const r of allRegions) {
    const full = `${r.sidoLabel} ${r.sigunguLabel}`;
    const seed = hash(`${siteKey}|${r.code}`);
    const dongPick = pickRotated(r.repDong, 3, seed);
    const vars = {
      지역: full, 구: r.sigunguLabel, 시도: r.sidoLabel, 키워드: '배관막힘',
      동: dongPick[0] || r.sigunguLabel,
      동2: dongPick[1] || dongPick[0] || r.sigunguLabel,
      동3: dongPick[2] || dongPick[0] || r.sigunguLabel,
    };
    const one = (name, off = 0) => fillPlaceholders(pools[name][(seed + off) % pools[name].length], vars);

    const group2 = sidoGroups.find((g) => g.label === r.sidoLabel).items;
    const others = group2.filter((x) => x.code !== r.code);
    const start = others.length ? hash(`${siteKey}|near|${r.code}`) % others.length : 0;
    const near = [];
    for (let i = 0; i < Math.min(12, others.length); i += 1) {
      const n = others[(start + i) % others.length];
      near.push({ href: regionHref(n), label: n.sigunguLabel });
    }

    urls.push(page({
      path: regionHref(r),
      kind: 'sigungu',
      crumbs: [{ name: '홈', href: '/' }, { name: r.sidoLabel, href: `/${r.sidoSlug}/` }, { name: r.sigunguLabel }],
      title: `${r.sigunguLabel} 하수구막힘 ${r.sigunguLabel} 변기막힘 싱크대막힘 — ${site.brand}`,
      description: `${full} 배관 막힘 출동. ${dongPick.join(' · ')} 등 ${r.dongCount}개 동네. `
        + `${keywords.length}가지 증상별 안내.`,
      jsonLd: {
        ...orgLd,
        areaServed: { '@type': 'AdministrativeArea', name: full },
        url: `${siteUrl}${regionHref(r)}`,
      },
      main: renderTemplate(templates.sigunguHub, {
        ...base,
        sidoLabel: r.sidoLabel,
        sidoHref: `/${r.sidoSlug}/`,
        sigunguLabel: r.sigunguLabel,
        dongCount: r.dongCount,
        regionLede: one('heroLedes'),
        /*
         * 시군구 허브도 목록이 본체다. 긴 글은 그 아래 키워드 상세가 맡는다 —
         * 여기서 길게 쓰면 13장의 상세와 같은 말을 하게 된다.
         */
        kwHeading: `${r.sigunguLabel}에서 무엇 때문에 부르시나요`,
        kws: keywords.map((k) => ({
          href: detailHref(r, k),
          label: `${r.sigunguLabel} ${k.label}`,
          what: kwByGroup[k.group].what,
        })),
        dongHeading: one('dongHeadings', 2),
        dongLede: one('dongLedes', 3),
        dongs: r.repDong.slice(0, 60).map((name) => ({ name })),
        hasPhotos: imagePool.length > 0,
        photos: pickCombination(imagePool, 3, hash(`${siteKey}|photo|${r.code}`)).map((img) => ({
          ...img, alt: `${site.brand} ${img.label}`,
        })),
        price: fillDeep(pools.price, vars),
        priceHeading: one('priceHeadings', 4),
        priceNote: one('priceNotes', 5),
        nearHeading: `${r.sidoLabel} 다른 지역`,
        near,
        estimateForm: estimateForm({
          no: '06',
          heading: one('estimateHeadings', 13),
          lede: one('estimateLedes', 17),
          sido: r.sidoLabel,
          sigungu: r.sigunguLabel,
        }),
      }),
    }));
  }

  /* ── /<시도>/<시군구>/<키워드>/ × 3,328 — 말단 상세 ── */
  for (const r of allRegions) {
    const full = `${r.sidoLabel} ${r.sigunguLabel}`;
    const group2 = sidoGroups.find((g) => g.label === r.sidoLabel).items;
    const others = group2.filter((x) => x.code !== r.code);

    for (const k of keywords) {
      const g = kwByGroup[k.group];
      // 씨앗에 키워드를 넣는다. 같은 구라도 13장이 서로 다른 조합이 되게.
      const seed = hash(`${siteKey}|${r.code}|${k.slug}`);
      const dongPick = pickRotated(r.repDong, 3, seed);
      const vars = {
        지역: full, 구: r.sigunguLabel, 시도: r.sidoLabel, 키워드: k.label,
        동: dongPick[0] || r.sigunguLabel,
        동2: dongPick[1] || dongPick[0] || r.sigunguLabel,
        동3: dongPick[2] || dongPick[0] || r.sigunguLabel,
      };
      const pick = (arr, n, off = 0) => fillDeep(pickCombination(arr, n, seed + off), vars);
      const oneOf = (arr, off = 0) => fillPlaceholders(arr[(seed + off) % arr.length], vars);

      const start = others.length ? seed % others.length : 0;
      const near = [];
      for (let i = 0; i < Math.min(8, others.length); i += 1) {
        const n = others[(start + i) % others.length];
        near.push({ href: detailHref(n, k), label: `${n.sigunguLabel} ${k.label}` });
      }
      // 같은 지역의 다른 키워드로 건너가는 줄. 안쪽 링크의 뼈대다.
      const siblings = keywords.filter((x) => x.slug !== k.slug)
        .map((x) => ({ href: detailHref(r, x), label: `${r.sigunguLabel} ${x.label}` }));

      urls.push(page({
        path: detailHref(r, k),
        kind: 'detail',
        crumbs: [{ name: '홈', href: '/' }, { name: r.sidoLabel, href: `/${r.sidoSlug}/` }, { name: r.sigunguLabel, href: regionHref(r) }, { name: k.label }],
        title: `${r.sigunguLabel}${k.label} ${r.sigunguLabel} ${k.label} 출동 — ${site.brand}`,
        description: `${full} ${k.label}. ${g.symptoms[seed % g.symptoms.length].t} 같은 상태면 `
          + `연락 주십시오. ${dongPick.join(' · ')} 등 ${r.dongCount}개 동네 출동.`,
        jsonLd: {
          ...orgLd,
          '@type': 'Service',
          serviceType: k.label,
          provider: { '@type': 'LocalBusiness', name: site.brand, telephone: site.phone },
          areaServed: { '@type': 'AdministrativeArea', name: full },
          url: `${siteUrl}${detailHref(r, k)}`,
        },
        main: renderTemplate(templates.detail, {
          ...base,
          sidoLabel: r.sidoLabel,
          sidoHref: `/${r.sidoSlug}/`,
          sigunguLabel: r.sigunguLabel,
          sigunguHref: regionHref(r),
          kwLabel: k.label,
          /*
           * H1 은 "지역 + 키워드" 다. 레퍼런스(클린배관)도 그렇게 쓴다.
           * 붙여쓰기를 앞에 두는 것은 실제로 그렇게 검색하기 때문이다.
           */
          detailH1: fillPlaceholders(oneOf(keywordData.h1[k.angle]), vars),
          detailLede: oneOf(keywordData.lede[k.angle], 1),
          /*
           * "이 지역은 이렇습니다" 는 동네 이름과 개수로만 쓴다.
           * 건물 연식·배관 상태 같은 지역 특성은 근거 데이터가 없다 —
           * 256개 구에 대해 지어내면 반드시 틀린 것이 섞인다.
           */
          localHeading: `${r.sigunguLabel} ${k.label}, 어디로 가나`,
          localBody: `${full}는 동네가 ${r.dongCount}곳입니다. `
            + `${dongPick.join(' · ')} 어디로 부르셔도 갑니다. `
            + `${r.sidoLabel} 안에서는 옮겨 다니는 시간이 크게 다르지 않습니다.`,
          symptomHeading: `${r.sigunguLabel} ${g.symptomHeading}`,
          symptoms: pick(g.symptoms, 5),
          causeHeading: `${r.sigunguLabel} ${k.label}, ${g.causeHeading}`,
          causes: pick(g.causes, 5, 3),
          methodHeading: `${r.sigunguLabel} ${k.label}, ${g.methodHeading}`,
          method: g.method.map((m, i) => ({
            ...fillDeep([m], vars)[0], no: String(i + 1).padStart(2, '0'),
          })),
          dontHeading: g.dontHeading,
          dont: pick(g.dont, 4, 7),
          priceHeading: `${r.sigunguLabel} ${oneOf(pools.priceHeadings, 11)}`,
          price: fillDeep(pools.price, vars),
          priceNote: oneOf(pools.priceNotes, 13),
          hasPhotos: imagePool.length > 0,
          photoHeading: imagePool.length ? oneOf(pools.photoHeadings, 17) : '',
          /*
           * alt 에 지역명을 넣지 않는다. 같은 사진이 3,328장을 도는데
           * "종로구 꺼낸 이물질" 이라고 적으면 거기서 찍었다는 말이 된다.
           */
          photos: pickCombination(imagePool, 3, seed).map((img) => ({
            ...img, alt: `${site.brand} ${img.label}`,
          })),
          faqHeading: `${r.sigunguLabel} ${k.label} 자주 묻는 것`,
          faq: pick(g.faq, 6, 19),
          nearHeading: `${r.sigunguLabel} 인근도 갑니다`,
          near,
          siblingHeading: `${r.sigunguLabel}의 다른 배관 문제`,
          siblings,
          estimateForm: estimateForm({
            no: '11',
            heading: oneOf(pools.estimateHeadings, 23),
            lede: oneOf(pools.estimateLedes, 29),
            sido: r.sidoLabel,
            sigungu: r.sigunguLabel,
          }),
        }),
      }));
    }
  }
}


/* ══════════════════════════════════════════════════════════════
   블로그형 (하수구박사) — 한글 평면 슬러그

     /{구}{키워드}-{작업}-{성격}/     × 256 × 6 × 2 = 3,072

   다른 네 사이트와 반대로 간다.
     - 카드·패널이 아니라 문단이 죽 이어진다
     - 격식체(~습니다)가 아니라 설명조(~해요/~하죠)
     - 사진을 안 넣는다. 레퍼런스도 로고와 썸네일뿐이고 글이 전부다
     - 하단에 해시태그와 그 구의 동 이름을 깐다
   ══════════════════════════════════════════════════════════════ */
if (BLOG) {
  const bg = blogData.groups;

  /* ── /blog/ — 글 전체 입구 ── */
  {
    const seed = hash(`${siteKey}|blog`);
    // 3,072편을 한 장에 다 깔면 페이지가 300KB 를 넘는다. 여기서는 최근 것만 보여주고
    // 증상별 목록으로 넘긴다.
    const recent = pickSpread(blogPosts, 40, seed);
    urls.push(page({
      path: '/blog/',
      kind: 'blogIndex',
      crumbs: [{ name: '홈', href: '/' }, { name: '글' }],
      title: `배관 정보 글 — ${site.brand}`,
      description: '하수구·변기·싱크대 막힘의 원인과 비용을 지역별로 정리했어요. '
        + blogData.keywords.map((k) => k.label).join(' · '),
      jsonLd: { '@type': 'CollectionPage', name: '배관 정보 글' },
      main: renderTemplate(templates.blogIndex, {
        ...base,
        groups: blogData.keywords.map((kw) => ({
          label: kw.label,
          href: `/blog/${kw.slug}/`,
          what: bg[kw.group].what,
        })),
        rows: recent.map((t) => ({
          href: `/${t.slug}/`, title: t.title, area: t.area, zone: t.zone,
          kw: t.kw.label, at: ymd(t.at),
        })),
      }),
    }));
  }

  /* ── /blog/<키워드>/[권역/][쪽] — 게시판 ──
     권역을 주소로 뺀다. 화면에서만 거르면 탭과 쪽 넘김이 서로 어긋난다 —
     "서울" 을 눌렀는데 이 쪽에 실린 30줄 중 서울만 남는 꼴이 된다.
     주소로 빼면 어느 조합이든 링크로 걸 수 있고 크롤러도 따라올 수 있다. */
  const PER_PAGE = 30;
  for (const kw of blogData.keywords) {
    const all = postsByKeyword.get(kw.slug);   // 이미 최신순
    const views = [
      { zone: null, label: '전체', list: all },
      ...BLOG_ZONES.map((z) => ({
        zone: z, label: z.label, list: all.filter((t) => t.zone === z.key),
      })).filter((v) => v.list.length),
    ];
    for (const view of views) {
      const pages = Math.max(1, Math.ceil(view.list.length / PER_PAGE));
      const baseHref = view.zone ? `/blog/${kw.slug}/${view.zone.key}/` : `/blog/${kw.slug}/`;
      const hrefOfPage = (n) => (n === 1 ? baseHref : `${baseHref}${n}/`);
      for (let n = 1; n <= pages; n += 1) {
        const rows = view.list.slice((n - 1) * PER_PAGE, n * PER_PAGE);
        const where = view.zone ? `${view.zone.label} ` : '';
        // 쪽 번호는 앞뒤로 두 개씩만. 18쪽을 다 늘어놓으면 줄보다 번호가 많아진다.
        const from = Math.max(1, Math.min(n - 2, pages - 4));
        const nums = [];
        for (let i = from; i < from + 5 && i <= pages; i += 1) {
          nums.push({ n: i, href: hrefOfPage(i), on: i === n });
        }
        urls.push(page({
          path: hrefOfPage(n),
          kind: 'blogHub',
          crumbs: [
            { name: '홈', href: '/' }, { name: '글', href: '/blog/' },
            ...(view.zone ? [{ name: kw.label, href: `/blog/${kw.slug}/` }, { name: view.zone.label }]
              : [{ name: kw.label }]),
          ],
          title: `${where}${kw.label} 지역별 정보${n > 1 ? ` (${n})` : ''} — ${site.brand}`,
          description: `${where}${kw.label} 원인과 비용을 시·군·구별로 정리했어요.`,
          jsonLd: { '@type': 'CollectionPage', name: `${where}${kw.label} 지역별 정보` },
          main: renderTemplate(templates.blogHub, {
            ...base,
            kwLabel: kw.label,
            zoneLabel: view.zone ? view.zone.label : '',
            kwLede: `${kw.label}은 원인이 여러 갈래예요. 어느 지역이든 부르시면 가서 보고 `
              + '무엇 때문인지 말씀드립니다. 사시는 곳을 눌러 보세요.',
            tabs: [
              { href: `/blog/${kw.slug}/`, label: '전체', on: !view.zone },
              ...BLOG_ZONES.filter((z) => all.some((t) => t.zone === z.key)).map((z) => ({
                href: `/blog/${kw.slug}/${z.key}/`,
                label: z.label,
                on: !!view.zone && view.zone.key === z.key,
              })),
            ],
            rows: rows.map((t) => ({
              href: `/${t.slug}/`, title: t.title, area: t.area,
              kw: t.kw.label, at: ymd(t.at),
            })),
            hasPager: [{
              nums,
              prev: n > 1 ? [{ href: hrefOfPage(n - 1) }] : [],
              next: n < pages ? [{ href: hrefOfPage(n + 1) }] : [],
              first: n > 3 ? [{ href: baseHref }] : [],
              last: n < pages - 2 ? [{ href: hrefOfPage(pages) }] : [],
            }],
            others: blogData.keywords.filter((x) => x.slug !== kw.slug)
              .map((x) => ({ href: `/blog/${x.slug}/`, label: x.label })),
          }),
        }));
      }
    }
  }

  /* ── 글 × 3,072 ── */
  for (const r of allRegions) {
    const full = `${r.sidoLabel} ${r.sigunguLabel}`;
    for (const kw of blogData.keywords) {
      for (const kind of blogData.kinds) {
        const g = bg[kw.group];
        const seed = hash(`${siteKey}|${r.code}|${kw.slug}|${kind.slug}`);
        // 작업·장비 한 마디는 슬러그와 제목에만 쓴다. 본문에서 장비를 지어내지 않기 위해서다.
        const work = blogData.works[seed % blogData.works.length];
        const dongPick = pickRotated(r.repDong, 3, seed);
        const vars = {
          지역: full, 구: r.sigunguLabel, 시도: r.sidoLabel, 키워드: kw.label,
          동: dongPick[0] || r.sigunguLabel,
          동2: dongPick[1] || dongPick[0] || r.sigunguLabel,
          동3: dongPick[2] || dongPick[0] || r.sigunguLabel,
        };
        const slug = blogPostSlug(r, kw, kind);   // 주소는 한 곳에서만 만든다
        const at = postedAt(seed);

        /*
         * 소제목 5개가 그대로 다 나가면 3,072장이 같은 뼈대가 된다.
         * 시드로 순서를 돌리고 문단도 골라 뽑는다 — 재빌드해도 같은 글이 나온다.
         */
        const tail = g.sections.map((_, i) => i).slice(1);
        const shuffled = pickCombination(tail, tail.length, seed)
          .map((_, n) => tail[(seed + n * 7) % tail.length]);
        const useIdx = [0, ...[...new Set(shuffled)], ...tail].slice(0, g.sections.length);
        const secs = useIdx.map((i, n) => {
          const s2 = g.sections[i];
          return {
            h: fillPlaceholders(s2.h, vars),
            // 문단 5개 중 4개를 뽑아 순서까지 시드로 돌린다
            p: pickCombination(s2.p, 5, seed + n * 31).map((t) => ({ t: fillPlaceholders(t, vars) })),
          };
        });

        const costPart = kind.focus === 'cost' ? [{
          intro: fillPlaceholders(blogData.costIntro[seed % blogData.costIntro.length], vars),
          after: fillPlaceholders(blogData.costAfter[seed % blogData.costAfter.length], vars),
          price: fillDeep(pools.price, vars),
        }] : [];

        /*
         * 관련 글. 이게 없으면 3,072장이 서로 안 이어져서, 검색으로 한 장에
         * 들어온 사람이 다른 글로 못 넘어가고 크롤러도 /area/ 를 거치지 않으면
         * 나머지를 못 찾는다. 두 방향으로 건다 — 같은 동네의 다른 증상, 같은 증상의 옆 동네.
         */
        const sameArea = (postsByRegion.get(r.code) || [])
          .filter((t) => t.slug !== slug).slice(0, 6)
          .map((t) => ({ href: `/${t.slug}/`, label: t.title }));
        const sameKwAll = (postsByKeyword.get(kw.slug) || []).filter((t) => t.r.code !== r.code);
        const nearStart = sameKwAll.length ? seed % sameKwAll.length : 0;
        const sameKw = [];
        for (let i = 0; i < Math.min(6, sameKwAll.length); i += 1) {
          const t = sameKwAll[(nearStart + i) % sameKwAll.length];
          sameKw.push({ href: `/${t.slug}/`, label: t.title });
        }

        // 하단 해시태그. 레퍼런스가 #지역키워드 두세 개를 붙인다.
        const tags = [
          `#${blogSlugLabel(r)}${kw.label}`,
          `#${blogSlugLabel(r)}${work}`,
          `#${r.sidoLabel}${kw.label}`,
          `#${kw.label}${kind.label}`,
        ];

        urls.push(page({
          path: `/${slug}/`,
          kind: 'post',
          published: at.toISOString(),
          crumbs: [{ name: '홈', href: '/' }, { name: `${blogLabel(r)}${kw.label}` }],
          title: `${blogLabel(r)}${kw.label} ${work} ${kind.label} - ${site.brand}`,
          description: `${full} ${kw.label} ${kind.label}. `
            + `${dongPick.join(' · ')} 등 ${r.dongCount}개 동네. 원인부터 해결까지 정리했어요.`,
          jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: `${blogLabel(r)}${kw.label} ${work} ${kind.label}`,
            about: kw.label,
            datePublished: at.toISOString(),
            dateModified: at.toISOString(),
            author: { '@type': 'Organization', name: site.brand },
            publisher: { '@type': 'Organization', name: site.brand },
            areaServed: { '@type': 'AdministrativeArea', name: full },
            mainEntityOfPage: `${siteUrl}/${slug}/`,
          },
          main: renderTemplate(templates.post, {
            ...base,
            postH1: `${blogLabel(r)}${kw.label} ${work} ${kind.label}`,
            postedAt: ymd(at),
            postedAtISO: at.toISOString(),
            sidoLabel: r.sidoLabel,
            sigunguLabel: r.sigunguLabel,
            kwLabel: kw.label,
            dongCount: r.dongCount,
            lead: `${full}에서 ${kw.label}으로 검색해 들어오셨다면 잘 오셨어요. `
              + `${dongPick.join(' · ')} 어디든 가고요, 이 글에 원인부터 해결까지 정리해 뒀으니 `
              + `읽어 보시고 애매하면 전화 주세요.`,
            secs,
            costPart,
            closing: fillPlaceholders(blogData.closing[seed % blogData.closing.length], vars),
            tags: tags.map((t) => ({ t })),
            /*
             * 하단 동네 나열. 레퍼런스가 글 아래에 지역명을 까는 것을 그대로 가져왔다.
             * 링크가 아니라 글자다 — 동 단위 페이지를 만들지 않기로 했기 때문이다.
             */
            blogHref: '/blog/',
            kwHubHref: `/blog/${kw.slug}/`,
            kwLabel2: kw.label,
            sameAreaHeading: `${blogLabel(r)}의 다른 이야기`,
            sameArea,
            sameKwHeading: `다른 지역 ${kw.label} 글`,
            sameKw,
            dongHeading: `${blogLabel(r)} 어디든 갑니다`,
            dongs: r.repDong.slice(0, 40).map((name) => ({ name })),
            estimateForm: estimateForm({
              no: '09',
              heading: pools.estimateHeadings[seed % pools.estimateHeadings.length],
              lede: pools.estimateLedes[seed % pools.estimateLedes.length],
              sido: r.sidoLabel,
              sigungu: r.sigunguLabel,
            }),
          }),
        }));
      }
    }
  }
}

/* ── 사이트맵 · robots · 자산 ── */
const sitemapBody = urls.map((u) => `<url><loc>${u}</loc></url>`).join('\n');
writeFileSync(join(outRoot, siteKey, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n`
  + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapBody}\n</urlset>\n`);

writeFileSync(join(outRoot, siteKey, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

const assetOut = join(outRoot, siteKey, 'assets', site.assetVersion);
mkdirSync(assetOut, { recursive: true });
/*
 * 폼의 시/도·시/군/구 선택지는 페이지에 적은 지역명과 같은 출처(regions.json)에서
 * 나와야 한다. 둘이 어긋나면 접수된 주소가 실제 지역과 달라진다.
 */
const regionMap = Object.fromEntries(
  sidoGroups.map((g) => [g.label, g.items.map((r) => r.sigunguLabel)]),
);
/*
 * 로고·파비콘. 다섯 사이트가 서로 다른 회사로 보여야 하므로 없으면 굽지 않는다 —
 * 자리표시자를 띄우느니 멈추는 편이 낫다.
 */
const BRAND_FILES = ['logo-mark.png', 'logo.png', 'favicon.png', 'favicon.ico'];
mkdirSync(join(assetOut, 'img'), { recursive: true });
for (const f of BRAND_FILES) {
  const src = join(templateDir, 'assets', 'img', f);
  if (!existsSync(src)) throw new Error(`브랜드 자산이 없습니다: assets/img/${f}`);
  copyFileSync(src, join(assetOut, 'img', f));
}

if (site.heroImage) {
  mkdirSync(join(assetOut, 'img'), { recursive: true });
  const hsrc = join(templateDir, 'assets', 'img', site.heroImage.file);
  if (!existsSync(hsrc)) throw new Error(`히어로 이미지가 없습니다: ${site.heroImage.file}`);
  copyFileSync(hsrc, join(assetOut, 'img', site.heroImage.file));
}
for (const img of [...imagePool, ...casePool]) {
  copyFileSync(join(templateDir, 'assets', 'img', img.file), join(assetOut, 'img', img.file));
}
for (const f of readdirSync(join(templateDir, 'assets'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name !== 'README.md').map((e) => e.name)) {
  const src = join(templateDir, 'assets', f);
  if (f === 'app.js') {
    const js = readFileSync(src, 'utf8').replace('/*@REGION_MAP@*/ {}', JSON.stringify(regionMap));
    if (js.includes('@REGION_MAP@')) throw new Error('app.js 의 REGION_MAP 자리를 못 찾았습니다.');
    writeFileSync(join(assetOut, f), js);
  } else {
    copyFileSync(src, join(assetOut, f));
  }
}

console.log(`${site.brand} (${siteKey})  →  ${join(outRoot, siteKey)}`);
console.log(`  호스트     ${siteUrl}${host === 'TBD.co.kr' ? '   ⚠ 도메인 미정' : ''}`);
// 3단계와 평면은 만드는 것이 달라서 요약도 따로 적는다. 평면 문구를 그대로 쓰면
// 3단계에서 "서비스 5" 처럼 만들지도 않은 것이 찍힌다.
// 구조마다 만드는 것이 다르니 요약도 따로 적는다. 한 문구로 돌려 쓰면
// 3단계에서 "서비스 5" 처럼 만들지도 않은 것이 찍힌다.
if (BLOG) {
  console.log(`  페이지     ${urls.length}장  (홈 1 · /area/ 1 · 서비스 ${services.length}`
    + ` · 글 ${allRegions.length * blogData.keywords.length * blogData.kinds.length}`
    + `  = 시군구 ${allRegions.length} × 키워드 ${blogData.keywords.length} × 성격 ${blogData.kinds.length})`);
  console.log('  URL 모양   /{구}{키워드}-{작업}-{성격}/   예: /서대문구하수구막힘-고압세척-원인정보/');
} else if (TIERED) {
  console.log(`  페이지     ${urls.length}장  (홈 1 · /area/ 1 · /services/ 1`
    + ` · 키워드 ${keywords.length} · 시도 ${sidoGroups.length}`
    + ` · 시군구 ${allRegions.length} · 상세 ${allRegions.length * keywords.length})`);
  console.log('  URL 모양   /{시도}/{시군구}/{키워드}   예: /seoul/gangnamgu/toilet-clog/');
} else {
  console.log(`  페이지     ${urls.length}장  (홈 1 · /area/ 1 · 시군구 ${allRegions.length}`
    + ` · 서비스 ${services.length}`
    + `${realCases.length ? ` · 사례 ${realCases.length + 1}` : ' · 사례 0 — 실제 사례가 오면 생성된다'})`);
}
console.log(`  시도 묶음  ${sidoGroups.map((g) => `${g.label} ${g.items.length}`).join(' · ')}`);
