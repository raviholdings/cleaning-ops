#!/usr/bin/env node
/**
 * 지금 이 기계의 공인 IP 를 특정 계정의 예약 IP 로 못박는다.
 *
 *   node scripts/claim-account-ip.mjs --account 217            # 확인만 (기본)
 *   node scripts/claim-account-ip.mjs --account 217 --apply    # DB 에 기록
 *   node scripts/claim-account-ip.mjs --account dtxfafen60 --apply
 *   node scripts/claim-account-ip.mjs --status 217,219,236     # 여러 계정의 예약 IP 만 조회
 *
 * 왜 필요한가
 *   러너는 계정마다 HaiIP 로 IP 를 돌린 뒤 "이 IP 가 남의 것인가"를 DB 에 묻는다.
 *   임자 있는 IP 만 걸리면 10번 뽑고 그 계정을 통째로 건너뛴다 (100호스트 = 5,000건).
 *   그런데 러너는 예약 IP 와 현재 IP 가 같으면 HaiIP 클릭 자체를 건너뛴다
 *   (run-windows-naver-crawl-resume.ps1 의 "already on preferred IP" 분기).
 *   그래서 손으로 IP 를 바꿔 빈 IP 를 잡은 뒤 이 스크립트로 못박아 두면,
 *   그 계정 수집요청은 IP 뽑기 없이 바로 시작한다.
 *
 * 쓰는 순서 (그 계정을 돌릴 기계에서)
 *   1. haiip-windows-ui-control.ps1 change  로 IP 를 바꾼다
 *   2. node scripts/claim-account-ip.mjs --account <순번>        ← 비었는지 확인
 *      비어 있지 않으면 1번으로 돌아간다
 *   3. node scripts/claim-account-ip.mjs --account <순번> --apply
 *   4. run-piping-crawl-range.ps1 -From <순번> -To <순번> ...
 *
 * ⛔ 반드시 그 계정을 돌릴 기계에서 실행할 것. 다른 기계에서 잡으면 그 기계는
 *    그 IP 를 못 만들어서 아무 소용이 없다.
 *
 * ⛔⛔ 세션 재캡처(capture-naver-session.mjs) 앞에 쓰지 말 것.
 *     이 스크립트는 수집요청용이다. 수집요청은 저장된 세션을 그대로 쓰므로
 *     새 로그인이 없고, IP 를 옮겨도 네이버가 볼 일이 없다.
 *     반면 캡처는 새로 로그인한다. 캡처의 "배정 IP 로 못 가면 중단" 은 불편한
 *     제약이 아니라, 그 계정이 안 써본 IP 에서 로그인하는 걸 막는 안전장치다.
 *     이걸로 배정 IP 를 갈아끼워 그 검사를 통과시키면 보호조치가 걸린다
 *     (2026-08-31 #285 mh5o58o1cl8ezzrz4g 에서 실제로 걸렸다).
 *     캡처에서 IP 를 못 잡으면 capture-naver-session.mjs --allow-new-ip 를 쓸 것 —
 *     같은 /24 -> /16 순으로 가까운 IP 를 찾고, 성공한 뒤에만 DB 에 기록한다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const accountArg = valueOf('--account');
const statusArg = valueOf('--status');
const apply = args.includes('--apply');

if (!accountArg && !statusArg) {
  throw new Error('--account <순번|계정id> 또는 --status <순번,순번,...> 이 필요합니다.');
}

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const client = new pg.Client({
  connectionString: env.DATABASE_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});

/** 계정 하나를 순번이든 id 든 찾아온다. */
async function findAccount(token) {
  const isOrder = /^\d+$/.test(String(token).trim());
  const { rows } = await client.query(
    `select account_id, account_order, status,
            host(searchadvisor_session_validated_public_ip) as ip,
            searchadvisor_session_secret_id is not null as has_session,
            searchadvisor_session_validated_at as validated_at
       from public.naver_searchadvisor_accounts
      where ${isOrder ? 'account_order = $1::int' : 'account_id = $1'}`,
    [String(token).trim()],
  );
  if (!rows.length) throw new Error(`계정을 찾을 수 없습니다: ${token}`);
  return rows[0];
}

