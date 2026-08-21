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
 *   node scripts/build-and-deploy-sites.mjs --renderer static        # Astro 없이 빌드
 *
 * --renderer static 은 Astro 대신 scripts/lib/static-site-renderer.mjs 를 쓴다.
 * 같은 데이터 모듈(pageCatalog / pageMeta / content)을 그대로 읽으므로 결과가
 * 같아야 하고, scripts/compare-static-render.mjs 로 대조해 확인한다.
 * 실측(2026-08-07): Astro 1.91 사이트/초 -> 12.2 사이트/초, 힙 16GB 불필요.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import pg from 'pg';

import { prepareOriginSsh } from './lib/origin-ssh.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

// Astro 의 build() 를 한 프로세스에서 수천 번 부르면 호출마다 모듈 그래프가 쌓여
// 기본 힙(이 PC 기준 약 4.2GB)을 넘긴다. 2,000개를 돌리다 1,000개 지점에서
// "JavaScript heap out of memory" 로 죽었다(2026-08-06).
// PC 메모리는 128GB 라 남아돈다. 힙 상한만 올려 스스로를 다시 띄운다.
//
// static 렌더러는 모듈 그래프를 쌓지 않아 이 재기동이 필요 없다.
const useStaticRenderer = process.argv.includes('--renderer')
  && process.argv[process.argv.indexOf('--renderer') + 1] === 'static';

const HEAP_MB = Number(process.env.DEPLOY_HEAP_MB || 16384);
if (!useStaticRenderer && !process.env.DEPLOY_HEAP_APPLIED) {
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
// 계정 범위를 좁힌다. 이미 배포·소유확인이 끝난 사이트를 다시 올리면 빌드 시간이
// 배로 들고, 멀쩡히 도는 것을 건드릴 이유도 없다. 기본은 전체.
//   node scripts/build-and-deploy-sites.mjs --from-order 15 --to-order 20
const fromOrder = Number(options.fromOrder || 1);
const toOrder = Number(options.toOrder || 9999);
const deploy = !options.noDeploy;
// 오타로 astro 를 계속 쓰는 사고를 막는다. 지정했으면 둘 중 하나여야 한다.
if (options.renderer !== undefined && !['astro', 'static'].includes(options.renderer)) {
  throw new Error(`--renderer 는 astro 또는 static 이어야 합니다: ${options.renderer}`);
}
// --extend merged 를 주면 새 디자인(templates-merged)이 쓰는 places/gallery 를
// 페이지 데이터에 얹는다. 안 주면 기존 템플릿 동작 그대로다.
//   node scripts/build-and-deploy-sites.mjs --renderer static --templates templates-merged --extend merged
if (options.extend !== undefined && options.extend !== 'merged') {
  throw new Error(`--extend 는 merged 만 지원합니다: ${options.extend}`);
}
const useMergedExtension = options.extend === 'merged';
if (useMergedExtension && !useStaticRenderer) {
  throw new Error('--extend merged 는 --renderer static 과 함께 써야 합니다.');
}
const groupKey = options.groupKey || 'cleaning-ravi';

/*
 * --gzip     : .html 대신 .html.gz 만 만든다. 서버에 gzip_static·gunzip 설정이
 *              먼저 들어가 있어야 한다. 없으면 nginx 가 원본을 못 찾아 404 다.
 * --no-feeds : sitemap.xml / rss.xml / robots.txt 를 다시 만들지 않는다.
 *              내용이 같은데 다시 쓰면 sitemap 의 <lastmod> 만 배포일로 바뀌어,
 *              100만 URL 의 수정일이 하루에 몰린다. 서버 파일이 그대로 남는다.
 */
const gzipHtml = Boolean(options.gzip);
const writeFeeds = !options.noFeeds;
if (gzipHtml && !useStaticRenderer) {
  throw new Error('--gzip 은 --renderer static 과 함께 써야 합니다.');
}

/*
 * 어느 앱의 lib 를 쓸지.
 *
 * 여기에는 pageCatalog·pageMeta·keywords 가 들어 있어서, 이 값이 곧
 * "어느 사업의 페이지를 굽느냐" 가 된다. 청소는 apps/cleaning-ravi,
 * 이사는 apps/moving-ravi 다.
 *
 * 기본값을 종전 값으로 둔다. 청소 명령은 한 글자도 바꿀 필요가 없다.
 */
const appDir = resolve(projectRoot, options.app || 'apps/cleaning-ravi');
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
    `select d.id, d.host, d.site_url, d.page_count, d.naver_verification_token,
            (d.source_payload->>'globalSiteOrder')::int as global_site_order
       from public.naver_project_domains d
       join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where d.group_key = $1 and d.deployment_status = 'active' and d.is_visible = true
        and a.account_order between $2 and $3
      order by (d.source_payload->>'globalSiteOrder')::int
      ${limit ? 'limit ' + Number(limit) : ''}`,
    [groupKey, fromOrder, toOrder],
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

/*
 * 같은 스테이지 폴더를 두 프로세스가 쓰면 안 된다.
 *
 * 2026-08-11 에 run-pc-chain.ps1 의 전체 배포와 수동 구간 배포가 겹쳤다.
 * 한쪽이 폴더를 지우고 다시 빌드하는 동안 다른 쪽 tar 가 그 폴더를 읽어서
 * "File removed before we read it" 로 깨졌고, 결국 둘 다 못 쓰게 됐다.
 */
const lockPath = resolve(stageDir, '..', '.deploy.lock');
if (existsSync(lockPath)) {
  const holder = readFileSync(lockPath, 'utf8').trim();
  const pid = Number(holder.split(/\s+/)[0]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) {
    throw new Error(`다른 배포가 실행 중입니다 (${holder}). 끝난 뒤 다시 실행하세요.`);
  }
  console.log(JSON.stringify({ phase: 'lock', note: '죽은 잠금 해제', holder }));
}
mkdirSync(resolve(stageDir, '..'), { recursive: true });
writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
const releaseLock = () => { try { rmSync(lockPath, { force: true }); } catch { /* 이미 없음 */ } };
process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { releaseLock(); process.exit(130); });
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
let buildOne;

