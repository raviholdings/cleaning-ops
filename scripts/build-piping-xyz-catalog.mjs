#!/usr/bin/env node
/**
 * piping-xyz 카탈로그 생성 — 도메인 5개 × (지역 5,032 × 메인 54 × 변형 3) = 4,075,920 페이지.
 *
 *   node scripts/build-piping-xyz-catalog.mjs             # dry-run: 계산·건수 검증·표본, DB 롤백
 *   node scripts/build-piping-xyz-catalog.mjs --apply     # 커밋
 *   node scripts/build-piping-xyz-catalog.mjs --apply --domain pipeinfo.xyz   # 한 도메인만
 *
 * DB (로컬 naver_hub, 도메인마다 한 트랜잭션)
 *   naver_page_keywords    메인 54 upsert
 *   naver_page_locations   지역 5,032 upsert (이름 = 표시명)
 *   naver_project_pages    그 도메인의 piping-xyz 페이지 전부 삭제 후 다시 넣음
 *                          (domain_id = 집 서브도메인, request_id = 서브도메인 안 순번, path = 인코딩된 한글 경로)
 *                          루트 도메인은 '/' 1장 (지역 전국, 키워드 하수구막힘)
 *   naver_project_domains  page_count, region_label='전국', area_name='배관', source_payload.model
 * 파일: C:\xampp\sites\<도메인>\gen\subs.txt  (Apache RewriteMap: "서브 1")
 *
 * 매핑은 scripts/lib/piping-xyz-site.mjs 하나에서만 나온다. 렌더 서버도 같은 파일을 쓴다.
 */
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import pg from 'pg';
import { loadSite, enumerateCatalog } from './lib/piping-xyz-site.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyDomain = (() => { const i = args.indexOf('--domain'); return i === -1 ? null : args[i + 1]; })();
const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops.sh 로 실행)');
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('안전장치: 로컬 DB 가 아닙니다. 중단.');

