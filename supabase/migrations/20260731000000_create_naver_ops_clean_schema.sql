-- =============================================================================
-- Cleaning-Ops :: Naver Search Advisor operations — Clean DDL (no legacy data)
-- =============================================================================
-- Consolidated final state of the schema the scripts in ./scripts depend on.
-- Rebuilt from the legacy migration history; all legacy seed rows, legacy
-- project groups, legacy domain/page rows and deprecated columns are excluded.
--
--   Tables (15) : naver_searchadvisor_accounts,
--                 naver_project_groups, naver_project_domains,
--                 naver_project_group_account_controls (+ _events audit),
--                 naver_page_locations, naver_page_keywords,
--                 naver_project_pages, naver_project_page_crawl_state,
--                 naver_project_page_combo_overrides,
--                 naver_region_keyword_exposure_targets,
--                 naver_searchadvisor_crawl_request_runs / _results,
--                 naver_index_check_runs / _results / _urls
--   Views  (6)  : naver_crawl_request_target_domains,
--                 naver_project_group_crawl_accounts,
--                 naver_index_check_target_domains,
--                 naver_region_keyword_exposure_latest,
--                 naver_region_keyword_exposure_latest_full_location,
--                 naver_crawl_request_page_candidates
--   Support     : weekly_page_expansion_runs / _targets
--                 (required by naver_project_page_combo_overrides.run_id FK and
--                  read by scripts/sync-naver-project-page-catalog.mjs)
--
-- NOTE: the handover doc lists `naver_region_keyword_exposure_targets` under
-- "views". It is a base table in the source schema and is created as such here;
-- `naver_region_keyword_exposure_latest` is the corresponding view.
-- =============================================================================

begin;

set local lock_timeout = '10s';
set local statement_timeout = '300s';

