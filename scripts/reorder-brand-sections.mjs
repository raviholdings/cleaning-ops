#!/usr/bin/env node
/**
 * 브랜드 사이트 템플릿의 구역 순서를 바꾼다.
 *
 *   node scripts/reorder-brand-sections.mjs [--dry-run]
 *
 * 왜 필요한가 — 다섯 사이트의 색·글꼴·모양은 갈라 놓았는데 **뼈대가 같았다.**
 * 히어로 → 서비스 → 원인 → 요금 → 접수 → 사례 → FAQ → 지역 순서가 다섯 다 똑같아서,
 * 나란히 놓고 스크롤하면 같은 리듬이 보인다. 색만 다르게 칠한 셈이다.
 *
 * 그래서 사이트마다 정보 구조 자체를 다르게 잡는다. 아래 ORDER 가 그 설계다.
 * 목록에 없는 구역은 그 페이지에서 빠진다(홈의 지역 목록이 그렇게 빠진다 —
 * nav 와 상세 페이지로 들어가므로 홈에 또 둘 이유가 없다).
 *
 * 이 스크립트는 템플릿 파일을 직접 고친다. 한 번 돌리고 나면 결과가 파일에 남으므로
 * 다시 돌려도 같은 순서면 "변경 없음" 이 뜬다.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/*
 * 사이트별 정보 구조.
 *
 *   dream   진단서. 증상을 먼저 훑고 서비스로 넘어간다.
 *   thunder 긴급 상황판. 접수를 맨 위로 올리고 홈을 짧게 끝낸다(요금·FAQ 는 상세로).
 *   mole    동네 사람. 다녀온 이야기부터 꺼낸다. 요금은 상세로 뺀다.
 *   ssak    전단지. 요금표가 주인공이고 정보를 촘촘히 넣는다.
 *   dosa    노포. 시술 소개 뒤에 문답을 길게 두고 값은 뒤로 뺀다.
 */
const ORDER = {
  dream: {
    'home.html': ['cause', 'service', 'shot', 'price', 'estimate', 'faq', 'case'],
    'region.html': ['keyword', 'cause', 'dong', 'service', 'photo', 'prevent', 'price', 'estimate', 'method', 'building', 'season', 'faq', 'before', 'case', 'near'],
    'service.html': ['when', 'how', 'avoid', 'estimate', 'faq', 'others', 'spots'],
  },
  thunder: {
    'home.html': ['estimate', 'service', 'cause', 'shot', 'case'],
    'region.html': ['estimate', 'keyword', 'dong', 'service', 'photo', 'cause', 'method', 'building', 'prevent', 'season', 'before', 'case', 'near'],
    'service.html': ['when', 'estimate', 'how', 'avoid', 'faq', 'others', 'spots'],
  },
  mole: {
    'home.html': ['symptom', 'promise', 'estimate', 'process', 'shot', 'case', 'review', 'area', 'faq'],
    'region.html': ['keyword', 'dong', 'photo', 'case', 'cause', 'building', 'service', 'prevent', 'season', 'method', 'faq', 'before', 'estimate', 'near'],
    'service.html': ['when', 'avoid', 'how', 'faq', 'estimate', 'others', 'spots'],
  },
  ssak: {
    'home.html': ['price', 'service', 'estimate', 'cause', 'shot', 'case', 'faq'],
    'region.html': ['keyword', 'dong', 'price', 'service', 'estimate', 'photo', 'cause', 'method', 'prevent', 'building', 'season', 'case', 'faq', 'before', 'near'],
    'service.html': ['when', 'how', 'estimate', 'avoid', 'faq', 'others', 'spots'],
  },
  dosa: {
    'home.html': ['service', 'faq', 'cause', 'shot', 'case', 'price', 'estimate'],
    'region.html': ['keyword', 'service', 'dong', 'faq', 'cause', 'photo', 'prevent', 'building', 'season', 'method', 'case', 'price', 'before', 'estimate', 'near'],
    'service.html': ['when', 'how', 'faq', 'avoid', 'others', 'estimate', 'spots'],
  },
};

/**
 * 템플릿을 머리말과 구역 덩어리로 가른다.
 * 사진 구역은 {{#hasPhotos}} 로 감싸여 있고, 접수 폼은 {{{estimateForm}}} 한 줄이다.
 */
function split(source) {
  const blocks = [];
  const re = /\{\{#hasPhotos\}\}[\s\S]*?\{\{\/hasPhotos\}\}|\{\{\{estimateForm\}\}\}|<section\b[\s\S]*?<\/section>/g;
  let head = null;
  let m = re.exec(source);
  while (m) {
    if (head === null) head = source.slice(0, m.index);
    const text = m[0];
    let key;
    if (text.includes('{{{estimateForm}}}')) key = 'estimate';
    else if (text.includes('{{#hasPhotos}}')) key = 'photo';
    else key = (text.match(/<section[^>]*id="([a-z]+)"/) || [])[1];
    if (!key) throw new Error(`id 없는 <section> 을 만났습니다:\n${text.slice(0, 80)}`);
    blocks.push({ key, text: text.trim() });
    m = re.exec(source);
  }
  return { head: (head ?? source).replace(/\s+$/, ''), blocks };
}

let changed = 0;
const report = [];

for (const [key, files] of Object.entries(ORDER)) {
  for (const [file, order] of Object.entries(files)) {
    const path = join(projectRoot, 'apps/brand-static', `${key}-template`, file);
    if (!existsSync(path)) { report.push(`${key}/${file} — 파일 없음`); continue; }
    const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const { head, blocks } = split(source);

    const found = new Map(blocks.map((b) => [b.key, b.text]));
    /*
     * 목록에 있는데 템플릿에 없는 구역은 건너뛴다. 사이트마다 구성이 달라지면서
     * (브리프 교체) 없어지는 구역이 생기는데, 그때마다 전체가 멈추면
     * 나머지 사이트까지 재배치가 안 된 채로 남는다 — 실제로 그렇게 됐다.
     */
    const missing = order.filter((k) => !found.has(k));
    const use = order.filter((k) => found.has(k));
    const dropped = [...found.keys()].filter((k) => !order.includes(k));

    const out = `${head}\n\n${order.map((k) => found.get(k)).join('\n\n')}\n`;
    const before = blocks.map((b) => b.key).join(' ');
    const after = order.join(' ');
    if (before === after && !dropped.length) { report.push(`${key}/${file} — 변경 없음`); continue; }

    report.push(`${key}/${file}\n    전: ${before}\n    후: ${after}`
      + (dropped.length ? `\n    뺀 구역: ${dropped.join(', ')}` : ''));
    if (!dryRun) { writeFileSync(path, out); changed += 1; }
  }
}

report.forEach((r) => console.log(`  ${r}`));
console.log(`\n${dryRun ? '(--dry-run) ' : ''}템플릿 ${changed}개 수정`);
