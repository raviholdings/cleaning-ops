# HaiIP VM 병렬 확장 — 다른 세션에 붙여넣을 프롬프트

아래 `---` 사이를 그대로 복사해서 새 세션에 붙여넣으면 됩니다.

---

## 무엇을 하나

`C:\Users\LD\Desktop\ravi\cleaning-ops` 프로젝트의 네이버 자동화를 **HaiIP 가상 서버 여러 대로 병렬화**하는 작업입니다. 지금은 PC 한 대에서 순차로만 돌아가서 처리량이 막혀 있습니다.

목표는 **하루 수집요청 5만 건 → 50만 건**입니다.

## 먼저 읽을 것

1. `AGENTS.md` — 전체 아키텍처, 환경변수, 스크립트 매핑
2. `CLAUDE.md` — 운영 규칙
3. `scripts/haiip-windows-ui-control.ps1` — HaiIP 제어의 전부. **이 작업의 핵심 파일**
4. `scripts/run-windows-naver-crawl-resume.ps1` — 수집요청 러너 (HaiIP 를 호출하는 쪽)
5. `scripts/run-batch2-full-pipeline.ps1` — 현재 전체 파이프라인

## 지금 구조와 병목

파이프라인은 계정마다 이렇게 돕니다.

```
계정 IP 로 HaiIP 전환 → 세션 캡처 → 사이트 등록 → 소유확인 → 수집요청 → 다음 계정
```

**병목은 성능이 아니라 IP 입니다.** HaiIP 회선 하나가 공인 IP 를 한 번에 하나만 잡습니다.
코드가 이를 강제합니다:

- `run-windows-naver-crawl-resume.ps1` 의 `$MaxAccountsPerHaiIpPublicIp = 1`
- `Get-NaverSessionIpConflictAccounts` — 한 IP 를 두 계정이 쓰면 중단
- 환경변수 `HAIIP_MAX_ACCOUNTS_PER_PUBLIC_IP`

같은 IP 를 두 계정이 쓰면 네이버가 계정을 묶어서 볼 위험이 있어 일부러 막아둔 것입니다.
**따라서 실제 병렬 수 = 확보한 HaiIP 회선 수**입니다. VM 대수가 아닙니다.

## 실측 자원 사용량 (2026-08-06 측정)

VM 사양을 정하는 근거입니다. 소유확인·수집요청만 돌릴 때:

```
node 프로세스            111 MB
Playwright chrome 8개    647 MB
─────────────────────────────
합계                     759 MB   ← 1GB 미만
```

디스크: 저장소 약 2GB + node_modules 약 170MB → **5GB 면 충분**

검토 중인 사양 **4코어 / 4GB / 50GB / Windows 10 Pro** 는 넉넉합니다.
CPU 는 캡차 응답·네트워크 대기가 대부분이라 연산 부하가 낮습니다.

**단, 빌드·배포는 이 VM 에서 돌리면 안 됩니다.** 2,000 사이트 빌드에 Node 힙 16GB 를 씁니다
(`scripts/build-and-deploy-sites.mjs` 의 `DEPLOY_HEAP_MB`). 배포는 메인 PC 에 남깁니다.

### 처리량 계산 근거 (실측)

```
소유확인   40초/도메인  → 계정 100개 = 67분
수집요청   440건/분     → 5,000건 = 11분
IP 전환    약 1분

초기 구축(소유확인 포함)  계정당 79분  → 24시간 18계정
정상 운영(수집요청만)     계정당 12분  → 24시간 120계정
```

소유확인은 **1회성**입니다. 초기 구축만 넘기면 한 대가 훨씬 많은 계정을 감당합니다.

## ⚠️ 가장 큰 리스크 — 먼저 검증할 것

**HaiIP 제어가 GUI 조작 방식입니다.** `haiip-windows-ui-control.ps1` 이 Win32 API 로
HaiIP 클라이언트 창을 직접 찾아 클릭합니다:

```
user32.dll: EnumWindows, FindWindow, SetForegroundWindow, ShowWindow, BringWindowToTop
기본 클릭 방식: BMClick  (-ChangeClickMethod Input|WMCommand|BMClick)
실행 파일: C:\Program Files (x86)\Haionnet\HaiipClientMulti\HaiipClientMulti.exe
```

즉 **살아 있는 데스크톱 세션이 필요합니다.** 그래서 반드시 먼저 확인해야 합니다:

1. **RDP 창을 닫아도 자동화가 계속 도는가?**
   RDP 연결을 끊으면 세션이 잠겨 GUI 조작이 실패할 수 있습니다.
   자동 로그온 + 콘솔 세션 유지 설정이 필요할 수 있습니다.
   (참고 수단: `tscon` 으로 콘솔 리다이렉트, 화면보호기·잠금 비활성화)
2. **관리자 권한으로 실행되는가?** HaiIP 창 조작에 필요합니다.
3. **VM 마다 독립된 공인 IP 가 나오는가?**
   여러 VM 이 같은 회선을 공유하면 병렬이 아예 성립하지 않습니다.
   각 VM 에서 `https://api.ipify.org?format=json` 을 찍어 서로 다른지 확인하세요.

