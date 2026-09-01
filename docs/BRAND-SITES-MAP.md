# 브랜드 사이트 배정표 (확정 2026-09-01)

다섯 곳이 서로 다른 회사로 보여야 하는 프로젝트다. 어느 브랜드가 어느 도메인·계정·
구조를 쓰는지 헷갈리면 남의 사이트에 남의 문안을 올리게 된다. 여기가 단일 기준이다.

## 한 장 요약

| 키 | 브랜드 | 도메인 | 전화 | 계정 | 구조 | 장수 |
|---|---|---|---|---|---|---|
| `dream` | 드림컴뚜러 | dreamcome.kr | 070-7106-5225 | **506** `yuzjplo3322` | 평면 · **글형식** | 286 |
| `thunder` | 썬더배관 | thunderdrain.kr | 070-7106-5226 | 502 `dynfbs403` | 평면 · 카드형 | 303 |
| `mole` | 비버배관 | beaverpipe.kr | 070-7106-5227 | 503 `zfbbt34` | 평면 · 카드형 | 286 |
| `ssak` | 싹쓰리배관 | ssac3.kr | 070-7106-5228 | 504 `saennl02` | 블로그 · **글형식** | 3,325 |
| `dosa` | 하수구도사 | dosadosa.kr | 070-7106-5229 | 505 `jukkl07` | 3단계 · **글형식** | 3,632 |

- 그룹 키 `brand-ravi` · 실행 기계 **VM1** · 계정 범위 **501~510**
- 이관 체인: **501 → 506** (501 정지, 2026-09-01). 정지되면 506 부터 순서대로 쓴다
- 한 계정이 도메인 하나씩 든다 (계정당 100개까지 가능하지만 그렇게 안 쓴다)
- 합계 **7,832장**, 그중 본문(글형식) **6,656장**

## 구조가 왜 다른가

운영자가 레퍼런스를 정해 줬다. 디자인이 아니라 **사이트 구조**를 다르게 가져간다.

    dream    하림배관(cloggedpipe.co.kr) 꼴 — 지역 한 장에 다 담는다
    thunder  water114 / apex 꼴 — 평면
    mole     pipe-oneshot.com 꼴 — 평면, CSS 는 물길찾기/hud 결
    ssak     하수구박사(hasugubaksa.com) 꼴 — /{구}{키워드}-{작업}-{성격}/ 한글 평면
    dosa     클린배관 꼴 — /{시도}/{시군구}/{키워드} 3단계 로마자

## URL 모양

    dream    https://dreamcome.kr/bannati/                     (임의 영단어)
    thunder  https://thunderdrain.kr/bajaga/
    mole     https://beaverpipe.kr/besorigo/
    ssak     https://ssac3.kr/강남구변기막힘-스프링작업-비용정보/
    dosa     https://dosadosa.kr/seoul/gangnamgu/toilet-clog/

## 본문 형식 — 셋만 글형식

    글형식   dream · ssak · dosa      목차 + 질문형 소제목 + 표·목록·체크·상자·문답
    카드형   thunder · mole           운영자가 그대로 두라고 했다 (2026-09-01)

글형식의 구역 계획은 사이트 json 의 `articlePlan` 에 있다. 문안은
`blog-section-reference-library*.md` → `node scripts/import-blog-library.mjs` →
`data/brands/_blog-library.json`.

**세 사이트가 라이브러리를 삼등분해 쓴다** (`libraryShare`). 겹치면 한 사람이 만든
티가 난다. 사이트를 더 붙이려면 n 을 올리고 소제목부터 늘려야 한다.

## 사이트맵

Yoast 꼴 색인이다. 네이버 웹마스터도구 문서의 2번 형식.

    /sitemap_index.xml       색인 (robots.txt 가 가리킨다)
    /sitemap.xml             같은 색인 (옛 주소를 가리키던 곳 때문에 남겼다)
    /<종류>-sitemap<N>.xml   자식, 주소 1,000개씩

자식 개수: dream 5 · thunder 5 · mole 5 · ssak 10 · dosa 9

