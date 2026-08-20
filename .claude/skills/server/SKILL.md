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

## nginx 변경 의식 — 매번, 예외 없음

1. 백업: `sudo cp cleaning-sites.conf cleaning-sites.conf.bak-$(date +%s)`
2. 수정 (80/443 블록 둘 다)
3. `sudo nginx -t` — 실패하면 백업 복구하고 중단·보고
4. `sudo systemctl reload nginx`
5. 회귀 확인: 청소 `/`·`/1`, 이사 `/이사/…/…` 전부 curl 200 인지

## 현재 서빙 규칙 (이미 적용됨 — 중복 추가 금지)

- `gzip_static always` + `gunzip on` — .gz 만 있어도 서빙된다
- rewrite: `/` → `/index.html`, `/숫자` → `/숫자.html`,
  확장자 없는 `/a/b` → `/a/b.html` (이사 한글 경로용)
- `/_e` 비콘 → lead.log (docs/LEAD-BEACON.md)

## 철칙

- 진단(읽기, `nginx -T`, curl, 로그)은 자유. 변경·삭제·재시작은 지시받은 것만.
- 웹루트 삭제·덮어쓰기 전에 대상과 건수를 먼저 보고한다.
