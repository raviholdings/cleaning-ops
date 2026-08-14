# 색인 확인 작업 인수인계

작성 2026-08-13. 다른 세션에서 색인 작업을 이어받기 위한 문서.

원본 코드는 `~/Desktop/ravi/keyword_ranking` 이다. cleaning-ops 는 거기서 필요한
것만 빼온 것이다. 참고로 `~/Desktop/ravi/naver-exposure-check` 는 색인이 아니라
**노출 순위** 프로그램이다 (3장 참고).

---

## 0-1. 토큰 회수 (NAVER_REGISTER_TOKEN_RECOVERY) — 쓰기 전에 읽을 것

DB 에 `미등록`(토큰 없음)으로 보이는 도메인이 **실제로는 네이버에 이미 등록돼
있고 토큰만 잃어버린** 경우가 있다. 2026-08-06 파일 손상 때 그런 일이 있었고,
`#17`(100건)·`#19`(10건)이 그 잔재였다.

이때 그냥 재등록하면 막힌다. 네이버는 **계정당 사이트 100개 상한**이 있어서
슬롯이 이미 차 있으면 등록 버튼이 안 눌린다.

```
error 최대 100개 사이트를 등록할 수 있습니다.
```

회수 스위치를 켜면 `/console/verify?site=...` 에서 토큰을 다시 받아온다.

```bash
NAVER_REGISTER_TOKEN_RECOVERY=1 \
node scripts/register-naver-searchadvisor-sites.mjs --account <계정>
```

**⚠️ 이 스위치는 기본으로 꺼져 있고, 그럴 이유가 있다.** 그 경로는 등록되지
않은 사이트에도 토큰을 내준다. 평소에 켜두면 토큰만 쌓이고 사이트 목록에는
아무것도 안 올라간다. 실제로 토큰 96개를 모으고 등록 0건이었던 사고가 있었다.

### 켜기 전에 반드시 확인할 것

먼저 네이버의 실제 상태를 읽는다. 읽기만 하므로 안전하다.

```bash
node scripts/sync-naver-verification-status.mjs --account <계정> --dry-run --no-require-ip
```

```
네이버 사이트 목록 100건, 그중 소유확인 완료 90건   ← 이미 등록돼 있다
DB 100건 | 네이버에서 미확인 10건
```

- **네이버 목록이 100건이면** 이미 등록된 것이다 → 회수 모드가 맞다
- **100건 미만이면** 슬롯이 남았다 → 회수 모드 없이 정상 등록하면 된다

### 일부만 토큰이 없는 계정은 반드시 범위를 좁힐 것

2026-08-14 에 `#19`(verified 90 + 토큰없음 10)에 `--limit` 없이 회수를 돌렸다.
스크립트가 **이미 `verified` 인 90건까지 다시 훑어 `registered` 로 되돌려 놓았다.**

복구는 된다. 네이버 쪽 상태는 안 바뀌므로 sync 로 되돌린다.

```bash
node scripts/sync-naver-verification-status.mjs --account <계정> --no-require-ip
```

토큰 값 자체는 사이트마다 고정이라 재조회해도 같은 값이 나온다. 배포된
메타태그와 어긋나지 않는다(표본 4건 확인). 그래도 불필요한 왕복이므로
**`#17` 처럼 전량이 미등록인 계정이 아니면 `--limit` 으로 끊어서 돌릴 것.**

### 회수 뒤에는 재배포가 필요하다

토큰은 페이지의 `<meta name="naver-site-verification">` 로 나가야 소유확인이
된다. 회수만 하고 소유확인을 돌리면 사전점검에서 전부 건너뛴다.

```
토큰 회수 → 재배포 → 소유확인 → 수집요청
```

---

## 0. 2026-08-13 진행 결과 (읽고 시작할 것)

### 파일 손상을 복구했다

8월 6일 11:23~12:16 사이에 여러 스크립트가 서로의 내용으로 덮어써지는 사고가
있었다. `tmp/corrupt-backup/` 에 그때 격리한 `.corrupt` 파일들이 남아 있다.
색인 확인이 실행조차 안 되던 원인이 이것이었다. 아래를 복구했다.

