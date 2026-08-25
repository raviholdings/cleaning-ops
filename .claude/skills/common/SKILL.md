---
name: common
description: 업종과 무관한 전역 함정 — DB 마이그레이션 적용, pg 접속, Git Bash/PowerShell 실행, 관리자 페이지 수정. 마이그레이션·DB 스크립트 작성·관리자 화면 작업 시 사용.
---

# 전역 함정

업종(청소·이사·배관)과 무관하게 이 저장소 전체에 걸리는 것들.

## 마이그레이션 — 파일을 지정해서 돌린다

`scripts/apply-migrations.mjs` 에는 **적용 이력 테이블이 없다.** 인자 없이 돌리면
`supabase/migrations/*.sql` 을 **이름순으로 전부 다시 실행**한다.

    node scripts/apply-migrations.mjs supabase/migrations/<파일>.sql   # 이렇게
    npm run db:migrate                                                 # 전부 재적용된다

각 파일이 `if not exists` / `create or replace` / `on conflict` 로 멱등하게 짜여
있어 **최종 스키마는 안전하다.** 문제는 비용이다 — 원장 스키마
(`20260731000000_create_naver_ops_clean_schema.sql:569-583`)가 인덱스 다이어트
(`20260822000000`)로 지운 인덱스 5개를 다시 만든다. 결과 테이블은 168만 행이라
**약 1,361MB 인덱스를 빌드했다가 곧바로 드롭**하고, `CONCURRENTLY` 가 아니라서
그동안 그 테이블 INSERT 가 잠긴다. 수집요청 러너가 계속 쓰는 테이블이다.

`--dry-run` 은 "무엇이 새것인지" 를 알려주지 않는다 — 그냥 전 파일을 나열한다.

## pg — connect 직후 `SET statement_timeout`

pg Client config 의 `statement_timeout` 은 **서버 세션에 반영되지 않는다**(실측).
역할 기본값이 2분이라 무거운 쿼리가 중간에 끊긴다.

    await client.connect();
    await client.query(`set statement_timeout = '1200s'`);

## Git Bash(MSYS) — 경로 인자 변조

MSYS 가 `/배관/...` 처럼 슬래시로 시작하는 인자와 글롭을 Windows 경로로 자동
변환한다. `MSYS2_ARG_CONV_EXCL` 로 끄거나, 목록은 인자 대신 **stdin 으로** 넘긴다.
ssh·tar 에 한글 URL 경로를 넘길 때 조용히 엉뚱한 값이 된다.

## Windows sleep — `timeout.exe` 금지

stdin 리다이렉트 환경에서 죽는다. Node 에서 동기 sleep 이 필요하면
`Atomics.wait` 를 쓴다.

## SSM Run Command — 출력 24KB 잘림

`nginx -T` 나 대량 `ls` 를 이 경로로 돌리면 잘린 줄 모르고 오판한다. 파일로 받거나
나눠서 조회할 것. 터널 실효 6.4Mbps 라 큰 파일은 직결 SSH 나 R2 릴레이.

## 관리자 페이지 — 실시간 무거운 쿼리 금지

2026-08-21 DB 포화 사태의 원인이다. 20초 폴링으로 결과 테이블(168만 행)을 매번
풀스캔 집계했고, 호출당 23~43초 × 폴링 겹침으로 DB 가 상시 포화돼 수집요청
러너와 색인 루프까지 statement timeout 으로 같이 죽었다.

- 집계는 **머티리얼라이즈드 뷰**를 읽는다 (`admin_crawl_page_candidate_counts` 등,
  `20260821000000_admin_stats_matviews.sql`). 갱신은 `scripts/refresh-admin-stats.mjs`.
- **자동 폴링을 되살리지 않는다** (`App.tsx` 에서 이미 제거됨).
- 원본 테이블 집계 쿼리를 화면에 새로 붙이지 않는다.
- 상세: `supabase/migrations/20260821000000_admin_stats_matviews.sql` 머리 주석
  (그 주석이 가리키는 `docs/ADMIN-DB-QUERY-FIX.md` 는 실재하지 않는다)

### 관리자 코드를 고쳤으면 재빌드 + 재시작

관리자는 `scripts/run-admin-server.ps1` 이 **빌드본**(`npm run preview`)으로 띄우고,
작업 스케줄러가 부팅 때 부른다. Cloudflare 터널이 `localhost:3000` 을 본다.

- 프론트(`src/`)만 고쳤으면 재빌드로 충분 — preview 가 `dist/` 를 읽는다
- **API(`vite.config.ts`·`server/`)를 고쳤으면 서버 프로세스를 재시작**해야 한다.
  라우트가 프로세스 안에 등록되므로, 재시작 전에는 새 엔드포인트가 404 다.

      powershell -NoProfile -ep Bypass -File scripts/run-admin-server.ps1 -Rebuild

## 호스트 분기 — admin / lead-dashboard

같은 서버·같은 인증(`AuthGate`)을 쓰고 화면만 가른다 (`src/main.tsx`).

- `admin.<루트>` → 기존 관리자 7탭
- `lead-dashboard.<루트>` → 배관 접수 화면(`LeadDashboard.tsx`, `/api/leads`)

새 호스트를 붙이면 **`vite.config.ts` 의 `server.allowedHosts` 와
`preview.allowedHosts` 양쪽에 추가**해야 한다. 없으면 Vite 가 "Blocked request" 로
막는다. 세션 쿠키는 `Domain` 속성이 없는 host-only 라 호스트마다 따로 로그인한다 —
**`Domain=.<루트>` 로 바꾸지 말 것.** 루트 아래 고객 사이트 서브도메인 수천 개에
관리자 세션 쿠키가 실려 나간다.