/** 캐시를 타지 않게 매번 다른 쿼리스트링을 붙인다. */
function currentPublicIp() {
  const out = execFileSync('curl', ['-4', '-sS', '--max-time', '15', '--no-keepalive',
    `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) throw new Error(`공인 IP 조회 실패: ${out.slice(0, 120)}`);
  return out;
}

await client.connect();
try {
  if (statusArg) {
    const tokens = statusArg.split(',').map((s) => s.trim()).filter(Boolean);
    console.log('순번  계정                 상태     예약 IP           마지막 검증');
    for (const t of tokens) {
      const a = await findAccount(t);
      console.log(`#${String(a.account_order).padStart(3)}  ${a.account_id.padEnd(20)} ${a.status.padEnd(8)} `
        + `${String(a.ip ?? '(없음)').padEnd(17)} ${String(a.validated_at ?? '-').slice(4, 21)}`);
    }
    process.exit(0);
  }

  const account = await findAccount(accountArg);
  const ip = currentPublicIp();

  const { rows: holders } = await client.query(
    `select account_id, account_order, status
       from public.naver_searchadvisor_accounts
      where (searchadvisor_session_validated_public_ip = $1::inet
             or searchadvisor_session_saved_public_ip = $1::inet)
        and account_id <> $2
      order by account_order`,
    [ip, account.account_id],
  );

  console.log(`계정      : #${account.account_order} ${account.account_id} (${account.status})`);
  console.log(`세션      : ${account.has_session ? '있음' : '없음'}`);
  console.log(`예약 IP   : ${account.ip ?? '(없음)'}`);
  console.log(`현재 IP   : ${ip}`);

  if (account.ip === ip) {
    console.log('\n✅ 이미 이 계정의 예약 IP 입니다. 그대로 수집요청을 돌리면 HaiIP 클릭 없이 시작합니다.');
    process.exit(0);
  }
  if (holders.length) {
    console.log(`\n⛔ 이 IP 는 다른 계정이 쓰고 있습니다 (${holders.length}개):`);
    for (const h of holders) console.log(`     #${h.account_order} ${h.account_id} (${h.status})`);
    console.log('   IP 를 다시 바꾸고 이 명령을 다시 실행하세요:');
    console.log('     powershell -NoProfile -ep Bypass -File scripts\\haiip-windows-ui-control.ps1 change '
      + '-RequireChanged -NoAllCheck -ChangeClickMethod BMClick');
    process.exit(1);
  }

  console.log('\n✅ 비어 있는 IP 입니다.');
  if (!apply) {
    console.log('   기록하려면 --apply 를 붙이세요 (지금은 아무것도 바꾸지 않았습니다).');
    process.exit(0);
  }

  await client.query('begin');
  const res = await client.query(
    `update public.naver_searchadvisor_accounts
        set searchadvisor_session_validated_public_ip = $1::inet,
            searchadvisor_session_validated_at = now(),
            updated_at = now()
      where account_id = $2`,
    [ip, account.account_id],
  );
  if (res.rowCount !== 1) {
    await client.query('rollback');
    throw new Error(`1행이 아니라 롤백했습니다 (${res.rowCount}행).`);
  }
  await client.query('commit');
  console.log(`   기록 완료: #${account.account_order} ${account.account_id} → ${ip}`);
  console.log('\n   이제 이 기계에서 그 계정만 돌리세요:');
  console.log(`     powershell -NoProfile -ep Bypass -File scripts\\run-piping-crawl-range.ps1 `
    + `-Group piping-ravi -From ${account.account_order} -To ${account.account_order} -Pages 150`);
  console.log('   러너 로그에 "already on preferred IP" 가 뜨면 IP 뽑기를 건너뛴 것입니다.');
} finally {
  await client.end();
}
