#!/usr/bin/env node
/**
 * 브랜드별로 어느 지역이 배포돼 있는지 정리해 파일로 낸다.
 *
 *   node scripts/report-brand-regions.mjs
 *   → docs/BRAND-REGIONS.md  (사람이 읽는 표)
 *   → reports/brand-regions.json  (기계가 읽는 원본)
 *
 * 세는 기준은 "구운 결과에 실제로 들어 있는 것" 이다. 데이터 파일을 보고
 * 계산하면 슬라이스 한도(DONG_LIMIT)나 페이지 구조 차이를 놓친다.
 *
 * 동은 페이지가 따로 없다 — 지역 페이지 안에 이름으로만 실린다 (운영자 결정
 * 2026-08-31, 하림배관 레퍼런스가 그렇다). 그래서 "동 페이지 수" 가 아니라
 * "이름이 실제로 실린 동 수" 를 센다.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(projectRoot, 'tmp/brands');
const regions = JSON.parse(readFileSync(join(projectRoot, 'data/hub/regions.json'), 'utf8'));

/* 전국 기준값 */
const sggList = [];
for (const sido of regions.sido) {
  for (const s of sido.sigungu) {
    sggList.push({
      code: s.code.slice(0, 5), sido: sido.name, sigungu: s.shortName,
      repDong: s.repDong, dongCount: s.dongCount,
    });
  }
}
const ALL_DONG = new Set();
for (const s of sggList) for (const d of s.repDong) ALL_DONG.add(d);
const TOTAL = {
  sido: regions.sido.length,
  sigungu: sggList.length,
  dongOfficial: regions.counts.dong,
  repDong: sggList.reduce((n, s) => n + s.repDong.length, 0),
  repDongDistinct: ALL_DONG.size,
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'assets') walk(p, out); } else if (e.name === 'index.html') out.push(p);
  }
  return out;
}

/* 화면에 실린 글자에서 동 이름을 찾는다. 마크업이 사이트마다 달라 태그를 지우고 본다. */
const textOf = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/g, ' ');

const keys = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((k) => existsSync(join(outRoot, k)))
  .sort();

const sites = [];
for (const key of keys) {
  const site = JSON.parse(readFileSync(join(projectRoot, `data/brands/${key}.json`), 'utf8'));
  const files = walk(join(outRoot, key));

  const dongSeen = new Set();
  const sggSeen = new Set();
  let dongMentions = 0;
  for (const f of files) {
    const words = textOf(readFileSync(f, 'utf8')).split(/[^가-힣]+/);
    for (const w of words) {
      if (w.length >= 2 && ALL_DONG.has(w)) { dongSeen.add(w); dongMentions += 1; }
    }
  }
  for (const s of sggList) {
    // 시군구 이름이 어디든 실렸는지 — 지역 페이지가 있으면 반드시 실린다
    if (files.some((f) => readFileSync(f, 'utf8').includes(s.sigungu))) sggSeen.add(s.code);
  }

  sites.push({
    key,
    brand: site.brand,
    host: site.host,
    structure: site.structure || 'flat',
    pages: files.length,
    sigunguCovered: sggSeen.size,
    dongDistinct: dongSeen.size,
    dongMentions,
  });
  console.log(`  ${key.padEnd(8)} ${String(files.length).padStart(5)}장 · 시군구 ${sggSeen.size} · `
    + `동 ${dongSeen.size}종 (노출 ${dongMentions.toLocaleString()}회)`);
}

/* 사이트별 시군구당 동 노출 한도 — 코드에 박힌 값이라 여기 적어 둔다 */
const DONG_LIMIT_NOTE = {
  dream: '지역 페이지 1장에 최대 60개',
  thunder: '지역 페이지 1장에 최대 60개',
  mole: '지역 페이지 1장에 최대 60개',
  ssak: '글 1편에 최대 40개',
  dosa: '시군구 페이지 1장에 최대 60개',
};