| 파일 | 무슨 일이 있었나 | 조치 |
|---|---|---|
| `scripts/naver-site-check-proxy.mjs` | `check-naver-indexed-posts.mjs` 복사본으로 덮어써짐. 자기 자신을 import 하고 있었다 | keyword_ranking 원본 복원 (13,891 B) |
| `scripts/sync-naver-project-page-catalog.mjs` | `apps/cleaning-ravi/src/site.mjs` 내용이 들어와 있었다 | keyword_ranking 원본 복원 (34,455 B) |
| `apps/cleaning-ravi/src/site.mjs` | 아예 사라져 있었다. 위 파일이 유일본이었다 | 제자리로 이동 (2,597 B) |
| `supabase/migrations/20260630093000_create_naver_index_check_registry.sql` | 애초에 안 넘어와 있었다 | keyword_ranking 에서 복사 (6,272 B) |

아직 판단 못 한 것 — `scripts/check-cloudflare-dns.mjs` 와
`scripts/set-dns-unproxied.mjs` 가 내용이 완전히 같다(1,981 B). 하나가 다른 하나를
덮어썼는데 keyword_ranking 에 없는 파일이라 원본을 알 수 없다. 작은 유틸이라 보류.

### 시험 실행이 통과했다

```
NAVER_INDEX_GROUP_KEY=cleaning-ravi NAVER_INDEX_CHECK_LIMIT=5 NAVER_INDEX_MAX_PAGES=2 \
NAVER_INDEX_CHECK_CONCURRENCY=1 \
node scripts/check-naver-indexed-posts.mjs --group cleaning-ravi \
  --run-id probe-20260813-002 --trigger manual
```

5개 도메인, 차단 0건, 에러 0건, 약 2분. DB 에 `runs` 1행 / `results` 5행 /
`urls` 35행이 정상 기록됐다. 리포트는 `reports/naver-site-search/` 에 떨어진다.

### 수집요청 → 색인 인과관계가 실측으로 확인됐다

| 도메인 | 수집요청 | 색인 |
|---|---|---|
| `acorn-marsh.pipe-oneshot.com` | **51장** (8/10) | **34장** |
| `acorn-brick.ddulea.com` | 0장 | 0 |
| `acorn-cobra.anclose.com` | 0장 | 0 |
| `acorn-echo.neverfoul.com` | 0장 | 0 |
| `acorn-gentle.pipe-oneshot.com` | 0장 | 0 |

**수집요청을 넣은 곳만 색인됐다.** 색인률 67%, 걸린 시간 3일.
수집요청이 색인으로 가는 유일한 경로이며, 색인이 안 붙는 구조적 문제는 없다.

이 대조는 반복해서 볼 가치가 있다. 색인 결과와 수집요청 이력을 조인하는 쿼리를
정식 리포트에 넣어두면 "요청 대비 색인률"을 계속 추적할 수 있다.
(`naver_index_check_results.domain` = `naver_searchadvisor_crawl_request_results.host`)

### 다음 병목은 프록시다

프록시가 없어 지금은 이 PC 의 IP 로 직접 나간다. 소량은 괜찮지만 전량은 불가능하다.

```
10,000 도메인 × 최대 9페이지, 요청 간 5초 → 순차 125시간
```

`scripts/naver-site-check-proxy.mjs` 가 지원하는 방식은 두 가지다.

1. **Webshare API** — `NAVER_INDEX_WEBSHARE_API_KEY` 를 넣으면 프록시 목록을
   API 로 자동으로 받아온다. 코드 수정이 전혀 필요 없다. 가장 쉬운 길.
2. **프록시 파일** — `NAVER_INDEX_PROXY_FILE` 에 경로를 주고, 파일에
   `http://아이디:비밀번호@호스트:포트` 를 한 줄에 하나씩 적는다. `#` 로 주석 가능.

