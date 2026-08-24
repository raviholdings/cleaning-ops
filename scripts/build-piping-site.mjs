#!/usr/bin/env node
/**
 * 배관 사이트 빌더.
 *
 *   node scripts/build-piping-site.mjs --site-index 0 --host tower-clover.daddul.com
 *   node scripts/build-piping-site.mjs --site-index 0 --host tower-clover.daddul.com --pages 1 --out tmp/piping-sample
 */

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { buildPipingPageData, buildPipingIndexData, loadLocations, loadPipingData } from './lib/piping-page-data.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] || '');
};

const siteIndex = Number(valueOf('--site-index') || 0);
const host = valueOf('--host') || 'tower-clover.daddul.com';
const siteUrl = `https://${host}`;
const outDir = resolve(projectRoot, valueOf('--out') || 'tmp/piping-sample');
const token = valueOf('--token') || '';
const clean = !args.includes('--keep');
const pipingData = loadPipingData(projectRoot);
const locations = loadLocations(projectRoot);
const pageCount = Number(valueOf('--pages') || 1);

function loadPipingTemplates(dir) {
  const page = parseTemplate(readFileSync(join(dir, 'page.html'), 'utf8'), 'piping-template/page.html');
  const partialDir = join(dir, 'partials');
  const partials = existsSync(partialDir)
    ? readdirSync(partialDir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => ({
          name: f.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
          template: parseTemplate(readFileSync(join(partialDir, f), 'utf8'), `partials/${f}`),
        }))
    : [];
  return { page, partials };
}

const templates = loadPipingTemplates(resolve(projectRoot, 'apps/piping-static/piping-template'));

if (clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

function withPartials(data) {
  for (const partial of templates.partials) {
    data[partial.name] = renderTemplate(partial.template, data);
  }
  return data;
}

console.log(JSON.stringify({
  phase: 'start',
  host,
  siteIndex,
  pageCount,
  outDir,
}));

const started = Date.now();
const results = [];

for (let requestId = 1; requestId <= pageCount; requestId += 1) {
  const pageData = await buildPipingPageData({
    projectRoot,
    locations,
    siteIndex,
    requestId,
    siteUrl,
    pageCount,
    naverSiteVerification: token,
    pipingData,
  });

  const fullData = withPartials(pageData);
  const html = renderTemplate(templates.page, fullData);

  const rawFile = join(outDir, fullData.filePath);
  mkdirSync(dirname(rawFile), { recursive: true });

  const rawBuf = Buffer.from(html, 'utf8');
  const gzBuf = gzipSync(rawBuf, { level: 6 });

  // 1) 원본 .html 저장 (사용자 확인용)
  writeFileSync(rawFile, rawBuf);
  // 2) 압축본 .html.gz 저장 (Nginx 배포용)
  writeFileSync(`${rawFile}.gz`, gzBuf);

  results.push({
    requestId,
    pagePath: fullData.pagePath,
    title: fullData.title,
    location: fullData.location,
    mainKeyword: fullData.mainKeyword,
    rawBytes: rawBuf.byteLength,
    gzipBytes: gzBuf.byteLength,
  });
}

// 루트 index (소유확인 메타태그가 여기 있어야 한다)
const indexTemplate = parseTemplate(
  readFileSync(resolve(projectRoot, 'apps/piping-static/piping-template/index.html'), 'utf8'),
  'piping-template/index.html',
);
const indexData = await buildPipingIndexData({
  projectRoot, locations, siteIndex, siteUrl, pageCount,
  naverSiteVerification: token, pipingData,
});
const indexHtml = renderTemplate(indexTemplate, indexData);
writeFileSync(join(outDir, 'index.html'), Buffer.from(indexHtml, 'utf8'));
writeFileSync(join(outDir, 'index.html.gz'), gzipSync(Buffer.from(indexHtml, 'utf8'), { level: 6 }));
console.log(JSON.stringify({ phase: 'index', links: indexData.linkCount, title: indexData.title, bytes: Buffer.byteLength(indexHtml) }));

console.log(JSON.stringify({
  phase: 'complete',
  durationMs: Date.now() - started,
  pagesBuilt: results.length,
  sample: results[0],
}, null, 2));
