#!/usr/bin/env node
/**
 * R2 에 올라간 수집요청 응답 원문 로그를 메인 PC 로 내려받는다.
 *
 *   node scripts/fetch-crawl-raw-logs.mjs --date 2026-08-21
 *   node scripts/fetch-crawl-raw-logs.mjs --date 2026-08-21 --machine vm1
 *   node scripts/fetch-crawl-raw-logs.mjs --prefix crawl-raw/db-archive
 *   node scripts/fetch-crawl-raw-logs.mjs --list            # 파일 목록만
 *
 * 저장 위치: reports/naver-raw/ (gunzip 된 jsonl).
 * 각 줄의 (runId, idx) 가 DB 결과 행의 (run_id, result_index) 와 붙는다.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { getObject, listObjects, loadDotEnv, r2ClientFromEnv } from './lib/r2-client.mjs';

const BUCKET = 'ravi-ops-logs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] || '');
};
const date = valueOf('--date');
const machine = valueOf('--machine');
const listOnly = args.includes('--list');
const prefix = valueOf('--prefix') || `crawl-raw/${date}`;

if (!date && !valueOf('--prefix') && !listOnly) {
  console.error('사용법: node scripts/fetch-crawl-raw-logs.mjs --date YYYY-MM-DD [--machine 이름] | --prefix 접두어 | --list');
  process.exit(1);
}

const env = { ...loadDotEnv(readFileSync, join(projectRoot, '.env')), ...process.env };
const client = r2ClientFromEnv(env);
if (!client) throw new Error('.env 에 R2 자격증명이 없습니다 (R2_* / CLOUDFLARE_ACCOUNT_ID).');

const keys = (await listObjects(client, BUCKET, listOnly && !date ? 'crawl-raw/' : prefix))
  .filter((key) => !machine || key.includes(`.${machine}.`));

if (!keys.length) {
  console.log(`r2://${BUCKET}/${prefix} 에 파일이 없습니다.`);
  process.exit(0);
}
if (listOnly) {
  for (const key of keys) console.log(key);
  process.exit(0);
}

const outDir = join(projectRoot, 'reports', 'naver-raw');
mkdirSync(outDir, { recursive: true });

for (const key of keys) {
  const gz = await getObject(client, BUCKET, key);
  const content = key.endsWith('.gz') ? gunzipSync(gz) : gz;
  const outName = key.split('/').pop().replace(/\.gz$/, '');
  const outPath = join(outDir, outName);
  writeFileSync(outPath, content);
  const lineCount = content.toString('utf8').split('\n').filter(Boolean).length;
  console.log(`${outPath}  (${content.length.toLocaleString()} bytes, ${lineCount.toLocaleString()}줄)`);
}
