/**
 * 배관 IndexNow 파일럿 감시 — 제출군 vs 대조군 Yeti 방문 비교.
 *
 *   node scripts/check-indexnow-pilot.mjs            # 최근 2일
 *   node scripts/check-indexnow-pilot.mjs --days 5
 *   node scripts/check-indexnow-pilot.mjs --all
 *
 * 판정 방법:
 *   제출군과 대조군은 같은 날 같은 내용으로 배포된, 같은 루트에서 뽑은
 *   200 : 200 이다. 차이는 IndexNow 제출 여부 하나뿐이다.
 *   - 두 군이 비슷하게 오른다  -> IndexNow 효과 아님 (배경 변동)
 *   - 제출군만 오른다          -> IndexNow 가 발견 경로를 열었다
 *   - 둘 다 0                  -> 아직 판단 불가. 며칠 더
 *
 * "방문받은 호스트 수" 를 같이 보는 이유: 총 방문수는 한 호스트가 수천 번
 * 긁히면서 혼자 끌어올릴 수 있다. 몇 개 호스트가 발견됐는지가 더 정직하다.
 *
 * ⚠ 8/25 이전 회전 로그는 log_format 에 $host 가 없어 호스트를 알 수 없다.
 *   그 구간은 두 군 모두 0 으로 보인다 — 없는 게 아니라 못 세는 것이다.
 *
 * ⚠⚠ 오리진은 t3.small(2GB, 스왑 없음). 큰 입력에 sort 를 물리지 말 것 —
 *    2026-08-27 09:13 KST 에 그걸로 nginx 를 죽였다. .claude/skills/server 참고.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/local-env.mjs';
import { buildPilotAwk } from './lib/pilot-log-awk.mjs';

loadLocalEnv();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const scanAll = args.includes('--all');
const days = Number(valueOf('--days', '2'));
const INSTANCE = 'i-039361b55ae33808b';

/** 작은따옴표로 감싼다. 안쪽 작은따옴표는 끊어 붙인다. */
const shq = (v) => `'${String(v).split("'").join(`'${String.fromCharCode(92)}''`)}'`;

const pilot = JSON.parse(readFileSync(resolve(projectRoot, 'data/piping/indexnow-pilot.json'), 'utf8'));
const submit = pilot.submit.map((s) => s.host);
const control = pilot.control;

// ⚠ 글로브에 .gz 를 붙이지 말 것. logrotate 가 delaycompress 라 가장 최근
// 회전분은 압축되어 있지 않다 — .gz 만 잡으면 어제치를 통째로 빠뜨린다.
const pickRotated = scanAll
  ? 'ls -1t /var/log/nginx/access.log-* 2>/dev/null'
  : `ls -1t /var/log/nginx/access.log-* 2>/dev/null | head -${days}`;

const remote = [
  '{',
  `LOGS="/var/log/nginx/access.log $(${pickRotated} | tr '\\n' ' ')";`,
  'echo "로그 파일: $(echo $LOGS | wc -w)개"; echo;',
  // 중간 파일 없음. 각 단계 nice. 정렬은 awk 안에서 끝난다.
  'nice -n 19 zcat -f $LOGS 2>/dev/null',
  '  | nice -n 19 grep Yeti',
  `  | nice -n 19 awk ${shq(buildPilotAwk(submit, control))};`,
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
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = execFileSync('aws', ['ssm', 'get-command-invocation', '--command-id', cmdId,
      '--instance-id', INSTANCE, '--query', '[Status,StandardOutputContent]', '--output', 'text']).toString();
    if (res.startsWith('Success') || res.startsWith('Failed')) { out = res; break; }
  } catch { /* 아직 시작 전 */ }
}
if (!out) throw new Error('SSM 응답 시간 초과');

const submittedAt = pilot.submittedAt ? ` · 제출 ${pilot.submittedAt}` : ' · 아직 제출 안 함';
console.log(`=== IndexNow 파일럿 (${scanAll ? '전체 이력' : `최근 ${days}일`})${submittedAt} ===`);

const text = Buffer.from(out.split(/\s+/).filter(Boolean).pop(), 'base64').toString('utf8');
const memLine = text.split('\n').find((l) => /^Mem:/i.test(l.trim()));
const pretty = memLine ? (() => {
  const [total, used, , , , avail] = memLine.trim().split(/\s+/).slice(1).map(Number);
  const warn = avail < 300 ? '  ⚠ 여유가 없다 — 무거운 작업 금지' : '';
  return `메모리: ${used}MB 사용 / ${total}MB · 가용 ${avail}MB (${Math.round((avail / total) * 100)}%)${warn}`;
})() : null;
console.log(pretty ? text.replace(memLine, pretty) : text);
