# Astro 없이 배포하기 — 정적 렌더러

2026-08-07 작성.

## 왜 바꾸나

산출물에 자바스크립트 번들이 없다. `dist/_astro` 폴더 자체가 생기지 않는다.
실제로 쓰던 Astro 기능은 `Astro.props` 4곳과 `getStaticPaths` 하나뿐이었다.

그런데도 사이트마다 Vite 빌드를 통째로 돌기 때문에:

| | Astro | 정적 렌더러 |
|---|---|---|
| 1,000 사이트 | **525초** (1.91/초) | **82초** (12.2/초) |
| 필요 힙 | 16GB (`--max-old-space-size`) | 기본값 |
| 실패 이력 | OOM, `spawn UNKNOWN`(esbuild), EPERM | 없음 |
| VM(4GB)에서 배포 | 불가 | 가능 |

마지막 줄이 핵심이다. 지금은 배포를 이 PC에서만 할 수 있어 VM 이 기다려야 한다.
정적 렌더러면 VM 이 등록 → 배포 → 소유확인을 혼자 끝낸다.

## 구성

```
scripts/lib/micro-template.mjs        템플릿 엔진 (Mustache 부분집합, 의존성 0)
scripts/lib/static-site-renderer.mjs  데이터 조립 + 파일 출력
scripts/render-static-site.mjs        사이트 1개 렌더 (CLI)
scripts/compare-static-render.mjs     Astro 산출물과 대조 (안전장치)
apps/cleaning-static/templates/
  page.html                           /N.html
  index.html                          /
  partials/estimate-form.html         {{{estimateForm}}} 로 꽂힌다
  styles.css                          없으면 Astro 의 page.css 를 쓴다
```

**데이터 계산은 다시 구현하지 않았다.** 지역·키워드 배정(`pageCatalog.ts`),
문구 생성(`pageMeta.ts`), 콘텐츠 풀(`content.ts`) 은 Astro 앱의 `.ts` 를
Node 24 의 타입 스트리핑으로 그대로 import 한다. 두 벌이 되면 반드시 어긋난다.

## 템플릿 문법

```
{{name}}              HTML 이스케이프해서 넣는다
{{{name}}}            그대로 넣는다 (JSON-LD, CSS, partial)
{{#name}}…{{/name}}   배열이면 반복, 참이면 한 번, 비었으면 생략
{{^name}}…{{/name}}   비었을 때만
{{.}}                 반복 안에서 현재 항목 (문자열 배열)
```

**없는 변수를 쓰면 조용히 빈칸이 되지 않고 던진다.** 30만 페이지를 찍는데
오타 하나가 빈칸으로 나가면 배포하고 나서야 안다.

## 쓰는 법

```bash
# 템플릿이 요구하는 변수 목록
npm run render:vars

# 사이트 1개 렌더 (DB 안 읽음)
npm run render:one -- --site-url https://a.example.com --site-index 0 --out tmp/a

# 실제 도메인 조건으로 렌더 (DB 읽기 전용)
npm run render:one -- --host lemur-teal.daddul.com --out tmp/lemur

# Astro 와 대조
npm run render:compare -- tmp/astro-dist tmp/a

# 배포 스크립트에서 쓰기
node scripts/build-and-deploy-sites.mjs --from-order 21 --to-order 30 --renderer static
```

`--renderer` 를 안 주면 지금까지처럼 Astro 로 빌드한다. 기본 동작은 안 바뀐다.

## 안전장치 — 대조 검사

`compare-static-render.mjs` 는 바이트 비교를 하지 않는다. Astro 는 공백을
정리하고 속성 순서를 바꾸므로 어차피 다르다. 대신 실제로 영향을 주는 것만 본다.

- `title` / `description` / `canonical` / `robots` / `og:*`
- **소유확인 meta** — 이게 틀리면 도메인이 통째로 소유확인 실패한다
- JSON-LD (파싱 후 깊은 비교)
- 본문 텍스트 (태그를 걷어낸 순수 텍스트)
- 내부 링크 href 목록
- `sitemap.xml` / `rss.xml` / `robots.txt` (빌드 시각만 무시)

하나라도 어긋나면 종료코드 1.

**검증 기록 (2026-08-07)**
- 가상 사이트 1개 · 104파일 → 전부 일치
- 실제 도메인 3개(`apple-stream.anclose.com`, `lemur-teal.daddul.com`,
  `ruby-spring.amunsa.com`) × 104파일 → 전부 일치

## 디자인을 바꿀 때

템플릿 HTML 만 갈아끼우면 된다. 다만 아래 값은 페이지마다 달라야 하므로
반드시 치환 자리로 남겨야 한다.

| 변수 | 왜 필요한가 |
|---|---|
| `{{title}}` `{{description}}` | 30만 페이지가 같은 제목이면 중복 판정 |
| `{{canonical}}` | 고정하면 100장이 1장으로 합쳐진다 |
| `{{naverSiteVerification}}` | 없으면 소유확인 자체가 안 된다 |
| `{{location}}` `{{mainKeyword}}` | 페이지의 존재 이유 |
| `{{{jsonLd}}}` `{{{pageCss}}}` | 구조화 데이터 / 인라인 스타일 |

바꾼 뒤에는 반드시 Astro 판과 대조하거나, Astro 를 버린 뒤라면 이전 산출물과
대조한다. 확인 없이 3,000개를 덮어쓰지 않는다.

## 아직 남은 것

- `img/` 는 사이트마다 복사하지 않는다. 파비콘처럼 오리진의 shared 한 벌을
  nginx 가 서빙한다. 템플릿 폴더에 `static/` 을 두면 사이트마다 복사된다.
- Astro 를 완전히 걷어내려면 `apps/cleaning-ravi` 의 로컬 미리보기(`npm run dev`)
  대체가 필요하다. 지금은 두 방식이 공존하므로 미리보기는 Astro 로 하면 된다.