if (useStaticRenderer) {
  const renderer = await import(pathToFileURL(resolve(projectRoot, 'scripts/lib/static-site-renderer.mjs')).href);
  const locations = renderer.loadLocations();
  // --templates 로 디자인 세트를 고른다. 기본은 templates.
  //   templates       Astro 앱과 같은 마크업 (대조 검사가 통과하는 기준선)
  //   templates-test  test.html 디자인
  const templateDir = resolve(projectRoot, 'apps/cleaning-static', options.templates || 'templates');
  const templates = renderer.loadTemplates(templateDir);
  console.log(JSON.stringify({ phase: 'renderer', kind: 'static', templates: templates.dir, css: templates.cssPath }));

  // 새 디자인이 쓰는 places/gallery 는 렌더러가 모른다. 훅으로 얹는다.
  let extendPage = null;
  let extendIndex = null;
  if (useMergedExtension) {
    const appLib = resolve(appDir, 'src/lib');
    const merged = await import(pathToFileURL(resolve(projectRoot, 'scripts/lib/merged-page-data.mjs')).href);
    const { catalogEntry } = await import(pathToFileURL(resolve(appLib, 'pageCatalog.ts')).href);
    const { normalizeLocation, pickFaqs, pickReviews, pickNearbyLocations, buildTitle, buildDescription, relatedKeywords } = await import(pathToFileURL(resolve(appLib, 'pageMeta.ts')).href);
    const { subKeywordsFor, MAIN_KEYWORDS } = await import(pathToFileURL(resolve(appLib, 'keywords.ts')).href);

    extendPage = (data) => merged.extendPageData(data, { mainKeywords: MAIN_KEYWORDS });
    extendIndex = (data, ctx) => merged.extendIndexData(data, {
      catalogEntry,
      locations: ctx.locations,
      siteIndex: ctx.siteIndex,
      pageCount: ctx.pageCount,
      normalizeLocation,
      pickFaqs,
      pickReviews,
      subKeywordsFor,
      pickNearbyLocations,
      mainKeywords: MAIN_KEYWORDS,
      buildTitle,
      buildDescription,
      // 홈 해시태그(kw-row)용. buildIndexData 는 related 를 안 만든다.
      relatedKeywords,
    });
    console.log(JSON.stringify({
      phase: 'renderer',
      extend: 'merged',
      // 기본은 사이트의 루트 도메인에서 자동으로 뽑는다 (https://assets.<루트>).
      // PUBLIC_ASSET_BASE_URL 을 주면 전 사이트가 그 값을 쓴다 (테스트용).
      assetBase: process.env.PUBLIC_ASSET_BASE_URL || '사이트 루트별 assets.<루트> 자동',
    }));
  }

  buildOne = (domain) => {
    renderer.renderSite({
      templates,
      locations,
      outDir: resolve(stageDir, domain.host),
      siteUrl: domain.site_url,
      siteIndex: domain.global_site_order - 1,
      pageCount: domain.page_count,
      // 소유확인 태그. 아직 없으면 빈 값이라 meta 가 안 나간다.
      naverSiteVerification: domain.naver_verification_token || '',
      extendPage,
      extendIndex,
      gzipHtml,
      writeFeeds,
    });
  };
} else {
  const appRequire = createRequire(resolve(appDir, 'package.json'));
  const { build } = await import(pathToFileURL(appRequire.resolve('astro')).href);

  buildOne = async (domain) => {
    process.env.PUBLIC_SITE_URL = domain.site_url;
    process.env.PUBLIC_SITE_INDEX = String(domain.global_site_order - 1);
    process.env.PUBLIC_PAGE_COUNT = String(domain.page_count);
    process.env.PUBLIC_NAVER_SITE_VERIFICATION = domain.naver_verification_token || '';
    process.env.ASTRO_DIST_DIR = resolve(stageDir, domain.host);
    await build({ root: appDir, logLevel: 'error' });
  };
}

