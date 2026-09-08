#!/usr/bin/env node
/**
 * 브랜드 사이트가 실제 검색어에서 몇 등에 뜨는지 잰다.
 *
 *   node scripts/check-brand-serp-rank.mjs --dry-run       # 조회만, 기록 안 함
 *   node scripts/check-brand-serp-rank.mjs --save          # reports/ 에 남긴다
 *   node scripts/check-brand-serp-rank.mjs --per 8         # 사이트당 검색어 수
 *   node scripts/check-brand-serp-rank.mjs --pages 3       # 몇 페이지까지 훑을지
 *
 * 왜 이걸 만들었나
 *   색인은 되고 있다. site:도메인 검색에 6건밖에 안 나오지만 그건 네이버가
 *   그 화면에서 안 보여줄 뿐이고, 키워드로 찾으면 SERP 에 뜬다 (운영자 확인
 *   2026-09-08). 문제는 "잡히느냐" 가 아니라 "몇 등이냐" 다.
 *   그래서 색인 여부(check-brand-root-index.mjs)와 별개로 순위를 따로 잰다.
 *
 * 어떻게 재나
 *   페이지에서 실제 쓰는 검색어(동+키워드, 시군구+키워드)를 뽑아 통합검색에
 *   던지고, 결과 안에서 우리 도메인이 처음 나오는 자리를 순위로 적는다.
 *   같은 검색어를 다음에도 그대로 쓰도록 시드로 고정한다 — 검색어가 바뀌면
 *   앞뒤 비교가 안 된다.
 *
 * 실험 설계
 *   드림·비버 = 실험군(하단 블록·긴 설명·본문 반복), 썬더 = 대조군(안 건드림).
 *   셋은 도메인 등록일이 같고 동 페이지도 4,760장씩이라 다른 건 콘텐츠뿐이다.
 *
 * ⚠ 조회 예산
 *   색인 조사 배치와 같은 IP 를 쓴다. 같은 IP 로 하루 1,400~1,900건이 지나면
 *   403 이다. 기본값(5사이트 × 6검색어 × 2페이지 = 60건)은 그 안에서 작지만,
 *   색인 배치가 도는 중이면 같이 돌리지 말 것.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (name, fb) => {
  const i = argv.indexOf(name);
  return i === -1 ? fb : (argv[i + 1] ?? fb);
};
const dryRun = argv.includes('--dry-run');
const save = argv.includes('--save');
const perSite = Number(argValue('--per', '15'));
const maxPages = Number(argValue('--pages', '3'));
/*
 * 어느 탭에서 재나.
 *   통합  ssc 없음 — 손님이 실제로 보는 화면. 블로그·카페·플레이스가 섞인다
 *   웹    ssc=tab.ur.all — 웹문서만. 우리 페이지끼리 견주기엔 이쪽이 깔끔하다
 * 둘의 순위가 다르다. 운영자가 통합에서 3쪽에 봤다고 한 건을 웹 탭에서는
 * 1쪽 3위로 잡았다 (2026-09-08). 그래서 둘 다 잰다.
 */
const TABS = { 통합: '', 웹: 'tab.ur.all' };
/*
 * 통합검색은 page 파라미터가 안 먹는다 — 1·2·3쪽이 모두 같은 HTML 이다
 * (실측 783KB 동일, 2026-09-08). 블록마다 따로 더 불러오는 구조라 그렇다.
 * 그래서 통합은 첫 화면만 본다. 깊이 훑는 건 웹 탭에서만 뜻이 있다.
 */
const PAGEABLE = { 통합: false, 웹: true };
const tabArg = argValue('--tabs', 'both');
const tabs = tabArg === 'web' ? ['웹'] : tabArg === 'total' ? ['통합'] : ['통합', '웹'];
const delayMs = Number(argValue('--delay', '7000'));

/* 대조군을 표에 같이 적어 두면 읽는 사람이 헷갈리지 않는다. */
const ARM = {
  dream: '실험군', mole: '실험군', thunder: '대조군',
  ssak: '하단·설명만', dosa: '하단·설명만',
};

