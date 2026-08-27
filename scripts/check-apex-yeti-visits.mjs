/**
 * apex 루트 10개에 네이버 Yeti 가 실제로 오는지 오리진 접근 로그로 센다.
 *
 *   node scripts/check-apex-yeti-visits.mjs            # 최근 2일
 *   node scripts/check-apex-yeti-visits.mjs --days 5
 *   node scripts/check-apex-yeti-visits.mjs --all      # 회전 로그 전부
 *
 * IndexNow 제출(scripts/submit-apex-indexnow.mjs)이 효과가 있었는지 판별하는
 * 유일한 직접 증거다. 제출 응답 200 은 "접수됨" 일 뿐 방문이 아니다.
 *
 * 기준선 (2026-08-26 11:58 UTC, IndexNow 제출 직후):
 *   apex 10개 전부 0회 / 같은 날 서브도메인 Yeti 7,572회
 *   -> 0 에서 움직이면 그게 IndexNow 가 발견 경로를 열었다는 신호다.
 *
 * ⚠⚠ 오리진은 t3.small — 메모리 2GB, 스왑 없음 ⚠⚠
 * 2026-08-27 09:13 KST, 이 스크립트의 옛 버전이 nginx 를 OOM 으로 죽였다.
 * 로그 180만 줄을 `sort | uniq -c` 에 물렸더니 sort 가 1.76GB 를 잡았고, 커널이
 * nginx·systemd-resolve·systemd-logind 를 죽여 전 사이트가 HTTP 521 이 됐다.
 *
 * 그래서 이 스크립트는:
 *   - 큰 입력에 sort 를 절대 물리지 않는다. 집계는 awk 연관배열로 한 번에 끝낸다
 *     (키가 호스트 10여 개 × 날짜라 수백 개뿐 — 입력이 아무리 커도 메모리가 상수)
 *   - 중간 파일을 만들지 않는다. zcat -> grep -> awk 스트리밍 한 번뿐이다
 *   - 마지막 sort 는 이미 수십 줄로 줄어든 출력에만 걸고 -S 로 상한을 둔다
 *   - nice 로 우선순위를 낮춰 nginx 를 굶기지 않는다
 *   - 기본이 최근 2일이다. 전체 이력은 --all 을 명시해야 한다
 *
 * 오리진에서 로그를 훑는 스크립트를 새로 쓸 때도 같은 규칙을 지킬 것.
 */
import { execFileSync } from 'node:child_process';
import { loadLocalEnv } from './lib/local-env.mjs';
import { buildYetiAwk, APEX_ROOTS } from './lib/yeti-log-awk.mjs';

loadLocalEnv();  // AWS 자격증명 — 셸에 미리 export 하지 않아도 돌게 한다

/** 작은따옴표로 감싼다. 안쪽 작은따옴표는 '\'' 로 끊어 붙인다. */
function shq(v) {
  const BS = String.fromCharCode(92);
  return `'${String(v).split("'").join(`'${BS}''`)}'`;
}

const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const scanAll = args.includes('--all');
const days = Number(valueOf('--days', '2'));
if (!scanAll && (!Number.isInteger(days) || days < 1)) throw new Error('--days 는 1 이상의 정수');

const INSTANCE = 'i-039361b55ae33808b';
const ROOTS = APEX_ROOTS;

// awk 프로그램은 lib/yeti-log-awk.mjs 에 있다 (로컬에서 시험할 수 있게 분리).
const awkProgram = buildYetiAwk(ROOTS);

// 로그는 매일 00:00 UTC 에 access.log-YYYYMMDD.gz 로 회전한다. 현재 파일만 보면
// 자정 직후에는 몇 분치밖에 없어서 0 이 나온다 — 회전분을 최신순으로 함께 본다.
const pickRotated = scanAll
  ? 'ls -1t /var/log/nginx/access.log-*.gz 2>/dev/null'
  : `ls -1t /var/log/nginx/access.log-*.gz 2>/dev/null | head -${days}`;

const remote = [
  '{',
  `LOGS="/var/log/nginx/access.log $(${pickRotated} | tr '\\n' ' ')";`,
  'echo "로그 파일: $(echo $LOGS | wc -w)개"; echo;',
  // 중간 파일 없음. 각 단계에 nice 를 걸어 nginx 를 굶기지 않는다.
  'nice -n 19 zcat -f $LOGS 2>/dev/null',
  '  | nice -n 19 grep Yeti',
  // 정렬은 awk 안에서 끝난다. 여기에 sort 를 붙이지 말 것 — nginx 를 죽인 게 그것이다.
  `  | nice -n 19 awk ${shq(awkProgram)};`,
  'echo;',
  'free -m | grep -i mem;',
  'date -u;',
  '} | base64 -w0',
].join(' ');

const cmdId = execFileSync('aws', [
  'ssm', 'send-command', '--instance-ids', INSTANCE,
  '--document-name', 'AWS-RunShellScript',
  '--parameters', JSON.stringify({ commands: [remote] }),
  '--query', 'Command.CommandId', '--output', 'text',
]).toString().trim();

let out = '';
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = execFileSync('aws', [
      'ssm', 'get-command-invocation', '--command-id', cmdId,
      '--instance-id', INSTANCE, '--query', '[Status,StandardOutputContent]', '--output', 'text',
    ]).toString();
    if (res.startsWith('Success') || res.startsWith('Failed')) { out = res; break; }
  } catch { /* InvocationDoesNotExist — 아직 시작 전 */ }
}
if (!out) throw new Error('SSM 응답 시간 초과');

console.log(`=== apex 루트 Yeti 방문 (${scanAll ? '전체 이력' : `최근 ${days}일`}) ===`);
// --output text 는 "Success\t<base64>\n" 로 온다. 끝의 빈 조각을 걷어내야 한다.
const payload = out.split(/\s+/).filter(Boolean).pop();
console.log(Buffer.from(payload, 'base64').toString('utf8'));
console.log('기준선(2026-08-26 11:58 UTC): apex 전부 0회. 0 에서 움직였으면 IndexNow 가 먹힌 것.');