-- -----------------------------------------------------------------------------
-- 1. Naver Search Advisor accounts
-- -----------------------------------------------------------------------------
create table if not exists public.naver_searchadvisor_accounts (
  account_id text primary key,
  account_order integer not null unique,
  provider text not null default 'naver',
  organization_name text not null default '라비홀딩스',
  account_identity_type text not null default '비실계',
  planned_domain_limit integer not null default 100,
  status text not null default 'active',
  phone text,
  notes text,

  -- credentials
  password_secret_id uuid,
  password_plain text,

  -- registrant identity (used when registering sites in Search Advisor)
  personal_email text,
  personal_name text,
  personal_birth_date date,
  personal_gender text,
  personal_info_source text,
  personal_info_imported_at timestamptz,

  -- Playwright storage-state session, held in Supabase Vault
  searchadvisor_session_secret_id uuid,
  searchadvisor_session_saved_at timestamptz,
  searchadvisor_session_validated_at timestamptz,
  searchadvisor_session_cookie_count integer,
  searchadvisor_session_origin_count integer,
  searchadvisor_session_bytes integer,
  searchadvisor_session_saved_public_ip inet,
  searchadvisor_session_validated_public_ip inet,
  searchadvisor_session_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.naver_searchadvisor_accounts.status is
  'Single source of truth for account usability: active | blocked | site_limit_full.';

create index if not exists idx_naver_searchadvisor_accounts_organization
  on public.naver_searchadvisor_accounts(organization_name, account_order);

create index if not exists idx_naver_searchadvisor_accounts_identity_type
  on public.naver_searchadvisor_accounts(account_identity_type, account_order);

create index if not exists idx_naver_searchadvisor_accounts_phone
  on public.naver_searchadvisor_accounts(phone)
  where phone is not null;

create index if not exists idx_naver_searchadvisor_accounts_personal_email
  on public.naver_searchadvisor_accounts(personal_email)
  where personal_email is not null;

-- -----------------------------------------------------------------------------
-- 2. Project groups
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_groups (
  group_key text primary key,
  project_key text not null,
  target_project text not null,
  sheet_name text not null,
  display_name text,
  spreadsheet_id text,
  sheet_title text,
  index_check_enabled boolean not null default false,
  crawl_request_enabled boolean not null default false,
  deploy_enabled boolean not null default false,
  unexposed_priority_enabled boolean not null default false,
  run_order integer not null default 1000,
  index_runner text not null default 'generic',
  sheet_runner text not null default 'generic',
  crawl_runner text not null default 'generic',
  crawl_runner_pc text not null default 'siwol-win',
  settings jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.naver_project_groups.unexposed_priority_enabled is
  '그룹의 일일 추가 배포와 수집요청에서 미노출 지역·키워드 조합을 먼저 처리할지 결정한다.';

create index if not exists idx_naver_project_groups_enabled_order
  on public.naver_project_groups(index_check_enabled, run_order, group_key);

create index if not exists idx_naver_project_groups_crawl_runner_pc
  on public.naver_project_groups(crawl_runner_pc, crawl_request_enabled, run_order, group_key);

-- -----------------------------------------------------------------------------
-- 3. Project domains (registry / source of truth for hosts)
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_domains (
  id bigserial primary key,
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  project_key text not null,
  target_project text not null,
  host text not null,
  site_url text not null,
  provider text,
  naver_account_id text references public.naver_searchadvisor_accounts(account_id),
  deployment_status text not null default 'active',
  is_visible boolean not null default true,
  page_count integer not null default 0,
  static_page_count integer not null default 0,
  sitemap_url_count integer not null default 0,
  sitemap_max_post_id integer,
  rss_url_count integer not null default 0,
  route_style text,
  post_route_mode text,
  post_url_pattern text,
  rss_mode text,
  rss_post_count integer,
  area_slug text,
  area_name text,
  region_label text,
  subdomain_generation_strategy text not null default 'legacy-unknown',
  naver_registration_status text not null default 'pending',
  naver_registered_at timestamptz,
  naver_verified_at timestamptz,
  naver_verification_token text,
  naver_meta_tag text,
  naver_console_url text,
  source_table text,
  source_pk text,
  source_run_id text,
  deployed_at timestamptz,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint naver_project_domains_host_unique unique (host),
  constraint naver_project_domains_subdomain_generation_strategy_check
    check (
      subdomain_generation_strategy in (
        'regional-location',
        'random-two-words',
        'manual',
        'legacy-unknown'
      )
    )
);

comment on column public.naver_project_domains.naver_registration_status is
  'pending | registered | verified. Crawl-request targeting requires verified.';

comment on column public.naver_project_domains.subdomain_generation_strategy is
  'Hostname label generation rule: regional-location, random-two-words, manual, or legacy-unknown.';

-- host is referenced by weekly_page_expansion_targets.host
create unique index if not exists idx_naver_project_domains_host_unique_btree
  on public.naver_project_domains(host);

-- composite key required by naver_project_page_combo_overrides (domain_id, group_key) FK
create unique index if not exists idx_naver_project_domains_id_group
  on public.naver_project_domains(id, group_key);

create index if not exists idx_naver_project_domains_group_active
  on public.naver_project_domains(group_key, deployment_status, is_visible, host)
  include (site_url, naver_account_id, page_count, region_label);

create index if not exists idx_naver_project_domains_account
  on public.naver_project_domains(naver_account_id, group_key, deployment_status, is_visible)
  include (host, site_url, page_count, naver_registration_status);

create index if not exists idx_naver_project_domains_source
  on public.naver_project_domains(source_table, source_pk);

create index if not exists idx_naver_project_domains_group_subdomain_strategy
  on public.naver_project_domains(group_key, subdomain_generation_strategy, deployment_status, is_visible);

-- -----------------------------------------------------------------------------
-- 4. Per-group / per-account crawl controls
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_group_account_controls (
  group_key text not null references public.naver_project_groups(group_key) on delete cascade,
  naver_account_id text not null references public.naver_searchadvisor_accounts(account_id) on delete restrict,
  crawl_request_enabled boolean not null default true,
  crawl_runner_pc text,
  rollout_role text,
  reason text,
  changed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_key, naver_account_id),
  constraint naver_project_group_account_controls_runner_pc_check
    check (crawl_runner_pc is null or btrim(crawl_runner_pc) <> '')
);

comment on column public.naver_project_group_account_controls.rollout_role is
  'Optional cohort label filtered by scripts/sync-naver-project-page-catalog.mjs --rollout-role.';

create index if not exists idx_naver_project_group_account_controls_runner
  on public.naver_project_group_account_controls(
    crawl_runner_pc, group_key, crawl_request_enabled, naver_account_id
  );

create index if not exists idx_naver_project_group_account_controls_role
  on public.naver_project_group_account_controls(group_key, rollout_role, naver_account_id)
  where rollout_role is not null;

create table if not exists public.naver_project_group_account_control_events (
  id bigserial primary key,
  group_key text not null references public.naver_project_groups(group_key) on delete cascade,
  naver_account_id text not null references public.naver_searchadvisor_accounts(account_id) on delete restrict,
  crawl_request_enabled boolean not null,
  crawl_runner_pc text,
  reason text,
  changed_by text,
  changed_at timestamptz not null default now()
);

create index if not exists idx_naver_project_group_account_control_events_lookup
  on public.naver_project_group_account_control_events(group_key, naver_account_id, changed_at desc);

-- -----------------------------------------------------------------------------
-- 5. Page dictionaries (locations / main keywords)
-- -----------------------------------------------------------------------------
create table if not exists public.naver_page_locations (
  id integer generated always as identity primary key,
  name text not null unique,
  search_name text generated always as (
    lower(
      regexp_replace(
        regexp_replace(btrim(name), '^.*[[:space:]]+', ''),
        '[[:space:]]+',
        '',
        'g'
      )
    )
  ) stored,
  rollout_order integer,
  rollout_source text,
  created_at timestamptz not null default now(),
  constraint naver_page_locations_name_not_blank check (btrim(name) <> ''),
  constraint naver_page_locations_rollout_order_positive
    check (rollout_order is null or rollout_order > 0),
  constraint naver_page_locations_rollout_source_check
    check (rollout_source is null or rollout_source in ('legal', 'administrative', 'checklist')),
  constraint naver_page_locations_rollout_pair_consistent
    check ((rollout_order is null) = (rollout_source is null))
);

comment on column public.naver_page_locations.rollout_order is
  '배포가 공유하는 지역 순서. 한번 부여한 순서는 이름과 함께 고정한다.';

comment on column public.naver_page_locations.rollout_source is
  '배포 지역 출처: legal(법정동), administrative(행정동), checklist(검색 체크리스트 보강).';

create index if not exists idx_naver_page_locations_search_name
  on public.naver_page_locations(search_name, id);

create unique index if not exists idx_naver_page_locations_rollout_order
  on public.naver_page_locations(rollout_order)
  where rollout_order is not null;

create table if not exists public.naver_page_keywords (
  id integer generated always as identity primary key,
  name text not null unique,
  search_name text generated always as (
    lower(regexp_replace(btrim(name), '[[:space:]]+', '', 'g'))
  ) stored,
  created_at timestamptz not null default now(),
  constraint naver_page_keywords_name_not_blank check (btrim(name) <> '')
);

create index if not exists idx_naver_page_keywords_search_name
  on public.naver_page_keywords(search_name, id);

-- -----------------------------------------------------------------------------
-- 6. Page catalog
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_pages (
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  domain_id bigint not null references public.naver_project_domains(id) on delete cascade,
  request_id integer not null,
  path text not null,
  location_id integer not null references public.naver_page_locations(id) on delete restrict,
  main_keyword_id integer not null references public.naver_page_keywords(id) on delete restrict,
  content_version text not null,
  primary key (domain_id, request_id),
  constraint naver_project_pages_request_id_positive check (request_id > 0),
  constraint naver_project_pages_path_absolute check (path like '/%'),
  constraint naver_project_pages_content_version_not_blank check (btrim(content_version) <> '')
);

comment on table public.naver_project_pages is
  '모든 프로젝트의 배포 페이지를 공통으로 관리하는 압축 카탈로그. 반복되는 지역과 메인키워드는 사전 ID로 참조한다.';

create unique index if not exists idx_naver_project_pages_domain_path
  on public.naver_project_pages(domain_id, path);

create index if not exists idx_naver_project_pages_group_combo
  on public.naver_project_pages(group_key, location_id, main_keyword_id);

create index if not exists idx_naver_project_pages_group_keyword_location
  on public.naver_project_pages(group_key, main_keyword_id, location_id);

-- -----------------------------------------------------------------------------
-- 7. Weekly page expansion (support tables for combo overrides / catalog sync)
-- -----------------------------------------------------------------------------
create table if not exists public.weekly_page_expansion_runs (
  run_id text primary key,
  week_key text not null,
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  increment integer not null check (increment > 0),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'partial', 'complete', 'failed')),
  target_domain_count integer not null default 0,
  succeeded_domain_count integer not null default 0,
  failed_domain_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (week_key, group_key)
);

