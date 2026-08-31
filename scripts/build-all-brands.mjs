#!/usr/bin/env node
/**
 * 브랜드 사이트 다섯 개를 한 번에 굽고 검사한다.
 *
 *   node scripts/build-all-brands.mjs            굽고 검사
 *   node scripts/build-all-brands.mjs --check    굽지 않고 검사만
 *   node scripts/build-all-brands.mjs --no-check 굽기만
 *
 * 사이트마다 따로 부르다 보면 일부만 최신인 상태가 생긴다 — 실제로 빌더를 고친 뒤
 * 하나만 다시 굽고 넷을 그대로 둔 적이 있다. 산출물이 서로 다른 코드에서 나오면
 * 검사기가 통과해도 의미가 없다. 그래서 굽기와 검사를 한 명령에 묶는다.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* 사이트 목록은 data/brands/<키>.json 에서 찾는다 — 여섯 번째가 생겨도 손댈 곳이 없다. */
const SITES = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((k) => existsSync(join(projectRoot, `apps/brand-static/${k}-template`)))
  .sort();

const args = process.argv.slice(2);
const skipBuild = args.includes('--check');
const skipCheck = args.includes('--no-check');

const run = (file, rest) => spawnSync(process.execPath, [join(projectRoot, file), ...rest], {
  cwd: projectRoot,
  stdio: 'inherit',
  encoding: 'utf8',
});

if (!SITES.length) {
  console.error('data/brands 에서 사이트를 못 찾았습니다.');
  process.exit(1);
}

console.log(`대상 ${SITES.length}개: ${SITES.join(' · ')}\n`);

if (!skipBuild) {
  for (const key of SITES) {
    const res = run('scripts/build-brand-site.mjs', ['--site', key, ...args.filter((a) => a.startsWith('--host') || a.startsWith('--out'))]);
    if (res.status !== 0) {
      console.error(`\n✗ ${key} 굽기 실패 — 여기서 멈춥니다. 일부만 새 코드로 구워지면 검사가 무의미합니다.`);
      process.exit(res.status || 1);
    }
    console.log('');
  }
}

if (skipCheck) process.exit(0);

const check = run('scripts/check-brand-sites.mjs', SITES);
if (check.status !== 0) process.exit(check.status || 1);

/* 도메인이 아직 없으면 여기서 한 번 더 알린다 — 이 상태로 배포하면 안 된다. */
const tbd = SITES.filter((k) => {
  const j = JSON.parse(readFileSync(join(projectRoot, `data/brands/${k}.json`), 'utf8'));
  return !j.host || j.host === 'TBD.co.kr';
});
if (tbd.length) {
  console.log(`\n⚠ 도메인 미정 ${tbd.length}개: ${tbd.join(' · ')}`);
  console.log('  canonical·사이트맵·og:image 가 TBD.co.kr 를 가리킵니다. 등록 후 다시 구우세요.');
}
