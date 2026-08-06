#!/usr/bin/env node
/**
 * naver_project_domains 를 읽어 사이트를 하나씩 빌드하고 오리진에 올린다.
 *
 * 사이트 순번(PUBLIC_SITE_INDEX)은 source_payload.globalSiteOrder - 1 이다.
 * site.mjs 의 siteIndexFor 와 같은 규칙이어야 DB 카탈로그와 실제 HTML 이 맞는다.
 *
 * 전송은 사이트마다 ssh 를 새로 여는 대신, 전부 빌드한 뒤 한 번에 tar 로 보낸다.
 * SSM 터널은 연결 수립이 느려서 1,000번 열면 그것만으로 수십 분이 걸린다.
 *
 *   node scripts/build-and-deploy-sites.mjs --limit 5 --no-deploy   # 빌드만
 *   node scripts/build-and-deploy-sites.mjs                          # 전체 빌드 + 배포
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

// Astro 의 build() 를 한 프로세스에서 수천 번 부르면 호출마다 모듈 그래프가 쌓여
// 기본 힙(이 PC 기준 약 4.2GB)을 넘긴다. 2,000개를 돌리다 1,000개 지점에서
// "JavaScript heap out of memory" 로 죽었다(2026-08-06).
// PC 메모리는 128GB 라 남아돈다. 힙 상한만 올려 스스로를 다시 띄운다.
const HEAP_MB = Number(process.env.DEPLOY_HEAP_MB || 16384);
if (!process.env.DEPLOY_HEAP_APPLIED) {
  const currentMb = getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (currentMb < HEAP_MB * 0.9) {
    const relaunch = spawnSync(
      process.execPath,
      [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, DEPLOY_HEAP_APPLIED: '1' } },
    );
    process.exit(relaunch.status ?? 1);
  }
}

const options = parseOptions(process.argv.slice(2));
const limit = options.limit ? Number(options.limit) : null;
const deploy = !options.noDeploy;
const groupKey = options.groupKey || 'cleaning-ravi';
const appDir = resolve(projectRoot, 'apps/cleaning-ravi');
// 스테이지는 반드시 앱 디렉터리 안이어야 한다. Astro 가 빌드 중간 청크를 outDir 에
// 쏟아놓고 그걸 다시 import 하는데, 앱 밖이면 node_modules 를 못 찾아 실패한다.
const stageDir = resolve(appDir, options.stageDir || 'tmp/site-builds');

const REMOTE_ROOT = '/srv/group-page-origin/sites';
const INSTANCE = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';
const SSH_KEY = process.env.ORIGIN_SSH_KEY || '/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem';
const AWS_PROFILE = process.env.AWS_PROFILE || 'cleaning-ops';
const AWS_REGION = process.env.AWS_DEFAULT_REGION || 'ap-northeast-2';

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

let domains;
try {
  const result = await client.query(
    `select id, host, site_url, page_count, naver_verification_token,
            (source_payload->>'globalSiteOrder')::int as global_site_order
       from public.naver_project_domains
      where group_key = $1 and deployment_status = 'active' and is_visible = true
      order by (source_payload->>'globalSiteOrder')::int
      ${limit ? 'limit ' + Number(limit) : ''}`,
    [groupKey],
  );
  domains = result.rows;
} finally {
  await client.end();
}
if (!domains.length) throw new Error('배포할 도메인이 없습니다.');

for (const domain of domains) {
  if (!Number.isSafeInteger(domain.global_site_order) || domain.global_site_order < 1) {
    throw new Error(`${domain.host}: globalSiteOrder 가 없습니다.`);
  }
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

console.log(JSON.stringify({ phase: 'start', domains: domains.length, deploy, stageDir }));

/**
 * 한 프로세스 안에서 Astro API 를 반복 호출한다.
 *
 * 사이트마다 `astro build` 프로세스를 새로 띄우면 기동에만 2초씩 들고,
 * 동시에 띄우면 apps/cleaning-ravi/.astro 캐시를 서로 덮어써서 깨진다.
 * API 로 순차 호출하면 두 문제가 다 없어지고 사이트당 0.5초로 떨어진다.
 *
 * PUBLIC_* 는 build() 를 부를 때마다 Vite 가 process.env 에서 다시 읽으므로
 * 호출 전에 값을 바꿔주면 사이트별로 다른 결과가 나온다.
 */
