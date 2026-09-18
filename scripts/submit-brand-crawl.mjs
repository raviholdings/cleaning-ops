#!/usr/bin/env node
/**
 * 브랜드 5종 수집요청 — 실명 계정(ia_48) 세션 하나로 다섯 사이트를 돌린다.
 *
 *   node scripts/submit-brand-crawl.mjs --dry-run      무엇을 보낼지만
 *   node scripts/submit-brand-crawl.mjs                사이트마다 오늘 몫(기본 50건)
 *   node scripts/submit-brand-crawl.mjs --site dosadosa.kr
 *   node scripts/submit-brand-crawl.mjs --limit 10
 *   node scripts/submit-brand-crawl.mjs --show-browser  화면을 보며
 *
 * 한도는 **사이트마다** 하루 50건이다 (계정당이 아니다). 그래서 다섯 사이트를
 * 한 계정으로 묶어도 하루 250건 그대로다. 한 사이트가 한도를 만나면 그 사이트만
 * 접고 다음 사이트로 간다.
 *
 * 어디까지 보냈는지는 .crawl-state.json 에 **매 건마다** 적는다. 중간에 끊겨도
 * 다시 돌리면 이어서 간다. 사이트별로 따로 센다.
 *
 * URL 은 각 사이트의 숨은 사이트맵에서 읽는다 — /_crawl/sitemap_index.xml.
 * 브랜드는 배관과 달리 주소를 번호로 만들 수 없어 생성 폴백이 없다. 이 사이트맵은
 * 링크·robots 어디에도 안 걸려 있고 러너만 경로를 안다 (build-brand-site.mjs 참고).
 *
 * ⛔ 다른 러너(배관 수집요청·등록·소유확인)가 도는 중에는 같이 켜지 마라.
 *    그쪽이 HaiIP 로 IP 를 바꾸면 진행 중인 요청이 끊기고, 진짜 실패인지
 *    IP 가 바뀐 건지 구별이 안 된다.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

/** 사이트 순서 = 제출 순서. 앞이 먼저 하루 몫을 받는다. */
const SITES = [
  'dosadosa.kr',
  'ssac3.kr',
  'thunderdrain.kr',
  'dreamcome.kr',
  'beaverpipe.kr',
];
const CRAWL_PATH = '/_crawl/sitemap_index.xml';
const SESSION = process.env.BRAND_SESSION_PATH
  || 'C:/Users/LD/Desktop/ravi/_secure/brand-naver-session.json';
const STATE = process.env.BRAND_CRAWL_STATE
  || 'C:/Users/LD/Desktop/ravi/brand-crawl/.crawl-state.json';
