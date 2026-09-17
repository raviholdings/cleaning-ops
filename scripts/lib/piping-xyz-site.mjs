/**
 * piping-xyz 페이지 매핑 — 순수 함수. 카탈로그 생성기와 렌더 서버가 같은 파일을 쓴다.
 *
 * 페이지 한 장 = (도메인, 지역 r, 메인A, 변형 j)
 *   메인B  같은 계열 메인 중 하나 (j 마다 다름)
 *   서브   A 에 묶인 짝 (부족하면 같은 계열 풀에서 보충), j 마다 다름
 *   꼬리   6개 중 하나, j 마다 다름
 *   제목   "<지역 표시명> <A> <B> <서브> <꼬리>"
 *   경로   /배관/<시도>/<동세그먼트>/<동라벨>-<A>-<B>-<서브>-<꼬리>.html   (한글, 인코딩은 encodePath 한 가지)
 *   집     그 도메인의 서브도메인 1,000개 중 하나 (j 마다 137 칸씩 떨어진 다른 서브도메인)
 *
 * 같은 입력은 언제 계산해도 같은 결과. 변형 수(k)나 메인을 늘려도 기존 페이지는 안 바뀐다
 * (request_id 는 j-메인-지역 순으로 매기므로 새 j 는 뒤에 붙는다).
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function loadSite(configPath = resolve(projectRoot, 'config/piping-xyz.json')) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const abs = (p) => (isAbsolute(p) ? p : resolve(projectRoot, p));
  const regionsFile = JSON.parse(readFileSync(abs(config.regionsFile), 'utf8'));
  const keywordsFile = JSON.parse(readFileSync(abs(config.keywordsFile), 'utf8'));
  const plan = JSON.parse(readFileSync(abs(config.planFile), 'utf8'));

  const regions = regionsFile.regions.slice().sort((a, b) => a.index - b.index);
  const regionByUrl = new Map(regions.map((r) => [`${r.url_sido}/${r.url_seg}`, r]));
  const regionsBySigungu = new Map();
  for (const r of regions) {
    const key = `${r.sido}|${r.sigungu}`;
    if (!regionsBySigungu.has(key)) regionsBySigungu.set(key, []);
    regionsBySigungu.get(key).push(r);
  }
  const regionsBySido = new Map();
  for (const r of regions) { if (!regionsBySido.has(r.sido)) regionsBySido.set(r.sido, []); regionsBySido.get(r.sido).push(r); }

  const phases = Object.keys(keywordsFile.phases);
  const mains = []; // [{name, phase, subs, index}]
  for (const ph of phases) for (const m of keywordsFile.phases[ph]) mains.push({ name: m.name, phase: ph, subs: m.subs.slice(), index: mains.length });
  const mainByName = new Map(mains.map((m) => [m.name, m]));
  const phaseSubs = {};
  for (const ph of phases) phaseSubs[ph] = [...new Set(mains.filter((m) => m.phase === ph).flatMap((m) => m.subs))];
  // 짝이 6개 미만인 메인은 같은 계열 풀에서 보충 (자기 이름·이미 있는 것 제외)
  for (const m of mains) {
    if (m.subs.length >= 6) continue;
    const extra = phaseSubs[m.phase].filter((s) => !m.subs.includes(s) && s !== m.name);
    const start = hash32(`fill|${m.name}`) % Math.max(1, extra.length);
    for (let i = 0; m.subs.length < 6 && i < extra.length; i += 1) m.subs.push(extra[(start + i) % extra.length]);
  }
  const tails = keywordsFile.tails;
  const k = Number(config.variants) || 3;

  // 서브도메인: 계획 파일 순서 = 도메인별 0..999
  const subsByDomain = new Map();
  for (const item of plan.items) {
    if (!subsByDomain.has(item.root)) subsByDomain.set(item.root, []);
    subsByDomain.get(item.root).push(item.subdomain);
  }
  const subIndexByHost = new Map();
  for (const [root, list] of subsByDomain) list.forEach((s, i) => subIndexByHost.set(`${s}.${root}`, { root, sub: s, index: i }));

  return {
    config, projectRoot, regions, regionByUrl, regionsBySigungu, regionsBySido, mains, mainByName, phases, phaseSubs, tails, k,
    subsByDomain, subIndexByHost,
  };
}

/** 슬러그 조각용: 꼬리의 공백 제거 ("업체 비용" → "업체비용") */
const tailSlug = (t) => t.replace(/\s+/g, '');

