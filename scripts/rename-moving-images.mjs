#!/usr/bin/env node
/**
 * 이사 광고 이미지 파일명을 카탈로그 규칙에 맞게 바꾼다.
 *
 *   node scripts/rename-moving-images.mjs --dir "<경로>" --dry-run
 *   node scripts/rename-moving-images.mjs --dir "<경로>"
 *
 * 왜 바꾸나
 *   지금은 001.webp 처럼 번호만 있다. 그러면 코드가 "이 사진이 무슨 유형인지"
 *   를 알 수 없어서, 화면의 문구와 사진 내용이 어긋난다.
 *
 *   청소 쪽은 파일명이 곧 메타데이터다.
 *     001_거실_01.webp  =  전체순번_공간_그공간에서몇번째
 *   merged-page-data.mjs 의 imageAt()/pickInRoom() 이 이 이름을 파싱해서
 *   "욕실 청소 전후" 자리에 욕실 사진이 오도록 맞춘다.
 *
 *   이사도 같은 모양으로 맞추면 그 코드를 그대로 쓸 수 있다.
 *     001_포장이사_01.webp
 *
 * 이름은 CSV 의 메인문구 첫 어절에서 뽑는다.
 *   "포장이사 꼼꼼하게" -> 포장이사
 * 25개 유형 × 20장 = 500장이라 청소(10공간 × 50장)와 같은 구조다.
 *
 * 원본은 안 지운다. renamed/ 하위에 새로 만든다. 잘못돼도 되돌릴 게 없다.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dir = valueOf('--dir');
if (!dir) throw new Error('--dir 로 이미지 폴더를 지정하세요.');

const srcDir = resolve(dir);
if (!existsSync(srcDir)) throw new Error(`폴더가 없습니다: ${srcDir}`);

const csvName = readdirSync(srcDir).find((f) => /captions.*\.csv$/i.test(f));
if (!csvName) throw new Error('captions CSV 를 폴더에서 못 찾았습니다.');

const rows = readFileSync(join(srcDir, csvName), 'utf8')
  .replace(/^\uFEFF/, '')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [no, bg, main, sub, file] = line.split(',');
    return { no: Number(no), bg, main: (main || '').trim(), sub: (sub || '').trim(), file: (file || '').trim() };
  })
  .filter((r) => r.no && r.main);

console.log(`=== 이사 이미지 이름 바꾸기 (dryRun=${dryRun}) ===`);
console.log(`  폴더 ${srcDir}`);
console.log(`  CSV  ${csvName} · ${rows.length}행`);

/*
 * 유형별로 1부터 다시 센다. 청소의 "그 공간에서 몇 번째" 와 같은 값이다.
 * CSV 가 유형별로 뭉쳐 있지만 그걸 가정하지 않고 직접 센다.
 */
const seen = new Map();
const plan = [];
for (const row of rows) {
  const type = row.main.split(/\s+/)[0];
  const n = (seen.get(type) || 0) + 1;
  seen.set(type, n);

  // 원본은 CSV 에 .jpg 로 적혀 있지만 실제 파일은 webp 로 변환돼 있다.
  const base = row.file.replace(/\.[^.]+$/, '');
  const from = `${base}.webp`;
  const to = `${String(row.no).padStart(3, '0')}_${type}_${String(n).padStart(2, '0')}.webp`;
  plan.push({ from, to, type });
}

const types = [...seen.entries()].sort((a, b) => b[1] - a[1]);
console.log(`  유형 ${types.length}종`);
for (const [type, n] of types.slice(0, 5)) console.log(`    ${type} ${n}장`);
if (types.length > 5) console.log(`    … 외 ${types.length - 5}종`);

const missing = plan.filter((p) => !existsSync(join(srcDir, p.from)));
if (missing.length) {
  console.log(`\n⚠️ 원본이 없는 항목 ${missing.length}건. 앞 3건:`);
  for (const m of missing.slice(0, 3)) console.log(`    ${m.from}`);
}

console.log('\n예시:');
for (const p of plan.slice(0, 3)) console.log(`  ${p.from}  ->  ${p.to}`);

if (dryRun) {
  console.log('\n[dry-run] 아무것도 쓰지 않았습니다.');
  process.exit(0);
}

const outDir = join(srcDir, 'renamed');
mkdirSync(outDir, { recursive: true });
let done = 0;
for (const p of plan) {
  const from = join(srcDir, p.from);
  if (!existsSync(from)) continue;
  copyFileSync(from, join(outDir, p.to));
  done += 1;
}
console.log(`\n복사 완료 ${done}장 -> ${outDir}`);
console.log('원본은 그대로 뒀습니다.');

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] || '');
}
