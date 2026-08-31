#!/usr/bin/env node
/**
 * 브랜드 사이트 교차 검사 — 다섯이 남남으로 보이는지 확인한다.
 *
 *   node scripts/check-brand-sites.mjs dream thunder [...]
 *
 * 이 프로젝트에서 브랜드 사이트가 실패하는 방식은 하나뿐이다. **서로 닮는 것.**
 * 다섯을 한 사람이 만들기 때문에 같은 문장·같은 URL·같은 자산 버전이
 * 자기도 모르게 새어 들어간다. 사람 눈으로는 250장씩 1,290장을 못 본다.
 *
 * 잡는 것
 *   1. 사이트 간 슬러그 충돌      — 같은 URL 이 두 사이트에 있으면 즉시 묶인다
 *   2. 사이트 간 같은 문장        — 복제 판정의 근거가 된다
 *   3. 사이트 안 링크 깨짐        — 앵커 포함
 *   4. 사이트 안 문장 단조로움    — 한 문장이 페이지 대부분에 반복되는지
 *   5. 자산 버전·leadProject 충돌 — 두 사이트가 같은 값을 쓰면 접수가 섞인다
 *
 * 문제가 있으면 종료 코드 1. 배포 전에 돌린다.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outRoot = resolve(projectRoot, 'tmp/brands');
const keys = args.length ? args : ['dream', 'thunder'];

/**
 * 페이지에서 "이 사이트가 쓴 글" 만 남긴다.
 *
 * 접수 폼과 동의 전문은 제외한다. 라벨은 기능이지 브랜드 목소리가 아니라서
 * 다섯 사이트가 똑같이 "이름 / 연락처 / 주소 / 문의내용" 이어야 맞다.
 * 이걸 문장으로 세면 의도한 통일을 중복으로 잡아낸다.
 */
function visibleText(file) {
  return readFileSync(file, 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<form[\s\S]*?<\/form>/g, ' ')
    .replace(/<dialog[\s\S]*?<\/dialog>/g, ' ')
    // 푸터도 기능 영역이다 — 저작권 문구("All rights reserved.")는 사이트마다
    // 같은 게 정상이라, 여기를 세면 다섯이 서로 베낀 것으로 잡힌다.
    .replace(/<footer[\s\S]*?<\/footer>/g, ' ')
    // 사진 캡션도 뺀다. 작업사례 사진 50장은 다섯 사이트가 함께 쓰기로
    // 확정했고(운영자 지시 2026-08-31), 같은 사진에 붙는 설명은 같을 수밖에 없다.
    // 사진 자체가 공유된다는 사실은 캡션을 바꿔도 달라지지 않는다.
    .replace(/<figcaption[\s\S]*?<\/figcaption>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function walkPages(root) {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'assets') walk(f); } else if (e.name === 'index.html') out.push(f);
    }
  }(root));
  return out;
}

/** 문장으로 자른다. 한국어는 종결어미로 끊는 게 마침표보다 정확하다. */
const cutSentences = (text) => text
  .split(/(?<=[.?!다])\s+/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 14);

const problems = [];
const sites = [];

for (const key of keys) {
  const root = join(outRoot, key);
  if (!existsSync(root)) {
    problems.push(`[${key}] 구운 결과가 없습니다: ${root}`);
    continue;
  }
  const meta = JSON.parse(readFileSync(resolve(projectRoot, `data/brands/${key}.json`), 'utf8'));
  const pages = walkPages(root);
  const slugs = new Set(readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['assets', 'area'].includes(e.name))
    .map((e) => e.name));

  const homeHtml = readFileSync(join(root, 'index.html'), 'utf8');

  // 문장 -> 몇 장에 나오는지
  const freq = new Map();
  for (const f of pages) {
    for (const s of new Set(cutSentences(visibleText(f)))) {
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  }

  // 링크·앵커
  let links = 0;
  let broken = 0;
  /*
   * 들어오는 링크를 센다. 0 이면 어디서도 안 걸리는 페이지다 —
   * 사이트맵에는 있으니 404 도 아니고 끊긴 링크도 아니라 여태 안 잡혔다.
   * 실제로 하수구도사의 /services/ 가 이 상태였다 (메뉴가 하위로 바로 갔다).
   */
  const inbound = new Map();
  for (const f of pages) {
    const rel = relative(root, dirname(f)).split(sep).join('/');
    inbound.set(rel, 0);
  }
  for (const f of pages) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/href="(\/[^"#]*)"/g)) {
      links += 1;
      const t = m[1];
      if (!t.startsWith('/assets/')) {
        const key2 = decodeURIComponent(t).replace(/^\/|\/$/g, '');
        if (inbound.has(key2)) inbound.set(key2, inbound.get(key2) + 1);
      }
      const ok = t.startsWith('/assets/')
        ? existsSync(join(root, t))
        : existsSync(join(root, t, 'index.html'));
      if (!ok) { broken += 1; problems.push(`[${key}] 끊긴 링크 ${t} ← ${f}`); }
    }
    for (const m of html.matchAll(/href="#([a-z]+)"/g)) {
      if (!html.includes(`id="${m[1]}"`)) {
        broken += 1;
        problems.push(`[${key}] 없는 앵커 #${m[1]} ← ${f}`);
      }
    }
    /*
     * 홈으로 보내는 앵커(/#faq)도 확인한다. 사이트마다 홈 구성을 다르게 하면서
     * 어떤 구역은 홈에서 빠졌는데, 메뉴가 그대로 그리로 보내면 눌러도 아무 일이
     * 없는 죽은 링크가 된다. 404 가 아니라서 링크 검사만으로는 안 잡힌다.
     */
    for (const m of html.matchAll(/href="\/#([a-z]+)"/g)) {
      if (!homeHtml.includes(`id="${m[1]}"`)) {
        broken += 1;
        problems.push(`[${key}] 홈에 없는 앵커로 보냅니다 /#${m[1]} ← ${f}`);
      }
    }
    if (html.includes('{{')) problems.push(`[${key}] 템플릿 미치환 ← ${f}`);
    if (html.includes('<!--')) problems.push(`[${key}] HTML 주석이 남았습니다 ← ${f}`);
  }

  const orphans = [...inbound.entries()].filter(([k2, n]) => k2 && n === 0).map(([k2]) => k2);
  for (const o of orphans.slice(0, 5)) {
    problems.push(`[${key}] 아무 데서도 안 걸리는 페이지 /${o}/ — 메뉴나 목록에 넣으세요`);
  }
  if (orphans.length > 5) {
    problems.push(`[${key}] 고립 페이지가 ${orphans.length}개입니다 (위 5개는 예시)`);
  }

  sites.push({
    key, meta, pages, slugs, freq, links, broken, orphans,
  });
  console.log(`${key.padEnd(9)} ${String(pages.length).padStart(4)}장  링크 ${links}  `
  + `고립 ${orphans.length}  `
    + `고유문장 ${freq.size.toLocaleString()}`);
}

