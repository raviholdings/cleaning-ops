#!/usr/bin/env node
/**
 * piping-xyz(.xyz 허브 5개) 서브도메인 계획을 naver_project_domains 에 적용한다.
 * 계획 파일: C:/Users/LD/Desktop/naver/reports/piping-xyz-subdomain-plan.json
 *
 *   node scripts/apply-piping-xyz-subdomains.mjs --dry-run   # 넣어보고 롤백 (기본)
 *   node scripts/apply-piping-xyz-subdomains.mjs --apply     # 실제 커밋
 *
 * 전부 한 트랜잭션. 삽입 전후 행수를 대조해 예상과 다르면 커밋하지 않는다.
 * DATABASE_URL 은 환경변수(naverops.sh)로 로컬 naver_hub 를 가리켜야 한다.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const planPath = (() => { const i = args.indexOf('--plan'); return i === -1 ? 'C:/Users/LD/Desktop/naver/reports/piping-xyz-subdomain-plan.json' : args[i + 1]; })();
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops.sh 로 실행)');
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('안전장치: 로컬 DB 가 아닙니다. 중단.');

const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const items = plan.items || [];
if (!items.length) throw new Error('계획이 비어있습니다.');
const hosts = new Set(items.map((x) => x.host));
if (hosts.size !== items.length) throw new Error('계획에 중복 host 있음');

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query('begin');
  const before = Number((await c.query(`select count(*) from naver_project_domains where group_key='piping-xyz'`)).rows[0].count);
  const already = Number((await c.query(`select count(*) from naver_project_domains where host = any($1::text[])`, [[...hosts]])).rows[0].count);
  // 계정 존재 확인
  const accts = [...new Set(items.map((x) => x.naver_account_id))];
  const have = (await c.query(`select account_id from naver_searchadvisor_accounts where account_id = any($1::text[])`, [accts])).rows.map((r) => r.account_id);
  const missing = accts.filter((a) => !have.includes(a));
  if (missing.length) throw new Error('DB 에 없는 계정: ' + missing.join(','));

  const CHUNK = 500; let inserted = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const vals = []; const params = [];
    chunk.forEach((x, k) => {
      const b = k * 7;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},'naver','pending')`);
      params.push(x.group_key, x.group_key, x.group_key, x.host, x.site_url, x.naver_account_id, x.subdomain_generation_strategy);
    });
    const r = await c.query(
      `insert into naver_project_domains (group_key, project_key, target_project, host, site_url, naver_account_id, subdomain_generation_strategy, provider, naver_registration_status)
       values ${vals.join(',')} on conflict (host) do nothing`, params);
    inserted += r.rowCount;
  }
  const after = Number((await c.query(`select count(*) from naver_project_domains where group_key='piping-xyz'`)).rows[0].count);
  const expected = before + (items.length - already);
  console.log(JSON.stringify({ plan: items.length, alreadyExisted: already, before, inserted, after, expected }));
  if (after !== expected) { await c.query('rollback'); throw new Error(`행수 불일치 (after=${after}, expected=${expected}) → 롤백`); }
  if (apply) { await c.query('commit'); console.log('COMMIT 완료'); }
  else { await c.query('rollback'); console.log('DRY-RUN: 롤백함 (실제 적용은 --apply)'); }
} catch (e) { try { await c.query('rollback'); } catch {} throw e; }
finally { await c.end(); }
