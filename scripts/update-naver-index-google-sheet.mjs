# 관리자 페이지 제작 요청 (다른 세션에 붙여넣을 프롬프트)

아래 `---` 사이 내용을 그대로 복사해서 새 세션에 붙여넣으면 됩니다.

---

## 무엇을 만드나

`C:\Users\LD\Desktop\ravi\cleaning-ops` 프로젝트의 **운영 관리자 페이지**를 만들어 주세요.
청소 서비스 SEO 프로젝트로, 네이버 서치어드바이저에 1,000개 도메인(계정 10개 × 100개)을
등록·소유확인하고 수집요청을 넣어 색인을 만드는 파이프라인입니다.

## 왜 필요한가 (클라이언트 원문 요청)

> 목적은
> 잘 배포가 되고 있는지
> 색인이 잘 되고 있는지
> 유입량이 일정하게 상승하고 있는지 체크하기 위함 입니다
>
> 유입량으로 분석하다 보면 특정 일자에 유입이 급증 하던가, 급락 하게 되면
> 네이버 검색 구좌가 바뀌었든, 색인이 풀리든, 이유를 빠르게 찾아 빠르게 복구하기 위함 입니다

핵심은 **"이상 징후를 빨리 발견하는 것"** 입니다. 예쁜 대시보드보다 일자별 추이와
급변 감지가 중요합니다. 숫자 하나만 크게 보여주는 화면은 쓸모가 없습니다.

## 먼저 읽을 것

1. `AGENTS.md` — 전체 아키텍처, 환경변수, 스크립트 매핑
2. `CLAUDE.md` — **운영 규칙. 특히 "확인 먼저, 실행은 그 다음"**
3. `supabase/migrations/20260731000000_create_naver_ops_clean_schema.sql` — 스키마 전체(41KB).
   테이블·뷰 정의가 전부 여기 있습니다
4. `docs/HANDOVER.md` — 파이프라인 현재 진행 상황

## 쓸 수 있는 데이터 (실제 존재하는 테이블)

### 배포 현황 — `public.naver_project_domains` (1,000행)
| 컬럼 | 용도 |
|---|---|
| `host`, `site_url` | 도메인 |
| `naver_account_id` | 소속 계정 (10개) |
| `group_key`, `target_project` | 그룹 구분 (현재 `cleaning-ravi`) |
| `deployment_status`, `is_visible` | 배포 상태 |
| `deployed_at` | ⚠️ **1,000행 전부 NULL. 아래 "데이터 공백" 참고** |
| `page_count`, `static_page_count`, `sitemap_url_count` | 페이지 수 |
| `naver_registration_status` | `pending` / `registered` / `verified` |
| `naver_registered_at` | 등록 일시. **1,000행 전부 값 있음 ✅** |
| `naver_verified_at` | 소유확인 일시. **약 650행 값 있음 ✅ (계속 늘어나는 중)** |
| `region_label`, `area_name` | 지역 |

### 수집요청 현황
- `public.naver_searchadvisor_crawl_request_runs` — 실행 단위.
  `run_id`, `account_id`, `status`, `started_at`, `finished_at`,
  `submitted_count`, `already_present_count`, `failed_count`, `quota_stop_count`,
  `host_quota_stop_count`, `blocked_count`, `total_tasks`
- `public.naver_searchadvisor_crawl_request_results` — URL 단위.
  `url`, `host`, `status`, `requested_at`, `api_code`, `api_message`
- `public.naver_project_page_crawl_state` — 페이지별 최신 상태(압축 로그)

### 색인 현황
- `public.naver_index_check_runs` — `check_date`, `indexed_domain_count`,
  `not_indexed_domain_count`, `indexed_post_total`, `indexed_url_total`,
  `target_domain_count`, `checked_domain_count`, `error_domain_count`
- `public.naver_index_check_results` — 도메인 단위.
  `domain`, `checked_at`, `indexed`, `indexed_post_count`,
  `visible_indexed_post_count`, `indexed_url_count`, `search_cap_reached`
- `public.naver_index_check_urls` — URL 단위 색인 결과

`naver_index_check_runs.check_date` 가 이미 일자 컬럼이라 **일자별 색인 추이는 바로 그릴 수 있습니다.**

### 키워드 노출 순위
- `public.naver_region_keyword_exposure_targets`
- 뷰: `naver_region_keyword_exposure_latest`, `naver_region_keyword_exposure_latest_full_location`

### 이미 있는 뷰 (직접 만들지 말고 먼저 확인할 것)
`naver_crawl_request_target_domains`, `naver_project_group_crawl_accounts`,
`naver_index_check_target_domains`, `naver_crawl_request_page_candidates`

## ⚠️ 반드시 알아야 할 데이터 공백 (2026-08-05 실제 조회 결과)

클라이언트가 요청한 3가지 중 **온전히 만들 수 있는 건 사실상 없습니다.** 착수 전에
이걸 먼저 이해하고, 없는 데이터로 차트를 지어내지 마세요.

| 요청 | 상태 |
|---|---|
| 배포 체크 | ⚠️ `deployed_at` 이 **1,000행 전부 NULL**. 배포 일자 데이터 없음 |
| 색인 체크 | ⚠️ `naver_index_check_*` 테이블 **3개 모두 0행**. 색인 체크를 아직 한 번도 안 돌림 |
| 유입량 체크 | ❌ 수집 경로 자체가 없음 |

수치가 있는 것은 이것뿐입니다:
- `naver_project_domains` 1,000행 — 등록 1,000 / 소유확인 약 650 (일시 컬럼 있음)
- `naver_searchadvisor_crawl_request_results` **32,339행** — `requested_at` 있음.
  **일자별 추이를 제대로 그릴 수 있는 유일한 테이블**
