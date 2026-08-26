#!/usr/bin/env node
/**
 * apex(루트 도메인) 홈페이지 빌더 — 한 장짜리 업체 소개형 + 견적 페이지.
 *
 * 왜 있는가: 루트 10개가 404(6개) 아니면 서브도메인 심볼릭 링크(4개)였다.
 * 네이버의 판정 단위가 등록가능도메인인데 그 루트에 실체가 없었다.
 *
 * 루트마다 세부 분야·브랜드명·팔레트·레이아웃·섹션 제목·nav 라벨·후기 표기가
 * 전부 다르다(data/apex/apex-content.json). 같은 배관 5개라도 판박이가 아니어야
 * apex 를 만든 의미가 있다.
 *
 *   node scripts/build-apex-site.mjs --all
 *   node scripts/build-apex-site.mjs --root daddul.com --preview
 *
 * 히어로 사진은 scripts/prepare-apex-hero-images.mjs 를 먼저 돌려야 잡힌다.
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { heroArt, serviceIcon, ctaIcon } from './lib/apex-visuals.mjs';
import { loadReviewPool, pickApexReviews } from './lib/apex-reviews.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fallback = '') => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

const content = JSON.parse(readFileSync(resolve(projectRoot, 'data/apex/apex-content.json'), 'utf8'));
const reviewPool = loadReviewPool(projectRoot);
const templateDir = resolve(projectRoot, 'apps/apex-static/apex-template');
const pageTemplate = parseTemplate(readFileSync(join(templateDir, 'page.html'), 'utf8'), 'apex-template/page.html');
const partials = Object.fromEntries(readdirSync(join(templateDir, 'partials'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => [
    f.replace(/\.html$/, ''),
    parseTemplate(readFileSync(join(templateDir, 'partials', f), 'utf8'), `partials/${f}`),
  ]));

// --preview 는 로컬에서 파일을 그냥 열어볼 때 쓴다. 상대경로를 쓰고 .gz 를 안 만든다.
const preview = args.includes('--preview');
const buildAll = args.includes('--all');
const outBase = valueOf('--out-base', 'tmp/apex');
const year = Number(valueOf('--year', String(new Date().getFullYear())));
const clean = !args.includes('--keep');

const SECTION_PARTIAL = {
  intro: 'section-intro',
  services: 'section-services',
  price: 'section-price',
  cases: 'section-cases',
  faq: 'section-faq',
  process: 'section-process',
  reviews: 'section-reviews',
  area: 'section-area',
  formpage: 'section-formpage',
};

// 지역은 시/도 단위로만 쓴다. 서브도메인이 읍면동 단위를 쓰고 있어서
// 여기서 같은 입도를 쓰면 그대로 중복이 된다.
const AREA_POOL = [
  ['서울', '경기 남부', '경기 북부', '인천'],
  ['부산', '경남', '울산', '대구'],
  ['대전', '세종', '충남', '충북'],
  ['광주', '전남', '전북', '제주'],
  ['강원', '경북', '수도권 전역'],
];

/** 루트별 결정적 난수. 같은 루트는 몇 번을 빌드해도 같은 결과가 나온다. */
function seeded(seed) {
  let s = (seed + 11) * 9301;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildRoot(root, overrides = {}) {
  const conf = content.roots[root];
  if (!conf) throw new Error(`apex-content.json 의 roots 에 "${root}" 이 없다.`);
  const v = content.specialties[conf.specialty];
  if (!v) throw new Error(`분야 "${conf.specialty}" 가 specialties 에 없다.`);

  const variant = Number(overrides.variant ?? conf.variant);
  const brand = overrides.brand || conf.brand;
  const token = overrides.token || '';
  const outDir = resolve(projectRoot, overrides.out || join(outBase, root));
  const rng = seeded(variant);

  // 팔레트·폰트는 테마가 들고 있다. 루트마다 디자인 방향이 통째로 다르다.
  const themeKey = overrides.theme || conf.theme;
  const theme = content.themes[themeKey];
  if (!theme) throw new Error(`테마 "${themeKey}" 가 themes 에 없다.`);
  const palette = theme.palette;
  const fontHref = `https://fonts.googleapis.com/css2?family=${theme.google}&display=swap`;
  const layout = content.layouts[variant % content.layouts.length];
  const headline = content.headlines[variant % content.headlines.length];
  // 지역: none = 섹션을 빼고 / regional = 권역 몇 개 / national = 도 기준 전국
  const areaMode = overrides.areaMode || conf.areaMode || 'regional';
  const areas = areaMode === 'national'
    ? content.areaNational
    : AREA_POOL[variant % AREA_POOL.length];
  const vertical = v.vertical;
  const cta = content.cta[vertical];
  const ctaIsPhone = cta.type === 'phone';
  const reviewMode = overrides.reviewMode || conf.reviewMode || 'author';

  const siteUrl = `https://${root}`;
  // 배포본은 R2(assets.<루트>/site/<버전>/)를 본다. immutable 이라 버전 폴더가
  // 바뀌면 apex-content.json 의 assetVersion 도 같이 올려야 한다.
  const assetBase = preview ? 'assets' : `https://assets.${root}/site/${content.assetVersion}`;

  // nginx 는 /숫자 와 /a/b 만 .html 로 넘긴다. 한 단계 경로는 404 라 .html 을 쓴다.
  const homeHref = preview ? 'index.html' : '/';
  // 견적 폼은 /form/ 서브디렉토리로 낸다. nginx 에 index index.html 이 있어
  // /form/ -> /form/index.html(.gz) 로 잡힌다. 배포 후 200 을 반드시 확인할 것.
  const formHref = preview ? 'form/index.html' : '/form/';
  const ctaHref = ctaIsPhone ? `tel:${cta.phone}` : formHref;

  const heroFile = ['.webp', '.jpg', '.jpeg', '.png']
    .map((e) => join(templateDir, 'assets/hero', root + e))
    .find((f) => existsSync(f));

  // 후기 표기: author = "이**" / duration = "작업 40분" / none = 섹션 자체를 뺀다
  const sections = layout.order.filter((s) => !(s === 'reviews' && reviewMode === 'none'))
    .filter((s) => !(s === 'area' && areaMode === 'none'));
  const reviews = reviewMode === 'none' ? [] : pickApexReviews(
    reviewPool, vertical, rng, 3 + Math.floor(rng() * 2),
    { area: areas[0], main: v.label, sub: v.services[0].name },
    reviewMode,
  );

  const pickFrom = (pool, key) => {
    const opts = pool[key];
    return opts ? opts[variant % opts.length] : key;
  };
  const heading = (s) => (conf.headings && conf.headings[s]) || pickFrom(content.headingPool, s);
  const navLabel = (s) => (conf.nav && conf.nav[s]) || pickFrom(content.navPool, s);
  const topbar = conf.topbar || cta.topbar;

  // nav 는 섹션 앵커로 간다.
  const navSections = sections.filter((s) => (conf.nav && conf.nav[s]) || content.navPool[s]).slice(0, 7);

  // 밴드를 번갈아 어둡게 해서 리듬을 만들고, 레이아웃이 지정한 섹션은 좌우로 눕힌다.
  const splitSet = new Set(theme.split || []);
  const titleMode = overrides.titleMode || conf.titleMode || 'stacked';
  const bandClass = (sec, idx) => [idx % 2 === 1 ? 'alt' : '', splitSet.has(sec) ? 'split' : '']
    .filter(Boolean).join(' ');

  const PAGES = [{ file: 'index.html', sections, home: true }];
  if (!ctaIsPhone) PAGES.push({ file: 'form/index.html', sections: ['formpage'], home: false });

  const TITLES = { 'index.html': brand, 'form/index.html': `무료 견적 신청 | ${brand}` };
  const DESCS = {
    'index.html': `${v.tagline}. ${areaMode === 'national' ? '전국 출동. ' : ''}${v.intro}`.slice(0, 155),
    'form/index.html': `${brand} 무료 견적 신청. ${cta.note}`.slice(0, 155),
  };

  const ctaData = {
    // 하단 연락 섹션 제목은 루트마다 다르게 고른다 (업종당 10개 풀).
    ctaHeading: content.ctaHeadingPool[vertical][variant % content.ctaHeadingPool[vertical].length],
    ctaNote: cta.note,
    ctaHref,
    ctaLabel: cta.label,
    ctaIcon: ctaIcon(cta.type),
    ctaFabLabel: cta.fabLabel,
    ctaFabAria: cta.fabAria,
    ctaPhoneText: cta.phoneText || '',
    // 미리보기는 file:// 라 /go/quote 가 file:///go/quote 로 풀려 오류가 난다.
    // 로컬에서도 실제 폼이 보이게 공개 주소로 띄운다. 배포본은 같은 도메인이라 상대경로.
    ctaFormSrc: cta.formSrc ? (preview ? `${siteUrl}${cta.formSrc}` : cta.formSrc) : '',
    ctaIsPhone,
    ctaIsForm: !ctaIsPhone,
  };

  const sectionData = {
    ...ctaData,
    intro: v.intro,
    verticalLabel: v.label,
    // 아이콘은 순번에 따라 달라지는데 템플릿 엔진에 인덱스가 없다. 미리 붙여서 넘긴다.
    // 테마별 고유 3D 입체감 이모지/배지를 붙인다.
    services: v.services.map((svc, i) => ({ ...svc, icon: serviceIcon(vertical, i, variant, themeKey) })),
    process: v.process,
    reviews,
    alsoNote: content.verticals[vertical].also,
    priceNote: v.priceNote,
    priceRows: v.priceRows,
    cases: v.cases,
    faq: v.faq,
    areas,
    areaNote: areaMode === 'national'
      ? '전국 어디든 갑니다. 아래는 도 기준이고, 시·군·구 단위는 접수하실 때 확인해 드립니다. 접수는 24시간 받습니다.'
      : `${areas.join(', ')} 순으로 일정을 잡습니다. 목록에 없는 지역도 일정이 맞으면 갑니다. 접수는 24시간 받습니다.`,
  };

  if (clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const write = (name, text) => {
    const buf = Buffer.from(text, 'utf8');
    mkdirSync(dirname(join(outDir, name)), { recursive: true });
    writeFileSync(join(outDir, name), buf);
    if (!preview) writeFileSync(join(outDir, `${name}.gz`), gzipSync(buf, { level: 6 }));
    return buf.byteLength;
  };

  let bytes = 0;
  for (const page of PAGES) {
    // 미리보기의 견적 페이지는 form/ 안에 있다. 상위 자산·홈으로 가려면 ../ 가 붙는다.
    // 배포본은 절대경로(R2 / 루트)라 영향 없다.
    const up = preview && !page.home ? '../' : '';
    const pageHome = preview ? `${up}index.html` : '/';
    const pageAssets = preview ? `${up}assets` : assetBase;
    // 섹션 앵커는 홈에 있다. 견적 페이지에서는 홈으로 되돌아가는 링크가 돼야 한다.
    const anchor = (id) => (page.home ? `#${id}` : `${pageHome}#${id}`);
    const navItems = navSections.map((s) => ({ href: anchor(s), label: navLabel(s), current: false }));

    const heroHtml = renderTemplate(partials.hero, {
      ...ctaData,
      tagline: v.tagline,
      headline: page.home ? headline.h1 : '무료 견적 신청',
      headlineSub: page.home ? headline.sub : cta.note,
      heroPhoto: Boolean(heroFile),
        heroSrc: heroFile
        ? (preview ? `${pageAssets}/hero${extname(heroFile)}` : `${assetBase}/hero/${root}.webp`)
        : '',
      heroArt: heroArt(variant, palette.accent),
      badges: cta.badges,
    });

    const tail = page.home ? renderTemplate(partials['section-estimate'], sectionData) : '';
    const bodyHtml = heroHtml
      + page.sections
        .map((s, i) => renderTemplate(partials[SECTION_PARTIAL[s]], {
          ...sectionData, heading: heading(s), bandClass: bandClass(s, i),
        }))
        .join('\n')
      + tail;

    const canonical = siteUrl + (page.home ? '/' : '/form/');
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: TITLES[page.file],
      url: canonical,
      description: DESCS[page.file],
      isPartOf: { '@type': 'WebSite', name: brand, url: `${siteUrl}/` },
    });

    bytes += write(page.file, renderTemplate(pageTemplate, {
      ...ctaData,
      title: TITLES[page.file],
      description: DESCS[page.file],
      canonical,
      naverVerification: token,
      brand,
      year,
      vertical,
      layout: layout.name,
      titleMode,
      theme: themeKey,
      fontHref,
      palette,
      cssHref: `${pageAssets}/apex.css`,
      jsonLd,
      bodyHtml,
      topbar,
      homeHref: pageHome,
      nav: navItems,
      footerDesc: `${v.intro.split('. ')[0]}.`,
      footerServicesLabel: pickFrom(content.footerPool, 'services'),
      footerInfoLabel: pickFrom(content.footerPool, 'info'),
      footerContactLabel: pickFrom(content.footerPool, 'contact'),
      footerServices: v.services.map((s) => s.name),
      footerInfo: sections
        .filter((s) => (conf.nav && conf.nav[s]) || content.navPool[s])
        .slice(0, 4)
        .map((s) => ({ href: anchor(s), label: navLabel(s) })),
      footerHours: cta.footerHours,
    }));
  }

  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    // 견적 페이지는 form/index.html 로 떨어지지만 주소는 /form/ 이다.
    + PAGES.map((p) => `  <url><loc>${siteUrl}${p.home ? '/' : '/form/'}</loc></url>`).join('\n')
    + `\n</urlset>\n`);

  // 서브도메인 사이트맵을 여기 얹지 않는다. 루트에서 서브도메인 2만 개를 가리키면
  // 지금 의심받는 구조를 네이버에 그대로 확인시켜 주는 꼴이다.
  // robots 정책은 apex-content.json 에 있다 (운영자 지정, 2026-08-26).
  // 원본에 있던 Sitemap 주소는 다른 사이트 것이라 각 루트 자기 주소로 채운다.
  write('robots.txt', `${content.robots
    .replaceAll('{{brand}}', brand)
    .replaceAll('{{siteUrl}}', siteUrl)}\n`);

  write('favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="12" fill="${palette.accent}"/>`
    + `<text x="32" y="44" font-size="30" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">`
    + `${brand.slice(0, 1)}</text></svg>`);

  // 미리보기는 로컬 파일을 그냥 열어보는 용도라 자산을 옆에 떨군다.
  // 배포본은 R2(assets.<루트>/site/<버전>/)를 보므로 서버에 올릴 건 HTML 뿐이다.
  if (preview) {
  mkdirSync(join(outDir, 'assets'), { recursive: true });
  // 기본 시트 + 테마 + 모션을 한 파일로 합친다. R2 업로드도 같은 방식으로 합친다.
  writeFileSync(join(outDir, 'assets/apex.css'), [
    readFileSync(join(templateDir, 'assets/apex.css'), 'utf8'),
    readFileSync(join(templateDir, 'assets/themes.css'), 'utf8'),
    readFileSync(join(templateDir, 'assets/motion.css'), 'utf8'),
  ].join('\n'), 'utf8');
  if (heroFile) copyFileSync(heroFile, join(outDir, `assets/hero${extname(heroFile)}`));
  }

  return {
    root, brand, label: v.label, vertical, variant, layout: layout.name,
    theme: themeKey, themeLabel: theme.label, areaMode, titleMode, sections: sections.length, nav: navSections.length,
    reviewMode, reviews: reviews.length, pages: PAGES.length, bytes,
  };
}

const targets = buildAll ? Object.keys(content.roots) : [valueOf('--root')].filter(Boolean);
if (!targets.length) throw new Error('--root 또는 --all 이 필요하다.');

const results = targets.map((root) => buildRoot(root, {
  variant: args.includes('--variant') ? valueOf('--variant') : undefined,
  brand: valueOf('--brand') || undefined,
  token: valueOf('--token') || undefined,
  out: valueOf('--out') || undefined,
}));

for (const r of results) {
  console.log(`  ${r.root.padEnd(19)} ${r.brand.padEnd(8)} ${r.label.padEnd(14)} `
    + `${r.themeLabel.padEnd(11)} 섹션${r.sections} 지역:${r.areaMode.padEnd(8)} 제목:${r.titleMode.padEnd(7)} `
    + `후기 ${r.reviewMode === 'none' ? '없음 ' : `${r.reviewMode}·${r.reviews}개`} ${String(Math.round(r.bytes / 1024)).padStart(3)}KB`);
}
console.log(`\n${results.length}개 · ${preview ? '미리보기(gz 없음, 상대경로)' : '배포본(gz 포함)'} · ${resolve(projectRoot, outBase)}`);
