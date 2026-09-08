#!/usr/bin/env node
/**
 * apex 사이트맵 인덱스를 오리진 웹루트에 얹는다.
 *
 *   node scripts/build-apex-sitemap-index.mjs --root amunsa.com
 *   node scripts/deploy-apex-sitemap-index.mjs --root amunsa.com --dry-run
 *   node scripts/deploy-apex-sitemap-index.mjs --root amunsa.com
 *
 * 올리는 것은 사이트맵 파일(+gz)뿐이다. 사이트를 다시 굽지 않는다.
 *   sitemap.xml      색인 (자식은 전부 같은 apex 호스트)
 *   sitemap-N.xml    URL 5만 개씩. 루트당 9개쯤 된다
 *
 * ⛔ 지우지 않는다. tar 로 덮어 얹기만 한다 (deploy 스킬 철칙 8).
 * ⛔ 배포 중 HaiIP 금지 — 직결 SSH 라 IP 가 바뀌면 보안그룹 규칙이 어긋나 끊긴다.
 *
 * ⚠ apex 루트가 심볼릭 링크면 중단한다. 예전에 apex 루트가 서브도메인 디렉토리로
 *   걸려 있어서, 거기에 풀면 그 서브도메인 사이트를 덮어쓸 뻔했다 (2026-08-27).
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
const onlyRoot = valueOf('--root');
const stageDir = resolve(projectRoot, valueOf('--stage', 'tmp/apex-sitemaps'));
const REMOTE_ROOT = '/srv/group-page-origin/sites';

const BSLASH = String.fromCharCode(92);
const q = (v) => `'${String(v).split("'").join(`'${BSLASH}''`)}'`;
const toPosix = (p) => p.split(BSLASH).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

if (!existsSync(stageDir)) throw new Error(`스테이징이 없다: ${stageDir} — build-apex-sitemap-index.mjs 를 먼저 돌릴 것`);
let roots = readdirSync(stageDir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
if (onlyRoot) roots = roots.filter((r) => r === onlyRoot);
if (!roots.length) throw new Error(onlyRoot ? `${stageDir} 에 ${onlyRoot} 가 없다.` : `${stageDir} 가 비었다.`);

// 색인과 그 자식(sitemap-N.xml)이 짝을 이뤄야 한다. 자식이 빠진 색인을 올리면
// 구글이 404 를 그대로 본다.
for (const root of roots) {
  const files = readdirSync(resolve(stageDir, root));
  if (!files.includes('sitemap.xml') || !files.includes('sitemap.xml.gz')) {
    throw new Error(`${root}: sitemap.xml 이 없다.`);
  }
  const children = files.filter((f) => /^sitemap-\d+\.xml$/.test(f));
  if (!children.length) throw new Error(`${root}: 자식 사이트맵(sitemap-N.xml)이 없다.`);
  const missingGz = children.filter((f) => !files.includes(`${f}.gz`));
  if (missingGz.length) throw new Error(`${root}: .gz 가 빠졌다 — ${missingGz.join(', ')}`);
  const index = readFileSync(resolve(stageDir, root, 'sitemap.xml'), 'utf8');
  const referenced = [...index.matchAll(/<loc>[^<]*\/([^/<]+)<\/loc>/g)].map((m) => m[1]);
  const dangling = referenced.filter((f) => !files.includes(f));
  if (dangling.length) throw new Error(`${root}: 색인이 없는 파일을 가리킨다 — ${dangling.join(', ')}`);
}

console.log(`=== apex 사이트맵 배포 (${roots.length}개 루트 · ${mode}${dryRun ? ' · dry-run' : ''}) ===`);
for (const root of roots) {
  const idx = readdirSync(resolve(stageDir, root));
  console.log(`  ${root.padEnd(20)} 파일 ${idx.length}개`);
}

if (dryRun) {
  console.log(`\n[dry-run] 원격: cd ${REMOTE_ROOT} && tar -xz  (루트당 6파일)`);
  process.exit(0);
}

const ssh = await prepareOriginSsh({ mode });
process.on('exit', ssh.cleanup);
process.on('SIGINT', () => { ssh.cleanup(); process.exit(130); });
try {
  // 심볼릭 링크면 그 대상 디렉토리를 덮어쓰게 된다. 먼저 확인하고 있으면 멈춘다.
  const checkScript = roots.map((r) =>
    `if [ -L ${q(`${REMOTE_ROOT}/${r}`)} ]; then echo "SYMLINK ${r} -> $(readlink ${q(`${REMOTE_ROOT}/${r}`)})"; fi`).join('; ');
  const checked = execSync(`${ssh.sshCommand} ${q(checkScript)}`, { shell: 'bash', encoding: 'utf8' }).trim();
  if (checked) {
    console.log(`\n⛔ apex 루트가 심볼릭 링크입니다 — 중단합니다:\n${checked}`);
    process.exit(1);
  }
  console.log('  심볼릭 링크 없음 ✅');

  const listPath = resolve(stageDir, '.deploy-files');
  writeFileSync(listPath, `${roots.map((r) => `./${r}`).join('\n')}\n`, 'utf8');

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
  for (const root of roots) console.log(`  https://${root}/sitemap.xml`);
} finally {
  ssh.cleanup();
}