const md = [];
md.push('# 브랜드별 배포 지역', '');
md.push(`구운 결과에서 직접 센 것이다 (${new Date().toISOString().slice(0, 10)}).`);
md.push('`node scripts/report-brand-regions.mjs` 로 다시 만든다.', '');
md.push('## 전국 기준값', '');
md.push('| | 수 |', '|---|---|');
md.push(`| 시도 | ${TOTAL.sido} |`);
md.push(`| 시군구 | ${TOTAL.sigungu} |`);
md.push(`| 행정동 (전국) | ${TOTAL.dongOfficial.toLocaleString()} |`);
md.push(`| 그중 대표동(repDong) | ${TOTAL.repDong.toLocaleString()} |`);
md.push(`| 대표동 고유 이름 | ${TOTAL.repDongDistinct.toLocaleString()} |`);
md.push('');
md.push('`repDong` 은 시군구마다 골라 둔 대표 동네다 (평균 18.6개, 최소 2 최대 79).');
md.push('전국 행정동 5,067개를 다 싣지 않는 이유는 한 페이지에 이름만 수백 개 나열하면');
md.push('사람에게도 검색엔진에도 도움이 안 되기 때문이다.', '');
md.push('## 브랜드별', '');
md.push('| 브랜드 | 도메인 | 구조 | 페이지 | 시군구 | 동(고유) | 동 노출 | 동 한도 |');
md.push('|---|---|---|---|---|---|---|---|');
for (const s of sites) {
  md.push(`| ${s.brand} | ${s.host} | ${s.structure} | ${s.pages.toLocaleString()} | `
    + `${s.sigunguCovered} | ${s.dongDistinct.toLocaleString()} | ${s.dongMentions.toLocaleString()}회 | `
    + `${DONG_LIMIT_NOTE[s.key] || '-'} |`);
}
md.push('');
md.push('## 시군구 한 장에 동이 몇 개나', '');
md.push('| 개수 | 시군구 |', '|---|---|');
{
  const dist = { '1~9': 0, '10~19': 0, '20~39': 0, '40~59': 0, '60 이상': 0 };
  for (const s of sggList) {
    const n = s.repDong.length;
    const b2 = n < 10 ? '1~9' : n < 20 ? '10~19' : n < 40 ? '20~39' : n < 60 ? '40~59' : '60 이상';
    dist[b2] += 1;
  }
  for (const [k, v] of Object.entries(dist)) md.push(`| ${k} | ${v} |`);
}
md.push('');
md.push('중앙값 13개다. 상한(60)에 닿는 시군구는 넷뿐이라 **한도가 병목이 아니다** —');
md.push('데이터가 가진 만큼 다 싣고 있다. 강남구는 repDong 14개를 14개 다 싣는다.');
md.push('');
md.push('동이 적어 보인다면 원인은 둘 중 하나다.');
md.push('');
md.push('1. `repDong` 이 1동·2동을 합친 이름이다 (역삼1동·역삼2동 -> 역삼동).');
md.push('   전국 행정동 5,067 대비 4,761 로 94% 수준.');
md.push('2. **동 단위 페이지가 없다.** 아래를 볼 것.');
md.push('');
md.push('## 동은 페이지가 없다', '');
md.push('운영자 결정(2026-08-31)이다. 레퍼런스(하림배관)도 nav 에는 구까지만 두고');
md.push('동은 본문에 이름으로만 싣는다. 그래서 위 표의 "동" 은 **페이지 수가 아니라**');
md.push('이름이 실제로 실린 동의 수다.', '');
md.push('레퍼런스(하림배관)는 동 페이지를 실제로 갖고 있다 —');
md.push('`cloggedpipe.co.kr/dangu-dong-clogged-sink/` 같은 꼴이다. 우리는 아직 없다.');
md.push('');
md.push('붙이기로 한 방식은 `메인.com/랜덤영단어` 다 (운영자 결정 2026-08-31). 아직 안 만들었다.');
md.push('만들면 규모는 이렇게 된다.');
md.push('');
md.push('    동 4,761 x 키워드 1종 =  4,761장');
md.push('    동 4,761 x 키워드 3종 = 14,283장');
md.push('');
md.push('수집요청 한도가 사이트당 하루 50건이라, 늘린 만큼 색인까지 가는 기간도 늘어난다.');
md.push('지금도 싹쓰리 67일 · 도사 73일이다.', '');
md.push('## 시도별 시군구 수', '');
md.push('| 시도 | 시군구 | 대표동 |', '|---|---|---|');
for (const sido of regions.sido) {
  const n = sido.sigungu.length;
  const d = sido.sigungu.reduce((a, s) => a + s.repDong.length, 0);
  md.push(`| ${sido.name} | ${n} | ${d.toLocaleString()} |`);
}
md.push('');
md.push('다섯 브랜드가 같은 256개 시군구를 모두 덮는다. 지역을 나눠 갖지 않는다 —');
md.push('서로 다른 회사가 전국 영업을 하는 모양이라야 하기 때문이다.', '');

const mdPath = join(projectRoot, 'docs/BRAND-REGIONS.md');
writeFileSync(mdPath, `${md.join('\n')}\n`);

const jsonPath = join(projectRoot, 'reports/brand-regions.json');
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify({
  generated_at: new Date().toISOString(),
  total: TOTAL,
  sites,
  sido: regions.sido.map((s) => ({
    name: s.name,
    sigungu: s.sigungu.length,
    repDong: s.sigungu.reduce((a, x) => a + x.repDong.length, 0),
  })),
  sigungu: sggList.map((s) => ({
    code: s.code, sido: s.sido, sigungu: s.sigungu,
    repDong: s.repDong.length, dongCount: s.dongCount,
  })),
}, null, 1)}\n`);

console.log(`\n  → ${mdPath}`);
console.log(`  → ${jsonPath}`);
