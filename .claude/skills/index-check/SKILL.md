---
name: index-check
description: 네이버 색인 확인 배치 실행 절차 — 페이스, 차단 한계, 재개 방법. 색인 조사·색인률 확인 작업 시 사용.
---

# 색인 조사

## 실행

    powershell -NoProfile -ep Bypass -File scripts/run-index-check-batches.ps1 -BatchSize 150 -RestMinutes 45 [-Rounds N] [-ResumeFrom N] [-StartDelayMinutes M]

- 페이스: **150개 / 45분**. 더 빠르면 차단당한다.
  **스크립트 기본값(BatchSize 200 / RestMinutes 20)은 이 안전선보다 빠르다** —
  플래그를 생략하면 약 2.9배로 돌아 403 에 훨씬 빨리 닿는다. 반드시 명시할 것.
- 차단은 **총량 기준** — 같은 IP 에서 1,400~1,900건 지나면 403.
  배치 사이 텀을 지켜도 총량은 쌓인다. 일일 상한으로 계획할 것.
  (실측 사고 2건: 1,386건 → 403 / 1,892건 → 403)
- 소요를 먼저 계산해 보고한다 — 기본 `-Rounds 12` 면 회차당 텀까지 4시간 이상 돈다.
- `NAVER_INDEX_CHECK_LIMIT` 은 **누적 목표치**다 (이번 실행 건수가 아님).
  늘려 가며 재실행한다.
- `-ResumeFrom` 은 **회차 번호가 아니라 그 run-id 로 이미 끝낸 도메인 수**다.
  회차 번호(3 같은 값)를 넣으면 누적 목표가 거의 안 늘어 헛돈다.
- 그 밖: `-RunId`(기본 cleaning-ravi-index-rolling), `-Concurrency`(기본 20).

## PowerShell 5.1 함정

네이티브 stderr 가 ErrorRecord 로 바뀌어 `$?` 가 false 가 된다.
다만 이 스크립트는 **의도적으로 `2>&1` 을 쓴다** — stderr 를 합쳐야
`naver blocked` 를 셀 수 있기 때문이다. 대신 그 구간만
`$ErrorActionPreference = 'Continue'` 로 낮추고 종료 판정은 `$LASTEXITCODE` 로만 한다.
**이 조합을 "고치지" 말 것** — `2>&1` 을 지우면 차단 탐지가 없어진다.

## 규모 한계

도메인 20,000개를 IP 1개로 1회전 하면 1,700건/일 기준 약 12일이 걸린다.
전수 조사는 현실적이지 않으므로 표본 설계나 IP 증설을 먼저 운영자와 정한다.

## 참고

- docs/INDEX-CHECK-HANDOVER.md — 상세 핸드오버 (소유확인·토큰 회수 함정 포함)
- 결과는 관리자 페이지 색인 탭에 표시 (scripts/naver-index-check-alert.mjs)
- 구글시트 연동은 걷어냈다 (2026-09-01). 시트가 만들어진 적이 없고 러너마다
  꺼 두고 있었다. 현황은 관리자 페이지가 담당한다.