create table if not exists public.weekly_page_expansion_targets (
  run_id text not null references public.weekly_page_expansion_runs(run_id) on delete cascade,
  host text not null references public.naver_project_domains(host) on delete restrict,
  previous_page_count integer not null check (previous_page_count >= 0),
  target_page_count integer not null check (target_page_count > previous_page_count),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'complete', 'failed')),
  attempt_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, host)
);

create index if not exists idx_weekly_page_expansion_runs_group_status
  on public.weekly_page_expansion_runs(group_key, status, week_key desc);

create index if not exists idx_weekly_page_expansion_targets_status
  on public.weekly_page_expansion_targets(run_id, status, host);

-- -----------------------------------------------------------------------------
-- 8. Region + keyword exposure checklist
-- -----------------------------------------------------------------------------
create table if not exists public.naver_region_keyword_exposure_targets (
  id bigserial primary key,
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  source_key text not null,
  source_spreadsheet_id text,
  source_sheet_gid bigint,
  source_sheet_name text,
  source_row integer not null,
  query_text text not null,
  location_name text not null,
  location_search_name text not null,
  main_keyword_id integer not null references public.naver_page_keywords(id) on delete restrict,
  exposure_status text not null default 'unknown',
  result_url text,
  result_rank integer,
  observed_at timestamptz not null default now(),
  is_active boolean not null default true,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint naver_region_keyword_exposure_targets_source_row_positive
    check (source_row > 0),
  constraint naver_region_keyword_exposure_targets_query_not_blank
    check (btrim(query_text) <> ''),
  constraint naver_region_keyword_exposure_targets_location_not_blank
    check (btrim(location_search_name) <> ''),
  constraint naver_region_keyword_exposure_targets_status_check
    check (exposure_status in ('exposed', 'unexposed', 'unknown')),
  constraint naver_region_keyword_exposure_targets_rank_positive
    check (result_rank is null or result_rank > 0),
  constraint naver_region_keyword_exposure_targets_source_row_unique
    unique (source_key, source_row)
);

