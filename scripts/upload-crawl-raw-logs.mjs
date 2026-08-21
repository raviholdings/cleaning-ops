#!/usr/bin/env node
/**
 * 수집요청 응답 원문 로그(logs/naver-raw/*.jsonl)를 R2 프라이빗 버킷에 올린다.
 *
 *   node scripts/upload-crawl-raw-logs.mjs
 *
 * 동작
 *   - 지난 날짜(KST) 파일만 올린다. 오늘 파일은 아직 쓰는 중이므로 건드리지 않는다.
 *   - 올린 파일은 logs/naver-raw/uploaded/ 로 옮긴다(로컬 사본 유지).
 *     같은 날짜 파일이 또 생기면(드묾) 합쳐서 다시 올린다 — R2 쪽은 항상 상위집합.
 *   - 자격증명이 없거나 실패해도 exit 0 — 러너 래퍼가 매 사이클 끝에 부르므로
 *     수집요청 자체를 막으면 안 된다. 경고는 stdout 으로만 낸다.
 *
 * 버킷: ravi-ops-logs (프라이빗 — cleaning-assets 는 assets.* 로 공개 서빙되므로
 * 로그를 절대 거기 두지 않는다). 키: crawl-raw/{날짜}.{기계}.jsonl.gz
 * 내려받기: node scripts/fetch-crawl-raw-logs.mjs --date YYYY-MM-DD
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadDotEnv, putObject, r2ClientFromEnv } from './lib/r2-client.mjs';

const BUCKET = 'ravi-ops-logs';
const PREFIX = 'crawl-raw';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = process.env.NAVER_CRAWL_RAW_LOG_DIR || join(projectRoot, 'logs', 'naver-raw');
const uploadedDir = join(logDir, 'uploaded');

const env = { ...loadDotEnv(readFileSync, join(projectRoot, '.env')), ...process.env };
const client = r2ClientFromEnv(env);
if (!client) {
  console.log('[upload-raw] R2 자격증명이 없어 업로드를 건너뜁니다 (.env 의 R2_* / CLOUDFLARE_ACCOUNT_ID).');
  process.exit(0);
}

const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
let pending = [];
try {
  pending = readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\..+\.jsonl$/);
      return match && match[1] < todayKst;
    })
    .sort();
} catch {
  process.exit(0); // 로그 디렉터리 자체가 없음 — 올릴 게 없다
}

if (!pending.length) process.exit(0);

let ok = 0;
for (const name of pending) {
  try {
    const originalPath = join(logDir, name);
    const archivedPath = join(uploadedDir, name);
    let content = readFileSync(originalPath);
    if (existsSync(archivedPath)) {
      content = Buffer.concat([readFileSync(archivedPath), content]);
    }
    await putObject(client, BUCKET, `${PREFIX}/${name}.gz`, gzipSync(content), 'application/gzip');
    mkdirSync(uploadedDir, { recursive: true });
    writeFileSync(archivedPath, content);
    rmSync(originalPath);
    ok += 1;
    console.log(`[upload-raw] ${name} -> r2://${BUCKET}/${PREFIX}/${name}.gz (${content.length.toLocaleString()} bytes)`);
  } catch (error) {
    console.log(`[upload-raw] ${name} 실패: ${error?.message || String(error)} — 다음 사이클에 재시도`);
  }
}
console.log(`[upload-raw] ${ok}/${pending.length}개 업로드 완료`);
