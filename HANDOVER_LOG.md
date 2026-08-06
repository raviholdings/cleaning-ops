# 진행 상황 / 인수인계 — 2026-08-04

이 문서는 다음 작업자(사람 또는 AI)가 바로 이어받을 수 있도록 쓴 것이다.
**「⚠️ 함정」 절을 먼저 읽을 것.** 대부분 실제로 한 번씩 밟은 것들이다.

---

## 1. 지금까지 완료된 것

| 단계 | 상태 |
|---|---|
| EC2 오리진 + nginx 와일드카드 + Cloudflare Origin 인증서 | 완료 |
| 10개 루트 도메인 와일드카드 DNS → 오리진 도달 | 완료 |
| DB 스키마 (14테이블 6뷰) | 완료 |
| 위치 데이터 72,938건 | 완료 |
| 키워드 73건 (메인 18 + 서브 55) | 완료 |
| 계정 500건 시딩 / 그중 10건 세션 확보 | 완료 |
| 서브도메인 1,000건 생성·배정 | 완료 |
| 페이지 카탈로그 100,000건 | 완료 |
| 1,000개 사이트 빌드·배포 (메타태그 포함) | 완료 |
| 서치어드바이저 사이트 등록 1,000건 | 완료 |
| 인증키(메타태그) 수집 1,000건 | 완료 |
| **계정1 소유확인 100건** | 완료 (운영자가 수동으로) |
| **계정1 수집요청 1차분** | 진행 중 → 아래 참조 |

---

## 2. DB 현재 상태

```
naver_page_locations              72,938
naver_page_keywords                   73
naver_project_pages              100,000
naver_searchadvisor_accounts         500  (세션 보유 10)
naver_project_domains              1,000
  ├─ verified                        100  ← 계정1
  └─ registered                      900  ← 계정2~10, 소유확인 대기
naver_crawl_request_target_domains   100  (= verified 만 잡힘)
```

### 수집요청 결과 (계정1) — 1일차 완료

```
실행         02:32 ~ 04:43 (2시간 11분)  status=succeeded
submitted    4,994
quota-stop     100   ← 정상. 100개 사이트 전부 하루 한도(50건) 도달
unknown          8   ← API 500 → UI 폴백, 확인 타임아웃 (0.16%)
blocked(601)     0   ← 자동화 감지 없음
```

사이트 100개 중 98개가 정확히 50건, 2개가 49건(unknown 포함하면 50).
큐 커서는 `next=10000/10000` 이지만 실제 제출은 4,994건이다.
나머지는 quota 로 유예된 것이므로 **내일 자정 이후 같은 명령으로 이어서 돌리면 된다.**

### 계정별 배정 (변하지 않음)

```
계정 1  lguxp4nlw          100개 사이트   verified
계정 2  noiuhejawrjjyso4n  100개 사이트   registered
계정 3  66cu93e1o          100개
계정 4  nrxssn6875893      100개
계정 5  es4ncf1zbq3la6wi   100개
계정 6  txxwli74           100개
계정 7  fbg6qgbmh          100개
계정 8  rnjsihy3140202     100개
계정 9  mdnfjwpton55       100개
계정 10 wnxisi8ma          100개
```

각 계정은 10개 루트 도메인에 10개씩 고르게 분산되어 있다 (라운드로빈).

---

## 3. 네이버 플랫폼 제약 (실측으로 확인)

```
계정당 사이트     100개  ← api-board/list 응답의 "meta":{"max":100}
사이트당 수집요청  50건/일  ← 자정(KST) 리셋
계정당            100 × 50 = 5,000건/일
```

`acorn-shore.neverfoul.com` 이 테스트 5건 + 본실행 45건 = 정확히 50에서 멈춘 것이 근거.

**소유확인에는 캡차가 있고 수집요청에는 없다.** 수집요청은 할당량으로만 통제된다.

---

## 4. ⚠️ 함정 (전부 실제로 밟은 것)

