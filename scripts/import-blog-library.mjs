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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(projectRoot, 'blog-section-reference-library.md');
const OUT = join(projectRoot, 'data/brands/_blog-library.json');

const lines = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n').split('\n');

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

const summary = Object.entries(groups)
  .map(([k, v]) => `${k}(${v.length})`)
  .join(' · ');
const total = Object.values(groups).reduce((n, v) => n + v.length, 0);

writeFileSync(OUT, `${JSON.stringify({
  _note: 'blog-section-reference-library.md 에서 만든다. 직접 고치지 말고 .md 를 고친 뒤 '
    + 'node scripts/import-blog-library.mjs 를 다시 돌릴 것.',
  _source: 'blog-section-reference-library.md',
  groups,
}, null, 1)}\n`);

console.log(`  ${Object.keys(groups).length}묶음 · 문안 ${total}개`);
console.log(`  ${summary}`);
console.log(`  → ${OUT}`);
