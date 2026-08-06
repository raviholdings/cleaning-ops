-- =============================================================================
-- Cleaning-Ops :: seed the single project group for this repository
-- =============================================================================
-- No legacy groups, domains or pages are imported. This creates only the group
-- row that domains, pages and check runs for the 입주청소 project hang off.
--
--   group_key      : cleaning-ravi
--   target_project : cleaning-ravi   (matches apps/cleaning-ravi)
--   crawl_runner_pc: siwol-win       (matches CRAWL_RUNNER_PC in .env)
--
-- group_key matches data/domains.json and the operator's seed data, so nothing
-- downstream has to be rewritten.
--
-- crawl_request_enabled is left true so that a domain becomes an eligible crawl
-- target as soon as it reaches naver_registration_status = 'verified' and its
-- account has a stored Search Advisor session.
-- =============================================================================

begin;

insert into public.naver_project_groups (
  group_key,
  project_key,
  target_project,
  sheet_name,
  display_name,
  index_check_enabled,
  crawl_request_enabled,
  deploy_enabled,
  unexposed_priority_enabled,
  run_order,
  index_runner,
  sheet_runner,
  crawl_runner,
  crawl_runner_pc,
  settings,
  notes
) values (
  'cleaning-ravi',
  'cleaning-ravi',
  'cleaning-ravi',
  '입주청소',
  '입주청소 정적 프로젝트',
  true,
  true,
  true,
  false,
  10,
  'generic',
  'generic',
  'db',
  'siwol-win',
  jsonb_build_object(
    'postUrlStyle', 'slashless',
    'domainKind', 'all',
    'capPageFirst', false,
    'source', 'naver_project_domains',
    'spreadsheetStatePath', 'reports/naver-site-search/cleaning-index-google-sheet.json'
  ),
  'Standalone 입주청소 static-site project.'
)
on conflict (group_key) do update set
  project_key = excluded.project_key,
  target_project = excluded.target_project,
  sheet_name = excluded.sheet_name,
  display_name = excluded.display_name,
  index_check_enabled = excluded.index_check_enabled,
  crawl_request_enabled = excluded.crawl_request_enabled,
  deploy_enabled = excluded.deploy_enabled,
  run_order = excluded.run_order,
  index_runner = excluded.index_runner,
  sheet_runner = excluded.sheet_runner,
  crawl_runner = excluded.crawl_runner,
  crawl_runner_pc = excluded.crawl_runner_pc,
  settings = public.naver_project_groups.settings || excluded.settings,
  updated_at = now();

-- Remove the earlier placeholder group key. Aborts rather than cascading if
-- anything was already attached to it.
do $$
declare
  dependent_domains integer;
  dependent_pages integer;
  dependent_runs integer;
begin
  if not exists (select 1 from public.naver_project_groups where group_key = 'cleaning') then
    return;
  end if;

  select count(*) into dependent_domains
  from public.naver_project_domains where group_key = 'cleaning';
  select count(*) into dependent_pages
  from public.naver_project_pages where group_key = 'cleaning';
  select count(*) into dependent_runs
  from public.naver_index_check_runs where group_key = 'cleaning';

  if dependent_domains > 0 or dependent_pages > 0 or dependent_runs > 0 then
    raise exception
      'Refusing to drop group "cleaning": % domain(s), % page(s), % run(s) still reference it.',
      dependent_domains, dependent_pages, dependent_runs
      using errcode = '55000';
  end if;

  delete from public.naver_project_groups where group_key = 'cleaning';
end;
$$;

commit;
