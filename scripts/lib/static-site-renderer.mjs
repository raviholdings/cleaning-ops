/**
 * Astro 없이 사이트 한 벌을 찍어내는 렌더러.
 *
 * 왜 만들었나:
 *   Astro 산출물에는 자바스크립트 번들이 없다(_astro 폴더 자체가 안 생긴다).
 *   실제로 쓰던 Astro 기능은 Astro.props 4곳과 getStaticPaths 하나가 전부였다.
 *   그런데도 사이트마다 Vite 빌드를 통째로 돌아 1,000개에 525초가 걸렸고,
 *   힙 16GB 를 잡아야 했으며 OOM / esbuild spawn UNKNOWN / EPERM 으로 죽었다.
 *   내용을 문자열로 끼워 넣는 일에 번들러가 필요하지 않다.
 *
 * 데이터 계산은 절대 다시 구현하지 않는다. 지역·키워드 배정(pageCatalog),
 * 문구 생성(pageMeta), 콘텐츠 풀(content) 은 Astro 앱이 쓰는 .ts 파일을
 * Node 24 의 타입 스트리핑으로 그대로 import 한다. 두 벌이 되면 반드시 어긋난다.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseTemplate, renderTemplate, templateVariables } from './micro-template.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const appLib = resolve(repoRoot, 'apps', 'cleaning-ravi', 'src', 'lib');

// Windows 에서는 절대경로를 그대로 import 하면 'c:' 를 프로토콜로 읽는다.
// 반드시 file:// URL 로 바꿔야 한다.
const importLib = (file) => import(pathToFileURL(join(appLib, file)).href);

const { catalogEntry, pagePath } = await importLib('pageCatalog.ts');
const { CLEANING_SCOPE } = await importLib('content.ts');
const {
  buildBodyCopy, buildDescription, buildIndexMeta, buildTitle, ctaLabel, mapLinks, normalizeLocation,
  pickFaqs, pickSubKeywords, pickReviews, pickNearbyLocations,
  pickPromises, pickVendorTips, pickServiceCategories, pickProcessSteps, relatedKeywords,
} = await importLib('pageMeta.ts');

/** rollout-locations.json 은 DB 의 naver_page_locations 와 같은 순서여야 한다. */
export function loadLocations() {
  const path = resolve(repoRoot, 'data', 'locations', 'rollout-locations.json');
  return JSON.parse(readFileSync(path, 'utf8')).locations;
}

/**
 * 링크·폼 주소처럼 사이트 전체가 공유하는 값.
 * Astro 의 src/config/site.ts 와 같은 기본값을 쓴다. 다르면 페이지가 달라진다.
 */
export const SITE_DEFAULTS = {
  siteName: '입주청소114',
  /**
   * 홈(index) 전용 대표 키워드.
   * 하위 페이지는 카탈로그가 정해주지만 홈은 지역이 없다. Astro 판은
   * PUBLIC_SITE_MAIN_KEYWORD 를 읽었고 배포 스크립트가 이 값을 안 넘겨서
   * 항상 기본값이었다. 같은 결과가 나오도록 기본값을 그대로 박아 둔다.
   */
  mainKeyword: '입주청소',
  formSrc: 'https://replyalba.com/intros/_frm/index.php?code=wKSpzJlHMP',
  jqueryUrl: 'https://replyalba.com/js/jquery-1.11.0.min.js',
  iframeResizerUrl: 'https://replyalba.com/js/iframeResizer.min.js',
};

/**
 * 템플릿 묶음을 한 번만 읽어 파싱해 둔다.
 * 3,000개 사이트 × 100장이면 30만 번 렌더하는데 매번 파싱하면 그게 병목이 된다.
 */
export function loadTemplates(templateDir) {
  const dir = resolve(templateDir);
  const read = (file) => {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`템플릿이 없습니다: ${path}`);
    return { source: readFileSync(path, 'utf8'), path };
  };

  const page = read('page.html');
  const index = read('index.html');

  // partials/*.html 은 페이지 데이터로 먼저 렌더한 뒤 {{{이름}}} 으로 꽂힌다.
  // 파일명 estimate-form.html -> 변수 estimateForm.
  const partials = [];
  const partialDir = join(dir, 'partials');
  if (existsSync(partialDir)) {
    for (const file of readdirSync(partialDir).filter((f) => f.endsWith('.html'))) {
      partials.push({
        key: file.replace(/\.html$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
        template: parseTemplate(readFileSync(join(partialDir, file), 'utf8'), `partials/${file}`),
      });
    }
  }

  // 스타일은 템플릿 폴더에 있으면 그걸 쓰고, 없으면 Astro 앱 것을 그대로 쓴다.
  // 디자인 교체 중에는 둘이 공존한다.
  const cssPath = existsSync(join(dir, 'styles.css'))
    ? join(dir, 'styles.css')
    : resolve(repoRoot, 'apps', 'cleaning-ravi', 'src', 'styles', 'page.css');

  return {
    dir,
    css: readFileSync(cssPath, 'utf8'),
    cssPath,
    page: parseTemplate(page.source, 'page.html'),
    index: parseTemplate(index.source, 'index.html'),
    partials,
    /** 정적 자산 폴더. 있으면 사이트마다 복사한다. */
    staticDir: existsSync(join(dir, 'static')) ? join(dir, 'static') : null,
  };
}