두 저장소 어디에도 Webshare 키나 프록시 파일이 없다. 다만 **`.env` 에 Bright Data
설정이 이미 있다** (`BRIGHT_DATA_PROXY_SERVER` / `_USERNAME` / `_PASSWORD`).
이건 네이버 수집요청·소유확인 쪽에서 쓰는 것인데, Bright Data 의 로테이팅
게이트웨이는 같은 주소로 요청할 때마다 나가는 IP 가 바뀐다. 그러므로 **프록시 파일에
한 줄만 적어도 동작할 가능성이 있다.** 새로 결제하기 전에 이걸 먼저 시험해 볼 것.

```
# config/naver-index-proxies.txt 예시
http://<BRIGHT_DATA_PROXY_USERNAME>:<BRIGHT_DATA_PROXY_PASSWORD>@<BRIGHT_DATA_PROXY_SERVER>
```

```bash
NAVER_INDEX_PROXY_FILE=config/naver-index-proxies.txt \
NAVER_INDEX_GROUP_KEY=cleaning-ravi NAVER_INDEX_CHECK_LIMIT=5 \
node scripts/check-naver-indexed-posts.mjs --group cleaning-ravi
```

실행 로그의 `proxySource` 가 `file`, `proxyCount` 가 1 이상으로 나오면 붙은 것이다.
같은 도메인을 여러 번 돌려 나가는 IP 가 실제로 바뀌는지 확인해야 의미가 있다.

---

## 1. 결정 사항 — 색인 확인부터 (2026-08-13 운영자 확정)

**이번 작업은 (A) 색인 확인이다.** 노출 순위 확인은 나중이다.

근거 세 가지.

1. **순서상 색인이 먼저다.** 색인이 안 된 페이지는 검색 결과에 존재하지 않으므로
   순위를 잴 대상 자체가 없다.
2. **지금 진행 중인 수집요청의 효과를 재는 유일한 지표다.** 앞으로 2주에 걸쳐
   100만 장을 요청할 계획인데, 색인이 실제로 붙는지 확인할 방법이 이것뿐이다.
   안 붙는다면 2주 뒤가 아니라 지금 알아야 한다. 그래서 **지금 기준선을 잡아두는
   것이 목적**이며, "아직 색인이 적어서 무의미하다"는 이유로 미루면 안 된다.
3. **작업이 가볍고 병행이 가능하다.** 색인 확인은 비로그인 검색이라 네이버 세션도
   HaiIP 도 쓰지 않는다. 따라서 이 PC 에서 수집요청이 도는 동안에도 다른 기기나
   프록시로 동시에 돌릴 수 있다. 대상도 도메인 단위 10,000개로 끝난다.

아래는 두 저장소가 무엇이 다른지에 대한 참고 자료다.

| | 하는 일 | 결과물 | 어디에 있나 |
|---|---|---|---|
| **색인 확인** | `site:https://호스트/` 로 검색해 네이버가 그 도메인의 페이지를 몇 장 물고 있는지 센다 | 도메인별 색인 페이지 수 | `cleaning-ops/scripts/check-naver-indexed-posts.mjs` |
| **노출 확인** | 키워드를 검색해 우리 도메인이 몇 위에 뜨는지 본다 | 키워드별 최고 순위 | `naver-exposure-check` (Python) |

`naver-exposure-check` 는 **노출 확인** 프로그램이다. 색인 확인 코드가 아니다.
반면 cleaning-ops 에는 이미 색인 확인 스크립트가 들어 있다.

**→ 이번 작업(A)은 cleaning-ops 의 기존 색인 스크립트를 쓴다.**
`naver-exposure-check` 에서는 **크롤링 운영 방식만** 참고한다 (아래 4장).
노출 순위(B)는 색인이 붙는 것이 확인된 뒤에 별도 작업으로 진행한다.

---

## 2. 파이프라인 현재 위치

색인은 아래 세 단계가 끝나야 의미가 있다. 앞 단계 상태는 이렇다.