comment on table public.naver_region_keyword_exposure_targets is
  '검색 노출 체크리스트의 지역+메인키워드 결과. 동일 검색어가 여러 전체 행정주소 페이지에 우선순위로 적용된다.';

create unique index if not exists idx_naver_region_keyword_exposure_id_group
  on public.naver_region_keyword_exposure_targets(id, group_key);

create index if not exists idx_naver_region_keyword_exposure_group_combo
  on public.naver_region_keyword_exposure_targets(
    group_key, location_search_name, main_keyword_id, observed_at desc, source_row desc
  )
  include (exposure_status, result_url, result_rank)
  where is_active = true;

create index if not exists idx_naver_region_keyword_exposure_group_status
  on public.naver_region_keyword_exposure_targets(
    group_key, exposure_status, main_keyword_id, location_search_name
  )
  where is_active = true;

create index if not exists idx_naver_region_keyword_exposure_group_source_freshness
  on public.naver_region_keyword_exposure_targets(
    group_key, source_spreadsheet_id, source_sheet_gid, observed_at desc
  )
  where is_active = true;

-- -----------------------------------------------------------------------------
-- 9. Page combination overrides (append-only replication assignments)
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_page_combo_overrides (
  group_key text not null references public.naver_project_groups(group_key) on delete restrict,
  domain_id bigint not null references public.naver_project_domains(id) on delete restrict,
  source_page_id integer not null check (source_page_id > 0),
  global_slot bigint not null check (global_slot >= 0),
  location_id integer not null references public.naver_page_locations(id) on delete restrict,
  location_search_name text not null,
  main_keyword_id integer not null references public.naver_page_keywords(id) on delete restrict,
  run_id text not null references public.weekly_page_expansion_runs(run_id) on delete restrict,
  source_exposure_target_id bigint,
  reason text not null default 'unexposed-replication',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain_id, source_page_id),
  unique (group_key, global_slot),
  constraint naver_project_page_combo_overrides_reason_check
    check (reason = 'unexposed-replication'),
  constraint naver_project_page_combo_overrides_domain_group_fk
    foreign key (domain_id, group_key)
    references public.naver_project_domains(id, group_key)
    on delete restrict,
  constraint naver_page_combo_override_exposure_group_fk
    foreign key (source_exposure_target_id, group_key)
    references public.naver_region_keyword_exposure_targets(id, group_key)
    on delete restrict
);

