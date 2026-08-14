-- 개발현황 탭 데이터를 파일에서 DB 로 옮긴다.
--
-- 지금까지 data/dev_tasks.json 을 읽고 썼다. 문제가 셋이다.
--   1. git 에 추적돼 있어 화면에서 과제를 하나 고칠 때마다 저장소가 더러워진다.
--      VM 들이 git pull 할 때 이 파일 때문에 막힌 적도 있다.
--   2. 여러 사람이 동시에 고치면 통째로 덮어쓴다. 마지막 저장이 이긴다.
--   3. 나중에 서버리스(Vercel 등)로 옮기면 파일 쓰기가 아예 안 된다.
--
-- 컬럼 이름은 화면이 쓰는 camelCase 를 그대로 snake_case 로 옮겼다.
-- id 는 기존 파일이 'task-1786327556193' 같은 문자열을 쓰고 있어 text 로 둔다.

create table if not exists public.dev_tasks (
  id             text primary key,
  title          text not null,
  category       text,
  assignee       text,
  priority       text not null default 'medium'
                 check (priority in ('low', 'medium', 'high', 'urgent')),
  status         text not null default 'pending'
                 check (status in ('pending', 'in_progress', 'completed', 'on_hold')),
  start_date     date,
  target_date    date,
  completed_date date,
  progress       int  not null default 0 check (progress between 0 and 100),
  description    text,
  notes          text,
  sort_order     bigint,          -- 화면에 보이던 순서. 새 과제는 맨 위로 간다
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_dev_tasks_status on public.dev_tasks(status);
create index if not exists idx_dev_tasks_sort on public.dev_tasks(sort_order desc);
