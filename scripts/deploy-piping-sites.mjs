#!/usr/bin/env node
/**
 * 배관 페이지 배포.
 *
 * 도메인이 두 종류라 --group 으로 고른다.
 *   cleaning-ravi  기존 청소 서브도메인 10,000개에 /배관/ 을 얹는다 (이사와 같은 방식,
 *                  이미 소유확인이 끝나 있어 바로 배포 가능. 계정 1~105)
 *   piping-ravi    배관 신규 서브도메인 10,000개 (계정 201~300, 소유확인 필요)
 *
 *   node scripts/deploy-piping-sites.mjs --group cleaning-ravi --from-order 1 --to-order 105 --pages 110
 *   node scripts/deploy-piping-sites.mjs --group cleaning-ravi --from-order 1 --to-order 1 --chunk-sites 10 --pages 110   # 파일럿
 *   node scripts/deploy-piping-sites.mjs --group piping-ravi --from-order 201 --to-order 300 --pages 110
 *
 * --pages 는 사이트당 장수다. 페이즈가 연속 대역이라 그대로 자르면 된다.
 *   110 = 막힘만 / 140 = 막힘+수전 / 200 = 전부
 * 주의: --pages 를 늘려 다시 돌리면 페이지네이션이 달라지므로 기존 장도 다시 구워야
 * 한다. 상태 파일(reports/piping-deploy-state-<group>.jsonl)을 비우고 전량 재배포할 것.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';

import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { buildPipingPageData, loadLocations, loadPipingData } from './lib/piping-page-data.mjs';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseOptions(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { result[key] = next; i += 1; } else { result[key] = true; }
  }
  return result;
}
const options = parseOptions(process.argv.slice(2));

const DOMAIN_GROUPS = ['cleaning-ravi', 'piping-ravi'];
const domainGroup = String(options.group || 'cleaning-ravi');
if (!DOMAIN_GROUPS.includes(domainGroup)) {
  throw new Error(`--group 은 ${DOMAIN_GROUPS.join(' | ')} 중 하나여야 한다 (받은 값: ${domainGroup}).`);
}
const fromOrder = Number(options.fromOrder || 1);
const toOrder = Number(options.toOrder || (domainGroup === 'piping-ravi' ? 300 : 105));
const chunkSize = Math.max(1, Number(options.chunkSites || 500));
const maxAttempts = Math.max(1, Number(options.chunkRetries || 3));

const REMOTE_ROOT = '/srv/group-page-origin/sites';
// nginx 는 `location /img/ { root .../shared; }` 라 URI 가 root 뒤에 그대로 붙는다.
// 즉 /img/piping/x.webp -> shared/img/piping/x.webp 다. shared/piping 에 올리면 404.
// (청소는 shared/img/cleaning, 이사는 shared/img/moving 을 쓴다)
const REMOTE_SHARED = '/srv/group-page-origin/shared/img/piping';
const INSTANCE = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';
const SSH_KEY = process.env.ORIGIN_SSH_KEY || '/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem';
const AWS_PROFILE = process.env.AWS_PROFILE || 'cleaning-ops';
const AWS_REGION = process.env.AWS_DEFAULT_REGION || 'ap-northeast-2';

const stageDir = resolve(projectRoot, 'apps/piping-static/tmp/deploy-stage');
// 상태 파일은 그룹별로 따로 둔다 — 섞이면 한쪽 배포가 다른 쪽을 "이미 했다"고 건너뛴다.
const statePath = resolve(projectRoot, `reports/piping-deploy-state-${domainGroup}.jsonl`);

function toPosix(path) {
  return path.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── 잠금 ── */
const lockPath = resolve(projectRoot, 'apps/piping-static/tmp/.piping-deploy.lock');
mkdirSync(dirname(lockPath), { recursive: true });
if (existsSync(lockPath)) {
  const holder = readFileSync(lockPath, 'utf8').trim();
  const pid = Number(holder.split(/\s+/)[0]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) throw new Error(`다른 배관 배포가 실행 중입니다 (${holder}).`);
  console.log(JSON.stringify({ phase: 'lock', note: '죽은 잠금 해제', holder }));
}
writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
const releaseLock = () => { try { rmSync(lockPath, { force: true }); } catch { /* 없음 */ } };
process.on('exit', releaseLock);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { releaseLock(); process.exit(130); });

