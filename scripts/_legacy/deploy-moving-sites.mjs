#!/usr/bin/env node
/**
 * 이사 페이지 전량 배포 — 10,000 서브도메인 × 50장.
 *
 *   node scripts/deploy-moving-sites.mjs --from-order 1 --to-order 100
 *   node scripts/deploy-moving-sites.mjs --from-order 1 --to-order 1 --chunk-sites 100   # 파일럿
 *
 * 청소(build-and-deploy-sites.mjs)의 전송 방식을 그대로 쓴다:
 * 덩어리 tar | ssh(SSM 터널) 추출, 덩어리별 재시도 3회, 실패 덩어리는
 * 기록하고 계속 간다. 다른 점:
 *
 *   · DB 에 쓰지 않는다. deployed_at 은 청소 배포 상태라서 건드리면 안 된다.
 *     이사 배포 상태는 reports/moving-deploy-state.jsonl 에만 남긴다.
 *     재실행하면 이 파일에 있는 호스트는 건너뛴다 (재개).
 *   · 스테이지·잠금도 청소와 분리한다. 같은 폴더를 쓰면 동시 실행 때 깨진다.
 *
 * 사이트 배정: siteIndex = globalSiteOrder - 1 (0-based).
 * 카탈로그가 사이트당 폭 100 을 예약하므로(SLOT_STRIDE) 나중에 50장을
 * 늘려도 기존 페이지 내용은 변하지 않는다.
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';

import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { buildMovingPageData, loadLocations, loadMovingLib } from './lib/moving-page-data.mjs';
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

const fromOrder = Number(options.fromOrder || 1);
const toOrder = Number(options.toOrder || 100);
const chunkSize = Math.max(1, Number(options.chunkSites || 500));
const maxAttempts = Math.max(1, Number(options.chunkRetries || 3));

const REMOTE_ROOT = '/srv/group-page-origin/sites';
const INSTANCE = process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b';
const SSH_KEY = process.env.ORIGIN_SSH_KEY || '/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem';
const AWS_PROFILE = process.env.AWS_PROFILE || 'cleaning-ops';
const AWS_REGION = process.env.AWS_DEFAULT_REGION || 'ap-northeast-2';

const stageDir = resolve(projectRoot, 'apps/moving-ravi/tmp/deploy-stage');
const statePath = resolve(projectRoot, 'reports/moving-deploy-state.jsonl');

function toPosix(path) {
  return path.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
}
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── 잠금 (청소와 같은 방식, 파일만 분리) ── */
const lockPath = resolve(projectRoot, 'apps/moving-ravi/tmp/.moving-deploy.lock');
mkdirSync(dirname(lockPath), { recursive: true });
if (existsSync(lockPath)) {
  const holder = readFileSync(lockPath, 'utf8').trim();
  const pid = Number(holder.split(/\s+/)[0]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) throw new Error(`다른 이사 배포가 실행 중입니다 (${holder}).`);
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
    ['cleaning-ravi', fromOrder, toOrder],
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
  phase: 'start', accounts: `${fromOrder}-${toOrder}`,
  domains: domains.length, skipDone: domains.length - targets.length, targets: targets.length,
  chunkSites: chunkSize,
}));
if (!targets.length) { console.log(JSON.stringify({ phase: 'nothing-to-do' })); process.exit(0); }

/* ── 템플릿 (build-moving-site.mjs 와 같은 로더) ── */
const templateDir = resolve(projectRoot, 'apps/moving-static/move-template');
const pageTemplate = parseTemplate(readFileSync(join(templateDir, 'page.html'), 'utf8'), 'move-template/page.html');
const partials = readdirSync(join(templateDir, 'partials'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => ({
    name: f.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
    template: parseTemplate(readFileSync(join(templateDir, 'partials', f), 'utf8'), `partials/${f}`),
  }));

const lib = await loadMovingLib(projectRoot);
const locations = loadLocations(projectRoot);
const pageCount = Number(options.pages || lib.catalog.PAGE_COUNT);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(dirname(statePath), { recursive: true });

async function bakeSite(domain) {
  const siteUrl = domain.site_url || `https://${domain.host}`;
  const siteIndex = domain.ord - 1;
  const written = [];
  for (let requestId = 1; requestId <= pageCount; requestId += 1) {
    const data = await buildMovingPageData({
      projectRoot, lib, locations, siteIndex, requestId, siteUrl, pageCount,
      naverSiteVerification: domain.naver_verification_token || '',
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
  const smPath = join(stageDir, domain.host, '이사', 'sitemap.xml');
  writeFileSync(`${smPath}.gz`, gzipSync(Buffer.from(sitemap, 'utf8'), { level: 6 }));
}

/*
 * 전송 경로 — 직결 SSH 가 기본 (2026-08-22 운영자 확정).
 * SSM 터널은 실측 6.4Mbps 라 전량 배포에 87분이 걸렸다. 직결은 배포 동안만
 * 보안그룹 22 를 내 IP /32 로 열었다 닫는다. 문제가 생기면 --ssm 으로 폴백.
 * 배포 중 HaiIP 로 IP 를 바꾸면 끊긴다 — PC 수집요청과 동시 실행 금지.
 */
const origin = await prepareOriginSsh({
  mode: options.ssm ? 'ssm' : 'direct',
  config: { instance: INSTANCE, sshKey: SSH_KEY, profile: AWS_PROFILE, region: AWS_REGION },
});
process.on('exit', origin.cleanup);
console.log(JSON.stringify({ phase: 'ssh', mode: origin.mode, originIp: origin.originIp, myIp: origin.myIp, door: origin.doorState }));
const sshBase = origin.sshCommand;

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

  // 보낸 덩어리는 스테이지에서 지운다. 안 지우면 10,000사이트 4GB 가 쌓인다.
  for (const d of chunk) rmSync(join(stageDir, d.host), { recursive: true, force: true });
}

if (failedChunks.length) {
  const reportPath = resolve(projectRoot, 'reports', `moving-deploy-failed-${fromOrder}-${toOrder}.txt`);
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
