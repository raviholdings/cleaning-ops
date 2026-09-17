#!/usr/bin/env node
/**
 * piping-xyz 렌더 서버 — Apache 뒤(127.0.0.1:3800)에서 서브도메인 페이지를 즉석 렌더한다.
 *
 *   GET  /배관/<시도>/<동>/<슬러그>.html   랜딩 (어떤 서브도메인에서든 열림, canonical = 자기 주소)
 *   GET  /                                  등록 서브도메인 루트 인덱스 (시도 16개) + 네이버 소유확인 메타태그
 *   GET  /배관/<시도>/                        그 서브도메인의 해당 시도 페이지 목록
 *   GET  /piping-assets/...                  템플릿 자산 (css/js/img)
 *   POST /api/lead                           견적 폼 접수 → 로컬 PG lead_submissions + 텔레그램
 *   GET  /healthz
 *
 *   node scripts/hub-render-server.mjs            # DATABASE_URL 없으면 config.dbCredsFile 에서 읽는다
 *
 * 템플릿·자산·FAQ 풀은 apps/piping-static/piping-template 과 data/piping-faq-pool.json 을 그대로 쓴다.
 * 매핑은 scripts/lib/piping-xyz-site.mjs (카탈로그 생성기와 동일).
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import pg from 'pg';
import { parseTemplate, renderTemplate } from './lib/micro-template.mjs';
import { loadSite, makePage, parsePath, resolveHost, nearbyRegions, hash32, enumeratePages } from './lib/piping-xyz-site.mjs';

const site = loadSite();
const { config, projectRoot } = site;
const templateDir = resolve(projectRoot, config.templateDir);
const pageTpl = parseTemplate(readFileSync(join(templateDir, 'page.html'), 'utf8'), 'page.html');
const formTpl = parseTemplate(readFileSync(join(templateDir, 'partials', 'estimate-form.html'), 'utf8'), 'estimate-form.html');
const oldConfig = JSON.parse(readFileSync(resolve(projectRoot, 'config/piping.json'), 'utf8'));   // 이미지·업종 분류 목록 재사용
const faqData = JSON.parse(readFileSync(resolve(projectRoot, config.faqFile), 'utf8'));
const ASSET = config.assetBase;            // "/piping-assets"
const VER = config.assetVersion;
const URL_ROOT = config.urlRoot;
const PLATFORM = String(config.platformHost || '').toLowerCase();      // 접수·전화 추적·주입 스크립트 전용 도메인 (랜딩 도메인과 분리)
const PLATFORM_BASE = config.platformBase || `https://${PLATFORM}`;

/* ---------- env: DB, 텔레그램 ---------- */
function readKv(path) {
  if (!path || !existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/); if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const creds = readKv(config.dbCredsFile);
const dotenv = readKv(resolve(projectRoot, '.env'));
const DATABASE_URL = process.env.DATABASE_URL || creds.DATABASE_URL;
if (!DATABASE_URL || !/127\.0\.0\.1|localhost/.test(DATABASE_URL)) throw new Error('로컬 DATABASE_URL 필요');
// 텔레그램: 환경변수 > ravi\_secure\naver-hub-db.txt (이 프로젝트 전용 봇을 쓰려면 여기에 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 추가) > cleaning-ops .env (옛 봇)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || creds.TELEGRAM_BOT_TOKEN || dotenv.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || creds.TELEGRAM_CHAT_ID || dotenv.TELEGRAM_CHAT_ID || '';
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });

/* ---------- 집 서브도메인 색인 (도메인별, 느리게 1회) ---------- */
const homeMaps = new Map(); // domain -> { homes: Uint16Array, keys: [[j, mainIdx, regionIdx]...] 는 안 만들고 순서로 복원 }
function homeMap(domain) {
  if (homeMaps.has(domain)) return homeMaps.get(domain);
  const total = site.k * site.mains.length * site.regions.length;
  const homes = new Uint16Array(total);
  let i = 0;
  for (const page of enumeratePages(site, domain)) homes[i++] = page.homeIndex;
  homeMaps.set(domain, homes);
  return homes;
}
function pageAt(domain, flatIndex) {
  const R = site.regions.length, M = site.mains.length;
  const j = Math.floor(flatIndex / (M * R)) + 1;
  const rem = flatIndex % (M * R);
  const mainA = site.mains[Math.floor(rem / R)];
  const region = site.regions[rem % R];
  return makePage(site, domain, region, mainA, j);
}
const homePagesCache = new Map();
function homePages(domain, subIndex) {
  const key = `${domain}|${subIndex}`;
  if (homePagesCache.has(key)) return homePagesCache.get(key);
  const homes = homeMap(domain); const out = [];
  for (let i = 0; i < homes.length; i += 1) if (homes[i] === subIndex) out.push(pageAt(domain, i));
  if (homePagesCache.size > 300) homePagesCache.delete(homePagesCache.keys().next().value);
  homePagesCache.set(key, out);
  return out;
}

