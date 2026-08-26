#!/usr/bin/env node
/**
 * apex 히어로 이미지 준비 — 업종숫자 PNG 를 루트별 webp 로 바꾼다.
 *
 * 운영자가 assets/hero/ 에 `배관1.png` `청소2.png` 처럼 넣어 두면
 * 업종 순서대로 루트에 배정해 `<루트>.webp` 로 만든다.
 * 빌더는 `<루트>.webp` 만 찾으므로 이 스크립트를 먼저 돌려야 한다.
 *
 *   node scripts/prepare-apex-hero-images.mjs
 *   node scripts/prepare-apex-hero-images.mjs --width 1600 --quality 78
 *   node scripts/prepare-apex-hero-images.mjs --dry-run
 *
 * 원본 PNG 는 지우지 않는다. 다시 돌리면 webp 만 새로 만든다.
 */
import { readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : (args[i + 1] ?? d); };
const width = Number(valueOf('--width', 1600));
const quality = Number(valueOf('--quality', 78));
const dryRun = args.includes('--dry-run');

const heroDir = resolve(projectRoot, 'apps/apex-static/apex-template/assets/hero');
const content = JSON.parse(readFileSync(resolve(projectRoot, 'data/apex/apex-content.json'), 'utf8'));

const VERTICAL_KO = { piping: '배관', cleaning: '청소', moving: '이사' };

// 루트를 업종별로 묶는다. JSON 의 roots 순서가 곧 1,2,3… 순서다.
const byVertical = new Map();
for (const [root, conf] of Object.entries(content.roots)) {
  const vert = content.specialties[conf.specialty].vertical;
  if (!byVertical.has(vert)) byVertical.set(vert, []);
  byVertical.get(vert).push(root);
}

let sharp;
try { ({ default: sharp } = await import('sharp')); }
catch { throw new Error('sharp 가 필요하다. npm install sharp 후 다시 실행할 것.'); }

const SRC_EXT = ['.png', '.jpg', '.jpeg', '.webp'];
const plan = [];
for (const [vert, roots] of byVertical) {
  const ko = VERTICAL_KO[vert];
  roots.forEach((root, i) => {
    const src = SRC_EXT.map((e) => join(heroDir, `${ko}${i + 1}${e}`)).find((f) => existsSync(f));
    plan.push({ root, vert, label: `${ko}${i + 1}`, src, out: join(heroDir, `${root}.webp`) });
  });
}

const missing = plan.filter((p) => !p.src);
if (missing.length) {
  console.log(`원본 없음 ${missing.length}개 — SVG 도식으로 남는다: ${missing.map((m) => m.label).join(', ')}`);
}

let before = 0;
let after = 0;
for (const p of plan.filter((x) => x.src)) {
  const srcSize = statSync(p.src).size;
  before += srcSize;
  if (dryRun) {
    console.log(`  ${p.label} → ${p.root}.webp  (dry-run)`);
    continue;
  }
  const meta = await sharp(p.src).metadata();
  await sharp(p.src)
    .resize({ width: Math.min(width, meta.width), withoutEnlargement: true })
    .webp({ quality })
    .toFile(p.out);
  const outSize = statSync(p.out).size;
  after += outSize;
  console.log(
    `  ${p.label.padEnd(6)} → ${p.root.padEnd(19)} `
    + `${meta.width}x${meta.height}  ${(srcSize / 1024 / 1024).toFixed(2)}MB → ${(outSize / 1024).toFixed(0)}KB`,
  );
}

if (!dryRun && after) {
  console.log(`\n합계 ${(before / 1024 / 1024).toFixed(1)}MB → ${(after / 1024).toFixed(0)}KB`);
}