/* FNV-1a. 검색어 뽑기를 고정하려고 쓴다 — 다음 회차도 같은 검색어여야 한다. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 겹치지 않게 count 개를 고르게 뽑는다. */
function pickRotated(list, count, seed) {
  const size = list.length;
  if (!size) return [];
  let step = 1 + ((seed * 2) % Math.max(1, size - 1));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  while (gcd(step, size) !== 1) step += 1;
  const start = (seed * 3) % size;
  const out = [];
  for (let i = 0; i < size && out.length < count; i += 1) {
    const v = list[(start + i * step) % size];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/* 사이트별 검색어를 만든다. 페이지가 실제로 노리는 말이어야 의미가 있다. */
const regions = JSON.parse(readFileSync(join(projectRoot, 'data/hub/regions.json'), 'utf8'));
const allSgg = [];
for (const sd of regions.sido) for (const s of sd.sigungu) allSgg.push(s);

function queriesFor(key, site) {
  const kws = site.regionKeywords || [];
  if (!kws.length) return [];
  const seed = hash(`serp|${key}`);
  const sgg = pickRotated(allSgg, perSite, seed);
  return sgg.map((r, i) => {
    const kw = kws[(seed + i) % kws.length];
    const dongs = (r.repDong || []).filter((d) => d && d.trim());
    /* 절반은 동 단위, 절반은 시군구 단위로 섞는다 — 둘의 순위가 다르다. */
    if (i % 2 === 0 && dongs.length) {
      return { q: `${dongs[(seed + i) % dongs.length]} ${kw}`, level: '동' };
    }
    return { q: `${r.shortName || r.name} ${kw}`, level: '시군구' };
  });
}

function serpUrl(query, page, tab) {
  const url = new URL('https://search.naver.com/search.naver');
  url.searchParams.set('query', query);
  url.searchParams.set('sm', 'tab_pge');
  const ssc = TABS[tab];
  if (ssc) url.searchParams.set('ssc', ssc);
  url.searchParams.set('start', String((page - 1) * 10 + 1));
  url.searchParams.set('page', String(page));
  return url.toString();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, html: await res.text() };
}

/*
 * 결과 안에서 우리 도메인이 처음 나오는 자리를 찾는다.
 * 네이버 SERP 는 블록(웹사이트·블로그·카페…)이 섞여 있어 "정확한 등수" 를
 * 매기기 어렵다. 그래서 '웹문서 항목 중 몇 번째' 를 순위로 쓴다 —
 * 절대값보다 앞뒤 회차 비교가 목적이라 잣대만 일정하면 된다.
 *
 * 자리를 세는 기준은 렌더된 HTML 의 fds-web-doc-root 다.
 * 처음에는 JSON 쪽 마커(templateId":"webItem)를 썼는데, 그건 페이지에 같이
 * 실려 있을 뿐 링크가 그 안에 없다. 그래서 실제로 1위인 것도 "없음" 으로
 * 세어 75개 표본이 전부 0 으로 나왔다 (2026-09-08). 두 마커 수는 같지만
 * 링크가 들어 있는 쪽은 fds-web-doc-root 다.
 */
function findRank(html, host, offset) {
  const blocked = html.includes('검색 서비스 이용이 제한되었습니다')
    || html.includes('비정상적인 움직임이 발견');
  if (blocked) return { blocked: true };

  const BS = String.fromCharCode(92);
  const esc = host.split('.').join(`${BS}.`);
  const items = [...html.matchAll(/fds-web-doc-root/g)].map((m) => m.index);
  const re = new RegExp(`https?://[a-z0-9.-]*${esc}`, 'i');
  for (let i = 0; i < items.length; i += 1) {
    const from = items[i];
    const to = i + 1 < items.length ? items[i + 1] : html.length;
    if (re.test(html.slice(from, to))) {
      return { blocked: false, items: items.length, rank: offset + i + 1 };
    }
  }
  /*
   * 웹문서 블록 밖(블로그·카페·플레이스)에 뜨는 경우도 있다. 순위는 못 매기지만
   * "떴다" 는 사실은 남긴다 — 0 과 구별해야 한다.
   */
  const outside = re.test(html);
  return { blocked: false, items: items.length, rank: null, outside };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sites = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => {
    const j = JSON.parse(readFileSync(join(projectRoot, 'data/brands', f), 'utf8'));
    return { key: f.replace(/\.json$/, ''), site: j };
  })
  .filter((x) => x.site.host && x.site.host !== 'TBD.co.kr')
  .sort((a, b) => a.key.localeCompare(b.key));

const total = sites.length * perSite
  * tabs.reduce((n, t) => n + (PAGEABLE[t] ? maxPages : 1), 0);
console.log(`브랜드 ${sites.length}곳 · 검색어 ${perSite}개씩 · ${maxPages}페이지`
  + ` · 탭 ${tabs.join('·')} · 조회 최대 ${total}건 · ${delayMs}ms 간격`);
console.log(`예상 소요 약 ${Math.ceil((total * delayMs) / 60000)}분`
  + `${dryRun ? ' · DRY RUN(기록 안 함)' : ''}\n`);

const results = [];
let blockedCount = 0;
for (const { key, site } of sites) {
  const qs = queriesFor(key, site);
  const rows = [];
  for (const { q, level } of qs) {
    const byTab = {};
    for (const tab of tabs) {
      let found = null;
      let items = 0;
      const pages = PAGEABLE[tab] ? maxPages : 1;
      for (let p = 1; p <= pages; p += 1) {
        let r;
        try {
          const { html } = await fetchHtml(serpUrl(q, p, tab));
          r = findRank(html, site.host, (p - 1) * 10);
        } catch (e) {
          r = { error: String(e.message).slice(0, 60) };
        }
        await sleep(delayMs);
        if (r.blocked) { blockedCount += 1; found = 'blocked'; break; }
        if (r.error) { found = 'error'; break; }
        items += r.items || 0;
        if (r.rank) { found = r.rank; break; }
        if (r.outside) { found = '블록밖'; break; }
      }
      byTab[tab] = { rank: found, items };
    }
    rows.push({ q, level, byTab });
    const shown = tabs.map((t) => {
      const v = byTab[t].rank;
      return `${t} ${v === null ? '없음' : typeof v === 'number' ? `${v}위` : v}`;
    }).join(' · ');
    console.log(`  ${key.padEnd(8)} ${level.padEnd(4)} ${q.padEnd(24)} ${shown}`);
  }
  const stat = (tab) => {
    const nums = rows.map((r) => r.byTab[tab]?.rank).filter((x) => typeof x === 'number');
    return {
      hit: nums.length,
      best: nums.length ? Math.min(...nums) : null,
      avg: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null,
    };
  };
  results.push({
    key, host: site.host, brand: site.brand, arm: ARM[key] || '-', rows,
    of: rows.length,
    tabs: Object.fromEntries(tabs.map((t) => [t, stat(t)])),
  });
}

console.log('\n== 요약 ==');
const pad = (s, n) => String(s).padEnd(n - (String(s).match(/[가-힣]/g) || []).length);
console.log(`${pad('사이트', 14)}${pad('구분', 12)}`
  + tabs.map((t) => `${`${t} 잡힘`.padStart(10)}${`최고`.padStart(7)}${`평균`.padStart(7)}`).join(''));
for (const r of results) {
  const cells = tabs.map((t) => {
    const st = r.tabs[t];
    return `${`${st.hit}/${r.of}`.padStart(10)}${String(st.best ?? '-').padStart(7)}${String(st.avg ?? '-').padStart(7)}`;
  }).join('');
  console.log(`${pad(r.brand, 14)}${pad(r.arm, 12)}${cells}`);
}
if (blockedCount) {
  console.log(`\n⚠ 차단 ${blockedCount}건 — 이 회차 숫자는 믿지 말 것. IP 예산을 다 쓴 것이다.`);
}

if (save && !dryRun) {
  const dir = join(projectRoot, 'reports/brand-serp-rank');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({
    takenAt: new Date().toISOString(), perSite, maxPages, tabs, blockedCount, results,
  }, null, 1)}\n`);
  console.log(`\n기준선을 남겼습니다 → ${file.replace(projectRoot, '.')}`);
}
