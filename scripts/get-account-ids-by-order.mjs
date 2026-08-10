#!/usr/bin/env node
/**
 * 계정 순번 범위 -> 계정 ID 목록. DB 는 읽기만 한다.
 *
 *   node scripts/get-account-ids-by-order.mjs --from 21 --to 50
 *   -> wzgn185rf,gmmadrgsnt8702,...
 *
 * 수집요청 러너가 NAVER_CRAWL_INCLUDE_ACCOUNTS 를 계정 ID 로만 받기 때문에
 * 필요하다. 순번을 손으로 ID 로 바꾸다 보면 반드시 하나를 빠뜨린다.
 * 계정이 늘어도 이 스크립트만 다시 돌리면 된다.
 *
 * --json 을 주면 순번까지 같이 보여준다 (확인용).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseArgs(process.argv.slice(2));
const from = Number(options.from);
const to = Number(options.to);
if (!Number.isFinite(from) || !Number.isFinite(to)) {
  throw new Error('사용법: node scripts/get-account-ids-by-order.mjs --from 21 --to 50');
}

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

let rows;
try {
  // 수집요청 대상이 실제로 있는 계정만 넘긴다. 도메인이 없는 계정을 목록에
  // 넣으면 러너가 매번 붙었다가 "할 일 없음" 으로 빠져나오며 시간만 쓴다.
  ({ rows } = await client.query(
    `select a.account_order, a.account_id, count(d.id)::int as verified
       from public.naver_searchadvisor_accounts a
       left join public.naver_project_domains d
         on d.naver_account_id = a.account_id
        and d.naver_registration_status = 'verified'
      where a.account_order between $1 and $2
      group by a.account_order, a.account_id
     having count(d.id) > 0
      order by a.account_order`,
    [from, to],
  ));
} finally {
  await client.end();
}

if (options.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(rows.map((row) => row.account_id).join(','));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch { /* .env 가 없으면 환경변수로 준 것을 쓴다 */ }
}
