#!/usr/bin/env node
/**
 * 배관 수집요청에서 안 나간 계정·호스트를 찾는다.
 *
 *   node scripts/check-piping-crawl-gaps.mjs --from 101 --to 150
 *   node scripts/check-piping-crawl-gaps.mjs --from 101 --to 150 --hosts       # 호스트까지
 *   node scripts/check-piping-crawl-gaps.mjs --group cleaning-ravi --from 51 --to 100
 *
 * "몇 건 나갔나" 가 아니라 "어느 계정이 통째로 빠졌나" 를 본다. 계정 하나가
 * HaiIP 에서 IP 를 못 잡고 죽으면 그 계정의 100호스트가 통째로 0건이 되는데,
 * 총량만 보면 그게 안 보인다 (46만/50만 이면 "8% 부족" 으로만 읽힌다).
 *
 * 판정 기준은 결과 테이블의 post_id 다 — URL 문자열을 정규식으로 파싱하지
 * 않는다. post_id 는 페이지 번호가 그대로 들어가고 인덱스도 host 해시가 있어
 * 전체 스캔보다 훨씬 싸다.
 *
 * ⚠ --group 은 도메인 그룹이다 (수집요청 그룹명이 아니다).
 *     piping-ravi     신규 서브도메인 1만 (계정 201~300, 정지 이관분은 100번대)
 *     cleaning-ravi   차용분 — 수집요청 쪽 그룹명은 piping-ravi-shared
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const group = valueOf('--group', 'piping-ravi');
const fromPage = Number(valueOf('--from', '101'));
const toPage = Number(valueOf('--to', '150'));
const showHosts = args.includes('--hosts');
const hostLimit = Number(valueOf('--host-limit', '40'));

if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 1 || toPage < fromPage) {
  throw new Error(`--from/--to 가 잘못됐습니다: ${fromPage}~${toPage}`);
}
const perHost = toPage - fromPage + 1;

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const client = new pg.Client({
  connectionString: env.DATABASE_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
await client.query('set statement_timeout = 300000');

try {
  const { rows } = await client.query(`
    with done as (
      select r.host, count(*) n
        from public.naver_searchadvisor_crawl_request_results r
       where r.status = 'submitted' and r.post_id between $2 and $3
       group by 1
    )
    select a.account_order ord, a.account_id, a.status,
           count(d.host) hosts,
           count(done.host) filter (where done.n >= $4) full_hosts,
           count(done.host) filter (where done.n between 1 and $4 - 1) partial_hosts,
           count(d.host) - count(done.host) zero_hosts,
           coalesce(sum(done.n), 0) submitted
      from public.naver_project_domains d
      join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      left join done on done.host = d.host
     where d.group_key = $1 and d.deployment_status = 'active'
     group by 1, 2, 3 order by 1`, [group, fromPage, toPage, perHost]);

  const target = rows.reduce((a, r) => a + Number(r.hosts) * perHost, 0);
  const sent = rows.reduce((a, r) => a + Number(r.submitted), 0);
  const short = rows.filter((r) => Number(r.submitted) < Number(r.hosts) * perHost);
  const dead = short.filter((r) => Number(r.zero_hosts) === Number(r.hosts));

  console.log(`=== ${group} · /piping/${fromPage}~${toPage} (호스트당 ${perHost}장) ===`);
  console.log(`  계정 ${rows.length}개 · 호스트 ${rows.reduce((a, r) => a + Number(r.hosts), 0).toLocaleString()}개`);
  console.log(`  제출 ${sent.toLocaleString()} / 목표 ${target.toLocaleString()}  (부족 ${(target - sent).toLocaleString()})`);
  console.log(`  통째로 안 돈 계정 ${dead.length}개 · 일부만 빠진 계정 ${short.length - dead.length}개\n`);

  if (dead.length) {
    console.log('── 통째로 안 돈 계정 (재실행 대상) ──');
    console.log('순번  계정                 상태     호스트   부족');
    for (const r of dead) {
      console.log(`#${String(r.ord).padStart(3)}  ${r.account_id.padEnd(20)} ${r.status.padEnd(8)} ${String(r.hosts).padStart(5)} ${String(Number(r.hosts) * perHost).padStart(6)}`);
    }
    console.log(`\n  재실행 명령 (기계 배정은 .claude/skills/crawl 참고):`);
    for (const r of dead) {
      console.log(`    ... run-piping-crawl-range.ps1 -Group ${group === 'piping-ravi' ? 'piping-ravi' : 'piping-ravi-shared'} -From ${r.ord} -To ${r.ord} -Pages ${toPage}`);
    }
    console.log('');
  }

  const partial = short.filter((r) => Number(r.zero_hosts) < Number(r.hosts));
  if (partial.length) {
    const lost = partial.reduce((a, r) => a + (Number(r.hosts) * perHost - Number(r.submitted)), 0);
    console.log(`── 일부만 빠진 계정 ${partial.length}개 (합계 ${lost.toLocaleString()}건) ──`);
    console.log('  대개 하루 한도(quota-stop)나 개별 호스트 실패다. 다음 회차에 dedup 이 알아서 채운다.');
    const worst = [...partial].sort((a, b) =>
      (Number(b.hosts) * perHost - Number(b.submitted)) - (Number(a.hosts) * perHost - Number(a.submitted))).slice(0, 8);
    for (const r of worst) {
      console.log(`    #${String(r.ord).padStart(3)} ${r.account_id.padEnd(20)} 부족 ${String(Number(r.hosts) * perHost - Number(r.submitted)).padStart(5)}건 (일부 ${r.partial_hosts}호스트 · 0장 ${r.zero_hosts}호스트)`);
    }
    console.log('');
  }

  if (showHosts) {
    const { rows: hosts } = await client.query(`
      with done as (
        select r.host, count(*) n
          from public.naver_searchadvisor_crawl_request_results r
         where r.status = 'submitted' and r.post_id between $2 and $3
         group by 1
      )
      select d.host, a.account_order ord, coalesce(done.n, 0) n
        from public.naver_project_domains d
        join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
        left join done on done.host = d.host
       where d.group_key = $1 and d.deployment_status = 'active'
         and coalesce(done.n, 0) < $4
       order by coalesce(done.n, 0), a.account_order limit $5`,
    [group, fromPage, toPage, perHost, hostLimit]);
    console.log(`── 덜 나간 호스트 (앞 ${hosts.length}개) ──`);
    for (const h of hosts) console.log(`    #${String(h.ord).padStart(3)} ${h.host.padEnd(32)} ${h.n}/${perHost}장`);
  } else {
    console.log('  호스트 단위로 보려면 --hosts');
  }
} finally {
  await client.end();
}
