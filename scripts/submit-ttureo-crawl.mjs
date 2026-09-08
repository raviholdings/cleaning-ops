#!/usr/bin/env node
/**
 * ttureo.kr 수집요청 — 운영자 개인 계정 세션으로, DB 를 거치지 않고 제출한다.
 *
 *   node scripts/submit-ttureo-crawl.mjs --dry-run     무엇을 보낼지만
 *   node scripts/submit-ttureo-crawl.mjs               오늘 몫(기본 50건)
 *   node scripts/submit-ttureo-crawl.mjs --limit 10
 *   node scripts/submit-ttureo-crawl.mjs --show-browser 화면을 보며
 *
 * 왜 기존 제출기를 안 쓰나 —
 * scripts/submit-naver-searchadvisor-crawl-requests.mjs 는 대포 계정 풀
 * (naver_searchadvisor_accounts) 과 HaiIP 를 전제로 한다. ttureo.kr 은 운영자
 * 개인 계정으로 소유확인했고 본인이 직접 관리하므로 풀에 넣지 않는다 —
 * 풀에 넣으면 러너가 IP 를 계속 바꿔 로그인해 정지 위험을 지고, 비밀번호·세션이
 * 대포 계정들과 같은 자리에 저장된다. 그래서 쿠키 파일 하나만 쓰는 얇은 길을 낸다.
 * API 계약(엔드포인트·필드·응답 코드)은 기존 제출기에서 그대로 가져왔다.
 *
 * ⛔ 브랜드/청소 러너가 도는 중에는 같이 켜지 마라. HaiIP 가 IP 를 바꾸면
 *    진행 중인 요청이 끊기고, 진짜 실패인지 IP 가 바뀐 건지 구별이 안 된다.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

const SITE = 'https://ttureo.kr';
const SITEMAP = `${SITE}/sitemap_index.xml`;
const SESSION = process.env.TTUREO_SESSION_PATH
  || 'C:/Users/LD/Desktop/ravi/_secure/ttureo-naver-session.json';
const STATE = process.env.TTUREO_CRAWL_STATE
  || 'C:/Users/LD/Desktop/ravi/dr-ttureo-project/.crawl-state.json';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, fb) => { const i = args.indexOf(n); return i === -1 ? fb : args[i + 1]; };
const dryRun = flag('--dry-run');
const showBrowser = flag('--show-browser');
const LIMIT = Number(val('--limit', 50));   // 네이버 한도: 사이트당 하루 50건
const DELAY_MS = Number(val('--delay', 2500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 결과를 DB 에도 남긴다 — 관리자 화면(/api/crawl-brand)이 여기서 읽는다.
 * 로컬 .crawl-state.json 은 "무엇을 이미 보냈나"(재개용)이고, DB 는 "언제 무엇이
 * 어떻게 됐나"(현황·실패사유)다. 둘은 용도가 달라 하나로 합치지 않는다.
 *
 * account 에 운영자 개인 네이버 ID 를 넣지 않는다 — 대포 계정들과 같은 테이블이라
 * 굳이 개인 ID 를 흘릴 이유가 없다. 어느 경로로 들어온 기록인지만 남기면 충분하다.
 */
const ACCOUNT_LABEL = 'ttureo-owner';

function loadDbUrl() {
  const envPath = 'C:/Users/LD/Desktop/ravi/cleaning-ops/.env';
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

async function openDb() {
  const url = loadDbUrl();
  if (!url) { console.log("⚠ DATABASE_URL 을 못 읽어 DB 기록은 건너뜁니다."); return null; }
  try {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    return client;
  } catch (e) {
    console.log("⚠ DB 연결 실패 — 제출은 계속합니다: " + e.message.split("\n")[0]);
    return null;
  }
}

/** 응답 코드 뜻 — 기존 제출기(2026-08)에서 확인된 값. */
const CODE = { 0: '성공', 200: '성공', 110: '오늘 한도 소진', 139: '이미 요청됨' };

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'ttureo-crawl/1.0' } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer()).toString('utf8'); // 청크 경계에서 한글이 깨진다
}

