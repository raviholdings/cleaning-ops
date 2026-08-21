-- 관리자 대시보드 통계를 머티리얼라이즈드 뷰로 캐시한다.
--
-- 배경 (2026-08-21): 관리자 페이지가 20초 폴링으로 결과 테이블(168만 행)을
-- 매번 풀스캔 집계했다. 호출당 23~43초 × 폴링 겹침으로 DB 가 상시 포화됐고,
-- 수집요청 러너·색인 루프까지 statement timeout 으로 같이 죽었다
-- (pg_stat_statements 누적 상위가 전부 이 쿼리들, 합계 50시간+).
--
-- 처방: 집계는 이 뷰들을 읽고, 갱신은 scripts/refresh-admin-stats.mjs 가
-- 주기적으로 REFRESH CONCURRENTLY 한다. 상세는 docs/ADMIN-DB-QUERY-FIX.md.

-- 페이지 후보 카운트 (기존 Q1: candidates 뷰 풀조인이 호출당 23초였다)
create materialized view if not exists public.admin_crawl_page_candidate_counts as
select
	target_project,
	count(*)::bigint as total,
	count(*) filter (where last_done_at is not null)::bigint as done,
	count(*) filter (where last_done_at is null)::bigint as pending
from public.naver_crawl_request_page_candidates
-- 도메인을 빌려 쓰는 그룹(moving-ravi 등)은 카탈로그가 남의 것이라 허수가 된다.
where target_project not in (
	select group_key from public.naver_project_groups where settings ? 'domainSourceGroup')
group by target_project;

create unique index if not exists idx_admin_crawl_page_candidate_counts_key
	on public.admin_crawl_page_candidate_counts (target_project);
