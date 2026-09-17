#!/usr/bin/env node
/**
 * 재캡처 → 사이트 등록을 한 번에 돌린다.
 *
 *   node scripts/recapture-and-register.mjs twri5a-61_o          # 계정 하나
 *   node scripts/recapture-and-register.mjs acct1 acct2 acct3    # 여러 개
 *   node scripts/recapture-and-register.mjs                      # 내 몫 중 세션 없는 계정 전부
 *   node scripts/recapture-and-register.mjs --list               # 뭘 할지만 보기
 *   node scripts/recapture-and-register.mjs acct --allow-new-ip  # 배정 IP 가 풀에서 사라졌을 때
 *   node scripts/recapture-and-register.mjs acct --skip-capture  # 등록만
 *
 * 두 단계로 나눠서 돈다. 캡처는 사람이 브라우저에서 로그인해야 하고 등록은
 * 계정당 몇 분씩 걸리므로, 섞어 돌리면 사람이 등록 끝나기를 기다리며 앉아
 * 있어야 한다. 캡처를 전부 끝낸 뒤 등록으로 넘어간다.
 *
 *   1단계 캡처  — 사람이 붙어 있어야 함. 계정마다 로그인하고 Enter.
 *   2단계 등록  — 무인. 캡처에 성공한 계정만 넘어간다.
 *
 * 계정 아이디를 직접 주면 "재캡처" 로 보고 기존 세션이 있어도 다시 잡는다
 * (보호조치 풀고 온 계정이 이 경우다). 아이디 없이 돌리면 내 몫(runner_pc)
 * 중 세션이 없는 계정만 잡는다 — 멀쩡한 세션을 날리지 않는다.
 *
 * ⚠ 소유확인은 여기서 하지 않는다. 등록이 끝난 뒤 집 PC 에서
 *     node scripts/export-piping-xyz-naver-meta.mjs
 *   를 돌려 메타태그를 배포해야 소유확인이 통과한다. 이 순서를 빠뜨리면
 *   전건 "메타태그 없음" 으로 실패한다 (2026-09-17).
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
const val = (n, fb = null) => { const i = args.indexOf(n); return i === -1 ? fb : args[i + 1]; };
const flag = (n) => args.includes(n);

/* 옵션이 아니고, 옵션의 값 자리도 아닌 인자를 계정 아이디로 본다. */
const VALUE_OPTS = new Set(['--vm', '--limit', '--from', '--group-key']);
const ids = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) { if (VALUE_OPTS.has(args[i])) i += 1; continue; }
  if (i > 0 && VALUE_OPTS.has(args[i - 1])) continue;
  ids.push(args[i]);
}

const listOnly = flag('--list');
const skipCapture = flag('--skip-capture');
const skipRegister = flag('--skip-register');
const allowNewIp = flag('--allow-new-ip');
const groupKey = String(val('--group-key', 'piping-xyz'));
const limit = val('--limit', null);
const from = Number(val('--from', 1));
const vm = String(val('--vm', process.env.NAVER_CRAWL_RUNNER_PC || '')).trim();
// 아이디를 직접 준 건 "이 계정을 다시 잡아라" 라는 뜻이다.
const force = ids.length > 0 || flag('--force');

if (!ids.length && !vm) {
  throw new Error('계정 아이디를 주거나, .env 의 NAVER_CRAWL_RUNNER_PC 를 넣거나, --vm vm1 로 주세요.');
}

const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 이 없습니다 (.env 확인).');

const c = new pg.Client({ connectionString: url, ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false } });
await c.connect();

const SELECT = `select account_order, account_id, status,
                       (searchadvisor_session_secret_id is not null) as has_session,
                       host(searchadvisor_session_validated_public_ip) as validated_ip`;
const rows = ids.length
  ? (await c.query(`${SELECT} from naver_searchadvisor_accounts
                     where account_id = any($1) order by account_order`, [ids])).rows
  : (await c.query(`${SELECT} from naver_searchadvisor_accounts
                     where runner_pc = $1 and status = 'active'
                     order by account_order`, [vm])).rows;

for (const id of ids) {
  if (!rows.some((r) => r.account_id === id)) throw new Error(`계정을 못 찾았습니다: ${id}`);
}
if (!rows.length) throw new Error(`${vm} 에 배정된 활성 계정이 없습니다.`);

const pendingSql = `select count(*) n from naver_project_domains
                     where naver_account_id = $1 and group_key = $2
                       and naver_registration_status = 'pending'`;
for (const r of rows) {
  r.pending = Number((await c.query(pendingSql, [r.account_id, groupKey])).rows[0].n);
}
await c.end();

/* 아이디를 안 줬으면 세션 없는 계정만 잡는다 — 멀쩡한 세션은 건드리지 않는다. */
const targets = rows.filter((r) => r.status === 'active' && (force || !r.has_session));