/** 경로 인코딩 한 가지로 고정: 세그먼트마다 encodeURIComponent, '/' 유지. 카탈로그·제출·canonical 전부 이 결과를 쓴다. */
export function encodePath(path) {
  return path.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

/** (도메인, 지역, 메인A, j) → 페이지. */
export function makePage(site, domain, region, mainA, j) {
  const { config, mains, tails } = site;
  // j = 1..k 가 카탈로그 변형. j = k+1 은 등록 서브도메인 루트 전용(주소 없음, parsePath 가 안 받음).
  if (!(j >= 1)) throw new Error(`변형 j=${j} 는 1 이상이어야 함`);
  const sameGroup = mains.filter((m) => m.phase === mainA.phase && m.name !== mainA.name);
  const rk = `${domain}|${region.index}|${mainA.name}`;
  const mainB = sameGroup[(hash32(`B|${rk}`) + (j - 1)) % sameGroup.length];
  const sub = mainA.subs[(hash32(`S|${rk}`) + (j - 1) * 7) % mainA.subs.length];
  const tail = tails[(hash32(`T|${rk}`) + (j - 1) * 2) % tails.length];
  /*
   * 집 서브도메인 고르기. 구간이 둘이다 (2026-09-17).
   *
   *   j <= variantsLegacy  → 인덱스 0 .. nLegacy-1      기존 서브도메인
   *   j >  variantsLegacy  → 인덱스 nLegacy ..          나중에 추가한 서브도메인
   *
   * 기존 배정을 한 장도 안 건드리려고 이렇게 나눴다.
   * nLegacy 를 그냥 키우면 나머지 연산의 분모가 바뀌어 이미 색인된 페이지가
   * 전부 다른 서브도메인으로 옮겨간다.
   * 새 구간은 해시 씨앗도 다르게(H2) 줘서 기존과 상관없이 흩어지게 한다.
   */
  const step = Number(config.subdomainStep) || 137;
  const nLegacy = Number(config.subdomainsPerDomain) || 1000;
  const kLegacy = Number(config.variantsLegacy) || 3;
  const nNew = Number(config.subdomainsPerDomainNew) || 0;
  const homeIndex = (j <= kLegacy || nNew <= 0)
    ? (hash32(`H|${rk}`) + (j - 1) * step) % nLegacy
    : nLegacy + ((hash32(`H2|${rk}`) + (j - kLegacy - 1) * step) % nNew);
  const slug = `${region.label}-${mainA.name}-${mainB.name}-${sub}-${tailSlug(tail)}`;
  const path = `/${config.urlRoot}/${region.url_sido}/${region.url_seg}/${slug}.html`;
  return {
    domain, region, mainA, mainB, sub, tail, j, homeIndex,
    title: `${region.name} ${mainA.name} ${mainB.name} ${sub} ${tail}`,
    slug, path, encodedPath: encodePath(path),
  };
}

/** 카탈로그 순서: j → 메인 → 지역. 새 j·새 메인은 뒤에 붙는다. */
export function* enumeratePages(site, domain) {
  for (let j = 1; j <= site.k; j += 1) {
    for (const mainA of site.mains) {
      for (const region of site.regions) yield makePage(site, domain, region, mainA, j);
    }
  }
}

/** 도메인 전체를 돌며 서브도메인별 request_id 를 매긴다. cb(page, requestId, homeSub) */
export function enumerateCatalog(site, domain, cb) {
  const subs = site.subsByDomain.get(domain);
  if (!subs) throw new Error(`계획에 없는 도메인: ${domain}`);
  const counters = new Array(subs.length).fill(0);
  let total = 0;
  for (const page of enumeratePages(site, domain)) {
    counters[page.homeIndex] += 1;
    cb(page, counters[page.homeIndex], subs[page.homeIndex]);
    total += 1;
  }
  return { total, perSubdomain: counters };
}

/** 한 서브도메인의 집 페이지 목록 (루트/시도 인덱스용). */
export function pagesForSubdomain(site, domain, subIndex) {
  const out = [];
  for (const page of enumeratePages(site, domain)) if (page.homeIndex === subIndex) out.push(page);
  return out;
}

/** 경로 → 페이지 (없으면 null). 슬러그를 다시 계산해 실제 카탈로그에 있는 조합만 통과시킨다. */
export function parsePath(site, domain, rawPath) {
  let path;
  try { path = decodeURIComponent(rawPath); } catch { return null; }
  const m = path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\.html$/);
  if (!m || m[1] !== site.config.urlRoot) return null;
  const region = site.regionByUrl.get(`${m[2]}/${m[3]}`);
  if (!region) return null;
  const parts = m[4].split('-');
  if (parts.length !== 5 || parts[0] !== region.label) return null;
  const mainA = site.mainByName.get(parts[1]);
  if (!mainA) return null;
  for (let j = 1; j <= site.k; j += 1) {
    const page = makePage(site, domain, region, mainA, j);
    if (page.slug === m[4]) return page;
  }
  return null;
}

/** 호스트 → { root, sub, index } (등록 서브도메인이면) / { root } (루트·www) / null */
export function resolveHost(site, hostname) {
  const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '');
  const hit = site.subIndexByHost.get(host);
  if (hit) return { ...hit, registered: true };
  for (const d of site.config.domains) {
    if (host === d || host === `www.${d}`) return { root: d, sub: '', index: -1, registered: false, isRoot: true };
    if (host.endsWith(`.${d}`)) return { root: d, sub: host.slice(0, -(d.length + 1)), index: -1, registered: false };
  }
  return null;
}

/** 같은 시군구의 다른 지역(동) — 플레이스 카드용. 부족하면 같은 시도에서 보충. */
export function nearbyRegions(site, region, count, seed) {
  const same = (site.regionsBySigungu.get(`${region.sido}|${region.sigungu}`) || []).filter((r) => r.id !== region.id);
  const pool = same.length >= count ? same : [...same, ...(site.regionsBySido.get(region.sido) || []).filter((r) => r.id !== region.id && !same.includes(r))];
  const out = [];
  for (let i = 0; i < count && pool.length; i += 1) out.push(pool[(seed + i * 3) % pool.length]);
  return out;
}
