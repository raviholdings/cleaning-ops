create table if not exists public.naver_index_check_runs (
  run_id text primary key,
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  target_project text not null,
  source text not null default 'naver-site-search',
  trigger_type text not null default 'manual',
  status text not null default 'running',
  check_date date not null default ((now() at time zone 'Asia/Seoul')::date),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  target_domain_count integer not null default 0,
  checked_domain_count integer not null default 0,
  indexed_domain_count integer not null default 0,
  indexed_with_posts_domain_count integer not null default 0,
  not_indexed_domain_count integer not null default 0,
  indexed_post_total integer not null default 0,
  visible_indexed_post_total integer not null default 0,
  indexed_static_url_total integer not null default 0,
  indexed_url_total integer not null default 0,
  search_cap_reached_domain_count integer not null default 0,
  error_domain_count integer not null default 0,
  max_pages integer,
  request_delay_ms integer,
  host_delay_ms integer,
  check_concurrency integer,
  runner_host text,
  runner_cwd text,
  output_json_path text,
  output_csv_path text,
  output_md_path text,
  error text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint naver_index_check_runs_status_check
    check (status in ('running', 'succeeded', 'failed', 'partial'))
);

create table if not exists public.naver_index_check_results (
  id bigserial primary key,
  run_id text not null references public.naver_index_check_runs(run_id) on delete cascade,
  group_key text not null,
  target_project text not null,
  domain text not null,
  site_url text,
  naver_account_id text,
  city_slug text,
  region_label text,
  page_count integer not null default 0,
  sitemap_url_count integer not null default 0,
  deployed_at timestamptz,
  checked_at timestamptz not null default now(),
  indexed boolean not null default false,
  no_result boolean not null default false,
  indexed_post_count integer not null default 0,
  visible_indexed_post_count integer not null default 0,
  search_cap_reached boolean not null default false,
  indexed_static_url_count integer not null default 0,
  indexed_url_count integer not null default 0,
  pages_checked integer not null default 0,
  stopped_by text,
  error text,
  indexed_post_urls_sample jsonb not null default '[]'::jsonb,
  indexed_static_urls jsonb not null default '[]'::jsonb,
  page_samples jsonb not null default '[]'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, domain)
);

create table if not exists public.naver_index_check_urls (
  id bigserial primary key,
  run_id text not null references public.naver_index_check_runs(run_id) on delete cascade,
  group_key text not null,
  target_project text not null,
  domain text not null,
  url text not null,
  post_id integer,
  url_type text not null default 'post',
  checked_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, url),
  constraint naver_index_check_urls_type_check
    check (url_type in ('post', 'static'))
);

create index if not exists idx_naver_index_check_runs_group_date
  on public.naver_index_check_runs(group_key, check_date desc, status, started_at desc);

create index if not exists idx_naver_index_check_runs_project_group
  on public.naver_index_check_runs(target_project, group_key, status, finished_at desc);

create index if not exists idx_naver_index_check_results_run
  on public.naver_index_check_results(run_id, indexed_post_count desc, domain);

create index if not exists idx_naver_index_check_results_group_domain
  on public.naver_index_check_results(group_key, domain, checked_at desc);

create index if not exists idx_naver_index_check_results_error
  on public.naver_index_check_results(run_id, error)
  where error is not null;

create index if not exists idx_naver_index_check_urls_domain
  on public.naver_index_check_urls(group_key, domain, checked_at desc);

create index if not exists idx_naver_index_check_urls_url
  on public.naver_index_check_urls(url);

create index if not exists idx_naver_index_check_urls_post
  on public.naver_index_check_urls(group_key, domain, post_id, checked_at desc)
  where url_type = 'post';

create or replace view public.naver_index_check_latest as
  select distinct on (result.group_key, result.domain)
    result.*
  from public.naver_index_check_results result
  join public.naver_index_check_runs run
    on run.run_id = result.run_id
  where run.status in ('succeeded', 'partial')
  order by result.group_key, result.domain, result.checked_at desc, result.id desc;

create or replace view public.naver_index_check_url_latest as
  select distinct on (indexed_url.group_key, indexed_url.url)
    indexed_url.*
  from public.naver_index_check_urls indexed_url
  join public.naver_index_check_runs run
    on run.run_id = indexed_url.run_id
  where run.status in ('succeeded', 'partial')
  order by indexed_url.group_key, indexed_url.url, indexed_url.checked_at desc, indexed_url.id desc;

update public.naver_project_groups
set
  index_runner = 'generic',
  sheet_runner = 'generic',
  settings = settings || '{"capPageFirst":false}'::jsonb,
  updated_at = now()
where group_key in ('gosim', 'rss_test', 'bbungbbung');

update public.naver_project_groups
set
  index_runner = 'generic',
  sheet_runner = 'generic',
  settings = settings || '{"capPageFirst":false}'::jsonb,
  updated_at = now()
where group_key = 'recovery-law';

update public.naver_project_groups
set
  index_runner = 'generic',
  sheet_runner = 'generic',
  updated_at = now()
where group_key in ('watermelon', 'dadream', 'deodream', 'woodrel');