console.log(`${ids.length ? '계정 지정' : `담당 ${vm}`} — 재캡처 + 사이트 등록 (${groupKey})`);
console.log(`  대상 ${targets.length}개 / 전체 ${rows.length}개${force ? '  (재캡처 모드)' : ''}`);
rows.forEach((r, i) => console.log(
  `  ${String(i + 1).padStart(3)}. #${String(r.account_order).padEnd(5)}${r.account_id.padEnd(18)}`
  + `${r.has_session ? '세션O' : '세션X'}  등록대기 ${String(r.pending).padStart(4)}건`
  + `${r.status === 'active' ? '' : `  [${r.status}]`}`
  + `${targets.includes(r) ? '' : '  ← 건너뜀'}`));

if (!targets.length && rows.some((r) => r.pending > 0)) {
  console.log('');
  console.log('  캡처할 게 없습니다 — 전부 세션이 살아 있습니다.');
  console.log('  등록만 하려면:  node scripts/run-batch.mjs register');
  console.log('  특정 계정을 다시 잡으려면 아이디를 인자로 주세요.');
}
if (listOnly || !targets.length) process.exit(0);

const captured = [];
const failed = [];

if (skipCapture) {
  console.log('\n--skip-capture — 캡처를 건너뛰고 등록만 합니다.');
  captured.push(...targets.filter((r) => r.has_session));
  targets.filter((r) => !r.has_session).forEach((r) => failed.push({ r, at: '캡처', why: '세션이 없습니다' }));
} else {
  console.log(`\n===== 1단계 · 캡처 ${targets.length}개 =====`);
  console.log('브라우저가 뜨면 로그인만 하고 이 창에서 Enter 를 누르세요.');
  console.log('계정 설정은 건드리지 마세요. 브라우저를 먼저 닫지 마세요.');
  for (const [i, r] of targets.entries()) {
    if (i + 1 < from) { console.log(`  [${i + 1}/${targets.length}] ${r.account_id} — --from 으로 건너뜀`); continue; }
    console.log(`\n----- 캡처 [${i + 1}/${targets.length}] #${r.account_order} ${r.account_id} -----`);
    const res = spawnSync(process.execPath, [
      resolve(projectRoot, 'scripts/capture-naver-session.mjs'),
      '--account', r.account_id,
      '--no-auto-click', '--keep-open', '--login-via-searchadvisor',
      ...(force ? ['--force'] : []),
      ...(allowNewIp ? ['--allow-new-ip'] : []),
    ], { stdio: 'inherit', cwd: projectRoot });
    if (res.status === 0) captured.push(r);
    else {
      failed.push({ r, at: '캡처', why: `종료코드 ${res.status}` });
      console.log(`  ✗ 캡처 실패. 등록은 건너뛰고 다음 계정으로 갑니다.`);
      if (!allowNewIp) console.log(`     배정 IP 를 못 잡은 거라면: --allow-new-ip`);
    }
  }
}

if (skipRegister) {
  console.log('\n--skip-register — 등록은 하지 않습니다.');
} else if (!captured.length) {
  console.log('\n캡처에 성공한 계정이 없어 등록을 건너뜁니다.');
} else {
  console.log(`\n===== 2단계 · 사이트 등록 ${captured.length}개 =====`);
  console.log('여기서부터는 무인입니다. 창을 닫지 마세요.');
  for (const [i, r] of captured.entries()) {
    console.log(`\n----- 등록 [${i + 1}/${captured.length}] #${r.account_order} ${r.account_id}  (대기 ${r.pending}건) -----`);
    if (!r.pending) { console.log('  등록할 게 없습니다. 건너뜁니다.'); continue; }
    const res = spawnSync(process.execPath, [
      resolve(projectRoot, 'scripts/register-naver-searchadvisor-sites.mjs'),
      '--account', r.account_id, '--group-key', groupKey,
      ...(limit ? ['--limit', String(limit)] : []),
    ], { stdio: 'inherit', cwd: projectRoot });
    if (res.status !== 0) {
      failed.push({ r, at: '등록', why: `종료코드 ${res.status}` });
      console.log(`  ✗ 등록 실패. 다음 계정으로 갑니다.`);
    }
  }
}

console.log(`\n===== 끝 =====`);
console.log(`  캡처 성공 ${captured.length} / 실패 ${failed.filter((f) => f.at === '캡처').length}`);
console.log(`  등록 실패 ${failed.filter((f) => f.at === '등록').length}`);
failed.forEach((f) => console.log(`    ✗ ${f.at}  ${f.r.account_id}  ${f.why}`));

console.log('');
console.log('  다음 순서 — 소유확인은 메타태그 배포 뒤에 해야 합니다.');
console.log('   1) 집 PC   node scripts/export-piping-xyz-naver-meta.mjs');
console.log('   2) 이 기계  node scripts/run-batch.mjs verify');
if (failed.length) process.exitCode = 1;