| 단계 | 상태 | 수치 |
|---|---|---|
| 배포 | ✅ 완료 | 10,000 / 10,000 서브도메인 · 1,000,000 페이지 |
| 소유확인 | 🔄 진행 중 | 약 4,800 / 10,000 서브도메인 (VM 3대 병렬) |
| 수집요청 | 🔄 진행 중 | 218,896장 / 2,676 서브도메인 |
| **색인 확인** | ⬜ **미실행** | 한 번도 안 돌았음 |

네트워크 구조는 **메인도메인 10개 × 서브도메인 1,000개 × 100장**이다.

메인도메인: `amunsa.com`, `anclose.com`, `daddul.com`, `ddulea.com`, `naoheg.com`,
`neverfoul.com`, `one-qfast.com`, `oneshot-sewer.com`, `pipe-oneshot.com`, `uloung.com`

> `one-qfast.com` 은 운영자 PC 의 VPN 이 차단한다. 로컬에서 접속이 안 되는 건
> 정상이며 사이트 장애가 아니다. 서버에서 보면 정상 응답한다.

### 지금 돌리는 목적은 "기준선"이다

지금 색인 확인을 돌리면 대부분 "색인 안 됨"으로 나온다. 수집요청을 넣은 게
전체의 21.9% 뿐이고, 그마저도 넣은 지 며칠 안 됐다. 네이버가 실제로 수집해
색인에 반영하기까지는 시간이 걸린다.

**그래도 지금 돌린다.** 숫자가 낮게 나오는 것이 목적이기 때문이다. 앞으로
수집요청이 진행되면서 이 숫자가 오르는지를 봐야 하는데, 비교할 출발점이 없으면
"올랐다"는 판단 자체가 불가능하다. 그리고 색인이 아예 안 붙는 구조적 문제가
있다면 100만 장을 요청하기 전에 발견해야 한다.

주기적으로 재실행해 추이를 보는 것이 실제 쓸모다. `naver_index_check_runs` 가
실행 단위로 집계를 남기므로 회차 간 비교가 된다.

---

## 3. cleaning-ops 에 이미 있는 것

### DB 테이블 (마이그레이션 완료, 스키마 존재)

| 테이블 | 행 수 | 용도 |
|---|---|---|
| `naver_index_check_target_domains` | **10,000** | 확인 대상. cleaning-ravi 전량 이미 채워져 있음 |
| `naver_index_check_runs` | 0 | 실행 단위 기록 (집계 카운터 다수) |
| `naver_index_check_results` | 0 | 도메인별 결과 |
| `naver_index_check_urls` | 0 | 색인된 URL 목록 |

마이그레이션: `supabase/migrations/20260630093000_create_naver_index_check_registry.sql`

`naver_index_check_results` 의 주요 칼럼 — `domain`, `indexed`, `no_result`,
`indexed_post_count`, `visible_indexed_post_count`, `indexed_static_url_count`,
`indexed_url_count`, `search_cap_reached`, `pages_checked`, `stopped_by`, `error`

### 스크립트

| 파일 | 크기 | 용도 |
|---|---|---|
| `scripts/check-naver-indexed-posts.mjs` | 42KB | **본체.** `site:` 검색으로 색인 확인 |
| `scripts/run-naver-index-checks.sh` | 16KB | 그룹 단위 러너 (락, 재시도, 타임아웃) |
| `scripts/naver-index-check-alert.mjs` | 6KB | 실패 알림 |
| `scripts/list-naver-index-check-runners.mjs` | 2KB | 러너 목록 |
| `scripts/update-naver-index-google-sheet.mjs` | 28KB | 구글 시트 반영 |
| `scripts/lib/naver-index-target-query.mjs` | — | 대상 조회 |
| `scripts/lib/naver-index-url-classifier.mjs` | — | URL 분류 (포스트/정적) |
| `scripts/naver-site-check-proxy.mjs` | — | 프록시 풀 관리 |

### 본체가 동작하는 방식

```
https://search.naver.com/search.naver?query=site:https://호스트/&start=N
```

