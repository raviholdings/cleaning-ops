---
name: deploy
description: 청소(cleaning-ravi)·이사(moving-ravi) 정적 사이트 굽기와 EC2 배포 절차. 배포, 굽기, build-and-deploy-sites, build-moving-site 작업 시 사용.
---

# 배포 (굽기 → EC2)

배포는 git 을 거치지 않는다. 로컬에서 굽고 tar 스트림으로 EC2 웹루트에 푼다.

## 명령

청소 — 옵션 없이 돌리면 청소가 나간다 (기본값이 청소):

    node scripts/build-and-deploy-sites.mjs …
    # --app apps/cleaning-ravi (기본) / PUBLIC_IMAGE_DIR=cleaning (기본)

이사 — 별도 스크립트, gzip 만 생성:

    node scripts/build-moving-site.mjs --site-index 0 --host blossom-light.anclose.com [--pages 3] [--token …] [--out …]
    # 출력: {out}/이사/{구}-{동}/{키워드}.html.gz + 이사/sitemap.xml.gz
    # .html 원본은 만들지 않는다. nginx 의 gzip_static + gunzip 이 서빙한다.

전송: tar -cz | ssh tar -xz → `/srv/group-page-origin/sites/<host>/`
SSH 키: `ORIGIN_SSH_KEY=/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem`

## 철칙

1. **청소 무영향** — `--app` / `PUBLIC_IMAGE_DIR` 기본값을 바꾸지 않는다.
   청소 `/1.html`~`/131.html` 주소 체계는 색인 94% 가 붙어 있어 불변이다.
2. **배포 전 운영자 확인** — 몇 사이트 × 몇 장, 어느 호스트인지 보고하고
   확인받은 뒤 실행한다. 새 템플릿이면 미리보기 한 장 먼저.
3. `public/cleaning/` 이미지 500장은 **로컬 전용** — 커밋도 삭제도 금지.
4. `--no-feeds` 함정 — 페이지 수를 늘리는 재배포에서는 이 플래그를 빼야
   사이트맵이 새 페이지를 포함한다 (docs/GZIP-ASSET-DEPLOY.md).
5. 사이트맵 분리 — 청소 `/sitemap.xml`(제출됨, 불변) / 이사 `/이사/sitemap.xml`.
6. 수집요청 URL 과 배포 URL 의 인코딩 형태를 통일한다 — dedup 이 문자열
   일치라서 어긋나면 같은 페이지에 할당량을 두 번 태운다.
7. 렌더러(micro-template)는 strict — 없는 변수는 throw. 시험 굽기(--pages 3)로
   치환 잔여(`{{`)가 0 인지 먼저 확인한다.

## 참고 문서

- docs/GZIP-ASSET-DEPLOY.md — gzip 배포 상세
- docs/STATIC-RENDERER.md — 렌더러 구조
- docs/MOVING-PROJECT-SPEC.md — 이사 확정값 (주소 체계 · 업체 5곳 · 50장)