/* ── 대상 도메인 ── */
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL
  || (() => {
    const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
    return env.DATABASE_URL || env.DIRECT_URL;
  })();
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
let domains;
try {
  const result = await client.query(
    `select d.host, d.site_url, d.naver_verification_token,
            (d.source_payload->>'globalSiteOrder')::int as ord
       from public.naver_project_domains d
       join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where d.group_key = $1 and d.deployment_status = 'active' and d.is_visible = true
        and a.account_order between $2 and $3
      order by (d.source_payload->>'globalSiteOrder')::int`,
    [domainGroup, fromOrder, toOrder],
  );
  domains = result.rows;
} finally {
  await client.end();
}
if (!domains.length) throw new Error('배포할 도메인이 없습니다.');
for (const d of domains) {
  if (!Number.isSafeInteger(d.ord) || d.ord < 1) throw new Error(`${d.host}: globalSiteOrder 가 없습니다.`);
}

/* 이미 배포한 호스트는 건너뛴다. */
const done = new Set();
if (existsSync(statePath)) {
  for (const line of readFileSync(statePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).host); } catch { /* 무시 */ }
  }
}
const targets = domains.filter((d) => !done.has(d.host));
console.log(JSON.stringify({
  phase: 'start', group: domainGroup, accounts: `${fromOrder}-${toOrder}`,
  domains: domains.length, skipDone: domains.length - targets.length, targets: targets.length,
  chunkSites: chunkSize, statePath,
}));
if (!targets.length) { console.log(JSON.stringify({ phase: 'nothing-to-do' })); process.exit(0); }

/* ── 템플릿 로더 ── */
const templateDir = resolve(projectRoot, 'apps/piping-static/piping-template');
const pageTemplate = parseTemplate(readFileSync(join(templateDir, 'page.html'), 'utf8'), 'piping-template/page.html');
const partialsDir = join(templateDir, 'partials');
const partials = existsSync(partialsDir)
  ? readdirSync(partialsDir)
      .filter((f) => f.endsWith('.html'))
      .map((f) => ({
        name: f.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
        template: parseTemplate(readFileSync(join(partialsDir, f), 'utf8'), `partials/${f}`),
      }))
  : [];

const pipingData = loadPipingData(projectRoot);
const locations = loadLocations(projectRoot);
const pageCount = Number(options.pages || pipingData.config.pages.perSite || 200);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(dirname(statePath), { recursive: true });

