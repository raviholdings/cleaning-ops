#!/usr/bin/env node
/**
 * blog-section-reference-library.md 를 빌더가 읽을 JSON 으로 옮긴다.
 *
 *   node scripts/import-blog-library.mjs
 *   → data/brands/_blog-library.json
 *
 * 원본은 사람이 읽는 문서다. 손으로 JSON 에 옮겨 적으면 둘이 어긋나므로
 * 파싱해서 만든다. 문안을 고칠 일이 있으면 .md 를 고치고 이걸 다시 돌린다.
 *
 * 구조
 *   # 1. 제목 레퍼런스        → sections["제목"] = [{ name, text }]
 *   ## 제목 A — 종합 안내형    → name = "제목 A — 종합 안내형"
 *   본문 문단                  → text
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* 확장본이 늘어나면 여기에 더한다. 같은 묶음 이름이면 뒤에 이어 붙는다. */
const SRCS = [
  'blog-section-reference-library.md',
  'blog-section-reference-library-2.md',
  'blog-section-reference-library-3.md',
  'blog-section-reference-library-4.md',
].map((f) => join(projectRoot, f)).filter((f) => existsSync(f));
const OUT = join(projectRoot, 'data/brands/_blog-library.json');

const lines = SRCS.map((f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  .join('\n').split('\n');

/* "# 3. 막힘 원인 설명 레퍼런스" 에서 "막힘 원인 설명" 만 뽑는다. */
const groupName = (h) => h
  .replace(/^#\s*\d+\.\s*/, '')
  .replace(/\s*레퍼런스\s*$/, '')
  .trim();

const groups = {};
let group = null;
let item = null;

const flush = () => {
  if (!group || !item) return;
  const text = item.buf.join('\n').trim();
  if (text) {
    (groups[group] ||= []).push({ name: item.name, text });
  }
  item = null;
};

for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  if (/^#\s+\d+\./.test(line)) {          // # 3. 막힘 원인 설명 레퍼런스
    flush();
    group = groupName(line);
    continue;
  }
  if (/^#\s/.test(line)) {                 // 제목·기본 치환 변수 등 그 밖의 h1
    flush();
    group = null;
    continue;
  }
  if (/^##\s/.test(line)) {                // ## 원인 A — 싱크대 기름 슬러지
    flush();
    if (group) item = { name: line.replace(/^##\s*/, '').trim(), buf: [] };
    continue;
  }
  if (line === '---') { flush(); continue; }
  if (item) item.buf.push(line);
}
flush();

/*
 * 백틱은 문서를 읽기 좋게 하려고 넣은 것이다. 그대로 두면 화면에 ` 가 찍힌다.
 * 자리표시자는 {지역} 꼴로 남겨 빌더가 채운다.
 */
for (const arr of Object.values(groups)) {
  for (const x of arr) x.text = x.text.replace(/`/g, '');
}

/*
 * "사례 사용 규칙" 처럼 글에 실을 문안이 아니라 작성 지침인 항목은 뺀다.
 * 그대로 두면 "완벽 제거 같은 표현을 피합니다" 가 손님 눈에 보이는 본문으로 나간다.
 */
const GUIDE = /(사용 규칙|조합법|편집 원칙|권장 순서)/;
/*
 * 항목 이름이 아니라 '본문 안에 섞인 작성 지침' 을 잡는다.
 * 이름으로만 거르면 FAQ 답변 끝에 붙은 "…같은 표현을 사용하지 않습니다" 가
 * 그대로 손님에게 나간다. 실제로 드림 256장에 나가 있었다 (2026-09-03).
 */
const GUIDE_LINE = /(표현을 사용하지 않습니다|표현은 피하는|처럼 작성합니다|라고 표시합니다|명확히 고지해야|작성하지 않습니다|지나치게 반복하지 않습니다)/;
const leaked = [];
for (const [k, arr] of Object.entries(groups)) {
  for (const x of arr) {
    // 이름으로 이미 버릴 항목과 인용(>) 줄은 본문으로 안 나가므로 검사에서 뺀다
    if (GUIDE.test(x.name)) continue;
    for (const line of x.text.split('\n')) {
      if (line.trim().startsWith('>')) continue;
      if (GUIDE_LINE.test(line)) leaked.push(`${k} / ${x.name}  ${line.trim().slice(0, 70)}`);
    }
  }
  groups[k] = arr.filter((x) => !GUIDE.test(x.name));
  if (!groups[k].length) delete groups[k];
}

if (leaked.length) {
  console.error('\n본문에 작성 지침이 섞여 있습니다 — 손님 눈에 그대로 나갑니다:');
  for (const l of leaked) console.error('  ' + l);
  process.exit(1);
}

const summary = Object.entries(groups)
  .map(([k, v]) => `${k}(${v.length})`)
  .join(' · ');
const total = Object.values(groups).reduce((n, v) => n + v.length, 0);

writeFileSync(OUT, `${JSON.stringify({
  _note: 'blog-section-reference-library.md 에서 만든다. 직접 고치지 말고 .md 를 고친 뒤 '
    + 'node scripts/import-blog-library.mjs 를 다시 돌릴 것.',
  _source: SRCS.map((f) => f.split(/[\\/]/).pop()),
  groups,
}, null, 1)}\n`);

console.log(`  ${Object.keys(groups).length}묶음 · 문안 ${total}개`);
console.log(`  ${summary}`);
console.log(`  → ${OUT}`);
