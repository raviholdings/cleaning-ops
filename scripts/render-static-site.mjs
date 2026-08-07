#!/usr/bin/env node
/**
 * 사이트 한 벌을 Astro 없이 찍어 본다. 새 렌더러의 단위 확인용.
 *
 *   node scripts/render-static-site.mjs --site-url https://a.example.com --site-index 0 --out tmp/a
 *   node scripts/render-static-site.mjs --host light-raven.one-qfast.com --out tmp/light-raven
 *   node scripts/render-static-site.mjs --inspect
 *
 * --host 를 주면 DB 에서 globalSiteOrder / page_count / 소유확인 토큰을 읽어
 * 실제 배포와 같은 조건으로 찍는다. DB 는 읽기만 한다.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectTemplates, loadLocations, loadTemplates, renderSite } from './lib/static-site-renderer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch { /* .env 가 없어도 --site-url 방식은 동작한다 */ }
}

const options = parseArgs(process.argv.slice(2));
const templateDir = options.templates
  ? resolve(options.templates)
  : resolve(repoRoot, 'apps', 'cleaning-static', 'templates');

const templates = loadTemplates(templateDir);

if (options.inspect) {
  const vars = inspectTemplates(templates);
  console.log(`템플릿 폴더: ${templates.dir}`);
  console.log(`스타일:      ${templates.cssPath}`);
  console.log(`\npage.html 이 쓰는 변수 (${vars.page.length}):`);
  for (const name of vars.page) console.log(`  {{${name}}}`);
  console.log(`\nindex.html 이 쓰는 변수 (${vars.index.length}):`);
  for (const name of vars.index) console.log(`  {{${name}}}`);
  process.exit(0);
}

const locations = loadLocations();

let site;
if (options.host) {
  loadEnv(resolve(repoRoot, '.env'));
  const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!connectionString) throw new Error('--host 를 쓰려면 DATABASE_URL 이 필요합니다.');

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  const { rows } = await client.query(
    `select domain_name,
            (source_payload->>'globalSiteOrder')::int as global_site_order,
            coalesce((source_payload->>'pageCount')::int, 100) as page_count,
            naver_meta_tag_content
       from public.naver_project_domains
      where domain_name = $1`,
    [options.host],
  );
  await client.end();
  if (!rows.length) throw new Error(`DB 에 없는 호스트입니다: ${options.host}`);

  const row = rows[0];
  site = {
    siteUrl: `https://${row.domain_name}`,
    siteIndex: row.global_site_order - 1,
    pageCount: row.page_count,
    naverSiteVerification: row.naver_meta_tag_content || '',
  };
} else {
  if (!options.siteUrl) throw new Error('--site-url 또는 --host 가 필요합니다.');
  site = {
    siteUrl: options.siteUrl,
    siteIndex: Number(options.siteIndex ?? 0),
    pageCount: Number(options.pageCount ?? 100),
    naverSiteVerification: options.naverToken === true ? '' : (options.naverToken || ''),
  };
}

const outDir = resolve(options.out || resolve(repoRoot, 'tmp', 'static-render'));

const started = Date.now();
const result = renderSite({
  templates,
  locations,
  outDir,
  ...site,
  buildDate: typeof options.buildDate === 'string' ? options.buildDate : undefined,
});
const elapsed = Date.now() - started;

console.log(JSON.stringify({
  outDir,
  siteUrl: site.siteUrl,
  siteIndex: site.siteIndex,
  pages: result.pages,
  files: result.files,
  ms: elapsed,
  pagesPerSec: Number((result.pages / (elapsed / 1000)).toFixed(1)),
}, null, 2));
