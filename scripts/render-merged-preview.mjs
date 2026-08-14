/**
 * templates-merged 로 페이지 한 장을 렌더해 파일로 떨군다. 눈으로 확인하는 용도.
 *
 * 기존 파이프라인(build-and-deploy-sites.mjs / renderSite)은 건드리지 않는다.
 * 여기서 통과하면 그때 정식 렌더러에 붙이면 된다.
 *
 * 사용:
 *   node scripts/render-merged-preview.mjs
 *   node scripts/render-merged-preview.mjs --page 7 --site-index 0 --out out.html
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const { parseTemplate, renderTemplate } = await import(
  pathToFileURL(join(here, 'lib', 'micro-template.mjs')).href
);
const { buildPageData, buildIndexData, loadLocations, SITE_DEFAULTS } = await import(
  pathToFileURL(join(here, 'lib', 'static-site-renderer.mjs')).href
);
const { extendPageData, extendIndexData } = await import(
  pathToFileURL(join(here, 'lib', 'merged-page-data.mjs')).href
);

const appLib = resolve(repoRoot, 'apps/cleaning-ravi/src/lib');
const { catalogEntry } = await import(pathToFileURL(join(appLib, 'pageCatalog.ts')).href);
const { normalizeLocation, pickFaqs, pickReviews, pickNearbyLocations, buildTitle, buildDescription } = await import(
  pathToFileURL(join(appLib, 'pageMeta.ts')).href
);
const { subKeywordsFor, MAIN_KEYWORDS } = await import(pathToFileURL(join(appLib, 'keywords.ts')).href);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const requestId = Number(arg('page', 1));
const siteIndex = Number(arg('site-index', 0));
const pageCount = Number(arg('page-count', 100));
const outPath = resolve(repoRoot, arg('out', 'preview_merged_output.html'));

// --home 이면 index.html(사이트 홈)을, 아니면 page.html(하위 페이지)을 렌더한다.
const isHome = process.argv.includes('--home');
const templateDir = resolve(repoRoot, 'apps/cleaning-static/templates-merged');
const pageTemplatePath = join(templateDir, isHome ? 'index.html' : 'page.html');
const cssPath = join(templateDir, 'styles.css');

for (const path of [pageTemplatePath, cssPath]) {
  if (!existsSync(path)) throw new Error(`파일이 없습니다: ${path}`);
}

const page = parseTemplate(
  readFileSync(pageTemplatePath, 'utf8'),
  `templates-merged/${isHome ? 'index' : 'page'}.html`,
);

// partials 는 원본 폴더 것을 그대로 빌려 쓴다 (estimate-form.html).
const partials = [];
const partialPath = resolve(repoRoot, 'apps/cleaning-static/templates/partials/estimate-form.html');
if (existsSync(partialPath)) {
  partials.push({
    key: 'estimateForm',
    template: parseTemplate(readFileSync(partialPath, 'utf8'), 'partials/estimate-form.html'),
  });
}

// --no-shim 을 주면 부트스트랩 대체 CSS 없이 렌더한다 (비교용).
// styles.css 하나에 전부 합쳐져 있다 (loadTemplates 가 그것만 읽기 때문).
const useShim = true;
const css = readFileSync(cssPath, 'utf8');

const site = {
  ...SITE_DEFAULTS,
  siteUrl: 'https://example.kr',
  naverSiteVerification: '',
  googleSiteVerification: '',
  indexable: true,
  titleVariant: 'B',
  pageCss: css,
};

const locations = loadLocations();
const data = isHome
  ? buildIndexData({ locations, siteIndex, pageCount, site })
  : buildPageData({ locations, siteIndex, pageCount, requestId, site });

for (const partial of partials) {
  data[partial.key] = renderTemplate(partial.template, data);
}
// partial 이 없으면 템플릿의 {{{estimateForm}}} 가 strict 에서 터진다.
if (!('estimateForm' in data)) data.estimateForm = '';

if (isHome) {
  extendIndexData(data, {
    catalogEntry, locations, siteIndex, pageCount,
    normalizeLocation, pickFaqs, pickReviews, subKeywordsFor, pickNearbyLocations,
    mainKeywords: MAIN_KEYWORDS,
    buildTitle, buildDescription,
  });
} else {
  extendPageData(data, { mainKeywords: MAIN_KEYWORDS });
}

const html = renderTemplate(page, data);
writeFileSync(outPath, html, 'utf8');

console.log(JSON.stringify({
  out: outPath,
  kind: isHome ? 'index(홈)' : 'page(하위)',
  shim: useShim,
  bytes: html.length,
  location: data.location || '(홈: 지역 없음)',
  mainKeyword: data.mainKeyword,
  title: data.title,
  places: data.places.length,
  gallery: data.gallery.count,
  faqs: data.faqs.length,
  reviews: data.reviews.length,
  links: data.links.length,
}, null, 2));
