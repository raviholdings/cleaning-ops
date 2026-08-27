# 배관 롤백 절차

배관이 청소·이사에 악영향을 줬다고 판단했을 때 되돌리는 순서.

> **이 문서의 명령은 에이전트가 스스로 실행하지 않는다.** 대상과 건수를 세어
> 보고하고 운영자 확인을 받은 뒤에만 실행한다. 원격 웹루트 삭제가 포함된다.

## 언제 쓰나

- 청소 색인률이 눈에 띄게 떨어졌을 때 (기준: 배관 수집요청 시작 전 대비)
- 네이버가 공유 호스트를 저품질로 판정해 노출이 사라졌을 때 (2026-08-22 사태 형태)
- 배관 페이지가 잘못 구워져 대량으로 재배포해야 할 때

## 되돌릴 수 있는 것과 없는 것

| | 되돌아가나 |
|---|---|
| 배포된 페이지 | **된다** — 파일을 지우면 404 |
| 사이트맵 | **된다** — 파일을 지우면 네이버가 더 못 읽는다 |
| 수집요청 제출 이력 | **안 된다** — 이미 제출한 URL 은 회수 불가. 404 를 주고 네이버가 빼기를 기다린다 |
| 호스트 품질 평가 | **안 된다** — 이게 롤백의 진짜 한계다. 그래서 파일럿이 먼저다 |

## 순서 (위에서부터)

### 1. 수집요청부터 멈춘다

새 URL 이 계속 나가면 아래 단계가 무의미하다.

```sql
-- 배관 두 그룹을 끈다. 청소·이사 그룹은 건드리지 않는다.
update public.naver_project_groups
   set crawl_request_enabled = false, updated_at = now()
 where group_key in ('piping-ravi', 'piping-ravi-shared');
```

돌고 있는 러너가 있으면 창을 닫아 끝낸다 (`run-piping-crawl-range.ps1`).
청소·이사 러너는 계속 돌아도 된다.

### 2. 사이트맵을 먼저 지운다

페이지보다 사이트맵을 먼저 지워야 네이버가 없는 URL 을 계속 읽지 않는다.

```bash
# 먼저 센다 (삭제 아님)
find /srv/group-page-origin/sites -maxdepth 3 -path '*/배관/sitemap.xml.gz' | wc -l
# 확인 후 삭제
find /srv/group-page-origin/sites -maxdepth 3 -path '*/배관/sitemap.xml.gz' -delete
```

### 3. 배관 페이지를 지운다

**공유 호스트(청소 도메인 차용)** — `/배관/` 하위만 지운다. 청소 `/N.html`,
청소 `/sitemap.xml`, 루트 `index.html` 은 절대 건드리지 않는다.

```bash
# 먼저 센다
find /srv/group-page-origin/sites -maxdepth 2 -type d -name '배관' | wc -l
du -sh --total /srv/group-page-origin/sites/*/배관 2>/dev/null | tail -1
# 확인 후 삭제
find /srv/group-page-origin/sites -maxdepth 2 -type d -name '배관' -prune -exec rm -rf {} +
```

**배관 신규 호스트(piping-ravi, 계정 201~300)** — 그 호스트에는 배관밖에 없으므로
호스트 디렉토리를 통째로 지워도 된다. 대상 목록은 DB 에서 뽑는다.

```sql
select host from public.naver_project_domains
 where group_key = 'piping-ravi' and is_visible = true order by host;
```

지우면 루트가 404 가 되어 **소유확인도 같이 깨진다.** 나중에 다시 쓸 도메인이면
루트 `index.html` 만 남기는 편이 낫다 (`deploy-piping-sites.mjs --index-only`).

### 4. 배포 상태 기록을 비운다

안 비우면 다시 배포할 때 "이미 했음" 으로 건너뛴다.

```
reports/piping-deploy-state-cleaning-ravi.jsonl
reports/piping-deploy-state-piping-ravi.jsonl
```

### 5. 청소·이사가 멀쩡한지 확인한다

삭제가 옆을 건드리지 않았는지 본다. 하나라도 200 이 아니면 멈추고 보고한다.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<청소호스트>/            # 청소 홈
curl -s -o /dev/null -w '%{http_code}\n' https://<청소호스트>/1           # 청소 페이지
curl -s -o /dev/null -w '%{http_code}\n' https://<청소호스트>/sitemap.xml # 청소 사이트맵
curl -s -o /dev/null -w '%{http_code}\n' 'https://<청소호스트>/이사/…/…'  # 이사
curl -s -o /dev/null -w '%{http_code}\n' 'https://<청소호스트>/배관/…/…'  # 404 여야 정상
```

### 6. R2 자산은 그대로 둔다

`site/piping-v2/` 는 immutable 이라 지워도 되돌릴 수 없고, 용량도 파일 3개뿐이다.
남겨두면 나중에 재개할 때 그대로 쓴다. **지우지 않는다.**

## 하면 안 되는 것

- **공유 호스트의 루트 `index.html` 삭제** — 청소 홈이다. 색인 진입점이라 지우면
  배관 롤백이 아니라 청소 사고가 된다.
- **`robots.txt` 로 `/배관/` 차단** — 차단하면 네이버가 페이지를 못 읽어서 오히려
  색인에 남은 채로 굳는다. 404 를 주는 편이 빠지는 데 낫다.
- **`npm run db:migrate`** — 러너에 이력이 없어 전 파일을 재적용한다. 결과 테이블
  (2.8만 행 기준 1.5GB)에 인덱스를 다시 빌드하며 INSERT 를 잠근다.
  (`.claude/skills/common/SKILL.md`)
- **수집요청·배포 동시 실행** — 배포는 직결 SSH 라 HaiIP 가 IP 를 바꾸면 끊긴다.

## 부분 롤백 (권장)

전량을 되돌리기 전에 루트 1개만 되돌려 관찰하는 편이 낫다. 루트별로 다르게
반응했던 전례가 있다 (2026-08-22 사태에서 naoheg 는 1일 만에 복귀).

```bash
find /srv/group-page-origin/sites -maxdepth 2 -type d -name '배관' -path '*naoheg.com*'
```
