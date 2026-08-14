-- 관리자 페이지 로그인.
--
-- 어드민은 계정 ID·도메인·배정 IP 같은 운영 데이터를 전부 보여준다.
-- 도메인을 붙여 밖에 내놓는 순간 아무나 보면 안 되므로 로그인을 붙인다.
--
-- 가입은 열어두되 곧바로 못 들어온다. 새 가입은 pending 으로 들어가고
-- 기존 관리자가 승인해야 approved 가 된다. 주소만 알면 누구나 가입해서
-- 운영 데이터를 보는 상황을 막기 위해서다.
-- 첫 번째 가입자만 자동으로 승인되고 owner 가 된다.

create table if not exists public.admin_users (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  -- scrypt(N=16384, r=8, p=1). 형식: scrypt$<salt-base64>$<hash-base64>
  -- 외부 라이브러리를 쓰지 않으려고 node:crypto 만으로 처리한다.
  password_hash text not null,
  name          text,
  -- pending  가입은 했지만 아직 승인 전. 로그인해도 데이터를 못 본다
  -- approved  정상
  -- blocked   차단
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'blocked')),
  -- owner 는 다른 사람을 승인할 수 있다
  role          text not null default 'member'
                check (role in ('owner', 'member')),
  created_at    timestamptz not null default now(),
  created_ip    inet,
  last_login_at timestamptz,
  last_login_ip inet,
  approved_at   timestamptz,
  approved_by   bigint references public.admin_users(id)
);

create index if not exists idx_admin_users_status on public.admin_users(status);

-- 로그인 세션. 쿠키에는 토큰만 담고 실제 정보는 여기서 본다.
-- 토큰을 그대로 저장하지 않고 sha256 만 저장한다. DB 가 새도 세션은 못 쓴다.
create table if not exists public.admin_sessions (
  token_hash text primary key,
  user_id    bigint not null references public.admin_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip         inet,
  user_agent text
);

create index if not exists idx_admin_sessions_user on public.admin_sessions(user_id);
create index if not exists idx_admin_sessions_expires on public.admin_sessions(expires_at);

-- 누가 언제 어디서 들어왔는지. 접속 IP 가 사람마다 다르므로 남겨둔다.
create table if not exists public.admin_login_events (
  id         bigint generated always as identity primary key,
  user_id    bigint references public.admin_users(id) on delete set null,
  email      text not null,
  -- login-ok / login-bad-password / login-unknown-email / login-not-approved / signup
  event      text not null,
  ip         inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_login_events_created on public.admin_login_events(created_at desc);
