import type { APIRoute } from 'astro';
import { SITE_CONFIG, SITE_URL } from '../config/site';

/**
 * Naver's crawler (Yeti) and Google both read /robots.txt before crawling.
 * Staging builds (PUBLIC_SITE_INDEXABLE=false) disallow everything so an
 * unfinished domain never enters the index.
 */
export const GET: APIRoute = () => {
  const body = SITE_CONFIG.indexable
    ? [
        'User-agent: Yeti',
        'Allow: /',
        '',
        'User-agent: *',
        'Allow: /',
        '',
        `Sitemap: ${SITE_URL}/sitemap.xml`,
        '',
      ].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
