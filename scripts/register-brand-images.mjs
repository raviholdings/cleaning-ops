#!/usr/bin/env node
/**
 * 브랜드 사이트 사진 등록 — 폴더에 넣은 파일을 <키>.json 의 images.pool 로 옮긴다.
 *
 *   node scripts/register-brand-images.mjs                 # 다섯 사이트 전부 훑는다
 *   node scripts/register-brand-images.mjs dream thunder   # 지정한 것만
 *   node scripts/register-brand-images.mjs --dry-run       # 바꾸지 않고 보기만
 *
 * 운영자가 JSON 을 손으로 고치지 않아도 되게 하려고 만들었다. 규칙은 파일 이름 하나뿐이다.
 *
 *   apps/brand-static/<키>-template/assets/img/<키>-NN.<확장자>
 *   예) dream-01.webp   thunder-07.jpg
 *
 * NN 은 주제 번호(01~10)다. 주제표는 SUBJECTS 에 있고, 화면에 나가는 설명(캡션)은
 * 사이트마다 다르게 써야 하므로 <키>.json 의 images.captions 에서 가져온다.
 * 없으면 SUBJECTS 의 기본 이름을 쓴다.
 *
 * 가로·세로는 파일에서 직접 읽는다. 사람이 적으면 틀리고, 틀리면 사진이 뜰 때
 * 화면이 덜컹거린다(레이아웃 시프트).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const keys = args.filter((a) => !a.startsWith('--'));
const ALL = ['dream', 'thunder', 'mole', 'ssak', 'dosa'];

/** 주제 번호 → 무엇을 찍은 사진인지. 다섯 사이트가 같은 번호 체계를 쓴다. */
const SUBJECTS = {
  '01': '변기 막힘 작업',
  '02': '꺼낸 이물질',
  '03': '욕실·베란다 배수구 분해',
  '04': '걷어낸 침전물',
  '05': '싱크대 배수 작업',
  '06': '굳은 기름층 제거',
  '07': '세면대 아래 관 분해',
  '08': '관 내시경 확인',
  '09': '보유 장비',
  '10': '작업 후 정리',
};

/* ────────────────────────────────────────────────────────────
   가로·세로 읽기. 의존성을 새로 들이지 않으려고 헤더만 직접 뜯는다.
   PNG · JPEG · WebP(VP8/VP8L/VP8X) 세 가지면 충분하다.
   ──────────────────────────────────────────────────────────── */
function imageSize(buf, file) {
  // PNG: 8바이트 시그니처 + IHDR
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // WebP: RIFF....WEBP
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  // JPEG: SOF 마커까지 세그먼트를 건너뛴다
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOF0~SOF15 중 DHT(c4)·JPG(c8)·DAC(cc) 는 크기 정보가 아니다
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error(`가로·세로를 읽지 못했습니다: ${file} (png · jpg · webp 만 됩니다)`);
}

let changed = 0;
let problems = 0;

for (const key of (keys.length ? keys : ALL)) {
  const jsonPath = resolve(projectRoot, `data/brands/${key}.json`);
  if (!existsSync(jsonPath)) { console.log(`${key}: 설정이 없습니다 (${jsonPath})`); problems += 1; continue; }
  const site = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const imgDir = resolve(projectRoot, `apps/brand-static/${site.template || key}-template/assets/img`);

  const files = existsSync(imgDir)
    ? readdirSync(imgDir).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort()
    : [];

  const pool = [];
  const skipped = [];
  const captions = site.images?.captions || {};

  for (const file of files) {
    const m = file.match(/^([a-z]+)-(\d{2})\./i);
    if (!m) { skipped.push(`${file} — 이름이 <키>-NN.확장자 형식이 아닙니다`); continue; }
    if (m[1] !== key) { skipped.push(`${file} — ${key} 폴더에 ${m[1]} 파일이 있습니다`); continue; }
    const no = m[2];
    if (!SUBJECTS[no]) { skipped.push(`${file} — ${no}번 주제가 없습니다 (01~10)`); continue; }

    const { width, height } = imageSize(readFileSync(join(imgDir, file)), file);
    if (width < 600) skipped.push(`${file} — 가로 ${width}px 은 너무 작습니다 (800px 이상 권장)`);
    pool.push({
      file, no, label: captions[no] || SUBJECTS[no], width, height,
    });
  }

  const covered = new Set(pool.map((p) => p.no));
  const missing = Object.keys(SUBJECTS).filter((n) => !covered.has(n));

  console.log(`\n${key} (${site.brand})`);
  console.log(`  등록 ${pool.length}장 / 주제 ${Object.keys(SUBJECTS).length}개`);
  if (missing.length) {
    console.log(`  아직 없는 주제: ${missing.map((n) => `${n} ${SUBJECTS[n]}`).join(' · ')}`);
  }
  for (const s of skipped) { console.log(`  ⚠ ${s}`); problems += 1; }
  if (pool.length && pool.length < 8) {
    console.log(`  ⚠ ${pool.length}장이면 지역 256장에 같은 조합이 자주 겹칩니다 (9장 이상 권장)`);
  }

  const before = JSON.stringify(site.images?.pool || []);
  const after = JSON.stringify(pool);
  if (before === after) { console.log('  변경 없음'); continue; }
  if (dryRun) { console.log('  (--dry-run: 저장하지 않음)'); continue; }

  site.images = { ...(site.images || {}), pool };
  writeFileSync(jsonPath, `${JSON.stringify(site, null, 2)}\n`);
  changed += 1;
  console.log('  저장했습니다.');
}

console.log(`\n설정 ${changed}개 갱신${problems ? ` · 확인할 것 ${problems}건` : ''}`);
console.log('사진을 바꿨으면 다시 구우세요: node scripts/build-brand-site.mjs --site <키>');
if (problems) process.exit(1);
