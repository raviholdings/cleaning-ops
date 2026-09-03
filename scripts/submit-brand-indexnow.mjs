#!/usr/bin/env node
/**
 * 브랜드 사이트를 네이버 IndexNow 로 제출한다.
 *
 *   node scripts/submit-brand-indexnow.mjs --keys           키 만들기 (한 번만)
 *   node scripts/submit-brand-indexnow.mjs --verify-only    키 파일이 뜨는지만
 *   node scripts/submit-brand-indexnow.mjs --dry-run
 *   node scripts/submit-brand-indexnow.mjs --site dream
 *   node scripts/submit-brand-indexnow.mjs                  다섯 곳 전부
 *
 * 왜 이걸 쓰나 — 수집요청은 사이트당 하루 50건이 천장이다. 브랜드는 도메인이
 * 다섯뿐이라 전량 한 바퀴에 싹쓰리 67일 · 도사 73일이 걸린다. IndexNow 는 그
 * 한도를 안 탄다. 계정·로그인·캡차·HaiIP 도 필요 없다 — 소유 증명은 루트에 둔
 * <키>.txt 하나다.
 *
 * ⚠ 색인을 보장하지 않는다. "이 주소가 갱신됐다" 고 알릴 뿐이다.
 *   그래서 수집요청을 대체하지 않고 같이 쓴다.
 *
 * ⚠ 도메인마다 키가 달라야 한다 (네이버 웹마스터 가이드). 키는 공개값이라
 *   숨길 것이 없고 data/brands/_indexnow-keys.json 에 둔다.
 *
 * ⚠ 네이버 안내: "IndexNow 를 사용하기 시작한 이후 추가·갱신된 URL만 게시".
 *   바뀐 것이 없는데 주기적으로 재제출하지 말 것. 그게 스팸 신호가 된다.
 *
 * ⛔ 제출 중 HaiIP 금지. IP 가 바뀌면 진행 중인 요청이 끊기고, 그러면 진짜
 *    429 인지 IP 가 바뀐 건지 구별이 안 된다. 키 파일로 소유를 증명하므로
 *    IP 를 돌릴 이유 자체가 없다.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => {
  const i = args.indexOf(flag);
  return i === -1 ? fb : (args[i + 1] ?? fb);
};
const makeKeys = args.includes('--keys');
const verifyOnly = args.includes('--verify-only');
const dryRun = args.includes('--dry-run');
const only = valueOf('--site', '');
const chunkSize = Number(valueOf('--chunk', 10000));   // 네이버 한 요청 상한

const ENDPOINT = 'https://searchadvisor.naver.com/indexnow';
const KEYS_PATH = join(projectRoot, 'data/brands/_indexnow-keys.json');
const MEANING = {
  200: 'Success — 전송 성공',
  202: 'Accepted — 수신, 키 확인중',
  400: 'Bad request — 형식 오류',
  403: 'Forbidden — 키가 유효하지 않음',
  422: 'URL 이 키 정보와 불일치',
  429: 'Too Many Requests — 과도한 요청',
  500: 'Server error',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 대상 — data/brands/<키>.json 의 host */
const sites = readdirSync(join(projectRoot, 'data/brands'))
  .filter((f) => /^[a-z]+\.json$/.test(f))
  .map((f) => {
    const key = f.replace(/\.json$/, '');
    const j = JSON.parse(readFileSync(join(projectRoot, 'data/brands', f), 'utf8'));
    return { key, brand: j.brand, host: j.host };
  })
  .filter((s) => s.host && s.host !== 'TBD.co.kr')
  .filter((s) => !only || s.key === only)
  .sort((a, b) => a.key.localeCompare(b.key));

if (!sites.length) throw new Error(only ? `그런 사이트가 없습니다: ${only}` : '대상이 없습니다.');

/* ── 키 만들기 ── */
if (makeKeys) {
  const cur = existsSync(KEYS_PATH) ? JSON.parse(readFileSync(KEYS_PATH, 'utf8')) : { keys: {} };
  let added = 0;
  for (const s of sites) {
    if (cur.keys[s.host]) { console.log(`  ${s.host.padEnd(17)} 이미 있음 ${cur.keys[s.host]}`); continue; }
    cur.keys[s.host] = randomBytes(16).toString('hex');   // 32자 16진수
    added += 1;
    console.log(`  ${s.host.padEnd(17)} 새로 만듦 ${cur.keys[s.host]}`);
  }
  writeFileSync(KEYS_PATH, `${JSON.stringify({
    _note: '네이버 IndexNow 키. 도메인마다 달라야 한다 (웹마스터 가이드). '
      + '공개값이라 숨길 것이 없다 — 루트에 <키>.txt 로 올라가 있어야 제출이 통한다.',
    _endpoint: ENDPOINT,
    _howto: '키를 웹루트에 놓는 것은 굽기가 한다 (build-brand-site 가 <키>.txt 를 쓴다). '
      + '만든 뒤에는 반드시 다시 굽고 배포해야 제출이 된다.',
    keys: cur.keys,
  }, null, 1)}\n`);
  console.log(`\n  ${added}개 추가 · ${KEYS_PATH}`);
  console.log('  이제 다시 굽고 배포해야 키 파일이 웹루트에 올라갑니다.');
  process.exit(0);
}

