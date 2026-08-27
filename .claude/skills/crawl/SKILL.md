---
name: crawl
description: 네이버 서치어드바이저 수집요청(청소·이사·배관) 실행 절차와 함정(HaiIP, 세션, dedup, 캡차, 한도). 수집요청·크롤 요청·소유확인 작업 시 사용.
---

# 수집요청 (네이버 서치어드바이저)

## 실행 — 반드시 범위 러너로 돈다

    powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 1 -To 20            # 청소
    powershell -NoProfile -ep Bypass -File scripts/run-moving-crawl-range.ps1 -From 1 -To 20     # 이사
    powershell -NoProfile -ep Bypass -File scripts/run-piping-crawl-range.ps1 -Group piping-ravi -From 201 -To 230   # 배관
    # 먼저 확인: 같은 명령에 -DryRun

`scripts/run-windows-naver-crawl-resume.ps1` 은 range 러너가 내부에서 호출하는
**본체다 — 직접 부르지 말 것.** `.env` 를 읽지 않아서 러너 이름이 `$env:COMPUTERNAME`
으로 떨어지고, 담당 계정 선별(`NAVER_CRAWL_INCLUDE_ACCOUNTS`)이 비어 **남의 기계
계정까지 돈다.** 이전 실행이 남긴 `NAVER_CRAWL_INCLUDE_GROUPS`/`EXCLUDE_ACCOUNTS`
도 그대로 살아 엉뚱한 필터가 걸린다 (range 러너는 매번 초기화한다).

- 제출 본체: `scripts/submit-naver-searchadvisor-crawl-requests.mjs`
- 배관 `-Group` 은 `piping-ravi`(신규 1만) / `piping-ravi-shared`(청소 도메인 차용 1만)

기계 배정 (운영자 확정 2026-08-25):

| 기계 | 청소·이사 | 배관 신규 |
|---|---|---|
| PC  | 1~20 | (미사용) |
| VM1 | 21~50 · 102 | 201~230 (204 정지 → **106**) |
| VM2 | 51~80 · 104 · 105 | 231~265 |
| VM3 | 81~95 · 97~101 | 266~300 |

**정지 계정: 34 · 59 · 60 · 96 · 103 · 204** — 범위 안에 들어 있어도 상태로 걸러진다.
이관 체인: 34→102 / 59→104 / 60→103→(103도 정지)→105 / 96→101 / **204→106**(2026-08-26).
이관은 `scripts/reassign-account-domains.mjs --from <옛id> --to <새id> --block-source`.
배관 신규분(201~300)도 같은 방식으로 정지 시 100번대 여유 순번으로 옮긴다.
배관 신규 100계정은 `config/piping.json` 의 배정을 따른다.
**배정은 임의로 바꾸지 않는다** — 계정↔IP↔세션이 기계에 묶여 있어 남의 범위를
돌리면 HaiIP 가 그 IP 를 못 잡고 계정마다 실패한다.
같은 기계에서 계정 간 병렬 불가 — HaiIP 가 기계의 IP 를 통째로 바꾸기 때문.

## 한도

- **사이트당 하루 50건**, 00시(KST) 리셋. 계정당 사이트 100개.
- 실측 최대 처리량: 4기계 기준 **하루 약 48만 건**. 계정을 늘려도 기계가
  병목이라 처리량은 거의 그대로다 — 늘리려면 기계를 늘려야 한다.
- 오늘 한도 소진 시 동작은 `NAVER_CRAWL_QUOTA_ACTION` (기본 `defer-host`).

## 함정

- **`-NoHaiIp` 금지.** 러너마다 이 스위치가 있지만 쓰면 그 기계의 계정 전부가
  **실제 공인 IP 하나로** 제출한다. 코드가 `MaxAccountsPerHaiIpPublicIp = 1` 로
  막아둔 조건 — 네이버가 계정을 묶어 보는 조건 — 을 정면으로 위반한다. 결과는
  계정 정지다. HaiIP 때문에 불편해도 이 플래그로 우회하지 않는다.
