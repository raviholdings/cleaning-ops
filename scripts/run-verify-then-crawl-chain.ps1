#!/usr/bin/env node
/**
 * account_order 범위로 계정 ID 를 순서대로 뽑는다.
 * 체인 러너(run-verify-then-crawl-chain.ps1)가 돌 순서를 정하는 데 쓴다.
 *
 *   node scripts/list-naver-accounts-by-order.mjs --from 2 --to 10
 *   -> [{"accountId":"...","accountOrder":2,"status":"active"}, ...]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

loadEnv(resolve(process.cwd(), '.env'));

const options = parseOptions(process.argv.slice(2));
const from = Number(options.from || 1);
const to = Number(options.to || from);

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows } = await client.query(
    `select account_id, account_order, status
       from public.naver_searchadvisor_accounts
      where account_order between $1 and $2
      order by account_order`,
    [from, to],
  );
  console.log(JSON.stringify(rows.map((row) => ({
    accountId: row.account_id,
    accountOrder: row.account_order,
    status: row.status,
  }))));
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
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
