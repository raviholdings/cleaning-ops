#!/usr/bin/env node
/**
 * 브랜드 사이트의 방문 IP·횟수를 본다.
 *
 *   node scripts/check-brand-traffic.mjs                              # 기본 2일
 *   node scripts/check-brand-traffic.mjs --days 5
 *   node scripts/check-brand-traffic.mjs --hosts ssac3.kr --days 3
 *   node scripts/check-brand-traffic.mjs --all --top 30
 *
 * 왜 이게 되는가
 *   두 사이트는 Cloudflare 뒤에 있어 nginx 의 $remote_addr 은 CF IP 다.
 *   진짜 방문자 IP 는 $http_x_forwarded_for 에 들어오고, log_format main 이
 *   이미 그걸 찍고 있다. 별도 설정 없이 지금 로그로 집계된다.
 *
 * 무엇을 보나
 *   - 일자별 요청수 / 사람 / 봇 / 서로 다른 IP
 *   - 봇 제외 IP 상위 N개
 *   외주 트래픽 작업(비실계·리워드)이 실제로 들어오는지 보려면 "서로 다른 IP" 와
 *   "IP 당 요청수" 를 같이 봐야 한다. 총량은 몇 IP 가 반복해서 올려도 늘어난다.
 *
 * ⚠ 봇 판정은 UA 문자열 기준이라 자칭이다. UA 를 바꾼 트래픽은 사람으로 잡힌다.
 * ⚠⚠ 오리진은 t3.small(2GB, 스왑 없음). sort 를 물리지 말 것 —
 *    2026-08-27 에 그걸로 nginx 를 죽였다. .claude/skills/server 참고.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/local-env.mjs';
import { buildBrandTrafficAwk } from './lib/brand-traffic-awk.mjs';

loadLocalEnv();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const scanAll = args.includes('--all');
const days = Math.max(1, Number(valueOf('--days', '2')));
const topN = Math.max(1, Number(valueOf('--top', '15')));
const hosts = valueOf('--hosts', 'ssac3.kr,dosadosa.kr').split(',').map((s) => s.trim()).filter(Boolean);
/*
 * --path 로 특정 페이지만 본다. 한글은 로그에 퍼센트 인코딩으로 남으므로
 * 인코딩해서 찾는다 (예: 횡주관청소 -> %ED%9A%A1%EC%A3%BC...).
 * 대소문자를 가리지 않게 grep -i 를 쓴다 — 인코딩 대문자/소문자가 섞여 들어온다.
 */
const pathFilter = valueOf('--path');
const pathPattern = pathFilter
  ? encodeURIComponent(pathFilter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  : '';
const INSTANCE = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';

/** 작은따옴표로 감싼다. 안쪽 작은따옴표는 끊어 붙인다. */
const shq = (v) => `'${String(v).split("'").join(`'${String.fromCharCode(92)}''`)}'`;

// ⚠ 글로브에 .gz 를 붙이지 말 것. logrotate 가 delaycompress 라 가장 최근
// 회전분은 압축되어 있지 않다 — .gz 만 잡으면 어제치를 통째로 빠뜨린다.
const pickRotated = scanAll
  ? 'ls -1t /var/log/nginx/access.log-* 2>/dev/null'
  : `ls -1t /var/log/nginx/access.log-* 2>/dev/null | head -${days}`;

// 호스트로 먼저 걸러 입력을 줄인다. 그 뒤에야 awk 로 집계한다.
const hostGrep = hosts.map((h) => h.replace(/\./g, '\\.')).join('|');

const remote = [
  '{',
  `LOGS="/var/log/nginx/access.log $(${pickRotated} | tr '\\n' ' ')";`,
  'echo "로그 파일: $(echo $LOGS | wc -w)개"; echo;',
  'nice -n 19 zcat -f $LOGS 2>/dev/null',
  `  | nice -n 19 grep -E ${shq(hostGrep)}`,
  ...(pathPattern ? [`  | nice -n 19 grep -i -E ${shq(pathPattern)}`] : []),
  `  | nice -n 19 awk ${shq(buildBrandTrafficAwk(hosts, topN))};`,
  'echo;',
  'free -m | grep -i mem;',
  'date -u;',
  '} | base64 -w0',
].join(' ');

const cmdId = execFileSync('aws', ['ssm', 'send-command', '--instance-ids', INSTANCE,
  '--document-name', 'AWS-RunShellScript',
  '--parameters', JSON.stringify({ commands: [remote] }),
  '--query', 'Command.CommandId', '--output', 'text']).toString().trim();

let out = '';
for (let i = 0; i < 60; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = execFileSync('aws', ['ssm', 'get-command-invocation', '--command-id', cmdId,
      '--instance-id', INSTANCE, '--query', '[Status,StandardOutputContent]', '--output', 'text']).toString();
    if (res.startsWith('Success') || res.startsWith('Failed')) { out = res; break; }
  } catch { /* 아직 시작 전 */ }
}
if (!out) throw new Error('SSM 응답 시간 초과');

console.log(`=== 브랜드 트래픽 (${hosts.join(', ')} · ${scanAll ? '전체 이력' : `최근 ${days}일`}) ===`);
const text = Buffer.from(out.split(/\s+/).filter(Boolean).pop(), 'base64').toString('utf8');
const memLine = text.split('\n').find((l) => /^Mem:/i.test(l.trim()));
const pretty = memLine ? (() => {
  const [total, used, , , , avail] = memLine.trim().split(/\s+/).slice(1).map(Number);
  const warn = avail < 300 ? '  ⚠ 여유가 없다 — 무거운 작업 금지' : '';
  return `메모리: ${used}MB 사용 / ${total}MB · 가용 ${avail}MB (${Math.round((avail / total) * 100)}%)${warn}`;
})() : null;
console.log(pretty ? text.replace(memLine, pretty) : text);