/* ── 1. 슬러그 충돌 ── */
console.log('\n── 사이트 간 URL ──');
for (let i = 0; i < sites.length; i += 1) {
  for (let j = i + 1; j < sites.length; j += 1) {
    const dup = [...sites[i].slugs].filter((s) => sites[j].slugs.has(s));
    console.log(`  ${sites[i].key} ↔ ${sites[j].key}: 겹치는 슬러그 ${dup.length}`);
    if (dup.length) problems.push(`슬러그 충돌 ${sites[i].key}/${sites[j].key}: ${dup.slice(0, 5).join(' ')}`);
  }
}

/* ── 2. 사이트 간 같은 문장 ── */
console.log('\n── 사이트 간 문장 ──');
for (let i = 0; i < sites.length; i += 1) {
  for (let j = i + 1; j < sites.length; j += 1) {
    const shared = [...sites[i].freq.keys()].filter((s) => sites[j].freq.has(s));
    console.log(`  ${sites[i].key} ↔ ${sites[j].key}: 같은 문장 ${shared.length}`);
    if (shared.length) {
      problems.push(`문장 중복 ${sites[i].key}/${sites[j].key} ${shared.length}건`);
      shared.slice(0, 8).forEach((s) => problems.push(`    "${s.slice(0, 60)}"`));
    }
  }
}

/* ── 3. 사이트 안 단조로움 ──
   고정 요소(상단 띠·CTA·푸터·동의문)는 모든 장에 있어야 정상이다.
   문제는 "본문이어야 할 문장"이 거의 모든 장에 있는 경우인데, 고정 요소와
   구분이 안 되므로 개수만 본다. 지금 기준은 12개 — 그보다 많으면 본문이
   돌지 않고 있다는 뜻이다. */
console.log('\n── 사이트 안 반복 ──');
const ALL_PAGE_LIMIT = 12;
for (const s of sites) {
  const everywhere = [...s.freq.entries()].filter(([, c]) => c >= s.pages.length - 1);
  console.log(`  ${s.key}: 전 페이지 공통 문장 ${everywhere.length}개 (한도 ${ALL_PAGE_LIMIT})`);
  if (everywhere.length > ALL_PAGE_LIMIT) {
    problems.push(`[${s.key}] 전 페이지에 같은 문장이 ${everywhere.length}개 — 본문 변형이 안 걸렸습니다`);
  }
}

/* ── 4. 설정 충돌 ── */
console.log('\n── 설정 ──');
for (const field of ['assetVersion', 'leadProject', 'brand']) {
  const seen = new Map();
  for (const s of sites) {
    const v = s.meta[field];
    if (seen.has(v)) problems.push(`${field} 충돌: ${seen.get(v)} 와 ${s.key} 가 둘 다 "${v}"`);
    seen.set(v, s.key);
  }
  console.log(`  ${field.padEnd(13)} ${[...seen.keys()].join(' · ')}`);
}
const words = sites.map((s) => [s.key, new Set(s.meta.slugWords || [])]);
for (let i = 0; i < words.length; i += 1) {
  for (let j = i + 1; j < words.length; j += 1) {
    const dup = [...words[i][1]].filter((w) => words[j][1].has(w));
    if (dup.length) problems.push(`슬러그 단어가 겹칩니다 ${words[i][0]}/${words[j][0]}: ${dup.join(' ')}`);
  }
}

/* ── 결과 ── */
console.log('');
if (problems.length) {
  console.log(`❌ 문제 ${problems.length}건`);
  problems.slice(0, 40).forEach((p) => console.log(`   ${p}`));
  if (problems.length > 40) console.log(`   … 외 ${problems.length - 40}건`);
  process.exit(1);
}
console.log('✅ 이상 없음 — URL·문장·링크·설정 모두 사이트별로 갈려 있습니다.');