const ACCOUNT_LABEL = 'ia_48';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, fb) => { const i = args.indexOf(n); return i === -1 ? fb : args[i + 1]; };
const dryRun = flag('--dry-run');
const showBrowser = flag('--show-browser');
const LIMIT = Number(val('--limit', 50));   // 네이버 한도: 사이트당 하루 50건
const DELAY_MS = Number(val('--delay', 2500));
const onlySite = String(val('--site', '') || '').trim();
const targets = onlySite ? SITES.filter((s) => s === onlySite) : SITES;
if (onlySite && !targets.length) throw new Error(`모르는 사이트입니다: ${onlySite} (${SITES.join(', ')})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 응답 코드 뜻 — 기존 제출기(2026-08)에서 확인된 값. */
const CODE_QUOTA = 110;      // 오늘 한도 소진
const CODE_ALREADY = 139;    // 이미 요청됨

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'brand-crawl/1.0' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('utf8'); // 청크 경계에서 한글이 깨진다
}

/**
 * 사이트맵 색인을 한 단계 따라 내려가 URL 을 모은다.
 *
 * 정렬은 두 단계 — <priority> 내림차순, 같으면 경로 깊이 오름차순.
 * 사이트맵 순서 그대로 보내면 한 지역을 전부 채우고 다음으로 넘어간다. 하루 50건
 * 한도에서는 전국이 깔리기까지 몇 달이 걸린다. 얕은 것부터 보내면 며칠 만에
 * 시군구 허브가 깔리고, 네이버가 거기서 하위 링크를 타고 들어간다.
 * priority 만으로는 안 갈린다 — 허브와 지역×서비스가 같은 값인 경우가 있어
 * 깊이를 2순위로 둔다. 같은 순위 안에서는 원래 순서를 지킨다(재실행해도 같은 순서).
 */
async function readAllUrls(host) {
  const siteUrl = `https://${host}`;
  const index = await fetchText(`${siteUrl}${CRAWL_PATH}`);
  const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const seen = new Set();
  const rows = [];
  for (const child of children) {
    const xml = await fetchText(child);
    for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const locM = /<loc>([^<]+)<\/loc>/.exec(block[1]);
      if (!locM) continue;
      const url = locM[1].trim();
      if (seen.has(url)) continue;
      seen.add(url);
      const prioM = /<priority>([^<]+)<\/priority>/.exec(block[1]);
      const prio = prioM ? Number(prioM[1]) : 0.5;
      const depth = decodeURIComponent(url).replace(siteUrl, '').split('/').filter(Boolean).length;
      rows.push({ url, prio, depth, order: rows.length });
    }
  }
  rows.sort((a, b) => (b.prio - a.prio) || (a.depth - b.depth) || (a.order - b.order));
  return rows.map((r) => r.url);
}

/* ---------- 진행 상태 (.crawl-state.json) ----------
 * { sites: { "dosadosa.kr": { done: { "<url>": "<보낸 시각>" }, lastRunAt } } }
 * 사이트별로 따로 센다. 매 건마다 저장한다.
 */
function loadState() {
  if (!existsSync(STATE)) return { sites: {} };
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    return s && typeof s === 'object' && s.sites ? s : { sites: {} };
  } catch { return { sites: {} }; }
}
function saveState(s) {
  const d = dirname(STATE);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
}
const state = loadState();
const siteState = (host) => (state.sites[host] ||= { done: {}, lastRunAt: null });

/* ---------- 무엇을 보낼지 먼저 정한다 ---------- */
const plan = [];
for (const host of targets) {
  let all;
  try {
    all = await readAllUrls(host);
  } catch (e) {
    console.log(`✗ ${host} — 사이트맵을 못 읽었습니다: ${e.message.split('\n')[0]}`);
    continue;
  }
  const done = siteState(host).done;
  const pending = all.filter((u) => !done[u]);
  plan.push({ host, all, pending, batch: pending.slice(0, LIMIT) });
  console.log(`${host.padEnd(18)} 전체 ${String(all.length).padStart(6)} · 보냄 ${String(all.length - pending.length).padStart(6)} · 남음 ${String(pending.length).padStart(6)} · 이번 ${pending.slice(0, LIMIT).length}`);
}
const totalBatch = plan.reduce((n, p) => n + p.batch.length, 0);
if (!totalBatch) { console.log('\n보낼 것이 없습니다.'); process.exit(0); }
console.log(`\n이번에 보낼 것: 모두 ${totalBatch}건`);

if (dryRun) {
  for (const p of plan) {
    if (!p.batch.length) continue;
    console.log(`\n[${p.host}]`);
    p.batch.slice(0, 5).forEach((u) => console.log('   ' + decodeURIComponent(u)));
    if (p.batch.length > 5) console.log(`   … 외 ${p.batch.length - 5}건`);
  }
  console.log('\n--dry-run 이라 보내지 않았습니다.');
  process.exit(0);
}

if (!existsSync(SESSION)) {
  console.error(`✗ 세션 파일이 없습니다: ${SESSION}`);
  console.error('  node scripts/capture-brand-session.mjs 로 먼저 만드세요.');
  process.exit(1);
}

