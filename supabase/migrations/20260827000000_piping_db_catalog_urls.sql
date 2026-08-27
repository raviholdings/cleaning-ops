-- 배관 신규 도메인을 사이트맵 모드에서 DB 카탈로그 모드로 바꾼다 (2026-08-27).
--
-- 문제: HaiIP 를 켜면 이름에 fast 가 들어간 도메인(one-qfast.com)이 접속되지 않는다.
-- 수집요청 러너는 HaiIP 가 필수라 그 루트의 사이트맵을 못 읽고, 계정당 100개 중
-- 10개가 통째로 빠졌다 (실측: 제출 4,500 / 5,000). 네트워크 전체로 10만 건이다.
-- 제출 자체는 searchadvisor.naver.com 으로 가므로 막히지 않는다 — 우리 도메인에서
-- 사이트맵 XML 을 읽어오는 단계만 문제였다.
--
-- 해결: 사이트맵을 아예 안 읽는다. 청소가 쓰는 방식과 같다.
-- 2026-08-26 URL 을 숫자로 바꾸면서 /piping/{postId} 로 치환식 표현이 가능해졌다
-- (그전에는 /배관/{구-동}/{키워드} 라 표현할 수 없어 사이트맵을 읽었다.
--  20260824000000 의 주석이 그 시절 기준이다).
--
-- page_count 는 "지금 배포된 장수" 다. 청소가 131(=배포된 131장)인 것과 같은 관례다.
-- 배관은 200(최종 목표)이 들어가 있어 그대로 두면 51~200번이 404 인 채로 제출된다.
-- 페이즈를 올려 재배포할 때마다 이 값도 같이 올린다.
--
-- 차용분(piping-ravi-shared)은 건드리지 않는다. 청소 도메인을 빌려 쓰는 구조라
-- 그 행의 page_count·post_url_pattern 은 청소 것이고, 바꾸면 청소가 깨진다.
-- 차용분은 사이트맵 모드 + 생성 폴백(NAVER_CRAWL_PIPING_PAGE_COUNT)으로 간다.

begin;

update public.naver_project_domains
   set page_count = 50,
       post_url_pattern = '/piping/{postId}',
       updated_at = now()
 where group_key = 'piping-ravi';

-- 사이트맵 모드를 끈다. 러너도 piping-ravi 에는 SITEMAP_ONLY_PROJECTS 를 넘기지 않는다.
update public.naver_project_groups
   set settings = (settings - 'sitemapPath' - 'postUrlStyle'),
       updated_at = now()
 where group_key = 'piping-ravi';

commit;