const startedAt = Date.now();
let built = 0;

for (const domain of domains) {
  await buildOne(domain);

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

const hostList = domains.map((domain) => domain.host).join('\n');
const hostFile = resolve(stageDir, '.hosts');
writeFileSync(hostFile, `${hostList}\n`);

/*
 * 전송 경로 — 직결 SSH 가 기본 (2026-08-22 운영자 확정, 이사 배포와 동일).
 * SSM 터널은 실측 6.4Mbps. 직결은 배포 동안만 보안그룹 22 를 내 IP /32 로
 * 열었다 닫는다. 문제가 생기면 --ssm 으로 폴백. 배포 중 HaiIP 금지.
 */
const origin = await prepareOriginSsh({
  mode: options.ssm ? 'ssm' : 'direct',
  config: { instance: INSTANCE, sshKey: SSH_KEY, profile: AWS_PROFILE, region: AWS_REGION },
});
process.on('exit', origin.cleanup);
console.log(JSON.stringify({ phase: 'ssh', mode: origin.mode, originIp: origin.originIp, myIp: origin.myIp, door: origin.doorState }));
const sshBase = origin.sshCommand;

/*
 * 전송을 덩어리로 쪼갠다.
 *
 * 10,000 사이트를 tar 하나로 보내면 32GB(gzip 6.5GB)짜리 단일 스트림이 된다.
 * 2026-08-11 에 그 방식으로 돌리다 SSM 터널이 중간에 깨졌다:
 *   Bad packet length 354974301. / Connection corrupted / tar: Cannot write: Broken pipe
 * 21분 걸린 빌드가 통째로 헛돌았고, 서버에는 5,237개만 남아 앞뒤가 섞였다.
 *
 * 덩어리로 나누면 깨져도 그 덩어리만 다시 보내면 되고, 성공한 만큼은
 * 그때그때 deployed_at 에 기록되어 DB 와 실제가 어긋나지 않는다.
 */
const chunkSize = Math.max(1, Number(options.chunkSites || 500));
const chunks = [];
for (let i = 0; i < domains.length; i += chunkSize) chunks.push(domains.slice(i, i + chunkSize));

/*
 * SSM 터널이 크기와 무관하게 랜덤으로 끊긴다.
 *   Bad packet length ... / ssh_dispatch_run_fatal: Connection corrupted
 * 450MB 짜리 덩어리에서도 났다. 그래서 덩어리마다 몇 번 다시 시도하고,
 * 그래도 안 되면 그 덩어리만 건너뛰고 계속 간다. 한 덩어리 때문에 구간 전체를
 * 다시 빌드·전송하는 게 더 비싸다. 실패분은 파일로 남겨 나중에 다시 올린다.
 */
const maxAttempts = Math.max(1, Number(options.chunkRetries || 3));
/** 끊긴 직후 바로 다시 붙으면 또 끊긴다. 동기 대기라 이벤트 루프를 안 쓴다. */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const transferStart = Date.now();
let deployedTotal = 0;
const failedChunks = [];

for (const [index, chunk] of chunks.entries()) {
  // tar 에 넘길 대상 목록. 인자로 나열하면 500개에서 명령줄 길이 한계에 걸린다.
  const listPath = resolve(stageDir, '.chunk-files');
  writeFileSync(listPath, `${chunk.map((domain) => `./${domain.host}`).join('\n')}\n`, 'utf8');

  const remoteScript = [
    `mkdir -p ${REMOTE_ROOT}`,
    `cd ${REMOTE_ROOT}`,
    'tar -xz',
  ].join(' && ');

  // pipefail 이 없으면 tar 가 죽어도 ssh 의 종료코드만 보고 성공으로 친다.
  // 2026-08-11 에 그것 때문에 전송이 깨졌는데도 1,000건이 배포 완료로 기록됐다.
  const command = 'set -o pipefail; '
    + `tar -cz -C ${shellQuote(toPosix(stageDir))} -T ${shellQuote(toPosix(listPath))}`
    + ` | ${sshBase} ${shellQuote(remoteScript)}`;

  const label = `${index + 1}/${chunks.length}`;
  console.log(JSON.stringify({ phase: 'transfer', chunk: label, sites: chunk.length }));

  let sent = false;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execSync(command, { shell: 'bash', stdio: 'inherit' });
      sent = true;
      break;
    } catch (error) {
      lastError = String(error.message).split('\n')[0].slice(0, 160);
      console.log(JSON.stringify({
        phase: 'transfer-retry', chunk: label, attempt, of: maxAttempts, error: lastError,
      }));
      if (attempt < maxAttempts) sleepMs(20000);
    }
  }

  if (!sent) {
    // 이 덩어리는 포기하고 다음으로 넘어간다. 구간 전체를 멈추지 않는다.
    failedChunks.push({ label, sites: chunk.length, error: lastError, hosts: chunk.map((d) => d.host) });
    console.log(JSON.stringify({ phase: 'chunk-skipped', chunk: label, sites: chunk.length }));
    continue;
  }

  // 이 덩어리는 확실히 올라갔다. 여기서만 배포 시각을 찍는다.
  deployedTotal += await markDeployed(chunk.map((domain) => domain.id));
  console.log(JSON.stringify({ phase: 'transferred', chunk: label, deployedAtUpdated: deployedTotal }));
}

