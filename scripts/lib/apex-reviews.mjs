/**
 * apex 홈페이지용 이용후기.
 *
 * 풀은 data/apex/review-pool.json 에 업종별로 있다.
 * apps/cleaning-ravi/src/lib/content.ts 의 REVIEW_TEXTS 는 쓰지 않는다 —
 * 그건 "여러 곳을 비교해서 추천받았다" 는 비교·연결 서비스 톤이라
 * 직접 작업하는 업체로 써 놓은 apex 와 앞뒤가 안 맞는다.
 * 성씨(REVIEW_AUTHORS)만 거기서 가져다 쓴다.
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

export function loadReviewPool(projectRoot) {
  const texts = JSON.parse(readFileSync(resolve(projectRoot, 'data/apex/review-pool.json'), 'utf8'));
  const authors = extractArray(
    readFileSync(resolve(projectRoot, 'apps/cleaning-ravi/src/lib/content.ts'), 'utf8'),
    'REVIEW_AUTHORS',
  );
  return { texts, authors };
}

/**
 * 루트 하나가 쓸 후기를 고른다.
 *
 * @param pool     loadReviewPool() 결과
 * @param vertical 'piping' | 'cleaning' | 'moving'
 * @param rng      루트별 결정적 난수 (같은 루트면 항상 같은 후기)
 * @param count    개수
 * @param fill     { area, main, sub } 치환값
 * @param mode     'author' → "이**" · 'duration' → "작업 40분"
 */
export function pickApexReviews(pool, vertical, rng, count, fill, mode) {
  const list = pool.texts[vertical] || [];
  const size = list.length;
  if (!size) return [];

  const start = Math.floor(rng() * size);
  // 서로소 간격으로 돌면 한 루트 안에서 중복이 안 생긴다.
  let step = Math.floor(rng() * (size - 2)) + 1;
  while (step > 1 && size % step === 0) step -= 1;

  const out = [];
  for (let i = 0; i < Math.min(count, size); i += 1) {
    const text = list[(start + i * step) % size]
      .replaceAll('{area}', fill.area)
      .replaceAll('{main}', fill.main)
      .replaceAll('{sub}', fill.sub);

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