**이 세 가지가 확인되기 전에 VM 을 여러 대 구매하지 마세요. 2대로 먼저 검증하십시오.**

## HaiIP 스크립트 사용법

```powershell
# 현재 공인 IP 확인
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/haiip-windows-ui-control.ps1 -Command status

# IP 변경 (바뀔 때까지 보장)
... -Command change -RequireChanged

# 특정 IP 를 노려서 잡기
... -Command change -PreferredIp 124.198.89.236 -CheckPreferredResult
```

주요 파라미터: `-WaitSeconds`, `-Retries`, `-WindowWaitSeconds`, `-ChangeClickMethod`,
`-HaiIpExePath`, `-LogPath`(기본 `reports/haiip-windows-ip-changes.jsonl`)

관련 환경변수: `HAIIP_CHANGE_COMMAND`, `HAIIP_MAX_ACCOUNTS_PER_PUBLIC_IP`, `HAIIP_SESSION_IP_ATTEMPTS`

## VM 을 늘릴 때 반드시 손봐야 하는 것

**러너 이름 매핑.** `run-windows-naver-crawl-resume.ps1` 이 PC 이름으로 담당 계정을 정합니다.

- `COMPUTERNAME` → 러너 이름 매핑이 하드코딩돼 있습니다 (`siwol-win`, `siwol-win2` 등)
- 현재 메인 PC(`DESKTOP-SI088GJ`)는 매핑에 없어서 `.env` 의 `NAVER_CRAWL_RUNNER_PC=siwol-win` 으로 우회 중입니다
- **VM 마다 다른 러너 이름을 주고, DB 뷰 `naver_project_group_crawl_accounts` 에서
  계정이 러너별로 갈리도록** 해야 두 대가 같은 계정을 잡지 않습니다
- 관련 스크립트: `scripts/list-naver-crawl-runs.mjs`

**동시 실행 방지.** 파이프라인이 `tmp\verify-crawl-chain.lock` 파일 락을 씁니다.
VM 별로 독립이라 문제없지만, **DB 는 공유**이므로 계정 배정이 겹치지 않아야 합니다.

## 작업 순서 제안

1. VM 2대 준비 → 위 세 가지 리스크 검증 (**여기서 막히면 그 다음은 무의미**)
2. 저장소 배치 + `.env` 구성 (`DATABASE_URL`, `ANTI_CAPTCHA_API_KEY` 필요)
3. 러너 이름 분리 + 계정 배정 방식 확정 → **운영자 확인**
4. VM 1대로 계정 1개 완주 테스트 (세션 캡처 → 등록 → 소유확인 → 수집요청)
5. 2대 동시 실행하며 IP 충돌·계정 중복이 없는지 확인
6. 문제없으면 대수 확장

## 진행 방식

`CLAUDE.md` 규칙에 따라 단계마다 확인받으세요. 특히:

- **DB 쓰기 전** 무엇이 몇 건인지 먼저 보고
- **계정 배정 규칙**은 임의로 정하지 말 것
- 임의로 정한 값(타임아웃, 재시도 횟수, 러너 이름 등)은 **목록으로 보고**

## 건드리면 안 되는 것

메인 PC 에서 **파이프라인이 계속 돌고 있습니다.** 같은 DB 를 씁니다.

- `scripts/` 아래 기존 파일을 고치기 전에 반드시 운영자 확인
- 특히 `verify-naver-searchadvisor-sites.mjs`, `submit-naver-searchadvisor-crawl-requests.mjs`,
  `run-windows-naver-crawl-resume.ps1`, `build-and-deploy-sites.mjs` 는 최근 수정·복구된 파일입니다
- `naver_project_domains` 삭제·초기화 금지

**2026-08-06 에 `git add .` 직후 `git reset --hard` 로 `scripts/` 파일 내용이 서로 뒤바뀌는
사고가 있었습니다.** `.git/lost-found` 에서 복구해 `5a20ff5` 로 커밋해 둔 상태입니다.
작업 전 `git status` 로 깨끗한지 확인하고, 변경은 반드시 커밋으로 남기세요.

---

## 참고: 현재 상태 (2026-08-06)

- 계정 1~10: 소유확인 1,000/1,000 완료, 수집요청 56,489/100,000
- 계정 11~20: 사이트 등록·토큰 발급 진행 중, 소유확인 대기
- 계정은 DB 에 500개 등록돼 있고 비밀번호도 전부 저장돼 있음 (`password_plain`)
- 세션은 **하루도 못 갑니다.** 15시간 지난 세션이 로그인 화면을 뱉었습니다.
  단계 진입 직전마다 `capture-naver-session.mjs --force` 로 새로 잡아야 합니다
- 서브도메인 DNS 는 **와일드카드**(`*.도메인.com`)라 서브도메인 추가 시 DNS 작업 불필요
- 계정당 사이트 100개가 네이버 상한