- 페이지네이션: `start = 1, 21, 41, 61, 81, 101, 121, 141, 161` (기본 9페이지)
- 차단 판정 후 다른 프록시로 재시도 (`markProxyBlocked`)
- 무결과 판정: HTML 에 `api_noresult_wrap` 또는 `검색결과가 없습니다`
- 기본 지연: 요청 간 5초, 호스트 간 10초
- 재개 지원: `NAVER_INDEX_CHECK_RESUME`(기본 켜짐)

주요 환경변수 — `NAVER_INDEX_GROUP_KEY`, `NAVER_INDEX_MAX_PAGES`,
`NAVER_INDEX_REQUEST_DELAY_MS`, `NAVER_INDEX_HOST_DELAY_MS`,
`NAVER_INDEX_CHECK_CONCURRENCY`, `NAVER_INDEX_CHECK_LIMIT`,
`NAVER_INDEX_PROXY_ENABLED`, `NAVER_INDEX_PROXY_FILE`, `NAVER_INDEX_QUERY_MODES`

**결론: 색인 확인은 새로 만들 필요가 없다.** 있는 걸 돌려보고 부족한 점을 찾는 게
먼저다. `naver-exposure-check` 를 통째로 이식하는 건 중복 작업이 된다.

---

## 4. naver-exposure-check 에서 가져올 만한 것

Python 저장소이고 청소 네트워크가 아니라 `pipe`, `internet`, `law` 프로젝트를 본다.
그대로 쓸 수는 없고, **설계 아이디어와 특정 모듈**만 참고 가치가 있다.

### 가져올 가치가 있는 것

| 대상 | 왜 |
|---|---|
| **로컬 스풀 아키텍처** (`src/local_spool.py`, `scripts/upload_local_spool.py`) | 크롤링 결과를 DB 에 바로 안 쓰고 `jsonl` 에 쌓았다가, 검증 통과 후에만 일괄 업로드. 중간에 DB 가 죽어도 결과가 안 날아간다. 10,000 도메인 규모에서 이 방식이 맞다 |
| **완료 검증 게이트** (README 5번) | 실패·캡차·로그인 이동·차단이 하나라도 있으면 DB 업로드를 막는다. 부분 결과가 "확인 완료"로 둔갑하는 걸 방지 |
| **캡차/차단 처리** (`src/naver_search.py` — `CaptchaDetectedError`, `BrowserCrashedError`) | 네이버 차단 시나리오가 이미 분류돼 있다 |
| **병렬 샤딩** (`sharded_parallel_runner.py`, `scripts/run_parallel_local_spool.py`) | 워커별 작업 범위 분할 방식 |
| **도메인 매칭** (`src/ranking_parser.py` — `TargetDomainMatcher`, `host_suffix_candidates`) | 서브도메인/리다이렉트를 고려한 호스트 매칭. 우리도 서브도메인이 10,000개라 필요 |

### 가져오지 말 것

- `src/official_admin_regions.py`, `region_cleanup.py`, `region_qualification.py`,
  `keyword_expansion.py`, `rebuild_intti_*.py` — 인티(intti) 프로젝트 전용 지역/키워드
  가공 로직. 청소 네트워크는 `data/locations/rollout-locations.json` 과
  `apps/cleaning-ravi/src/lib/keywords.ts` 를 쓴다
- `src/browser_sheets.py`, `apps_script_sheets.py` — 구글 시트 연동.
  cleaning-ops 에 이미 `update-naver-index-google-sheet.mjs` 가 있다
- `src/cycle_reporting.py`, `cycle_reporter.py` — 사이클 리포트 (노출 확인 전용 개념)
- `config_*.example.yaml` — 다른 업종 설정
- `*.csv`, `data/official_admin_20260724/` — 인티 데이터

### 언어 문제

`naver-exposure-check` 는 Python, cleaning-ops 는 Node.js 다.
**Python 코드를 그대로 옮기지 말고 개념만 가져와 Node 로 다시 쓰는 게 맞다.**
cleaning-ops 에 Python 런타임을 새로 들이면 배포·스케줄러가 복잡해진다.

---

## 5. 규모와 제약

### 무엇을 몇 번 검색해야 하나

색인 확인은 **페이지 단위가 아니라 도메인 단위**다.

