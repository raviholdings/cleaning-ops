# 프로젝트 독립 구축 및 인수인계 대화 히스토리 (HANDOVER_LOG)

> **일시**: 2026-07-31
> **작업자**: Antigravity AI & 사용자 (Pair Programming)
> **대상 저장소**: `C:\Users\LD\Desktop\ravi\cleaning-ops`

---

## 📌 1. 주요 요구사항 및 작업 목적
* 기존 모노레포(`keyword_ranking`)의 레거시 데이터/코드 복잡성을 덜어내고, **독립 서버 및 독립 DB(Supabase)** 기반의 슬림화된 운영 체계 구축.
* 입주청소 정적 웹사이트(`apps/cleaning-ravi`) 배포 및 네이버 서치어드바이저 자동 수집/노출 점검 전용 저장소 독립 생성.

---

## 🛠️ 2. 진행된 핵심 세팅 & 결정 사항

### 2.1 계정 및 외부 API 정리
* **필수 포함**:
  * Supabase (PostgreSQL) `DATABASE_URL`, `DIRECT_URL`
  * Cloudflare Email, API Key, Account ID, R2 Storage Bucket
  * 네이버 Open API (`NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` - 검색 노출 점검용)
  * SGIS (통계지리정보서비스) API
  * Lead Router (`PUBLIC_LEAD_ROUTER_BASE_URL`: `https://nichebox.siwol.kr`)
* **제외 (선택 사항)**:
  * 네이버 검색광고 API (`NAVER_SEARCHAD_*`) — 단순 수집/노출 운영 단계에서는 필요 없음.

### 2.2 도메인 & Cloudflare DNS 설정 가이드
* 도메인 구매처(Spaceship)에서 네임서버를 Cloudflare 전용 네임서버로 변경.
* Cloudflare DNS 레코드에 **와일드카드 레코드(`*`) 1회 등록**:
  * 레코드 1: `A` / `@` / `서버 IP` / `Proxied 🧡`
  * 레코드 2: `A` / `*` / `서버 IP` / `Proxied 🧡`
  * *(이 설정을 통해 향후 서브도메인이 무제한 자동 연결됨)*

### 2.3 프론트엔드 기술 스택 확정
* **Astro 5.x + React** 확정 (`apps/cleaning-ravi`)
* **선정이유**: "Zero JS" 기반으로 네이버/구글 SEO에 압도적이며, 정적 HTML 배포에 최적화됨.
* Figma 내보내기 시 발생한 Windows 배제 빌드 파일(`pnpm-workspace.yaml`) 제거 및 Astro 설정(`astro.config.mjs`) 생성 완료.

---

## 📦 3. 구축 완료된 독립 저장소 구조 (`cleaning-ops`)

```text
C:\Users\LD\Desktop\ravi\cleaning-ops\
├─ package.json                    # 루트 런너 패키지 (pg, playwright)
├─ .env                            # 독립 DB 및 API Key 설정 완료
├─ .env.example                    # 템플릿 환경변수 가이드
├─ .gitignore                      # 보안/임시 파일 제외 처리
├─ README.md                       # 저장소 안내서
├─ AGENTS.md / CLAUDE.md           # AI Agent 자동 인식 가이드
├─ HANDOVER_LOG.md                 # 본 대화 히스토리 보관 문서
├─ apps/
│  └─ cleaning-ravi/               # Astro 입주청소 정적 웹 앱
├─ config/.gitkeep                 # Google 서비스 계정 JSON 자리
├─ scripts/                        # 21개 필수 의존성 스크립트 복사 완료
│  ├─ [수집요청] run-windows-naver-crawl-resume.ps1, haiip-windows-ui-control.ps1,
│  │             submit-naver-searchadvisor-crawl-requests.mjs, check-naver-crawl-pending-fast.mjs,
│  │             export-naver-searchadvisor-session.mjs, upsert-naver-searchadvisor-session.mjs,
│  │             get-naver-searchadvisor-account-session-ip.mjs, list-naver-crawl-runs.mjs,
│  │             repair-naver-crawl-stale-runs.mjs, naver-searchadvisor-crawl-alert.mjs
│  ├─ [노출점검] run-naver-index-checks.sh, check-naver-indexed-posts.mjs,
│  │             naver-site-check-proxy.mjs, list-naver-index-check-runners.mjs,
│  │             naver-index-check-alert.mjs, update-naver-index-google-sheet.mjs
│  ├─ [카탈로그] sync-naver-project-page-catalog.mjs
│  └─ lib/                         # 4개 의존 라이브러리 스크립트
├─ supabase/migrations/.gitkeep    # Clean DDL 작성용 위치
└─ logs/ reports/ tmp/              # 런너 실행 로그 및 결과 디렉토리
```

---

## 🚀 4. 향후 작업 로드맵 (Next Action Plan)

1. **의존성 설치**: `C:\Users\LD\Desktop\ravi\cleaning-ops`에서 `npm install` 실행.
2. **Clean DDL 적용**: 테이블 14개 + 뷰 6개 스키마 SQL을 독립 Supabase DB에 적용.
3. **도메인 등록 & 소유확인**: 새 도메인 10개 DB 입력 및 `naver_ownership_only.py` 소유확인 완료.
4. **정적 빌드**: `apps/cleaning-ravi`에서 `npm run build` 실행하여 독립 서버에 배포.
