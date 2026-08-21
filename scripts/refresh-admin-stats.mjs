#!/usr/bin/env node
/**
 * 관리자 대시보드 통계 머티리얼라이즈드 뷰를 갱신한다.
 *
 *   node scripts/refresh-admin-stats.mjs
 *
 * admin_crawl_page_candidate_counts 는 100만 페이지 다중 조인 집계라 실시간으로
 * 돌리면 호출당 23초씩 DB 를 태운다 (2026-08-21 사태). 갱신은 이 스크립트로만.
 * CONCURRENTLY 라 갱신 중에도 관리자 페이지는 이전 값을 계속 읽는다.
 *
 * 언제 돌리나: 수집요청을 크게 돌린 뒤, 또는 관리자 페이지의 "수집 대상 풀"
 * 숫자가 낡았다 싶을 때. 주기 실행이 필요해지면 스케줄러에 걸면 된다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const projectRoot = process.cwd();
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const connectionString = process.env.DATABASE_URL || env.DATABASE_URL || env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 이 필요합니다.');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  // 역할 기본 2분으로는 부족할 수 있다. config 가 아니라 SET 이어야 서버에 닿는다.
  await client.query(`set statement_timeout = '1200s'`);
  const started = Date.now();
  await client.query('refresh materialized view concurrently public.admin_crawl_page_candidate_counts');
  console.log(`admin_crawl_page_candidate_counts 갱신 (${Math.round((Date.now() - started) / 1000)}초)`);
  const { rows } = await client.query('select * from public.admin_crawl_page_candidate_counts order by target_project');
  console.table(rows);
} finally {
  await client.end();
}
