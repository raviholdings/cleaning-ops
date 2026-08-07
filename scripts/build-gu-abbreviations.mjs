#!/usr/bin/env node
/**
 * 축약된 행정구역명 -> 정식 명칭 대응표를 지역 목록에서 뽑는다.
 *
 *   node scripts/build-gu-abbreviations.mjs
 *   -> apps/cleaning-ravi/src/lib/adminDivisions.ts
 *
 * 손으로 적으면 반드시 틀린다. '수원' 을 '수원구' 로 늘리는 식이다.
 * rollout-locations.json 은 같은 지역을 여러 표기로 담고 있어서,
 * 같은 토큰 위치에 정식 명칭이 이미 들어 있다. 그걸 근거로 삼는다.
 *
 *   서울 종로구 청운동   <- 2번째 자리에 '종로구' 가 존재
 *   서울 종로  청운동    <- 그러므로 '종로' -> '종로구'
 *   경기 수원시 장안구 파장동  <- 2번째 자리에 '수원시' 가 존재
 *   경기 수원 장안구 파장동    <- 그러므로 '수원' -> '수원시'
 *
 * 지역 목록을 바꾸면 이 스크립트를 다시 돌릴 것.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'data/locations/rollout-locations.json');
const target = resolve(repoRoot, 'apps/cleaning-ravi/src/lib/adminDivisions.ts');

const locations = JSON.parse(readFileSync(source, 'utf8')).locations;
const tokensOf = (value) => value.trim().split(/\s+/);

// 토큰 위치별로 등장하는 모든 값. '수원' 과 '수원시' 가 같은 자리에 오는지 봐야 한다.
const seenAtPosition = [];
for (const location of locations) {
  tokensOf(location).forEach((token, index) => {
    (seenAtPosition[index] ??= new Set()).add(token);
  });
}

// 행정구역 접미사로 끝나면 이미 정식 명칭이다.
const HAS_SUFFIX = /[구시군읍면동리가]$/;

const expansions = new Map();
const unresolved = new Set();

for (const location of locations) {
  const tokens = tokensOf(location);
  // 첫 토큰(시도)과 마지막 토큰(동/리)은 건드리지 않는다.
  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (HAS_SUFFIX.test(token) || expansions.has(token)) continue;

    if (seenAtPosition[index].has(`${token}구`)) expansions.set(token, `${token}구`);
    else if (seenAtPosition[index].has(`${token}시`)) expansions.set(token, `${token}시`);
    else unresolved.add(token);
  }
}

const sorted = [...expansions].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
const guCount = sorted.filter(([, full]) => full.endsWith('구')).length;
const siCount = sorted.length - guCount;

const header = [
  '/**',
  ' * 축약된 행정구역명 -> 정식 명칭.',
  ' *',
  ' * rollout-locations.json 이 같은 지역을 여러 표기로 담고 있어서 생긴 표다.',
  ' *   서울 종로구 청운동',
  ' *   서울 종로  청운동   <- 축약형이 별개 항목으로 들어 있다',
  ' * 축약형을 그대로 내보내면 "서울 동작 흑석동" 처럼 구가 빠진 채 나간다.',
  ' *',
  ' * 손으로 적은 표가 아니다. scripts/build-gu-abbreviations.mjs 가 지역 목록에서',
  ' * 직접 뽑는다. 같은 토큰 자리에 "종로구" 가 있으면 "종로" -> "종로구",',
  ' * "수원시" 가 있으면 "수원" -> "수원시" 로 정한다. 그래서 "수원" 을 "수원구" 로',
  ' * 잘못 늘리는 일이 없다.',
  ' *',
  ` * 생성 시점: 축약 토큰 ${sorted.length}개 전부 해결 (구 ${guCount} / 시 ${siCount}), 미해결 ${unresolved.size}개.`,
  ' * 지역 목록을 바꾸면 스크립트를 다시 돌릴 것.',
  ' */',
  'export const ADMIN_DIVISION_EXPANSIONS: Record<string, string> = {',
].join('\n');

const body = sorted.map(([abbr, full]) => `  '${abbr}': '${full}',`).join('\n');
writeFileSync(target, `${header}\n${body}\n};\n`, 'utf8');

console.log(JSON.stringify({
  entries: sorted.length,
  gu: guCount,
  si: siCount,
  unresolved: [...unresolved],
  target,
}, null, 2));