const appRequire = createRequire(resolve(appDir, 'package.json'));
const { build } = await import(pathToFileURL(appRequire.resolve('astro')).href);

const startedAt = Date.now();
let built = 0;

for (const domain of domains) {
  process.env.PUBLIC_SITE_URL = domain.site_url;
  process.env.PUBLIC_SITE_INDEX = String(domain.global_site_order - 1);
  process.env.PUBLIC_PAGE_COUNT = String(domain.page_count);
  // 소유확인 태그. 아직 없으면 빈 값이라 meta 가 안 나간다.
  process.env.PUBLIC_NAVER_SITE_VERIFICATION = domain.naver_verification_token || '';
  process.env.ASTRO_DIST_DIR = resolve(stageDir, domain.host);

  await build({ root: appDir, logLevel: 'error' });

  built += 1;
  if (built % 50 === 0 || built === domains.length) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = built / elapsed;
    console.log(JSON.stringify({
      phase: 'build',
      built,
      total: domains.length,
      elapsedSec: Math.round(elapsed),
      sitesPerSec: Number(rate.toFixed(2)),
      etaSec: Math.round((domains.length - built) / rate),
    }));
  }
}

console.log(JSON.stringify({
  phase: 'built',
  sites: built,
  buildSec: Math.round((Date.now() - startedAt) / 1000),
}));

if (!deploy) {
  console.log(JSON.stringify({ phase: 'skipped-deploy', stageDir }));
  process.exit(0);
}

// 스테이지 전체를 한 번의 tar 스트림으로 보낸다.
const hostList = domains.map((domain) => domain.host).join('\n');
const hostFile = resolve(stageDir, '.hosts');
writeFileSync(hostFile, `${hostList}\n`);

const sshBase = [
  'ssh', '-o', 'StrictHostKeyChecking=no', '-i', SSH_KEY,
  '-o', `ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region ${AWS_REGION} --profile ${AWS_PROFILE}`,
  `ec2-user@${INSTANCE}`,
].map(shellQuote).join(' ');

const remoteScript = [
  `mkdir -p ${REMOTE_ROOT}`,
  `cd ${REMOTE_ROOT}`,
  `tar -xz --exclude='.hosts'`,
  `echo "deployed=$(ls | wc -l) size=$(du -sh . | cut -f1)"`,
].join(' && ');

const transferStart = Date.now();
execSync(
  `tar -cz -C ${shellQuote(toPosix(stageDir))} --exclude='.hosts' . | ${sshBase} ${shellQuote(remoteScript)}`,
  { shell: 'bash', stdio: 'inherit' },
);
// 전송이 끝난 지금이 이 사이트들의 배포 시각이다. 레거시 배포 스크립트들
// (deploy-dabom-shared-ec2.mjs 등)도 같은 자리에서 deployed_at = now() 를 찍는다.
// 이게 없으면 배포를 해도 DB 상 배포일이 영영 갱신되지 않아 일자별 추이를 못 그린다.
const deployedCount = await markDeployed(domains.map((domain) => domain.id));

console.log(JSON.stringify({
  phase: 'deployed',
  sites: built,
  deployedAtUpdated: deployedCount,
  transferSec: Math.round((Date.now() - transferStart) / 1000),
  totalSec: Math.round((Date.now() - startedAt) / 1000),
}));

async function markDeployed(ids) {
  if (!ids.length) return 0;
  // 위쪽 클라이언트는 도메인 조회 직후 닫혀 있으므로 여기서 새로 연다.
  const writer = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await writer.connect();
  try {
    const result = await writer.query(
      `update public.naver_project_domains
          set deployed_at = now(), updated_at = now()
        where id = any($1::bigint[])`,
      [ids],
    );
    return result.rowCount;
  } catch (error) {
    // 배포 자체는 이미 성공했으니 기록 실패로 스크립트를 죽이지는 않는다.
    console.error(`deployed_at 기록 실패: ${error.message}`);
    return 0;
  } finally {
    await writer.end();
  }
}

function toPosix(path) {
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { result[key] = next; index += 1; } else { result[key] = true; }
  }
  return result;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
