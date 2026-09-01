#!/usr/bin/env node
/**
 * 정지된 브랜드 계정의 도메인을 새 계정으로 옮긴다.
 *
 *   node scripts/migrate-brand-account.mjs --from xcwhq4150 --to yuzjplo3322
 *   node scripts/migrate-brand-account.mjs --from xcwhq4150 --to yuzjplo3322 --apply
 *
 * 기존 migrate-blocked-account.ps1 은 청소 대량배포용이다. 재배포에
 * build-and-deploy-sites.mjs 를 부르고 등록도 cleaning-ravi 를 기본으로 잡는다.
 * 브랜드는 도메인이 하나뿐이고 배포 경로가 달라(deploy-brand-sites) 따로 만들었다.
 *
 * 여기서 하는 것은 DB 세 줄뿐이다.
 *
 *   1. 도메인의 소유 계정을 바꾼다
 *   2. 옛 계정을 blocked 로
 *   3. 등록 상태를 pending 으로 되돌리고 토큰·메타태그를 지운다
 *
 * 3번이 핵심이다. 서치어드바이저에서 사이트는 **등록한 계정의 것**이라,
 * DB 소유자만 바꾸고 옛 토큰을 두면 새 계정 세션에서는 남의 사이트가 된다.
 * 그 상태로 소유확인을 돌리면 전부 실패하는데 화면에는 이유가 안 나온다.
 *
 * 나머지 네 단계는 사람이 순서대로 해야 한다 (끝나면 안내를 찍는다).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const apply = args.includes('--apply');
const from = valueOf('--from');
const to = valueOf('--to');
const groupKey = valueOf('--group-key', 'brand-ravi');

if (!from || !to) {
  console.error('사용법: node scripts/migrate-brand-account.mjs --from <옛계정> --to <새계정> [--apply]');
  process.exit(1);
}

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

const acc = await c.query(
  `select account_id, account_order, status, searchadvisor_session_saved_at
     from naver_searchadvisor_accounts where account_id = any($1)`, [[from, to]]);
const src = acc.rows.find((r) => r.account_id === from);
const dst = acc.rows.find((r) => r.account_id === to);
if (!src) throw new Error(`옛 계정 ${from} 이 DB 에 없습니다.`);
if (!dst) throw new Error(`새 계정 ${to} 가 DB 에 없습니다.`);
if (dst.status !== 'active') throw new Error(`새 계정 ${to} 상태가 ${dst.status} 입니다.`);

/* 네이버 계정당 사이트 100개 상한. 받을 계정이 이미 차 있으면 안 된다. */
const held = await c.query(
  'select count(*)::int n from naver_project_domains where naver_account_id = $1', [to]);
const moving = await c.query(
  `select host, page_count, naver_registration_status, naver_verified_at
     from naver_project_domains where group_key = $1 and naver_account_id = $2 order by host`,
  [groupKey, from]);

if (!moving.rowCount) throw new Error(`${groupKey} 에서 ${from} 이 든 도메인이 없습니다.`);
if (held.rows[0].n + moving.rowCount > 100) {
  throw new Error(`${to} 가 이미 ${held.rows[0].n}개를 들고 있어 ${moving.rowCount}개를 더하면 100 을 넘습니다.`);
}

console.log(`\n옮길 것 — ${groupKey}`);
console.log(`  ${from} (순번 ${src.account_order} · ${src.status})  →  ${to} (순번 ${dst.account_order} · 지금 ${held.rows[0].n}개)`);
for (const d of moving.rows) {
  console.log(`    ${d.host.padEnd(17)} ${String(d.page_count).padStart(5)}장  ${d.naver_registration_status}`
    + `${d.naver_verified_at ? ' · 소유확인 완료' : ''}`);
}
console.log('\n같이 바뀌는 것');
console.log(`  ${from} 상태 → blocked`);
console.log('  등록 상태 → pending · 토큰·메타태그·등록시각 삭제');
console.log('    (옛 계정으로 받은 토큰이라 새 계정에서는 못 쓴다. 두면 소유확인이 전부 실패한다)');
if (!dst.searchadvisor_session_saved_at) {
  console.log(`\n⚠ ${to} 는 세션이 없습니다. 이관 뒤 등록 전에 먼저 캡처해야 합니다.`);
}

if (!apply) {
  console.log('\n--dry-run (기본). 적용하려면 --apply');
  await c.end();
  process.exit(0);
}

await c.query('begin');
try {
  const r1 = await c.query(
    `update naver_project_domains
        set naver_account_id = $1,
            naver_registration_status = 'pending',
            naver_verification_token = null,
            naver_meta_tag = null,
            naver_registered_at = null,
            naver_verified_at = null,
            updated_at = now()
      where group_key = $2 and naver_account_id = $3`, [to, groupKey, from]);
  const r2 = await c.query(
    `update naver_searchadvisor_accounts set status = 'blocked', updated_at = now()
      where account_id = $1`, [from]);
  await c.query('commit');
  console.log(`\n✅ 도메인 ${r1.rowCount}개 이관 · 계정 ${r2.rowCount}개 blocked`);
} catch (e) {
  await c.query('rollback');
  console.log(`\n✗ 실패 — 되돌렸습니다: ${e.message}`);
  await c.end();
  process.exit(1);
}

const after = await c.query(
  `select d.host, d.naver_account_id, a.account_order, d.naver_registration_status
     from naver_project_domains d
     left join naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
    where d.group_key = $1 order by a.account_order nulls last, d.host`, [groupKey]);
console.log('\n확인:');
for (const x of after.rows) {
  console.log(`  ${String(x.account_order ?? '-').padStart(3)} ${String(x.naver_account_id).padEnd(13)}`
    + `${x.host.padEnd(17)} ${x.naver_registration_status}`);
}

console.log(`
다음 순서 — 하나라도 건너뛰면 소유확인이 실패합니다.

  1. 세션 캡처   node scripts/capture-naver-session.mjs --account ${to}
  2. 사이트 등록  node scripts/register-naver-searchadvisor-sites.mjs --account ${to} --group-key ${groupKey}
  3. 토큰 옮기기  node scripts/sync-brand-verification.mjs --apply
  4. 굽기·배포    npm run brands:build
                 node scripts/deploy-brand-sites.mjs
                 node scripts/purge-brand-cache.mjs
  5. 소유확인     node scripts/verify-naver-searchadvisor-sites.mjs --account ${to} --group-key ${groupKey}
  6. 수집요청     scripts/run-brand-crawl-range.ps1 로 그 순번을 포함해 실행
`);
await c.end();
