/**
 * scripts/sync-naver-project-page-catalog.mjs 가 읽는 계약 모듈.
 *
 * 카탈로그 공식을 여기서 다시 구현하지 않는다. Astro 빌드가 쓰는 lib/pageCatalog.ts
 * 를 그대로 import 해서, DB 카탈로그와 실제 배포 HTML 이 절대 어긋나지 않게 한다.
 * (Node 22.18+ 는 타입 스트리핑으로 .ts 를 직접 읽는다.)
 *
 * 사이트 순번은 naver_project_domains.source_payload.globalSiteOrder 에서 온다.
 * 빌드 때 쓰는 PUBLIC_SITE_INDEX 와 같은 값이어야 한다 (globalSiteOrder - 1).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_KEYWORDS } from './lib/keywords.ts';
import { catalogEntry, pagePath } from './lib/pageCatalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rollout = JSON.parse(
  readFileSync(resolve(here, '../../../data/locations/rollout-locations.json'), 'utf8'),
);

/** naver_page_locations 의 rollout_order 순서와 같아야 한다. */
export const LOCATIONS = rollout.locations;

/** 사이트당 페이지 수. DB 의 page_count 와 다르면 sync 가 중단시킨다. */
const SITE_PAGE_COUNT = Number(process.env.PUBLIC_PAGE_COUNT || 100) || 100;

export function pageCountForHost(_host, _domain) {
  return SITE_PAGE_COUNT;
}

export function pageCatalogDimensions(_domains) {
  return { locations: LOCATIONS, mainKeywords: [...MAIN_KEYWORDS] };
}

export function pageCatalogEntryForRequestId(requestId, host, domain) {
  const entry = catalogEntry({
    locations: LOCATIONS,
    siteIndex: siteIndexFor(host, domain),
    requestId,
    pageCount: pageCountForHost(host, domain),
  });
  return {
    path: pagePath(requestId),
    location: entry.location,
    mainKeyword: entry.mainKeyword,
  };
}

/**
 * 지역 목록이나 메인키워드가 바뀌면 값이 달라져야 한다.
 * 그래야 sync 가 기존 카탈로그를 갱신 대상으로 잡는다.
 */
export function pageCatalogContentVersion(_domains) {
  return `cleaning-ravi-${String(rollout.hashes.all).slice(0, 12)}-k${MAIN_KEYWORDS.length}-v1`;
}

/** 빌드 스크립트가 도메인 행에서 PUBLIC_SITE_INDEX 를 뽑을 때도 이 함수를 쓴다. */
export function siteIndexFor(host, domain) {
  const payload = domain?.source_payload || domain?.sourcePayload || {};
  const order = Number(payload.globalSiteOrder);
  if (!Number.isSafeInteger(order) || order < 1) {
    throw new Error(`${host}: source_payload.globalSiteOrder 가 없거나 잘못됐습니다.`);
  }
  return order - 1;
}