`lastmod` 는 `2026-09-01T20:55:33+09:00` 꼴, `changefreq`·`priority` 도 넣는다.
굽기가 네이버 한도(10MB · 5만 URL · 동일 도메인)를 미리 검사한다.

## 확인해 준 사실만 쓴다

`data/brands/<키>.json` 의 `facts` 에 있는 것이 전부다.

    equipment    석션기 · 전동 스프링 · 플렉스 샤프트 · 배관 내시경 · 고압세척기
    hours        24시간 연중무휴
    dispatch     전국 30분 이내 긴급 출동
    dispatchLine 위 사실을 브랜드 말투로 쓴 한 줄 (사이트마다 다르다)

여기 없는 것은 지어내지 않는다 — 경력·고객수·성공률·자격증·특허·후기·평점·
무상보증·최저가·SLA. 정화조 청소는 아예 다루지 않는다 (분뇨수집운반업 허가 필요).

## 자주 쓰는 명령

    npm run brands:build                                    굽기 + 검사
    npm run brands:check                                    검사만
    node scripts/deploy-brand-sites.mjs --dry-run           무엇이 나갈지
    node scripts/deploy-brand-sites.mjs                     EC2 오리진에 올리기
    node scripts/purge-brand-cache.mjs                      Cloudflare 캐시 비우기
    node scripts/sync-brand-verification.mjs --apply        소유확인 토큰 DB -> json
    node scripts/serve-static.mjs --root tmp/brands/ssak --port 4184

**배포 뒤에는 반드시 퍼지**한다. 사이트맵·robots 는 Cloudflare 가 캐시한다
(HTML 은 DYNAMIC 이라 안 한다). 2026-09-01 에 dosadosa.kr 만 옛 robots.txt 를
계속 내보내고 있었다 — 도메인마다 캐시 상태가 달라 한 곳만 보고 판단하면 안 된다.

## 계정이 정지되면

    node scripts/migrate-brand-account.mjs --from <옛계정> --to <새계정>          무엇이 바뀌는지만
    node scripts/migrate-brand-account.mjs --from <옛계정> --to <새계정> --apply

DB 세 줄만 바꾸고(소유 계정 · 옛 계정 blocked · 등록 상태 pending) 나머지는 사람이 한다.
토큰을 지우는 것이 핵심이다 — 서치어드바이저에서 사이트는 **등록한 계정의 것**이라,
소유자만 바꾸고 옛 토큰을 두면 새 계정 세션에서는 남의 사이트가 된다.

    1. 세션 캡처   capture-naver-session.mjs --account <새계정>
    2. 사이트 등록  register-naver-searchadvisor-sites.mjs --account <새계정> --group-key brand-ravi
    3. 토큰 옮기기  sync-brand-verification.mjs --apply
    4. 굽기·배포    brands:build → deploy-brand-sites → purge-brand-cache
    5. 소유확인     verify-naver-searchadvisor-sites.mjs --account <새계정> --group-key brand-ravi
    6. 수집요청     run-brand-crawl-range.ps1 -From 501 -To 510

## 함정

- **`--group-key brand-ravi` 를 빼면 안 된다.** 등록·소유확인·사이트맵 제출 세
  스크립트 모두 기본값이 `cleaning-ravi` 다. 빼면 청소 1만을 대상으로 잡는다.
- **`site_url` 은 `https://<host>` 여야 한다.** 굽기는 이 필드를 안 보고 host 로
  주소를 만들기 때문에, 여기가 틀려도 페이지·사이트맵은 멀쩡하고 DB 만 틀린다.
  2026-09-01 에 `https://TBD.co.kr` 이 그대로 남아 서치어드바이저에 그 주소로
  등록됐다. 지금은 등록 스크립트가 어긋나면 멈춘다.
- **수집요청 한도는 계정이 아니라 사이트에 붙는다.** 도메인이 다섯뿐이라 하루
  250건(사이트당 50건)이 천장이다. 계정을 늘려도 안 늘어난다.
  전량 한 바퀴에 ssak 67일 · dosa 73일. 대량 색인은 IndexNow 쪽이 답이다.
