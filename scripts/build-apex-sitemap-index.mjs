#!/usr/bin/env node
/**
 * apex 루트에 서브도메인 사이트맵 인덱스를 굽는다.
 *
 *   node scripts/build-apex-sitemap-index.mjs --root amunsa.com
 *   node scripts/build-apex-sitemap-index.mjs                    # 전체 루트
 *   node scripts/build-apex-sitemap-index.mjs --root amunsa.com --out tmp/apex-sitemaps
 *
 * 왜 이게 필요한가
 *   서브도메인은 구글에게 별개 사이트다. apex 사이트맵에 서브도메인 주소를 넣는 것도,
 *   서브도메인의 사이트맵을 인덱스에 넣는 것도 전부 cross-submission 이라 소유권 확인이
 *   있어야 인정된다. GSC 에 루트를 **도메인 속성(DNS TXT)** 으로 등록하면 서브도메인
 *   전체 소유권이 한 번에 확인되므로 그 조건이 충족된다.
 *   ⚠ DNS TXT 등록은 운영자가 직접 해야 한다. 이 스크립트가 대신 못 한다.
 *
 * 굽는 것 (루트마다 3개)
 *   sitemap.xml         사이트맵 인덱스. 아래 둘 + 서브도메인 사이트맵 전부를 가리킨다
 *   sitemap-pages.xml   apex 자기 페이지 (기존 sitemap.xml 내용을 그대로 옮긴다)
 *   sitemap-hosts.xml   서브도메인 홈 주소 목록
 *
 *   두 갈래를 다 넣는 이유: sitemap-hosts 는 구글이 서브도메인을 "발견" 하게 하고,
 *   서브도메인 사이트맵 직접 참조는 robots.txt 상태와 무관하게 하위 페이지를 넘긴다.
 *   한쪽이 막혀도 다른 쪽이 산다. (배관 신규 9,000개는 robots.txt 에 Sitemap 지시자가
 *   없고 루트 /sitemap.xml 이 404 라, 직접 참조가 없으면 150장이 통째로 안 보인다.)
 *
 * 호스트별 사이트맵 (2026-09-08 표본 12/12 확인)
 *   cleaning-ravi  /sitemap.xml(132) + /piping/sitemap.xml(100) + /이사/sitemap.xml(50)
 *   piping-ravi    /piping/sitemap.xml(150) 만. 루트 /sitemap.xml 은 404 다.
 *
 * ⚠ 이 스크립트는 apex 웹루트의 sitemap.xml 을 덮어쓴다. build-apex-site.mjs 도
 *   sitemap.xml 을 굽는데(2줄짜리 urlset) 그건 여기서 sitemap-pages.xml 로 옮겨진다.
 *   apex 사이트를 다시 배포하면 2줄짜리로 되돌아가므로, 그 뒤에는 이 스크립트를
 *   다시 돌려야 한다.
 *
 * ⚠ 인덱스가 인덱스를 가리키는 건 구글이 지원하지 않는다. 서브도메인 사이트맵은
 *   전부 평범한 urlset 이라 지금 구조는 괜찮다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const onlyRoot = valueOf('--root');
const outDir = resolve(projectRoot, valueOf('--out', 'tmp/apex-sitemaps'));
const noFetch = args.includes('--no-fetch');

/** 그룹별 사이트맵 경로. 없는 경로를 넣으면 GSC 가 전부 오류로 잡는다. */
const SITEMAPS_BY_GROUP = {
  'cleaning-ravi': ['/sitemap.xml', '/piping/sitemap.xml', '/이사/sitemap.xml'],
  'piping-ravi': ['/piping/sitemap.xml'],
};

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const urlset = (locs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + locs.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`).join('\n')
  + '\n</urlset>\n';
const sitemapIndex = (locs) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + locs.map((u) => `  <sitemap><loc>${xmlEscape(u)}</loc></sitemap>`).join('\n')
  + '\n</sitemapindex>\n';

/** apex 자기 페이지 목록. 지금 서비스 중인 sitemap.xml 에서 그대로 가져온다. */
async function apexPages(root) {
  const fallback = [`https://${root}/`, `https://${root}/form/`];
  if (noFetch) return fallback;
  for (const path of ['/sitemap-pages.xml', '/sitemap.xml']) {
    try {
      const res = await fetch(`https://${root}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const text = await res.text();
      // 이미 인덱스로 바뀐 sitemap.xml 이면 여기서 페이지를 못 얻는다 — 다음 후보로.
      if (text.includes('<sitemapindex')) continue;
      const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
      if (locs.length) return locs;
    } catch { /* 다음 후보 */ }
  }
  console.log(`  ⚠ ${root}: 기존 사이트맵을 못 읽어 기본값(홈·/form/)을 씁니다.`);
  return fallback;
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
console.log(`=== apex 사이트맵 인덱스 (${byRoot.size}개 루트) ===`);
console.log(`  출력: ${outDir}\n`);

let totalSitemaps = 0;
let totalUrls = 0;
for (const [root, hosts] of [...byRoot.entries()].sort()) {
  const dir = join(outDir, root);
  mkdirSync(dir, { recursive: true });

  const write = (name, text) => {
    const buf = Buffer.from(text, 'utf8');
    writeFileSync(join(dir, name), buf);
    writeFileSync(join(dir, `${name}.gz`), gzipSync(buf, { level: 6 }));
    return buf.byteLength;
  };

  const pages = await apexPages(root);
  write('sitemap-pages.xml', urlset(pages));
  write('sitemap-hosts.xml', urlset(hosts.map((h) => `https://${h.host}/`)));

  const childSitemaps = [];
  for (const h of hosts) {
    for (const path of SITEMAPS_BY_GROUP[h.group_key]) {
      // 한글 경로(/이사/)는 퍼센트 인코딩해야 한다. 배포된 주소 형태와 같아야 200 이 난다.
      childSitemaps.push(`https://${h.host}${encodeURI(path)}`);
    }
  }
  const indexLocs = [
    `https://${root}/sitemap-pages.xml`,
    `https://${root}/sitemap-hosts.xml`,
    ...childSitemaps,
  ];
  const bytes = write('sitemap.xml', sitemapIndex(indexLocs));

  const cleaning = hosts.filter((h) => h.group_key === 'cleaning-ravi').length;
  const piping = hosts.filter((h) => h.group_key === 'piping-ravi').length;
  // 표본 실측치(2026-09-08). 정확한 총량이 아니라 규모 감각용이다.
  const urls = pages.length + hosts.length + cleaning * (132 + 100 + 50) + piping * 150;
  totalSitemaps += indexLocs.length;
  totalUrls += urls;
  console.log(`  ${root.padEnd(20)} 호스트 ${String(hosts.length).padStart(5)}개 (청소 ${cleaning} · 배관 ${piping})`
    + `  사이트맵 ${String(indexLocs.length).padStart(5)}개  인덱스 ${(bytes / 1024).toFixed(0)}KB  URL 약 ${urls.toLocaleString()}`);
}

console.log(`\n  합계: 사이트맵 ${totalSitemaps.toLocaleString()}개 · URL 약 ${totalUrls.toLocaleString()}`);
console.log('\n  다음: node scripts/deploy-apex-sitemap-index.mjs --dry-run');
if (!existsSync(outDir)) throw new Error('출력이 없습니다.');