### 4.1 `post_url_pattern` 을 반드시 넣어야 한다
없으면 `buildPostUrl()` 이 `/1/` 형태로 URL 을 만든다. 우리 정적 빌드는 `/1.html` 이라 전부 404 가 된다.
```
naver_project_domains.post_url_pattern = '/:postId.html'
```
현재 1,000건 전부 설정돼 있다. 새 도메인을 추가하면 반드시 같이 넣을 것.

### 4.2 크롤 스크립트는 별도 브라우저 프로필을 쓴다
`.naver-searchadvisor-profile-ju` 를 쓰는데 여기는 로그인이 안 돼 있다.
Vault 세션을 파일로 내보내 주입해야 한다.
```bash
node scripts/export-naver-searchadvisor-session.mjs --account <id> --output tmp/naver-login/<id>.crawl.json
NAVER_CRAWL_STORAGE_STATE=tmp/naver-login/<id>.crawl.json
```
안 하면 전부 `Naver login is required` 로 실패한다.

### 4.3 `NAVER_CRAWL_TARGET_PROJECT` 기본값이 남의 프로젝트다
기본값 `watermelon-piping`. 반드시 `cleaning-ravi` 를 지정할 것.

### 4.4 `NAVER_CRAWL_QUEUE_SOURCE=db` 를 지정해야 한다
기본값이 `file` 이라 존재하지 않는 큐 파일을 찾다가 ENOENT 로 죽는다.

### 4.5 inet 컬럼을 `::text` 로 캐스팅하면 `/32` 가 붙는다
`49.254.144.143/32` 가 되어 IP 비교가 항상 실패한다. `host(...)` 를 쓸 것.

### 4.6 HaiIP 자동화는 관리자 권한 PowerShell 이 필요하다
HaiIP 가 관리자 권한으로 뜨기 때문에, 일반 권한에서 창 메시지를 보내면 UIPI 로 차단되어
`SendMessage` 가 조용히 0 을 반환한다 (GetLastError=5). 목록이 비어 보이는 게 아니라 못 읽는 것이다.

### 4.7 HaiIP 회선이 1개라 계정을 동시에 못 돌린다
`keyword22` 회선 하나 = 동시에 공인 IP 하나.
계정마다 검증 IP 가 달라서, 프록시 없이는 계정 작업을 순차로만 할 수 있다.
**수집요청이 도는 중에 IP 를 바꾸면 세션이 깨진다.**

### 4.8 세션은 저장할 때의 IP 에서만 쓴다
`searchadvisor_session_validated_public_ip` 와 현재 공인 IP 가 같아야 한다.
프록시 모드면 이 검사를 건너뛴다.

### 4.9 Playwright: `--load-storage` 와 `--user-data-dir` 를 같이 쓰면 안 된다
인증 쿠키가 프로필에 반영되지 않아 로그아웃 상태로 열린다.
캡처할 때는 `--user-data-dir`, 사용할 때는 `--load-storage` 만.

### 4.10 AWS `default` 프로파일 키가 폐기됐다
```
[default]      InvalidClientTokenId
[cleaning-ops] arn:aws:iam::299362456167:user/terraform-cleaning-ops  ← 이걸 쓸 것
```
SSH/terraform 시 `AWS_PROFILE=cleaning-ops` 필요.

### 4.11 `DIRECT_URL` 은 DNS 가 안 잡힌다
`db.<ref>.supabase.co` 가 IPv6 전용이라 해석 실패한다. 항상 `DATABASE_URL`(pooler, 6543) 을 쓴다.

### 4.12 EC2 는 포트 22 가 닫혀 있다
SSM 터널로만 SSH 한다.
```bash
ssh -i /c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem \
  -o ProxyCommand="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region ap-northeast-2 --profile cleaning-ops" \
  ec2-user@i-039361b55ae33808b
```

### 4.13 소유확인에는 캡차가 있다 — 사람이 입력해야 한다
네이버 모달 문구: "프로그램을 이용한 자동등록을 방지하기 위해 보안절차를 거치고 있습니다."
`--semi-auto` 로 실행하면 스크립트가 이동·선택·클릭·판정·DB기록을 하고 보안문자만 사람이 넣는다.
**캡차 자동 해독은 구현하지 않았고, 하지 않는다.**