/* ---------- DB 기록 ----------
 * 로컬 .crawl-state.json 은 "무엇을 이미 보냈나"(재개용)이고,
 * DB 는 "언제 무엇이 어떻게 됐나"(현황·실패사유)다. 용도가 달라 합치지 않는다.
 * DB 가 안 되더라도 제출은 계속한다 — 기록 때문에 본업을 멈추지 않는다.
 */
function loadDbUrl() {
  const envPath = 'C:/Users/LD/Desktop/ravi/cleaning-ops/.env';
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}
let db = null;
{
  const url = loadDbUrl();
  if (!url) console.log('⚠ DATABASE_URL 을 못 읽어 DB 기록은 건너뜁니다.');
  else {
    try {
      db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
      await db.connect();
    } catch (e) {
      console.log('⚠ DB 연결 실패 — 제출은 계속합니다: ' + e.message.split('\n')[0]);
      db = null;
    }
  }
}
const runId = 'brand-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
let resultIndex = 0;

/**
 * 결과 행은 run_id 가 naver_searchadvisor_crawl_request_runs 에 먼저 있어야 한다(FK).
 * status 에 체크 제약이 있다 — running·succeeded·partial·failed·imported 만 받는다.
 */
async function openRun(total) {
  if (!db) return;
  try {
    await db.query(
      `insert into public.naver_searchadvisor_crawl_request_runs
         (run_id, target_project, account_id, trigger_type, status, submit_mode,
          dry_run, headless, total_tasks, runner_host)
       values ($1,'brand-ravi',$2,'manual','running','api',false,$3,$4,'siwol-win')`,
      [runId, ACCOUNT_LABEL, !showBrowser, total]);
  } catch (e) {
    console.log('⚠ run 행을 못 만들어 DB 기록을 끕니다: ' + e.message.split('\n')[0]);
    await db.end().catch(() => {});
    db = null;
  }
}
async function closeRun(c) {
  if (!db) return;
  try {
    await db.query(
      `update public.naver_searchadvisor_crawl_request_runs
          set status=$2, processed_count=$3, submitted_count=$4, already_present_count=$5,
              failed_count=$6, quota_stop_count=$7, finished_at=now(), last_result_at=now()
        where run_id=$1`,
      [runId, c.failed > 0 ? 'partial' : 'succeeded',
        c.sent + c.already + c.failed, c.sent, c.already, c.failed, c.quotaSites]);
  } catch (e) {
    console.log('⚠ run 마무리 기록 실패: ' + e.message.split('\n')[0]);
  }
}
async function record(host, url, status, code, note) {
  if (!db) return;
  try {
    await db.query(
      `insert into public.naver_searchadvisor_crawl_request_results
         (run_id, result_index, account, host, url, status, note, requested_at, mode, api_code, api_message)
       values ($1,$2,$3,$4,$5,$6,$7, now(), 'api', $8, $9)`,
      [runId, resultIndex++, ACCOUNT_LABEL, host, url, status, note || null,
        Number.isFinite(code) ? code : null, note || null]);
  } catch (e) {
    console.log('  ⚠ DB 기록 실패(제출은 정상): ' + e.message.split('\n')[0]);
  }
}

/* ---------- 제출 ---------- */
const browser = await chromium.launch({ headless: !showBrowser });
const context = await browser.newContext({ storageState: SESSION, locale: 'ko-KR' });
const page = await context.newPage();

