#!/usr/bin/env node
/**
 * 랜딩페이지 공용 자산(CSS·JS)을 R2 에 올린다.
 *
 *   node scripts/upload-site-assets-to-r2.mjs --dry-run
 *   node scripts/upload-site-assets-to-r2.mjs
 *   node scripts/upload-site-assets-to-r2.mjs --version v2
 *
 * 왜 필요한가
 *   예전에는 CSS 21KB 와 JS 4KB 가 페이지마다 통째로 박혀 나갔다. 100만
 *   페이지면 같은 내용이 100만 번 복제된 셈이고, 그것만으로 24GB 다.
 *   한 번만 올려두고 <link>·<src> 로 가리키면 그 24GB 가 사라진다.
 *
 * 버전 폴더를 쓰는 이유
 *   고정 이름으로 두면 내용을 고쳐도 Cloudflare 와 브라우저 캐시에 옛 파일이
 *   남아 새 페이지와 섞인다. site/v1/ 로 올리고 다음에는 v2 로 올리면
 *   템플릿 경로만 바꿔서 한 번에 갈아탈 수 있다.
 *
 * 자격증명은 .env 의 R2_* 와 CLOUDFLARE_ACCOUNT_ID 를 쓴다. R2 는 S3 호환이라
 * aws CLI 로 올린다(이미 설치돼 있다). 값 끝에 공백이 붙어 있으면 서명이
 * 어긋나므로 반드시 trim 한다 — 실제로 그 때문에 한 번 막혔다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = loadEnv(resolve(projectRoot, '.env'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// 기본값을 두지 않는다 — 실수로 기존 버전 폴더(immutable, 엣지 1년 캐시)를
// 덮어쓰는 사고를 막는다. 반드시 --version vN 으로 명시할 것 (2026-08-22).
const version = valueOf('--version') || process.env.PUBLIC_ASSET_VERSION;
if (!version) throw new Error('--version vN 을 명시하세요 (기존 버전 덮어쓰기 방지).');

const bucket = need('R2_BUCKET_NAME');
const accountId = need('CLOUDFLARE_ACCOUNT_ID');
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

const assetDir = resolve(projectRoot, 'apps/cleaning-static/templates-merged/assets');
const FILES = [
  { name: 'styles.css', type: 'text/css; charset=utf-8' },
  { name: 'app.js', type: 'text/javascript; charset=utf-8' },
];

/*
 * 캐시 정책.
 *
 * 버전 폴더를 쓰므로 같은 주소의 내용이 바뀔 일이 없다. 그래서 최대한 길게
 * 잡아 브라우저와 Cloudflare 가 다시 받지 않게 한다. 크롤러가 100만 페이지를
 * 긁을 때 이 파일을 매번 받으면 그만큼 크롤링 예산이 줄어든다.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

console.log(`=== 자산 업로드 (버전 ${version}, dryRun=${dryRun}) ===`);
console.log(`  버킷 ${bucket}`);

for (const file of FILES) {
  const source = resolve(assetDir, file.name);
  if (!existsSync(source)) throw new Error(`파일이 없습니다: ${source}`);
  const size = statSync(source).size;
  const key = `site/${version}/${file.name}`;

  console.log(`\n  ${file.name}  ${size.toLocaleString()} bytes  ->  s3://${bucket}/${key}`);
  if (dryRun) { console.log('    [dry-run] 올리지 않음'); continue; }

  execFileSync('aws', [
    's3', 'cp', source, `s3://${bucket}/${key}`,
    '--endpoint-url', endpoint,
    '--content-type', file.type,
    '--cache-control', CACHE_CONTROL,
  ], { stdio: 'inherit', env: awsEnv() });
}

if (!dryRun) {
  console.log('\n=== 확인 ===');
  for (const file of FILES) {
    console.log(`  https://assets.<루트도메인>/site/${version}/${file.name}`);
  }
  console.log('\n실제로 열리는지 보려면:');
  console.log(`  curl -I https://assets.pipe-oneshot.com/site/${version}/styles.css`);
}

// ---------------------------------------------------------------- 유틸

function awsEnv() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: need('R2_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY: need('R2_SECRET_ACCESS_KEY'),
    AWS_DEFAULT_REGION: 'auto',
    // aws CLI v2 가 기본으로 붙이는 체크섬을 R2 가 거부하는 경우가 있다.
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  };
}

function need(key) {
  const value = (env[key] || process.env[key] || '').trim();
  if (!value) throw new Error(`.env 에 ${key} 가 없습니다.`);
  return value;
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] || '');
}

function loadEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}
