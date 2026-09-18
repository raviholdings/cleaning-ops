#!/usr/bin/env node
/**
 * 이 기계가 맡은 계정을 순서대로 캡처한다.
 *
 *   node scripts/capture-batch.mjs                 # .env 의 NAVER_CRAWL_RUNNER_PC 를 씀
 *   node scripts/capture-batch.mjs --vm vm1        # 직접 지정
 *   node scripts/capture-batch.mjs --list          # 목록만 보기
 *   node scripts/capture-batch.mjs --from 3        # 3번째부터 (중단된 뒤 이어서)
 *   node scripts/capture-batch.mjs --force --allow-new-ip   # 전부 다시 잡기
 *   node scripts/capture-batch.mjs --force --allow-new-ip --orders 101-194
 *                                                  # 순번 101~194 만 (95~100 은 살아있어 제외)
 *
 * --allow-new-ip : 배정 IP 가 HaiIP 풀에서 사라졌을 때 지금 IP 로 진행한다.
 *   세션이 오래됐으면 배정 IP 도 대개 없어져 있어서, 재캡처 때는 사실상 필요하다.
 *
 * 담당은 DB 의 naver_searchadvisor_accounts.runner_pc 로 정해져 있다.
 * 파일을 VM 마다 옮길 필요가 없다 — 공유 DB 에서 자기 몫만 읽는다.
 *
 * 이미 세션이 있는 계정은 건너뛴다. 다시 잡으려면 --force.
 *
 * ⚠ 브라우저가 뜨면 **로그인만** 하고 이 창으로 돌아와 Enter.
 *   계정 설정(IP보안 등)을 캡처 직후에 건드리면 보호조치가 걸린다.
 *   2026-09-16 에 그렇게 해서 22개 중 19개를 잃었다.
 *   브라우저를 먼저 닫지 말 것. Enter 가 먼저다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* .env 를 읽어 DATABASE_URL·RUNNER_PC 를 얻는다 */
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || '').replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);

/*
 * 모르는 옵션은 조용히 무시하지 말고 멈춘다.
 *
 * 2026-09-17: --orders 를 --order 로 잘못 쳤는데 그냥 무시돼서, 범위 제한이
 * 안 걸린 채 멀쩡한 계정부터 재캡처가 시작됐다. 오타 하나가 계정을 날릴 수
 * 있는 스크립트라 알려진 이름만 받는다.
 */
const KNOWN = new Set(['--vm', '--list', '--force', '--allow-new-ip', '--from', '--orders',
  '--keep-profile']);
// --accounts 51-80 은 다른 스크립트에서 순번 범위를 뜻한다. 같은 뜻으로 받는다.
const ALIAS = { '--order': '--orders', '--accounts': '--orders' };
for (let i = 0; i < args.length; i += 1) {
  if (!args[i].startsWith('--')) continue;
  if (ALIAS[args[i]]) { args[i] = ALIAS[args[i]]; continue; }
  if (!KNOWN.has(args[i])) {
    throw new Error(`모르는 옵션입니다: ${args[i]}\n`
      + `  쓸 수 있는 것: ${[...KNOWN].join(' ')}`);
  }
}

const val = (n, fb = null) => {
  const i = args.indexOf(n);
  if (i === -1) return fb;
  const v = args[i + 1];
  // "--vm --force" 처럼 값을 안 줬으면 다음 옵션을 값으로 삼지 말고 기본값을 쓴다.
  // (2026-09-18: --vm 이 "--skip-capture" 를 담당 이름으로 먹었다)
  return (v === undefined || v.startsWith('--')) ? fb : v;
};
const vm = String(val('--vm', process.env.NAVER_CRAWL_RUNNER_PC || '')).trim();
const listOnly = args.includes('--list');
const force = args.includes('--force');
const allowNewIp = args.includes('--allow-new-ip');
/*
 * 크롬 프로필은 남기지 않는다 (운영자 결정 2026-09-18).
 * 캡처가 끝나면 세션 쿠키만 DB 에 남기고 프로필 폴더는 지운다. 등록·소유확인도
 * --profile 없이 돌아서 매번 깨끗한 브라우저에 쿠키만 주입한다 = 시크릿과 같다.
 * 프로필을 남기려면 --keep-profile.
 */