/* ---------- 네이버 소유확인 메타 (사이트별 gen/naver_meta.json) ---------- */
const metaCache = new Map();
function naverToken(domain, sub) {
  const path = `C:/xampp/sites/${domain}/gen/naver_meta.json`;
  try {
    const mtime = statSync(path).mtimeMs;
    let ent = metaCache.get(domain);
    if (!ent || ent.mtime !== mtime) { ent = { mtime, map: JSON.parse(readFileSync(path, 'utf8')) }; metaCache.set(domain, ent); }
    const v = ent.map[sub || '@'];
    return v && /^[0-9a-f]{16,}$/i.test(v) ? v : '';
  } catch { return ''; }
}

/* ---------- 유틸 ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function pickRotated(list, count, index) {
  if (!list.length) return [];
  const out = []; const step = Math.max(1, Math.floor(list.length / Math.max(1, count)));
  for (let i = 0; i < count; i += 1) out.push(list[(index + i * step) % list.length]);
  return out;
}
const homeUrl = (page) => `https://${site.subsByDomain.get(page.domain)[page.homeIndex]}.${page.domain}${page.encodedPath}`;

/* ---------- 랜딩 데이터 ---------- */
function landingData(host, page) {
  const { region, mainA, mainB, sub, tail } = page;
  const location = region.name; const shortLocation = region.label; const mainKeyword = mainA.name;
  const siteUrl = `https://${host}`;
  const canonical = `${siteUrl}${page.encodedPath}`;
  const seed = hash32(`piping-xyz|${page.domain}|${region.index}|${mainKeyword}|${page.j}`);
  const phaseSubs = site.phaseSubs[mainA.phase];
  const title = page.title;
  const description = `${location} ${mainKeyword} 관련 업체를 찾는 사용자를 위해 ${mainKeyword}, ${mainB.name}, ${sub} 정보를 한 화면에 정리했습니다. 24시간 긴급 출동 및 무료 상담.`;
  const keywords = `${location}, ${mainKeyword}, ${mainB.name}, ${sub}, 하수구막힘, 수전교체, 누수탐지, 긴급출동`;
  const headline = title;
  const subheadline = `${location} 인근 ${mainKeyword} 관련 업체들의 위치와 상담 정보를 한 번에 비교해 볼 수 있습니다.`;
  const summaryTitle = `${location} ${mainKeyword} 위치 정보 및 관련 업체 안내`;
  const summaryText = `${location} 일대에서 ${mainKeyword}, ${mainB.name} 등 관련 키워드를 기준으로 검색된 곳 가운데 지도 확인에 참고하기 좋은 주소 카드를 최대 6곳까지 정리했습니다.`;
  const placeCategories = oldConfig.placeCategories;
  const categoryLabel = placeCategories[seed % placeCategories.length];
  const carousel = oldConfig.images.carousel;
  const img = (f) => `${ASSET}/img/piping/${f}`;
  const strip = carousel.map((c, i) => ({ src: img(c.file), alt: `${location} ${mainKeyword} 상담 이미지 ${i + 1}`, label: c.label }));

  const mainPartners = pickRotated(mainA.subs, 6, seed);
  const subPool = phaseSubs.filter((k) => k !== mainKeyword && !mainPartners.includes(k));
  const subs = pickRotated(subPool, 12, seed);
  const spots = nearbyRegions(site, region, 6, seed);
  const places = spots.map((spot, i) => {
    const main2 = i === 0 ? mainB.name : (mainPartners[i % mainPartners.length] || mainB.name);
    const sub1 = subs[(i * 2) % subs.length] || sub; const sub2 = subs[(i * 2 + 1) % subs.length] || sub;
    return {
      rank: i + 1,
      name: `${spot.label} ${mainKeyword} ${main2} ${sub1} ${sub2}`,
      category: placeCategories[(seed + i) % placeCategories.length],
      address: spot.search,
      keywordText: `#${mainKeyword} #${main2} #긴급출동`,
      desc: `${spot.label} 일대 ${sub1} 문의와 ${mainKeyword} 현장 점검을 함께 확인할 수 있습니다.`,
      naverMap: `https://map.naver.com/v5/search/${encodeURIComponent(`${spot.search} ${main2} 업체`)}`,
      googleMap: `https://www.google.com/maps/search/${encodeURIComponent(`${spot.search} ${main2}`)}`,
    };
  });
  const promoBanners = [{ src: img(oldConfig.images.promo), alt: `${shortLocation} 하수구 막힘 변기 막힘 싱크대 막힘 24시간 신속 출동`, wide: true }];

  const blocks = (faqData.blocks || []).filter((b) => b.phase === mainA.phase || b.phase === '공통');
  const rest = blocks.map((_, i) => i).filter((i) => i !== 0);
  const picked = [0, ...pickRotated(rest, 3, seed % Math.max(1, rest.length))];
  const fill = (t) => String(t).replace(/\{location\}/g, location).replace(/\{shortLocation\}/g, shortLocation).replace(/\{main\}/g, mainKeyword);
  const faqs = picked.map((bi, i) => { const b = blocks[bi] || blocks[0]; return { q: fill((b.q || [])[(seed + i * 7) % b.q.length] || ''), a: fill((b.a || [])[(seed + i * 11) % b.a.length] || '') }; });

  // 페이지 이동: 같은 지역의 다른 메인 10개 → 각자의 집 서브도메인 절대주소 (복사본이 안 생기게)
  const others = site.mains.filter((m) => m.name !== mainKeyword);
  const start = seed % others.length;
  const pager = Array.from({ length: 10 }, (_, i) => {
    const m = others[(start + i) % others.length];
    const p = makePage(site, page.domain, region, m, 1);
    return { href: homeUrl(p), label: m.name, activeClass: '', isActive: false };
  });
  const pagerNext = { href: `https://${site.subsByDomain.get(page.domain)[page.homeIndex]}.${page.domain}/`, label: '상담 안내 홈' };
  const thumbs = carousel.map((c, i) => ({ src: img(c.file), alt: `${location} ${mainKeyword} 현장 사진 ${i + 1}` }));
  const resourceTitles = ['욕실 하수구 악취 해결 상담 안내', '화장실 물내림 불량과 배관 흐름 점검', '변기막힘 비용 문의와 현장 상황 상담', '배관 장비 투입이 필요한 막힘 상담'];
  const resources = resourceTitles.map((rt, i) => ({ thumb: img(carousel[(i + 1) % carousel.length].file), title: rt }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: region.sido, item: siteUrl },
        { '@type': 'ListItem', position: 2, name: location, item: canonical },
        { '@type': 'ListItem', position: 3, name: `${shortLocation} ${mainKeyword}`, item: canonical } ] },
      { '@type': 'Service', name: `${location} ${mainKeyword} 긴급출동`, serviceType: '배관설비공사',
        provider: { '@type': 'LocalBusiness', name: `${location} ${mainKeyword}` },
        areaServed: { '@type': 'AdministrativeArea', name: location } },
      { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
    ],
  };
  const itemListJson = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: carousel.map((c, i) => {
    const src = `${siteUrl}${img(c.file)}`; const caption = `${location} ${mainKeyword} ${c.label}`;
    return { '@type': 'ListItem', position: i + 1, name: caption, image: src, url: canonical,
      item: { '@type': 'ImageObject', url: src, contentUrl: src, name: caption, caption, width: c.width || 640, height: c.height || 640 } };
  }) };

  // 폼·전화는 HTML 에 넣지 않는다. hub-inject.js 가 브라우저에서 넣는다 (2026-09-14 결정, 노마드 방식).
  return {
    title, description, keywords, canonical, naverSiteVerification: '', rssHref: '', sitemapHref: '',
    assetBase: ASSET, assetVersion: VER, location, shortLocation, mainKeyword, headline, subheadline,
    leadApi: config.leadApi, leadProject: config.leadProject, phone: config.phone, phoneTel: config.phoneTel, showForm: true, platformBase: PLATFORM_BASE,
    heroImage: { src: img(oldConfig.images.hero), alt: `${location} ${mainKeyword} 24시간 긴급출동 상담 안내` },
    summaryTitle, summaryText, categoryLabel, strip, places, promoBanners, faqs, pager, pagerNext, thumbs, resources,
    jsonLd: JSON.stringify(jsonLd), itemListJson: JSON.stringify(itemListJson), pagePath: page.encodedPath,
  };
}

