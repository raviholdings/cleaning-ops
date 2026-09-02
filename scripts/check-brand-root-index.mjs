#!/usr/bin/env node
/**
 * 브랜드 사이트 메인 페이지가 네이버에 색인됐는지 본다.
 *
 *   node scripts/check-brand-root-index.mjs                 # 다섯 곳 조회 + 기록
 *   node scripts/check-brand-root-index.mjs --dry-run       # 조회만, 기록 안 함
 *   node scripts/check-brand-root-index.mjs --hosts a.kr,b.kr
 *   node scripts/check-brand-root-index.mjs --history       # 지난 기록만 (네트워크 안 씀)
 *   node scripts/check-brand-root-index.mjs --history --days 14
 *
 * check-naver-root-index-daily.mjs 와 같은 뼈대다. 다른 점은 하나.
 *
 *   저쪽은 "루트 아래 아무 페이지나 잡히나" 를 센다 (서브도메인 2,000개짜리라
 *   그게 맞다). 브랜드는 도메인 하나에 사이트 하나라 **홈이 잡혔는지**가 따로
 *   중요하다. 하위 3,000장이 색인돼도 홈이 빠져 있으면 브랜드명 검색에서 안 뜬다.
 *
 * 그래서 두 가지를 따로 기록한다.
 *
 *   webItemCount   site:<도메인> 전체 웹문서 건수
 *   rootIndexed    결과 안에 루트 주소(https://도메인/)가 실제로 들어 있는지
 *
 * 대조군을 쓰는 이유는 저쪽과 같다. "전멸" 로 보이는 세 경우 — 파서 고장,
 * 내 IP 차단, 프록시 이상 — 을 진짜 색인 소실과 갈라야 한다. 대조군이 0이면
 * 그 회차의 not-indexed 는 판단에 쓰면 안 되므로 unverifiable 로 적는다.
 *
 * 조회는 회차당 6쿼리(도메인 5 + 대조군 1)다. 색인 조사 배치와 같은 IP 예산
 * (하루 1,400~1,900)을 나눠 쓰니, 그 배치가 도는 중이면 같이 돌리지 말 것.
 */

import {
  appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const dryRun = argv.includes('--dry-run');
const historyOnly = argv.includes('--history');
const delayMs = Number(argValue('--delay-ms', 7000));
const days = Number(argValue('--days', 7));
const outPath = resolve(projectRoot, argValue('--out', 'reports/naver-brand-index/brand-root-index.jsonl'));

const USER_AGENT = process.env.NAVER_SITE_CHECK_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* 대조군 — 색인이 빠질 리 없는 외부 사이트. naver.com 은 자사라 site: 가 403 이다. */
const CONTROL_HOST = 'wikipedia.org';

/** 대상. data/brands/<키>.json 의 host 를 읽는다. */
function loadTargets() {
  const override = argValue('--hosts', '');
  if (override) {
    return override.split(',').map((v) => v.trim()).filter(Boolean)
      .map((host) => ({ key: host, brand: host, host }));
  }
  const dir = join(projectRoot, 'data/brands');
  return readdirSync(dir)
    .filter((f) => /^[a-z]+\.json$/.test(f))
    .map((f) => {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { key: f.replace(/\.json$/, ''), brand: j.brand, host: j.host };
    })
    .filter((t) => t.host && t.host !== 'TBD.co.kr')
    .sort((a, b) => a.key.localeCompare(b.key));
}

function searchUrl(host) {
  const url = new URL('https://search.naver.com/search.naver');
  url.searchParams.set('query', `site:${host}`);
  url.searchParams.set('sm', 'tab_pge');
  url.searchParams.set('ssc', 'tab.ur.all');
  url.searchParams.set('start', '1');
  url.searchParams.set('page', '1');
  return url.toString();
}

/*
 * 판정 기준은 check-naver-indexed-posts.mjs · check-naver-root-index-daily.mjs 와 맞춘다.
 * 셋이 다르면 같은 날 세 숫자가 서로 안 맞아 어느 것이 맞는지 알 수 없게 된다.
 */
function parse(host, html) {
  const blocked = html.includes('검색 서비스 이용이 제한되었습니다')
    || html.includes('비정상적인 움직임이 발견');
  const noResult = html.includes('api_noresult_wrap') || html.includes('검색결과가 없습니다');
  const webItemCount = (html.match(/templateId":"webItem/g) || []).length;

  /* 백슬래시를 소스에 직접 안 쓴다 — 셸 heredoc 이 먹어 정규식이 깨진 적이 있다. */
  const BS = String.fromCharCode(92);
  const esc = host.split('.').join(`${BS}.`);
  const re = new RegExp(`https?://[a-z0-9.-]*${esc}[^"'<>) ${BS}s${BS}${BS}]*`, 'gi');
  const urls = [...new Set([...html.matchAll(re)].map((m) => m[0].split('&amp;').join('&')))];

  const paths = new Set();
  let rootIndexed = false;
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    const h = u.host.toLowerCase();
    if (h !== host && h !== `www.${host}`) continue;   // 남의 도메인이 섞이는 것을 막는다
    const p = decodeURI(u.pathname || '/');
    paths.add(p);
    if (p === '/' || p === '') rootIndexed = true;
  }
  return {
    blocked, noResult, webItemCount, rootIndexed, pathCount: paths.size,
    samplePaths: [...paths].slice(0, 5),
  };
}

