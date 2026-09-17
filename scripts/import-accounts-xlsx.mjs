#!/usr/bin/env node
/**
 * 엑셀에 받은 네이버 계정을 naver_searchadvisor_accounts 에 넣는다.
 *
 *   node scripts/import-accounts-xlsx.mjs --file C:/.../domestic-xyz-accout.xlsx            # 미리보기
 *   node scripts/import-accounts-xlsx.mjs --file ... --apply                                 # 실제 삽입
 *   node scripts/import-accounts-xlsx.mjs --file ... --apply --start-order 85 --note '국내 2026-09'
 *
 * 엑셀 형식 (1행이 머리글, 2행부터 자료)
 *   아이디 | 비밀번호 | 이름 | 생년월일 | 성별 | 전화번호 | 유심번호 | 생성일시
 *
 * account_order 는 DB 의 최대값 다음부터 이어 붙인다 (--start-order 로 지정 가능).
 * 이미 있는 account_id 는 건드리지 않는다.
 *
 * 비밀번호는 화면에 찍지 않는다. 대화·로그에 남으면 안 된다.
 */
import { existsSync } from 'node:fs';
import pg from 'pg';
import XLSX from 'xlsx';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const val = (name, fb = null) => { const i = args.indexOf(name); return i === -1 ? fb : args[i + 1]; };

const file = val('--file');
if (!file || !existsSync(file)) throw new Error('--file <엑셀 경로> 가 필요합니다.');
const note = String(val('--note', ''));
const identityType = String(val('--identity-type', '비실계'));
const startOrderOpt = val('--start-order');

const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요');

/* ---------- 엑셀 읽기 ---------- */
const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
// 1행이 머리글이라 header:1 로 배열째 읽고 2행부터 쓴다 (머리글 칸 이름이 __EMPTY 로 깨져 나옴)
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
const head = grid[1] ? grid[0] : [];
const rows = grid.slice(2);

const pick = (r, i) => String(r[i] ?? '').trim();
const parsed = rows
  .map((r) => ({
    account_id: pick(r, 0),
    password_plain: pick(r, 1),
    personal_name: pick(r, 2),
    birth: pick(r, 3),
    gender: pick(r, 4),
    phone: pick(r, 5),
    sim: pick(r, 6),
  }))
  .filter((x) => x.account_id && x.password_plain);

/** 생년월일: 엑셀 일련번호 · YYYY-MM-DD · YYYYMMDD 를 모두 받는다. */
function toDate(v) {
  if (!v) return null;
  if (/^\d{5}$/.test(v)) {                                  // 엑셀 일련번호
    const d = XLSX.SSF.parse_date_code(Number(v));
    return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null;
  }
  const m = v.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const toGender = (v) => (/여|f/i.test(v) ? 'FEMALE' : /남|m/i.test(v) ? 'MALE' : null);

console.log(`파일: ${file}`);
console.log(`머리글: ${head.filter(Boolean).join(' | ')}`);
console.log(`읽은 계정: ${parsed.length}개`);

const c = new pg.Client({ connectionString: url, ssl: url.includes('127.0.0.1') ? false : { rejectUnauthorized: false } });
await c.connect();
try {
  const exists = (await c.query(
    'select account_id from naver_searchadvisor_accounts where account_id = any($1::text[])',
    [parsed.map((x) => x.account_id)],
  )).rows.map((r) => r.account_id);
  const fresh = parsed.filter((x) => !exists.includes(x.account_id));

  const maxOrder = Number((await c.query('select coalesce(max(account_order), 0) m from naver_searchadvisor_accounts')).rows[0].m);
  const startOrder = startOrderOpt ? Number(startOrderOpt) : maxOrder + 1;

  console.log(`이미 있음: ${exists.length}개 (건너뜀)`);
  console.log(`새로 넣을 것: ${fresh.length}개`);
  console.log(`account_order: ${startOrder} ~ ${startOrder + fresh.length - 1}  (현재 최대 ${maxOrder})`);
  console.log('\n미리보기 3개 (비밀번호는 안 보임):');
  fresh.slice(0, 3).forEach((x, i) => console.log(
    `  #${startOrder + i}  ${x.account_id.padEnd(16)}${(x.personal_name || '-').padEnd(20)}`
    + `${toDate(x.birth) || '-'}  ${toGender(x.gender) || '-'}  ${x.phone || '-'}`));

  if (!fresh.length) { console.log('\n넣을 게 없습니다.'); process.exit(0); }
  if (!apply) { console.log('\n미리보기만 했습니다. 실제로 넣으려면 --apply'); process.exit(0); }

  await c.query('begin');
  let n = 0;
  for (const [i, x] of fresh.entries()) {
    await c.query(
      `insert into naver_searchadvisor_accounts
         (account_id, account_order, account_identity_type, status,
          password_plain, personal_name, personal_birth_date, personal_gender,
          phone, personal_info_source, personal_info_imported_at, notes)
       values ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,now(),$10)`,
      [x.account_id, startOrder + i, identityType, x.password_plain,
        x.personal_name || null, toDate(x.birth), toGender(x.gender),
        x.phone || null, file.split(/[\\/]/).pop(), note || null],
    );
    n += 1;
  }
  const after = Number((await c.query('select count(*) n from naver_searchadvisor_accounts')).rows[0].n);
  console.log(`\n삽입 ${n}개 / 전체 계정 ${after}개`);
  await c.query('commit');
  console.log('COMMIT 완료');
} catch (e) {
  await c.query('rollback').catch(() => {});
  console.error('오류:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
