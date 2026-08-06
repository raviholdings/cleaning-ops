import rollout from '../../../../data/locations/rollout-locations.json';

/**
 * 배포 지역 목록. rollout_order 순서 그대로다.
 * DB 의 public.naver_page_locations 와 같은 내용·같은 순서여야 하며,
 * 무결성은 hashes.all 로 확인한다.
 *
 * 이 파일은 빌드 시에만 읽힌다 (클라이언트 JS 없음).
 */
export const LOCATIONS: readonly string[] = rollout.locations;
export const LOCATION_HASHES = rollout.hashes;
export const LOCATION_COUNTS = rollout.counts;

/** 사이트 순번. 도메인별 빌드에서 PUBLIC_SITE_INDEX 로 지정한다. */
export const SITE_INDEX = Number(import.meta.env.PUBLIC_SITE_INDEX ?? 0) || 0;

/** 사이트당 페이지 수. 레거시 기본값 100. */
export const PAGE_COUNT = Number(import.meta.env.PUBLIC_PAGE_COUNT ?? 100) || 100;
