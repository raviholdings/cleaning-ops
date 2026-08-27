/**
 * 배관 서브도메인 IndexNow 파일럿 — 대상 선정 + 키 생성 + 키 파일 스테이징.
 *
 *   node scripts/prepare-indexnow-pilot.mjs --dry-run
 *   node scripts/prepare-indexnow-pilot.mjs
 *
 * 왜 파일럿인가: apex 10개 제출은 17시간이 지나도 Yeti 방문 0회다. IndexNow 가
 * 우리한테 먹히는지 아직 모른다. 2만 호스트를 한꺼번에 쏘는 건 8/22 색인 해제
 * 직후라는 시점과 겹쳐 지금 의심받는 패턴을 확인시켜 줄 위험이 있다.
 *
 * ⛔ 전용 배관(piping-ravi)에서만 뽑는다. 차용분(cleaning-ravi)은 호스트 루트가
 *    청소 홈이다 — 색인 94% 가 붙어 있어 건드리지 않는다 (CLAUDE.md 철칙 1).
 *
 * 대조군을 같이 뽑는 이유: 색인·크롤은 원래 붙었다 떨어졌다 한다. 제출군만
 * 보면 배경 변동을 효과로 오독한다. 대조군은 키 파일도 깔지 않고 제출도 하지
 * 않는다 — 두 군의 Yeti 방문을 나중에 비교한다.
 *
 * ⚠ 키는 도메인(호스트)마다 달라야 한다. apex 키로는 서브도메인을 못 쓴다 —
 *   IndexNow 는 키 파일이 놓인 호스트·디렉토리 아래 URL 만 검증한다.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const dryRun = args.includes('--dry-run');
const perRoot = Number(valueOf('--per-root', '20'));   // 루트당 제출군 / 대조군 각각
const pages = Number(valueOf('--pages', '50'));        // 호스트당 /piping/1..N
const stateFile = valueOf('--state', 'reports/piping-deploy-state-piping-ravi.jsonl');
const outFile = resolve(projectRoot, 'data/piping/indexnow-pilot.json');
const stageDir = resolve(projectRoot, valueOf('--stage', 'tmp/indexnow-keys'));

const ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];

/** 같은 입력이면 같은 선택이 나오게 (재현 가능해야 나중에 대조가 성립한다). */
function seededRng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const lines = readFileSync(resolve(projectRoot, stateFile), 'utf8').trim().split('\n');
const deployed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!deployed.length) throw new Error(`${stateFile} 이 비었다.`);

const deployedAt = deployed[0].at;
console.log(`=== 배관 IndexNow 파일럿 준비${dryRun ? ' (dry-run)' : ''} ===`);
console.log(`  원본: ${stateFile} — ${deployed.length}개 호스트, 배포 ${deployedAt}`);

// 루트별로 모아서 각각 앞에서 제출군 / 뒤에서 대조군을 뽑는다.
// 같은 루트 안에서 갈라야 루트별 크롤 편차(naoheg 가 유독 많다)가 두 군에 같이 걸린다.
const byRoot = Object.fromEntries(ROOTS.map((r) => [r, []]));
for (const d of deployed) {
  const root = ROOTS.find((r) => d.host.endsWith(`.${r}`));
  if (root) byRoot[root].push(d.host);
}

const submit = [];
const control = [];
for (const root of ROOTS) {
  const hosts = byRoot[root].slice().sort();
  const rng = seededRng(`indexnow-pilot:${root}`);
  // 셔플 후 앞 perRoot 는 제출군, 다음 perRoot 는 대조군.
  for (let i = hosts.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
  }
  if (hosts.length < perRoot * 2) throw new Error(`${root}: 호스트가 ${hosts.length}개뿐 — ${perRoot * 2}개 필요`);
  submit.push(...hosts.slice(0, perRoot));
  control.push(...hosts.slice(perRoot, perRoot * 2));
  console.log(`  ${root.padEnd(20)} 보유 ${String(byRoot[root].length).padStart(5)} → 제출 ${perRoot} · 대조 ${perRoot}`);
}

const keys = {};
for (const host of submit) keys[host] = randomBytes(16).toString('hex');

const dup = new Set(Object.values(keys)).size !== submit.length;
const badFormat = Object.values(keys).some((k) => !/^[a-fA-F0-9-]{8,128}$/.test(k));
const overlap = submit.filter((h) => control.includes(h));
console.log(`\n  제출군 ${submit.length} · 대조군 ${control.length}`);
console.log(`  키 중복 ${dup ? '있음 ⛔' : '없음'} · 형식 ${badFormat ? '오류 ⛔' : 'OK'} · 두 군 겹침 ${overlap.length}건`);
if (dup || badFormat || overlap.length) throw new Error('검증 실패 — 진행하지 않는다.');

// 호스트당 제출할 URL: 루트(배관 홈) + /piping/1..N. 오늘 전부 다시 구워졌다.
const urlsFor = (host) => [`https://${host}/`,
  ...Array.from({ length: pages }, (_, i) => `https://${host}/piping/${i + 1}`)];

const payload = {
  _note: '배관 서브도메인 IndexNow 파일럿. 키는 공개값이라 비밀이 아니다. 대조군은 키도 제출도 없다.',
  _endpoint: 'https://searchadvisor.naver.com/indexnow',
  group: 'piping-ravi',
  deployedAt,
  pages,
  urlsPerHost: pages + 1,
  submit: submit.map((host) => ({ host, key: keys[host] })),
  control,
};

console.log(`  호스트당 URL ${payload.urlsPerHost}개 → 제출 총 ${submit.length * payload.urlsPerHost}개`);
console.log(`  예: ${urlsFor(submit[0]).slice(0, 2).join('  ')} …`);

if (dryRun) { console.log('\n[dry-run] 파일을 쓰지 않는다.'); process.exit(0); }

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`\n  기록: ${outFile}`);

// 키 파일 스테이징 — <호스트>/<키>.txt, 내용은 키 문자열 하나.
if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
for (const host of submit) {
  const dir = join(stageDir, host);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${keys[host]}.txt`), keys[host], 'utf8');
}
console.log(`  스테이징: ${stageDir} (${submit.length}개 호스트 × 1파일)`);
console.log('\n  다음: node scripts/deploy-indexnow-keys.mjs --dry-run');