/** 템플릿이 쓰는 변수 목록. 새 디자인을 받았을 때 대조용. */
export function inspectTemplates(templates) {
  return {
    page: templateVariables(templates.page),
    index: templateVariables(templates.index),
  };
}

/**
 * 페이지 한 장의 데이터.
 *
 * 이 객체의 키가 곧 템플릿이 쓸 수 있는 변수 전체다.
 * 새 디자인은 여기 있는 값만 쓸 수 있고, 여기 없는 값이 필요하면
 * 이 함수를 고쳐야 한다 (템플릿 쪽에서 지어내면 strict 렌더에서 죽는다).
 */
export function buildPageData({ locations, siteIndex, pageCount, requestId, site }) {
  const entry = catalogEntry({ locations, siteIndex, requestId, pageCount });
  // raw 는 rollout-locations.json 에 있는 그대로. 해시 입력은 반드시 이걸 쓴다.
  // full 은 "서울 동작 흑석동" -> "서울 동작구 흑석동" 처럼 편 것으로, 화면 표시용이다.
  // 축약형과 정식형이 별개 항목이라 raw 로 해시해야 두 페이지가 안 겹친다.
  const raw = entry.location;
  const full = normalizeLocation(raw);
  const main = entry.mainKeyword;
  const variant = site.titleVariant === 'A' ? 'A' : 'B';

  const path = pagePath(requestId);
  const canonical = `${site.siteUrl}${path}`;

  const title = buildTitle(raw, main, variant);
  const description = buildDescription(raw, main, variant);
  // JSON-LD Service.name. buildHeading 이 아니라 이 문구를 쓴다 (Astro 판과 동일).
  const heading = `${full} ${main} 업체 비교`;

  const nearby = pickNearbyLocations(raw, locations, 4);
  const faqs = pickFaqs(raw, main);
  const reviews = pickReviews(raw, main, 3);
  const promises = pickPromises(raw, main);
  const categories = pickServiceCategories(raw, main);

  /** 이 사이트의 다른 페이지 하나를 링크로 만든다. */
  const linkTo = (id) => {
    const other = catalogEntry({ locations, siteIndex, requestId: id, pageCount });
    return {
      href: pagePath(id),
      label: `${normalizeLocation(other.location)} ${other.mainKeyword} 업체 비교`,
    };
  };

  // 앞뒤 페이지. 크롤러가 한 URL 을 발견하면 사슬을 따라 100장을 전부 돈다.
  // 흩어진 링크 10개만 있으면 발견 경로가 끊기는 페이지가 생긴다.
  const prevId = requestId === 1 ? pageCount : requestId - 1;
  const nextId = requestId === pageCount ? 1 : requestId + 1;

  // 같은 사이트 안의 다른 페이지 10장으로 내부 링크를 건다.
  // 보폭 7은 Astro 판과 같아야 링크 구조가 바뀌지 않는다.
  const links = Array.from({ length: 15 }, (_, i) => i + 1)
    .map((offset) => ((requestId - 1 + offset * 7) % pageCount) + 1)
    .filter((id) => id !== requestId)
    .slice(0, 10)
    .map(linkTo);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '홈', item: `${site.siteUrl}/` },
          { '@type': 'ListItem', position: 2, name: `${full} ${main}`, item: canonical },
        ],
      },
      {
        '@type': 'Service',
        '@id': `${canonical}#service`,
        serviceType: main,
        name: heading,
        description,
        url: canonical,
        areaServed: [full, ...nearby].map((loc) => ({ '@type': 'AdministrativeArea', name: loc })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${canonical}#faq`,
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return {
    // --- 사이트 공통 ---
    siteUrl: site.siteUrl,
    siteName: site.siteName,
    naverSiteVerification: site.naverSiteVerification,
    googleSiteVerification: site.googleSiteVerification,
    robots: site.indexable ? 'index, follow' : 'noindex, nofollow',
    form: { src: site.formSrc, jquery: site.jqueryUrl, iframeResizer: site.iframeResizerUrl },
    pageCss: site.pageCss,

    // --- 이 페이지 ---
    pageId: requestId,
    pagePath: path,
    canonical,
    ogImage: `${site.siteUrl}/img/hero-1120.webp`,
    title,
    description,
    heading,
    cta: ctaLabel(raw, main),

    location: full,
    mainKeyword: main,
    subKeywords: pickSubKeywords(raw, main),
    // 이 페이지가 노리는 연관 검색어. 한 URL 이 여러 롱테일에 걸리게 한다.
    related: relatedKeywords(raw, main, 8).map((word) => ({ word })),
    // 주변 지역명·서브키워드를 섞은 본문 문장들. 템플릿이 자리마다 꽂아 쓴다.
    copy: buildBodyCopy(raw, main, nearby),
    // 지도 검색 링크. 페이지마다 다른 외부 링크가 지역성 신호가 된다.
    map: mapLinks(raw, main),
    // 앞뒤 페이지. 크롤러 순회용.
    prev: linkTo(prevId),
    next: linkTo(nextId),

    // --- 반복 블록 ---
    promises,
    reviews: reviews.map((r) => ({ ...r, stars: '★'.repeat(r.rating) })),
    nearby,
    nearbyText: nearby.join(', '),
    nearbyCount: nearby.length,
    cleaningScope: CLEANING_SCOPE,
    categories: categories.map((c) => ({ ...c, itemsText: c.items.join(' · ') })),
    tips: pickVendorTips(raw, main, 6),
    steps: pickProcessSteps(raw, main),
    faqs,
    links,

    // 짝수 페이지는 배치를 바꿔 중복 판정을 피한다 (Astro 판과 동일한 기준).
    alternateLayout: requestId % 2 === 0,

    jsonLd: JSON.stringify(jsonLd),
  };
}

/**
 * 홈 페이지 데이터.
 *
 * 하위 페이지와 계산식이 다르다. 홈에는 담당 지역이 없어서 Astro 판은
 * 지역 자리에 사이트 URL 을 넣어 후기·FAQ 를 뽑았다. 이상해 보이지만
 * 그래야 사이트마다 다른 조합이 나오고, 이미 배포된 3,000개 홈의 내용이
 * 바뀌지 않는다. 일부러 그대로 둔다.
 */
export function buildIndexData({ locations, siteIndex, pageCount, site }) {
  const main = site.mainKeyword;
  const canonical = `${site.siteUrl}/`;
  const meta = buildIndexMeta(site.siteUrl, locations, main);

  const faqs = pickFaqs(site.siteUrl, main);
  const reviews = pickReviews(site.siteUrl, main, 3);
  const nearby = pickNearbyLocations(site.siteUrl, locations, 4);

  // 홈은 이 사이트의 100장 중 앞 30장으로 카탈로그를 만든다.
  const links = Array.from({ length: pageCount }, (_, index) => {
    const requestId = index + 1;
    const entry = catalogEntry({ locations, siteIndex, requestId, pageCount });
    return {
      href: pagePath(requestId),
      label: `${normalizeLocation(entry.location)} ${entry.mainKeyword} 업체 비교`,
    };
  }).slice(0, 30);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${site.siteUrl}/#website`,
        url: canonical,
        name: meta.title,
        description: meta.description,
        inLanguage: 'ko-KR',
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumb`,
        itemListElement: [{ '@type': 'ListItem', position: 1, name: '홈', item: canonical }],
      },
      {
        '@type': 'Service',
        '@id': `${site.siteUrl}/#service`,
        serviceType: main,
        description: meta.description,
        url: canonical,
        areaServed: nearby.map((loc) => ({ '@type': 'AdministrativeArea', name: loc })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${site.siteUrl}/#faq`,
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return {
    siteUrl: site.siteUrl,
    siteName: site.siteName,
    naverSiteVerification: site.naverSiteVerification,
    googleSiteVerification: site.googleSiteVerification,
    robots: site.indexable ? 'index, follow' : 'noindex, nofollow',
    form: { src: site.formSrc, jquery: site.jqueryUrl, iframeResizer: site.iframeResizerUrl },
    pageCss: site.pageCss,

    pagePath: '/',
    canonical,
    ogImage: `${site.siteUrl}/img/hero-1120.webp`,
    title: meta.title,
    description: meta.description,
    mainKeyword: main,

    reviews: reviews.map((r) => ({ ...r, stars: '★'.repeat(r.rating) })),
    nearby,
    nearbyText: nearby.join(', '),
    nearbyCount: nearby.length,
    faqs,
    links,

    jsonLd: JSON.stringify(jsonLd),
  };
}

function sitemapXml({ siteUrl, pageCount, today }) {
  const entries = [
    { loc: `${siteUrl}/`, priority: '1.0' },
    ...Array.from({ length: pageCount }, (_, i) => ({
      loc: `${siteUrl}${pagePath(i + 1)}`,
      priority: '0.8',
    })),
  ];
  const urls = entries
    .map((e) => [
      '  <url>',
      `    <loc>${e.loc}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      '    <changefreq>weekly</changefreq>',
      `    <priority>${e.priority}</priority>`,
      '  </url>',
    ].join('\n'))
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rssXml({ siteUrl, mainKeyword, pages, now }) {
  const items = pages.map((p) => [
    '    <item>',
    `      <title>${escapeXml(p.title)}</title>`,
    `      <link>${p.canonical}</link>`,
    `      <guid isPermaLink="true">${p.canonical}</guid>`,
    `      <description>${escapeXml(p.description)}</description>`,
    `      <pubDate>${now}</pubDate>`,
    '    </item>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(mainKeyword)} 지역별 안내</title>`,
    `    <link>${siteUrl}/</link>`,
    `    <description>${escapeXml(mainKeyword)} 지역별 서비스 안내와 견적 신청</description>`,
    '    <language>ko</language>',
    `    <lastBuildDate>${now}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function robotsTxt({ siteUrl, indexable }) {
  return indexable
    ? ['User-agent: Yeti', 'Allow: /', '', 'User-agent: *', 'Allow: /', '', `Sitemap: ${siteUrl}/sitemap.xml`, ''].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n');
}

/**
 * 사이트 한 벌을 outDir 에 쓴다.
 *
 * @param {object} opts
 * @param {object} opts.templates  loadTemplates 결과 (여러 사이트가 공유)
 * @param {readonly string[]} opts.locations
 * @param {string} opts.outDir
 * @param {string} opts.siteUrl    끝에 슬래시 없음
 * @param {number} opts.siteIndex  globalSiteOrder - 1
 * @param {number} opts.pageCount
 * @param {string} [opts.naverSiteVerification]
 * @param {string} [opts.googleSiteVerification]
 * @param {boolean} [opts.indexable=true]
 * @param {'A'|'B'} [opts.titleVariant='B']
 * @param {string} [opts.buildDate]  YYYY-MM-DD. 없으면 오늘.
 * @returns {{files: number, pages: number}}
 */
export function renderSite(opts) {
  const {
    templates, locations, outDir, siteIndex, pageCount,
    indexable = true, titleVariant = 'B',
  } = opts;

  const siteUrl = String(opts.siteUrl).replace(/\/+$/, '');
  const site = {
    ...SITE_DEFAULTS,
    siteUrl,
    siteName: opts.siteName || SITE_DEFAULTS.siteName,
    naverSiteVerification: opts.naverSiteVerification || '',
    googleSiteVerification: opts.googleSiteVerification || '',
    indexable,
    titleVariant,
    pageCss: templates.css,
  };

  mkdirSync(outDir, { recursive: true });

  /** partial 을 먼저 렌더해 데이터에 얹는다. 페이지 템플릿은 {{{estimateForm}}} 로 쓴다. */
  const withPartials = (data) => {
    for (const partial of templates.partials) {
      data[partial.key] = renderTemplate(partial.template, data);
    }
    return data;
  };

  const pages = [];
  for (let requestId = 1; requestId <= pageCount; requestId += 1) {
    const data = withPartials(buildPageData({ locations, siteIndex, pageCount, requestId, site }));
    writeFileSync(join(outDir, `${requestId}.html`), renderTemplate(templates.page, data), 'utf8');
    pages.push(data);
  }

  writeFileSync(
    join(outDir, 'index.html'),
    renderTemplate(templates.index, withPartials(buildIndexData({ locations, siteIndex, pageCount, site }))),
    'utf8',
  );

  const buildDate = opts.buildDate || new Date().toISOString().slice(0, 10);
  const now = new Date(`${buildDate}T00:00:00Z`).toUTCString();

  writeFileSync(join(outDir, 'sitemap.xml'), sitemapXml({ siteUrl, pageCount, today: buildDate }), 'utf8');
  writeFileSync(join(outDir, 'rss.xml'), rssXml({ siteUrl, mainKeyword: site.mainKeyword, pages, now }), 'utf8');
  writeFileSync(join(outDir, 'robots.txt'), robotsTxt({ siteUrl, indexable }), 'utf8');

  if (templates.staticDir) {
    cpSync(templates.staticDir, outDir, { recursive: true });
  }

  return { files: pageCount + 4, pages: pageCount };
}
