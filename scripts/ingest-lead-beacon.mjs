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
const since = valueOf('--since') || '';
const groupKey = valueOf('--group') || 'cleaning-ravi';
const instance = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';
const region = process.env.AWS_DEFAULT_REGION || 'ap-northeast-2';
const logPath = valueOf('--log') || '/var/log/nginx/lead.log';

console.log(`=== 견적 폼 이벤트 수집 (group=${groupKey}, dryRun=${dryRun}) ===`);

const raw = fetchLog();
const rows = parse(raw);
console.log(`  로그 ${raw.split('\n').filter(Boolean).length}줄 · 해석 ${rows.length}건`);

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
      [groupKey, row.host, row.path, `beacon:${row.event}`, '제휴사 iframe 폼 이벤트 (입력값은 수집 불가)', row.at],
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

/** 서버 로그를 SSM 으로 읽어온다. ssh 키가 없는 기계에서도 돌게. */
function fetchLog() {
  const filter = since ? `grep '^${since}' ${logPath} || true` : `cat ${logPath} 2>/dev/null || true`;
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
    execFileSync(process.platform === 'win32' ? 'timeout' : 'sleep',
      process.platform === 'win32' ? ['/t', '2', '/nobreak'] : ['2'], { stdio: 'ignore' });
  }

  return execFileSync('aws', [
    'ssm', 'get-command-invocation', '--command-id', commandId,
    '--instance-id', instance, '--region', region,
    '--query', 'StandardOutputContent', '--output', 'text',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** `2026-08-18T12:00:00+09:00\thost\tadvance\t/37.html` */
function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 4) continue;
    const [at, host, event, path] = parts;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at)) continue;
    if (event !== 'view' && event !== 'advance') continue;
    out.push({ at, host, event, path: decodeURIComponent(path || '/') });
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