// 실패한 덩어리의 호스트는 파일로 남긴다. 나중에 이것만 다시 올리면 된다.
if (failedChunks.length) {
  const reportDir = resolve(projectRoot, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, `deploy-failed-${fromOrder}-${toOrder}.txt`);
  writeFileSync(
    reportPath,
    failedChunks.flatMap((c) => [`# 덩어리 ${c.label} (${c.sites}개) ${c.error}`, ...c.hosts]).join('\n') + '\n',
    'utf8',
  );
  console.log(JSON.stringify({ phase: 'failed-hosts-saved', path: reportPath }));
}

console.log(JSON.stringify({
  phase: failedChunks.length ? (deployedTotal ? 'deploy-partial' : 'deploy-failed') : 'deployed',
  sites: built,
  deployedAtUpdated: deployedTotal,
  chunks: chunks.length,
  failedChunks: failedChunks.map((c) => ({ chunk: c.label, sites: c.sites, error: c.error })),
  transferSec: Math.round((Date.now() - transferStart) / 1000),
  totalSec: Math.round((Date.now() - startedAt) / 1000),
}));

// 한 덩어리도 못 보냈을 때만 실패로 끝낸다. 일부라도 올라갔으면 다음 구간으로 넘어간다.
if (failedChunks.length && deployedTotal === 0) {
  console.error(`전 덩어리 전송 실패 (계정 #${fromOrder}~${toOrder}).`);
  process.exit(1);
}

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
