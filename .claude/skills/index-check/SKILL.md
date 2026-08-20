---
name: index-check
description: 네이버 색인 확인 배치 실행 절차 — 페이스, 차단 한계, 재개 방법. 색인 조사·색인률 확인 작업 시 사용.
---

# 색인 조사

## 실행

    powershell -File ./scripts/run-index-check-batches.ps1 [-ResumeFrom N] [-StartDelayMinutes M]

- 페이스: **150개 / 45분**. 더 빠르면 차단당한다.
- 차단은 **총량 기준** — 같은 IP 에서 1,400~1,900건 지나면 403.
  배치 사이 텀을 지켜도 총량은 쌓인다. 일일 상한으로 계획할 것.
- `NAVER_INDEX_CHECK_LIMIT` 은 **누적 목표치**다 (이번 실행 건수가 아님).
  늘려 가며 재실행한다.
- 중단 후 재개는 `-ResumeFrom`.

## PowerShell 5.1 함정

- 네이티브 stderr 가 ErrorRecord 로 바뀌어 `$?` 가 false 가 된다 —
  `2>&1` 리다이렉트 금지, ErrorActionPreference 는 Continue.

## 참고

- docs/INDEX-CHECK-HANDOVER.md — 상세 핸드오버
- 결과는 관리자 페이지 색인 탭에 표시 (scripts/update-naver-index-google-sheet.mjs,
  scripts/naver-index-check-alert.mjs)
