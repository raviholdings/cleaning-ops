/**
 * apex 홈페이지용 이용후기.
 *
 * 풀은 apps/cleaning-ravi/src/lib/content.ts 의 REVIEW_TEXTS · REVIEW_AUTHORS 다.
 * 서브도메인이 쓰는 것과 같은 풀이지만, 48개 중 루트마다 다른 것을 골라 쓰고
 * 치환값(지역·키워드)이 달라 문장이 그대로 겹치지는 않는다.
 *
 * 이 풀은 "여러 곳을 비교해서 추천받았다" 는 비교·연결 서비스 톤이다.
 * 운영자 확인(2026-08-26): apex 에서도 그 문구가 나가도 된다.
 *
 * content.ts 는 TypeScript 라 import 하지 않고 원문을 파싱한다.
 * 풀에 항목을 더하면 자동으로 잡힌다 — 이 파일을 고칠 필요는 없다.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function extractArray(source, name) {
  const head = `export const ${name} = [`;
  const start = source.indexOf(head);
  if (start === -1) throw new Error(`${name} 를 content.ts 에서 못 찾았다.`);
  const body = source.slice(start + head.length, source.indexOf('\n]', start));
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** 받침 유무에 따라 조사를 고른다. 풀 문장이 "{sub}와 {sub2}를" 처럼 조사를
 *  고정해 놓아서, 치환값에 따라 "막힘와 / 막힘를" 같은 어색한 말이 나온다. */
const PARTICLE = {
  '와': ['와', '과'], '과': ['와', '과'],
  '를': ['를', '을'], '을': ['를', '을'],
  '가': ['가', '이'], '이': ['가', '이'],
  '는': ['는', '은'], '은': ['는', '은'],
};
function hasJong(word) {
  const code = word.charCodeAt(word.length - 1);
  return code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0;
}
function fillToken(text, token, value) {
  const re = new RegExp(token.replace(/[{}]/g, '\$&') + '(와|과|를|을|가|이|는|은)?', 'g');
  return text.replace(re, (_, p) => {
    if (!p || !PARTICLE[p]) return value;
    const [noJong, jong] = PARTICLE[p];
    return value + (hasJong(value) ? jong : noJong);
  });
}

export function loadReviewPool(projectRoot) {
  const src = readFileSync(resolve(projectRoot, 'apps/cleaning-ravi/src/lib/content.ts'), 'utf8');
  return {
    texts: extractArray(src, 'REVIEW_TEXTS'),
    authors: extractArray(src, 'REVIEW_AUTHORS'),
  };
}

/**
 * 루트 하나가 쓸 후기를 고른다.
 *
 * @param pool     loadReviewPool() 결과
 * @param vertical 쓰지 않는다(시그니처 호환용). 풀이 업종 공용이다.
 * @param rng      루트별 결정적 난수 (같은 루트면 항상 같은 후기)
 * @param count    개수
 * @param fill     { area, main, sub } 치환값
 * @param mode     'author' → "이**" · 'duration' → "작업 40분"
 */
export function pickApexReviews(pool, vertical, rng, count, fill, mode) {
  const size = pool.texts.length;
  if (!size) return [];

  const start = Math.floor(rng() * size);
  // 서로소 간격으로 돌면 한 루트 안에서 중복이 안 생긴다.
  let step = Math.floor(rng() * (size - 2)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const out = [];
  for (let i = 0; i < Math.min(count, size); i += 1) {
    let text = pool.texts[(start + i * step) % size];
    for (const [token, value] of [
      ['{location}', fill.area], ['{short}', fill.area], ['{main}', fill.main],
      ['{sub2}', fill.sub2 || fill.sub], ['{sub}', fill.sub],
    ]) text = fillToken(text, token, value);

    let meta;
    if (mode === 'author') {
      meta = pool.authors[Math.floor(rng() * pool.authors.length)];
    } else {
      const mins = 30 + Math.floor(rng() * 16) * 10;
      meta = mins < 60 ? `작업 ${mins}분`
        : mins % 60 === 0 ? `작업 ${mins / 60}시간`
          : `작업 ${Math.floor(mins / 60)}시간 ${mins % 60}분`;
    }
    out.push({ text, meta });
  }
  return out;
}
