#!/usr/bin/env node
/**
 * 구운 결과를 눈으로 보기 위한 정적 서버. 확인 전용이다 (운영은 nginx).
 *
 *   node scripts/serve-static.mjs --root tmp/brands/dream [--port 4173]
 *
 * file:// 로 열면 /assets/... 같은 절대경로가 C:/assets/... 로 풀려서 CSS 가
 * 통째로 빠진 화면을 보게 된다. 디자인을 확인할 수 없으니 서버로 연다.
 * 127.0.0.1 에만 바인딩한다 — 굽는 중인 사이트를 밖에 열어둘 이유가 없다.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const root = resolve(process.cwd(), valueOf('--root', '.'));
const port = Number(valueOf('--port', '4173'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let path = resolve(join(root, url));

  // 루트 밖으로 나가는 경로는 거절한다 (../ 로 리포지토리 전체가 열리면 안 된다).
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const s = await stat(path).catch(() => null);
    if (!s || s.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<h1>404</h1><p>${url}</p>`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/   ←  ${root}`);
});