/* hub-inject.js — 브라우저에서 전화 배너·미니 CTA·견적 폼을 그려 넣는다. 폼 마크업은 partials/estimate-form.html 그대로. */
const formPartialSource = readFileSync(join(templateDir, 'partials', 'estimate-form.html'), 'utf8');
const hubInjectJs = `(function(){
var s=document.currentScript;if(!s)return;var d=s.dataset;
var BASE=${JSON.stringify(PLATFORM_BASE)},tel=${JSON.stringify(config.phoneTel)},phone=${JSON.stringify(config.phone)},proj=d.leadProject||'',loc=d.location||'';
var callHref=BASE+'/call/'+tel;   // 전화 클릭 추적: 플랫폼 도메인이 기록하고 tel: 로 넘긴다 (노마드 nicheon.kr/call/ 방식)
function esc(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
var callHtml='<a class="post-call" href="'+callHref+'" aria-label="전화 상담 '+esc(phone)+'"><span>⚡ 각종 막힘 / 뚫음 / 수전 / 배관공사 전국 24시 빠른출동</span><strong>📞 '+esc(phone)+'</strong><small>터치하시면 바로 전화가 연결됩니다</small></a>';
var calls=document.querySelectorAll('[data-hub-call]');for(var i=0;i<calls.length;i++){calls[i].outerHTML=callHtml;}
var formMount=document.querySelector('[data-hub-form]');
if(formMount){var src=BASE+'/embed/form?p='+encodeURIComponent(proj)+'&loc='+encodeURIComponent(loc)+'&parent='+encodeURIComponent(location.href);
formMount.outerHTML='<div id="estimate" class="hub-embed"><iframe id="hubFormFrame" src="'+src+'" title="빠른 견적 문의" style="width:100%;border:0;height:680px;display:block;background:transparent" scrolling="no"></iframe></div>';
/* 높이는 iframe 이 알려준 값 그대로 쓴다. 여유분을 더하면 그만큼 다음 측정값이 커져 계속 자란다. */
window.addEventListener('message',function(e){if(e.origin!==BASE)return;var m=e.data||{};
if(m.type==='hub-form-height'&&m.height>0&&m.height<4000){var f=document.getElementById('hubFormFrame');if(f&&Math.abs(parseInt(f.style.height,10)-m.height)>2)f.style.height=m.height+'px';}});}
var minis=document.querySelectorAll('[data-hub-minicta]');
for(var j=0;j<minis.length;j++){minis[j].innerHTML=(formMount?'<a href="#estimate">방문서비스 접수가 필요하신가요?</a>':'<a href="'+callHref+'">방문서비스 접수 전화 상담</a>')+'<a href="'+callHref+'">24시간 빠른 상담 전화연결</a>';}
var tels=document.querySelectorAll('[data-hub-tel]');for(var k=0;k<tels.length;k++){tels[k].setAttribute('href',callHref);}
})();
`;

