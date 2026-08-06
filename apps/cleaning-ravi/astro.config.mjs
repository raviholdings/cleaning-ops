import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

// The repository root holds the single .env shared by the app and the Naver
// automation scripts, so point Vite's env loader there. Only PUBLIC_*-prefixed
// variables are exposed to the client bundle.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const site = process.env.PUBLIC_SITE_URL || 'https://example.com';
const outDir = process.env.ASTRO_DIST_DIR || 'dist';

// 순수 정적 HTML만 내보낸다. React / Tailwind 는 제거했다.
// 네이버 검색로봇(Yeti)은 자바스크립트 해석이 제한적이므로 본문은 전부 HTML로
// 렌더되어야 한다. (웹마스터도구 가이드 quality p.15 Link Syntax, p.26 #2)
export default defineConfig({
  site,
  outDir,
  trailingSlash: 'never',
  build: {
    inlineStylesheets: 'always',
    // 페이지를 디렉터리(/1/index.html)가 아니라 파일(/1.html)로 내보낸다.
    // 레거시 route_style 'slashless' 와 동일한 URL 형태.
    format: 'file',
  },
  vite: { envDir: repoRoot },
});
