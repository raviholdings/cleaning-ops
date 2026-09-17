#!/usr/bin/env node
/**
 * piping-xyz 도메인의 네이버 소유확인 토큰(naver_verification_token)을
 * 사이트별 gen/naver_meta.json 으로 내보낸다. head.sub1.php 가 이 파일을 읽어
 * 호스트에 맞는 <meta name="naver-site-verification"> 를 찍는다.
 *
 *   {"readycrayon": "토큰", "@": "루트 토큰"}
 *
 *   node scripts/export-piping-xyz-naver-meta.mjs             # 쓰기
 *   node scripts/export-piping-xyz-naver-meta.mjs --dry-run   # 건수만
 *
 * register-naver-searchadvisor-sites.mjs 를 돌린 뒤, verify 전에 매번 실행.
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/* 등록 직후 verify 전에 매번 불러야 하는 스크립트라 .env 를 직접 읽는다.
   naverops.sh 를 안 거쳐도 그냥 돌아가야 한다. */
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

const dryRun = process.argv.includes('--dry-run');
const GROUP = 'piping-xyz';
const SITES_DIR = 'C:/xampp/sites';
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops.sh 로 실행)');
// 2026-09-17: 정본이 로컬에서 Supabase 로 옮겨갔다 (VM 3대가 붙어야 해서).
// 실수로 엉뚱한 DB 를 건드리지 않게 이름으로만 확인한다.
if (!/naver_hub|supabase/.test(url)) throw new Error('안전장치: 모르는 DB 입니다. 중단.');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows } = await c.query(
  `select host, naver_verification_token as token, naver_registration_status as status
     from naver_project_domains
    where group_key = $1 and naver_verification_token is not null
    order by host`, [GROUP]);
const { rows: rootRows } = await c.query(
  `select distinct split_part(host, '.', -2) || '.' || split_part(host, '.', -1) as root
     from naver_project_domains where group_key = $1`, [GROUP]);
await c.end();

const byRoot = new Map(rootRows.map((r) => [r.root, {}]));
let bad = 0;
for (const r of rows) {
  if (!/^[0-9a-f]{16,}$/i.test(r.token)) { bad += 1; continue; }
  const labels = r.host.split('.');
  const root = labels.slice(-2).join('.');
  const sub = labels.length > 2 ? labels.slice(0, -2).join('.') : '@';
  if (!byRoot.has(root)) byRoot.set(root, {});
  byRoot.get(root)[sub] = r.token;
}
for (const [root, map] of byRoot) {
  const n = Object.keys(map).length;
  const gen = `${SITES_DIR}/${root}/gen`;
  if (dryRun) { console.log(`${root}: 토큰 ${n}개 (dry-run)`); continue; }
  if (!existsSync(gen)) { console.log(`${root}: gen 폴더 없음, 건너뜀`); continue; }
  const path = `${gen}/naver_meta.json`;
  writeFileSync(path + '.tmp', JSON.stringify(map, null, 1) + '\n', 'utf8');
  renameSync(path + '.tmp', path);
  console.log(`${root}: naver_meta.json 토큰 ${n}개`);
}
if (bad) console.log(`형식이 이상한 토큰 ${bad}개는 제외`);
