-- 배관(piping) 그룹 등록.
--
-- 배관은 도메인이 두 종류다.
--   piping-ravi         신규 서브도메인 10,000개 (자기 도메인, globalSiteOrder 10001~20000)
--   piping-ravi-shared  기존 청소 서브도메인 10,000개를 /배관/ 서브디렉토리로 빌려 씀
--
-- 한 그룹이 "자기 도메인"과 "빌린 도메인"을 동시에 가질 수 없어서 그룹을 둘로 나눈다
-- (naver_crawl_request_target_domains 뷰가 domainSourceGroup 으로 조인하기 때문).
-- 뷰는 이사(20260820000000)에서 이미 domainSourceGroup 을 지원하므로 손대지 않는다.
--
-- URL 은 이사와 같은 시맨틱 주소다: /배관/{구-동}/{메인키워드}
-- postId 치환식으로 표현할 수 없어 post_url_pattern 을 비워 두고, 수집요청은
-- 사이트맵(/배관/sitemap.xml)에서 URL 을 읽는다 (postUrlStyle=sitemap).
--
-- crawl_request_enabled 는 false 로 시작한다. 배포·소유확인이 끝난 뒤 켠다
-- (운영자 확정: 수집요청 전환은 청소 재수집 완료 후).

-- 1) 서브도메인 생성 방식에 '단어붙여쓰기'를 추가한다.
--    기존 청소는 하이픈이 있는 shark-cotton, 배관 신규는 하이픈이 없는 amberwriter 다.
alter table public.naver_project_domains
  drop constraint if exists naver_project_domains_subdomain_generation_strategy_check;

alter table public.naver_project_domains
  add constraint naver_project_domains_subdomain_generation_strategy_check
  check (subdomain_generation_strategy = any (array[
    'regional-location'::text,
    'random-two-words'::text,
    'joined-two-words'::text,
    'manual'::text,
    'legacy-unknown'::text
  ]));

-- 2) 배관 자체 도메인 그룹
insert into public.naver_project_groups (
  group_key, project_key, target_project, sheet_name, display_name,
  index_check_enabled, crawl_request_enabled, deploy_enabled,
  unexposed_priority_enabled, run_order, index_runner, sheet_runner,
  crawl_runner, crawl_runner_pc, settings, notes
) values (
  'piping-ravi', 'piping-ravi', 'piping-ravi', '배관', '배관 정적 프로젝트',
  false, false, false, false, 30, 'generic', 'generic', 'db', 'siwol-win',
  jsonb_build_object(
    'source', 'naver_project_domains',
    'domainKind', 'all',
    'postUrlStyle', 'sitemap',
    'sitemapPath', '/배관/sitemap.xml'
  ),
  '배관 신규 서브도메인 10,000개 (계정 201~300). URL 은 /배관/{구-동}/{메인키워드}, 수집요청은 /배관/sitemap.xml 에서 읽는다.'
)
on conflict (group_key) do update set
  settings = excluded.settings,
  notes = excluded.notes,
  updated_at = now();

-- 3) 기존 청소 서브도메인을 빌려 쓰는 그룹 (이사 moving-ravi 와 같은 구조)
insert into public.naver_project_groups (
  group_key, project_key, target_project, sheet_name, display_name,
  index_check_enabled, crawl_request_enabled, deploy_enabled,
  unexposed_priority_enabled, run_order, index_runner, sheet_runner,
  crawl_runner, crawl_runner_pc, settings, notes
) values (
  'piping-ravi-shared', 'piping-ravi-shared', 'piping-ravi-shared', '배관(공유)', '배관 서브디렉토리 프로젝트',
  false, false, false, false, 40, 'generic', 'generic', 'db', 'siwol-win',
  jsonb_build_object(
    'domainSourceGroup', 'cleaning-ravi',
    'source', 'naver_project_domains',
    'domainKind', 'all',
    'postUrlStyle', 'sitemap',
    'sitemapPath', '/배관/sitemap.xml'
  ),
  '기존 청소 10,000 서브도메인에 /배관/ 서브디렉토리로 얹는다. 도메인·계정·세션은 cleaning-ravi 를 빌려 쓴다 (domainSourceGroup).'
)
on conflict (group_key) do update set
  settings = excluded.settings,
  notes = excluded.notes,
  updated_at = now();
