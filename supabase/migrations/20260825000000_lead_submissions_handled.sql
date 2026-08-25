-- 리드 처리 상태 컬럼 (2026-08-25 운영자 승인).
--
-- lead-dashboard.uloung.com 에서 접수 건을 보고 고객에게 전화하는 흐름이라
-- "누가 언제 전화했는지" 를 적을 곳이 필요하다. 없으면 같은 고객에게 두 번
-- 걸거나 빠뜨린다.
--
-- 테이블은 업종별로 나누지 않는다 (운영자 확정). group_key 로 이미 구분되고
-- idx_lead_submissions_group_created 가 업종별 최신순 조회를 담당한다.
-- 2026-08-25 기준 965행(청소 788 · 이사 177 · 배관 0) — 분리해서 얻을 이득이
-- 없고, 배관 Worker 가 넣는 컬럼도 기존 스키마와 정확히 일치한다.
--
-- 기존 행은 handled_at = null 로 남는다 = 전부 "미처리". 배관은 0건이라
-- 무관하지만, 청소·이사 탭을 열면 965건이 미처리로 보인다 (백필은 하지 않기로 함).

begin;

alter table public.lead_submissions
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by text,
  add column if not exists memo       text;

-- 미처리 건 최신순 — 대시보드 기본 쿼리용 부분 인덱스.
create index if not exists idx_lead_submissions_unhandled
  on public.lead_submissions (group_key, created_at desc)
  where handled_at is null;

commit;
