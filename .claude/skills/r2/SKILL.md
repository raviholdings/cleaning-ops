---
name: r2
description: Cloudflare R2 자산(이미지·CSS·JS·파비콘) 업로드와 버전 관리. R2 업로드, assets 도메인, site/moving-v1 등 자산 작업 시 사용.
---

# R2 자산

- 버킷: `cleaning-assets` 하나 — 이사도 여기 쓴다 (moving-assets 분리 안 함, 운영자 확정)
- endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
- 자격: .env 의 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — **반드시 .trim()** (개행 섞이면 인증 실패)
- 필수 env: `AWS_DEFAULT_REGION=auto`, `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`
- 공개 도메인: `assets.<루트도메인>` ×10 — 모든 루트가 같은 버킷을 본다

## 절대 규칙 — immutable 캐시

업로드는 `Cache-Control: max-age=31536000, immutable` 로 나간다.
**같은 경로에 다른 내용을 덮어쓰지 마라.** 1년 캐시 때문에 옛 파일이 계속
서빙된다 (청소 v3 사건). 내용이 바뀌면 버전 폴더를 올린다:
`site/moving-v1` → `site/moving-v2` + 템플릿의 assetVersion 도 함께 변경.

## 현재 배치

- `moving/001_포장이사_01.webp` … 500장 (유형 25종 × 20장)
- `moving/compare1.webp` ~ `compare5.webp` — SERP ItemList 용 업체 사진
- `site/moving-v1/` — moving.css · moving.js (favicon.ico 는 별도 확인)
- 청소: `cleaning/` 이미지, `site/v3/` 자산

## 절차

scripts/upload-site-assets-to-r2.mjs 참고. 업로드 후 공개 URL 을 curl 로
200 확인해야 끝이다 (업로드 성공 ≠ 서빙 성공).