### 4.14 하이아이피 서비스 만료: 2026-08-29
색인 확인에 2~4주가 걸리므로 만료 시점과 겹친다.

---

## 5. 자주 쓰는 명령

### 수집요청 (계정1 이어서)
```bash
NAVER_CRAWL_QUEUE_SOURCE=db \
NAVER_CRAWL_ACCOUNT_ID=lguxp4nlw \
NAVER_CRAWL_TARGET_PROJECT=cleaning-ravi \
NAVER_CRAWL_STORAGE_STATE=tmp/naver-login/lguxp4nlw.crawl.json \
node scripts/submit-naver-searchadvisor-crawl-requests.mjs
```
DB 에 남은 기록으로 이미 보낸 URL 은 자동으로 건너뛴다. 중단해도 안전하다.

### 소유확인 (계정2~10, 캡차는 사람이)
```bash
node scripts/verify-naver-searchadvisor-sites.mjs --account noiuhejawrjjyso4n --semi-auto
# 프록시 사용 시 (HaiIP 대기 없음, 병행 가능)
node scripts/verify-naver-searchadvisor-sites.mjs --account noiuhejawrjjyso4n --semi-auto --use-proxy
```

### 네이버 실제 소유확인 상태를 DB 에 반영
```bash
node scripts/sync-naver-verification-status.mjs --account <id> --dry-run
node scripts/sync-naver-verification-status.mjs --accounts 1-10
```
DB 를 임의로 verified 로 쓰지 않고, `api-board/list` 응답의 `verified=true` 만 반영한다.

### 재배포 (메타태그·본문 변경 시)
```bash
export AWS_PROFILE=cleaning-ops
node scripts/build-and-deploy-sites.mjs            # 전체
node scripts/build-and-deploy-sites.mjs --limit 1  # 1개만
```
실측: 빌드 7분 + 전송 23분 = 30분 (1,000개, 2.4GB).

### HaiIP IP 전환 (관리자 권한 필요)
```powershell
powershell -File .\scripts\haiip-windows-ui-control.ps1 -Command status
powershell -File .\scripts\haiip-windows-ui-control.ps1 -Command change -PreferredIp <IP> -CheckPreferredResult
```

---

## 6. 남은 일

1. **계정1 나머지 5,000건** — 내일 자정(KST) 리셋 후 같은 명령
2. **계정2~10 소유확인 900건** — 캡차 900회, 사람 입력 필요
3. **계정2~10 수집요청 45,000건**
4. **색인 확인** (2~4주 후) — `scripts/check-naver-indexed-posts.mjs`
5. **하이아이피 연장** (8/29 만료)
6. **Vercel 관리자 페이지** — 미착수

---

## 7. 규모 재검토 (미결정)

캡차 횟수는 **사이트 수**에, 1회전 기간은 **사이트당 페이지 수**에 비례한다.
총 페이지 100,000장을 고정하면:

| 구성 | 계정 | 사이트 | 사이트당 페이지 | 캡차 | 1회전 |
|---|---|---|---|---|---|
| 현재 | 10 | 1,000 | 100 | 1,000회 | 2일 |
| 대안 A | 2 | 200 | 500 | 200회 | 10일 |
| 대안 B | 1 | 100 | 1,000 | 100회 | 20일 |

실측: 계정 하나(사이트 100개) 수집요청에 약 2시간.
재구성 비용은 재배포 30분 + DB 재생성. **계정2 소유확인 전에 결정하는 것이 좋다**
(안 그러면 버릴 사이트에 캡차를 쓰게 된다).

---

## 8. 운영 규칙

`CLAUDE.md` / `AGENTS.md` 의 최우선 규칙을 따를 것.

- 한 단계 끝나면 보고하고 확인 받은 뒤 진행
- DB 쓰기 전에 무엇을 몇 건 바꾸는지 먼저 보고
- 외부 작업(네이버 접속, 배포, DNS) 전 확인
- 지시서와 실제 스키마가 다르면 임의로 고치지 말고 보고
- 임의로 정한 값은 목록으로 보고
