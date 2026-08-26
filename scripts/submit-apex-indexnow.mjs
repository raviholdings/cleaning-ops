/**
 * apex 루트 10개를 네이버 IndexNow 로 제출한다.
 *
 *   node scripts/submit-apex-indexnow.mjs --dry-run
 *   node scripts/submit-apex-indexnow.mjs
 *   node scripts/submit-apex-indexnow.mjs --root uloung.com
 *
 * 서치어드바이저 수집요청과 다른 점:
 *   - 계정·로그인·캡차·HaiIP 가 필요 없다. 소유 증명은 루트의 <key>.txt 하나다
 *   - 하루 50개 같은 호스트별 한도가 없다 (다만 한 번에 몰아치면 429 가 온다)
 *   - 색인을 보장하지 않는다. "이 주소가 갱신됐다" 고 알릴 뿐이다
 *
 * ⚠ 도메인마다 키가 달라야 한다 (네이버 웹마스터 가이드). 키는 공개값이고
 *   data/apex/indexnow-keys.json 에 있다. 파일 이름과 내용이 같아야 한다.
 *
 * ⚠ 네이버 안내: "IndexNow 를 사용하기 시작한 이후 추가·갱신된 URL만 게시".
 *   바뀐 것도 없는데 주기적으로 재제출하지 말 것.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const dryRun = args.includes('--dry-run');
const only = valueOf('--root');

const ENDPOINT = 'https://searchadvisor.naver.com/indexnow';
const MEANING = {
  200: 'Success — 전송 성공',
  202: 'Accepted — 수신, 키 확인중',
  400: 'Bad request — 형식 오류',
  403: 'Forbidden — 키가 유효하지 않음',
  422: 'URL 이 키 정보와 불일치',
  429: 'Too Many Requests — 과도한 요청',
  500: 'Server error',
};

const { keys } = JSON.parse(readFileSync(resolve(projectRoot, 'data/apex/indexnow-keys.json'), 'utf8'));
const roots = Object.keys(keys).filter((r) => !only || r === only).sort();
if (!roots.length) throw new Error(`대상 루트가 없다 (--root ${only})`);

console.log(`=== 네이버 IndexNow 제출 (${roots.length}개${dryRun ? ' · dry-run' : ''}) ===`);

let ok = 0;
for (const root of roots) {
  const key = keys[root];
  const target = `https://${root}/`;
  const url = `${ENDPOINT}?url=${encodeURIComponent(target)}&key=${encodeURIComponent(key)}`;

  if (dryRun) {
    console.log(`  ${root.padEnd(20)} [dry-run] ${target}`);
    continue;
  }

  // 키 파일이 살아 있는지 먼저 본다. 403/422 로 헛돌지 않게.
  const keyUrl = `https://${root}/${key}.txt`;
  const keyRes = await fetch(keyUrl).catch((e) => ({ ok: false, status: e.message }));
  const keyBody = keyRes.ok ? (await keyRes.text()).trim() : '';
  if (keyBody !== key) {
    console.log(`  ${root.padEnd(20)} 건너뜀 — 키 파일 확인 실패 (${keyUrl})`);
    continue;
  }

  const res = await fetch(url, { method: 'GET' }).catch((e) => ({ status: 0, statusText: e.message }));
  const meaning = MEANING[res.status] || `알 수 없는 응답 (${res.statusText || ''})`;
  console.log(`  ${root.padEnd(20)} ${String(res.status).padEnd(5)} ${meaning}`);
  if (res.status === 200 || res.status === 202) ok += 1;
}

if (!dryRun) {
  console.log(`\n  성공 ${ok}/${roots.length}`);
  console.log('  제출 성공 != 색인. Yeti 가 실제로 오는지는 오리진 접근 로그로 확인한다.');
}