comment on table public.naver_project_page_combo_overrides is
  '기존 URL 콘텐츠 매핑을 바꾸지 않고 신규 페이지에만 그룹별 미노출 조합의 신뢰 사이트 복제를 고정하는 append-only 할당표.';

comment on column public.naver_project_page_combo_overrides.location_search_name is
  '띄어쓰기·전체주소 별칭을 합친 노출 체크 조합 키.';

create index if not exists idx_naver_project_page_combo_overrides_run
  on public.naver_project_page_combo_overrides(run_id, domain_id, source_page_id);

create unique index if not exists idx_naver_page_combo_override_domain_combo
  on public.naver_project_page_combo_overrides(group_key, domain_id, location_id, main_keyword_id);

create index if not exists idx_naver_page_combo_override_replication
  on public.naver_project_page_combo_overrides(group_key, location_id, main_keyword_id, domain_id);

-- -----------------------------------------------------------------------------
-- 10. Search Advisor crawl-request runs / results
-- -----------------------------------------------------------------------------
create table if not exists public.naver_searchadvisor_crawl_request_runs (
  run_id text primary key,
  target_project text not null,
  account_id text,
  trigger_type text not null default 'manual',
  status text not null default 'running',
  queue_path text,
  report_path text,
  queue_order text,
  submit_mode text,
  dry_run boolean not null default false,
  headless boolean not null default false,
  batch_size integer,
  concurrency integer,
  next_index integer not null default 0,
  total_tasks integer not null default 0,
  processed_count integer not null default 0,
  submitted_count integer not null default 0,
  already_present_count integer not null default 0,
  submitted_or_present_count integer not null default 0,
  skipped_missing_count integer not null default 0,
  skipped_reserved_path_count integer not null default 0,
  quota_stop_count integer not null default 0,
  failed_count integer not null default 0,
  unknown_count integer not null default 0,
  blocked_count integer not null default 0,
  host_quota_stop_count integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_result_at timestamptz,
  runner_host text,
  runner_cwd text,
  error text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint naver_searchadvisor_crawl_request_runs_status_check
    check (status in ('running', 'succeeded', 'partial', 'failed', 'imported'))
);

