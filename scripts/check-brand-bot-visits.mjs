#!/usr/bin/env node
/**
 * 브랜드 다섯 사이트에 검색 봇이 실제로 오는지 오리진 접근 로그로 센다.
 *
 *   node scripts/check-brand-bot-visits.mjs              # 최근 3일
 *   node scripts/check-brand-bot-visits.mjs --days 7
 *   node scripts/check-brand-bot-visits.mjs --all        # 회전 로그 전부
 *   node scripts/check-brand-bot-visits.mjs --save       # reports/ 에 기준선으로 남긴다
 *
 * 왜 이걸 보나
 *   2026-09-07 에 드림·비버에만 키워드를 늘리고 썬더는 그대로 뒀다 (대조군).
 *   셋은 도메인 등록일이 같고 동 페이지도 4,760장씩이라 다른 건 콘텐츠뿐이다.
 *   차이가 나면 콘텐츠 때문이고, 셋 다 안 움직이면 도메인 파워 문제다.
 *
 *   "노출" 자체는 서치콘솔·서치어드바이저만 준다. 우리가 직접 잴 수 있는 건
 *   ① 봇이 왔나(이 스크립트) ② 색인됐나(check-brand-root-index.mjs) 둘이다.
 *   크롤이 색인보다 먼저 움직이므로 이쪽이 신호가 빠르다.
 *
 * ⚠⚠ 오리진은 t3.small — 메모리 2GB, 스왑 없음 ⚠⚠
 * 2026-08-27 에 로그 집계에 sort 를 물렸다가 nginx 를 OOM 으로 죽여 전 사이트가
 * 521 이 됐다. 그래서 여기서도 규칙은 같다.
 *   - 큰 입력에 sort 를 물리지 않는다. 집계는 awk 연관배열로 끝낸다
 *     (키가 호스트 5개 × 봇 4종 × 날짜라 수백 개뿐 — 입력이 커도 메모리가 상수)
 *   - 중간 파일을 만들지 않는다. zcat -> grep -> awk 스트리밍 한 번뿐이다
 *   - nice 로 우선순위를 낮춰 nginx 를 굶기지 않는다
 *   - 기본이 최근 3일이다. 전체는 --all 을 명시해야 한다
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/local-env.mjs';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';

loadLocalEnv();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => {
  const i = args.indexOf(flag);
  return i === -1 ? fb : (args[i + 1] ?? fb);
};
const scanAll = args.includes('--all');
const save = args.includes('--save');
const days = Number(valueOf('--days', '3'));
if (!scanAll && (!Number.isInteger(days) || days < 1)) throw new Error('--days 는 1 이상의 정수');

/* 실험군 · 대조군을 표에 같이 적어 두면 읽는 사람이 헷갈리지 않는다. */
const HOSTS = [
  { host: 'dreamcome.kr', label: '드림컴뚜러', arm: '실험군' },
  { host: 'beaverpipe.kr', label: '비버배관', arm: '실험군' },
  { host: 'thunderdrain.kr', label: '썬더배관', arm: '대조군' },
  { host: 'ssac3.kr', label: '싹쓰리배관', arm: '하단·설명만' },
  { host: 'dosadosa.kr', label: '하수구도사', arm: '하단·설명만' },
];

/* 어느 봇인지. 로그의 UA 문자열에 이 조각이 있으면 그 봇으로 센다. */
const BOTS = [
  ['Yeti', 'Yeti'],                    // 네이버
  ['Googlebot', 'Googlebot'],
  ['bingbot', 'bingbot'],
  ['Daum', 'Daum'],                    // 다음
];