/**
 * Yoast 꼴 색인이라 <loc> 이 자식 사이트맵이다 — 한 단계 따라 내려간다.
 *
 * 운영자 지시(2026-09-08 "허브우선으로 바꿔줘. 전국 얕게 깔고 가자"):
 * 사이트맵 순서 그대로면 대구를 전부 채우고 다음 시도로 넘어간다. 하루 50건
 * 한도에서 그러면 전국이 깔리기까지 150일이 걸린다. 얕은 것부터 보내면 엿새면
 * 전국 시군구 허브 280곳이 깔리고, 네이버가 거기서 하위 링크를 타고 들어간다.
 *
 * 정렬은 두 단계다 — <priority> 내림차순, 같으면 경로 깊이 오름차순.
 * priority 만으로는 안 갈린다: 지역허브(280, 깊이 2)와 지역×서비스(2,240, 깊이 3)가
 * 둘 다 0.6 이다. 깊이를 2순위로 둬야 허브가 먼저 나간다.
 * 같은 순위 안에서는 사이트맵 원래 순서를 지킨다(안정 정렬 — 재실행해도 같은 순서).
 */
async function readAllUrls() {
  const index = await fetchText(SITEMAP);
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
      const depth = decodeURIComponent(url).replace(SITE, '').split('/').filter(Boolean).length;
      rows.push({ url, prio, depth, order: rows.length });
    }
  }
  rows.sort((a, b) => (b.prio - a.prio) || (a.depth - b.depth) || (a.order - b.order));
  return rows.map((r) => r.url);
}

function loadState() {
  if (!existsSync(STATE)) return { done: {}, lastRunAt: null };
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { done: {}, lastRunAt: null }; }
}
function saveState(s) {
  const d = dirname(STATE);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
}

const state = loadState();
const all = await readAllUrls();
const pending = all.filter((u) => !state.done[u]);
const doneCount = all.length - pending.length;

console.log(`사이트맵 ${all.length}개 · 이미 제출 ${doneCount} · 남음 ${pending.length}`);
if (!pending.length) { console.log('보낼 것이 없습니다.'); process.exit(0); }

const batch = pending.slice(0, LIMIT);
console.log(`이번에 보낼 것: ${batch.length}건`);
if (dryRun) {
  batch.slice(0, 10).forEach((u) => console.log('   ' + decodeURIComponent(u)));
  if (batch.length > 10) console.log(`   … 외 ${batch.length - 10}건`);
  console.log('\n--dry-run 이라 보내지 않았습니다.');
  process.exit(0);
}

