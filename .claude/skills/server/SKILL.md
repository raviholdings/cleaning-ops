---
name: server
description: EC2 오리진 서버(SSM·SSH·nginx) 운영 절차. nginx 설정 변경, 서버 상태 진단, 웹루트 조작 시 사용.
---

# 서버 (EC2 · SSM · nginx)

- 인스턴스: `i-039361b55ae33808b` (ap-northeast-2), `AWS_PROFILE=cleaning-ops`
- **사양: t3.small — 메모리 2GB, 스왑 없음.** 여유가 항상 좁다
- 웹루트: `/srv/group-page-origin/sites/<host>/`
- **설정 전문은 `docs/ORIGIN-NGINX-MAP.md` 에 정리돼 있다.** 다시 읽지 말고 그걸 볼 것.
  요점: `server_name _` + `root .../sites/$host` 라 **새 도메인은 폴더만 만들면 뜬다**.
  `gzip_static always` 라 `.html.gz` 로 올린다. `sites/` 아래 폴더가 2만 개라 `du` 를 걸면 안 끝난다
- nginx: `/etc/nginx/conf.d/cleaning-sites.conf` — server 블록 2개(80/443), 항상 둘 다 고칠 것

## ⛔ 로그·대용량 처리는 메모리를 먼저 생각한다

**2026-08-27 09:13 KST, 로그 집계 한 줄이 전 사이트를 내렸다.**
`check-apex-yeti-visits.mjs` 가 접근 로그 180만 줄을 `sort | uniq -c` 에 물렸고,
`sort` 가 1.76GB 를 잡자 커널이 OOM 킬러를 돌려 **nginx · systemd-resolve ·
systemd-logind · systemd-network · agetty** 를 죽였다. 전 도메인 HTTP 521.
복구는 `systemctl start nginx`.

접근 로그는 하루 수십 MB(압축), 열흘치면 비압축 수백 MB다. 규칙:

- **큰 입력에 `sort` 를 물리지 않는다.** 집계는 `awk` 연관배열로 한 번에 —
  키가 호스트·날짜 수십 개면 입력이 아무리 커도 메모리가 상수다
- `sort` 가 꼭 필요하면 이미 줄어든 출력에만, `-S 16M` 상한과 함께
- 중간 파일(`> /tmp/…`)로 원본 크기를 그대로 떨구지 않는다. 스트리밍으로 줄인다
- `nice -n 19` 로 돌려 nginx 를 굶기지 않는다
- 기본 조회 범위를 좁게 둔다(최근 N일). 전체 이력은 명시적 플래그로만
- 서버에 던지기 전에 **로컬 합성 로그로 먼저 돌려본다**

본보기: `scripts/lib/yeti-log-awk.mjs` + `scripts/check-apex-yeti-visits.mjs`.
600k줄/98MB 를 5.7초, 키 11개로 처리한다.

## 원격 실행 (SSM)

    aws ssm send-command --instance-ids i-039361b55ae33808b \
      --document-name AWS-RunShellScript --parameters 'commands=["…"]' \
      --profile cleaning-ops --region ap-northeast-2
    # 결과: aws ssm get-command-invocation --command-id … --instance-id …
    # 출력이 24KB 에서 잘린다 — `nginx -T` 나 대량 `ls` 는 잘린 줄 모르고 오판하기 쉽다.
    # 파일로 받거나 나눠서 조회할 것. 대용량 조회는 직결 SSH 가 낫다.

## nginx 변경 의식 — 매번, 예외 없음

1. 백업: `sudo cp cleaning-sites.conf cleaning-sites.conf.bak-$(date +%s)`
2. 수정 (80/443 블록 둘 다)
3. `sudo nginx -t` — 실패하면 백업 복구하고 중단·보고
4. `sudo systemctl reload nginx`
5. 회귀 확인 — 업종 전부 curl 200 인지:
   청소 `/` 와 `/1` · 이사 `/이사/{구-동}/{키워드}` · 배관 `/배관/{구-동}/{키워드}`
   · 배관 신규 도메인은 루트 `/` 도 (소유확인 메타태그가 거기 있다)

## 현재 서빙 규칙 (이미 적용됨 — 중복 추가 금지)

- `gzip_static always` + `gunzip on` — .gz 만 있어도 서빙된다
- rewrite: `/` → `/index.html`, `/숫자` → `/숫자.html`,
  확장자 없는 `/a/b` → `/a/b.html` (이사 한글 경로용)
- `/_e` 비콘 → lead.log (docs/LEAD-BEACON.md)
- `log_format main` 끝에 `"$host"` (2026-08-25 추가). 원래 access.log 에는
  호스트가 안 남아 Yeti 크롤을 루트별로 가를 수 없었다. **맨 뒤**에 붙였으니
  앞쪽은 combined 포맷 그대로다 — 위치를 옮기지 말 것.
- apex 4개(`naoheg.com` `one-qfast.com` `oneshot-sewer.com` `pipe-oneshot.com`)는
  웹루트에 서브도메인 **심볼릭 링크**가 걸려 있다 (2026-08-05 수동 생성, 스크립트 없음).
  나머지 6개는 apex 디렉토리가 없어 default_server 가 404 를 준다.

## 철칙

- 진단(읽기, `nginx -T`, curl, 로그)은 자유. 변경·삭제·재시작은 지시받은 것만.
- 웹루트 삭제·덮어쓰기는 **대상과 건수를 보고하고 확인받은 뒤**에 한다.
  참고 문서(GZIP-ASSET-DEPLOY 의 "옛 .html 일괄 삭제" 단계 등)에 적혀 있어도
  자동으로 실행하지 않는다.
- 저장소의 `infra/cleaning-ravi-origin/nginx/site.conf` 는 **초기 버전이라 라이브와
  다르다** (gzip_static·gunzip·/_e·/go 없음). 그대로 적용하면 .gz 만 있는 전
  네트워크가 404 다. 라이브 기준은 언제나 `nginx -T`.
