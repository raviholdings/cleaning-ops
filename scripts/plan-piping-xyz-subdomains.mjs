#!/usr/bin/env node
/**
 * piping-xyz 서브도메인 계획을 만든다 — 알파벳 4자 무작위 라벨.
 *
 *   node scripts/plan-piping-xyz-subdomains.mjs --count 5000 --per-account 100
 *   node scripts/plan-piping-xyz-subdomains.mjs --count 5000 --out C:/.../plan.json --write
 *
 * 왜 4자인가 (2026-09-15 결정)
 *   기존은 단어 두 개를 붙인 방식(readycrayon, cosmoscandle…)이라 라벨이 6~17자였다.
 *   단어 사전 크기에 묶여 조합 수가 제한되고, 사람이 보기에 패턴이 읽힌다.
 *   26^4 = 456,976 개라 필요한 수만 개를 뽑고도 한참 남는다.
 *
 * 생성 규칙
 *   - [a-z] 4자. DNS 라벨로 항상 유효하다 (첫 글자가 문자, 하이픈 없음).
 *   - 시드 해시 기반이라 같은 시드 + 같은 제외목록이면 항상 같은 결과가 나온다.
 *   - DB 에 이미 있는 host 는 제외한다 (기존 5,000개는 6자 이상이라 사실상 안 겹치지만,
 *     이 스크립트를 두 번 돌렸을 때 겹치지 않게 하려면 필요하다).
 *   - 예약 라벨(mail, blog, test…)과 불쾌어는 제외한다. 목록은 아래 상수.
 *
 * 출력은 apply-piping-xyz-subdomains.mjs 가 먹는 모양 그대로다:
 *   { seed, total, perAccount, items: [{ group_key, root, subdomain, host, site_url,
 *                                        naver_account_id, subdomain_generation_strategy }] }
 *
 * 기본은 미리보기만 한다. 파일로 쓰려면 --write.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const GROUP = 'piping-xyz';
const STRATEGY = 'random-4-letters';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const SPACE = ALPHABET.length ** 4;               // 456,976

/* 서브도메인으로 쓰면 곤란한 4자 라벨. 메일·인증서·표준 서비스 이름과 겹치면 사고가 난다. */
const RESERVED = new Set([
  'mail', 'smtp', 'imap', 'pop3', 'news', 'ldap', 'sftp', 'nntp', 'ntpd',
  'blog', 'shop', 'test', 'beta', 'demo', 'docs', 'help', 'apis', 'auth', 'chat',
  'data', 'edge', 'file', 'host', 'info', 'link', 'live', 'main', 'push', 'sync',
  'temp', 'wiki', 'work', 'user', 'root', 'site', 'home', 'mx01', 'mx02', 'ns01',
  'ns02', 'dns1', 'dns2', 'www1', 'www2', 'web1', 'web2', 'ipv4', 'ipv6', 'acme',
]);

/* 영어권에서 불쾌하게 읽히는 4자 조합. 사업용 주소라 피한다. */
const BLOCKED = new Set([
  'fuck', 'shit', 'cunt', 'dick', 'cock', 'piss', 'slut', 'rape', 'nazi', 'kill',
  'anal', 'porn', 'hell', 'damn', 'turd', 'jerk', 'crap', 'wank', 'twat', 'fags',

  /*
   * fast — Hai-IP VPN 이 막는다 (2026-09-15 실측).
   * 호스트명에 fast 가 들어가면 앞뒤 위치와 무관하게 연결이 죽는다.
   * DNS 는 정상(115.140.73.75)인데 TLS 단계에서 20초 타임아웃 → SNI 기반 차단으로 보인다.
   *   fastglobe / fastharbor / fastaqua / atlasfast  전부 http=000
   *   대조군 goatcloud / troutblue                    http=200 (0.1초)
   * 속도측정 사이트(fast.com) 차단 규칙에 걸리는 것으로 추정.
   * 소유확인 자체는 네이버가 자기 쪽에서 페이지를 받아가므로 성공할 수 있으나,
   * 우리 스크립트의 메타태그 사전점검이 VPN 을 타서 막힌다.
   * 기존에 만들어진 18건은 그대로 둔다 (사용자 결정 2026-09-15).
   */
  'fast',
]);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };

const count = Number(value('--count', 0));
const perAccount = Number(value('--per-account', 100));
const seed = String(value('--seed', 'piping-xyz-4letters-v1'));
const configPath = String(value('--config', 'C:/Users/LD/Desktop/ravi/cleaning-ops/config/piping-xyz.json'));
const write = flag('--write');

if (!Number.isSafeInteger(count) || count < 1) throw new Error('--count <개수> 가 필요합니다.');
if (!Number.isSafeInteger(perAccount) || perAccount < 1) throw new Error('--per-account 가 잘못됐습니다.');

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const roots = config.domains.map((d) => (typeof d === 'string' ? d : d.host || d.root));
if (!roots.length) throw new Error('config 에 도메인이 없습니다.');
const outPath = String(value('--out', config.planFile));

