# 배관 프로젝트 핸드오버 — 인프라·서버 플로우 총정리

> 2026-08-24 작성. 새 세션이 이 문서 하나로 배관 업종 작업을 시작할 수 있도록
> 운영자 확정 요구사항 + 기존 인프라 전체 플로우 + 실행 단계 + 함정을 담았다.
> 세부 절차는 `.claude/skills/`(deploy·server·r2·crawl·index-check)가 최신이다.

## 1. 운영자 확정 요구사항 (2026-08-24 지시 원문 기준)

| 항목 | 확정 내용 |
|---|---|
| 업종 | **배관** (철거보다 먼저. 철거 자산은 `apps/demolition-static/`에 보류 중) |
| 규모 | **200계정 × 100도메인 = 20,000 서브도메인, 약 200만 페이지** (사이트당 ~100장) |
| 계정 | 기존 100개 **+ 신규 100개** (신규분은 소유확인부터). 배관 전용 ~100계정 목표 |
| 루트 도메인 | **그대로** (10개 루트 재사용, 서브도메인 추가 생성) |
| 지역 풀 | **기존 그대로** (72,938 지역) |
| 키워드 | **전달 예정** — 수령 후 메인/서브 AI 매칭·세트 묶음 작업. 메인 키워드를 늘려 200만 장 달성 |
| 랜딩 UI | **모티브: 다봄배관** — UI/UX 똑같이, 세부 내용만 조금씩 변경. 제작 파이프라인은 청소 정적 시스템 재사용 |
| 업체명 | **없이** (브랜드명 불포함) |
| 이미지·연락처 | **전달 예정** (수령 후 작업 시작) |
| 수익 모델 | CPA iframe 아님 — **자체 DB폼**: 어디서든 접수 → 우리 DB 저장 → **관리자 페이지에서 확인 + 텔레그램 알림** (구글시트 연동 등 편한 방식 허용) |
| 수집요청 순서 | 청소 재수집(131만) 완료 → **배관 수집요청으로 전환** |

