#!/usr/bin/env node
/**
 * Astro 산출물과 새 렌더러 산출물을 대조한다.
 *
 *   node scripts/compare-static-render.mjs tmp/render-astro tmp/render-new
 *
 * 바이트 단위로 같기를 기대하지 않는다. Astro 는 공백을 나름대로 정리하고
 * 속성 순서를 바꾼다. 대신 검색엔진과 사용자에게 실제로 영향을 주는 것만 본다.
 *
 *   - title / description / canonical / robots / og:*
 *   - 소유확인 meta (이게 틀리면 3,000개 도메인이 통째로 소유확인 실패한다)
 *   - JSON-LD (파싱해서 깊은 비교)
 *   - 본문 텍스트 (태그를 걷어낸 순수 텍스트)
 *   - 링크 href 목록
 *   - sitemap / rss / robots.txt
 *
 * 하나라도 어긋나면 종료코드 1. 배포 전 안전장치로 쓴다.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [astroDir, newDir] = process.argv.slice(2).map((p) => p && resolve(p));
if (!astroDir || !newDir) {
  console.error('사용법: node scripts/compare-static-render.mjs <astro-dist> <new-dist>');
  process.exit(2);
}

const problems = [];
function fail(file, what, expected, actual) {
  problems.push({ file, what, expected, actual });
}

/** 태그를 지우고 남는 본문 텍스트. 공백 차이는 무시한다. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, pattern) {
  const re = new RegExp(`<meta[^>]*${pattern}[^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag[0]);
  return content ? content[1] : null;
}

function titleOf(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

function canonicalOf(html) {
  const m = /<link[^>]*rel=["']canonical["'][^>]*>/i.exec(html);
  if (!m) return null;
  const href = /href=["']([^"']*)["']/i.exec(m[0]);
  return href ? href[1] : null;
}

function jsonLdOf(html) {
  const m = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return { PARSE_ERROR: m[1].slice(0, 120) }; }
}

/** 내부 링크만. 외부 CPA 링크는 템플릿 상수라 비교 가치가 낮다. */
function internalHrefs(html) {
  return [...html.matchAll(/<a[^>]*href=["'](\/[^"']*)["']/gi)].map((m) => m[1]).sort();
}

function compareHtml(name, a, b) {
  const checks = [
    ['title', titleOf(a), titleOf(b)],
    ['description', metaContent(a, 'name=["\']description["\']'), metaContent(b, 'name=["\']description["\']')],
    ['canonical', canonicalOf(a), canonicalOf(b)],
    ['robots', metaContent(a, 'name=["\']robots["\']'), metaContent(b, 'name=["\']robots["\']')],
    ['naver-site-verification',
      metaContent(a, 'name=["\']naver-site-verification["\']'),
      metaContent(b, 'name=["\']naver-site-verification["\']')],
    ['og:title', metaContent(a, 'property=["\']og:title["\']'), metaContent(b, 'property=["\']og:title["\']')],
    ['og:url', metaContent(a, 'property=["\']og:url["\']'), metaContent(b, 'property=["\']og:url["\']')],
    ['og:image', metaContent(a, 'property=["\']og:image["\']'), metaContent(b, 'property=["\']og:image["\']')],
  ];

  for (const [what, expected, actual] of checks) {
    if (expected !== actual) fail(name, what, expected, actual);
  }

  const ldA = JSON.stringify(jsonLdOf(a));
  const ldB = JSON.stringify(jsonLdOf(b));
  if (ldA !== ldB) fail(name, 'json-ld', truncate(ldA), truncate(ldB));

  const hrefA = internalHrefs(a).join(' ');
  const hrefB = internalHrefs(b).join(' ');
  if (hrefA !== hrefB) fail(name, 'internal-links', truncate(hrefA), truncate(hrefB));

  const textA = visibleText(a);
  const textB = visibleText(b);
  if (textA !== textB) fail(name, 'body-text', ...firstDifference(textA, textB));
}

function truncate(value, len = 160) {
  if (value === null || value === undefined) return String(value);
  return value.length > len ? `${value.slice(0, len)}…` : value;
}

/** 어디서부터 갈렸는지 앞뒤 60자만 보여준다. 전문을 찍으면 못 읽는다. */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 40);
  return [`…${a.slice(from, i + 60)}`, `…${b.slice(from, i + 60)}`];
}

function compareText(name, a, b, { ignore = [] } = {}) {
  const strip = (value) => ignore.reduce((acc, re) => acc.replace(re, '<무시>'), value).trim();
  if (strip(a) !== strip(b)) fail(name, 'content', ...firstDifference(strip(a), strip(b)));
}

const htmlFiles = readdirSync(astroDir).filter((f) => f.endsWith('.html')).sort();
let compared = 0;

for (const file of htmlFiles) {
  const newPath = join(newDir, file);
  if (!existsSync(newPath)) { fail(file, 'missing', '있음', '없음'); continue; }
  compareHtml(file, readFileSync(join(astroDir, file), 'utf8'), readFileSync(newPath, 'utf8'));
  compared += 1;
}

for (const file of ['sitemap.xml', 'rss.xml', 'robots.txt']) {
  const aPath = join(astroDir, file);
  const bPath = join(newDir, file);
  if (!existsSync(aPath)) continue;
  if (!existsSync(bPath)) { fail(file, 'missing', '있음', '없음'); continue; }
  compareText(
    file,
    readFileSync(aPath, 'utf8'),
    readFileSync(bPath, 'utf8'),
    // 빌드 시각은 당연히 다르다. 날짜만 무시한다.
    { ignore: [/<lastmod>[^<]*<\/lastmod>/g, /<pubDate>[^<]*<\/pubDate>/g, /<lastBuildDate>[^<]*<\/lastBuildDate>/g] },
  );
  compared += 1;
}

// 새 렌더러에만 있는 파일도 사고다 (예전에 없던 걸 뿌리게 된다).
const extra = readdirSync(newDir).filter((f) => !existsSync(join(astroDir, f)));
for (const file of extra) fail(file, 'unexpected', '없음', '있음');

if (problems.length === 0) {
  console.log(`✅ ${compared}개 파일 전부 일치합니다.`);
  process.exit(0);
}

const byWhat = {};
for (const p of problems) byWhat[p.what] = (byWhat[p.what] || 0) + 1;

console.log(`❌ 불일치 ${problems.length}건 / 검사 ${compared}개 파일`);
console.log(`   항목별: ${Object.entries(byWhat).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
for (const p of problems.slice(0, 12)) {
  console.log(`── ${p.file} :: ${p.what}`);
  console.log(`   astro: ${p.expected}`);
  console.log(`   new  : ${p.actual}\n`);
}
if (problems.length > 12) console.log(`… 외 ${problems.length - 12}건`);
process.exit(1);