- **HaiIP**: 관리자 권한 + AttachThreadInput + curl 필요
  (docs/HAIIP-VM-SCALEOUT-PROMPT.md). HaiIP 가 IP 를 바꾸면 Claude API
  연결도 끊긴다 — "Connection error" 배너는 러너 고장이 아니다. 러너는 계속 돈다.
- **배포와 동시 실행 금지** — 배포는 직결 SSH 라 IP 가 바뀌면 끊긴다.
- **세션**: DB 에 저장, 실행 시 export → 임시 프로필 → 삭제 (기계에 안 묶임).
  반복 재로그인은 계정 잠금을 유발한다. 수집요청 자체가 세션을 갱신하므로
  살아 있는 세션은 건드리지 않는다. 확인: scripts/check-naver-sessions-bulk.mjs
- **dedup**: `alreadyDone.has(url)` 문자열 일치. 한글 URL 은 인코딩 형태
  (원문 vs percent-encoded)를 한 가지로 통일 — 어긋나면 같은 페이지에
  할당량을 두 번 태운다. 첫 제출에서 네이버 콘솔이 받는 형태를 실측해 맞춘다.
  (이사·배관은 사이트맵 모드라 이 문제를 구조적으로 피한다.)
- **캡차 오답**: 네이버가 아무 신호도 안 준다. 경과 시간으로만 판별한다.
- **낡은 폴백 기본값**: 여러 스크립트의 `--project` 기본값이 아직
  `watermelon-piping` 이다 (`check-naver-crawl-pending-fast.mjs`,
  `naver-searchadvisor-crawl-alert.mjs`, `naver-searchadvisor-crawl-db.mjs` 등).
  플래그 없이 돌리면 없는 프로젝트를 조회해 **조용히 0건**을 보고한다.
- 정지 계정 이관: `scripts/migrate-blocked-account.ps1` — 도메인 이관만으로는
  안 된다. 이관 → **새 계정으로 사이트 재등록(토큰 재발급)** → 재배포 →
  소유확인 → 수집요청 5단계를 한 번에 처리한다. 2번을 건너뛰면 소유확인이
  전부 실패한다 (서치어드바이저에서 사이트는 등록한 계정의 것이라, DB 소유자만
  바꾸고 옛 토큰을 두면 새 계정 세션에서 남의 사이트가 된다).

## 소유확인

토큰이 있다고 등록된 게 아니다 — 실제 상태는
`scripts/verify-naver-searchadvisor-sites.mjs` 로 확인한다.

- `NAVER_REGISTER_TOKEN_RECOVERY` 를 평소에 켜두지 말 것 — 토큰만 96개 받고
  등록 0건으로 끝난 적이 있다.
- 토큰 회수는 **반드시 `--limit` 과 함께.** 없이 돌려 이미 verified 인 90건이
  registered 로 되돌아간 사고가 있다.
- 순서: 토큰 회수 → 재배포 → 소유확인 → 수집요청. 계정당 사이트 100개 상한.
- 신규 도메인은 **루트가 404 면 소유확인이 통째로 막힌다** — 네이버가 등록된
  주소(=루트)에서 메타태그를 찾기 때문. 배관 신규는
  `deploy-piping-sites.mjs --group piping-ravi --index-only` 로 루트를 채운다.
- 상세 함정: docs/INDEX-CHECK-HANDOVER.md

## 재수집 회차 (-DoneSince, 2026-08-23 도입)

노출 초기화 등으로 **전량을 처음부터 다시 제출**할 때:

    powershell -File scripts/run-crawl-range.ps1 -From 1 -To 20 -DoneSince 2026-08-23T00:00:00+09:00

- 기준선 이전의 제출 기록을 "없던 것"으로 친다 — 후보 선정(catalog)·dedup·
  fast-skip 세 곳 모두 (env NAVER_CRAWL_DONE_SINCE).
- 기준선 이후 기록은 정상 dedup — 회차 안에서 이중 제출 없다. 오늘 한도
  소진(quota-stop) 스킵도 그대로 산다.
- 다음 회차는 날짜만 올려서 다시 주면 된다. 이사·배관 러너도 같은 파라미터.
- check-crawl-remaining 은 기준선을 모른다 — 재수집 진행률은 관리자 카드의
  오늘 제출 수와 기준선 이후 누적으로 본다.