if (!existsSync(SESSION)) {
  console.error(`✗ 세션 파일이 없습니다: ${SESSION}`);
  console.error('  node scripts/capture-ttureo-session.mjs 로 먼저 만드세요.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: !showBrowser });
const context = await browser.newContext({ storageState: SESSION, locale: 'ko-KR' });
const page = await context.newPage();

const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(SITE)}`;
await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(DELAY_MS);

// Nuxt 스토어에서 user_enc_id·csrf 를 뽑는다 (기존 제출기와 같은 방식).
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
  throw new Error(`세션을 못 읽었습니다 — 로그인이 풀렸을 수 있습니다. state=${JSON.stringify(last || {})}`);
})();
console.log(`로그인 계정: ${session.accountId || '(id 불명)'}\n`);

let db = await openDb();
const runId = 'ttureo-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
let resultIndex = 0;

/**
 * 결과 행은 run_id 가 naver_searchadvisor_crawl_request_runs 에 먼저 있어야 한다(FK).
 * 없으면 첫 insert 에서 통째로 실패한다 — 실제로 한 번 걸렸다.
 * status 는 체크 제약이 있다: running·succeeded·partial·failed·imported 만 받는다.
 */
async function openRun(total) {
  if (!db) return;
  try {
    await db.query(
      `insert into public.naver_searchadvisor_crawl_request_runs
         (run_id, target_project, account_id, trigger_type, status, submit_mode,
          dry_run, headless, total_tasks, runner_host)
       values ($1,'brand-ravi',$2,'manual','running','api',false,$3,$4,'siwol-win')`,
      [runId, ACCOUNT_LABEL, !showBrowser, total],
    );
  } catch (e) {
    console.log("⚠ run 행을 못 만들어 DB 기록을 끕니다: " + e.message.split(String.fromCharCode(10))[0]);
    await db.end().catch(() => {});
    db = null;
  }
}

async function closeRun(counts) {
  if (!db) return;
  try {
    await db.query(
      `update public.naver_searchadvisor_crawl_request_runs
          set status=$2, processed_count=$3, submitted_count=$4, already_present_count=$5,
              failed_count=$6, quota_stop_count=$7, finished_at=now(), last_result_at=now()
        where run_id=$1`,
      [runId, counts.failed > 0 ? "partial" : "succeeded",
       counts.sent + counts.already + counts.failed, counts.sent, counts.already,
       counts.failed, counts.quota ? 1 : 0],
    );
  } catch (e) {
    console.log("⚠ run 마무리 기록 실패: " + e.message.split(String.fromCharCode(10))[0]);
  }
}

/** 한 건의 결과를 DB 에 남긴다. 실패해도 제출은 계속한다 — 기록 때문에 본업을 멈추지 않는다. */
async function record(url, status, code, note) {
  if (!db) return;
  try {
    await db.query(
      `insert into public.naver_searchadvisor_crawl_request_results
         (run_id, result_index, account, host, url, status, note, requested_at, mode, api_code, api_message)
       values ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9, $10)`,
      [runId, resultIndex++, ACCOUNT_LABEL, 'ttureo.kr', url, status, note || null, 'api',
       Number.isFinite(code) ? code : null, note || null],
    );
  } catch (e) {
    console.log('  ⚠ DB 기록 실패(제출은 정상): ' + e.message.split(String.fromCharCode(10))[0]);
  }
}

await openRun(batch.length);

let sent = 0, already = 0, failed = 0, quota = false;
for (const url of batch) {
  const u = new URL(url);
  const document = `${u.pathname}${u.search}`.replace(/^\//, '');
  let code = null, note = '';
  try {
    const res = await page.context().request.post('https://searchadvisor.naver.com/api-console/request/crawl', {
      timeout: 30000,
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        origin: 'https://searchadvisor.naver.com',
        referer: crawlPage,
      },
      data: { user_enc_id: session.userEncId, site: SITE, document, _csrf: session.csrfToken },
    });
    const body = await res.text();
    let j = null; try { j = JSON.parse(body); } catch {}
    code = Number(j?.code);
    note = j?.message || body.replace(/\s+/g, ' ').slice(0, 120);
  } catch (e) { note = e.message; }

  if (code === 0 || code === 200) {
    sent++; state.done[url] = new Date().toISOString();
    await record(url, 'submitted', code, '');
  } else if (code === 139) {
    already++; state.done[url] = new Date().toISOString();
    await record(url, 'already-present', code, note);
  } else if (code === 110) {
    quota = true;
    await record(url, 'quota-stop', code, note);
    console.log('오늘 한도가 찼습니다 — 중단합니다.');
    break;
  } else {
    failed++;
    await record(url, 'failed', code, note);
    console.log(`  ✗ ${decodeURIComponent(url)} — code=${code} ${note}`);
  }

  state.lastRunAt = new Date().toISOString();
  saveState(state);                    // 매 건마다 기록 — 중간에 끊겨도 이어서 간다
  await sleep(DELAY_MS);
}

await browser.close();
await closeRun({ sent, already, failed, quota });
if (db) await db.end().catch(() => {});
const left = all.length - Object.keys(state.done).length;
console.log(`\n제출 ${sent} · 이미있음 ${already} · 실패 ${failed}${quota ? ' · 한도소진' : ''}`);
console.log(`누적 ${Object.keys(state.done).length} / ${all.length} · 남음 ${left}`);
if (left > 0) console.log(`남은 것을 다 보내려면 하루 ${LIMIT}건 기준 약 ${Math.ceil(left / LIMIT)}일`);