const firstSite = `https://${plan[0].host}`;
const crawlPage = (site) => `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(site)}`;
await page.goto(crawlPage(firstSite), { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(DELAY_MS);

// Nuxt 스토어에서 user_enc_id·csrf 를 뽑는다 (기존 제출기와 같은 방식).
// 계정이 하나라 사이트가 바뀌어도 이 값은 그대로 쓴다.
const session = await (async () => {
  const deadline = Date.now() + 15000;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const st = window.$nuxt?.$store?.state || window.__NUXT__?.state || {};
      const au = st.authUser || {};
      const meta = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.getAttribute('content') || '';
      return { userEncId: au.enc_id || au.encId || '', csrfToken: st.csrfToken || meta, accountId: au.id || '' };
    }).catch(() => null);
    if (last?.userEncId && last?.csrfToken) return last;
    await sleep(500);
  }
  throw new Error(`세션을 못 읽었습니다 — 로그인이 풀렸을 수 있습니다. `
    + 'node scripts/capture-brand-session.mjs 로 다시 잡으세요. '
    + `state=${JSON.stringify(last || {})}`);
})();
console.log(`\n로그인 계정: ${session.accountId || '(id 불명)'}\n`);

await openRun(totalBatch);

const tally = { sent: 0, already: 0, failed: 0, quotaSites: 0 };
for (const p of plan) {
  if (!p.batch.length) continue;
  const site = `https://${p.host}`;
  const st = siteState(p.host);
  let sent = 0; let already = 0; let failed = 0; let quota = false;
  console.log(`===== ${p.host} — ${p.batch.length}건 =====`);
  for (const url of p.batch) {
    const u = new URL(url);
    const document = `${u.pathname}${u.search}`.replace(/^\//, '');
    let code = null; let note = '';
    try {
      const res = await page.context().request.post('https://searchadvisor.naver.com/api-console/request/crawl', {
        timeout: 30000,
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          origin: 'https://searchadvisor.naver.com',
          referer: crawlPage(site),
        },
        data: { user_enc_id: session.userEncId, site, document, _csrf: session.csrfToken },
      });
      const body = await res.text();
      let j = null; try { j = JSON.parse(body); } catch { /* HTML 이면 로그인 풀림 */ }
      code = Number(j?.code);
      note = j?.message || body.replace(/\s+/g, ' ').slice(0, 120);
    } catch (e) { note = e.message; }

    if (code === 0 || code === 200) {
      sent += 1; st.done[url] = new Date().toISOString();
      await record(p.host, url, 'submitted', code, '');
    } else if (code === CODE_ALREADY) {
      already += 1; st.done[url] = new Date().toISOString();
      await record(p.host, url, 'already-present', code, note);
    } else if (code === CODE_QUOTA) {
      quota = true;
      await record(p.host, url, 'quota-stop', code, note);
      console.log('  오늘 한도가 찼습니다 — 이 사이트는 접고 다음으로 갑니다.');
      break;
    } else {
      failed += 1;
      await record(p.host, url, 'failed', code, note);
      console.log(`  ✗ ${decodeURIComponent(url)} — code=${code} ${note}`);
    }

    st.lastRunAt = new Date().toISOString();
    saveState(state);                  // 매 건마다 기록 — 중간에 끊겨도 이어서 간다
    await sleep(DELAY_MS);
  }
  const left = p.all.length - Object.keys(st.done).length;
  console.log(`  제출 ${sent} · 이미있음 ${already} · 실패 ${failed}${quota ? ' · 한도소진' : ''} · 남음 ${left}`);
  tally.sent += sent; tally.already += already; tally.failed += failed;
  if (quota) tally.quotaSites += 1;
}

await browser.close();
await closeRun(tally);
if (db) await db.end().catch(() => {});

console.log(`\n===== 끝 =====`);
console.log(`제출 ${tally.sent} · 이미있음 ${tally.already} · 실패 ${tally.failed} · 한도소진 사이트 ${tally.quotaSites}`);
for (const p of plan) {
  const done = Object.keys(siteState(p.host).done).length;
  const left = p.all.length - done;
  console.log(`  ${p.host.padEnd(18)} ${String(done).padStart(6)} / ${p.all.length}  남음 ${String(left).padStart(6)}`
    + (left > 0 ? `  (하루 ${LIMIT}건 기준 약 ${Math.ceil(left / LIMIT)}일)` : '  ✓ 완료'));
}
console.log(`진행 기록: ${STATE}`);
if (tally.failed > 0) process.exitCode = 1;
