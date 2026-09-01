#!/usr/bin/env node
/**
 * 서치어드바이저 소유확인 토큰을 DB 에서 읽어 사이트 json 에 넣는다.
 *
 *   node scripts/sync-brand-verification.mjs             무엇이 바뀌는지만 (기본)
 *   node scripts/sync-brand-verification.mjs --apply
 *
 * 등록 스크립트가 받아 온 값은 naver_project_domains.naver_verification_token 에
 * 있고, 굽기가 읽는 자리는 data/brands/<키>.json 의 naverVerification 이다.
 * 둘 사이를 손으로 옮기면 40자짜리 16진수 다섯 개를 눈으로 베끼는 일이 되는데,
 * 한 글자만 틀려도 소유확인이 실패하고 원인이 화면에 안 나온다.
 *
 * 토큰만 옮긴다. 등록·소유확인은 각자의 스크립트가 한다.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const groupKey = valueOf('--group-key', 'brand-ravi');

for (const line of readFileSync(join(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const c = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});
await c.connect();
const rows = (await c.query(
  `select host, naver_verification_token, naver_registration_status
     from naver_project_domains where group_key = $1 order by host`, [groupKey])).rows;
await c.end();

if (!rows.length) {
  console.error(`${groupKey} 에 도메인이 없습니다.`);
  process.exit(1);
}
const byHost = new Map(rows.map((r) => [r.host, r]));

/* 사이트 json 을 host 로 짝짓는다 — 키 이름이 아니라 실제 도메인이 기준이다. */
const KEYS = ['dream', 'thunder', 'mole', 'ssak', 'dosa'];
const plan = [];
for (const key of KEYS) {
  const p = join(projectRoot, `data/brands/${key}.json`);
  if (!existsSync(p)) continue;
  const site = JSON.parse(readFileSync(p, 'utf8'));
  const row = byHost.get(site.host);
  if (!row) {
    console.log(`  ${key.padEnd(8)} ${String(site.host).padEnd(17)} DB 에 없음 — 건너뜁니다`);
    continue;
  }
  const token = row.naver_verification_token;
  if (!token) {
    console.log(`  ${key.padEnd(8)} ${site.host.padEnd(17)} 토큰 없음 (${row.naver_registration_status}) — 등록부터`);
    continue;
  }
  if (!/^[0-9a-f]{20,64}$/i.test(token)) {
    throw new Error(`${site.host} 의 토큰 모양이 이상합니다: ${token}`);
  }
  plan.push({
    key, path: p, site, host: site.host, token, before: site.naverVerification || '',
  });
}

console.log(`\n${groupKey} — naverVerification`);
for (const x of plan) {
  const same = x.before === x.token;
  console.log(`  ${x.key.padEnd(8)} ${x.host.padEnd(17)} ${same ? '그대로' : `${x.before || '(비어 있음)'} → ${x.token}`}`);
}
const changed = plan.filter((x) => x.before !== x.token);
console.log(`  바꿀 것 ${changed.length}건 / 전체 ${plan.length}건`);

if (!apply) {
  console.log('\n--dry-run (기본). 적용하려면 --apply');
  process.exit(0);
}
for (const x of changed) {
  x.site.naverVerification = x.token;
  writeFileSync(x.path, `${JSON.stringify(x.site, null, 1)}\n`);
}
console.log(`\n✅ ${changed.length}건 넣었습니다. 이제 굽기 → 배포 → 캐시 퍼지 → 소유확인 순입니다.`);
