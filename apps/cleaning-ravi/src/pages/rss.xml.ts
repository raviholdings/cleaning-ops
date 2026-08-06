import type { APIRoute } from 'astro';
import { SITE_CONFIG, SITE_URL } from '../config/site';
import { LOCATIONS, PAGE_COUNT, SITE_INDEX } from '../lib/locations';
import { catalogEntry, pagePath } from '../lib/pageCatalog';
import { buildDescription, buildTitle, type TitleVariant } from '../lib/pageMeta';

/**
 * 네이버 웹마스터도구 가이드(wmt_guide_ps_websearch p.37)가 사이트맵과 나란히
 * 권장하는 항목. "요청 > RSS 제출"로 등록하면 갱신분 수집이 빨라진다.
 */
export const GET: APIRoute = () => {
  const variant = (import.meta.env.PUBLIC_TITLE_VARIANT === 'A' ? 'A' : 'B') as TitleVariant;
  const now = new Date().toUTCString();

  const items = Array.from({ length: PAGE_COUNT }, (_, index) => {
    const requestId = index + 1;
    const entry = catalogEntry({ locations: LOCATIONS, siteIndex: SITE_INDEX, requestId, pageCount: PAGE_COUNT });
    const link = `${SITE_URL}${pagePath(requestId)}`;
    return [
      '    <item>',
      `      <title>${escapeXml(buildTitle(entry.location, entry.mainKeyword, variant))}</title>`,
      `      <link>${link}</link>`,
      `      <guid isPermaLink="true">${link}</guid>`,
      `      <description>${escapeXml(buildDescription(entry.location, entry.mainKeyword, variant))}</description>`,
      `      <pubDate>${now}</pubDate>`,
      '    </item>',
    ].join('\n');
  }).join('\n');

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(SITE_CONFIG.mainKeyword)} 지역별 안내</title>`,
    `    <link>${SITE_URL}/</link>`,
    `    <description>${escapeXml(SITE_CONFIG.mainKeyword)} 지역별 서비스 안내와 견적 신청</description>`,
    '    <language>ko</language>',
    `    <lastBuildDate>${now}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
