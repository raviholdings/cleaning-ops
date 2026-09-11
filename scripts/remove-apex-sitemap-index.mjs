#!/usr/bin/env node
/**
 * apex 사이트맵 인덱스를 걷어낸다 (build/deploy-apex-sitemap-index.mjs 의 되돌리기).
 *
 *   node scripts/remove-apex-sitemap-index.mjs --dry-run
 *   node scripts/remove-apex-sitemap-index.mjs
 *
 * 지우는 것 — 루트마다 **이름을 하나씩 지정한** 파일만 지운다. 와일드카드 rm 을
 * 쓰지 않는다 (웹루트에서 글로브 삭제는 사고가 크다).
 *   sitemap-1.xml ~ sitemap-9.xml (+ .gz)
 *   sitemap-hosts.xml · sitemap-pages.xml (+ .gz)   ← 더 옛 구조의 잔재
 *
 * 지우지 않는 것
 *   sitemap.xml — robots.txt 의 Sitemap 지시자가 이 주소를 가리킨다. 지우면 그
 *   지시자가 404 를 가리키게 되고 GSC 는 "가져올 수 없음" 으로 읽는다. 대신
 *   build-apex-site.mjs 가 굽는 원래 내용(apex 자기 페이지 1~2장)으로 되돌린다.
 *   그 되돌리기는 --restore-stage 의 산출물을 얹어서 한다.
 *
 * 배경: 서브도메인 433,001 URL 을 루트마다 한 번에 내보내는 게 부자연스럽다는
 * 운영자 판단 (2026-09-10). 파일만 걷어내고 스크립트는 남겨 둔다 — 다시 올릴 때는
 * build-apex-sitemap-index.mjs + deploy-apex-sitemap-index.mjs 를 그대로 쓰면 된다.
 *
 * ⛔ 배포 중 HaiIP 금지 — 직결 SSH 라 IP 가 바뀌면 끊긴다.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
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
const onlyRoot = valueOf('--root');
const restoreStage = resolve(projectRoot, valueOf('--restore-stage', 'tmp/apex-dist'));
const REMOTE_ROOT = '/srv/group-page-origin/sites';

const BSLASH = String.fromCharCode(92);
const q = (v) => `'${String(v).split("'").join(`'${BSLASH}''`)}'`;
const toPosix = (p) => p.split(BSLASH).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

const ROOTS = ['amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com'];
const roots = onlyRoot ? ROOTS.filter((r) => r === onlyRoot) : ROOTS;
if (!roots.length) throw new Error(`${onlyRoot} 는 대상이 아니다.`);

/** 지울 파일 이름. 글로브가 아니라 명시 목록이다. */
const NAMES = [
  ...Array.from({ length: 9 }, (_, i) => `sitemap-${i + 1}.xml`),
  'sitemap-hosts.xml', 'sitemap-pages.xml',
].flatMap((n) => [n, `${n}.gz`]);

console.log(`=== apex 사이트맵 인덱스 제거 (${roots.length}개 루트${dryRun ? ' · dry-run' : ''}) ===`);
console.log(`  루트마다 지울 이름 ${NAMES.length}개 (없으면 건너뜀)`);
console.log(`  sitemap.xml 은 지우지 않고 ${restoreStage} 의 원본으로 되돌린다\n`);

if (!existsSync(restoreStage)) {
  throw new Error(`되돌릴 산출물이 없다: ${restoreStage} — build-apex-site.mjs --all --out-base tmp/apex-dist 를 먼저 돌릴 것`);
}
for (const r of roots) {
  const p = resolve(restoreStage, r, 'sitemap.xml');
  if (!existsSync(p)) throw new Error(`${r}: ${p} 가 없다. 되돌릴 원본이 없으면 진행하지 않는다.`);
}

const ssh = await prepareOriginSsh({ mode });
process.on('exit', ssh.cleanup);
process.on('SIGINT', () => { ssh.cleanup(); process.exit(130); });
/*
 * 원격 명령은 인자로 넘기지 않고 stdin 으로 흘린다.
 * 루트 9개 × 이름 22개를 인자로 만들면 중첩 인용이 깨진다 (2026-09-10 실패).
 */
const runRemote = (lines) => {
  const shPath = resolve(projectRoot, 'tmp/.apex-sitemap-remote.sh');
  writeFileSync(shPath, `set -e\n${lines.join('\n')}\n`, 'utf8');
  return execSync(`cat ${q(toPosix(shPath))} | ${ssh.sshCommand} ${q('bash -s')}`,
    { shell: 'bash', encoding: 'utf8' });
};

try {
  // 무엇이 실제로 있는지 먼저 센다. 지우기 전과 후를 비교하기 위해서다.
  const countLines = roots.map((r) =>
    `printf '%-20s ' '${r}'; ls -1 ${NAMES.map((n) => `'${REMOTE_ROOT}/${r}/${n}'`).join(' ')} 2>/dev/null | wc -l`);
  console.log('-- 지우기 전 --');
  console.log(runRemote(countLines).trimEnd());

  if (dryRun) {
    console.log(`\n[dry-run] 지울 명령 예시:\n  rm -f ${REMOTE_ROOT}/${roots[0]}/sitemap-1.xml ... (루트당 ${NAMES.length}개 이름)`);
    console.log(`[dry-run] 그 뒤 sitemap.xml(+gz)을 ${restoreStage} 에서 덮어 얹는다.`);
    process.exit(0);
  }

  runRemote(roots.map((r) =>
    `rm -f ${NAMES.map((n) => `'${REMOTE_ROOT}/${r}/${n}'`).join(' ')}`));
  console.log('-- 삭제 완료 --');

  // sitemap.xml 되돌리기 — 루트별로 그 파일만 담아 보낸다.
  const listPath = resolve(restoreStage, '.restore-files');
  writeFileSync(listPath, `${roots.flatMap((r) => [`./${r}/sitemap.xml`, `./${r}/sitemap.xml.gz`]).join('\n')}\n`, 'utf8');
  const remote = [`cd ${REMOTE_ROOT}`, 'tar -xz'].join(' && ');
  execSync('set -o pipefail; '
    + `tar -cz -C ${q(toPosix(restoreStage))} -T ${q(toPosix(listPath))} | ${ssh.sshCommand} ${q(remote)}`,
  { shell: 'bash', stdio: 'inherit' });
  console.log('-- sitemap.xml 되돌림 --');

  console.log('\n-- 지운 뒤 --');
  console.log(runRemote(countLines).trimEnd());
} finally {
  ssh.cleanup();
}
