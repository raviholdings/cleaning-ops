/**
 * apex(루트 도메인) 홈페이지 10개를 오리진 웹루트에 올린다.
 *
 *   node scripts/build-apex-site.mjs --all --out-base tmp/apex-dist
 *   node scripts/deploy-apex-sites.mjs --dry-run
 *   node scripts/deploy-apex-sites.mjs
 *
 * 청소·이사·배관 서브도메인과 달리 양이 아주 작아서(10사이트 · 약 500KB)
 * 덩어리·재개 없이 한 번에 보낸다. 전송은 직결 SSH 가 기본이고 --ssm 이 폴백이다.
 *
 * ⚠ 심볼릭 링크
 * 루트 몇 개는 서브도메인 디렉토리로 가는 심볼릭 링크로 되어 있다.
 * 그대로 두고 tar 를 풀면 링크를 따라가 **서브도메인 사이트를 덮는다.**
 * 그래서 전송 전에 링크만 지운다(-L 로 확인 후 rm -f, 대상 디렉토리는 그대로).
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const dryRun = args.includes('--dry-run');
const mode = args.includes('--ssm') ? 'ssm' : 'direct';
const stageDir = resolve(projectRoot, valueOf('--from', 'tmp/apex-dist'));
const REMOTE_ROOT = '/srv/group-page-origin/sites';

// 백슬래시 리터럴은 heredoc 을 거치면 먹히므로 코드포인트로 만든다 (docs/APEX-HANDOVER.md 함정 14).
const BSLASH = String.fromCharCode(92);
// 작은따옴표로 감싸고, 안쪽 작은따옴표는 '\'' 로 끊어 붙인다.
const q = (v) => `'${String(v).split("'").join(`'${BSLASH}''`)}'`;
const toPosix = (p) => p.split(BSLASH).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

if (!existsSync(stageDir)) throw new Error(`빌드 산출물이 없다: ${stageDir}`);
const roots = readdirSync(stageDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
if (!roots.length) throw new Error(`${stageDir} 안에 사이트가 없다.`);

for (const r of roots) {
  if (!existsSync(resolve(stageDir, r, 'index.html'))) throw new Error(`${r}/index.html 이 없다.`);
}
console.log(`=== apex 배포 (${roots.length}개 · ${mode}${dryRun ? ' · dry-run' : ''}) ===`);
roots.forEach((r) => {
  const files = execSync(`find ${q(toPosix(resolve(stageDir, r)))} -type f | wc -l`, { shell: 'bash' }).toString().trim();
  console.log(`  ${r.padEnd(20)} ${files} 파일`);
});

// 링크만 지운다. 대상 디렉토리(서브도메인 사이트)는 건드리지 않는다.
const unlinkScript = roots.map((r) =>
  `if [ -L ${q(`${REMOTE_ROOT}/${r}`)} ]; then echo "unlink ${r} -> $(readlink ${q(`${REMOTE_ROOT}/${r}`)})"; rm -f ${q(`${REMOTE_ROOT}/${r}`)}; fi`,
).join('; ');

if (dryRun) {
  console.log('\n[dry-run] 원격에서 실행될 것:');
  console.log(`  ${unlinkScript.slice(0, 200)}…`);
  console.log(`  mkdir -p ${REMOTE_ROOT} && cd ${REMOTE_ROOT} && tar -xz`);
  process.exit(0);
}

const ssh = await prepareOriginSsh({ mode });
process.on('exit', ssh.cleanup);
process.on('SIGINT', () => { ssh.cleanup(); process.exit(130); });
try {
  console.log(`\n-- 심볼릭 링크 정리 --`);
  execSync(`${ssh.sshCommand} ${q(unlinkScript)}`, { shell: 'bash', stdio: 'inherit' });

  const listPath = resolve(stageDir, '.apex-files');
  writeFileSync(listPath, `${roots.map((r) => `./${r}`).join('\n')}\n`, 'utf8');

  console.log(`-- 전송 --`);
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
} finally {
  ssh.cleanup();
}
