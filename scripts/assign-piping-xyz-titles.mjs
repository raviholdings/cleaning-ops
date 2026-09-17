#!/usr/bin/env node
/**
 * piping-xyz 서브도메인 5,000개에 "지역 + 배관 키워드" 제목을 배정한다.
 *
 *   지역   Desktop/naver/content-data/regions (district_targets 상세 시군구 256 전부 + content_areas 4,763 중 4,744) = 5,000 (시드 셔플)
 *   키워드 data/keywords/piping-keywords.json mains 70개 (막힘 38 ×2 가중 + 수전 11 + 누수 21 = 108 주기)
 *   제목   "<지역 표시명> <키워드>"  예) "서울 종로구 청운동 하수구막힘", "수원시 장안구 배관청소"
 *
 * DB (로컬 naver_hub, 한 트랜잭션)
 *   naver_page_keywords / naver_page_locations  upsert(name)
 *   naver_project_pages                          piping-xyz 것 전부 지우고 다시 넣음 (domain_id, request_id=1, path '/')
 *   naver_project_domains                        region_label, area_name, page_count=1, source_payload.title
 *   루트 도메인 5개도 page '/' 를 받는다 (지역 '전국', 키워드 '배관막힘', 제목은 관리자 사이트명 그대로)
 *
 * 파일 (--apply 때만)
 *   C:\xampp\sites\<도메인>\gen\hosts.json      {"서브": "제목"} 1,000줄
 *   C:\xampp\sites\<도메인>\gen\regions.txt     지역 풀 5,000줄 (등록 안 된 서브도메인 해시 제목용)
 *   C:\xampp\sites\<도메인>\gen\categories.txt  키워드 70줄
 *   _template, htdocs\site1 의 gen\regions.txt / categories.txt 도 같이
 * 항상: C:\Users\LD\Desktop\naver\reports\piping-xyz-titles.json (검토용 전체 목록)
 *
 *   node scripts/assign-piping-xyz-titles.mjs            # dry-run: 계산 + DB 롤백 + 표본 출력
 *   node scripts/assign-piping-xyz-titles.mjs --apply    # DB 커밋 + 파일 쓰기
 *
 * 같은 시드면 몇 번을 돌려도 같은 배정. DATABASE_URL 은 naverops.sh 가 로컬로 준다.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const valueOf = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1]; };
const SEED = valueOf('--seed', 'piping-xyz-titles-v2');   // v2: 지역 원본을 content-data 로 교체 (2026-09-11)
const GROUP = 'piping-xyz';
const SITES_DIR = 'C:/xampp/sites';
const EXTRA_GEN_DIRS = ['C:/xampp/sites/_template/gen', 'C:/xampp/htdocs/site1/gen'];
const REPORT = 'C:/Users/LD/Desktop/naver/reports/piping-xyz-titles.json';

const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!url) throw new Error('DATABASE_URL 필요 (naverops.sh 로 실행)');
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error('안전장치: 로컬 DB 가 아닙니다. 중단.');

/* ---------- 시드 셔플 ---------- */
function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function shuffle(list, seedText) {
  const out = list.slice();
  let s = hash32(seedText) || 1;
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/* ---------- 키워드 ---------- */
const kwFile = JSON.parse(readFileSync(resolve(projectRoot, 'data/keywords/piping-keywords.json'), 'utf8'));
const mains = kwFile.mains;
const KEYWORDS = [...mains['막힘'], ...mains['수전'], ...mains['누수']];
if (new Set(KEYWORDS).size !== KEYWORDS.length) throw new Error('키워드 중복');
const kwCycle = shuffle([...mains['막힘'], ...mains['막힘'], ...mains['수전'], ...mains['누수']], SEED + '|kw');

/* ---------- 지역: Desktop\naver\content-data (콘텐츠 에이전트와 같은 원본, region.csv 법정동코드) ---------- */
const CD = 'C:/Users/LD/Desktop/naver/content-data/regions';
const districts = JSON.parse(readFileSync(`${CD}/district_targets.json`, 'utf8'));   // 269 = primary_area 256 + city_hub 13
const areas = JSON.parse(readFileSync(`${CD}/content_areas.json`, 'utf8'));          // 4,763 콘텐츠 지역 묶음 (동 4,630 + 번지 묶음 133)
// 전국에 같은 이름의 시/군이 둘 이상이면 (강원도 고성군 / 경남 고성군) 시도를 앞에 붙인다
const sgSidos = new Map();
for (const a of areas) { if (!sgSidos.has(a.sigungu)) sgSidos.set(a.sigungu, new Set()); sgSidos.get(a.sigungu).add(a.sido); }
const ambiguous = (sg) => (sgSidos.get(sg)?.size || 0) > 1;
/** 제목에 쓰는 지역명. district = 시군구 제목, base = 동 제목의 앞부분 */
function names(sido, sigungu) {
  if (sigungu.includes(' ')) {                       // "수원시 장안구" / "광주 서구"
    const first = sigungu.split(' ')[0];
    return { district: sigungu, base: first.endsWith('시') ? first : sigungu };   // 동은 "수원시 ○○동", 광주는 "광주 서구 ○○동"
  }
  if (sigungu.endsWith('구') || ambiguous(sigungu)) return { district: `${sido} ${sigungu}`, base: `${sido} ${sigungu}` }; // 서울 종로구, 강원도 고성군
  return { district: sigungu, base: sigungu };       // 목포시, 세종시, 양평군
}
const sigunguLocs = []; const dongLocs = []; const used = new Set();
for (const d of districts) {
  if (d.role !== 'primary_area') continue;           // city_hub(수원시 전체 등 13개)는 구 단위가 이미 있으므로 제외
  const [sido, ...rest] = d.label.split(' '); const sigungu = rest.join(' ');
  const n = names(sido, sigungu);
  let name = n.district;
  if (used.has(name)) name = d.label;
  if (used.has(name)) throw new Error('시군구 표시명 중복: ' + name);
  used.add(name);
  sigunguLocs.push({ level: '시군구', name, search: d.label, sido, sigungu, dong: '', cd_id: d.id });
}
for (const a of areas) {
  const n = names(a.sido, a.sigungu);
  let name = `${n.base} ${a.label}`;
  if (used.has(name)) name = `${n.district} ${a.label}`;
  if (used.has(name)) name = a.full_label;
  if (used.has(name)) continue;
  used.add(name);
  dongLocs.push({ level: '동', name, search: a.full_label, sido: a.sido, sigungu: a.sigungu, dong: a.label, cd_id: a.id });
}
const TOTAL = 5000;
const pickedDongs = shuffle(dongLocs, SEED + '|dong').slice(0, TOTAL - sigunguLocs.length);
const locations = shuffle([...sigunguLocs, ...pickedDongs], SEED + '|all');
if (locations.length !== TOTAL) throw new Error(`지역 ${locations.length}개 ≠ ${TOTAL}`);
const regionPool = [...sigunguLocs, ...dongLocs].map((l) => l.name);

/* ---------- DB ---------- */
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  await c.query('begin');
  const { rows: domains } = await c.query(
    `select id, host, naver_account_id from naver_project_domains
      where group_key = $1 order by id`, [GROUP]);
  const subs = domains.filter((d) => d.host.split('.').length === 3);
  const roots = domains.filter((d) => d.host.split('.').length === 2);
  if (subs.length !== TOTAL) throw new Error(`서브도메인 ${subs.length}개 ≠ ${TOTAL}`);
  if (roots.length !== 5) throw new Error(`루트 ${roots.length}개 ≠ 5`);

  // 배정
  const assigned = subs.map((d, i) => {
    const loc = locations[i]; const kw = kwCycle[i % kwCycle.length];
    return { ...d, loc, kw, title: `${loc.name} ${kw}` };
  });
  const titles = new Set(assigned.map((a) => a.title));
  if (titles.size !== TOTAL) throw new Error('제목 중복 발생');

  // 키워드 upsert
  // search_name 은 DB 가 name 에서 자동 계산하는 칼럼이라 넣지 않는다
  const kwRows = (await c.query(
    `insert into naver_page_keywords (name)
       select unnest($1::text[])
     on conflict (name) do update set name = excluded.name
     returning id, name`, [KEYWORDS])).rows;
  const kwId = new Map(kwRows.map((r) => [r.name, r.id]));

  // 지역 upsert (+ 전국)
  const locNames = [...locations.map((l) => l.name), '전국'];
  const locRows = (await c.query(
    `insert into naver_page_locations (name)
       select unnest($1::text[])
     on conflict (name) do update set name = excluded.name
     returning id, name`, [locNames])).rows;
  const locId = new Map(locRows.map((r) => [r.name, r.id]));

  // 페이지: 기존 것 지우고 다시
  await c.query(`delete from naver_project_pages where group_key = $1`, [GROUP]);
  const pageDomain = [...assigned.map((a) => a.id), ...roots.map((r) => r.id)];
  const pageLoc = [...assigned.map((a) => locId.get(a.loc.name)), ...roots.map(() => locId.get('전국'))];
  const pageKw = [...assigned.map((a) => kwId.get(a.kw)), ...roots.map(() => kwId.get('배관막힘'))];
  if (pageLoc.some((x) => !x) || pageKw.some((x) => !x)) throw new Error('id 매핑 실패');
  const ins = await c.query(
    `insert into naver_project_pages (group_key, domain_id, request_id, path, location_id, main_keyword_id, content_version)
       select $1, d, 1, '/', l, k, 'hub-v1' from unnest($2::bigint[], $3::int[], $4::int[]) as v(d, l, k)`,
    [GROUP, pageDomain, pageLoc, pageKw]);

  // 도메인 컬럼
  const upIds = [...assigned.map((a) => a.id), ...roots.map((r) => r.id)];
  const upLoc = [...assigned.map((a) => a.loc.name), ...roots.map(() => '전국')];
  const upKw = [...assigned.map((a) => a.kw), ...roots.map(() => '배관막힘')];
  const upPayload = [
    ...assigned.map((a) => JSON.stringify({ title: a.title, location: a.loc.name, location_search: a.loc.search, level: a.loc.level, sido: a.loc.sido, sigungu: a.loc.sigungu, dong: a.loc.dong, keyword: a.kw, cd_id: a.loc.cd_id, title_seed: SEED })),
    ...roots.map(() => JSON.stringify({ title: null, location: '전국', keyword: '배관막힘', title_seed: SEED })),
  ];
  const up = await c.query(
    `update naver_project_domains d
        set region_label = v.loc, area_name = v.kw, page_count = 1,
            source_payload = coalesce(d.source_payload, '{}'::jsonb) || v.payload::jsonb,
            updated_at = now()
       from unnest($1::bigint[], $2::text[], $3::text[], $4::text[]) as v(id, loc, kw, payload)
      where d.id = v.id`, [upIds, upLoc, upKw, upPayload]);

  // 검증
  const pages = Number((await c.query(`select count(*) from naver_project_pages where group_key=$1`, [GROUP])).rows[0].count);
  const doms = Number((await c.query(`select count(*) from naver_project_domains where group_key=$1 and page_count=1 and region_label is not null`, [GROUP])).rows[0].count);
  const distinctTitles = Number((await c.query(`select count(distinct source_payload->>'title') from naver_project_domains where group_key=$1 and source_payload->>'title' is not null`, [GROUP])).rows[0].count);
  const summary = { subdomains: TOTAL, roots: roots.length, pagesInserted: ins.rowCount, pagesNow: pages, domainsUpdated: up.rowCount, domainsWithPage: doms, distinctTitles, keywords: kwRows.length, locations: locRows.length };
  console.log(JSON.stringify(summary));
  if (pages !== TOTAL + 5 || doms !== TOTAL + 5 || distinctTitles !== TOTAL || up.rowCount !== TOTAL + 5) throw new Error('검증 실패 → 롤백');

  // 통계
  const byLevel = {}; const bySido = {}; const byPhase = { 막힘: 0, 수전: 0, 누수: 0 };
  for (const a of assigned) {
    byLevel[a.loc.level] = (byLevel[a.loc.level] || 0) + 1;
    bySido[a.loc.sido] = (bySido[a.loc.sido] || 0) + 1;
    for (const p of Object.keys(mains)) if (mains[p].includes(a.kw)) byPhase[p] += 1;
  }
  console.log('level', JSON.stringify(byLevel), 'phase', JSON.stringify(byPhase));
  console.log('sido', JSON.stringify(bySido));
  console.log('표본:'); assigned.slice(0, 8).forEach((a) => console.log(`  ${a.host}  →  ${a.title}`));
  assigned.slice(1000, 1004).forEach((a) => console.log(`  ${a.host}  →  ${a.title}`));

  // 검토 파일 (항상)
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ seed: SEED, total: TOTAL, generatedAt: new Date().toISOString(),
    items: assigned.map((a) => ({ host: a.host, account: a.naver_account_id, title: a.title, location: a.loc.name, level: a.loc.level, keyword: a.kw })) }, null, 1), 'utf8');
  console.log('검토 파일:', REPORT);

  if (!apply) { await c.query('rollback'); console.log('DRY-RUN: DB 롤백, 사이트 파일 안 씀 (실제 적용은 --apply)'); }
  else {
    await c.query('commit'); console.log('COMMIT 완료');
    // 사이트 파일
    const byRoot = new Map();
    for (const a of assigned) { const [sub, ...rest] = a.host.split('.'); const root = rest.join('.'); if (!byRoot.has(root)) byRoot.set(root, {}); byRoot.get(root)[sub] = a.title; }
    const writeAtomic = (path, text) => { const tmp = path + '.tmp'; writeFileSync(tmp, text, 'utf8'); renameSync(tmp, path); };
    for (const [root, map] of byRoot) {
      const gen = `${SITES_DIR}/${root}/gen`;
      if (!existsSync(gen)) throw new Error('사이트 gen 폴더 없음: ' + gen);
      const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
      writeAtomic(`${gen}/hosts.json`, JSON.stringify(sorted, null, 1) + '\n');
      writeAtomic(`${gen}/regions.txt`, regionPool.join('\n') + '\n');
      writeAtomic(`${gen}/categories.txt`, KEYWORDS.join('\n') + '\n');
      console.log(`  ${root}: hosts.json ${Object.keys(sorted).length}개, regions ${regionPool.length}, categories ${KEYWORDS.length}`);
    }
    for (const gen of EXTRA_GEN_DIRS) {
      if (!existsSync(gen)) continue;
      writeAtomic(`${gen}/regions.txt`, regionPool.join('\n') + '\n');
      writeAtomic(`${gen}/categories.txt`, KEYWORDS.join('\n') + '\n');
      console.log(`  ${gen}: regions/categories 갱신`);
    }
  }
} catch (e) { try { await c.query('rollback'); } catch {} throw e; }
finally { await c.end(); }
