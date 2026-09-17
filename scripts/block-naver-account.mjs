#!/usr/bin/env node
/**
 * 계정을 차단(blocked) 처리한다. 차단된 계정은 캡쳐·등록·소유확인·수집요청에서 전부 빠진다.
 *
 *   node scripts/block-naver-account.mjs --accounts 16
 *   node scripts/block-naver-account.mjs --accounts 11,12,13,18-20
 *   node scripts/block-naver-account.mjs --account jkblp3082,sqlcz2705
 *   node scripts/block-naver-account.mjs --accounts 16 --reason "세션 사망 (로그인 화면 튕김)"
 *   node scripts/block-naver-account.mjs --accounts 16 --unblock     # 되돌리기
 *
 * --accounts 는 순번(account_order), --account 는 아이디. 범위(18-20)와 쉼표 나열 모두 된다.
 * 기본 사유는 "보호조치/세션 사망 — 재로그인 금지". 담당 서브도메인은 건드리지 않는다
 * (주인 잃은 건수를 마지막에 알려주므로, 예비 계정으로 넘길지는 따로 정한다).
 */
import pg from 'pg';

const args = process.argv.slice(2);
const valueOf = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1]; };
const unblock = args.includes('--unblock');
const orders = valueOf('--accounts', '');
const ids = valueOf('--account', '');
const today = new Date().toISOString().slice(0, 10);
const reason = valueOf('--reason', unblock ? `차단 해제 ${today}` : `보호조치/세션 사망 ${today} — 재로그인 금지`);
if (!orders && !ids) throw new Error('--accounts <순번> 또는 --account <아이디> 가 필요합니다.');

const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops 래퍼로 실행)');
// 2026-09-17: 정본이 로컬에서 Supabase 로 옮겨갔다 (VM 3대가 붙어야 해서).
// 실수로 엉뚱한 DB 를 건드리지 않게 이름으로만 확인한다.
if (!/naver_hub|supabase/.test(url)) throw new Error('안전장치: 모르는 DB 입니다. 중단.');

const orderList = [];
for (const part of orders.split(',').map((s) => s.trim()).filter(Boolean)) {
  const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) { for (let n = Number(range[1]); n <= Number(range[2]); n += 1) orderList.push(n); }
  else if (/^\d+$/.test(part)) orderList.push(Number(part));
  else throw new Error(`순번 형식이 이상합니다: ${part}`);
}
const idList = ids.split(',').map((s) => s.trim()).filter(Boolean);

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const { rows: before } = await c.query(
    `select account_order, account_id, status,
            (select count(*) from naver_project_domains d where d.naver_account_id = a.account_id) as domains
       from naver_searchadvisor_accounts a
      where a.account_order = any($1::int[]) or a.account_id = any($2::text[])
      order by a.account_order`, [orderList, idList]);
  if (!before.length) throw new Error('해당하는 계정이 없습니다.');

  const target = before.filter((r) => (unblock ? r.status === 'blocked' : r.status !== 'blocked'));
  for (const r of before) {
    const mark = target.some((t) => t.account_id === r.account_id) ? '→ 변경' : '(그대로)';
    console.log(`  #${r.account_order} ${r.account_id}  ${r.status}  담당 ${r.domains}건  ${mark}`);
  }
  if (!target.length) { console.log('바꿀 계정이 없습니다.'); process.exit(0); }

  const res = await c.query(
    `update naver_searchadvisor_accounts
        set status = $2,
            notes = coalesce(notes, '') || ' | ' || $3,
            updated_at = now()
      where account_id = any($1::text[]) and status <> $2
      returning account_order, account_id, status`,
    [target.map((t) => t.account_id), unblock ? 'active' : 'blocked', reason]);

  console.log(`\n${unblock ? '해제' : '차단'} ${res.rowCount}건`);
  const { rows: sum } = await c.query(
    `select count(*) filter (where status = 'active') as active,
            count(*) filter (where status = 'blocked') as blocked,
            count(*) filter (where status = 'active' and notes = '예비 (미배정)') as spare
       from naver_searchadvisor_accounts`);
  const { rows: orphan } = await c.query(
    `select split_part(d.host, '.', -2) || '.' || split_part(d.host, '.', -1) as root, count(*) as n
       from naver_project_domains d
       join naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
      where a.status = 'blocked' and d.host like '%.%.%'
      group by 1 order by 2 desc`);
  console.log(`계정: 활성 ${sum[0].active} / 차단 ${sum[0].blocked} / 예비 ${sum[0].spare}`);
  if (orphan.length) {
    console.log('주인 잃은 서브도메인:');
    for (const o of orphan) console.log(`  ${o.root}  ${o.n}건`);
  } else {
    console.log('주인 잃은 서브도메인 없음');
  }
} finally { await c.end(); }
