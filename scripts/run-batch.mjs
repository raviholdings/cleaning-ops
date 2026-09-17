#!/usr/bin/env node
/**
 * 이 기계가 맡은 계정을 순서대로 등록 / 소유확인 한다.
 *
 *   node scripts/run-batch.mjs register                    # 내 몫 전부
 *   node scripts/run-batch.mjs register 5pnfdulzykpw1      # 계정 하나만
 *   node scripts/run-batch.mjs verify                      # 소유확인
 *   node scripts/run-batch.mjs register --list             # 대상만 보기
 *   node scripts/run-batch.mjs register --from 5           # 5번째 계정부터 (중단된 뒤 이어서)
 *
 * 담당은 DB 의 naver_searchadvisor_accounts.runner_pc 로 정해져 있다.
 * .env 의 NAVER_CRAWL_RUNNER_PC 와 맞는 계정만 집으므로 VM 마다 파일을 옮길 필요가 없다.
 *
 * 계정 하나가 실패해도 멈추지 않고 다음 계정으로 간다.
 * 사이트 단위 연속 실패는 각 스크립트가 알아서 그 계정을 중단한다
 *   등록   연속 3회  (--fail-abort N)
 *   소유확인 타임아웃 연속 2회 (--timeout-abort N)
 *
 * 세션이 없는 계정은 건너뛴다 — 먼저 capture-batch.mjs 를 돌려야 한다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const task = args[0];
const val = (n, fb = null) => {
  const i = args.indexOf(n);
  if (i === -1) return fb;
  const v = args[i + 1];
  // "--vm --list" 처럼 값을 안 줬으면 다음 옵션을 값으로 삼지 말고 기본값을 쓴다.
  return (v === undefined || v.startsWith('--')) ? fb : v;
};
// 두 번째 인자가 옵션이 아니면 계정 아이디로 본다 (계정 하나만 돌릴 때)
const oneAccount = args[1] && !args[1].startsWith('--') ? args[1] : String(val('--account', '') || '');
const listOnly = args.includes('--list');
const from = Number(val('--from', 1));
const vm = String(val('--vm', process.env.NAVER_CRAWL_RUNNER_PC || '')).trim();

const TASKS = {
  register: {
    script: 'scripts/register-naver-searchadvisor-sites.mjs',
    extra: ['--group-key', 'piping-xyz'],
    label: '사이트 등록',
    // 등록할 게 남았는지: pending 인 도메인
    countSql: `select count(*) n from naver_project_domains
                where naver_account_id = $1 and group_key = 'piping-xyz'
                  and naver_registration_status = 'pending'`,
  },
  verify: {
    script: 'scripts/verify-naver-searchadvisor-sites.mjs',
    extra: ['--group-key', 'piping-xyz', '--delay-ms', '4000'],
    label: '소유확인',
    countSql: `select count(*) n from naver_project_domains
                where naver_account_id = $1 and group_key = 'piping-xyz'
                  and naver_registration_status = 'registered'`,
  },
};

if (!TASKS[task]) {
  console.error('사용법: node scripts/run-batch.mjs <register|verify> [--list] [--from N] [--vm vm1]');
  process.exit(1);
}
if (!vm && !oneAccount) throw new Error('담당 이름이 없습니다. .env 의 NAVER_CRAWL_RUNNER_PC 를 넣거나 --vm vm1 로 주세요. 계정 하나만 하려면 아이디를 인자로 주세요.');
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 이 없습니다 (.env 확인).');

const t = TASKS[task];
const c = new pg.Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
await c.connect();
const accounts = oneAccount
  ? (await c.query(
    `select account_order, account_id,
            (searchadvisor_session_secret_id is not null) as has_session
       from naver_searchadvisor_accounts
      where account_id = $1`, [oneAccount])).rows
  : (await c.query(
    `select account_order, account_id,
            (searchadvisor_session_secret_id is not null) as has_session
       from naver_searchadvisor_accounts
      where runner_pc = $1 and status = 'active'
      order by account_order`, [vm])).rows;
if (oneAccount && !accounts.length) throw new Error(`계정을 못 찾았습니다: ${oneAccount}`);

const rows = [];
for (const a of accounts) {
  const n = Number((await c.query(t.countSql, [a.account_id])).rows[0].n);
  rows.push({ ...a, todo: n });
}
await c.end();

const work = rows.filter((r) => r.has_session && r.todo > 0);
const noSession = rows.filter((r) => !r.has_session);

console.log(oneAccount ? `계정 ${oneAccount} — ${t.label}` : `담당 ${vm} — ${t.label}`);
console.log(`  배정 ${rows.length}개 / 할 일 있는 계정 ${work.length}개 / 세션 없음 ${noSession.length}개`);
console.log(`  대상 사이트 ${work.reduce((s, r) => s + r.todo, 0).toLocaleString()}건`);
if (noSession.length) console.log(`  ⚠ 세션 없는 계정은 건너뜁니다. capture-batch.mjs 를 먼저 돌리세요.`);

if (listOnly || !work.length) {
  rows.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(3)}. #${String(r.account_order).padEnd(5)}${r.account_id.padEnd(18)}`
    + `${r.has_session ? '세션O' : '세션X'}  대상 ${String(r.todo).padStart(4)}건`));
  process.exit(0);
}

let ok = 0; let bad = 0;
for (const [i, r] of work.entries()) {
  if (i + 1 < from) continue;
  console.log(`\n===== [${i + 1}/${work.length}] #${r.account_order} ${r.account_id}  (${r.todo}건) =====`);
  const res = spawnSync(process.execPath, [
    resolve(projectRoot, t.script), '--account', r.account_id, ...t.extra,
  ], { stdio: 'inherit', cwd: projectRoot });
  if (res.status === 0) ok += 1;
  else {
    bad += 1;
    console.log(`  ✗ 계정 실패 (종료코드 ${res.status}). 다음 계정으로 갑니다.`);
    console.log(`     이어서 하려면: node scripts/run-batch.mjs ${task} --from ${i + 2}`);
  }
}
console.log(`\n===== 끝 — 성공 ${ok} / 실패 ${bad} =====`);
