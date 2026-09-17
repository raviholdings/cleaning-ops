# VM 구축 — piping-xyz 운영 3대

계정 129개(기존 29 + 신규 100)를 VM 3대에 **35 / 35 / 30** 으로 나눠 돌린다.
각 VM 이 담당 계정의 캡처 · 사이트등록 · 소유확인 · 수집요청을 맡는다.
VM 마다 Hai-IP 를 따로 붙인다.

---

## 1. 설치할 것

| | 버전 | 왜 |
|---|---|---|
| **Windows** | 10/11 또는 Server 2019+ | Hai-IP 클라이언트와 크롬 자동화가 윈도우용이다 |
| **Node.js** | 20 LTS 이상 (개발 PC 는 24) | `node --version` 으로 확인 |
| **Git** | 최신 | `git pull` 배포 + Git Bash 가 셸 래퍼에 필요 |
| **Google Chrome** | 최신 | Playwright 가 `channel: 'chrome'` 으로 **실제 크롬**을 쓴다. Chromium 아님 |
| **Hai-IP 클라이언트** | — | IP 전환. 스크립트가 창을 UI 조작하므로 **로그인해서 창을 띄워둬야 한다** |

PostgreSQL 은 **설치하지 않는다.** VM 은 공유 DB(Supabase)에 접속만 한다.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Google.Chrome
# Hai-IP 는 공급자 설치본으로
```

### 저장소 받기

```powershell
git clone https://github.com/raviholdings/cleaning-ops.git C:\ops
cd C:\ops
npm install
npx playwright install-deps    # 윈도우는 보통 불필요
```

> 비공개 저장소다. VM 마다 **읽기 전용 배포 키**나 PAT 를 쓴다. 개인 계정 비밀번호를 넣지 말 것.

---

## 2. `.env` 에 넣을 것

`C:\ops\.env` 로 만든다. **git 에 올라가지 않는다**(`.gitignore` 2번 줄).

```ini
# ── DB (공유) ─────────────────────────────────────────────
# VM 은 집 PC 의 로컬 PostgreSQL 에 못 닿는다. 공유 DB 를 쓴다.
DATABASE_URL=postgresql://<user>:<pw>@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres
DIRECT_URL=postgresql://<user>:<pw>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres

# ── Vault (계정 비밀번호·세션 보관) ────────────────────────
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role 키>

# ── 캡차 ──────────────────────────────────────────────────
# 소유확인 화면의 보안문자를 자동으로 푼다. 없으면 소유확인이 사람 손을 탄다.
ANTI_CAPTCHA_API_KEY=<키>

# ── 알림 ──────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<토큰>
TELEGRAM_CHAT_ID=<챗 ID>

# ── 이 VM 의 정체 ─────────────────────────────────────────
# VM 마다 다르게! 로그와 DB 기록에 어느 기계가 한 일인지 남는다.
NAVER_CRAWL_MACHINE=vm1            # vm1 / vm2 / vm3
NAVER_CRAWL_RUNNER_PC=vm1

# ── 수집요청 기본값 ───────────────────────────────────────
NAVER_CRAWL_QUEUE_SOURCE=db
NAVER_CRAWL_TARGET_PROJECT=piping-xyz
NAVER_CRAWL_DB_URL_SOURCE=catalog
NAVER_CRAWL_CATALOG_PROJECTS=piping-xyz   # 기본값에 piping-xyz 가 없어 반드시 지정
NAVER_CRAWL_CATALOG_ONLY_PENDING=1
NAVER_CRAWL_CONCURRENCY=1                 # IP 가 계정마다 달라 병렬 불가
NAVER_CRAWL_BETWEEN_DELAY_MS=300          # 기본 1000ms 는 0.82건/초로 느리다
NAVER_CRAWL_BATCH_DELAY_MS=5000
NAVER_CRAWL_HEADLESS=1
NAVER_CRAWL_AUTO_LOGIN=0                  # 재로그인 금지. 계정이 죽는 주원인이다
NAVER_CRAWL_WAIT_FOR_LOGIN=0
NAVER_CRAWL_PAUSE_WINDOWS=0
```

### 값 받아오는 곳

| 항목 | 어디서 |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Supabase 대시보드 → Settings → Database |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (**공개 금지**) |
| `ANTI_CAPTCHA_API_KEY` | anti-captcha.com 계정 |
| `TELEGRAM_*` | 기존 봇 그대로 |

---

## 3. 계정을 VM 에 고정하기

VM 3대가 같은 계정을 잡으면 Hai-IP 로 서로 IP 를 뺏어 **보호조치를 부른다.**
담당을 DB 에 박아두고 각 VM 이 자기 것만 집는다.

```sql
-- 한 번만
alter table naver_searchadvisor_accounts
  add column if not exists runner_pc text;

