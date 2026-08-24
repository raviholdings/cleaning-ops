#!/usr/bin/env node
/**
 * 배관 접수폼 경로 점검 — DB 저장 + 텔레그램 알림이 실제로 되는지 확인한다.
 *
 * Worker(workers/piping-lead)와 같은 검증 규칙·같은 행 모양을 쓴다. Worker 는
 * Supabase REST 로 넣고 여기서는 pg 로 넣는 차이뿐이라, 컬럼 매핑·알림 형식을
 * 배포 전에 그대로 확인할 수 있다.
 *
 *   node scripts/test-piping-lead-flow.mjs              # 검증 규칙만 (쓰기 없음)
 *   node scripts/test-piping-lead-flow.mjs --live       # 실제 저장 + 알림 후 되돌림
 *   node scripts/test-piping-lead-flow.mjs --live --keep  # 시험 행을 남겨둠
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const keep = args.includes('--keep');

const env = Object.fromEntries(
  readFileSync(resolve(projectRoot, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const secretPath = 'C:/Users/LD/Desktop/ravi/_secure/piping-telegram-bot.txt';
const secret = readFileSync(secretPath, 'utf8');
const TELEGRAM_BOT_TOKEN = secret.match(/BOT_TOKEN\s*=\s*(\S+)/)[1];
const TELEGRAM_CHAT_ID = secret.match(/CHAT_ID\s*=\s*(\S+)/)[1];

/* ── Worker 와 동일한 검증 (worker.js validate) ── */
const digits = (v) => String(v || '').replace(/\D+/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

function validate(payload) {
  if (clean(payload.company, 100)) return { drop: true };
  const name = clean(payload.name, 60);
  const phone = digits(payload.phone);
  const message = clean(payload.message, 2000);
  if (name.length < 2) return { error: '이름을 입력해 주세요.' };
  if (phone.length < 9 || phone.length > 11) return { error: '연락처를 정확히 입력해 주세요.' };
  if (!message) return { error: '문의내용을 입력해 주세요.' };
  if (payload.consent !== true) return { error: '개인정보 수집 및 이용에 동의해 주세요.' };
  return { name, phone, message };
}

/* ── 1. 검증 규칙 점검 ── */
const good = {
  name: '홍길동', phone: '01012345678', message: '싱크대가 막혀서 물이 안 내려갑니다.',
  consent: true, company: '', area: '서울 강남구 역삼동',
  pageUrl: 'https://prism-bamboo.daddul.com/배관/강남구-역삼동/싱크대막힘',
  referrer: 'https://search.naver.com/', sourceDomain: 'prism-bamboo.daddul.com',
};

const cases = [
  ['정상 접수', good, 'pass'],
  ['이름 없음', { ...good, name: '' }, 'error'],
  ['연락처 짧음', { ...good, phone: '0101234' }, 'error'],
  ['내용 없음', { ...good, message: '' }, 'error'],
  ['미동의', { ...good, consent: false }, 'error'],
  ['허니팟(봇)', { ...good, company: 'spam-bot' }, 'drop'],
];

console.log('=== 1. 검증 규칙 ===');
let failed = 0;
for (const [label, payload, expect] of cases) {
  const r = validate(payload);
  const got = r.drop ? 'drop' : r.error ? 'error' : 'pass';
  const ok = got === expect;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(12)} -> ${got}${r.error ? ' (' + r.error + ')' : ''}`);
}
if (failed) { console.error(`검증 규칙 ${failed}건 실패`); process.exit(1); }

/* ── 2. 저장할 행 (Worker 와 동일한 매핑) ── */
const checked = validate(good);
const row = {
  group_key: 'piping-ravi',
  host: good.sourceDomain,
  site_url: good.pageUrl,
  area_name: good.area,
  customer_name: checked.name,
  customer_phone: checked.phone,
  service_type: 'form:piping',
  request_notes: `${checked.message} [점검용 시험 접수]`,
  referer: good.referrer,
  user_agent: 'piping-lead-flow-test',
};

console.log('\n=== 2. 저장할 행 ===');
console.log(JSON.stringify(row, null, 1));

if (!live) {
  console.log('\n--live 를 붙이면 실제 저장 + 텔레그램 발송까지 합니다 (지금은 쓰기 없음).');
  process.exit(0);
}

/* ── 3. DB 저장 ── */
const client = new pg.Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
await client.query("set statement_timeout = '30s'");

const before = (await client.query('select count(*)::int n from lead_submissions')).rows[0].n;
const inserted = await client.query(
  `insert into lead_submissions
     (group_key, host, site_url, area_name, customer_name, customer_phone,
      service_type, request_notes, referer, user_agent)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   returning id, created_at`,
  [row.group_key, row.host, row.site_url, row.area_name, row.customer_name,
    row.customer_phone, row.service_type, row.request_notes, row.referer, row.user_agent],
);
const { id, created_at: createdAt } = inserted.rows[0];

const readBack = (await client.query(
  'select group_key, host, area_name, customer_name, customer_phone, service_type, request_notes from lead_submissions where id = $1',
  [id],
)).rows[0];
const after = (await client.query('select count(*)::int n from lead_submissions')).rows[0].n;

console.log('\n=== 3. DB 저장 ===');
console.log(`  행 수 ${before} -> ${after}`);
console.log(`  id ${id} / ${createdAt.toISOString()}`);
console.log('  되읽기:', JSON.stringify(readBack));

/* ── 4. 텔레그램 알림 (Worker 와 동일한 형식) ── */
const kst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
const text = [
  '🔧 [배관] 상담 접수  ※ 연동 점검용 시험 발송',
  `이름: ${row.customer_name}`,
  `연락처: ${row.customer_phone}`,
  `지역: ${row.area_name}`,
  `내용: ${row.request_notes}`,
  `유입: ${row.host}`,
  `페이지: ${row.site_url}`,
  `시각: ${kst} KST`,
].join('\n');

const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
});
const tgBody = await tg.json();
console.log('\n=== 4. 텔레그램 알림 ===');
console.log(`  HTTP ${tg.status} ok=${tgBody.ok}` + (tgBody.ok ? ` message_id=${tgBody.result.message_id} chat=${tgBody.result.chat.title}` : ` ${tgBody.description}`));

/* ── 5. 시험 행 정리 ── */
if (keep) {
  console.log('\n=== 5. 정리 === --keep 이라 시험 행을 남겨둡니다. id =', id);
} else {
  await client.query('delete from lead_submissions where id = $1', [id]);
  const final = (await client.query('select count(*)::int n from lead_submissions')).rows[0].n;
  console.log(`\n=== 5. 정리 === 시험 행 삭제. 행 수 ${after} -> ${final} (원래대로)`);
}

await client.end();
console.log('\n결과: DB 저장 OK · 텔레그램 ' + (tgBody.ok ? 'OK' : '실패'));