async function check(host) {
  const res = await fetch(searchUrl(host), {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  const html = await res.text();
  const parsed = parse(host, html);
  // blocked 는 "색인 없음" 이 아니다. 섞으면 차단당한 날이 색인 소실로 기록된다.
  const status = parsed.blocked || res.status === 403
    ? 'blocked'
    : parsed.webItemCount > 0 ? 'indexed' : 'not-indexed';
  return { host, status, httpStatus: res.status, ...parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 지난 기록만 보기 ── */
function showHistory() {
  if (!existsSync(outPath)) {
    console.error(`기록이 없습니다: ${outPath}`);
    process.exit(1);
  }
  const since = Date.now() - days * 86400_000;
  const rows = readFileSync(outPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => new Date(r.checked_at).getTime() >= since);
  if (!rows.length) {
    console.log(`최근 ${days}일 기록이 없습니다.`);
    return;
  }
  const hosts = [...new Set(rows.map((r) => r.host))].sort();
  const rounds = [...new Set(rows.map((r) => r.checked_at))].sort();
  const at = new Map(rows.map((r) => [`${r.checked_at}|${r.host}`, r]));
  const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600_000)
    .toISOString().slice(5, 16).replace('T', ' ');

  /* 셀: H=홈 색인 · o=하위만 색인 · .=0건 · ?=대조군 실패 · X=차단 · E=에러 */
  console.log(`최근 ${days}일 · 회차 ${rounds.length}개 (KST)`);
  console.log('  H=홈 색인  o=하위만  .=0건  ?=판정불가  X=차단  E=에러\n');
  const w = Math.max(...hosts.map((h) => h.length));
  console.log(`  ${''.padEnd(w)}  ${rounds.map((r) => kst(r).slice(0, 5)).join(' ')}`);
  for (const host of hosts) {
    const line = rounds.map((r) => {
      const x = at.get(`${r}|${host}`);
      if (!x) return '  -  ';
      if (x.status === 'blocked') return '  X  ';
      if (x.status === 'error') return '  E  ';
      if (x.status === 'unverifiable') return '  ?  ';
      if (x.rootIndexed) return '  H  ';
      return x.webItemCount > 0 ? '  o  ' : '  .  ';
    }).join(' ');
    console.log(`  ${host.padEnd(w)}  ${line}`);
  }
  const last = rounds[rounds.length - 1];
  console.log(`\n마지막 회차 ${kst(last)}`);
  for (const host of hosts) {
    const x = at.get(`${last}|${host}`);
    if (!x) continue;
    console.log(`  ${host.padEnd(w)} ${String(x.status).padEnd(13)}`
      + `홈 ${x.rootIndexed ? '색인됨' : '아직'}  웹문서 ${String(x.webItemCount ?? '-').padStart(3)}건`);
  }
}

if (historyOnly) {
  showHistory();
  process.exit(0);
}

/* ── 조회 ── */
const targets = loadTargets();
const checkedAt = new Date().toISOString();
console.log(`브랜드 ${targets.length}곳 · ${delayMs}ms 간격${dryRun ? ' · DRY RUN(기록 안 함)' : ''}\n`);

const rows = [];
for (const [i, t] of targets.entries()) {
  let row;
  try {
    row = { checked_at: checkedAt, key: t.key, brand: t.brand, ...(await check(t.host)) };
  } catch (error) {
    row = {
      checked_at: checkedAt, key: t.key, brand: t.brand, host: t.host,
      status: 'error', error: String(error?.message || error),
    };
  }
  rows.push(row);
  console.log(
    `  ${String(i + 1).padStart(2)}. ${String(row.brand).padEnd(7)} ${row.host.padEnd(17)}`
    + ` ${String(row.status).padEnd(13)}`
    + ` 홈 ${row.rootIndexed ? '색인됨 ✓' : '아직   '}`
    + `  웹문서 ${String(row.webItemCount ?? '-').padStart(3)}건`
    + `  주소 ${String(row.pathCount ?? '-').padStart(3)}종`
    + (row.error ? `  ${row.error}` : ''),
  );
  await sleep(delayMs);
}

let controlCount = -1;
try { controlCount = (await check(CONTROL_HOST)).webItemCount; } catch { controlCount = -1; }
const controlOk = controlCount > 0;

for (const row of rows) {
  row.control_ok = controlOk;
  row.control_host = CONTROL_HOST;
  row.control_count = controlCount;
  // 대조군이 죽은 회차는 색인 통계에 쓰면 안 된다. 상태 자체를 갈아둔다.
  if (!controlOk && row.status === 'not-indexed') row.status = 'unverifiable';
}

const home = rows.filter((r) => r.rootIndexed);
const any = rows.filter((r) => r.status === 'indexed');
const blocked = rows.filter((r) => r.status === 'blocked');

console.log(`\n대조군 ${CONTROL_HOST} ${controlCount}건 → 이 회차 ${controlOk ? '유효' : '무효'}`);
if (!controlOk) {
  console.log('⚠ 대조군이 0건입니다. 색인이 빠진 게 아니라 셋 중 하나입니다:');
  console.log('  파서 고장(네이버 마크업 변경) · 내 IP 차단 · 프록시 이상');
  console.log('  이 회차의 not-indexed 는 unverifiable 로 기록했습니다 — 판단에 쓰지 마세요.');
} else {
  console.log(`홈이 색인된 곳 ${home.length}/${rows.length}`
    + `${home.length ? ` — ${home.map((r) => r.brand).join(', ')}` : ''}`);
  console.log(`어떤 페이지든 잡히는 곳 ${any.length}/${rows.length}`);
}
if (blocked.length) {
  console.log(`⚠ 차단 페이지를 받은 곳 ${blocked.length} — 이 도메인은 판단에 쓰지 마세요`);
}

if (!dryRun) {
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  console.log(`\n기록: ${outPath}`);
  console.log('지난 기록 보기: node scripts/check-brand-root-index.mjs --history');
}
