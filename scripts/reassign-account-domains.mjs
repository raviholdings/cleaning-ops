#!/usr/bin/env node
/**
 * 못 쓰게 된 계정의 도메인을 다른 계정으로 넘긴다.
 *
 *   node scripts/reassign-account-domains.mjs --from hnw944cibg9s4l2a --to xv1lt9mp --dry-run
 *   node scripts/reassign-account-domains.mjs --from hnw944cibg9s4l2a --to xv1lt9mp --block-source
 *
 * 계정이 정지되거나 본인인증을 못 하게 되면 그 계정에 물린 도메인 100개가
 * 통째로 멈춘다. 서브도메인 자체는 멀쩡하니 다른 계정으로 옮겨 쓴다.
 *
 * ⚠ 등록 상태를 반드시 초기화한다.
 *   서치어드바이저에서 사이트는 **등록한 계정의 것**이다. DB 의 소유 계정만
 *   바꾸고 토큰을 그대로 두면, 새 계정 세션으로 소유확인을 시도했을 때 남의
 *   사이트라 전부 실패한다. 새 계정으로 다시 등록해서 토큰을 새로 받아야 한다.
 *
 * ⚠ globalSiteOrder 는 절대 건드리지 않는다.
 *   그 값이 페이지의 지역·키워드를 정한다. 바뀌면 이미 만들어둔 내용이
 *   통째로 달라진다.
 *
 * 전부 한 트랜잭션이다. --dry-run 이면 바꿔본 뒤 롤백한다.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
const fromId = options.from;
const toId = options.to;
const dryRun = Boolean(options.dryRun);
const blockSource = Boolean(options.blockSource);

if (!fromId || !toId) {
  throw new Error('사용법: --from <넘길 계정> --to <받을 계정> [--dry-run] [--block-source]');
}
if (fromId === toId) throw new Error('--from 과 --to 가 같습니다.');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('begin');

  // --- 1. 두 계정이 실제로 있는지 ---
  const accounts = await client.query(
    `select account_id, account_order, status from public.naver_searchadvisor_accounts
      where account_id = any($1::text[])`,
    [[fromId, toId]],
  );
  const byId = Object.fromEntries(accounts.rows.map((r) => [r.account_id, r]));
  if (!byId[fromId]) throw new Error(`넘길 계정을 찾을 수 없습니다: ${fromId}`);
  if (!byId[toId]) throw new Error(`받을 계정을 찾을 수 없습니다: ${toId}`);

  // --- 2. 받을 계정에 자리가 있는지. 네이버는 계정당 100개가 상한이다 ---
  const existing = await client.query(
    'select count(*)::int n from public.naver_project_domains where naver_account_id = $1', [toId]);
  const moving = await client.query(
    'select count(*)::int n from public.naver_project_domains where naver_account_id = $1', [fromId]);
  if (moving.rows[0].n === 0) throw new Error(`${fromId} 에 넘길 도메인이 없습니다.`);
  const after = existing.rows[0].n + moving.rows[0].n;
  if (after > 100) {
    throw new Error(`받을 계정이 넘칩니다: 기존 ${existing.rows[0].n} + 이관 ${moving.rows[0].n} = ${after} (상한 100)`);
  }

  console.log(JSON.stringify({
    phase: 'before',
    from: { id: fromId, order: byId[fromId].account_order, status: byId[fromId].status, domains: moving.rows[0].n },
    to: { id: toId, order: byId[toId].account_order, status: byId[toId].status, domains: existing.rows[0].n },
    afterMove: after,
  }, null, 2));

  // --- 3. 이관 + 등록 상태 초기화 ---
  // globalSiteOrder(source_payload) 는 손대지 않는다.
  const moved = await client.query(
    `update public.naver_project_domains
        set naver_account_id = $2,
            naver_registration_status = 'pending',
            naver_verification_token = null,
            naver_meta_tag = null,
            naver_console_url = null,
            naver_registered_at = null,
            naver_verified_at = null,
            updated_at = now()
      where naver_account_id = $1
      returning id`,
    [fromId, toId],
  );

  // --- 4. 넘긴 계정을 정지로 ---
  let blocked = 0;
  if (blockSource) {
    const r = await client.query(
      `update public.naver_searchadvisor_accounts set status = 'blocked', updated_at = now()
        where account_id = $1 returning account_id`, [fromId]);
    blocked = r.rowCount;
  }

  // --- 5. 검산 ---
  const verify = await client.query(
    `select
       (select count(*)::int from public.naver_project_domains where naver_account_id = $1) from_left,
       (select count(*)::int from public.naver_project_domains where naver_account_id = $2) to_now,
       (select count(*)::int from public.naver_project_domains
         where naver_account_id = $2 and naver_verification_token is not null) to_with_token,
       (select count(distinct (source_payload->>'globalSiteOrder')::int)::int
          from public.naver_project_domains) distinct_order,
       (select count(*)::int from public.naver_project_domains) total`,
    [fromId, toId],
  );
  const v = verify.rows[0];
  if (v.from_left !== 0) throw new Error(`이관 후에도 ${fromId} 에 ${v.from_left}건이 남았습니다.`);
  if (v.to_with_token !== 0) throw new Error(`받을 계정에 토큰이 ${v.to_with_token}건 남았습니다. 초기화 실패.`);
  if (v.distinct_order !== v.total) throw new Error(`globalSiteOrder 가 겹칩니다: 고유 ${v.distinct_order} / 전체 ${v.total}`);

  console.log(JSON.stringify({
    phase: dryRun ? 'dry-run' : 'complete',
    movedDomains: moved.rowCount,
    sourceBlocked: blocked,
    verify: v,
  }, null, 2));

  if (dryRun) {
    await client.query('rollback');
    console.log('\n(dry-run: 롤백했습니다. DB 는 변경되지 않았습니다.)');
  } else {
    await client.query('commit');
    console.log(`\n다음 순서:\n  1. node scripts/capture-naver-session.mjs --account ${toId} --no-auto-click`);
    console.log(`  2. node scripts/register-naver-searchadvisor-sites.mjs --account ${toId}`);
    console.log('  3. 배포 → 소유확인');
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { result[key] = next; index += 1; } else { result[key] = true; }
  }
  return result;
}

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch { /* .env 없으면 환경변수로 준 것을 쓴다 */ }
}