/* ---------- 인덱스 페이지 (루트 · 시도) ---------- */
function shell({ title, description, canonical, token, body, extraHead = '' }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="index, follow">
${token ? `<meta name="naver-site-verification" content="${esc(token)}">\n` : ''}<meta property="og:locale" content="ko_KR">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="${ASSET}/site/${VER}/favicon.ico" sizes="any">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">
<link rel="stylesheet" href="${ASSET}/site/${VER}/piping.css">
<style>
.area-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.area-links a{background:#fff;border:1px solid var(--line);border-radius:8px;padding:9px 13px;font-size:.86rem;font-weight:700;color:#334155;text-decoration:none}
.area-links a:hover{border-color:var(--red-dark);color:var(--red-dark)}
.area-links a small{display:block;font-weight:400;color:#64748b;font-size:.72rem}
</style>${extraHead}
</head>
<body class="post-page">
<main id="top" class="post-shell">
${body}
</main>
</body>
</html>`;
}
const callBlock = () => `
  <a class="post-call" href="tel:${config.phoneTel}" aria-label="전화 상담 ${config.phone}">
    <span>⚡ 각종 막힘 / 뚫음 / 수전 / 배관공사 전국 24시 빠른출동</span>
    <strong>📞 ${config.phone}</strong>
    <small>터치하시면 바로 전화가 연결됩니다</small>
  </a>
  <section class="post-notice">
    <p><strong>긴급 서비스 및 견적요청</strong>은 전화연결을 이용해 주세요.</p>
    <p>아래 지역별 안내에서 해당 지역의 상담 정보를 확인하실 수 있습니다.</p>
  </section>`;

/**
 * 등록 서브도메인 루트 = 폼 없는 랜딩 한 장 (2026-09-14 결정: 링크 목록 루트는 도어웨이 신호).
 * 대표 조합 = 이 서브도메인의 첫 집 페이지의 (지역, 메인A). 변형 j = k+1 로 만들어 제목·짝·꼬리가
 * 실제 랜딩과 겹치지 않는다. 링크는 집 페이지 10개만 (페이지 이동 자리).
 */
function rootLandingHtml(host, hit) {
  const pages = homePages(hit.root, hit.index);
  if (!pages.length) return null;
  const rep = pages[0];
  const page = makePage(site, hit.root, rep.region, rep.mainA, site.k + 1);
  const data = landingData(host, page);
  data.canonical = `https://${host}/`;
  data.pagePath = '/';
  data.naverSiteVerification = naverToken(hit.root, hit.sub);
  data.showForm = true;    // 루트에도 견적 폼을 넣는다 (2026-09-15 결정). 폼·전화는 여전히 JS 주입이라 HTML 엔 안 보인다.
  data.description = `${page.region.name} ${page.mainA.name}, ${page.mainB.name} 등 배관 막힘 · 누수 · 수전 상담 정보를 지역별로 안내합니다. 24시간 긴급 출동 및 무료 상담.`;
  const start = hash32(`rootpager|${host}`) % pages.length;
  data.pager = Array.from({ length: Math.min(10, pages.length) }, (_, i) => { const p = pages[(start + i) % pages.length]; return { href: p.encodedPath, label: `${p.region.label} ${p.mainA.name}`, activeClass: '', isActive: false }; });
  data.pagerNext = { href: pages[(start + 10) % pages.length].encodedPath, label: '다른 지역 보기' };
  data.jsonLd = data.jsonLd.split(page.encodedPath).join('/');
  data.itemListJson = data.itemListJson.split(page.encodedPath).join('/');
  return renderTemplate(pageTpl, data);
}

function rootIndexHtml(host, hit) {
  const pages = homePages(hit.root, hit.index);
  const bySido = new Map();
  for (const p of pages) bySido.set(p.region.sido, (bySido.get(p.region.sido) || 0) + 1);
  const sidoOrder = ['서울', '경기도', '인천', '부산', '대구', '대전', '울산', '세종', '강원도', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
  const links = sidoOrder.filter((s) => bySido.has(s)).map((s) => `<a href="/${encodeURIComponent(URL_ROOT)}/${encodeURIComponent(s)}/">${esc(s)} 배관 상담<small>${bySido.get(s)}개 지역</small></a>`).join('');
  const sample = pages.slice(0, 24).map((p) => `<a href="${p.encodedPath}">${esc(p.region.label)} ${esc(p.mainA.name)}</a>`).join('');
  const title = `전국 배관 막힘 · 누수 · 수전 상담 안내 (${pages.length}개 지역 페이지)`;
  const description = `배관막힘, 하수구·싱크대 막힘, 누수탐지, 수전 교체 상담을 시도별·지역별로 안내합니다. ${pages.length}개 지역 페이지에서 해당 지역 정보를 확인하실 수 있습니다.`;
  const body = `
  <header class="post-header"><h1>${esc(title)}</h1><p>${esc(description)}</p></header>
  ${callBlock()}
  <section class="post-places" aria-label="시도별 안내">
    <div class="section-heading"><span>Area</span><h2>시도별 배관 상담 안내</h2></div>
    <nav class="area-links">${links}</nav>
  </section>
  <section class="post-places" aria-label="최근 지역">
    <div class="section-heading"><span>Recent</span><h2>지역별 상담 바로가기</h2></div>
    <nav class="area-links">${sample}</nav>
  </section>`;
  return shell({ title, description, canonical: `https://${host}/`, token: naverToken(hit.root, hit.sub), body });
}
function sidoIndexHtml(host, hit, sido) {
  const pages = homePages(hit.root, hit.index).filter((p) => p.region.sido === sido);
  if (!pages.length) return null;
  const chips = pages.map((p) => `<a href="${p.encodedPath}">${esc(p.region.label)} ${esc(p.mainA.name)}<small>${esc(p.mainB.name)} · ${esc(p.sub)}</small></a>`).join('');
  const title = `${sido} 배관 막힘 · 누수 · 수전 상담 안내 (${pages.length}곳)`;
  const description = `${sido} 지역의 배관막힘, 하수구·싱크대 막힘, 누수탐지, 수전 교체 상담 페이지 ${pages.length}곳을 모았습니다.`;
  const body = `
  <header class="post-header"><h1>${esc(title)}</h1><p>${esc(description)}</p></header>
  ${callBlock()}
  <section class="post-places" aria-label="지역별 안내">
    <div class="section-heading"><span>Area</span><h2>${esc(sido)} 지역별 배관 상담 안내 (${pages.length}곳)</h2></div>
    <nav class="area-links">${chips}</nav>
    <p style="margin-top:14px"><a href="/">← 전국 안내로</a></p>
  </section>`;
  return shell({ title, description, canonical: `https://${host}/${encodeURIComponent(URL_ROOT)}/${encodeURIComponent(sido)}/`, token: '', body });
}

/* ---------- 정적 자산 ---------- */
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const assetCache = new Map();
function serveAsset(urlPath, res) {
  let rel = null;
  const m1 = urlPath.match(new RegExp(`^${ASSET}/site/[^/]+/([a-z0-9._-]+)$`, 'i'));
  const m2 = urlPath.match(new RegExp(`^${ASSET}/img/piping/([a-z0-9._-]+)$`, 'i'));
  if (m1) rel = join(templateDir, 'assets', m1[1]);
  else if (m2) rel = join(templateDir, 'assets', 'img', m2[1]);
  if (!rel || !existsSync(rel)) return false;
  let buf = assetCache.get(rel);
  if (!buf) { buf = readFileSync(rel); assetCache.set(rel, buf); }
  res.writeHead(200, { 'content-type': MIME[extname(rel).toLowerCase()] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(buf);
  return true;
}

/* ---------- 접수 API ---------- */
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python-requests|headless/i;
const rate = new Map(); const RATE_LIMIT = 20; const RATE_WINDOW = 600_000;
const digits = (v) => String(v || '').replace(/\D+/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
function clientIp(req) {
  const xf = req.headers['x-forwarded-for']; const v = (xf ? String(xf).split(',')[0] : req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(v) || /^[0-9a-f:]+$/i.test(v) ? v : null;
}
async function handleLead(req, res, host) {
  const send = (obj, status = 200) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
  let raw = ''; let over = false;
  await new Promise((ok) => { req.on('data', (d) => { raw += d; if (raw.length > 65536) { over = true; req.destroy(); ok(); } }); req.on('end', ok); req.on('error', ok); });
  if (over) return send({ ok: false, error: '요청이 너무 큽니다.' }, 413);
  let payload; try { payload = JSON.parse(raw || '{}'); } catch { return send({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, 400); }
  const ua = String(req.headers['user-agent'] || '');
  if (BOT_UA.test(ua)) return send({ ok: true });
  if (clean(payload.company, 100)) return send({ ok: true });            // 허니팟
  const ip = clientIp(req);
  const now = Date.now(); const ent = rate.get(ip) || { n: 0, t: now };
  if (now - ent.t > RATE_WINDOW) { ent.n = 0; ent.t = now; }
  ent.n += 1; rate.set(ip, ent);
  if (ent.n > RATE_LIMIT) return send({ ok: false, error: '잠시 후 다시 시도해 주세요.' }, 429);
  const name = clean(payload.name, 60), phone = digits(payload.phone), message = clean(payload.message, 2000);
  if (name.length < 2) return send({ ok: false, error: '이름을 입력해 주세요.' }, 400);
  if (phone.length < 9 || phone.length > 11) return send({ ok: false, error: '연락처를 정확히 입력해 주세요.' }, 400);
  if (!message) return send({ ok: false, error: '문의내용을 입력해 주세요.' }, 400);
  if (payload.consent !== true) return send({ ok: false, error: '개인정보 수집 및 이용에 동의해 주세요.' }, 400);
  // iframe 폼이면 pageUrl 은 임베드 주소(…/embed/form?parent=<랜딩주소>) 라서 parent 를 꺼내 랜딩 호스트·주소로 기록한다
  let pageUrl = clean(payload.pageUrl, 500); let srcHost = clean(payload.sourceDomain, 200) || host;
  try { const parent = new URL(pageUrl).searchParams.get('parent'); if (parent) { pageUrl = parent.slice(0, 500); srcHost = new URL(parent).hostname; } } catch {}
  const row = {
    group_key: config.groupKey, host: srcHost, site_url: pageUrl,
    area_name: clean(payload.area, 200), customer_name: name, customer_phone: phone, service_type: config.serviceType,
    request_notes: message, referer: clean(payload.referrer || req.headers.referer, 500), user_agent: ua.slice(0, 500), client_ip: ip,
  };
  try {
    await pool.query(
      `insert into lead_submissions (group_key, host, site_url, area_name, customer_name, customer_phone, service_type, request_notes, referer, user_agent, client_ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.group_key, row.host, row.site_url, row.area_name, row.customer_name, row.customer_phone, row.service_type, row.request_notes, row.referer, row.user_agent, row.client_ip]);
  } catch (e) { console.error('lead insert 실패', e.message); return send({ ok: false, error: '접수 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 502); }
  send({ ok: true });
  if (TG_TOKEN && TG_CHAT) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `🔧 배관 신규 접수\n이름: ${row.customer_name}`, disable_web_page_preview: true }) })
      .then((r) => { if (!r.ok) console.error('telegram', r.status); }).catch((e) => console.error('telegram 실패', e.message));
  }
}

/* ---------- 전화 클릭 추적: GET /api/call/<번호> → call_clicks 기록 → tel: 로 넘기는 200 페이지 ---------- */
function handleCall(req, res, host, digits) {
  if (digits !== config.phoneTel) return notFound(res);               // 우리 번호만 (오픈 리다이렉트 방지)
  const referer = String(req.headers.referer || '').slice(0, 500);
  const ua = String(req.headers['user-agent'] || '').slice(0, 500);
  let pageHost = host;                                                  // 플랫폼 도메인에서 호출되면 랜딩 호스트는 Referer 에서
  try { if (referer) pageHost = new URL(referer).hostname; } catch {}
  if (!BOT_UA.test(ua)) {
    pool.query(
      `insert into call_clicks (group_key, host, page_url, phone, referer, user_agent, client_ip) values ($1,$2,$3,$4,$5,$6,$7)`,
      [config.groupKey, pageHost, referer, digits, referer, ua, clientIp(req)],
    ).catch((e) => console.error('call_clicks 실패', e.message));
  }
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>24시 긴급상담 전화연결</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<script>location.href="tel:${digits}";</script>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f5f5f5}.box{max-width:420px;margin:80px auto;background:#fff;padding:28px;text-align:center;border:1px solid #ddd}.num{font-size:26px;font-weight:bold;margin:20px 0}.btn{display:inline-block;padding:14px 22px;background:#dc3545;color:#fff;text-decoration:none;border-radius:10px;font-weight:700}</style></head>
<body><div class="box"><p>각종 막힘 / 뚫음 / 수전 / 배관공사 24시 긴급상담</p><div class="num">${esc(config.phone)}</div><a class="btn" href="tel:${digits}">전화 연결이 안 되면 여기를 누르세요</a></div></body></html>`;
  const b = Buffer.from(body, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
}

/* ---------- 플랫폼 호스트 (go.daddul.com): 주입 스크립트 · 접수 iframe · 전화 추적 · 접수 API ---------- */
function embedFormHtml(loc, proj) {
  const form = renderTemplate(formTpl, { leadApi: config.leadApi, leadProject: proj || config.leadProject, location: loc || '' });
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>빠른 견적 문의</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">
<link rel="stylesheet" href="/css/piping.css">
<style>html,body{margin:0;background:transparent}main.post-shell{padding:0 2px;max-width:none}</style></head>
<body class="post-page"><main class="post-shell">${form}</main>
<script>(function(){
/* ⚠ documentElement.scrollHeight 를 쓰면 안 된다. 그 값은 최소한 iframe 뷰포트 높이라서
   부모가 그 높이로 iframe 을 키우면 다음 측정값도 같이 커진다 — 높이가 끝없이 자라
   폼 아래로 빈 공간이 계속 늘어난다 (2026-09-15 실제로 발생).
   내용 요소의 실제 높이를 재고, 2px 이내 변화는 무시해 진동도 막는다. */
var last=0;
function measure(){var el=document.querySelector('main');return el?Math.ceil(el.getBoundingClientRect().height):document.body.scrollHeight;}
function post(){try{var h=measure();if(!h||Math.abs(h-last)<=2)return;last=h;parent.postMessage({type:'hub-form-height',height:h},'*');}catch(e){}}
window.addEventListener('load',post);window.addEventListener('resize',post);
if(window.ResizeObserver){var m=document.querySelector('main');if(m)new ResizeObserver(post).observe(m);}
setInterval(post,1500);})();</script>
<script src="/js/piping.js" defer></script></body></html>`;
}
function servePlatform(req, res, urlPath, host) {
  if (urlPath === '/healthz') return html(res, JSON.stringify({ ok: true, platform: PLATFORM, uptimeSec: Math.round((Date.now() - started) / 1000) }));
  if (urlPath === '/js/hub-inject.js') {
    const b = Buffer.from(hubInjectJs, 'utf8');
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=3600' });
    return res.end(b);
  }
  if (urlPath === '/js/piping.js' || urlPath === '/css/piping.css' || urlPath === '/favicon.ico') {
    const rel = join(templateDir, 'assets', urlPath.split('/').pop());
    if (!existsSync(rel)) return notFound(res);
    let buf = assetCache.get(rel); if (!buf) { buf = readFileSync(rel); assetCache.set(rel, buf); }
    res.writeHead(200, { 'content-type': MIME[extname(rel).toLowerCase()] || 'application/octet-stream', 'content-length': buf.length, 'cache-control': 'public, max-age=3600' });
    return res.end(buf);
  }
  if (urlPath === '/embed/form') {
    const q = new URL(req.url, 'http://x').searchParams;
    const b = Buffer.from(embedFormHtml(String(q.get('loc') || '').slice(0, 60), String(q.get('p') || '').slice(0, 40)), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
    return res.end(b);
  }
  const callM = urlPath.match(/^\/(?:api\/)?call\/(\d{9,11})$/);
  if (callM) return handleCall(req, res, host, callM[1]);
  if (urlPath === config.leadApi) {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    return handleLead(req, res, host);
  }
  return notFound(res);
}

/* ---------- 라우터 ---------- */
const pageCache = new Map(); const PAGE_CACHE = Number(config.server.pageCacheSize) || 4000;
const putCache = (k, v) => { if (pageCache.size >= PAGE_CACHE) pageCache.delete(pageCache.keys().next().value); pageCache.set(k, v); };
const started = Date.now(); let served = 0;
function html(res, body, status = 200) { const b = Buffer.from(body, 'utf8'); res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=600' }); res.end(b); }
function notFound(res) { html(res, '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>페이지를 찾을 수 없습니다</title><meta name="robots" content="noindex"></head><body><h1>페이지를 찾을 수 없습니다</h1></body></html>', 404); }

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
    const urlPath = (req.url || '/').split('?')[0];
    if (PLATFORM && host === PLATFORM) return servePlatform(req, res, urlPath, host);
    if (urlPath === '/healthz') return html(res, JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - started) / 1000), served, cache: pageCache.size }));
    if (urlPath === `${ASSET}/site/${VER}/hub-inject.js`) {
      const b = Buffer.from(hubInjectJs, 'utf8');
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=3600' });
      return res.end(b);
    }
    if (urlPath.startsWith(ASSET + '/')) { if (serveAsset(urlPath, res)) return; return notFound(res); }
    if (urlPath === config.leadApi) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      return handleLead(req, res, host);
    }
    const callM = urlPath.match(/^\/api\/call\/(\d{9,11})$/);
    if (callM) return handleCall(req, res, host, callM[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const hit = resolveHost(site, host);
    if (!hit) return notFound(res);
    // 루트는 소유확인 메타태그를 싣는다. gen/naver_meta.json 이 바뀌면(내보내기 직후) 캐시 키가 바뀌어 새로 렌더된다.
    const metaStamp = urlPath === '/' ? (() => { try { return statSync(`C:/xampp/sites/${hit.root}/gen/naver_meta.json`).mtimeMs; } catch { return 0; } })() : 0;
    const cacheKey = `${host}${urlPath}|${metaStamp}`;
    const cached = pageCache.get(cacheKey);
    if (cached) { served += 1; return html(res, cached); }

    let out = null;
    if (urlPath === '/') {
      if (hit.registered) out = rootLandingHtml(host, hit);          // 목록(rootIndexHtml)·시도 목록(sidoIndexHtml)은 쓰지 않는다 — 도어웨이 신호
    } else {
      const page = parsePath(site, hit.root, urlPath);
      if (page) out = renderTemplate(pageTpl, landingData(host, page));
    }
    if (!out) return notFound(res);
    putCache(cacheKey, out); served += 1;
    return html(res, out);
  } catch (e) {
    console.error(new Date().toISOString(), req.url, e.stack || e.message);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('server error'); }
  }
});
server.keepAliveTimeout = 65_000;
server.listen(config.server.port, config.server.host, () => {
  console.log(`hub-render-server listening on http://${config.server.host}:${config.server.port} (domains ${config.domains.length}, regions ${site.regions.length}, mains ${site.mains.length}, k ${site.k}, telegram ${TG_TOKEN ? 'on' : 'off'})`);
  // 집 서브도메인 색인을 미리 만들어 둔다 (도메인당 약 3초). 안 하면 루트 인덱스 첫 요청이 4초 걸린다.
  setImmediate(() => {
    const t0 = Date.now();
    for (const d of config.domains) { try { homeMap(d); } catch (e) { console.error('homeMap 실패', d, e.message); } }
    console.log(`home maps ready (${config.domains.length} domains, ${Date.now() - t0} ms)`);
  });
});