- `naver_searchadvisor_crawl_request_runs` 10행
- `naver_project_pages` 100,000행 (단, 날짜 컬럼 없음)
- `naver_region_keyword_exposure_targets` 0행 — 키워드 순위도 비어 있음

### 배포 일자를 어떻게 채울지
`deployed_at` 이 비어 있어 "일자별 배포 추이"는 지금 불가능합니다. 조사해서 제안해 주세요.
`created_at` 은 전부 2026-08-02 (일괄 임포트라 추이로 못 씀).
`source_payload` jsonb 안에 배포 정보가 있는지 확인해 볼 가치가 있습니다.

### 색인 데이터
스키마·스크립트는 준비돼 있는데 실행을 안 한 상태입니다. 화면은 만들되
**"아직 데이터 없음"을 정직하게 표시**하고, 색인 체크 실행 여부는 운영자와 상의하세요.

### 유입량
애널리틱스도, 액세스 로그 적재도 없습니다. **먼저 수집 방법을 조사해서 운영자에게
선택지를 제시**해 주세요. 후보:
1. 네이버 서치어드바이저 "검색 유입" 리포트를 크롤링해 일자별로 적재 (기존 서치어드바이저
   세션·계정 인프라를 그대로 재사용 가능 — 가장 현실적)
2. 랜딩페이지에 애널리틱스 삽입 (도메인 1,000개 재배포 필요)
3. 호스팅 액세스 로그 수집

**수집 방식이 정해지기 전까지 유입량 영역은 "데이터 수집 준비 중"으로 비워두고,
배포·색인·수집요청 3개 영역부터 완성**하는 게 맞습니다. 임의로 더미 데이터를 넣지 마세요.

## 화면에 있어야 할 것

**1. 상단 요약** — 전체 1,000개 대비 배포 완료 / 소유확인 완료 / 수집요청 완료 / 색인 완료 건수와 비율

**2. 일자별 추이 (가장 중요)** — 하나의 시간축에 겹쳐 볼 수 있게:
   - 일자별 소유확인 수 (`naver_verified_at`) — 데이터 있음 ✅
   - 일자별 수집요청 제출 수 (`requested_at`) — 데이터 있음 ✅ 32,339행
   - 일자별 색인된 도메인/URL 수 (`check_date`) — 지금은 0행, 자리만 잡아둘 것
   - 일자별 배포 수 (`deployed_at`) — 지금은 전부 NULL, 자리만 잡아둘 것
   - (추후) 일자별 유입량 — 수집 경로 미정

   **급증·급락을 눈에 띄게 표시**해 주세요. 클라이언트가 원한 건 이 지점입니다.
   전일 대비 변화율이 임계치를 넘으면 강조하는 식이면 충분합니다.

**3. 계정별 현황 표** — 계정 10개 각각의 등록/소유확인/색인 진행률.
   계정 하나가 막히면 바로 보여야 합니다

**4. 도메인 목록** — 검색·필터(계정, 지역, 상태별) 가능한 표.
   도메인별로 배포일 / 소유확인 여부 / 수집요청 상태 / 색인 여부 / 색인된 포스트 수

**5. 문제 도메인 뷰** — 배포됐는데 색인 안 된 것, 소유확인 실패한 것,
   수집요청 실패한 것. 복구 대상을 찾는 화면입니다

## 기술 제약

- **DB 접속**: `.env` 의 `DATABASE_URL` / `DIRECT_URL` (Supabase Postgres).
  루트에 `pg` 패키지가 이미 설치돼 있습니다
- **기존 앱 `apps/cleaning-ravi` 는 건드리지 마세요.** 이건 Astro 정적 랜딩페이지
  생성기라 대시보드를 넣을 곳이 아닙니다. `apps/` 아래 **별도 앱**으로 만드세요
- **읽기 전용으로 시작하세요.** 이 DB 는 운영 중인 파이프라인이 실시간으로 쓰고 있습니다.
  조회만 하고, 쓰기가 필요하면 먼저 물어보세요
- 마이그레이션이 필요하면 `npm run db:migrate:dry` 로 먼저 확인
- 로컬 실행 우선. 배포는 운영자 확인 후

## 진행 방식

`CLAUDE.md` 규칙에 따라 **한 번에 다 만들지 말고** 단계마다 확인받으세요:

1. 먼저 위 테이블들을 **실제로 조회**해서 각 테이블에 데이터가 몇 건 있고
   어떤 값이 들어있는지 파악한 뒤 보고 (스키마에 있어도 비어 있는 테이블이 있습니다.
   특히 색인 체크는 아직 안 돌렸을 수 있습니다)
2. 화면 구성안 제시 → 확인
3. 구현 → 로컬에서 보여주기 → 확인
4. 임의로 정한 값(임계치, 색상 기준, 페이지네이션 크기 등)은 **반드시 목록으로 보고**

---

## 참고: 이 프롬프트를 쓸 때 알아두면 좋은 현재 상태 (2026-08-05 기준)

- 소유확인 651/1000 완료, 2차 패스가 **지금 백그라운드에서 돌고 있음**.
  대시보드를 만드는 동안에도 숫자가 계속 변합니다
- 수집요청 결과 32,339행 적재됨
- 색인 체크는 **한 번도 안 돌렸음** (테이블 3개 전부 0행) — 위에서 확인함
- `one-qfast.com` 90개 도메인은 Cloudflare 존 문제로 접속 불가 상태
- `scripts/update-naver-index-google-sheet.mjs` 는 현재 깨져 있습니다
  (없어진 마이그레이션 파일을 참조). 구글시트 연동을 참고할 거면 이 점 유의
