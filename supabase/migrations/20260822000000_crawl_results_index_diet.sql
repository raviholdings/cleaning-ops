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

create index if not exists idx_crawl_results_quota_stop
  on public.naver_searchadvisor_crawl_request_results (requested_at)
  where status = 'quota-stop';