### 수령 대기 (작업 시작 조건)
- [ ] 배관 메인/서브 키워드 목록
- [ ] 이미지 (참고: `C:\Users\LD\Desktop\img\renamed\` 에 {자리}_{세트}.webp 100장 변환본 있음 — 철거용으로 준비했던 것. 배관용인지 운영자 확인 필요)
- [ ] 연락처 (폼 수신자 정보)
- [ ] 다봄배관 원본 URL 또는 캡처 (UI 복제 기준)
- [ ] 텔레그램 봇 토큰 + 수신 chat_id
- [ ] 신규 계정 100개 (네이버 계정 생성은 운영자 영역)

### 새 세션이 임의로 정하면 안 되는 것 (운영자 확인 필수)
- 그룹 키 이름 (제안: `piping-ravi`. 주의 — 코드 기본값에 옛 `watermelon-piping`/`bbungbbung-piping`이 살아 있다. 충돌 금지)
- 신규 서브도메인 명명 규칙, 계정↔도메인 배정
- 신규 100계정의 기계 배정 (현행: PC 1-20 / VM1 21-50·102 / VM2 51-80·104-105 / VM3 81-101 — 100계정 추가 시 VM 증설 또는 재배정 필요. docs/HAIIP-VM-SCALEOUT-PROMPT.md 참고)
- R2 이미지 프리픽스 (관례: `piping/`), 자산 버전 폴더 (관례: `site/piping-v1/`)

## 2. 인프라 전체 플로우 (2026-08-24 현재)

### 2-1. 서빙 체인
```
방문자/네이버봇
  → Cloudflare (루트 10개 존, 프록시. HTML 캐시 없음 / assets.* 만 엣지 TTL 1년)
  → EC2 오리진 1대 (t3.small, i-039361b55ae33808b, 54.116.79.116)
      nginx: /srv/group-page-origin/sites/$host  (정적 .html.gz, gzip_static)
             /img/*      → /srv/group-page-origin/shared (사이트 공용: 캐러셀 이미지)
             /_e         → 204 + lead.log 기록 (비콘)
             /go/*       → 302 리다이렉트 (CPA/외부 링크 — 교체 시 재배포 불필요)
  이미지·CSS·JS → assets.<루트> (Cloudflare R2 버킷 cleaning-assets, 버전 폴더 immutable)
```
- 보안그룹: 80/443 = Cloudflare 대역만. 22 = 평소 0개, 배포 스크립트가 내 IP /32 로 자동 개폐 (`scripts/lib/origin-ssh.mjs`, 수동: `origin-ssh-door.mjs`)
- 루트 10개: anclose, pipe-oneshot, amunsa, naoheg, ddulea, neverfoul, uloung, daddul, one-qfast, oneshot-sewer (.com)
- 서브도메인 DNS: Cloudflare 와일드카드. one-qfast 는 국내 ISP 가 CF 엣지 IP 일부를 간헐 차단(봇·서버는 정상)

### 2-2. 페이지 생성·배포 (결정적 생성기)
- 모든 페이지 = (siteIndex, pageId)의 순수 함수. 언제 구워도 같은 바이트
- 청소: `build-and-deploy-sites.mjs --renderer static --templates templates-merged --extend merged --gzip --no-feeds`
- 이사: `deploy-moving-sites.mjs` (카탈로그 SLOT_STRIDE=100 — 사이트당 폭 100 예약, 증설해도 기존 페이지 불변)
- 전송: tar|ssh **직결 SSH 기본** (배포 중 SG 22 자동 개폐, 87분→14분 실측). HaiIP 가동 중엔 `--ssm` 폴백
- 배포 중 PC 수집요청(HaiIP) 금지 — IP 바뀌면 끊김
- 로드맵: 대규모(700장/사이트급)부터 오리진 베이크(서버에 Node22·git 있음) 또는 CF Workers 엣지 렌더 — docs/MOVING-PROJECT-SPEC.md "블록 append" 참고

### 2-3. DB (Supabase Postgres, 2.6GB)
- `naver_project_domains` (도메인·소유확인 토큰·계정 배정) / `naver_searchadvisor_accounts` (계정, account_order)
- `naver_project_pages` + `naver_page_locations` (페이지 카탈로그) / `naver_project_page_crawl_state` (URL당 1행 최신 상태)
- `naver_searchadvisor_crawl_request_runs`/`_results` (제출 이력 — 인덱스 다이어트 완료: url·host 는 hash 인덱스)
- `naver_index_check_urls`/`_results` (색인 조사) / `lead_submissions` (폼·비콘 이벤트)
- `naver_crawl_request_target_domains`·`naver_crawl_request_page_candidates` (뷰 — 그룹 조인, domainSourceGroup 으로 도메인 차용)
- 관리자 통계 MV `admin_crawl_page_candidate_counts` (갱신: `refresh-admin-stats.mjs`)
- **함정**: pg 는 connect 직후 `set statement_timeout` 필수 (config 는 서버에 안 닿음)

### 2-4. 수집요청 파이프라인
```
run-crawl-range.ps1(청소) / run-moving-crawl-range.ps1(이사)  ← -From/-To 계정 순번, -DoneSince 재수집 기준선
  → run-windows-naver-crawl-resume.ps1: 계정 루프
      HaiIP UI 자동 조작(계정 배정 IP 전환·확인) → 저장 세션을 그 IP 로 검증 → submit-naver-searchadvisor-crawl-requests.mjs
  → 결과 DB 기록(원문은 로컬 jsonl → R2 ravi-ops-logs, upload-crawl-raw-logs.mjs)
```
- 한도: **사이트당 50건/일 (00시 KST 리셋)** — 업종이 같은 서브도메인을 공유하면 한도도 공유
- 실측 최대: 10,000사이트 × 50 = 하루 48만 제출 (2026-08-23, 4기계)
- dedup = URL 문자열 완전일치 (인코딩 형태 통일 필수). `-DoneSince` 는 기준선 이전 기록을 무효화 (후보·dedup·fast-skip 3곳)
- 계정↔IP↔세션이 기계에 묶임 — 남의 범위를 돌리면 실패. 병렬은 기계 단위로만
- 소유확인: `npm run domains:register` → 서치어드바이저 등록·토큰 (토큰 존재≠등록 완료 함정) → verify-crawl-chain 러너

### 2-5. 색인 조사 / 관리자 / 리드
- 색인: `run-index-check-batches.ps1` — site: 검색 기반, 총량 차단(1,400~1,900/일·IP), run-id 단위 누적
  - **2026-08-22 사태**: 네이버가 저품질 도메인의 site:/노출을 일괄 제거 → 재수집(-DoneSince)으로 재평가 유도, 루트 단위 순차 회복 관찰 중 (naoheg 1일 만에 복귀)
- 관리자: `apps/cleaning-admin` (vite preview + run-admin-server.ps1. 수정 후 재빌드+재시작 필요)
- 리드 비콘: 페이지 /_e → nginx lead.log → `ingest-lead-beacon.mjs`(매일 09:30 스케줄) → lead_submissions
- 텔레그램 알림: **아직 없음 — 배관에서 신규 구축** (아래 3-3)

## 3. 배관 실행 계획 (순서대로)

### 3-1. 키워드 구조화 (키워드 수령 후)
- 전달받은 배관 메인/서브 키워드를 AI 매칭·세트 묶음 (이사 방식: 메인 N × 서브 배정, 코프라임 셔플)
- 200만 장 산술: 20,000사이트 × 100장. 지역 풀 72,938 × 메인 키워드 수로 재고 확인 (이사 참고: 지역×메인 20개 = 146만 재고)
- 카탈로그는 SLOT_STRIDE 패턴 재사용 — 나중에 증설해도 기존 페이지 불변

### 3-2. 랜딩 템플릿 (이미지·다봄배관 자료 수령 후)
- `apps/piping-static/piping-template/` 신설 — 이사(move-template) 구조 복제가 출발점
- 다봄배관 UI/UX 복제, 업체명 없음, 연락처는 전달값
- 제목: 청소식 가변 조합(지역+메인+서브+어미 시드 회전, 40자 이내, 브랜드 없음)
- 캐러셀: **ItemList 독립 JSON-LD 블록 + same-origin 이미지(/img/piping/)** — 청소·이사에서 검증된 형태 그대로
- 폼: 자체 DB폼 (아래 3-3). iframe 아님 → checkOrigin 함정 무관
- 자산: R2 `site/piping-v1/` (immutable, 업로드 스크립트 --version 명시 필수)

### 3-3. DB폼 + 텔레그램 알림 (신규 배관)
정적 오리진이라 POST 받을 곳이 필요하다. 선택지(운영자와 확정할 것):
1. **Cloudflare Worker** (권장) — 폼 POST → Supabase lead_submissions insert + Telegram Bot API sendMessage. 오리진 무변경, 10존 라우트
2. 기존 lead router (`PUBLIC_LEAD_ROUTER_BASE_URL=https://nichebox.siwol.kr`) 확장 — 외부 의존
3. EC2 에 소형 API 추가 — 오리진이 동적 서버가 됨 (비권장)
- 공통: lead_submissions 에 저장(관리자 페이지 리드 탭에서 확인) + 텔레그램 즉시 알림 + (선택) 구글시트 미러
- 스팸 방어: rate limit + 봇 UA 필터 (ingest-lead-beacon 의 필터 재사용)

### 3-4. 서브도메인 20,000 + 계정 200
1. 신규 계정 100개 수령 → `naver_searchadvisor_accounts` 등록 (account_order 103~ 이후, 기존 102·104·105 와 충돌 주의)
2. 신규 서브도메인 ~10,000 생성 (`plan/apply-cleaning-subdomains.mjs` 패턴) — 루트 10개 균등, DNS 는 와일드카드라 CF 작업 최소
3. `domains:register` 로 DB 등록 + 계정 배정
4. 소유확인: verify-crawl-chain (HaiIP 필수, 계정 간 병렬 불가 — 기계 단위만). **100계정 소유확인은 대형 작업** — 일일 목표 정해 분할
5. 신규 계정 기계 배정 확정 + VM .env/세션 구축 (HAIIP-VM-SCALEOUT-PROMPT.md)

### 3-5. 굽기·배포
- 200만 장 ≈ 16GB(gz) — 디스크 41GB 여유로 수용 가능, inode 여유 확인됨
- 직결 SSH 로 전송 ~35분급. **이 규모부터 오리진 베이크 전환을 검토할 가치 있음** (전송 0)
- 기존 청소·이사 사이트와 같은 서브도메인을 쓰는 구간은 경로 분리 (예: /배관/ 또는 별도 페이지 대역) — 청소 /N.html 불변 원칙

### 3-6. 수집요청
- 그룹 등록 (마이그레이션: moving-ravi 패턴 — 20260820000000 참고. 신규 서브도메인은 자체 그룹, 기존 서브도메인 차용분은 domainSourceGroup)
- 전용 러너 스크립트 `run-piping-crawl-range.ps1` (이사 패턴 복제)
- **전환 시점: 청소 재수집 완료 후** (운영자 확정). 같은 서브도메인 = 한도 공유 주의
- 페이스: 200만 장 ÷ (사이트 수 × 50/일). 20,000사이트 풀가동이면 하루 100만 — 실측은 계정·기계 수에 좌우

### 3-7. 색인·관리자 연동
- 색인 체커 대상 그룹 확장, 관리자 카드에 배관 추가 (PROJECTS 배열 — CrawlRequestTab.tsx)
- MV 재정의 시 도메인 차용 그룹 제외 조건 유지

## 4. 함정 목록 (실전에서 피 흘리고 배운 것)

| 함정 | 요지 |
|---|---|
| pg statement_timeout | config 무효. connect 직후 `SET` 필수 |
| R2 immutable | 같은 경로 덮어쓰기 금지(엣지 1년 캐시). 버전 폴더 + 기본버전 상수 갱신. 업로드 --version 명시 필수 |
| 자산 버전 롤백 사고 | 재배포가 env 없이 돌면 기본값 자산으로 롤백됨 — merged-page-data ASSET_VERSION 기본값이 진실 |
| iframe checkOrigin | src 를 리다이렉트 경로로 바꾸면 resizer 가 메시지 거부(150px 고정). 구버전 resizer 는 배열도 못 읽음 — false 만 동작 |
| 캐러셀 | ItemList 는 @graph 밖 독립 블록 + 페이지당 1개 + same-origin 이미지 + url 절대경로 |
| dedup 인코딩 | 제출 URL 과 배포 URL 의 퍼센트 인코딩 형태 통일 (사이트맵 <loc> 기준) |
| -DoneSince | 재수집 기준선. 후보·dedup·fast-skip 3곳 적용. check-crawl-remaining 은 기준선 모름 |
| HaiIP | 관리자 권한+AttachThreadInput 필수. -NoHaiIp 금지. 켜지면 Claude API·직결 SSH 끊김 |
| SSM | Run Command 출력 24KB 잘림. 터널 실효 6.4Mbps. 큰 파일은 직결 SSH 나 R2 릴레이 |
| MSYS | Git Bash 가 /path 인자·글롭을 변조. MSYS2_ARG_CONV_EXCL, 또는 목록은 stdin 으로 |
| Windows sleep | timeout.exe 는 stdin 리다이렉트에서 죽음 — Atomics.wait 사용 |
| PS 5.1 | 2>&1 이 stderr 를 ErrorRecord 화($? 오염). 한글 env 깨짐 — 인코딩된 리터럴로 |
| 네이버 노출 초기화 | 2026-08-22 저품질 일괄 제거 실측. 재수집(-DoneSince)이 재평가를 유도, 회복은 루트 단위 순차. already-present 12/48만 = 재제출 정상 접수 |
| 소유확인 | 토큰 존재 ≠ 등록 완료. IP 바꿔가며 확인 필요 |
| 색인 조사 | 총량 차단 1,400~1,900/일·IP. site: 는 네이버가 언제든 바꿈 — 제목 검색·유입 로그로 교차 검증 |
| 관리자 페이지 | 실시간 무거운 쿼리 금지(2026-08-21 DB 포화 사태). 카운트·MV 만. 수정 후 재빌드+재시작 |
| 원문 로그 | DB 저장 금지 — 로컬 jsonl → R2 ravi-ops-logs (crawl-raw/) |

## 5. 자주 쓰는 명령

```powershell
# 수집요청 (기계별 범위 준수)
powershell -File scripts/run-crawl-range.ps1 -From 1 -To 20 [-DoneSince 2026-08-23T00:00:00+09:00]
# 배포 (청소)
node scripts/build-and-deploy-sites.mjs --renderer static --templates templates-merged --extend merged --gzip --no-feeds
# 색인 조사
powershell -File scripts/run-index-check-batches.ps1 -RunId <id> -Rounds N
# 잔여/통계
node scripts/check-crawl-remaining.mjs · node scripts/refresh-admin-stats.mjs
# 리드 로그
node scripts/ingest-lead-beacon.mjs (매일 09:30 자동) · node scripts/fetch-crawl-raw-logs.mjs --date YYYY-MM-DD
# SSH 문
node scripts/origin-ssh-door.mjs --status|--open|--close
```
