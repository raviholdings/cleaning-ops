#!/usr/bin/env node
/**
 * 브랜드 사이트의 Cloudflare 캐시를 비운다.
 *
 *   node scripts/purge-brand-cache.mjs --dry-run
 *   node scripts/purge-brand-cache.mjs                 다섯 도메인 · 기본 파일만
 *   node scripts/purge-brand-cache.mjs --site dosa
 *   node scripts/purge-brand-cache.mjs --all           그 존 전체를 비운다
 *
 * 왜 필요한가 — 오리진에 새 파일을 올려도 Cloudflare 가 옛것을 계속 준다.
 * 2026-09-01 배포 직후 dosadosa.kr 의 robots.txt 가 cf-cache HIT 로 옛
 * `Sitemap: /sitemap.xml` 을 내보내고 있었다 (ssac3.kr 은 새것이었다 — 도메인마다
 * 캐시 상태가 달라서 한 곳만 보고 판단하면 안 된다).
 *
 * HTML 은 굳이 비우지 않는다. 사이트맵·robots 는 크롤러가 판단의 근거로 삼는
 * 파일이라 옛것이 남으면 색인 자체가 어긋난다 — 그래서 이것부터 비운다.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const purgeAll = args.includes('--all');
const only = valueOf('--site', '');

/* .env 를 읽는다 — 다른 cloudflare 스크립트와 같은 방식 */
const env = {};
for (const line of readFileSync(join(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const apiKey = process.env.CLOUDFLARE_API_KEY || env.CLOUDFLARE_API_KEY;
const email = process.env.CLOUDFLARE_EMAIL || env.CLOUDFLARE_EMAIL;
if (!apiKey || !email) {
  console.error('CLOUDFLARE_EMAIL · CLOUDFLARE_API_KEY 가 없습니다 (.env).');
  process.exit(1);
}
const auth = { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'content-type': 'application/json' };

const SITES = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((k) => existsSync(join(projectRoot, `apps/brand-static/${k}-template`)))
  .filter((k) => !only || k === only)
  .sort();

let failed = 0;
for (const key of SITES) {
  const site = JSON.parse(readFileSync(join(projectRoot, `data/brands/${key}.json`), 'utf8'));
  const host = site.host;

  /* 자식 사이트맵 이름은 구운 결과에서 읽는다 — 개수가 사이트마다 다르다 */
  const outDir = join(projectRoot, 'tmp/brands', key);
  const kids = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => /-sitemap\d+\.xml$/.test(f))
    : [];
  const files = ['/robots.txt', '/sitemap.xml', '/sitemap_index.xml',
    ...kids.map((f) => `/${f}`)]
    .map((p) => `https://${host}${p}`);

  const zoneRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${host}`, { headers: auth });
  const zoneId = (await zoneRes.json()).result?.[0]?.id;
  if (!zoneId) {
    console.log(`  ${key.padEnd(8)} ${host.padEnd(17)} ✗ 존을 못 찾았습니다`);
    failed += 1;
    continue;
  }

  if (dryRun) {
    console.log(`  ${key.padEnd(8)} ${host.padEnd(17)} ${purgeAll ? '전체 비움' : `${files.length}개 파일`}`);
    continue;
  }

  const body = purgeAll ? { purge_everything: true } : { files };
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST', headers: auth, body: JSON.stringify(body),
  });
  const out = await res.json();
  if (out.success) {
    console.log(`  ${key.padEnd(8)} ${host.padEnd(17)} 비움 ${purgeAll ? '(전체)' : `${files.length}개`}`);
  } else {
    console.log(`  ${key.padEnd(8)} ${host.padEnd(17)} ✗ ${JSON.stringify(out.errors)}`);
    failed += 1;
  }
}

console.log(failed ? `\n✗ ${failed}곳 실패` : '\n✅ 완료');
process.exit(failed ? 1 : 0);
