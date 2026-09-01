#!/usr/bin/env node
/**
 * 브랜드 사이트를 EC2 오리진에 올린다.
 *
 *   node scripts/deploy-brand-sites.mjs --dry-run              무엇이 나갈지만 본다
 *   node scripts/deploy-brand-sites.mjs --site thunder         한 곳만
 *   node scripts/deploy-brand-sites.mjs                        다섯 다
 *
 * 대량배포(deploy-piping-sites)와 달리 대상이 다섯 개 고정이라 훨씬 단순하다.
 * DB 를 보지 않고 data/brands/<키>.json 의 host 를 그대로 쓴다.
 *
 * 오리진은 `server_name _` + `root .../sites/$host` 라 nginx 를 안 고쳐도 된다.
 * 폴더만 올리면 그 도메인이 뜬다 (docs/ORIGIN-NGINX-MAP.md).
 *
 * HTML 은 .html.gz 로 바꿔 올린다 — `gzip_static always` + `gunzip on` 이라
 * 압축본만 있어도 되고, gzip 을 못 받는 클라이언트에는 nginx 가 풀어서 준다.
 * 이미지·CSS·JS 는 그대로 둔다 (webp/png 는 다시 압축해도 안 줄고 CPU 만 쓴다).
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE_ROOT = '/srv/group-page-origin/sites';

const args = process.argv.slice(2);
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const only = valueOf('--site', '');
const useSsm = args.includes('--ssm');

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const toPosix = (p) => p.split(sep).join('/');

/* 대상. --site 를 주면 그 하나만. */
const SITES = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((k) => existsSync(join(projectRoot, `apps/brand-static/${k}-template`)))
  .filter((k) => !only || k === only)
  .sort();

if (!SITES.length) {
  console.error(only ? `그런 사이트가 없습니다: ${only}` : 'data/brands 에서 사이트를 못 찾았습니다.');
  process.exit(1);
}

/*
 * 스테이지를 따로 만든다. tmp/brands 를 그대로 보내면 .html 과 .html.gz 가
 * 둘 다 올라가 디스크를 두 배로 먹는다.
 */
const stageRoot = resolve(projectRoot, 'tmp/brand-deploy');
if (existsSync(stageRoot)) rmSync(stageRoot, { recursive: true, force: true });

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const plan = [];
for (const key of SITES) {
  const site = JSON.parse(readFileSync(join(projectRoot, `data/brands/${key}.json`), 'utf8'));
  const host = site.host;
  if (!host || host === 'TBD.co.kr') {
    console.error(`[${key}] host 가 아직 TBD 입니다. 굽기부터 다시 하세요.`);
    process.exit(1);
  }
  const src = resolve(projectRoot, 'tmp/brands', key);
  if (!existsSync(src)) {
    console.error(`[${key}] 구운 결과가 없습니다: ${src} — npm run brands:build 먼저`);
    process.exit(1);
  }
  const dst = join(stageRoot, host);
  let html = 0; let raw = 0; let bytesIn = 0; let bytesOut = 0;

  for (const f of walk(src)) {
    const rel = relative(src, f);
    const target = join(dst, rel);
    mkdirSync(dirname(target), { recursive: true });
    const buf = readFileSync(f);
    bytesIn += buf.length;
    if (f.endsWith('.html')) {
      /*
       * .html 과 .html.gz 를 둘 다 올린다.
       *
       * .gz 만 올렸더니 홈만 뜨고 하위가 전부 403 이었다 (2026-09-01).
       * `index index.html` 은 실제 index.html 파일이 있어야 내부 리다이렉트를 하고,
       * gzip_static 은 그 단계에서 도와주지 않는다. 홈이 뜬 건 `rewrite ^/$ /index.html`
       * 규칙이 따로 있어서였다. 기존 대량배포는 /123.html 평면이라 이 문제가 없다.
       *
       * 둘 다 두면 index 가 .html 을 찾고, gzip_static always 가 gzip 받는
       * 클라이언트에는 .gz 를 준다. nginx 를 더 고치지 않아도 된다.
       */
      copyFileSync(f, target);
      const gz = gzipSync(buf, { level: 9 });
      writeFileSync(`${target}.gz`, gz);
      html += 1; bytesOut += buf.length + gz.length;
    } else {
      copyFileSync(f, target);
      raw += 1; bytesOut += buf.length;
    }
  }

  /*
   * /favicon.ico — 브라우저가 관례적으로 찾는 자리. 2026-09-01 에 nginx 를 고쳐
   * 사이트 폴더를 먼저 보게 했으므로, 여기 놓으면 브랜드 아이콘이 나간다.
   * 없으면 대량배포와 같은 공용 아이콘이 나간다.
   */
  const ico = join(projectRoot, `apps/brand-static/${key}-template/assets/img/favicon.ico`);
  if (existsSync(ico)) {
    copyFileSync(ico, join(dst, 'favicon.ico'));
    raw += 1;
  }

  plan.push({
    key, host, dst, html, raw, bytesIn, bytesOut,
    files: html + raw,
  });
}

const mb = (n) => (n / 1048576).toFixed(1);
console.log('보낼 것');
for (const p of plan) {
  console.log(`  ${p.key.padEnd(8)} ${p.host.padEnd(18)} 파일 ${String(p.files).padStart(5)}개 `
    + `· HTML ${p.html} → .gz · ${mb(p.bytesIn)}MB → ${mb(p.bytesOut)}MB`);
}
console.log(`  합계 ${mb(plan.reduce((a, p) => a + p.bytesOut, 0))}MB → ${REMOTE_ROOT}/<도메인>/`);

if (dryRun) {
  console.log('\n--dry-run 이라 여기서 멈춥니다. 스테이지는 tmp/brand-deploy 에 있습니다.');
  process.exit(0);
}

/* 보안그룹 22/tcp 를 내 IP 로만 열고, 끝나면 닫는다 (exit 훅). */
const origin = await prepareOriginSsh({ mode: useSsm ? 'ssm' : 'direct' });
console.log(`\nssh: ${origin.mode} · 내 IP ${origin.myIp || '-'} · 오리진 ${origin.originIp || '-'}`);

let failed = 0;
for (const p of plan) {
  /*
   * --delete 대신 지우고 새로 푼다. 슬러그가 바뀌면 옛 페이지가 남아
   * 사이트맵에 없는 유령이 쌓인다 (굽기에서 겪은 것과 같은 문제).
   */
  const remote = [
    `rm -rf ${REMOTE_ROOT}/${p.host}`,
    `mkdir -p ${REMOTE_ROOT}/${p.host}`,
    `cd ${REMOTE_ROOT}/${p.host}`,
    'tar -xz',
  ].join(' && ');
  const cmd = 'set -o pipefail; '
    + `tar -cz -C ${shellQuote(toPosix(p.dst))} .`
    + ` | ${origin.sshCommand} ${shellQuote(remote)}`;

  const t0 = Date.now();
  let sent = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execSync(cmd, { shell: 'bash', stdio: 'inherit' });
      sent = true;
      break;
    } catch (e) {
      console.log(`  ${p.key} 전송 실패 ${attempt}/3: ${String(e.message).split('\n')[0].slice(0, 120)}`);
      if (attempt < 3) execSync('sleep 15', { shell: 'bash' });
    }
  }
  if (!sent) { failed += 1; continue; }
  console.log(`  ${p.key.padEnd(8)} ${p.host.padEnd(18)} 완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
}

if (typeof origin.cleanup === 'function') origin.cleanup();
console.log(failed ? `\n✗ ${failed}곳 실패` : '\n✅ 전부 올렸습니다');
process.exit(failed ? 1 : 0);
