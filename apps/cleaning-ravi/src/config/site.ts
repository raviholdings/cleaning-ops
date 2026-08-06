/**
 * Single source of truth for per-deployment site values.
 *
 * Every field is env-driven so the same source tree can be built once per
 * target domain:
 *
 *   PUBLIC_SITE_URL=https://example.kr \
 *   PUBLIC_NAVER_SITE_VERIFICATION=<Search Advisor HTML tag content> \
 *   ASTRO_DIST_DIR=dist/example.kr \
 *   npm run build
 *
 * Values are read from import.meta.env so they are inlined at build time and
 * work in both .astro pages and hydrated React components. astro.config.mjs
 * points Vite's envDir at the repository root, so the root .env is the source.
 */

const env = import.meta.env as Record<string, string | undefined>;

function envValue(name: string, fallback: string): string {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Absolute site origin, never with a trailing slash. */
export const SITE_URL = envValue('PUBLIC_SITE_URL', 'https://example.com').replace(/\/+$/, '');

export const SITE_CONFIG = {
  siteUrl: SITE_URL,
  siteName: envValue('PUBLIC_SITE_NAME', '입주청소114'),
  /** Broad service area, used in copy and structured data. */
  region: envValue('PUBLIC_SITE_REGION', '강남·서초·송파'),
  /** Primary administrative district this build targets. */
  areaName: envValue('PUBLIC_SITE_AREA_NAME', '강남구'),
  city: envValue('PUBLIC_SITE_CITY', '서울특별시'),
  mainKeyword: envValue('PUBLIC_SITE_MAIN_KEYWORD', '입주청소'),

  /** Lead-capture iframe. PUBLIC_LEAD_ROUTER_BASE_URL overrides the host. */
  formSrc: envValue(
    'PUBLIC_LEAD_FORM_URL',
    'https://replyalba.com/intros/_frm/index.php?code=wKSpzJlHMP',
  ),
  jqueryUrl: envValue('PUBLIC_LEAD_JQUERY_URL', 'https://replyalba.com/js/jquery-1.11.0.min.js'),
  iframeResizerUrl: envValue(
    'PUBLIC_LEAD_IFRAME_RESIZER_URL',
    'https://replyalba.com/js/iframeResizer.min.js',
  ),

  telegramLink: envValue('PUBLIC_TELEGRAM_URL', 'https://t.me/'),

  /**
   * Content of Naver Search Advisor's "HTML 태그" ownership check. Empty until
   * the domain is registered in Search Advisor; the meta tag is then emitted
   * and scripts/naver_ownership_only.py can flip the domain to verified.
   */
  naverSiteVerification: envValue('PUBLIC_NAVER_SITE_VERIFICATION', ''),
  googleSiteVerification: envValue('PUBLIC_GOOGLE_SITE_VERIFICATION', ''),

  businessRegistrationNumber: envValue('PUBLIC_BUSINESS_REGISTRATION_NUMBER', ''),
  mailOrderNumber: envValue('PUBLIC_MAIL_ORDER_NUMBER', ''),

  /** Set to false on staging builds to emit noindex. */
  indexable: envValue('PUBLIC_SITE_INDEXABLE', 'true') !== 'false',
} as const;

export const SEO = {
  title: `${SITE_CONFIG.areaName} ${SITE_CONFIG.mainKeyword} 업체 비교 | ${SITE_CONFIG.siteName}`,
  description:
    `${SITE_CONFIG.city} ${SITE_CONFIG.areaName} ${SITE_CONFIG.mainKeyword} 업체를 비용·보험·재작업 조건으로 비교해 ` +
    `가장 나은 곳을 연결해 드립니다. 30초 무료 접수, 당일 출장 가능.`,
  keywords: [
    `${SITE_CONFIG.areaName} ${SITE_CONFIG.mainKeyword}`,
    `${SITE_CONFIG.city} ${SITE_CONFIG.mainKeyword}`,
    `${SITE_CONFIG.mainKeyword} 견적`,
    `${SITE_CONFIG.mainKeyword} 비용`,
    `${SITE_CONFIG.mainKeyword} 업체`,
    '이사청소',
    '아파트 입주청소',
  ].join(', '),
} as const;

/** Routes emitted into sitemap.xml. Extend as pages are added. */
export const SITEMAP_ROUTES = ['/'] as const;
