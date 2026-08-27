#!/usr/bin/env node
/**
 * 프로젝트 그룹의 수집요청 스위치를 켜고 끈다.
 *
 *   node scripts/set-crawl-enabled.mjs                              # 현재 상태만 본다
 *   node scripts/set-crawl-enabled.mjs --on  piping-ravi piping-ravi-shared
 *   node scripts/set-crawl-enabled.mjs --off cleaning-ravi
 *
 * 러너(run-*-crawl-range.ps1)는 crawl_request_enabled = true 인 그룹만 대상으로
 * 잡는다. false 면 조용히 0건으로 끝나서 원인을 찾느라 시간을 버리기 쉽다.
 *
 * 배관 두 그룹은 배포·소유확인 전에 URL 이 새어 나가지 않게 false 로 두었다.
 * 배포가 끝나고 사이트맵이 새 주소로 갈린 뒤에 켠다.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const out = {};
  for (const line of readFileSync(resolve(projectRoot, '.env'), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
  return out;
}

const args = process.argv.slice(2);
const on = args.includes('--on');
const off = args.includes('--off');
const groups = args.filter((a) => !a.startsWith('--'));

if (on && off) throw new Error('--on 과 --off 를 같이 줄 수 없습니다.');
if ((on || off) && !groups.length) throw new Error('그룹을 하나 이상 지정하세요. 예: --on piping-ravi');

const env = loadEnv();
const client = new pg.Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
await client.query("set statement_timeout = '30s'");

try {
  if (on || off) {
    const value = on;
    // 없는 그룹 이름을 조용히 넘기지 않는다 — 오타면 여기서 멈춰야 한다.
    const found = await client.query(
      'select group_key from public.naver_project_groups where group_key = any($1)',
      [groups],
    );
    const missing = groups.filter((g) => !found.rows.some((r) => r.group_key === g));
    if (missing.length) throw new Error(`없는 그룹: ${missing.join(', ')}`);

    const updated = await client.query(
      `update public.naver_project_groups
          set crawl_request_enabled = $1, updated_at = now()
        where group_key = any($2)
        returning group_key, crawl_request_enabled`,
      [value, groups],
    );
    console.log(`${value ? '켬' : '끔'}: ${updated.rows.map((r) => r.group_key).join(', ')}`);
  }

  const all = await client.query(
    `select group_key, crawl_request_enabled, index_check_enabled,
            settings->>'sitemapPath' as sitemap_path
       from public.naver_project_groups order by run_order, group_key`,
  );
  console.log('\n현재 상태');
  for (const r of all.rows) {
    console.log(
      `  ${r.crawl_request_enabled ? '✅ 켜짐' : '⛔ 꺼짐'}  ${r.group_key.padEnd(20)}`
      + `  사이트맵: ${r.sitemap_path || '(postId 방식)'}`,
    );
  }
} finally {
  await client.end();
}