const site = loadSite();
const { config } = site;
const GROUP = config.groupKey;
const domains = onlyDomain ? [onlyDomain] : config.domains;
const CHUNK = 5000;

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
await c.query(`set statement_timeout = 0`);
try {
  for (const domain of domains) {
    const t0 = Date.now();
    await c.query('begin');
    // 도메인 행
    const { rows: domRows } = await c.query(
      `select id, host from naver_project_domains where group_key = $1 and (host = $2 or host like $3)`, [GROUP, domain, `%.${domain}`]);
    const idByHost = new Map(domRows.map((r) => [r.host, Number(r.id)]));
    const subs = site.subsByDomain.get(domain);
    const missing = subs.filter((s) => !idByHost.has(`${s}.${domain}`));
    if (missing.length) throw new Error(`${domain}: DB 에 없는 서브도메인 ${missing.length}개 (예 ${missing[0]})`);
    if (!idByHost.has(domain)) throw new Error(`${domain}: 루트 행 없음`);

    // 키워드·지역 upsert (search_name 은 생성 칼럼)
    const kwRows = (await c.query(
      `insert into naver_page_keywords (name) select unnest($1::text[])
       on conflict (name) do update set name = excluded.name returning id, name`, [site.mains.map((m) => m.name)])).rows;
    const kwId = new Map(kwRows.map((r) => [r.name, Number(r.id)]));
    const locRows = (await c.query(
      `insert into naver_page_locations (name) select unnest($1::text[])
       on conflict (name) do update set name = excluded.name returning id, name`, [[...site.regions.map((r) => r.name), '전국']])).rows;
    const locId = new Map(locRows.map((r) => [r.name, Number(r.id)]));

    // 기존 페이지 삭제 (이 도메인 것만)
    const del = await c.query(
      `delete from naver_project_pages where group_key = $1 and domain_id = any($2::bigint[])`, [GROUP, [...idByHost.values()]]);

    // 페이지 삽입 (청크)
    let buf = { d: [], r: [], p: [], l: [], k: [] }; let inserted = 0; let seenPaths = 0;
    const flush = async () => {
      if (!buf.d.length) return;
      const res = await c.query(
        `insert into naver_project_pages (group_key, domain_id, request_id, path, location_id, main_keyword_id, content_version)
           select $1, d, r, p, l, k, $2 from unnest($3::bigint[], $4::int[], $5::text[], $6::int[], $7::int[]) as v(d, r, p, l, k)`,
        [GROUP, config.contentVersion, buf.d, buf.r, buf.p, buf.l, buf.k]);
      inserted += res.rowCount; buf = { d: [], r: [], p: [], l: [], k: [] };
    };
    const pending = [];
    const stats = enumerateCatalog(site, domain, (page, requestId, sub) => {
      pending.push([idByHost.get(`${sub}.${domain}`), requestId, page.encodedPath, locId.get(page.region.name), kwId.get(page.mainA.name)]);
    });
    for (const row of pending) {
      if (row.some((x) => x === undefined)) throw new Error('id 매핑 실패: ' + JSON.stringify(row));
      buf.d.push(row[0]); buf.r.push(row[1]); buf.p.push(row[2]); buf.l.push(row[3]); buf.k.push(row[4]); seenPaths += 1;
      if (buf.d.length >= CHUNK) await flush();
    }
    await flush();
    // 루트 1장
    await c.query(
      `insert into naver_project_pages (group_key, domain_id, request_id, path, location_id, main_keyword_id, content_version)
       values ($1, $2, 1, '/', $3, $4, $5)`, [GROUP, idByHost.get(domain), locId.get('전국'), kwId.get('하수구막힘'), config.contentVersion]);

    // 도메인 컬럼
    const subIds = subs.map((s) => idByHost.get(`${s}.${domain}`));
    const counts = stats.perSubdomain;
    await c.query(
      `update naver_project_domains d
          set page_count = v.n, region_label = '전국', area_name = '배관',
              source_payload = coalesce(d.source_payload, '{}'::jsonb) || jsonb_build_object('model', 'catchall-v1', 'pages', v.n, 'variants', $3::int, 'content_version', $4::text),
              updated_at = now()
         from unnest($1::bigint[], $2::int[]) as v(id, n) where d.id = v.id`, [subIds, counts, site.k, config.contentVersion]);
    await c.query(`update naver_project_domains set page_count = 1, updated_at = now() where id = $1`, [idByHost.get(domain)]);

    // 검증
    const dbCount = Number((await c.query(`select count(*) from naver_project_pages where group_key=$1 and domain_id = any($2::bigint[])`, [GROUP, subIds])).rows[0].count);
    const distinctPaths = Number((await c.query(`select count(distinct path) from naver_project_pages where group_key=$1 and domain_id = any($2::bigint[])`, [GROUP, subIds])).rows[0].count);
    const summary = { domain, expected: stats.total, inserted, dbCount, distinctPaths, deletedOld: del.rowCount, perSubMin: Math.min(...counts), perSubMax: Math.max(...counts), seconds: ((Date.now() - t0) / 1000).toFixed(1) };
    console.log(JSON.stringify(summary));
    if (dbCount !== stats.total || distinctPaths !== stats.total || inserted !== stats.total) throw new Error('검증 실패 → 롤백');

    if (apply) {
      await c.query('commit');
      // RewriteMap 파일
      const gen = `C:/xampp/sites/${domain}/gen`;
      if (existsSync(gen)) {
        const tmp = `${gen}/subs.txt.tmp`;
        writeFileSync(tmp, subs.map((s) => `${s} 1`).join('\n') + '\n', 'utf8');
        renameSync(tmp, `${gen}/subs.txt`);
      }
      console.log(`  ${domain}: COMMIT, subs.txt ${subs.length}줄`);
    } else {
      await c.query('rollback');
      console.log(`  ${domain}: DRY-RUN 롤백`);
    }
  }
} catch (e) { try { await c.query('rollback'); } catch {} throw e; }
finally { await c.end(); }