create table if not exists public.naver_searchadvisor_crawl_request_results (
  id bigserial primary key,
  run_id text not null references public.naver_searchadvisor_crawl_request_runs(run_id) on delete cascade,
  result_index integer not null,
  account text,
  host text,
  post_id integer,
  page_domain_id bigint,
  page_request_id integer,
  url text not null,
  status text not null,
  note text,
  requested_at timestamptz not null default now(),
  mode text,
  api_code integer,
  api_message text,
  api_response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, result_index),
  constraint naver_crawl_results_project_page_fk
    foreign key (page_domain_id, page_request_id)
    references public.naver_project_pages(domain_id, request_id)
    on delete set null
);

create index if not exists idx_naver_searchadvisor_crawl_runs_project
  on public.naver_searchadvisor_crawl_request_runs(target_project, updated_at desc);

create index if not exists idx_naver_searchadvisor_crawl_runs_account_project
  on public.naver_searchadvisor_crawl_request_runs(account_id, target_project, updated_at desc)
  include (run_id, status);

create index if not exists idx_naver_searchadvisor_crawl_runs_status
  on public.naver_searchadvisor_crawl_request_runs(status, updated_at desc);

create index if not exists idx_naver_searchadvisor_crawl_results_host
  on public.naver_searchadvisor_crawl_request_results(host, requested_at desc);

create index if not exists idx_naver_searchadvisor_crawl_results_status
  on public.naver_searchadvisor_crawl_request_results(status, requested_at desc);

create index if not exists idx_naver_searchadvisor_crawl_results_url
  on public.naver_searchadvisor_crawl_request_results(url);

create index if not exists idx_naver_searchadvisor_crawl_results_done_account_url
  on public.naver_searchadvisor_crawl_request_results(account, url)
  include (run_id, host, post_id, status, requested_at)
  where status in ('submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path');

create index if not exists idx_naver_crawl_results_project_page_latest
  on public.naver_searchadvisor_crawl_request_results(
    page_domain_id, page_request_id, requested_at desc, id desc
  )
  include (run_id, account, status, api_code)
  where page_domain_id is not null and page_request_id is not null;

-- -----------------------------------------------------------------------------
-- 11. Per-page crawl state (compacted execution log)
-- -----------------------------------------------------------------------------
create table if not exists public.naver_project_page_crawl_state (
  domain_id bigint not null,
  request_id integer not null,
  last_result_id bigint,
  last_run_id text,
  last_account_id text,
  last_status text,
  last_attempt_at timestamptz,
  last_done_result_id bigint,
  last_done_run_id text,
  last_done_at timestamptz,
  last_success_result_id bigint,
  last_success_run_id text,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain_id, request_id),
  constraint naver_project_page_crawl_state_page_fk
    foreign key (domain_id, request_id)
    references public.naver_project_pages(domain_id, request_id)
    on delete cascade
);

comment on table public.naver_project_page_crawl_state is
  '대용량 수집 로그를 매번 읽지 않도록 페이지별 최신 시도와 최신 성공만 보관하는 실행 상태 테이블.';

create index if not exists idx_naver_project_page_crawl_state_pending
  on public.naver_project_page_crawl_state(last_done_at, last_attempt_at, domain_id, request_id);

-- -----------------------------------------------------------------------------
-- 12. Naver index (exposure) check runs / results / urls
-- -----------------------------------------------------------------------------
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

-- =============================================================================
-- VIEWS
-- =============================================================================