/** 작은따옴표로 감싼다. 안쪽 작은따옴표는 '\'' 로 끊어 붙인다. */
function shq(v) {
  const BS = String.fromCharCode(92);
  return `'${String(v).split("'").join(`'${BS}''`)}'`;
}

const awkProgram = [
  'BEGIN {',
  `  n = split(${JSON.stringify(HOSTS.map((h) => h.host).join(' '))}, a, " ");`,
  '  for (i = 1; i <= n; i++) want[a[i]] = 1;',
  `  m = split(${JSON.stringify(BOTS.map((b) => b[0]).join(' '))}, bp, " ");`,
  '  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ");',
  '  for (i = 1; i <= 12; i++) mnum[mn[i]] = sprintf("%02d", i);',
  '}',
  '{',
  /* 호스트는 줄 끝 따옴표 안이다. -F 를 쓰면 셸 인용이 한 겹 더 늘어난다. */
  '  if (!match($0, /"[^"]*"$/)) next;',
  '  host = substr($0, RSTART + 1, RLENGTH - 2);',
  '  if (!(host in want)) next;',
  /* 27/Aug/2026 -> 2026-08-27 (정렬 가능한 형태로) */
  '  b = index($0, "[");',
  '  d = "?";',
  '  if (b) {',
  '    split(substr($0, b + 1, 11), dp, "/");',
  '    if (dp[2] in mnum) d = dp[3] "-" mnum[dp[2]] "-" dp[1];',
  '  }',
  '  which = "";',
  '  for (i = 1; i <= m; i++) if (index($0, bp[i])) { which = bp[i]; break }',
  '  if (which == "") next;',
  '  C[host, which, d]++; tot[host, which]++; dseen[d] = 1; hits++;',
  '}',
  'END {',
  '  printf "봇방문 %d건\\n", hits;',
  /* 정렬은 여기서 끝난다. 키가 수백 개뿐이라 안전하다. */
  '  for (k in C) { split(k, p, SUBSEP); print "ROW", p[1], p[2], p[3], C[k] }',
  '  for (k in tot) { split(k, p, SUBSEP); print "TOT", p[1], p[2], tot[k] }',
  '}',
].join('\n');

/*
 * 로그는 root 소유라 sudo 없이는 못 읽는다. 그런데 stderr 를 버리면
 * "Permission denied" 가 안 보여 봇이 0건인 것처럼 나온다 — 실제로 그렇게
 * 잘못 읽었다 (2026-09-07). sudo 를 붙이고 stderr 는 살려 둔다.
 */
const pickRotated = scanAll
  /*
   * ⚠ 글로브에 .gz 를 붙이지 말 것. logrotate 가 delaycompress 라 가장 최근
   * 회전분은 압축이 안 되어 있다 — .gz 만 잡으면 어제치를 통째로 빠뜨린다.
   */
  /*
   * 글로브를 sudo 안에서 펼쳐야 한다. 바깥 셸(ec2-user)이 펼치면 디렉터리를
   * 못 읽어 별표가 그대로 ls 에 넘어가고 "cannot access" 로 끝난다 —
   * 그러면 오늘치 access.log 하나만 보고 지난 며칠을 통째로 빠뜨린다.
   */
  ? `sudo sh -c ${shq('ls -1t /var/log/nginx/access.log-*')}`
  : `sudo sh -c ${shq(`ls -1t /var/log/nginx/access.log-* | head -${days}`)}`;

const remote = [
  '{',
  `LOGS="/var/log/nginx/access.log $(${pickRotated} | tr '\\n' ' ')";`,
  'echo "로그파일 $(echo $LOGS | wc -w)개";',
  'sudo nice -n 19 zcat -f $LOGS',
  `  | nice -n 19 awk ${shq(awkProgram)};`,
  'echo "MEM $(free -m | awk \'/Mem:/{print $3"/"$2"MB"}\')";',
  '}',
].join(' ');

const origin = await prepareOriginSsh({ mode: 'direct' });
let out = '';
try {
  out = execFileSync('bash', ['-c', `${origin.sshCommand} ${shq(remote)}`], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
} finally {
  if (typeof origin.cleanup === 'function') origin.cleanup();
}

const rows = [];
const totals = new Map();
let hits = 0;
let mem = '';
let files = '';
for (const line of out.split('\n')) {
  const t = line.trim();
  if (t.startsWith('ROW ')) {
    const [, host, bot, date, n] = t.split(/\s+/);
    rows.push({ host, bot, date, n: Number(n) });
  } else if (t.startsWith('TOT ')) {
    const [, host, bot, n] = t.split(/\s+/);
    totals.set(`${host}|${bot}`, Number(n));
  } else if (t.startsWith('봇방문 ')) {
    hits = Number(t.replace(/[^\d]/g, ''));
  } else if (t.startsWith('MEM ')) mem = t.slice(4);
  else if (t.startsWith('로그파일 ')) files = t;
}

const dates = [...new Set(rows.map((r) => r.date))].sort();
console.log(`${files} · ${scanAll ? '전체' : `최근 ${days}일`} · 봇방문 ${hits.toLocaleString()}건 · 오리진 메모리 ${mem}`);
console.log(`기간 ${dates[0] || '-'} ~ ${dates[dates.length - 1] || '-'}\n`);

const pad = (s, n) => String(s).padEnd(n - (String(s).match(/[가-힣]/g) || []).length);
console.log(`${pad('사이트', 14)}${pad('구분', 12)}${BOTS.map(([b]) => b.padStart(10)).join('')}`);
for (const h of HOSTS) {
  const cells = BOTS.map(([b]) => String(totals.get(`${h.host}|${b}`) || 0).padStart(10)).join('');
  console.log(`${pad(h.label, 14)}${pad(h.arm, 12)}${cells}`);
}

if (save) {
  const dir = join(projectRoot, 'reports/brand-bot-visits');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = join(dir, `${stamp}.json`);
  writeFileSync(file, `${JSON.stringify({
    takenAt: new Date().toISOString(),
    scope: scanAll ? 'all' : `${days}d`,
    hits,
    hosts: HOSTS,
    bots: BOTS.map(([b]) => b),
    totals: Object.fromEntries(totals),
    daily: rows,
  }, null, 1)}\n`);
  console.log(`\n기준선을 남겼습니다 → ${file.replace(projectRoot, '.')}`);
}
