---
name: crawl
description: 네이버 서치어드바이저 수집요청 실행 절차와 함정(HaiIP, 세션, dedup, 캡차). 수집요청·크롤 요청·소유확인 작업 시 사용.
---

# 수집요청 (네이버 서치어드바이저)

## 실행

    powershell -File ./scripts/run-windows-naver-crawl-resume.ps1
    # 범위 실행: scripts/run-crawl-range.ps1
    # 제출 본체: scripts/submit-naver-searchadvisor-crawl-requests.mjs

기계 배정: PC 1~20 / VM1 21-50·102 / VM2 51-80·103·104 / VM3 81-95·97-101
같은 기계에서 계정 간 병렬 불가 — HaiIP 가 기계의 IP 를 통째로 바꾸기 때문.

## 함정

- **HaiIP**: 관리자 권한 + AttachThreadInput + curl 필요
  (docs/HAIIP-VM-SCALEOUT-PROMPT.md). HaiIP 가 IP 를 바꾸면 Claude API
  연결도 끊긴다 — "Connection error" 배너는 러너 고장이 아니다. 러너는 계속 돈다.
- **세션**: DB 에 저장, 실행 시 export → 임시 프로필 → 삭제 (기계에 안 묶임).
  반복 재로그인은 계정 잠금을 유발한다. 수집요청 자체가 세션을 갱신하므로
  살아 있는 세션은 건드리지 않는다. 확인: scripts/check-naver-sessions-bulk.mjs
- **dedup**: `alreadyDone.has(url)` 문자열 일치. 한글 URL 은 인코딩 형태
  (원문 vs percent-encoded)를 한 가지로 통일 — 어긋나면 같은 페이지에
  할당량을 두 번 태운다. 첫 제출에서 네이버 콘솔이 받는 형태를 실측해 맞춘다.
- **캡차 오답**: 네이버가 아무 신호도 안 준다. 경과 시간으로만 판별한다.
- **소유확인**: 토큰이 있다고 등록된 게 아니다 — 실제 상태는
  scripts/verify-naver-searchadvisor-sites.mjs 로 확인한다.
- 정지 계정 이관: scripts/migrate-blocked-account.ps1

## 재수집 회차 (-DoneSince, 2026-08-23 도입)

노출 초기화 등으로 **전량을 처음부터 다시 제출**할 때:

    powershell -File scripts/run-crawl-range.ps1 -From 1 -To 20 -DoneSince 2026-08-23T00:00:00+09:00

- 기준선 이전의 제출 기록을 "없던 것"으로 친다 — 후보 선정(catalog)·dedup·
  fast-skip 세 곳 모두 (env NAVER_CRAWL_DONE_SINCE).
- 기준선 이후 기록은 정상 dedup — 회차 안에서 이중 제출 없다. 오늘 한도
  소진(quota-stop) 스킵도 그대로 산다.
- 다음 회차는 날짜만 올려서 다시 주면 된다. 이사(run-moving-crawl-range.ps1)도
  같은 파라미터.
- check-crawl-remaining 은 기준선을 모른다 — 재수집 진행률은 관리자 카드의
  오늘 제출 수와 기준선 이후 누적으로 본다.