-- 1/6 crawl-request eligible domains
create or replace view public.naver_crawl_request_target_domains as
select
  domain.id,
  domain.group_key,
  groups.project_key,
  groups.target_project,
  groups.run_order,
  groups.crawl_runner,
  groups.settings as group_settings,
  domain.host,
  domain.site_url,
  domain.provider,
  domain.naver_account_id,
  account.status as account_status,
  account.status as searchadvisor_session_status,
  account.searchadvisor_session_secret_id,
  domain.page_count,
  domain.route_style,
  domain.post_route_mode,
  domain.post_url_pattern,
  domain.rss_mode,
  domain.rss_post_count,
  domain.area_slug,
  domain.area_name,
  domain.region_label,
  domain.naver_registration_status,
  domain.source_table,
  domain.source_pk,
  domain.source_run_id,
  coalesce(account_control.crawl_runner_pc, groups.crawl_runner_pc) as crawl_runner_pc
from public.naver_project_domains domain
join public.naver_project_groups groups
  on groups.group_key = domain.group_key
join public.naver_searchadvisor_accounts account
  on account.account_id = domain.naver_account_id
left join public.naver_project_group_account_controls account_control
  on account_control.group_key = domain.group_key
 and account_control.naver_account_id = domain.naver_account_id
where groups.crawl_request_enabled = true
  and domain.is_visible = true
  and domain.deployment_status = 'active'
  and domain.page_count > 0
  and domain.naver_registration_status = 'verified'
  and account.status <> 'blocked'
  and account.searchadvisor_session_secret_id is not null
  and coalesce(
    account_control.crawl_request_enabled,
    not (
      lower(coalesce(groups.settings->>'requireExplicitCrawlAccountControl', 'false'))
        in ('1', 'true', 'yes', 'on')
    )
  );

comment on column public.naver_crawl_request_target_domains.searchadvisor_session_status is
  'Compatibility alias of account_status. Account usability is persisted only in naver_searchadvisor_accounts.status.';

-- 2/6 per-account crawl run plan
create or replace view public.naver_project_group_crawl_accounts as
select
  group_key,
  target_project,
  naver_account_id,
  min(run_order) as run_order,
  count(*)::integer as domain_count,
  sum(page_count)::integer as page_count,
  crawl_runner_pc
from public.naver_crawl_request_target_domains
group by group_key, target_project, crawl_runner_pc, naver_account_id;

-- 3/6 index-check eligible domains
create or replace view public.naver_index_check_target_domains as
select
  domain.id,
  domain.group_key,
  groups.project_key,
  groups.target_project,
  groups.sheet_name,
  coalesce(groups.display_name, groups.sheet_name) as display_name,
  groups.spreadsheet_id,
  groups.sheet_title,
  groups.run_order,
  groups.index_runner,
  groups.sheet_runner,
  groups.settings as group_settings,
  domain.host,
  domain.site_url,
  domain.provider,
  domain.naver_account_id,
  account.status as account_status,
  domain.page_count,
  domain.sitemap_url_count,
  domain.area_slug,
  domain.area_name,
  domain.region_label,
  domain.deployed_at,
  domain.source_table,
  domain.source_pk,
  domain.source_run_id,
  domain.source_payload
from public.naver_project_domains domain
join public.naver_project_groups groups
  on groups.group_key = domain.group_key
join public.naver_searchadvisor_accounts account
  on account.account_id = domain.naver_account_id
where groups.index_check_enabled = true
  and domain.is_visible = true
  and domain.deployment_status = 'active'
  and account.status <> 'blocked';

-- 4/6 latest exposure state per group + search-name combo
create or replace view public.naver_region_keyword_exposure_latest as
select distinct on (target.group_key, target.location_search_name, target.main_keyword_id)
  target.id,
  target.source_key,
  target.source_spreadsheet_id,
  target.source_sheet_gid,
  target.source_sheet_name,
  target.source_row,
  target.query_text,
  target.location_name,
  target.location_search_name,
  target.main_keyword_id,
  keyword.name as main_keyword,
  target.exposure_status,
  target.result_url,
  target.result_rank,
  target.observed_at,
  target.source_payload,
  target.group_key
from public.naver_region_keyword_exposure_targets target
join public.naver_page_keywords keyword on keyword.id = target.main_keyword_id
where target.is_active = true
order by
  target.group_key,
  target.location_search_name,
  target.main_keyword_id,
  target.observed_at desc,
  target.source_row desc,
  target.id desc;

