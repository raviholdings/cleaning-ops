# apex 템플릿 주의사항

여기 있던 내용은 원래 `page.html` · `partials/section-formpage.html` 의 HTML 주석이었다.
그 주석이 배포된 페이지에 그대로 실려 나가서(2026-09-08 운영자 지적) 이 파일로 옮겼다.

**템플릿에 HTML 주석을 쓰지 말 것.** 렌더러가 주석을 지우지 않아 그대로 배포된다.
남길 말이 있으면 이 파일에 적는다.

## `page.html` 의 `<style>` 한 줄

```html
<style>:root{--ink:{{palette.ink}};...;--line:{{palette.line}};}</style>
```

- **마지막 값 뒤에 세미콜론을 반드시 둔다.** 변수 닫는 괄호 바로 뒤에 CSS 닫는 괄호를
  붙이면 템플릿 엔진이 셋을 한 태그로 먹어 CSS 블록이 안 닫힌다.
- 주석 안에도 변수 표기를 쓰지 않는다 — 엔진이 그대로 읽는다.

## `partials/section-formpage.html` 의 iframe

높이는 `iFrameResize` 가 내용에 맞춘다. **CSS 로 높이를 고정하지 말 것.**
고정하면 이사 폼처럼 긴 서식이 넘쳐 iframe 이 자체 스크롤을 갖고, 그러면 주소검색
팝업이 `position:fixed` 로 iframe 상단에 붙어 화면 밖으로 밀린다.

이사 서브도메인 1만 개가 쓰는 것과 같은 설정이다
(`apps/moving-static/move-template/partials/estimate-form.html`).

## 네이버 소유확인 메타

`page.html:9` 에 자리가 있다.

```html
{{#naverVerification}}<meta name="naver-site-verification" content="{{naverVerification}}" />{{/naverVerification}}
```

토큰이 없으면 태그 자체가 안 나간다. 값은 `build-apex-site.mjs` 의 `--token` 으로 들어가는데
**그 플래그는 대상 전체에 같은 값을 넣는다** — 루트마다 토큰이 다르므로 여러 루트를 한 번에
구울 때는 쓸 수 없다.
