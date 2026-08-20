#!/usr/bin/env node
/**
 * 이사 사이트를 굽는다.
 *
 *   node scripts/build-moving-site.mjs --site-index 0 --host blossom-light.anclose.com
 *   node scripts/build-moving-site.mjs --site-index 0 --host … --out tmp/moving-build
 *   node scripts/build-moving-site.mjs --site-index 0 --host … --pages 3   # 시험용
 *
 * 청소 파이프라인(build-and-deploy-sites.mjs)은 건드리지 않는다. 주소 체계와
 * 데이터 구성이 달라 분기를 넣기보다 따로 두는 편이 안전하다. 나중에 이 스크립트가
 * 안정되면 배포 부분만 청소 쪽 tar 전송을 재사용하면 된다.
 *
 * 결과는 gzip 으로만 떨군다. nginx 가 gzip_static 으로 .gz 를 그대로 내보내고,
 * 압축을 못 받는 클라이언트에는 gunzip 으로 풀어 준다. 청소와 같은 방식이다.
 */

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readdirSync, readFileSync } from 'node:fs';
import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { buildMovingPageData, loadLocations, loadMovingLib } from './lib/moving-page-data.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] || '');
};

const siteIndex = Number(valueOf('--site-index') || 0);
const host = valueOf('--host');
if (!host) throw new Error('--host 가 필요합니다 (예: blossom-light.anclose.com)');
const siteUrl = `https://${host}`;
const outDir = resolve(projectRoot, valueOf('--out') || 'apps/moving-ravi/tmp/site-build');
const token = valueOf('--token') || '';
const clean = !args.includes('--keep');

const lib = await loadMovingLib(projectRoot);
const locations = loadLocations(projectRoot);
const pageCount = Number(valueOf('--pages') || lib.catalog.PAGE_COUNT);

/*
 * 템플릿을 읽는다.
 *
 * 청소의 loadTemplates() 를 쓰지 않는다. 그쪽은 index.html 을 반드시 요구하는데
 * 이사는 아직 홈이 없다(하위 페이지만 굽는다). 필요해지면 그때 추가한다.
 *
 * 파싱은 한 번만 한다 — 50장을 굽는데 매번 파싱하면 그게 병목이 된다.
 */
function loadMovingTemplates(dir) {
  const page = parseTemplate(readFileSync(join(dir, 'page.html'), 'utf8'), 'move-template/page.html');
  const partialDir = join(dir, 'partials');
  const partials = readdirSync(partialDir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({
      // estimate-form.html -> estimateForm
      name: f.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
      template: parseTemplate(readFileSync(join(partialDir, f), 'utf8'), `partials/${f}`),
    }));
  return { page, partials };
}

const templates = loadMovingTemplates(resolve(projectRoot, 'apps/moving-static/move-template'));

console.log(JSON.stringify({
  phase: 'start', host, siteIndex, pageCount,
  templates: 'apps/moving-static/move-template', outDir,
}));

if (clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

/** partial 을 먼저 렌더해 데이터에 얹는다. 템플릿은 {{{estimateForm}}} 으로 쓴다. */
function withPartials(data) {
  for (const partial of templates.partials) {
    data[partial.name] = renderTemplate(partial.template, data);
  }
  return data;
}

const started = Date.now();
const written = [];
for (let requestId = 1; requestId <= pageCount; requestId += 1) {
  const data = withPartials(await buildMovingPageData({
    projectRoot, lib, locations, siteIndex, requestId, siteUrl, pageCount,
    naverSiteVerification: token,
  }));

  const html = renderTemplate(templates.page, data);
  const file = join(outDir, data.filePath);
  mkdirSync(dirname(file), { recursive: true });
  // .html 은 만들지 않는다. nginx 가 확장자 없는 요청에 .html 을 붙여 .gz 를 찾는다.
  writeFileSync(`${file}.gz`, gzipSync(Buffer.from(html, 'utf8'), { level: 6 }));
  written.push({ path: data.pagePath, bytes: Buffer.byteLength(html) });
}

/*
 * 사이트맵.
 *
 * 청소와 파일이 겹치면 안 된다. 청소는 /sitemap.xml 을 쓰고 있고 이미
 * 서치어드바이저에 제출돼 있다. 이사는 /이사/sitemap.xml 로 따로 둔다.
 */
const now = new Date().toISOString();
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${written.map((w) => `  <url>
    <loc>${siteUrl}${encodeURI(w.path)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`).join('\n')}
</urlset>
`;
const smPath = join(outDir, '이사', 'sitemap.xml');
mkdirSync(dirname(smPath), { recursive: true });
writeFileSync(`${smPath}.gz`, gzipSync(Buffer.from(sitemap, 'utf8'), { level: 6 }));

const totalBytes = written.reduce((a, w) => a + w.bytes, 0);
console.log(JSON.stringify({
  phase: 'built',
  pages: written.length,
  sitemap: '이사/sitemap.xml',
  avgBytes: Math.round(totalBytes / written.length),
  elapsedSec: Math.round((Date.now() - started) / 1000),
}));
console.log('\n앞 5장:');
for (const w of written.slice(0, 5)) console.log(`  ${w.path}  ${(w.bytes / 1024).toFixed(1)}KB`);