const keepProfile = args.includes('--keep-profile');
const from = Number(val('--from', 1));
/*
 * --orders 101-194 : 계정 순번으로 범위를 자른다.
 *
 * 멀쩡한 계정을 재캡처 대상에서 빼려고 넣었다. --from 은 "목록의 몇 번째"라
 * VM 마다 숫자가 달라지지만, 순번은 세 VM 이 같은 값을 쓸 수 있다
 * (vm1 은 95,98,101… vm2 는 96,99,102… 로 섞여 있어도 101-194 는 똑같이 먹는다).
 */
const orderRange = (() => {
  const raw = String(val('--orders', '') || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) throw new Error('--orders 는 <시작>-<끝> 형식입니다. 예: --orders 101-194');
  return [Number(m[1]), Number(m[2])];
})();

if (!vm) throw new Error('담당 이름이 없습니다. .env 의 NAVER_CRAWL_RUNNER_PC 를 넣거나 --vm vm1 로 주세요.');
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 이 없습니다 (.env 확인).');

const c = new pg.Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
await c.connect();
const rows = (await c.query(
  `select account_order, account_id,
          (searchadvisor_session_secret_id is not null) as has_session,
          personal_info_source
     from naver_searchadvisor_accounts
    where runner_pc = $1 and status = 'active'
    order by account_order`, [vm])).rows;
await c.end();

if (!rows.length) throw new Error(`${vm} 에 배정된 활성 계정이 없습니다.`);

const inRange = (r) => !orderRange
  || (Number(r.account_order) >= orderRange[0] && Number(r.account_order) <= orderRange[1]);

const todo = (force ? rows : rows.filter((r) => !r.has_session)).filter(inRange);
console.log(`담당: ${vm}   배정 ${rows.length}개   캡처 필요 ${todo.length}개`
  + (orderRange ? `   순번 ${orderRange[0]}~${orderRange[1]} 만` : ''));
if (listOnly || !todo.length) {
  rows.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(3)}. #${String(r.account_order).padEnd(5)}${r.account_id.padEnd(18)}`
    + `${r.has_session ? '세션있음' : '캡처필요'}  ${String(r.personal_info_source || '').startsWith('domestic') ? '국내' : '해외'}`
    + `${todo.includes(r) ? '' : '  ← 건너뜀'}`));
  process.exit(0);
}

console.log('');
console.log('브라우저가 뜨면 로그인만 하고 이 창에서 Enter 를 누르세요.');
console.log('계정 설정은 건드리지 마세요. 브라우저를 먼저 닫지 마세요.');
console.log('');

let ok = 0; let fail = 0;
for (const [i, r] of todo.entries()) {
  if (i + 1 < from) continue;
  console.log(`\n===== [${i + 1}/${todo.length}] #${r.account_order} ${r.account_id} =====`);
  const res = spawnSync(process.execPath, [
    resolve(projectRoot, 'scripts/capture-naver-session.mjs'),
    '--account', r.account_id,
    '--no-auto-click', '--keep-open', '--login-via-searchadvisor',
    // --force 를 자식에게 넘기지 않으면 capture-naver-session 이 "이미 세션이
    // 있습니다" 로 조용히 건너뛰고 0 을 돌려준다. 성공처럼 보이는데 아무것도
    // 안 잡히는 상태가 된다 (2026-09-17 에 이걸로 헛돌았다).
    ...(force ? ['--force'] : []),
    ...(allowNewIp ? ['--allow-new-ip'] : []),
    ...(keepProfile ? [] : ['--drop-profile']),
  ], { stdio: 'inherit', cwd: projectRoot });
  if (res.status === 0) { ok += 1; } else {
    fail += 1;
    console.log(`  ✗ 실패 (종료코드 ${res.status}). 다음 계정으로 넘어갑니다.`);
    console.log(`     이어서 하려면: node scripts/capture-batch.mjs --from ${i + 2}`);
  }
}
console.log(`\n===== 끝 — 성공 ${ok} / 실패 ${fail} =====`);
