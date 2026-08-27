#!/usr/bin/env node
/**
 * apex(루트 도메인) 홈페이지 공용 자산을 Cloudflare R2 에 올린다.
 *
 *   node scripts/upload-apex-assets-to-r2.mjs --version apex-v1 --dry-run
 *   node scripts/upload-apex-assets-to-r2.mjs --version apex-v1
 *
 * 올리는 것
 *   apex.css          기본 시트 + 테마 + 모션을 이어붙인 한 파일
 *   hero/<루트>.webp  루트별 히어로 사진 10장
 *
 * --version 은 필수다. 버전 폴더는 immutable(엣지 1년 캐시)이라 덮어쓰면 되돌릴
 * 수 없다. 배포된 페이지가 보는 버전은 data/apex/apex-content.json 의
 * assetVersion 이고, 이 스크립트가 둘을 대조해 준다.
 *
 * 공개 주소는 https://assets.<루트>/site/<버전>/… 다. assets.* 는 열 개 루트가
 * 같은 버킷을 보므로 한 번만 올리면 전부 쓴다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/local-env.mjs';

loadLocalEnv();  // R2_* 자격증명

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = loadEnv(resolve(projectRoot, '.env'));
const need = (k) => {
  const v = (env[k] || process.env[k] || '').trim();
  if (!v) throw new Error(`.env 에 ${k} 가 없습니다.`);
  return v;
};

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] || '');
};
const dryRun = args.includes('--dry-run');

// 기본값을 두지 않는다 — 실수로 기존 버전 폴더를 덮어쓰는 사고를 막는다.
const version = valueOf('--version');
if (!version) {
  throw new Error('--version apex-vN 을 명시하세요 (기존 버전 덮어쓰기 방지). '
    + '현재 페이지가 참조하는 버전은 data/apex/apex-content.json 의 assetVersion 입니다.');
}

const bucket = need('R2_BUCKET_NAME');
const endpoint = `https://${need('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const content = JSON.parse(readFileSync(resolve(projectRoot, 'data/apex/apex-content.json'), 'utf8'));
const configVersion = content.assetVersion;

const templateDir = resolve(projectRoot, 'apps/apex-static/apex-template');
const assetDir = join(templateDir, 'assets');

// CSS 세 장은 배포 때 한 파일로 합쳐진다. R2 에도 합친 것을 올려야 페이지와 맞는다.
const cssBundle = ['apex.css', 'themes.css', 'motion.css']
  .map((f) => readFileSync(join(assetDir, f), 'utf8'))
  .join('\n');

const heroFiles = existsSync(join(assetDir, 'hero'))
  ? readdirSync(join(assetDir, 'hero')).filter((f) => f.endsWith('.webp')).sort()
  : [];

console.log(`=== apex 자산 R2 업로드 (버전 ${version}, dryRun=${dryRun}) ===`);
console.log(`    apex-content.json assetVersion = ${configVersion}`
  + (configVersion === version ? '' : `  ⚠️ 불일치 — 페이지는 ${configVersion} 를 참조합니다`));
console.log(`  버킷: ${bucket}`);
console.log(`  CSS 번들 ${(cssBundle.length / 1024).toFixed(1)}KB · 히어로 ${heroFiles.length}장`);

function awsEnv() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: need('R2_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: need('R2_SECRET_ACCESS_KEY'),
    AWS_DEFAULT_REGION: 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
}

function put(source, key, type) {
  const size = statSync(source).size;
  console.log(`\n  ${key}  (${size.toLocaleString()} bytes)`);
  if (dryRun) {
    console.log('    [dry-run] 업로드 생략');
    return;
  }
  execFileSync('aws', [
    's3', 'cp', source, `s3://${bucket}/${key}`,
    '--endpoint-url', endpoint,
    '--content-type', type,
    '--cache-control', CACHE_CONTROL,
  ], { stdio: 'inherit', env: awsEnv() });
}

const staging = mkdtempSync(join(tmpdir(), 'apex-r2-'));
const bundlePath = join(staging, 'apex.css');
writeFileSync(bundlePath, cssBundle, 'utf8');

put(bundlePath, `site/${version}/apex.css`, 'text/css; charset=utf-8');
for (const f of heroFiles) {
  put(join(assetDir, 'hero', f), `site/${version}/hero/${f}`, 'image/webp');
}

console.log('\n=== 업로드 완료 ===');
console.log(`  https://assets.daddul.com/site/${version}/apex.css`);
if (heroFiles[0]) console.log(`  https://assets.daddul.com/site/${version}/hero/${heroFiles[0]}`);
console.log('\n  업로드 성공 ≠ 서빙 성공. 위 주소를 curl 로 200 확인할 것.');
