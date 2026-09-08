#!/usr/bin/env node
/**
 * apex 루트에 서브도메인 URL 을 담은 사이트맵을 굽는다.
 *
 *   node scripts/build-apex-sitemap-index.mjs --root amunsa.com
 *   node scripts/build-apex-sitemap-index.mjs                      # 전체 루트
 *   node scripts/build-apex-sitemap-index.mjs --root amunsa.com --concurrency 10
 *
 * ── 왜 이 모양인가 (2026-09-08 실측으로 결론) ──
 *
 * 서브도메인은 구글에게 별개 사이트다. apex 사이트맵이 서브도메인을 커버하려면
 * cross-submission 이 인정돼야 하고, 그 조건은 GSC **도메인 속성(DNS TXT)** 으로
 * 루트를 등록하면 충족된다. 서브도메인 사이트맵을 그 속성에 직접 제출했더니
 * 성공 150장으로 받아들여졌다 — 소유권은 확실히 덮인다.
 *
 * 그런데 **사이트맵 색인이 다른 호스트의 사이트맵을 가리키면 구글이 안 따라간다.**
 *   amunsa.com/sitemap.xml -> 2,000개 서브도메인의 사이트맵 4,002개
 *     → 제출 당일 읽음 · 상태 성공 · 발견된 페이지 0
 *   dreamcome.kr/sitemap_index.xml -> 같은 호스트의 사이트맵 10개
 *     → 제출 당일 읽음 · 상태 성공 · 발견된 페이지 5,046
 * 같은 날 같은 조건에서 갈렸다. 색인의 자식은 같은 호스트여야 한다.
 *
 * 그래서 이렇게 만든다 — 파일은 apex 에, URL 만 서브도메인 것으로.
 *   sitemap.xml     색인. 자식은 전부 apex 호스트 (dreamcome.kr 과 같은 모양)
 *   sitemap-N.xml   URL 5만 개씩. 안에 https://<서브도메인>/... 이 들어간다
 *
 * URL 목록은 각 서브도메인의 사이트맵을 실제로 긁어와서 모은다. 배포 로직을
 * 여기서 다시 구현하면 어긋나기 때문이다 (긁으면 배포된 그대로가 나온다).
 *
 * 호스트별 사이트맵 (2026-09-08 표본 12/12)
 *   cleaning-ravi  /sitemap.xml(132) + /piping/sitemap.xml(100) + /이사/sitemap.xml(50)
 *   piping-ravi    /piping/sitemap.xml(150) 만. 루트 /sitemap.xml 은 404 다.
 *
 * ⚠ 오리진은 t3.small 이다. 동시 요청을 올리지 말 것 (기본 10).
 * ⚠ apex 를 다시 배포하면 build-apex-site.mjs 가 sitemap.xml 을 2줄짜리로
 *   되돌린다. 그 뒤에는 이 스크립트와 deploy-apex-sitemap-index.mjs 를 다시 돌려야 한다.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const onlyRoot = valueOf('--root');
const outDir = resolve(projectRoot, valueOf('--out', 'tmp/apex-sitemaps'));
const concurrency = Math.max(1, Number(valueOf('--concurrency', '10')));
const URLS_PER_FILE = 50_000; // 사이트맵 규격 상한

/** 그룹별 사이트맵 경로. 없는 경로를 넣으면 404 를 긁게 된다. */
const SITEMAPS_BY_GROUP = {
  'cleaning-ravi': ['/sitemap.xml', '/piping/sitemap.xml', '/이사/sitemap.xml'],
  'piping-ravi': ['/piping/sitemap.xml'],
};

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const urlset = (locs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + locs.map((u) => `<url><loc>${xmlEscape(u)}</loc></url>`).join('\n')
  + '\n</urlset>\n';
const sitemapIndex = (locs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + locs.map((u) => `  <sitemap><loc>${xmlEscape(u)}</loc></sitemap>`).join('\n')
  + '\n</sitemapindex>\n';

/** 동시 실행 수를 묶어 두는 최소 풀. 오리진이 t3.small 이라 필요하다. */
async function pool(items, limit, worker) {
  const results = [];
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchLocs(url) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { url, locs: [], error: `HTTP ${res.status}` };
      const text = await res.text();
      return { url, locs: [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()) };
    } catch (e) {
      if (attempt === 3) return { url, locs: [], error: String(e.message).slice(0, 60) };
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { url, locs: [], error: 'unreachable' };
}

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const client = new pg.Client({
  connectionString: env.DATABASE_URL || env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
let domains;
try {
  const { rows } = await client.query(
    `select host, group_key from public.naver_project_domains
      where deployment_status = 'active' and is_visible = true
        and group_key = any($1::text[])
      order by host`,
    [Object.keys(SITEMAPS_BY_GROUP)],
  );
  domains = rows;
} finally {
  await client.end();
}

/** foo.anclose.com -> anclose.com. 서브도메인이 한 단계라는 전제다. */
const rootOf = (host) => host.split('.').slice(1).join('.');
const byRoot = new Map();
for (const d of domains) {
  const root = rootOf(d.host);
  if (onlyRoot && root !== onlyRoot) continue;
  if (!byRoot.has(root)) byRoot.set(root, []);
  byRoot.get(root).push(d);
}
if (!byRoot.size) throw new Error(onlyRoot ? `${onlyRoot} 에 활성 서브도메인이 없습니다.` : '활성 서브도메인이 없습니다.');

rmSync(outDir, { recursive: true, force: true });
console.log(`=== apex 사이트맵 (${byRoot.size}개 루트 · 동시 ${concurrency}) ===`);
console.log(`  출력: ${outDir}\n`);

let grandUrls = 0;
let grandFiles = 0;
for (const [root, hosts] of [...byRoot.entries()].sort()) {
  const dir = join(outDir, root);
  mkdirSync(dir, { recursive: true });
  const write = (name, text) => {
    const buf = Buffer.from(text, 'utf8');
    writeFileSync(join(dir, name), buf);
    writeFileSync(join(dir, `${name}.gz`), gzipSync(buf, { level: 6 }));
    return buf.byteLength;
  };

  const targets = [];
  for (const h of hosts) {
    // 한글 경로(/이사/)는 퍼센트 인코딩해야 200 이 난다.
    for (const p of SITEMAPS_BY_GROUP[h.group_key]) targets.push(`https://${h.host}${encodeURI(p)}`);
  }

  process.stdout.write(`  ${root.padEnd(20)} 사이트맵 ${targets.length}개 수집 중...`);
  const started = Date.now();
  const fetched = await pool(targets, concurrency, fetchLocs);
  const failed = fetched.filter((r) => r.error);

  // apex 자기 페이지 + 서브도메인 홈 + 긁어온 URL 전부. 중복은 제거한다.
  const seen = new Set([`https://${root}/`]);
  for (const h of hosts) seen.add(`https://${h.host}/`);
  for (const r of fetched) for (const u of r.locs) seen.add(u);
  const all = [...seen];

  const files = [];
  for (let i = 0; i < all.length; i += URLS_PER_FILE) {
    const name = `sitemap-${files.length + 1}.xml`;
    write(name, urlset(all.slice(i, i + URLS_PER_FILE)));
    files.push(name);
  }
  write('sitemap.xml', sitemapIndex(files.map((f) => `https://${root}/${f}`)));

  const sec = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`\r  ${root.padEnd(20)} 사이트맵 ${String(targets.length).padStart(5)}개 → URL ${all.length.toLocaleString().padStart(9)}개`
    + `  파일 ${String(files.length).padStart(2)}개  ${sec}초`
    + (failed.length ? `  ⚠ 실패 ${failed.length}개` : ''));
  if (failed.length) {
    for (const f of failed.slice(0, 5)) console.log(`      ${f.error}  ${f.url}`);
    if (failed.length > 5) console.log(`      ... 외 ${failed.length - 5}개`);
  }
  grandUrls += all.length;
  grandFiles += files.length + 1;
}

console.log(`\n  합계: URL ${grandUrls.toLocaleString()}개 · apex 파일 ${grandFiles}개`);
console.log('\n  다음: node scripts/deploy-apex-sitemap-index.mjs --root <루트> --dry-run');
