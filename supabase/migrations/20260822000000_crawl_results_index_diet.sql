-- 결과 테이블 인덱스 다이어트 (2026-08-22 운영자 승인, 운영 DB 에는 CONCURRENTLY 로 기적용).
-- 실측(2026-08-21): 테이블 2.4GB 중 힙 593MB / 인덱스 1,729MB.
--
-- done_account_url (804MB, idx_scan=1): dedup 쿼리의
--   (run.account_id = $1 or result.account = $1) OR 조건 때문에 플래너가 안 쓴다.
--   dedup 은 실제로 url·host 인덱스를 탄다.
-- status (120MB): 행의 99% 가 submitted 라 선택도가 없다. 드문 상태 조회
--   (오늘 quota-stop 이월 판단)는 아래 부분 인덱스(336KB)가 담당한다.
drop index if exists public.idx_naver_searchadvisor_crawl_results_done_account_url;
drop index if exists public.idx_naver_searchadvisor_crawl_results_status;

-- project_page_latest (177MB): 기초 스키마가 정의하지만 실 DB 에는 없던 것.
-- 부분 인덱스 idx_crawl_results_page_link(51MB) 가 같은 선두 컬럼을 갖고,
-- 재구축·백필·FK 전부 그걸로 충분했다 (2026-08-21 실증). 원장 재적용이
-- 부활시키지 않도록 여기서 확정적으로 지운다.
drop index if exists public.idx_naver_crawl_results_project_page_latest;

-- url·host 는 등호 검색뿐이라 B-tree → hash 로 교체 (234+148MB → 61+61MB).
-- dedup(url = any)·오늘 한도(host = any) 쿼리가 그대로 hash 를 탄다.
create index if not exists idx_crawl_results_url_hash
  on public.naver_searchadvisor_crawl_request_results using hash (url);
create index if not exists idx_crawl_results_host_hash
  on public.naver_searchadvisor_crawl_request_results using hash (host);
drop index if exists public.idx_naver_searchadvisor_crawl_results_url;
drop index if exists public.idx_naver_searchadvisor_crawl_results_host;

create index if not exists idx_crawl_results_quota_stop
  on public.naver_searchadvisor_crawl_request_results (requested_at)
  where status = 'quota-stop';
