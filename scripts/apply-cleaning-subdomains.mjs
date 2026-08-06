#!/usr/bin/env node
// Seed accounts / domains / keywords for the cleaning-ravi project group.
//
//   node scripts/seed-cleaning-ops-data.mjs --dry-run   # 무엇이 몇 건 들어가는지만 출력
//   node scripts/seed-cleaning-ops-data.mjs             # 실제 적용
//
// Sources (경로는 플래그로 덮어쓸 수 있음):
//   --accounts  "C:/Users/LD/Desktop/해외비실 500ea.csv"
//   --keywords  "C:/Users/LD/Desktop/ravi/청소 키워드.txt"
//
// 도메인 10개와 계정 배정은 아래 DOMAINS 상수에 고정되어 있다. CSV 상위 10개
// 계정이 목록 순서대로 1:1 배정된다.
//
// 전 구간이 단일 트랜잭션이며 upsert라서 재실행해도 안전하다.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const accountsPath = optionValue('--accounts') || 'C:/Users/LD/Desktop/해외비실 500ea.csv';
const keywordsPath = optionValue('--keywords') || 'C:/Users/LD/Desktop/ravi/청소 키워드.txt';

const GROUP_KEY = 'cleaning-ravi';
const PROJECT_KEY = 'cleaning-ravi';
const TARGET_PROJECT = 'cleaning-ravi';

/** 배정 순서 = CSV 행 순서. i번째 도메인 <- i번째 계정. */
const DOMAINS = [
  'amunsa.com',
  'anclose.com',
  'daddul.com',
  'ddulea.com',
  'naoheg.com',
  'neverfoul.com',
  'one-qfast.com',
  'oneshot-sewer.com',
  'pipe-oneshot.com',
  'uloung.com',
];

loadLocalEnv('.env');

// ── 소스 파싱 ────────────────────────────────────────────────────────────────
const accounts = parseAccountsCsv(accountsPath);
const keywords = parseKeywords(keywordsPath);

if (accounts.length < DOMAINS.length) {
  throw new Error(`계정이 ${accounts.length}개뿐이라 도메인 ${DOMAINS.length}개를 배정할 수 없습니다`);
}

const assignments = DOMAINS.map((host, index) => ({
  host,
  siteUrl: `https://${host}`,
  accountId: accounts[index].accountId,
  accountName: accounts[index].personalName,
}));

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        groupKey: GROUP_KEY,
        sources: { accountsPath, keywordsPath },
        counts: {
          accounts: accounts.length,
          domains: assignments.length,
          keywords: keywords.length,
        },
        accountSample: accounts.slice(0, 3).map(redactAccount),
        assignments,
        keywordSample: keywords.slice(0, 8),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// ── 적용 ─────────────────────────────────────────────────────────────────────
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const { rowCount: groupExists } = await client.query(
    'select 1 from public.naver_project_groups where group_key = $1',
    [GROUP_KEY],
  );
  if (!groupExists) {
    throw new Error(`naver_project_groups 행이 없습니다: ${GROUP_KEY}. 먼저 npm run db:migrate`);
  }

  await client.query('begin');

  // 1. 계정 -------------------------------------------------------------------
  await client.query(
    `
      insert into public.naver_searchadvisor_accounts (
        account_id, account_order, password_plain, status,
        personal_name, personal_birth_date, personal_gender,
        personal_info_source, personal_info_imported_at, notes
      )
      select
        input.account_id,
        input.account_order,
        input.password_plain,
        input.status,
        nullif(input.personal_name, ''),
        nullif(input.personal_birth_date, '')::date,
        nullif(input.personal_gender, ''),
        $2,
        now(),
        nullif(input.notes, '')
      from jsonb_to_recordset($1::jsonb) as input(
        account_id text,
        account_order integer,
        password_plain text,
        status text,
        personal_name text,
        personal_birth_date text,
        personal_gender text,
        notes text
      )
      on conflict (account_id) do update set
        password_plain = excluded.password_plain,
        status = excluded.status,
        personal_name = excluded.personal_name,
        personal_birth_date = excluded.personal_birth_date,
        personal_gender = excluded.personal_gender,
        personal_info_source = excluded.personal_info_source,
        personal_info_imported_at = excluded.personal_info_imported_at,
        notes = excluded.notes,
        updated_at = now()
    `,
    [JSON.stringify(accounts.map(toAccountRow)), sourceLabel(accountsPath)],
  );

  // 2. 도메인 -----------------------------------------------------------------
  await client.query(
    `
      insert into public.naver_project_domains (
        group_key, project_key, target_project, host, site_url,
        naver_account_id, deployment_status, is_visible,
        subdomain_generation_strategy, naver_registration_status,
        source_table
      )
      select
        $1, $2, $3, input.host, input.site_url,
        input.account_id, 'active', true,
        'manual', 'pending',
        'cleaning-ops-seed'
      from jsonb_to_recordset($4::jsonb) as input(
        host text,
        site_url text,
        account_id text
      )
      on conflict (host) do update set
        group_key = excluded.group_key,
        project_key = excluded.project_key,
        target_project = excluded.target_project,
        site_url = excluded.site_url,
        naver_account_id = excluded.naver_account_id,
        updated_at = now()
    `,
    [
      GROUP_KEY,
      PROJECT_KEY,
      TARGET_PROJECT,
      JSON.stringify(
        assignments.map((row) => ({
          host: row.host,
          site_url: row.siteUrl,
          account_id: row.accountId,
        })),
      ),
    ],
  );

  // 3. 메인 키워드 -------------------------------------------------------------
  await client.query(
    `
      insert into public.naver_page_keywords (name)
      select value from unnest($1::text[]) as input(value)
      on conflict (name) do nothing
    `,
    [keywords],
  );

  await client.query('commit');

  const summary = await client.query(`
    select
      (select count(*)::int from public.naver_searchadvisor_accounts) as accounts,
      (select count(*)::int from public.naver_project_domains where group_key = 'cleaning-ravi') as domains,
      (select count(*)::int from public.naver_page_keywords) as keywords
  `);
  console.log(JSON.stringify({ applied: true, totals: summary.rows[0] }, null, 2));
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

