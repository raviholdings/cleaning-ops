---
name: server
description: EC2 오리진 서버(SSM·SSH·nginx) 운영 절차. nginx 설정 변경, 서버 상태 진단, 웹루트 조작 시 사용.
---

# 서버 (EC2 · SSM · nginx)

- 인스턴스: `i-039361b55ae33808b` (ap-northeast-2), `AWS_PROFILE=cleaning-ops`
- 웹루트: `/srv/group-page-origin/sites/<host>/`
- nginx: `/etc/nginx/conf.d/cleaning-sites.conf` — server 블록 2개(80/443), 항상 둘 다 고칠 것

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
