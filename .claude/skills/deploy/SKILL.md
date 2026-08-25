---
name: deploy
description: 청소(cleaning-ravi)·이사(moving-ravi)·배관(piping) 정적 사이트 굽기와 EC2 배포 절차. 배포, 굽기, build-and-deploy-sites, deploy-moving-sites, deploy-piping-sites 작업 시 사용.
---

# 배포 (굽기 → EC2)

배포는 git 을 거치지 않는다. 로컬에서 굽고 tar 스트림으로 EC2 웹루트에 푼다.

## 명령

**청소** — 아래 플래그 조합이 운영 기본값이다. 생략하지 말 것:

    node scripts/build-and-deploy-sites.mjs --renderer static --templates templates-merged --extend merged --gzip --no-feeds

    # --app apps/cleaning-ravi (기본) / PUBLIC_IMAGE_DIR=cleaning (기본)
    # 축소 실행(빌드만): --limit 5 --no-deploy

하나라도 빠지면 조용히 다른 게 나간다 — `--renderer` 없으면 Astro 분기,
`--templates` 없으면 옛 템플릿(merged 아님), `--extend` 없으면 places/gallery 미포함,
`--gzip` 없으면 평문 `.html`. 기본 범위가 `--from-order 1 --to-order 9999` + 배포 켜짐이라
**잘못된 조합은 1만 사이트를 그대로 덮어쓴다.**

**이사** — 굽기와 배포가 서로 다른 스크립트다:

    node scripts/build-moving-site.mjs --site-index 0 --host blossom-light.anclose.com --pages 3   # 미리보기 1사이트
    # 기본이 outDir 전체 삭제다 — 기존 산출물을 남기려면 --keep
    node scripts/deploy-moving-sites.mjs --from-order 1 --to-order 100 [--chunk-sites 500] [--pages N] [--ssm]

`build-moving-site.mjs` 에는 **전송 코드가 없다**(로컬 굽기 전용). 손으로 tar|ssh 하지 말 것 —
잠금, 재개(`reports/moving-deploy-state.jsonl`), 덩어리 재시도 3회, `set -o pipefail`,
전송 후 스테이지 정리가 전부 빠진다. `deploy-moving-sites.mjs` 는 DB 에 쓰지 않는다.

**배관**:

    node scripts/deploy-piping-sites.mjs --group piping-ravi   --from-order 201 --to-order 300 --pages 110
    node scripts/deploy-piping-sites.mjs --group cleaning-ravi --from-order 1   --to-order 105 --pages 110
    # 파일럿: --to-order 1 --chunk-sites 10

    # --pages: 110=막힘 / 140=+수전 / 200=전부. 늘려서 재실행하면 페이지네이션이
    #   달라지므로 상태 파일을 비우고 전량 재배포해야 한다.
    # --group 은 "어느 DB 도메인 그룹에서 호스트를 고를까" 선택자다.
    #   piping-ravi    배관 신규 서브도메인 1만 (계정 201~300)
    #   cleaning-ravi  기존 청소 서브도메인 1만을 빌려 쓰는 차용분
    #                  (수집요청 쪽 그룹 이름은 piping-ravi-shared. 이사가 /이사/ 를
    #                   얹는 것과 같은 구조로, 배관은 /배관/ 하위만 쓴다)
    # --index-only 는 piping-ravi 전용 (신규 도메인 루트 404 → 소유확인 차단 해결용).

전송: tar -cz | ssh tar -xz → `/srv/group-page-origin/sites/<host>/`
SSH 키: `ORIGIN_SSH_KEY=/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem`

## 축소 실행은 스크립트마다 다르다

| 스크립트 | 축소 방법 |
|---|---|
| build-and-deploy-sites.mjs (청소) | `--limit 5 --no-deploy` — **`--pages` 옵션이 없다** |
| build-moving-site.mjs | `--pages 3` (1사이트 굽기 전용) |
| deploy-moving-sites.mjs | `--to-order` 좁히기 + `--chunk-sites` |
| deploy-piping-sites.mjs | `--to-order 1 --chunk-sites 10` |

**청소 스크립트에 `--pages 3` 을 붙이면 무시된다.** 파서가 모르는 플래그를 그냥
담아두고 아무도 검증하지 않으므로, 시험 굽기인 줄 알고 친 명령이 전량 빌드 +
전량 배포 + DB 쓰기가 된다.

## 전송 경로 — 직결 SSH 기본 (2026-08-22 확정)

