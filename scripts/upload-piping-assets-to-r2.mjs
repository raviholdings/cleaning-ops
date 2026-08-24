#!/usr/bin/env node
/**
 * 배관 랜딩페이지 공용 자산(CSS, JS, Favicon)을 Cloudflare R2 에 업로드한다.
 *
 *   node scripts/upload-piping-assets-to-r2.mjs
 *   node scripts/upload-piping-assets-to-r2.mjs --version piping-v1
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
const version = valueOf('--version') || 'piping-v1';

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

console.log(`=== 배관 자산 R2 업로드 (버전 ${version}, dryRun=${dryRun}) ===`);
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
