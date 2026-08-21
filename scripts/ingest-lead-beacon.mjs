#!/usr/bin/env node
/**
 * nginx 의 견적 폼 이벤트 로그를 DB 로 옮긴다.
 *
 *   node scripts/ingest-lead-beacon.mjs --dry-run
 *   node scripts/ingest-lead-beacon.mjs
 *   node scripts/ingest-lead-beacon.mjs --since 2026-08-18
 *
 * 왜 로그를 거치나
 *   사이트는 nginx 가 파일만 내보내는 정적 구조다. 백엔드가 없으니 브라우저가
 *   DB 로 바로 쓸 수 없다. 그래서 /_e 로 비콘을 쏘고 nginx 가 204 로 받아
 *   접근 로그에만 남긴다. 그 로그를 여기서 읽어 옮긴다.
 *
 * 무엇이 기록되나
 *   폼은 제휴사(replyalba) iframe 이라 입력값을 읽을 수 없다. 잡히는 것은
 *   "폼이 열렸다(view)" 와 "다음 화면으로 넘어갔다(advance)" 둘뿐이다.
 *   advance 는 제출의 상한이다 — 검증 오류로 되돌아온 경우도 포함된다.
 *   자세한 배경은 docs/LEAD-BEACON.md 참고.
 *
 * 테이블
 *   기존 lead_submissions 를 쓴다. 손님 정보 칸(customer_name 등)은 채울 수
 *   없으므로 NULL 로 두고 service_type 에 'beacon:view' / 'beacon:advance' 를
 *   적는다. 새 테이블을 만들면 나중에 제휴사 리포트를 받았을 때 합치기 번거롭다.
 *
 * 중복
 *   같은 (시각, 호스트, 이벤트, 경로) 는 한 번만 넣는다. 로그를 여러 번 돌려도
 *   같은 결과가 된다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// --ssh: SSM Run Command(24KB 상한) 대신 ssh(SSM 터널)로 회전 로그까지 통째로 읽는다.
// ssh 키가 있는 메인 PC 의 기본 경로. 스케줄 작업(scripts/run-lead-ingest-task.cmd)이 쓴다.
const useSsh = args.includes('--ssh');
const since = valueOf('--since') || '';
const groupKey = valueOf('--group') || 'cleaning-ravi';
const instance = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';
const region = process.env.AWS_DEFAULT_REGION || 'ap-northeast-2';
const profile = process.env.AWS_PROFILE || 'cleaning-ops';
const sshKey = process.env.ORIGIN_SSH_KEY || 'C:/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem';
const logPath = valueOf('--log') || (useSsh ? '/var/log/nginx/lead.log*' : '/var/log/nginx/lead.log');

console.log(`=== 견적 폼 이벤트 수집 (group=${groupKey}, dryRun=${dryRun}) ===`);

let botSkipped = 0;
const raw = fetchLog();
const rows = parse(raw);
console.log(`  로그 ${raw.split('\n').filter(Boolean).length}줄 · 해석 ${rows.length}건 · 봇 건너뜀 ${botSkipped}건`);

const counts = {};
for (const row of rows) counts[row.event] = (counts[row.event] || 0) + 1;
for (const [event, n] of Object.entries(counts)) console.log(`    ${event}: ${n}건`);

if (!rows.length) {
  console.log('\n넣을 것이 없습니다.');
  process.exit(0);
}

if (dryRun) {
  console.log('\n[dry-run] 아무것도 쓰지 않았습니다. 앞 5건:');
  for (const row of rows.slice(0, 5)) console.log(`    ${row.at}  ${row.host}  ${row.event}  ${row.path}`);
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  let inserted = 0;
  for (const row of rows) {
    /*
     * 같은 이벤트가 두 번 들어가지 않게 막는다. 유니크 제약이 없으므로
     * not exists 로 확인한다. 건수가 적어서(하루 수백) 이걸로 충분하다.
     */
    const res = await client.query(
      `insert into public.lead_submissions
         (group_key, host, site_url, service_type, request_notes, created_at)
       select $1, $2, $3, $4, $5, $6::timestamptz
        where not exists (
          select 1 from public.lead_submissions
           where host = $2 and site_url = $3 and service_type = $4 and created_at = $6::timestamptz)`,
      // 이사 페이지 이벤트는 경로로 구분해 moving-ravi 로 태그한다.
      // UA 를 notes 에 남긴다 — "누가(기기·브라우저)" 를 나중에 볼 수 있게 (2026-08-22).
      [row.path.startsWith('/이사/') ? 'moving-ravi' : groupKey,
        row.host, row.path, `beacon:${row.event}`,
        row.ua ? `제휴사 iframe 폼 이벤트 · ${row.ua.slice(0, 200)}` : '제휴사 iframe 폼 이벤트 (입력값은 수집 불가)', row.at],
    );
    inserted += res.rowCount;
  }
  console.log(`\n넣은 행 ${inserted} (중복 ${rows.length - inserted} 건너뜀)`);

  const total = await client.query(
    `select service_type, count(*)::int c
       from public.lead_submissions where service_type like 'beacon:%'
      group by 1 order by 1`,
  );
  console.log('\n누적:');
  for (const r of total.rows) console.log(`  ${r.service_type}: ${r.c.toLocaleString()}건`);
} finally {
  await client.end();
}