// ── helpers ──────────────────────────────────────────────────────────────────
function parseAccountsCsv(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new Error(`${path} 에 데이터 행이 없습니다`);

  const header = lines[0].split(',').map((cell) => cell.trim());
  const expected = ['아이디', '비밀번호', '이름', '생년월일', '성별', '생성일', '구매일'];
  if (header.join(',') !== expected.join(',')) {
    throw new Error(`CSV 헤더가 예상과 다릅니다.\n  기대: ${expected.join(',')}\n  실제: ${header.join(',')}`);
  }

  const seen = new Set();
  return lines.slice(1).map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== expected.length) {
      throw new Error(`${index + 2}행 컬럼 수가 ${cells.length}개입니다 (기대 ${expected.length})`);
    }
    const [accountId, password, name, birthDate, gender, createdDate, purchasedDate] = cells;
    if (!accountId || !password) throw new Error(`${index + 2}행: 아이디 또는 비밀번호가 비어 있습니다`);
    if (seen.has(accountId)) throw new Error(`${index + 2}행: 아이디 중복 ${accountId}`);
    seen.add(accountId);
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      throw new Error(`${index + 2}행: 생년월일 형식 오류 ${birthDate}`);
    }

    return {
      accountId,
      password,
      personalName: name,
      personalBirthDate: birthDate,
      personalGender: gender,
      createdDate,
      purchasedDate,
      accountOrder: index + 1,
    };
  });
}

function toAccountRow(account) {
  const notes = [
    account.createdDate ? `생성일=${account.createdDate}` : '',
    account.purchasedDate ? `구매일=${account.purchasedDate}` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    account_id: account.accountId,
    account_order: account.accountOrder,
    password_plain: account.password,
    status: 'active',
    personal_name: account.personalName,
    personal_birth_date: account.personalBirthDate,
    personal_gender: account.personalGender,
    notes,
  };
}

function redactAccount(account) {
  return {
    accountId: account.accountId,
    accountOrder: account.accountOrder,
    password: '***',
    personalName: account.personalName,
    personalBirthDate: account.personalBirthDate,
    personalGender: account.personalGender,
  };
}

function parseKeywords(path) {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const unique = [...new Set(raw)];
  if (unique.length !== raw.length) {
    console.error(`경고: 키워드 ${raw.length - unique.length}건 중복을 제거했습니다`);
  }
  return unique;
}

function sourceLabel(path) {
  return path.split(/[\\/]/).pop() || path;
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function loadLocalEnv(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