comment on view public.naver_region_keyword_exposure_latest is
  '그룹별 지역+키워드의 최신 노출 상태. 조회 시 group_key를 반드시 지정한다.';

-- 5/6 latest exposure state resolved against full location names
create or replace view public.naver_region_keyword_exposure_latest_full_location as
select distinct on (target.group_key, location.id, target.main_keyword_id)
  target.id,
  target.source_key,
  target.source_spreadsheet_id,
  target.source_sheet_gid,
  target.source_sheet_name,
  target.source_row,
  target.query_text,
  target.location_name,
  location.id as location_id,
  target.location_search_name,
  target.main_keyword_id,
  keyword.name as main_keyword,
  target.exposure_status,
  target.result_url,
  target.result_rank,
  target.observed_at,
  target.source_payload,
  target.group_key
from public.naver_region_keyword_exposure_targets target
join public.naver_page_locations location on location.name = target.location_name
join public.naver_page_keywords keyword on keyword.id = target.main_keyword_id
where target.is_active = true
order by
  target.group_key,
  location.id,
  target.main_keyword_id,
  target.observed_at desc,
  target.source_row desc,
  target.id desc;

comment on view public.naver_region_keyword_exposure_latest_full_location is
  '그룹별 전체 location_name에서 해석된 location_id와 메인키워드 조합의 최신 노출 상태. 매칭되지 않는 지역명은 제외한다.';

-- 6/6 runner queue: pages joined with exposure state and last crawl attempt
create or replace view public.naver_crawl_request_page_candidates as
select
  page.group_key,
  target.project_key,
  target.target_project,
  target.run_order,
  target.crawl_runner,
  target.crawl_runner_pc,
  target.naver_account_id,
  page.domain_id,
  page.request_id,
  page.path,
  target.host,
  target.site_url,
  rtrim(target.site_url, '/') || page.path as page_url,
  target.page_count,
  target.route_style,
  target.post_route_mode,
  target.post_url_pattern,
  target.rss_mode,
  target.rss_post_count,
  target.area_slug,
  target.area_name,
  target.region_label,
  page.location_id,
  location.name as location,
  location.search_name as location_search_name,
  page.main_keyword_id,
  keyword.name as main_keyword,
  exposure.id as exposure_target_id,
  coalesce(exposure.exposure_status, 'unknown') as exposure_status,
  exposure.query_text as exposure_query_text,
  exposure.result_url as exposure_result_url,
  exposure.result_rank as exposure_result_rank,
  exposure.observed_at as exposure_observed_at,
  case coalesce(exposure.exposure_status, 'unknown')
    when 'unexposed' then 0
    when 'unknown' then 1
    else 2
  end as exposure_priority,
  state.last_result_id,
  state.last_run_id,
  state.last_account_id,
  state.last_status,
  state.last_attempt_at,
  state.last_done_result_id,
  state.last_done_run_id,
  state.last_done_at,
  state.last_success_result_id,
  state.last_success_run_id,
  state.last_success_at
from public.naver_project_pages page
join public.naver_crawl_request_target_domains target on target.id = page.domain_id
join public.naver_page_locations location on location.id = page.location_id
join public.naver_page_keywords keyword on keyword.id = page.main_keyword_id
left join public.naver_region_keyword_exposure_latest_full_location exposure
  on exposure.group_key = page.group_key
 and exposure.location_id = page.location_id
 and exposure.location_name = location.name
 and exposure.main_keyword_id = page.main_keyword_id
left join public.naver_project_page_crawl_state state
  on state.domain_id = page.domain_id
 and state.request_id = page.request_id;

comment on view public.naver_crawl_request_page_candidates is
  '수집 대상 페이지와 전체 location_name 기준 최신 노출 상태 및 요청 이력을 결합한 DB 큐 후보.';

commit;
