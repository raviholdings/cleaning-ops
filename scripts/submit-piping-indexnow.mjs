/**
 * 배관 서브도메인 파일럿을 네이버 IndexNow 로 제출한다.
 *
 *   node scripts/submit-piping-indexnow.mjs --verify-only   # 키 파일만 확인
 *   node scripts/submit-piping-indexnow.mjs --dry-run
 *   node scripts/submit-piping-indexnow.mjs
 *
 * host 필드가 요청당 하나라 호스트마다 POST 를 따로 보낸다. 한 요청에 URL 은
 * 10,000 개까지 실을 수 있어, 호스트당 51개(루트 + /piping/1..50)를 한 번에 넣는다.
 *
 * ⛔ 제출 중 HaiIP 금지. IP 가 바뀌면 진행 중인 요청이 끊기고, 그러면 진짜
 *    429 인지 IP 가 바뀐 건지 구별이 안 된다. IndexNow 는 세션이 아니라 키
 *    파일로 소유를 증명하므로 IP 를 돌릴 이유도 없다.
 *
 * ⛔ 대조군에는 절대 보내지 않는다. 실험이 망가진다.
 *
 * 네이버 안내: "IndexNow 를 사용하기 시작한 이후 추가·갱신된 URL만 게시".
 * 이 파일럿 대상은 2026-08-27 09:43~10:15 KST 에 전부 다시 구워졌다.
 *
 * 응답: 200 성공 · 202 수신(키 확인중) · 400 형식 · 403 키 무효 ·
 *       422 URL 이 키와 불일치 · 429 과다요청 · 500 서버오류
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const dryRun = args.includes('--dry-run');
const verifyOnly = args.includes('--verify-only');
const perSec = Number(valueOf('--per-sec', '2'));      // 초당 요청 수 (천천히 간다)
const limit = Number(valueOf('--limit', '0'));         // 0 = 전부

const ENDPOINT = 'https://searchadvisor.naver.com/indexnow';
const MEANING = {
  200: 'Success', 202: 'Accepted(키 확인중)', 400: 'Bad request', 403: 'Forbidden(키 무효)',
  422: 'URL 이 키와 불일치', 429: 'Too Many Requests', 500: 'Server error',
};

const pilotPath = resolve(projectRoot, 'data/piping/indexnow-pilot.json');
const pilot = JSON.parse(readFileSync(pilotPath, 'utf8'));
const controlSet = new Set(pilot.control);
let targets = pilot.submit.filter((t) => !controlSet.has(t.host));
if (targets.length !== pilot.submit.length) throw new Error('제출군에 대조군이 섞였다 — 중단');
if (limit > 0) targets = targets.slice(0, limit);

const urlsFor = (host) => [`https://${host}/`,
  ...Array.from({ length: pilot.pages }, (_, i) => `https://${host}/piping/${i + 1}`)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`=== 배관 IndexNow 제출 (${targets.length}개 호스트 × ${pilot.pages + 1} URL`
  + `${verifyOnly ? ' · 키 확인만' : dryRun ? ' · dry-run' : ` · 초당 ${perSec}건`}) ===`);

const results = [];
let ok = 0; let keyFail = 0; let httpFail = 0;

for (const [i, t] of targets.entries()) {
  // 키 파일이 실제로 서빙되는지 먼저 본다. 403/422 로 헛돌지 않게.
  const keyUrl = `https://${t.host}/${t.key}.txt`;
  let keyOk = false;
  try {
    const r = await fetch(keyUrl);
    keyOk = r.ok && (await r.text()).trim() === t.key;
  } catch { keyOk = false; }

  if (!keyOk) {
    keyFail += 1;
    results.push({ host: t.host, keyOk: false, status: null });
    console.log(`  ${String(i + 1).padStart(3)}/${targets.length}  ${t.host.padEnd(30)} 키 파일 확인 실패 ⛔`);
    continue;
  }
  if (verifyOnly) {
    ok += 1;
    if (i < 3 || (i + 1) % 50 === 0) console.log(`  ${String(i + 1).padStart(3)}/${targets.length}  ${t.host.padEnd(30)} 키 OK`);
    continue;
  }
  if (dryRun) {
    console.log(`  ${String(i + 1).padStart(3)}/${targets.length}  ${t.host.padEnd(30)} [dry-run] ${pilot.pages + 1} URL`);
    continue;
  }

  const body = JSON.stringify({
    host: t.host, key: t.key, keyLocation: keyUrl, urlList: urlsFor(t.host),
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
    console.log(`      429 — ${backoff / 1000}초 대기 후 재시도 (${attempt}/4)`);
    await sleep(backoff);
  }

  results.push({ host: t.host, keyOk: true, status });
  if (status === 200 || status === 202) ok += 1; else httpFail += 1;
  const mark = status === 200 || status === 202 ? '' : '  ⛔';
  if (i < 5 || (i + 1) % 25 === 0 || mark) {
    console.log(`  ${String(i + 1).padStart(3)}/${targets.length}  ${t.host.padEnd(30)} ${status} ${MEANING[status] || '?'}${mark}`);
  }
  await sleep(Math.max(0, Math.round(1000 / perSec)));
}

console.log(`\n  성공 ${ok} · 키 실패 ${keyFail} · HTTP 실패 ${httpFail} / 전체 ${targets.length}`);

if (!verifyOnly && !dryRun) {
  pilot.submittedAt = new Date().toISOString();
  pilot.submitResult = { ok, keyFail, httpFail, total: targets.length };
  writeFileSync(pilotPath, `${JSON.stringify(pilot, null, 2)}\n`, 'utf8');
  console.log(`  기록: ${pilotPath} (submittedAt=${pilot.submittedAt})`);
  console.log('\n  제출 성공 != 색인. 며칠 뒤 아래로 대조군과 비교할 것:');
  console.log('    node scripts/check-indexnow-pilot.mjs --days 3');
}