-- 예: 35 / 35 / 30
update naver_searchadvisor_accounts set runner_pc='vm1' where account_order between 1 and 35;
update naver_searchadvisor_accounts set runner_pc='vm2' where account_order between 36 and 70;
update naver_searchadvisor_accounts set runner_pc='vm3' where account_order between 71 and 129;
```

각 VM 은 `runner_pc = <자기 이름>` 인 계정만 대상으로 돌린다.

---

## 4. 실행 순서 (VM 한 대 기준)

```powershell
# 1) 계정 세션 캡처 — 사람이 로그인. 창을 먼저 닫지 말 것
node scripts/capture-naver-session.mjs --account <아이디> --no-auto-click --keep-open --login-via-searchadvisor
#    창에서 할 일: 로그인만. 설정은 건드리지 않는다.
#    (IP보안 끄기를 캡처 직후에 했더니 22개 중 19개가 보호조치를 맞았다 — 2026-09-16)

# 2) 사이트 등록 (계정당 100개)
node scripts/register-naver-searchadvisor-sites.mjs --account <아이디> --profile auto --group-key piping-xyz

# 3) 메타태그 배포 — ★ 집 PC 에서. 이걸 빼면 소유확인이 전건 실패한다
#    (등록이 다 끝난 뒤에 돌릴 것. 돌리는 중에 하면 그 뒤 등록분이 빠진다)
node scripts/export-piping-xyz-naver-meta.mjs

# 4) 소유확인
node scripts/verify-naver-searchadvisor-sites.mjs --account <아이디> --profile auto --group-key piping-xyz --delay-ms 4000

# 5) 수집요청 (사이트당 하루 50건)
node scripts/submit-naver-searchadvisor-crawl-requests.mjs
```

### 묶어서 돌리기

계정 하나씩 손으로 치는 대신:

```powershell
# 내 몫 전부 (runner_pc 로 자동 선택)
node scripts/capture-batch.mjs           # 캡처
node scripts/run-batch.mjs register      # 등록
node scripts/run-batch.mjs verify        # 소유확인

# 보호조치 풀고 온 계정 — 재캡처부터 등록까지 한 번에
node scripts/recapture-and-register.mjs <아이디> [<아이디> ...]
node scripts/recapture-and-register.mjs <아이디> --allow-new-ip   # 배정 IP 가 풀에서 사라졌을 때
```

`recapture-and-register` 는 캡처를 전부 끝낸 뒤 등록으로 넘어간다.
캡처는 사람이 붙어야 하고 등록은 계정당 몇 분씩 걸려서, 섞어 돌리면
사람이 등록 끝나기를 기다리며 앉아 있게 된다.

세션이 살아있는지 먼저 보고 싶으면 (**로그인을 시도하지 않는다**):

```powershell
node scripts/check-naver-sessions-bulk.mjs --account <아이디>
```

---

## 5. 지켜야 할 것

- **재로그인 금지.** 저장된 세션으로 안 열리면 그 계정은 죽은 것이다. 다시 로그인하면 더 잠긴다.
- **캡처 직후 계정 설정을 건드리지 말 것.** 위 사고 기록 참조.
- **크롬 프로필을 지우지 말 것.** `tmp/naver-login/<계정>-profile` 이 "같은 기기"를 만든다.
  이게 있으면 다음 실행이 로그인 화면을 아예 안 거친다.
- **수집요청 전에 IP 를 맞출 것.** 수집요청 스크립트는 Hai-IP 를 스스로 바꾸지 않는다.
  `check-naver-sessions-bulk` 가 IP 전환 + 생존확인을 같이 해주므로 앞에 붙이면 된다.
- 호스트명에 **`fast`** 가 들어가면 Hai-IP 가 막는다(SNI 차단으로 추정). 신규 생성기는 이미 제외한다.

---

## 6. 렌더 서버는 VM 에 없다

랜딩 페이지는 집 PC 의 `hub-render-server.mjs`(127.0.0.1:3800) + Apache 가 서비스한다.
VM 은 네이버에 요청만 보내므로 렌더 서버가 필요 없다.
다만 **소유확인은 집 PC 의 서버가 살아 있어야** 통과한다 — 메타태그를 그 서버가 찍는다.
