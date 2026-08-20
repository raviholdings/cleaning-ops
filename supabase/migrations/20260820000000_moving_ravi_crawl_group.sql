-- 이사(moving-ravi) 수집요청 등록.
--
-- 이사는 자기 도메인이 없다 — 청소의 10,000 서브도메인에 /이사/ 서브디렉토리로
-- 얹혀 있다. naver_project_domains.host 가 unique 라 도메인 행을 복제할 수도 없다.
-- 그래서 타깃 뷰의 조인에 "도메인 빌려오기"(settings.domainSourceGroup)를 추가하고,
-- moving-ravi 그룹 행 하나만 넣는다.
--
-- 기존 그룹(cleaning-ravi)은 settings 에 domainSourceGroup 이 없으므로 coalesce 가
-- 자기 group_key 로 떨어져 청소 쪽 결과는 한 행도 달라지지 않는다.
-- (naver_project_group_crawl_accounts 는 이 뷰에서 파생되므로 자동으로 따라온다.)

create or replace view public.naver_crawl_request_target_domains as
select
  domain.id,
  groups.group_key,   -- 도메인을 빌려 쓰는 그룹이면 그 그룹 이름이 나와야 한다 (원래는 domain.group_key)
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
  on domain.group_key = coalesce(groups.settings->>'domainSourceGroup', groups.group_key)
join public.naver_searchadvisor_accounts account
  on account.account_id = domain.naver_account_id
left join public.naver_project_group_account_controls account_control
  on account_control.group_key = groups.group_key
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
        not (lower(coalesce(groups.settings->>'requireExplicitCrawlAccountControl', 'false')) in ('1', 'true', 'yes', 'on'))
      );

insert into public.naver_project_groups (
  group_key, project_key, target_project, sheet_name, display_name,
  index_check_enabled, crawl_request_enabled, deploy_enabled,
  unexposed_priority_enabled, run_order, index_runner, sheet_runner,
  crawl_runner, crawl_runner_pc, settings, notes
) values (
  'moving-ravi', 'moving-ravi', 'moving-ravi', '이사', '이사 정적 프로젝트',
  false, true, false, false, 20, 'generic', 'generic', 'db', 'siwol-win',
  jsonb_build_object(
    'domainSourceGroup', 'cleaning-ravi',
    'source', 'naver_project_domains',
    'domainKind', 'all',
    'postUrlStyle', 'sitemap',
    'sitemapPath', '/이사/sitemap.xml'
  ),
  '이사 서브디렉토리 프로젝트. 도메인·계정·세션은 cleaning-ravi 를 빌려 쓴다 (domainSourceGroup). URL 은 각 사이트의 /이사/sitemap.xml 에서 읽는다.'
)
on conflict (group_key) do update set
  crawl_request_enabled = excluded.crawl_request_enabled,
  settings = excluded.settings,
  notes = excluded.notes,
  updated_at = now();
