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
 *   node scripts/recapture-and-register.mjs acct --verify        # 소유확인까지
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
 * --verify 를 붙이면 3단계로 소유확인까지 간다. 단, 소유확인은 집 PC 가
 * 메타태그를 배포한 뒤에만 통과한다 (토큰을 gen/naver_meta.json 으로 내보내야
 * head.sub1.php 가 찍는다). VM 에서는 그 파일을 만들 수 없으므로, 등록한
 * 사이트를 실제로 열어보고 메타태그가 뜰 때까지 기다렸다가 소유확인을 건다.
 *
 * 집 PC 는 5분마다 export-piping-xyz-naver-meta.mjs 를 도는 작업이 걸려 있다
 * (NaverMetaExport). 그래서 보통은 몇 분 안에 저절로 뜬다.
 * 이 순서를 빠뜨리면 전건 "메타태그 없음" 으로 실패한다 (2026-09-17).
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

/*
 * 모르는 옵션은 조용히 무시하지 말고 멈춘다.
 * 2026-09-17: --orders 를 --order 로 잘못 쳐서 범위 제한이 안 걸린 채
 * 멀쩡한 계정부터 재캡처가 시작됐다. 오타 하나가 계정을 날릴 수 있다.
 */
const KNOWN = new Set(['--vm', '--list', '--force', '--allow-new-ip', '--from', '--orders',
  '--verify', '--skip-capture', '--skip-register', '--limit', '--group-key', '--meta-wait',
  '--keep-profile',
  // 캡처에 항상 넘기는 값이라 붙여도 무해하다. 받아만 준다.
  '--no-auto-click', '--keep-open', '--login-via-searchadvisor']);
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
  // "--vm --skip-capture" 처럼 값을 안 줬으면 다음 옵션을 값으로 삼지 말고 기본값을 쓴다.
  // (2026-09-18: --vm 이 담당 이름으로 "--skip-capture" 를 먹고 계정을 못 찾았다)
  return (v === undefined || v.startsWith('--')) ? fb : v;
};
const flag = (n) => args.includes(n);

/* 옵션이 아니고, 옵션의 값 자리도 아닌 인자를 계정 아이디로 본다. */
const VALUE_OPTS = new Set(['--vm', '--limit', '--from', '--group-key', '--meta-wait', '--orders']);
const ids = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) { if (VALUE_OPTS.has(args[i])) i += 1; continue; }
  if (i > 0 && VALUE_OPTS.has(args[i - 1])) continue;
  ids.push(args[i]);
}

const listOnly = flag('--list');
const skipCapture = flag('--skip-capture');
const skipRegister = flag('--skip-register');
const doVerify = flag('--verify');
/*
 * --orders 101-194 : 계정 순번으로 범위를 자른다.
 * --from 은 "목록의 몇 번째"라 VM 마다 값이 달라지지만, 순번은 세 VM 이
 * 같은 값을 쓸 수 있다 (vm1 95,98,101… vm2 96,99,102… 여도 101-194 는 똑같다).
 */
const orderRange = (() => {
  const raw = String(val('--orders', '') || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) throw new Error('--orders 는 <시작>-<끝> 형식입니다. 예: --orders 101-194');
  return [Number(m[1]), Number(m[2])];
})();
// 집 PC 가 메타태그를 배포할 때까지 기다릴 시간 (분). 0 이면 기다리지 않는다.
const metaWaitMin = Number(val('--meta-wait', 15));
const allowNewIp = flag('--allow-new-ip');
/*
 * 크롬 프로필은 남기지 않는다 (운영자 결정 2026-09-18).
 * 캡처가 끝나면 세션 쿠키만 DB 에 남기고 프로필 폴더는 지운다. 등록·소유확인도
 * --profile 없이 돌아서 매번 깨끗한 브라우저에 쿠키만 주입한다 = 시크릿과 같다.
 * 프로필을 남기려면 --keep-profile.
 */
const keepProfile = flag('--keep-profile');
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

const newClient = async () => {
  const cl = new pg.Client({
    connectionString: url,
    ssl: /127\.0\.0\.1|localhost/.test(url) ? false : { rejectUnauthorized: false },
  });
  await cl.connect();
  return cl;
};
const c = await newClient();

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

const inRange = (r) => !orderRange
  || (Number(r.account_order) >= orderRange[0] && Number(r.account_order) <= orderRange[1]);

/*
 * 대상 고르기
 *   --skip-capture : 이미 세션이 있는 계정 (등록·소유확인만 돌린다)
 *   재캡처 모드    : 범위 안의 활성 계정 전부
 *   기본           : 세션 없는 계정만 — 멀쩡한 세션은 건드리지 않는다
 */
const targets = rows.filter((r) => r.status === 'active' && inRange(r)
  && (skipCapture ? r.has_session : (force || !r.has_session)));

