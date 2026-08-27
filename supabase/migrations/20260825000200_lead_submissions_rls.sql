-- lead_submissions RLS — Worker 를 service_role 에서 anon 으로 낮추기 위한 준비.
--
-- 배경: workers/piping-lead 가 service_role 키(RLS 우회 전권)로 insert 한다.
-- 그 키 하나로 같은 프로젝트의 모든 테이블(계정·세션·admin_users·수집요청 결과)을
-- 읽고 쓰고 지울 수 있는데, Worker 는 인증 없이 열린 공개 엔드포인트다.
-- 지금 새는 경로는 없지만 여유가 없다 — 최소 권한으로 낮춘다.
--
-- 안전 확인(2026-08-25): 관리자 대시보드는 DATABASE_URL 로 postgres 롤에 직접
-- 붙고 그 롤은 rolbypassrls = true 다. RLS 를 켜도 관리자 조회·수정은 영향 없다.
--
-- 적용 순서 — 이 마이그레이션만 먼저 적용해도 안전하다(Worker 는 아직 service_role
-- 이라 RLS 를 우회한다). Worker 를 anon 키로 바꾸는 배포는 그 다음이다.

begin;

alter table public.lead_submissions enable row level security;

-- 접수 폼은 넣기만 한다. 조회·수정·삭제 정책은 만들지 않는다
-- (anon 키가 유출돼도 남의 리드를 읽거나 지울 수 없다).
drop policy if exists lead_submissions_anon_insert on public.lead_submissions;
create policy lead_submissions_anon_insert
  on public.lead_submissions
  for insert
  to anon
  with check (true);

commit;
