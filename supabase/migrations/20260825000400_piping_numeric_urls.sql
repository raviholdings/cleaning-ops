-- 배관 URL 을 숫자로 전환 (2026-08-25 운영자 확정).
--
--   종전: /배관/{구-동}/{메인키워드}
--   변경: /piping/{1..200}
--
-- 이유: 한글 경로가 물리던 비용을 없앤다.
--   · dedup 인코딩 불일치(원문 vs percent-encoded) — 사이트맵 모드로 우회 중이던 것
--   · Git Bash(MSYS) 의 경로 인자 변조
--   · 결과 테이블의 긴 url 텍스트 (청소·이사 합쳐 약 158MB)
--   · 페이지마다 디렉토리를 만들던 것 — 400만 장 기준 디렉토리 400만 개 → 2만 개
-- 페이지 내용(제목·H1·본문)의 지역·키워드는 그대로다. 주소만 번호가 된다.
-- 근거: 청소가 이미 /1~/131 숫자 URL 이고 색인 전환율 35% 를 낸다(2026-08-20 실측).
--
-- 이사(moving-ravi)는 건드리지 않는다 — 이미 34만 건을 네이버에 제출했다.
--
-- 코드 쪽 짝: scripts/lib/piping-page-data.mjs (pipingPagePath), deploy-piping-sites.mjs

begin;

update public.naver_project_groups
   set settings = jsonb_set(settings, '{sitemapPath}', '"/piping/sitemap.xml"'),
       updated_at = now()
 where group_key in ('piping-ravi', 'piping-ravi-shared');

-- 재배포 전까지 수집요청을 잠근다.
-- 지금 오리진에 올라가 있는 사이트맵은 아직 옛 한글 URL 이라, 켜둔 채로 러너를
-- 돌리면 곧 사라질 주소를 네이버에 제출하게 된다. 재배포가 끝난 뒤 다시 켠다.
update public.naver_project_groups
   set crawl_request_enabled = false,
       updated_at = now()
 where group_key in ('piping-ravi', 'piping-ravi-shared');

commit;
