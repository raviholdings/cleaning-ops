-- 로그인을 이메일에서 아이디로 바꾼다.
--
-- 처음에 Cloudflare Access(이메일 OTP)를 쓰려다 자체 회원가입으로 방향을 바꿨는데
-- 이메일 필드만 그대로 남았다. 내부 운영자 몇 명이 쓰는 화면이라 이메일을
-- 받을 이유가 없다.
--
-- ⚠ apply-migrations.mjs 는 적용 이력을 남기지 않고 매번 전부 다시 돌린다.
-- 그래서 두 번 돌아도 깨지지 않게 컬럼 존재 여부를 보고 실행한다.
-- 그냥 alter ... rename 만 쓰면 두 번째 실행에서 "column does not exist" 로 죽고,
-- 그 뒤 마이그레이션이 전부 멈춘다.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'admin_users' and column_name = 'email'
  ) then
    alter table public.admin_users rename column email to username;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'admin_login_events' and column_name = 'email'
  ) then
    alter table public.admin_login_events rename column email to username;
  end if;
end $$;

-- 기존 값은 @ 앞부분을 아이디로 삼는다. 이미 바뀐 값은 like 에 안 걸려 그대로 둔다.
update public.admin_users
   set username = split_part(username, '@', 1)
 where username like '%@%';

update public.admin_login_events
   set username = split_part(username, '@', 1)
 where username like '%@%';
