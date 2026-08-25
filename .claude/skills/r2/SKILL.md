---
name: r2
description: Cloudflare R2 자산(이미지·CSS·JS·파비콘) 업로드와 immutable 버전 관리. R2 업로드, assets 도메인, site/v4·moving-v3·piping-v2 등 자산 작업 시 사용.
---

# R2 자산

- 버킷: `cleaning-assets` 하나 — 이사·배관도 여기 쓴다 (분리 안 함, 운영자 확정)
- 로그 버킷: `ravi-ops-logs` (프라이빗, 2026-08-21 생성) — 수집요청 응답 원문
  jsonl.gz 가 `crawl-raw/{날짜}.{기계}.jsonl.gz` 로 쌓인다. **cleaning-assets 는
  assets.* 로 공개 서빙되므로 로그·내부 파일을 절대 거기 두지 말 것.**
  업로드는 scripts/upload-crawl-raw-logs.mjs (VM 은 aws CLI 가 없어
  scripts/lib/r2-client.mjs 의 자체 SigV4 를 쓴다), 다운로드는
  scripts/fetch-crawl-raw-logs.mjs.
- endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
- 자격: .env 의 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — **반드시 .trim()** (개행 섞이면 인증 실패)
- 필수 env: `AWS_DEFAULT_REGION=auto`, `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`,
  `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`
- 공개 도메인: `assets.<루트도메인>` — 모든 루트가 같은 버킷을 본다

## 엣지 캐시 (2026-08-21 적용)

assets.* 존 전부 Cloudflare Cache Rule 로 **엣지 TTL 1년 강제**가 걸려
있다 (룰 이름 assets-immutable-cache). R2 객체에 Cache-Control 메타가 없어도
엣지에 1년 저장된다 — 즉 **대시보드 업로드도 같은 경로 덮어쓰기 금지**.
캐러셀(SERP) 이미지 수집 안정화 목적: 적용 전 장당 0.6~1.2초(DYNAMIC) →
적용 후 한국망 0.07~0.2초(HIT).

## 절대 규칙 — immutable 캐시

업로드는 `Cache-Control: max-age=31536000, immutable` 로 나간다.
**같은 경로에 다른 내용을 덮어쓰지 마라.** 1년 캐시 때문에 옛 파일이 계속
서빙된다 (청소 v3 사건). 내용이 바뀌면 **버전 폴더 번호를 올리고**, 템플릿이
참조하는 assetVersion 도 함께 올린다. 되돌릴 방법은 없다.

**버전 숫자를 이 문서에서 읽지 말 것.** 현재 라이브 버전의 진실은 코드에 있다:

| 업종 | 진실의 출처 | 2026-08-25 기준 |
|---|---|---|
| 청소 | `scripts/lib/merged-page-data.mjs` 의 `ASSET_VERSION` 기본값 | `site/v4/` |
| 이사 | `scripts/lib/moving-page-data.mjs` 의 `ASSET_VERSION` 기본값 | `site/moving-v3/` |
| 배관 | `config/piping.json` 의 `assetVersion` | `site/piping-v2/` |

## 업로드 — `--version` 을 반드시 명시한다

    node scripts/upload-site-assets-to-r2.mjs   --version v4        [--dry-run]   # 청소 styles.css · app.js
    node scripts/upload-piping-assets-to-r2.mjs --version piping-v2 [--dry-run]   # 배관 piping.css · piping.js · favicon.ico

- **두 스크립트 모두 `--version` 이 없으면 throw 한다** (2026-08-25 배관도 강제로 통일).
  틀린 버전에 올리면 배포된 페이지가 보는 경로와 어긋나 **CSS·JS 가 전부 404** 가
  되고, immutable 이라 복구는 새 버전 + 전량 재굽기뿐이다.
- 배관 스크립트는 `config/piping.json` 의 assetVersion 을 같이 찍는다 — 실행 첫 줄에
  `⚠️ 불일치` 가 뜨면 멈추고 확인할 것.
- 업로드 후 공개 URL 을 curl 로 200 확인해야 끝이다 (업로드 성공 ≠ 서빙 성공).

## 현재 배치

- `cleaning/` 이미지, `site/v4/` — 청소 (2026-08-22 라이브, 비콘 포함).
  v1(비콘 없음)·v3 은 옛 버전.
- `moving/001_포장이사_01.webp` … 500장 (유형 25종 × 20장)
- `moving/compare1.webp` ~ `compare5.webp` — SERP ItemList 용 업체 사진
- `site/moving-v3/` — 이사 자산. **운영자가 직접 업로드한다** (전용 업로드
  스크립트 없음. 청소는 upload-site-assets-to-r2.mjs, 배관은 upload-piping-assets-to-r2.mjs)
- `site/piping-v2/` — piping.css · piping.js · favicon.ico
- 배관 캐러셀 이미지는 R2 가 아니라 오리진 공유 경로에 있다:
  `/srv/group-page-origin/shared/img/piping` (nginx `location /img/`)
