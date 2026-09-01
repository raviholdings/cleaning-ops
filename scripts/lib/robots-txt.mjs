/**
 * robots.txt.
 *
 * 운영자가 준 dr-ddul.com 판을 그대로 따른다 (2026-09-01). 주소·날짜만 사이트 것으로 바꾼다.
 *
 * `User-agent: *  Allow: /` 한 줄이면 사실 기능은 같다. 봇 이름을 일일이 적는 것은
 * 두 가지 이유다.
 *   - 사람이 읽고 "이 봇을 어떻게 대하기로 했나" 를 바로 안다
 *   - 나중에 한 놈만 막고 싶을 때 그 줄만 고치면 된다
 *
 * 막는 것은 넷뿐이다 — 본문을 통째로 퍼가 되파는 쪽이다.
 * AI 학습 봇(GPTBot·ClaudeBot·CCBot 등)은 연다. 인용되는 편이 이득이라는 판단이고,
 * 이건 운영자가 정한 방침이다.
 */

const ALLOW = [
  ['네이버', ['Yeti', 'Blueno', 'Ads-Naver', 'Naver-AI-Bot', 'Naver-Image', 'Naver-Video',
    'Naver-Sitemap-Robot']],
  ['OpenAI / ChatGPT', ['OAI-SearchBot', 'ChatGPT-User', 'GPTBot']],
  ['Anthropic / Claude', ['Claude-User', 'Claude-SearchBot', 'ClaudeBot']],
  ['Google', ['Googlebot', 'Google-Extended']],
  ['Apple', ['Applebot']],
  ['Meta', ['facebookexternalhit', 'Facebot', 'Meta-ExternalFetcher', 'Meta-ExternalAgent']],
  ['Perplexity', ['PerplexityBot', 'Perplexity-User']],
  ['Amazon', ['Amazonbot']],
  ['Common Crawl', ['CCBot']],
  ['검색·탐색 크롤러', ['Bingbot', 'Daum', 'Daumoa', 'Baiduspider', 'YandexBot', 'PetalBot']],
];

/* 본문을 대량으로 퍼가 되파는 쪽. AmazonAdBot 은 광고용이라 여기 둔다. */
const DENY = [
  ['광고 수집', ['AmazonAdBot']],
  ['대량 스크레이퍼 · 데이터 중개', ['Bytespider', 'Diffbot', 'Omgilibot', 'Omgili']],
];

const RULE = 74;
const bar = () => `# ${'='.repeat(RULE)}`;
const head = (t) => `${bar()}\n# ${t}\n${bar()}`;

/**
 * @param {object} o
 * @param {string} o.brand      브랜드 이름 (머리말에 적는다)
 * @param {string} o.siteUrl    https://example.kr
 * @param {string} o.sitemap    사이트맵 색인 주소
 * @param {string} o.updated    YYYY-MM-DD
 */
export function robotsTxt({ brand, siteUrl, sitemap, updated }) {
  const out = [];
  out.push(bar());
  out.push(`# ${brand} OFFICIAL ROBOTS CONTROL INTERFACE`);
  out.push('# Open discovery / citation / training-friendly policy');
  out.push(`# Updated: ${updated}`);
  out.push(bar());
  out.push('');
  out.push('User-agent: *');
  out.push('Allow: /');
  out.push('');
  out.push(`Sitemap: ${sitemap}`);
  out.push('');

  for (const [label, bots] of ALLOW) {
    out.push(head(label));
    out.push('');
    for (const b of bots) {
      out.push(`User-agent: ${b}`);
      out.push('Allow: /');
      out.push('');
    }
  }
  for (const [label, bots] of DENY) {
    out.push(head(label));
    out.push('');
    for (const b of bots) {
      out.push(`User-agent: ${b}`);
      out.push('Disallow: /');
      out.push('');
    }
  }
  /* 마지막 빈 줄 하나만 남긴다 */
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
