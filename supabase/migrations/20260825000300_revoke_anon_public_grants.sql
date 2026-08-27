-- public 스키마의 anon/authenticated 권한 회수 (2026-08-25 발견).
--
-- 발견 경위: 배관 접수 Worker 를 service_role 에서 publishable(anon) 키로 낮추면서
-- 키가 실제로 동작하는지 검증하다가, publishable 키로 public.admin_users 에 행이
-- 만들어지는 것을 확인했다(HTTP 201). 테스트 행은 즉시 삭제했다.
--
-- 실태: public 테이블 23개 중 22개가 RLS 없이 anon 롤에
--   SELECT / INSERT / UPDATE / DELETE / TRUNCATE 를 전부 허용하고 있었다.
--   admin_users(관리자 계정), admin_sessions(세션), naver_searchadvisor_accounts
--   (네이버 계정)까지 포함된다. anon 계열 키를 가진 사람은 관리자 계정을 만들고
--   세션을 조작하고 전 테이블을 지울 수 있었다.
--
-- 유출 정황: 없다. 저장소를 확인한 결과
--   · 정적 사이트(청소·이사·배관 220만 장)는 Supabase 를 아예 쓰지 않는다
--   · apps/cleaning-admin/src/lib/supabase.ts 는 어디서도 import 하지 않는 죽은
--     코드이고, 하드코딩된 값도 '.fakekey' 로 끝나는 가짜다. 빌드 산출물(dist)에도
--     supabase 문자열이 없다
--
-- 이 변경이 깨뜨리지 않는 것 (확인함):
--   · 관리자 대시보드 — DATABASE_URL 로 postgres 롤에 직접 접속, rolbypassrls=true
--   · 배관 접수 Worker — 현재 service_role, rolbypassrls=true
--   · 정적 사이트 — Supabase 미사용
--
-- 스키마 USAGE 는 회수하지 않는다. 회수하면 PostgREST 가 접수 INSERT 도 못 한다.

begin;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 앞으로 만드는 테이블에 권한이 자동으로 붙지 않게 한다.
-- (이번 사태의 근본 원인이 기본 권한이다)
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 유일한 예외: 접수 폼. RLS 정책(lead_submissions_anon_insert)과 짝을 이룬다.
-- 테이블 권한과 RLS 정책 둘 다 있어야 INSERT 가 된다.
grant insert on public.lead_submissions to anon;

commit;
