/**
 * apex 루트 10개에 네이버 Yeti 가 실제로 오는지 오리진 접근 로그로 센다.
 *
 *   node scripts/check-apex-yeti-visits.mjs
 *
 * IndexNow 제출(scripts/submit-apex-indexnow.mjs)이 실제로 효과가 있었는지
 * 판별하는 유일한 직접 증거다. 제출 응답 200 은 "접수됨" 일 뿐 방문이 아니다.
 *
 * 기준선 (2026-08-26 11:58 UTC, IndexNow 제출 직후):
 *   apex 10개 전부 0회 / 같은 날 서브도메인 Yeti 7,572회
 *   -> 0 에서 움직이면 그게 IndexNow 가 발견 경로를 열었다는 신호다.
 *
 * 로그 형식의 마지막 필드가 호스트다. 서브도메인과 섞이지 않게
 * "루트" 로 끝나는 줄만(= 앞에 점이 없는 정확 일치) 센다.
 */
import { execFileSync } from 'node:child_process';

const INSTANCE = 'i-039361b55ae33808b';
const LOG = '/var/log/nginx/access.log';
const ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];

const remote = [
  '{',
  `for r in ${ROOTS.join(' ')}; do`,
  `  apex=$(grep Yeti ${LOG} | grep -c "\\"$r\\"$");`,
  `  sub=$(grep Yeti ${LOG} | grep -c "\\.$r\\"$");`,
  '  printf "  %-20s apex=%-6s 서브도메인=%s\\n" "$r" "$apex" "$sub";',
  'done;',
  `echo; echo "Yeti 전체: $(grep -c Yeti ${LOG})"; echo "로그 시작: $(head -1 ${LOG} | cut -d[ -f2 | cut -d] -f1)"; date -u;`,
  '} | base64 -w0',
].join(' ');

const cmdId = execFileSync('aws', [
  'ssm', 'send-command', '--instance-ids', INSTANCE,
  '--document-name', 'AWS-RunShellScript',
  '--parameters', JSON.stringify({ commands: [remote] }),
  '--query', 'Command.CommandId', '--output', 'text',
]).toString().trim();

// SSM 은 비동기다. 완료될 때까지 짧게 되묻는다.
let out = '';
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const res = execFileSync('aws', [
      'ssm', 'get-command-invocation', '--command-id', cmdId,
      '--instance-id', INSTANCE, '--query', '[Status,StandardOutputContent]', '--output', 'text',
    ]).toString();
    if (res.startsWith('Success') || res.startsWith('Failed')) { out = res; break; }
  } catch { /* InvocationDoesNotExist — 아직 시작 전 */ }
}
if (!out) throw new Error('SSM 응답 시간 초과');

console.log('=== apex 루트 Yeti 방문 ===');
// --output text 는 "Success\t<base64>\n" 로 온다. 끝의 빈 조각을 걷어내야 한다.
const payload = out.split(/\s+/).filter(Boolean).pop();
console.log(Buffer.from(payload, 'base64').toString('utf8'));
console.log('기준선(2026-08-26 11:58 UTC): apex 전부 0회. 0 에서 움직였으면 IndexNow 가 먹힌 것.');
