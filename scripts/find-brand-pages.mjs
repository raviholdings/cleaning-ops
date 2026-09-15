#!/usr/bin/env node
/**
 * 지역 이름으로 다섯 브랜드의 페이지를 찾는다.
 *
 *   node scripts/find-brand-pages.mjs 나성동
 *   node scripts/find-brand-pages.mjs 세종            # 시군구·동 전부
 *   node scripts/find-brand-pages.mjs 나성동 --site dream
 *   node scripts/find-brand-pages.mjs 나성동 --md      # 표로 (붙여넣기용)
 *
 * 구운 결과(tmp/brands)를 읽는다 — 라이브와 같은 것을 보려면 먼저 굽거나, 마지막
 * 배포 뒤에 굽지 않았어야 한다. 제목이 그 이름으로 시작하거나 설명에 그 이름이
 * 들어간 페이지를 찾는다. 슬러그가 난수라 주소만 보고는 어느 동인지 알 수 없어서
 * 이 스크립트가 필요하다 (운영자 질문 2026-09-15).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith('--'));
const onlySite = argv.includes('--site') ? argv[argv.indexOf('--site') + 1] : '';
const md = argv.includes('--md');
if (!name) {
  console.error('지역 이름을 주세요. 예: node scripts/find-brand-pages.mjs 나성동');
  process.exit(1);
}

const HOST = { dream: 'dreamcome.kr', thunder: 'thunderdrain.kr', mole: 'beaverpipe.kr', ssak: 'ssac3.kr', dosa: 'dosadosa.kr' };
const NAME = { dream: '드림컴뚜러', thunder: '썬더배관', mole: '비버배관', ssak: '싹쓰리배관', dosa: '하수구도사' };
const one = (re, h) => (re.exec(h) || [])[1] || '';

let total = 0;
for (const [key, host] of Object.entries(HOST)) {
  if (onlySite && onlySite !== key) continue;
  const root = join(projectRoot, 'tmp/brands', key);
  if (!existsSync(root)) { console.log(`${NAME[key]}: tmp/brands/${key} 가 없습니다 — 먼저 구우세요`); continue; }
  const hits = [];
  const walk = (dir, base) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || ['assets', '_crawl'].includes(e.name)) continue;
      const f = join(dir, e.name, 'index.html');
      if (existsSync(f)) {
        const h = readFileSync(f, 'utf8');
        const t = one(/<title>([^<]*)</, h);
        const d = one(/<meta name="description" content="([^"]*)"/, h);
        /* 제목이 그 이름으로 시작(그 지역 페이지) 또는 시도·시군구 이름이 설명 머리에 */
        const head = t.replace(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\s+/, '');
        if (head.startsWith(name) || d.slice(0, 40).includes(` ${name} `) || d.startsWith(name)) {
          hits.push({ url: `https://${host}${base}/${e.name}/`, title: t, kind: h.includes('id="siblings"') || /동네별|근처도 갑니다/.test(h) ? '동' : '' });
        }
      }
      walk(join(dir, e.name), `${base}/${e.name}`);
    }
  };
  walk(root, '');
  total += hits.length;
  if (md) {
    console.log(`\n### ${NAME[key]} — ${hits.length}장\n| 제목 | 주소 |\n|---|---|`);
    for (const x of hits) console.log(`| ${x.title} | ${x.url} |`);
  } else {
    console.log(`\n■ ${NAME[key]}  ${hits.length}장`);
    for (const x of hits) console.log(`  ${x.url}\n     ${x.title}`);
  }
}
console.log(`\n"${name}" 합계 ${total}장`);