console.log(`${ids.length ? '계정 지정' : `담당 ${vm}`} — 재캡처 + 사이트 등록 (${groupKey})`);
console.log(`  대상 ${targets.length}개 / 전체 ${rows.length}개${force ? '  (재캡처 모드)' : ''}`
  + (orderRange ? `   순번 ${orderRange[0]}~${orderRange[1]} 만` : ''));
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
      ...(keepProfile ? [] : ['--drop-profile']),
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

/* ---------- 3단계 · 소유확인 ----------
 *
 * 메타태그는 집 PC 의 gen/naver_meta.json 이 찍는다. VM 에서는 그 파일을 만들 수
 * 없으니, 등록한 사이트를 실제로 열어보고 토큰이 뜨는지로 배포 여부를 본다.
 * 집 PC 의 NaverMetaExport 작업이 5분마다 도니까 보통 몇 분 안에 뜬다.
 */
async function liveMetaToken(host) {
  try {
    const res = await fetch(`https://${host}/`, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; meta-check)' },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await res.text();
    return (html.match(/name=["']naver-site-verification["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/content=["']([^"']+)["'][^>]*name=["']naver-site-verification["']/i)
      || [])[1] || null;
  } catch { return null; }
}

/** 이 계정의 등록완료 사이트 몇 개를 열어 메타태그가 배포됐는지 본다. */
async function waitForMeta(accountId) {
  const cl = await newClient();
  const { rows: sample } = await cl.query(
    `select host, naver_verification_token tok from naver_project_domains
      where naver_account_id = $1 and group_key = $2
        and naver_registration_status = 'registered'
      order by naver_registered_at desc nulls last limit 3`, [accountId, groupKey]);
  await cl.end();
  if (!sample.length) return { ok: true, note: '소유확인할 사이트가 없습니다' };

  const deadline = Date.now() + metaWaitMin * 60_000;
  for (let round = 1; ; round += 1) {
    const live = await Promise.all(sample.map((s) => liveMetaToken(s.host)));
    const bad = sample.filter((s, i) => live[i] !== s.tok);
    if (!bad.length) return { ok: true, note: `메타태그 확인 ${sample.length}건` };
    if (Date.now() >= deadline) {
      return { ok: false, note: `메타태그 미배포 (${bad.map((b) => b.host).join(', ')})` };
    }
    console.log(`  [${round}] 메타태그 아직입니다 (${bad.length}/${sample.length}). 60초 뒤 다시 봅니다.`
      + `  남은 대기 ${Math.ceil((deadline - Date.now()) / 60_000)}분`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

if (doVerify) {
  const verifyTargets = skipRegister ? targets : captured;
  console.log(`\n===== 3단계 · 소유확인 ${verifyTargets.length}개 =====`);
  if (metaWaitMin > 0) {
    console.log(`  메타태그가 배포될 때까지 계정마다 최대 ${metaWaitMin}분 기다립니다.`);
    console.log(`  (집 PC 의 NaverMetaExport 가 5분마다 돕니다. 안 뜨면 집 PC 에서`);
    console.log(`   node scripts/export-piping-xyz-naver-meta.mjs 를 직접 돌리세요.)`);
  }
  for (const [i, r] of verifyTargets.entries()) {
    console.log(`\n----- 소유확인 [${i + 1}/${verifyTargets.length}] #${r.account_order} ${r.account_id} -----`);
    const ready = await waitForMeta(r.account_id);
    console.log(`  ${ready.ok ? '✓' : '✗'} ${ready.note}`);
    if (!ready.ok) {
      failed.push({ r, at: '소유확인', why: ready.note });
      console.log('  메타태그가 없으면 전건 실패합니다. 건너뜁니다.');
      continue;
    }
    const res = spawnSync(process.execPath, [
      resolve(projectRoot, 'scripts/verify-naver-searchadvisor-sites.mjs'),
      '--account', r.account_id, '--group-key', groupKey, '--delay-ms', '4000',
    ], { stdio: 'inherit', cwd: projectRoot });
    if (res.status !== 0) {
      failed.push({ r, at: '소유확인', why: `종료코드 ${res.status}` });
      console.log(`  ✗ 소유확인 실패. 다음 계정으로 갑니다.`);
    }
  }
}

console.log(`\n===== 끝 =====`);
console.log(`  캡처 성공 ${captured.length} / 실패 ${failed.filter((f) => f.at === '캡처').length}`);
console.log(`  등록 실패 ${failed.filter((f) => f.at === '등록').length}`);
if (doVerify) console.log(`  소유확인 실패 ${failed.filter((f) => f.at === '소유확인').length}`);
failed.forEach((f) => console.log(`    ✗ ${f.at}  ${f.r.account_id}  ${f.why}`));

if (!doVerify) {
  console.log('');
  console.log('  소유확인까지 하려면 --verify. 따로 하려면:');
  console.log('   1) 집 PC   node scripts/export-piping-xyz-naver-meta.mjs   (5분마다 자동으로도 돕니다)');
  console.log('   2) 이 기계  node scripts/run-batch.mjs verify');
}
if (failed.length) process.exitCode = 1;