if (!existsSync(KEYS_PATH)) {
  console.error('키가 없습니다. 먼저: node scripts/submit-brand-indexnow.mjs --keys');
  process.exit(1);
}
const { keys } = JSON.parse(readFileSync(KEYS_PATH, 'utf8'));

/* 제출할 주소 — 구운 사이트맵에서 읽는다. 배포된 것과 글자까지 같아야 한다. */
function urlsOf(key) {
  const dir = join(projectRoot, 'tmp/brands', key);
  const idx = join(dir, 'sitemap_index.xml');
  if (!existsSync(idx)) throw new Error(`구운 결과가 없습니다: ${idx} — npm run brands:build 먼저`);
  const kids = [...readFileSync(idx, 'utf8').matchAll(/<loc>[^<]*\/([^/<]+\.xml)<\/loc>/g)].map((m) => m[1]);
  const out = [];
  for (const k of kids) {
    for (const m of readFileSync(join(dir, k), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

console.log(`=== 브랜드 IndexNow (${sites.length}곳${dryRun ? ' · dry-run' : ''}${verifyOnly ? ' · 키 확인만' : ''}) ===\n`);

let ok = 0; let keyFail = 0; let httpFail = 0;
for (const s of sites) {
  const key = keys[s.host];
  if (!key) { console.log(`  ${s.host.padEnd(17)} 키가 없습니다 — --keys 로 만드세요`); keyFail += 1; continue; }

  /* 키 파일이 실제로 뜨는지 먼저 본다. 403/422 로 헛돌지 않게. */
  const keyUrl = `https://${s.host}/${key}.txt`;
  const kr = await fetch(keyUrl).catch((e) => ({ ok: false, status: e.message }));
  const kb = kr.ok ? (await kr.text()).trim() : '';
  if (kb !== key) {
    console.log(`  ${s.brand.padEnd(7)} ${s.host.padEnd(17)} ✗ 키 파일 확인 실패 — ${keyUrl}`);
    console.log('        굽고 배포했는지 확인하세요 (키는 굽기가 웹루트에 씁니다).');
    keyFail += 1;
    continue;
  }
  if (verifyOnly) {
    console.log(`  ${s.brand.padEnd(7)} ${s.host.padEnd(17)} 키 OK`);
    ok += 1;
    continue;
  }

  const urls = urlsOf(s.key);
  if (dryRun) {
    console.log(`  ${s.brand.padEnd(7)} ${s.host.padEnd(17)} [dry-run] ${urls.length.toLocaleString()} URL`
      + `  예: ${urls[0]}`);
    continue;
  }

  /* 한 요청에 10,000개까지. 그보다 많으면 나눠 보낸다. */
  let sent = 0; let bad = 0;
  for (let i = 0; i < urls.length; i += chunkSize) {
    const part = urls.slice(i, i + chunkSize);
    const body = JSON.stringify({
      host: s.host, key, keyLocation: keyUrl, urlList: part,
    });
    let status = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      }).catch((e) => ({ status: 0, statusText: e.message }));
      status = res.status;
      if (status !== 429) break;
      // 429 는 물러선다. 밀어붙이면 그게 곧 스팸 신호다.
      const backoff = 5000 * attempt;
      console.log(`        429 — ${backoff / 1000}초 쉬고 다시 (${attempt}/4)`);
      await sleep(backoff);
    }
    if (status === 200 || status === 202) sent += part.length; else bad += 1;
    console.log(`  ${s.brand.padEnd(7)} ${s.host.padEnd(17)} ${String(status).padEnd(5)}`
      + `${MEANING[status] || '알 수 없는 응답'}  (${part.length.toLocaleString()} URL)`);
    await sleep(1000);
  }
  if (bad) httpFail += 1; else ok += 1;
}

console.log(`\n  성공 ${ok} · 키 실패 ${keyFail} · HTTP 실패 ${httpFail} / 전체 ${sites.length}`);
if (!dryRun && !verifyOnly) {
  const logDir = join(projectRoot, 'reports/brand-indexnow');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'last-submit.json'), `${JSON.stringify({
    submitted_at: new Date().toISOString(),
    sites: sites.map((s) => s.host),
    ok, keyFail, httpFail,
  }, null, 1)}\n`);
  console.log('\n  제출 성공은 색인이 아닙니다. 며칠 뒤 아래로 확인하세요:');
  console.log('    node scripts/check-brand-root-index.mjs --history');
}
