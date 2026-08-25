-- admin_users.role 에 'staff' 를 정식화한다 (2026-08-25).
--
-- 실제 운영 DB 에는 이미 'staff' 가 들어가 있다 (testuser). 그런데 원장
-- 마이그레이션(20260812000000)의 check 제약은 아직 ('owner','member') 라
-- 파일과 실제 스키마가 어긋나 있었다. 이 파일이 그 드리프트를 정리한다.
--
-- 역할 의미:
--   owner   전체 관리
--   staff   리드(고객 개인정보) 열람·처리 가능
--   member  리드 접근 불가 — /api/leads 가 requireRole 로 403 을 준다
--
-- 재적용해도 안전하도록 drop → add 로 쓴다 (러너가 전 파일을 매번 다시 돌린다).

begin;

alter table public.admin_users drop constraint if exists admin_users_role_check;
alter table public.admin_users
  add constraint admin_users_role_check check (role in ('owner', 'staff', 'member'));

commit;