/* ---------- 라벨 생성: 시드 해시로 4자 공간을 결정적으로 훑는다 ---------- */
function labelAt(n) {                              // 0..SPACE-1 -> 'abcd'
  let x = n; let s = '';
  for (let i = 0; i < 4; i += 1) { s = ALPHABET[x % 26] + s; x = Math.floor(x / 26); }
  return s;
}
function hashInt(str) {
  return parseInt(createHash('sha256').update(str).digest('hex').slice(0, 13), 16);
}
/*
 * 같은 시드면 같은 순서가 나오도록, 해시로 시작점과 보폭을 정해 공간을 한 바퀴 돈다.
 * 보폭이 SPACE 와 서로소라 중복 없이 전부 방문한다 (SPACE = 26^4 = 2^4 * 13^4).
 * → 보폭을 홀수이면서 13의 배수가 아닌 값으로 잡으면 된다.
 */
function makeWalk(seedStr) {
  const start = hashInt(`${seedStr}:start`) % SPACE;
  let step = (hashInt(`${seedStr}:step`) % SPACE) | 1;             // 홀수로
  while (step % 13 === 0) step += 2;                               // 13 배수 회피
  return (i) => labelAt((start + step * i) % SPACE);
}

/* ---------- 이미 쓰고 있는 라벨 (DB) ---------- */
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops.sh 로 실행)');
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('안전장치: 로컬 DB 가 아닙니다. 중단.');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
let takenHosts;
let accounts;
try {
  takenHosts = new Set((await c.query('select host from naver_project_domains')).rows.map((r) => r.host));
  /*
   * 받을 계정: 활성이면서 이 그룹의 서브도메인을 아직 perAccount 만큼 안 들고 있는 계정.
   * 적게 들고 있는 계정부터 채운다.
   */
  accounts = (await c.query(
    `select a.account_id, a.account_order,
            count(d.*) filter (where d.group_key = $1) held
       from naver_searchadvisor_accounts a
       left join naver_project_domains d on d.naver_account_id = a.account_id
      where a.status = 'active'
      group by 1, 2
     having count(d.*) filter (where d.group_key = $1) < $2
      order by held asc, a.account_order asc`,
    [GROUP, perAccount],
  )).rows;
} finally { await c.end(); }

if (!accounts.length) throw new Error(`여유 계정이 없습니다 (활성이면서 ${perAccount}개 미만 보유인 계정 0).`);
const capacity = accounts.reduce((sum, a) => sum + (perAccount - Number(a.held)), 0);
if (capacity < count) {
  throw new Error(`계정 수용량 부족: 요청 ${count} / 가능 ${capacity} (활성 계정 ${accounts.length}개). --count 를 줄이거나 계정을 늘리세요.`);
}

/* ---------- 조립 ---------- */
const walk = makeWalk(seed);
const items = [];
const used = new Set();
let cursor = 0;
let rejected = { taken: 0, reserved: 0, blocked: 0, dup: 0 };

// 계정별 남은 자리
const slots = accounts.map((a) => ({ id: a.account_id, order: a.account_order, left: perAccount - Number(a.held) }));
let si = 0;

for (let made = 0; made < count; ) {
  if (cursor >= SPACE) throw new Error('4자 공간을 다 썼습니다. 시드를 바꾸거나 자릿수를 늘리세요.');
  const label = walk(cursor); cursor += 1;

  if (RESERVED.has(label)) { rejected.reserved += 1; continue; }
  if (BLOCKED.has(label)) { rejected.blocked += 1; continue; }
  if (used.has(label)) { rejected.dup += 1; continue; }

  // 라벨 하나를 5개 루트 중 하나에 붙인다 — 루트를 돌아가며 균등 배분
  const root = roots[made % roots.length];
  const host = `${label}.${root}`;
  if (takenHosts.has(host)) { rejected.taken += 1; continue; }

  while (si < slots.length && slots[si].left <= 0) si += 1;
  if (si >= slots.length) throw new Error('계정 자리가 모자랍니다.');
  const acct = slots[si];

  items.push({
    group_key: GROUP,
    root,
    subdomain: label,
    host,
    site_url: `https://${host}`,
    naver_account_id: acct.id,
    subdomain_generation_strategy: STRATEGY,
  });
  used.add(label);
  acct.left -= 1;
  made += 1;
}

const plan = { seed, strategy: STRATEGY, total: items.length, perAccount, items };

/* ---------- 보고 ---------- */
const byRoot = {};
const byAcct = {};
for (const it of items) {
  byRoot[it.root] = (byRoot[it.root] || 0) + 1;
  byAcct[it.naver_account_id] = (byAcct[it.naver_account_id] || 0) + 1;
}
console.log(`전략: ${STRATEGY}  시드: ${seed}`);
console.log(`생성: ${items.length}건   공간: ${SPACE.toLocaleString()} (26^4)`);
console.log(`걸러낸 것: 예약어 ${rejected.reserved} / 불쾌어 ${rejected.blocked} / 기존중복 ${rejected.taken} / 라벨중복 ${rejected.dup}`);
console.log('루트별:'); for (const [k, v] of Object.entries(byRoot)) console.log(`  ${k}: ${v}`);
console.log(`계정: ${Object.keys(byAcct).length}개 (계정당 최대 ${perAccount})`);
console.log('샘플 10개:'); items.slice(0, 10).forEach((x) => console.log(`  ${x.host}  -> ${x.naver_account_id}`));

if (write) {
  writeFileSync(outPath, JSON.stringify(plan, null, 1), 'utf8');
  console.log(`\n계획 파일 기록: ${outPath}`);
  console.log('다음: node scripts/apply-piping-xyz-subdomains.mjs --dry-run  (확인 후 --apply)');
} else {
  console.log('\n미리보기만 했습니다. 파일로 쓰려면 --write 를 붙이세요.');
}
