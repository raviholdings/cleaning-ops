# _legacy — 지금 쓰지 않는 옛 파이프라인

2026-09-15 에 `scripts/` 에서 옮겼다.

## 왜 옮겼나

여기 있는 스크립트는 전부 `source_payload.globalSiteOrder` 를 **필수로** 요구한다.
옛 방식은 그 숫자 순번이 페이지 내용을 정했다 (`PUBLIC_SITE_INDEX = globalSiteOrder - 1`).

지금 쓰는 piping-xyz 는 그 필드를 쓰지 않는다. **호스트명 자체가 내용을 정한다**
(`source_payload` 에 지역·키워드가 박혀 있고, `lib/piping-xyz-site.mjs` 가 호스트명을
해시해 페이지 집합을 만든다). 실제로 `naver_project_domains` 5,005행 중
`globalSiteOrder` 를 가진 행은 **0건**이다.

따라서 여기 스크립트는 지금 돌리면 `globalSiteOrder 가 없습니다` 로 죽는다.
그냥 죽으면 다행이고, 더 나쁜 경우 순번을 새로 매겨 기존 배정을 흔들 수 있다.

특히 `plan-piping-subdomains.mjs` / `apply-piping-subdomains.mjs` 는 이름이 현행과
비슷해서 헷갈리기 쉽다. **현행은 `scripts/build-piping-xyz-catalog.mjs` 다.**

## 현행 대응표

| 옛것 (여기) | 지금 쓰는 것 |
|---|---|
| plan-piping-subdomains.mjs / apply-piping-subdomains.mjs | ../apply-piping-xyz-subdomains.mjs |
| build-and-deploy-sites.mjs / deploy-piping-sites.mjs | ../build-piping-xyz-catalog.mjs + ../hub-render-server.mjs |
| plan-cleaning-subdomains.mjs / apply-cleaning-subdomains.mjs | (청소 프로젝트 종료) |
| deploy-moving-sites.mjs | (이사 프로젝트 종료) |

## 되돌리려면

`git mv scripts/_legacy/<파일> scripts/` 후, 파일 안의 `from '../lib/` 를 `from './lib/` 로 되돌린다.
