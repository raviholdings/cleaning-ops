#!/usr/bin/env node
/**
 * 배관 랜딩페이지 공용 자산(CSS, JS, Favicon)을 Cloudflare R2 에 업로드한다.
 *
 *   node scripts/upload-piping-assets-to-r2.mjs --version piping-v2 --dry-run
 *   node scripts/upload-piping-assets-to-r2.mjs --version piping-v2
 *
 * --version 은 필수다. 버전 폴더는 immutable(엣지 1년 캐시)이라 덮어쓰면 되돌릴
 * 수 없고, 배포된 페이지가 보는 버전은 config/piping.json 의 assetVersion 이다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const v = env[k] || process.env[k];
  if (!v) throw new Error(`.env 에 ${k} 가 없습니다.`);
  return v;
};

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] || '');
};

const dryRun = args.includes('--dry-run');
// 기본값을 두지 않는다 — 실수로 기존 버전 폴더(immutable, 엣지 1년 캐시)를
// 덮어쓰는 사고를 막는다. 반드시 --version piping-vN 으로 명시할 것 (2026-08-25).
const version = valueOf('--version');
if (!version) {
  throw new Error('--version piping-vN 을 명시하세요 (기존 버전 덮어쓰기 방지). 현재 페이지가 참조하는 버전은 config/piping.json 의 assetVersion 입니다.');
}

const bucket = need('R2_BUCKET_NAME');
const accountId = need('CLOUDFLARE_ACCOUNT_ID');
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

const assetDir = resolve(projectRoot, 'apps/piping-static/piping-template/assets');
const FILES = [
  { name: 'piping.css', type: 'text/css; charset=utf-8' },
  { name: 'piping.js', type: 'text/javascript; charset=utf-8' },
  { name: 'favicon.ico', type: 'image/x-icon' },
];

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const configVersion = JSON.parse(readFileSync(resolve(projectRoot, 'config/piping.json'), 'utf8')).assetVersion;
console.log(`=== 배관 자산 R2 업로드 (버전 ${version}, dryRun=${dryRun}) ===`);
console.log(`    config/piping.json assetVersion = ${configVersion}` + (configVersion === version ? '' : `  ⚠️ 불일치 — 페이지는 ${configVersion} 를 참조합니다`));
console.log(`  버킷: ${bucket}`);

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

for (const file of FILES) {
  const source = resolve(assetDir, file.name);
  if (!existsSync(source)) throw new Error(`파일이 없습니다: ${source}`);
  const size = statSync(source).size;
  const key = `site/${version}/${file.name}`;

  console.log(`\n  ${file.name} (${size.toLocaleString()} bytes) -> s3://${bucket}/${key}`);
  if (dryRun) {
    console.log('    [dry-run] 업로드 생략');
    continue;
  }

  execFileSync('aws', [
    's3', 'cp', source, `s3://${bucket}/${key}`,
    '--endpoint-url', endpoint,
    '--content-type', file.type,
    '--cache-control', CACHE_CONTROL,
  ], { stdio: 'inherit', env: awsEnv() });
}

console.log('\n=== R2 업로드 완료 ===');
for (const file of FILES) {
  console.log(`  https://assets.daddul.com/site/${version}/${file.name}`);
}
