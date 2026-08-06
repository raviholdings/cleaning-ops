import type { APIRoute } from 'astro';
import { SITE_URL } from '../config/site';
import { LOCATIONS, PAGE_COUNT, SITE_INDEX } from '../lib/locations';
import { catalogEntry, pagePath } from '../lib/pageCatalog';

/**
 * 이 사이트가 보유한 페이지 전체.
 * scripts/sync-naver-project-page-catalog.mjs 가 같은 목록을
 * naver_project_pages 로 동기화하므로 두 곳이 어긋나면 안 된다.
 *
 * 사이트맵 1개당 URL 50,000건 제한이 있으나 사이트당 100장이라 여유가 있다.
 */
export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = [
    { loc: `${SITE_URL}/`, priority: '1.0' },
    ...Array.from({ length: PAGE_COUNT }, (_, index) => ({
      loc: `${SITE_URL}${pagePath(index + 1)}`,
      priority: '0.8',
    })),
  ]
    .map((entry) =>
      [
        '  <url>',
        `    <loc>${entry.loc}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        '    <changefreq>weekly</changefreq>',
        `    <priority>${entry.priority}</priority>`,
        '  </url>',
      ].join('\n'),
    )
    .join('\n');

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};

/** 카탈로그를 다른 곳에서도 쓰기 위한 헬퍼 */
export function siteCatalog() {
  return Array.from({ length: PAGE_COUNT }, (_, index) =>
    catalogEntry({ locations: LOCATIONS, siteIndex: SITE_INDEX, requestId: index + 1, pageCount: PAGE_COUNT }),
  );
}
