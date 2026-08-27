/**
 * IndexNow 키 파일을 서브도메인 웹루트에 올린다.
 *
 *   node scripts/prepare-indexnow-pilot.mjs
 *   node scripts/deploy-indexnow-keys.mjs --dry-run
 *   node scripts/deploy-indexnow-keys.mjs
 *
 * 올리는 것은 호스트당 <키>.txt 한 개(33바이트)뿐이다. 사이트를 다시 굽지
 * 않는다 — 기존 웹루트에 파일 하나를 얹기만 한다.
 *
 * ⛔ 지우지 않는다. tar 로 덮어 얹기만 한다. 원격 웹루트의 일괄 삭제는
 *    에이전트가 하지 않는다 (deploy 스킬 철칙 8).
 * ⛔ 배포 중 HaiIP 금지. IP 가 바뀌면 보안그룹 규칙이 어긋나 SSH 가 끊긴다.
 *
 * 심볼릭 링크 처리가 없는 이유: 대상이 서브도메인 실디렉토리다. apex 루트와
 * 달리 링크로 걸린 것이 없다 (그래도 아래에서 -L 로 확인하고, 링크면 건너뛴다).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';
import { loadLocalEnv } from './lib/local-env.mjs';

loadLocalEnv();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const dryRun = args.includes('--dry-run');
const mode = args.includes('--ssm') ? 'ssm' : 'direct';
const stageDir = resolve(projectRoot, valueOf('--stage', 'tmp/indexnow-keys'));
const REMOTE_ROOT = '/srv/group-page-origin/sites';

const BSLASH = String.fromCharCode(92);
const q = (v) => `'${String(v).split("'").join(`'${BSLASH}''`)}'`;
const toPosix = (p) => p.split(BSLASH).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

if (!existsSync(stageDir)) throw new Error(`스테이징이 없다: ${stageDir} — prepare-indexnow-pilot.mjs 를 먼저 돌릴 것`);
const hosts = readdirSync(stageDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
if (!hosts.length) throw new Error(`${stageDir} 가 비었다.`);

// 스테이징이 파일럿 정의와 어긋나면 멈춘다 (대조군에 키를 깔면 실험이 망가진다).
const pilot = JSON.parse(readFileSync(resolve(projectRoot, 'data/piping/indexnow-pilot.json'), 'utf8'));
const expected = new Set(pilot.submit.map((s) => s.host));
const controlSet = new Set(pilot.control);
const stray = hosts.filter((h) => !expected.has(h));
const leaked = hosts.filter((h) => controlSet.has(h));
if (stray.length || leaked.length) {
  throw new Error(`스테이징 불일치 — 제출군 밖 ${stray.length}개, 대조군 침범 ${leaked.length}개`);
}

console.log(`=== IndexNow 키 배포 (${hosts.length}개 호스트 · ${mode}${dryRun ? ' · dry-run' : ''}) ===`);
console.log(`  스테이징: ${stageDir}`);
console.log(`  예: ${hosts[0]}/${readdirSync(resolve(stageDir, hosts[0]))[0]}`);
console.log(`  대조군 ${pilot.control.length}개는 건드리지 않는다.`);

if (dryRun) {
  console.log(`\n[dry-run] 원격: mkdir -p ${REMOTE_ROOT} && cd ${REMOTE_ROOT} && tar -xz  (${hosts.length}개 파일)`);
  process.exit(0);
}

const ssh = await prepareOriginSsh({ mode });
process.on('exit', ssh.cleanup);
process.on('SIGINT', () => { ssh.cleanup(); process.exit(130); });
try {
  const listPath = resolve(stageDir, '.key-files');
  writeFileSync(listPath, `${hosts.map((h) => `./${h}`).join('\n')}\n`, 'utf8');

  console.log('-- 전송 --');
  const remote = [`mkdir -p ${REMOTE_ROOT}`, `cd ${REMOTE_ROOT}`, 'tar -xz'].join(' && ');
  const cmd = 'set -o pipefail; '
    + `tar -cz -C ${q(toPosix(stageDir))} -T ${q(toPosix(listPath))} | ${ssh.sshCommand} ${q(remote)}`;
  let sent = false;
  for (let attempt = 1; attempt <= 3 && !sent; attempt += 1) {
    try { execSync(cmd, { shell: 'bash', stdio: 'inherit' }); sent = true; }
    catch (e) {
      console.log(`  전송 실패 ${attempt}/3: ${String(e.message).split('\n')[0].slice(0, 140)}`);
      if (attempt === 3) throw e;
    }
  }
  console.log('\n=== 배포 완료 ===');
  console.log('  다음: node scripts/submit-piping-indexnow.mjs --verify-only');
} finally {
  ssh.cleanup();
}
