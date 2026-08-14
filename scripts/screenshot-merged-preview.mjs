/**
 * 합친 템플릿을 실제 브라우저로 띄워 스크린샷을 찍는다.
 *
 * 이미지 src 가 /cleaning/... 절대경로라 file:// 로 열면 이미지가 안 뜬다.
 * apps/cleaning-ravi/public 을 문서 루트로 하는 임시 서버를 띄워서 찍는다.
 *
 * 사용:
 *   node scripts/screenshot-merged-preview.mjs
 *   node scripts/screenshot-merged-preview.mjs --page 7
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicDir = resolve(repoRoot, 'apps/cleaning-ravi/public');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const pageId = arg('page', '1');

/** 두 벌을 렌더한다: 부트스트랩 대체 CSS 있는 것 / 없는 것. */
// --home 을 주면 홈만, 아니면 하위 페이지 두 벌을 찍는다.
const variants = process.argv.includes('--home')
  ? [{ key: 'home', file: 'preview_merged_home.html', extra: ['--home'] }]
  : [
    { key: 'with-shim', file: 'preview_merged_with_shim.html', extra: [] },
    { key: 'no-shim', file: 'preview_merged_no_shim.html', extra: ['--no-shim'] },
  ];

for (const variant of variants) {
  execFileSync(process.execPath, [
    join(here, 'render-merged-preview.mjs'),
    '--page', pageId,
    '--out', variant.file,
    ...variant.extra,
  ], { cwd: repoRoot, stdio: 'pipe' });
  console.log(`렌더: ${variant.file}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // /preview/<key> 는 렌더된 HTML, 나머지는 public/ 에서 찾는다.
  const variant = variants.find((v) => urlPath === `/preview/${v.key}`);
  const filePath = variant ? resolve(repoRoot, variant.file) : join(publicDir, urlPath);

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
});

await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;
console.log(`임시 서버: http://127.0.0.1:${port}`);

const { chromium } = await import('playwright');
let browser;
for (const channel of ['msedge', 'chrome', null]) {
  try {
    browser = await chromium.launch(channel ? { channel, headless: true } : { headless: true });
    break;
  } catch { /* 다음 후보 */ }
}
if (!browser) {
  server.close();
  throw new Error('브라우저를 못 띄웠습니다. playwright 브라우저 설치가 필요합니다.');
}

const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });

for (const variant of variants) {
  await page.goto(`http://127.0.0.1:${port}/preview/${variant.key}`, { waitUntil: 'networkidle' });

  // 실제 페이지는 loading="lazy" 라 화면 밖 이미지가 안 뜬다. 캡처용으로만 강제 로드한다.
  // 그리고 sticky header 가 요소 스크린샷 위에 겹치므로 잠시 숨긴다.
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
    const header = document.querySelector('header');
    if (header) header.style.position = 'static';
    await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => {}))));
  });
  await page.waitForTimeout(800);

  const full = `preview_merged_${variant.key.replace('-', '_')}_full.png`;
  await page.screenshot({ path: resolve(repoRoot, full), fullPage: true });

  // 플레이스 블록만 따로 (차이가 가장 크게 드러나는 구간)
  const block = await page.$('#faq-section .mt-5');
  let cropped = null;
  if (block) {
    cropped = `preview_merged_${variant.key.replace('-', '_')}_places.png`;
    await block.screenshot({ path: resolve(repoRoot, cropped) });
  }

  const broken = await page.evaluate(() =>
    Array.from(document.images).filter((img) => !img.complete || img.naturalWidth === 0).length,
  );
  console.log(JSON.stringify({ variant: variant.key, full, cropped, brokenImages: broken }));
}

await browser.close();
server.close();
console.log('완료');