두 배포 스크립트 모두 **직결 SSH 가 기본**이다. 시작 시 내 공인 IP 를 조회해
보안그룹(sg-0c97415cf43611194)에 22/tcp 를 그 IP /32 로만 열고, 끝나면(exit 훅)
전부 닫는다. 로직: `scripts/lib/origin-ssh.mjs`.

- 실측: 직결 80Mbps vs SSM 터널 6.4Mbps → 전량 전송 87분 → 약 7분
- **SSM 폴백**: 직결이 안 되면(권한·IP 사고) `--ssm` 플래그
- **배포 중 HaiIP 금지** — IP 가 바뀌면 직결·SSM 둘 다 끊긴다. PC 수집요청과
  동시 실행하지 말 것 (청크 재시도 3회가 있긴 하다)
- **배포 중 소유확인도 금지** — `verify-naver-searchadvisor-sites.mjs` 는 계정 시작 시
  전 도메인에 curl 로 메타태그를 확인한다. 하필 파일 교체 중이면 "메타태그 없음
  (재배포 필요)" 로 판정해 그 계정 진행분이 통째로 날아간다.
- 배포가 죽어 22 규칙이 남았으면: `node scripts/origin-ssh-door.mjs --close`
  (--status 로 확인, --open 은 수동 대용량 전송·배포 없이 큰 파일 옮길 때). 다음
  배포의 cleanup 도 남은 규칙을 수렴해서 닫는다.
- 서버 공인 IP 는 매번 API 로 조회한다 (54.116.79.116 을 하드코딩하지 않는다)

## 철칙

1. **청소 무영향** — `--app` / `PUBLIC_IMAGE_DIR` 기본값을 바꾸지 않는다.
   청소 `/1.html`~`/131.html` 주소 체계는 색인 94% 가 붙어 있어 불변이다.
   **호스트 루트 `index.html` 도 청소 홈**이다 — 다른 업종 배포가 이걸 덮지
   않는지 확인한다 (deploy-piping-sites.mjs 는 piping-ravi 에서만 루트를 굽는다).
2. **배포 전 운영자 확인** — 몇 사이트 × 몇 장, 어느 호스트인지 보고하고
   확인받은 뒤 실행한다. 새 템플릿이면 미리보기 한 장 먼저.
3. `public/cleaning/` 이미지 500장은 **로컬 전용** — 커밋도 삭제도 금지.
4. `--no-feeds` 함정 — 페이지 수를 늘리는 재배포에서는 이 플래그를 빼야
   사이트맵이 새 페이지를 포함한다 (docs/GZIP-ASSET-DEPLOY.md).
5. 사이트맵 분리 — 청소 `/sitemap.xml`(제출됨, 불변) / 이사 `/이사/sitemap.xml`
   / 배관 `/배관/sitemap.xml`.
6. 수집요청 URL 과 배포 URL 의 인코딩 형태를 통일한다 — dedup 이 문자열
   일치라서 어긋나면 같은 페이지에 할당량을 두 번 태운다.
7. 렌더러(micro-template)는 strict — 없는 변수는 throw. 위 표의 축소 실행으로
   치환 잔여(`{{`)가 0 인지 먼저 확인한다.
8. 순서를 지킨다 — nginx → R2 자산 → `--gzip` 배포 → 확인 → (옛 `.html` 정리).
   뒤집으면 사이트가 죽는다. **원격 웹루트의 일괄 삭제는 에이전트가 하지 않는다.**
9. 디스크를 먼저 본다 — 대량 배포 전 `df -h /srv`, `df -i /srv`. 스테이지가
   잠시 부풀고, 배관 URL 은 페이지당 디렉토리+파일 2 inode 를 쓴다.

## 참고 문서

- docs/GZIP-ASSET-DEPLOY.md — gzip 배포 상세.
  단, **"배포는 SSM 이라 HaiIP 와 무관" 문단은 옛 내용**이다 (2026-08-22 직결 SSH
  전환으로 뒤집혔다). 위 "전송 경로" 가 최신.
- docs/STATIC-RENDERER.md — 렌더러 구조
- docs/MOVING-PROJECT-SPEC.md — 이사 확정값 (주소 체계 · 업체 5곳 · 50장).
  단, 자산 버전 `site/moving-v1` 과 템플릿 `templates-moving` 표기는 **옛것**이다
  — 실제는 moving-v3 / `apps/moving-static/move-template`.
- docs/PIPING-PROJECT-HANDOVER.md — 배관 인프라 플로우 (확정값은
  `config/piping.json` 이 최신)