async function bakeSite(domain) {
  const siteUrl = domain.site_url || `https://${domain.host}`;
  const siteIndex = domain.ord - 1;
  const written = [];
  for (let requestId = 1; requestId <= pageCount; requestId += 1) {
    const data = await buildPipingPageData({
      projectRoot, locations, siteIndex, requestId, siteUrl, pageCount,
      naverSiteVerification: domain.naver_verification_token || '',
      pipingData,
    });
    for (const partial of partials) data[partial.name] = renderTemplate(partial.template, data);
    const html = renderTemplate(pageTemplate, data);
    const file = join(stageDir, domain.host, data.filePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.gz`, gzipSync(Buffer.from(html, 'utf8'), { level: 6 }));
    written.push(data.pagePath);
  }
  const now = new Date().toISOString();
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + written.map((p) => `  <url>\n    <loc>${siteUrl}${encodeURI(p)}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`).join('\n')
    + '\n</urlset>\n';
  const smPath = join(stageDir, domain.host, '배관', 'sitemap.xml');
  mkdirSync(dirname(smPath), { recursive: true });
  writeFileSync(`${smPath}.gz`, gzipSync(Buffer.from(sitemap, 'utf8'), { level: 6 }));
}

/* ── SSH 직결 연결 준비 (내 IP /32 SG 임시 개방) ── */
const origin = await prepareOriginSsh({
  mode: options.ssm ? 'ssm' : 'direct',
  config: { instance: INSTANCE, sshKey: SSH_KEY, profile: AWS_PROFILE, region: AWS_REGION },
});
process.on('exit', origin.cleanup);
console.log(JSON.stringify({ phase: 'ssh', mode: origin.mode, originIp: origin.originIp, myIp: origin.myIp, door: origin.doorState }));
const sshBase = origin.sshCommand;

/* ── 배관 공유 이미지 동기화 (/srv/group-page-origin/shared/piping) ── */
const localImgDir = resolve(templateDir, 'assets/img');
if (existsSync(localImgDir)) {
  console.log(JSON.stringify({ phase: 'sync-shared-images', remote: REMOTE_SHARED }));
  const remoteImgScript = [`mkdir -p ${REMOTE_SHARED}`, `cd ${REMOTE_SHARED}`, 'tar -xz'].join(' && ');
  const imgTarCmd = 'set -o pipefail; '
    + `tar -cz -C ${shellQuote(toPosix(localImgDir))} .`
    + ` | ${sshBase} ${shellQuote(remoteImgScript)}`;
  try {
    execSync(imgTarCmd, { shell: 'bash', stdio: 'inherit' });
  } catch (err) {
    console.warn('공유 이미지 전송 실패 (기존 디렉토리 사용):', err.message);
  }
}

const chunks = [];
for (let i = 0; i < targets.length; i += chunkSize) chunks.push(targets.slice(i, i + chunkSize));

const startedAt = Date.now();
let deployedTotal = 0;
let bakeSecTotal = 0;
let transferSecTotal = 0;
const failedChunks = [];

for (const [index, chunk] of chunks.entries()) {
  const label = `${index + 1}/${chunks.length}`;

  const bakeStart = Date.now();
  for (const domain of chunk) await bakeSite(domain);
  const bakeSec = (Date.now() - bakeStart) / 1000;
  bakeSecTotal += bakeSec;

  const listPath = resolve(stageDir, '.chunk-files');
  writeFileSync(listPath, `${chunk.map((d) => `./${d.host}`).join('\n')}\n`, 'utf8');
  const remoteScript = [`mkdir -p ${REMOTE_ROOT}`, `cd ${REMOTE_ROOT}`, 'tar -xz'].join(' && ');
  const command = 'set -o pipefail; '
    + `tar -cz -C ${shellQuote(toPosix(stageDir))} -T ${shellQuote(toPosix(listPath))}`
    + ` | ${sshBase} ${shellQuote(remoteScript)}`;

  const transferStart = Date.now();
  let sent = false;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execSync(command, { shell: 'bash', stdio: 'inherit' });
      sent = true;
      break;
    } catch (error) {
      lastError = String(error.message).split('\n')[0].slice(0, 160);
      console.log(JSON.stringify({ phase: 'transfer-retry', chunk: label, attempt, of: maxAttempts, error: lastError }));
      if (attempt < maxAttempts) sleepMs(20000);
    }
  }
  const transferSec = (Date.now() - transferStart) / 1000;
  transferSecTotal += transferSec;

  if (!sent) {
    failedChunks.push({ label, sites: chunk.length, error: lastError, hosts: chunk.map((d) => d.host) });
    console.log(JSON.stringify({ phase: 'chunk-skipped', chunk: label, sites: chunk.length }));
  } else {
    const now = new Date().toISOString();
    appendFileSync(statePath, chunk.map((d) => JSON.stringify({ host: d.host, ord: d.ord, pages: pageCount, at: now })).join('\n') + '\n', 'utf8');
    deployedTotal += chunk.length;
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = deployedTotal / elapsed;
    const remain = targets.length - deployedTotal;
    console.log(JSON.stringify({
      phase: 'transferred', chunk: label, deployed: deployedTotal,
      bakeSec: Math.round(bakeSec), transferSec: Math.round(transferSec),
      siteSecAvg: Number((elapsed / deployedTotal).toFixed(2)),
      etaMin: Math.round(remain / rate / 60),
    }));
  }

  for (const d of chunk) rmSync(join(stageDir, d.host), { recursive: true, force: true });
}

if (failedChunks.length) {
  const reportPath = resolve(projectRoot, 'reports', `piping-deploy-failed-${fromOrder}-${toOrder}.txt`);
  writeFileSync(reportPath,
    failedChunks.flatMap((c) => [`# 덩어리 ${c.label} (${c.sites}개) ${c.error}`, ...c.hosts]).join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({ phase: 'failed-hosts-saved', path: reportPath }));
}

console.log(JSON.stringify({
  phase: failedChunks.length ? (deployedTotal ? 'deploy-partial' : 'deploy-failed') : 'deployed',
  deployed: deployedTotal,
  failed: failedChunks.reduce((a, c) => a + c.sites, 0),
  bakeSec: Math.round(bakeSecTotal),
  transferSec: Math.round(transferSecTotal),
  totalSec: Math.round((Date.now() - startedAt) / 1000),
}));
if (failedChunks.length && deployedTotal === 0) process.exit(1);