```
서브도메인 10,000개 × 최대 9페이지 = 최대 90,000 요청
요청 간 5초 지연 → 순차 실행 시 125시간
```

동시성을 올리면 줄지만 네이버가 차단한다. **프록시 없이는 현실적으로 불가능하다.**
`NAVER_INDEX_PROXY_ENABLED` / `NAVER_INDEX_PROXY_FILE` 로 프록시 풀을 붙이면
동시성이 프록시 수만큼 올라간다 (`effectiveCheckConcurrency`).

첫 실행은 `NAVER_INDEX_CHECK_LIMIT` 으로 50~100개만 잘라서
차단이 나는지, 결과가 제대로 파싱되는지부터 확인할 것.

### 실행 환경 제약

- **이 PC(`DESKTOP-SI088GJ`) 에서는 네이버 관련 작업을 한 번에 하나만 돌린다.**
  HaiIP 가 공인 IP 를 바꾸기 때문에, 동시에 돌리면 서로의 연결을 끊는다.
  실제로 배포 중 IP 가 바뀌어 전송이 깨진 적이 있다.
- 소유확인은 VM 1·2·3 에서 별도로 돈다. 그건 이 PC 와 무관하다.
- 색인 확인은 네이버 로그인 세션이 **필요 없다.** 검색은 비로그인으로 한다.
  따라서 HaiIP 대신 프록시를 쓰는 편이 낫고, VM 이 아닌 다른 기기에서도 돌릴 수 있다.

---

## 6. 권장 진행 순서

1. 기존 스크립트를 소규모로 돌려본다 (아래 명령). 결과 파싱과 차단 여부 확인.
2. 부족한 점을 목록화한다. 그 목록에 대해서만 `naver-exposure-check` 에서
   해당하는 부분을 찾아 Node 로 이식한다. 특히 로컬 스풀과 검증 게이트.
3. 프록시 풀을 붙여 동시성을 올린다. 이게 없으면 전량 실행이 불가능하다.
4. 전량(10,000) 실행 → `naver_index_check_runs` 에 **기준선** 기록.
5. 수집요청이 진행되는 동안 주기적으로 재실행해 색인 증가 추이를 본다.
6. 색인이 붙는 것이 확인되면 그때 노출 순위 확인을 별도 작업으로 시작한다.

### 소규모 시험 실행

```bash
NAVER_INDEX_GROUP_KEY=cleaning-ravi \
NAVER_INDEX_CHECK_LIMIT=20 \
NAVER_INDEX_MAX_PAGES=3 \
NAVER_INDEX_CHECK_CONCURRENCY=1 \
node scripts/check-naver-indexed-posts.mjs --group cleaning-ravi
```

특정 호스트만 보려면:

```bash
NAVER_INDEX_CHECK_HOSTS=acorn-brick.ddulea.com \
node scripts/check-naver-indexed-posts.mjs --group cleaning-ravi
```

결과는 `reports/naver-site-search/` 에 떨어지고 DB 에도 기록된다.

> ⚠️ 이 스크립트는 DB 에 쓴다(`naver_index_check_runs` / `_results` / `_urls`).
> 지금 0행이므로 첫 실행이 곧 첫 데이터가 된다. 시험 실행도 기록에 남는다는 점을
> 감안하고, 필요하면 `--run-id` 로 시험임을 구분해 둘 것.

---

## 7. 참고 — 관련 문서와 상태 확인

- 전체 아키텍처: `AGENTS.md`
- 운영 규칙: `CLAUDE.md` (확인 먼저, 임의 결정 금지)
- 정적 렌더러: `docs/STATIC-RENDERER.md`
- 배포/소유확인 현황 확인용 스크립트는 세션 스크래치패드에 있음.
  없으면 `naver_project_domains` 를 직접 조회할 것:

```sql
select count(*) filter (where deployed_at is not null) as 배포,
       count(*) filter (where naver_registration_status='verified') as 소유확인,
       count(*) as 전체
  from public.naver_project_domains
 where group_key='cleaning-ravi' and deployment_status='active' and is_visible=true;
```
