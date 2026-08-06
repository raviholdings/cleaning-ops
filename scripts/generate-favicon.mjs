#!/usr/bin/env node
/**
 * 파비콘을 만든다. 외부 이미지 라이브러리 없이 PNG/ICO 를 직접 인코딩한다.
 *
 * 파비콘이 없으면 브라우저가 /favicon.ico 를 요청했다가 404 를 받는다.
 * 네이버 웹마스터 가이드도 "검색 로봇은 파비콘을 웹 페이지 콘텐츠의 일부로
 * 판단한다"며 수집 가능하게 두라고 권고한다.
 *
 *   node scripts/generate-favicon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(projectRoot, 'apps/cleaning-ravi/public');
mkdirSync(outDir, { recursive: true });

// 사이트 본문과 같은 색을 쓴다 (page.css 의 --brand / --accent).
const BRAND = [0x0d, 0x62, 0x73];
const ACCENT = [0xf0, 0xc4, 0x6a];
const WHITE = [0xff, 0xff, 0xff];

/** 물방울 하나와 반짝임 두 개. 청소 서비스라는 뜻만 전달되면 된다. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const radius = size * 0.22; // 라운드 사각형 모서리

  const put = (x, y, [cr, cg, cb], alpha) => {
    if (alpha <= 0) return;
    const i = (y * size + x) * 4;
    const a = Math.min(1, alpha);
    px[i] = Math.round(px[i] * (1 - a) + cr * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + cg * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + cb * a);
    px[i + 3] = Math.round(Math.min(255, px[i + 3] + 255 * a));
  };

  // 배경: 라운드 사각형
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius));
      const dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const dist = Math.hypot(dx, dy);
      const alpha = dist <= radius ? 1 : Math.max(0, 1 - (dist - radius));
      put(x, y, BRAND, alpha);
    }
  }

  // 물방울. 도형 두 개를 겹쳐 그리면 이음새에서 알파가 두 번 섞여 선이 보인다.
  // 픽셀마다 덮임 정도를 한 번만 구해서 한 번만 칠한다.
  const dropCx = size * 0.44;
  const dropCy = size * 0.605;
  const dropR = size * 0.195;
  const tipY = size * 0.215;

  // y 에서의 반폭. 아래쪽은 원, 위쪽은 끝으로 갈수록 좁아지는 곡선.
  const halfWidthAt = (y) => {
    if (y >= dropCy) {
      const dy = y - dropCy;
      return dy > dropR ? -1 : Math.sqrt(dropR * dropR - dy * dy);
    }
    if (y < tipY) return -1;
    const t = (dropCy - y) / (dropCy - tipY);       // 0 = 원 중심, 1 = 끝점
    return dropR * Math.pow(1 - t, 0.68);           // 0.68 이면 옆면이 살짝 부푼다
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 세로로 3번 표본을 떠서 계단 현상을 줄인다.
      let coverage = 0;
      for (const sy of [-0.33, 0, 0.33]) {
        const half = halfWidthAt(y + 0.5 + sy);
        if (half < 0) continue;
        const dx = Math.abs(x + 0.5 - dropCx);
        coverage += Math.max(0, Math.min(1, half - dx + 0.5)) / 3;
      }
      put(x, y, WHITE, coverage);
    }
  }

  // 반짝임 두 개 (오른쪽 위, 왼쪽 아래)
  const sparkle = (cx, cy, len, color) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = Math.abs(x + 0.5 - cx);
        const dy = Math.abs(y + 0.5 - cy);
        const d = dx + dy; // 마름모
        if (d <= len) put(x, y, color, Math.min(1, (len - d) / (len * 0.55)));
      }
    }
  };
  sparkle(size * 0.745, size * 0.285, size * 0.135, ACCENT);
  sparkle(size * 0.195, size * 0.795, size * 0.085, ACCENT);

  return px;
}

function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 각 스캔라인 앞에 필터 바이트(0)를 붙인다.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 는 256px 이하면 PNG 를 그대로 품을 수 있다. */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);           // 1 = 아이콘
  header.writeUInt16LE(pngs.length, 4);

  let offset = 6 + pngs.length * 16;
  const entries = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const sizes = [16, 32, 48, 64, 180];
const pngs = sizes.map((size) => ({ size, data: encodePng(size, drawIcon(size)) }));

writeFileSync(resolve(outDir, 'favicon.ico'), encodeIco(pngs.filter((p) => p.size <= 64)));
writeFileSync(resolve(outDir, 'favicon-32.png'), pngs.find((p) => p.size === 32).data);
writeFileSync(resolve(outDir, 'apple-touch-icon.png'), pngs.find((p) => p.size === 180).data);

// SVG 는 확대해도 안 깨진다. 지원하는 브라우저는 이걸 먼저 쓴다.
// PNG 와 같은 배치로 맞춘다 (물방울 중심 28.2/38.7, 반지름 12.5, 끝점 y=13.8).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="청소 서비스">
  <rect width="64" height="64" rx="14" fill="#0d6273"/>
  <path d="M28.2 13.8 C22.6 24.4 15.7 32.8 15.7 38.7 a12.5 12.5 0 0 0 25 0 C40.7 32.8 33.8 24.4 28.2 13.8 Z" fill="#ffffff"/>
  <path d="M47.7 9.6 l2.7 6.0 6.0 2.7 -6.0 2.7 -2.7 6.0 -2.7 -6.0 -6.0 -2.7 6.0 -2.7 Z" fill="#f0c46a"/>
  <path d="M12.5 45.5 l1.7 3.9 3.9 1.7 -3.9 1.7 -1.7 3.9 -1.7 -3.9 -3.9 -1.7 3.9 -1.7 Z" fill="#f0c46a"/>
</svg>
`;
writeFileSync(resolve(outDir, 'favicon.svg'), svg);

console.log(JSON.stringify({
  outDir,
  files: {
    'favicon.ico': encodeIco(pngs.filter((p) => p.size <= 64)).length,
    'favicon-32.png': pngs.find((p) => p.size === 32).data.length,
    'apple-touch-icon.png': pngs.find((p) => p.size === 180).data.length,
    'favicon.svg': Buffer.byteLength(svg),
  },
}, null, 2));