/**
 * 서버 로그를 SSM 으로 읽어온다. ssh 키가 없는 기계에서도 돌게.
 *
 * 함정: SSM Run Command 의 StandardOutputContent 는 24KB 에서 잘린다
 * (2026-08-22 실측 — 763줄 중 61줄만 왔다). 로그가 그보다 크면 ssh 로 받아서
 * --log <로컬파일> 로 넣을 것. 경로가 로컬에 존재하면 그 파일을 그대로 읽는다.
 */
function fetchLog() {
  if (existsSync(logPath)) {
    console.log(`  (로컬 파일 사용: ${logPath})`);
    return readFileSync(logPath, 'utf8');
  }
  if (useSsh) {
    console.log(`  (ssh 로 수집: ${logPath})`);
    return execFileSync('ssh', [
      '-o', 'StrictHostKeyChecking=no', '-i', sshKey,
      '-o', `ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region ${region} --profile ${profile}`,
      `ec2-user@${instance}`,
      `sudo sh -c 'zcat -f ${logPath} 2>/dev/null'`,
    ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  }
  // zcat -f 는 압축·비압축을 모두 읽는다. logrotate 가 lead.log 도 매일 자르므로
  // --log '/var/log/nginx/lead.log*' 로 회전분까지 한 번에 넣을 수 있다 (2026-08-22).
  const filter = since
    ? `zcat -f ${logPath} 2>/dev/null | grep '^${since}' || true`
    : `zcat -f ${logPath} 2>/dev/null || true`;
  const commandId = execFileSync('aws', [
    'ssm', 'send-command', '--instance-ids', instance, '--region', region,
    '--document-name', 'AWS-RunShellScript',
    '--parameters', `commands=["${filter.replace(/"/g, '\\"')}"]`,
    '--query', 'Command.CommandId', '--output', 'text',
  ], { encoding: 'utf8' }).trim();

  for (let i = 0; i < 60; i += 1) {
    const status = execFileSync('aws', [
      'ssm', 'get-command-invocation', '--command-id', commandId,
      '--instance-id', instance, '--region', region, '--query', 'Status', '--output', 'text',
    ], { encoding: 'utf8' }).trim();
    if (status !== 'InProgress' && status !== 'Pending') break;
    // Windows 의 timeout.exe 는 stdin 리다이렉트 환경에서 죽는다 (2026-08-22 실측,
    // 이것 때문에 ingest 가 한 번도 못 돌아 DB 가 비어 있었다). 프로세스 없이 잔다.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }

  const out = execFileSync('aws', [
    'ssm', 'get-command-invocation', '--command-id', commandId,
    '--instance-id', instance, '--region', region,
    '--query', 'StandardOutputContent', '--output', 'text',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.length >= 23500) {
    console.warn('  ⚠ SSM 출력이 24KB 상한 부근 — 잘렸을 수 있다. ssh 로 받아 --log <로컬파일> 로 다시 돌릴 것.');
  }
  return out;
}

/** `2026-08-18T12:00:00+09:00\thost\tadvance\t/37.html` */
function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 4) continue;
    const [at, host, event, path, ua] = parts;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) continue;
    if (event !== 'view' && event !== 'advance') continue;
    /*
     * 렌더링 봇을 거른다. 네이버 Yeti 가 페이지를 그리면서 비콘을 발사해
     * view 가 사람 방문처럼 쌓였다 (2026-08-20, 하루 82건 전부 봇 패턴).
     * UA 는 2026-08-20 부터 로그 5번째 칸에 붙는다. 그 전 줄(UA 없음)은
     * 구분할 수 없으므로 그대로 통과시킨다.
     * 'naver' 는 거르면 안 된다 — 네이버 앱 브라우저(사람) UA 에도 들어간다.
     */
    if (ua && /yeti|bot|spider|crawl|headless|phantom|slurp|bingpreview/i.test(ua)) {
      botSkipped += 1;
      continue;
    }
    out.push({ at, host, event, path: decodeSafe(path || '/'), ua: ua || '' });
  }
  return out;
}

/**
 * $arg_p 는 encodeURIComponent(pathname) 인데, 한글 경로는 브라우저의
 * pathname 자체가 이미 퍼센트 인코딩이라 로그에는 두 겹으로 쌓인다.
 * 두 번 풀어야 "/이사/…" 원형이 된다. 청소(/37.html)는 한 번에 원형이라
 * 두 번째 풀기가 아무것도 바꾸지 않는다.
 */
function decodeSafe(value) {
  let out = value;
  for (let i = 0; i < 2; i += 1) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] || '');
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}
