# apex(루트 도메인) 홈페이지 — 인수인계

2026-08-26 작성. **코드를 고치기 전에 이 문서를 먼저 읽을 것.**

---

## 왜 만들었나

루트 도메인 10개(`amunsa.com` `anclose.com` `daddul.com` `ddulea.com` `naoheg.com`
`neverfoul.com` `one-qfast.com` `oneshot-sewer.com` `pipe-oneshot.com` `uloung.com`)에
실체가 없었다 — 6개는 404, 4개는 서브도메인을 가리키는 심볼릭 링크였다.

2026-08-22 00시 네이버가 10개 루트의 `site:` 노출을 통째로 걷어냈다. 살아남은 외부
사이트(`hasugubaksa.com` 2021~, `draincare.co.kr` 2022~, `btocbstae.com` 2024~)를
조사한 결과 **셋 다 루트에 완결된 사이트가 있었고 우리만 없었다.** 그 자리를 채우는 게
이 작업이다. 배경은 `docs/` 의 다른 문서와 대화 기록에 있다.

**핵심 제약: 10개가 한 틀로 찍힌 티가 나면 안 된다.** 서브도메인 2만 개가 이미 같은
템플릿이라 걸린 상황에서, 루트까지 똑같이 찍으면 같은 문제를 한 층 위에서 반복한다.
그래서 루트마다 갈리는 축을 여러 개 뒀다(아래 표).

---

## 파일 지도

```
data/apex/
  apex-content.json      단일 진실 원천. 루트 배정·테마·분야 콘텐츠·제목풀·nav풀·상단띠·CTA
  review-pool.json       업체 톤 후기 (배관 24 · 청소 16 · 이사 12)

apps/apex-static/apex-template/
  page.html              전체 뼈대 — 상단띠·헤더·main·푸터·FAB·리빌 스크립트
  partials/
    hero.html            히어로 (사진 or SVG 도식 · CTA · 뱃지)
    section-intro.html   소개          section-services.html  서비스 카드 (가로형/벤토/그리드)
    section-price.html   요금표        section-cases.html     작업 사례 (로그/피드/비교)
    section-faq.html     FAQ          section-process.html   작업 순서 (타임라인/파이프라인)
    section-reviews.html 이용 후기 (말풍선/인증/에디토리얼)  section-area.html      서비스 지역
    section-estimate.html 연락 (전화 박스 or 견적 버튼) — 홈 맨 끝에 항상 붙음
    section-formpage.html 견적 폼 (form.html 전용)
  assets/
    apex.css             기본 시트 — 레이아웃·타이포·여백·공통 컴포넌트·입체감 배지
    themes.css           테마 10종 — 10개 고유 UI/UX 아키타입 및 가로/세로 레이아웃
    motion.css           리빌 모션 10종
    hero/                배관1~5.png 청소1~3.png 이사1~2.png (원본)
                         + <루트>.webp (변환본, 빌더가 읽는 건 이쪽)

scripts/
  build-apex-site.mjs           빌더
  prepare-apex-hero-images.mjs  PNG → webp 변환 + 루트 배정 (sharp 필요)
  preview-apex-gallery.mjs      10개를 한 페이지에 모아 비교
  lib/apex-visuals.mjs          SVG 아이콘 24종 · 3D 입체 이모지 배지 · 히어로 도식 · CTA 아이콘
  lib/apex-reviews.mjs          후기 풀 로더 · 루트별 선택
  lib/micro-template.mjs        템플릿 엔진 (기존 것, 손대지 말 것)

tmp/apex/<도메인>/              빌드 결과
tmp/apex-gallery.html           갤러리
```

---

## 실행

```bash
node scripts/prepare-apex-hero-images.mjs        # 사진을 바꿨을 때만
node scripts/build-apex-site.mjs --all --preview # 로컬 확인용 (상대경로, gz 없음)
node scripts/preview-apex-gallery.mjs            # 10개 비교 페이지
node scripts/build-apex-site.mjs --all           # 배포본 (절대경로, gz 포함)
```

`--preview` 와 배포본은 **경로가 다르다**. 미리보기는 `assets/apex.css`,
배포본은 `/assets/apex.css`. 미리보기 결과를 그대로 서버에 올리면 안 된다.

---

## 루트마다 갈리는 10대 UI/UX 아키타입

전부 `data/apex/apex-content.json` 의 `roots` 에서 정한다.

| 루트 | 브랜드 / 테마 | UI/UX 레이아웃 변칙 특징 | 상단 헤더 & 네비게이션 | 후기 / 요금 / 공정 표현 |
|---|---|---|---|---|
| daddul.com | 다뚫배관<br>`blueprint` 산업도면 | **가로형 전폭 기술 사양 행** (`1fr`)<br>가로형 배관 플로우차트 파이프라인 | CAD 타이틀 블록 헤더<br>`01.진단공종` `02.시공공정` `03.단가표` | CAD 도면 사양 단가표<br>현장 검측 및 조치 로그 |
| ddulea.com | 뚫어드림<br>`warm-utility` 생활설비 | **플로팅 아일랜드 캡슐 헤더**<br>2x2 소프트 라운디드 파스텔 카드 | 부양 알약형 내비<br>`우리집 배관 진단` `어떻게 고치나요?` | **카카오톡/문자 말풍선 후기**<br>안심 정찰제 요금표 |
| neverfoul.com | 냄새잡이설비<br>`glass` 글래스모피즘 | **플로팅 글래스 캡슐 헤더**<br>2열 가로형 와이드 서리유리 바 | 서리유리 아일랜드 내비<br>`악취 차단공법` `원인별 진단비용` | 반투명 글래스 Before/After<br>글래스 아코디언 FAQ |
| oneshot-sewer.com | 한방하수도<br>`emergency` 긴급출동 | **24H 사이렌 긴급 알림 띠 헤더**<br>굵은 적색 띠 경보 카드 · 거대 직통버튼 | 긴급 레드 점멸 헤더<br>`🚨 긴급 출동분야` `⚡ 30분 출동절차` | **실시간 30분 긴급 타임라인**<br>출동완료 5스타 검증카드 |
| pipe-oneshot.com | 물길찾기<br>`hud` 탐지HUD | **다크 모드 콕핏 대시보드**<br>네온 시안 정밀 계측 진단 카드 | 콕핏 HUD 헤더 (`//` 제거 완료)<br>`정밀탐지` `스캔공정` `단가표` `탐지기록` | **가로형 터미널 콘솔 로그 피드**<br>레이더 스캔 시퀀스 |
| naoheg.com | 새집처럼<br>`clinic` 메디컬 | **스위스 미니멀 헤어라인 헤더**<br>가로형 메디컬 프로토콜 목록 (`01/04`) | 스위스 극세선 내비<br>`검수 항목` `클리닉 공정` `표준 요율표` | **세로형 정밀 클리닉 타임라인**<br>2열 스위스 미니멀 FAQ |
| amunsa.com | 손끝청소<br>`organic` 유기농 | **에디토리얼 매거진 중앙 헤더**<br>**벤토 그리드 (1 대형 피처 + 3 서브)** | 브랜드 중앙 정렬 매거진 내비<br>`공간 케어` `자연유래 공정` `살림 이야기` | 살림 매거진 인용문 후기<br>도트 리더 (Dot Leader) 요금표 |
| anclose.com | 끝마감청소<br>`brutal` 브루탈리즘 | **3px 블랙 솔리드 보더 & 옐로우 스티커**<br>가로형 브루탈리즘 스티커 스트립 | 볼드 스티커 블랙 헤더 (고대비 가독)<br>`⚡ 청소 분야` `💥 번개 공정` `💰 요금` | **청키 번호 스티커 박스 공정**<br>비뚤어진 스티커 배지 사례 |
| one-qfast.com | 원큐이사<br>`appish` 스마트앱 | **모바일 앱 세그먼트 탭 내비**<br>2열 가로형 와이드 모바일 앱 카드 | 토스/카카오 앱 세그먼트 탭<br>`이사 서비스` `진행 절차` `실시간 후기` | **모바일 앱 실시간 리뷰 피드**<br>3단 앱 요금제 박스 |
| uloung.com | 우렁이사<br>`luxe` 럭셔리 | **다크 차콜 & 샴페인 골드 바**<br>가로형 로만 럭셔리 리스티클 | 부티크 럭셔리 헤더 (한글화 완료)<br>`서비스` `진행과정` `요금기준` `진행사례` | **가로형 4단계 스테이지 플로우**<br>프라이빗 고객 추천서 |

---

## 뭘 고치려면 어디를 보나

| 하려는 것 | 고칠 곳 |
|---|---|
| 브랜드명·분야·전용 네비 라벨 | `apex-content.json` → `roots.<루트>.nav` |
| 전용 섹션 제목 문구 (h2) | `apex-content.json` → `roots.<루트>.headings` |
| 전용 상단 띠 문구 | `apex-content.json` → `roots.<루트>.topbar` |
| 서비스·요금·사례·FAQ·작업순서 원문 | `apex-content.json` → `specialties.<분야>` |
| 입체감 3D 이모지 / 배지 | `scripts/lib/apex-visuals.mjs` 의 `THEME_EMOJIS` + `themes.css` 의 `.dim-ico` |
| 후기 문장 | `review-pool.json` (업종별 배열) |
| 색·폰트·카드·레이아웃 변칙 (가로형/벤토/타임라인 등) | `themes.css` 의 `.t-<테마>` |
| 좌우 배치 대상·개수 | `apex-content.json` → `themes.<테마>.split` |
| 리빌 모션 | `motion.css` 의 `.js .t-<테마> [data-reveal]` |
| 섹션 순서 | `apex-content.json` → `layouts[].order` |
| 전화번호·폼 주소·CTA 문구 | `apex-content.json` → `cta.<업종>` |
| 여백·타이포·공통 컴포넌트 | `apex.css` |
| 히어로 사진 | `assets/hero/` 에 `배관1.png` 식으로 넣고 prepare 스크립트 실행 |
| 좌우 배치 대상·개수 | `apex-content.json` → `themes.<테마>.split` |
| 리빌 모션 | `motion.css` 의 `.js .t-<테마> [data-reveal]` |
| 섹션 순서 | `apex-content.json` → `layouts[].order` |
| 전화번호·폼 주소·CTA 문구 | `apex-content.json` → `cta.<업종>` |
| 여백·타이포·공통 컴포넌트 | `apex.css` |
| 히어로 사진 | `assets/hero/` 에 `배관1.png` 식으로 넣고 prepare 스크립트 실행 |

---

## 함정 — 여기서 다들 넘어진다

**1. 템플릿 엔진이 strict 다.** `micro-template.mjs` 는 데이터에 없는 변수를 만나면
조용히 빈 문자열을 넣지 않고 **던진다**. 파티셜에 `{{newVar}}` 를 추가하면 빌더의
`sectionData` 나 `renderTemplate` 호출부에도 반드시 같이 넣어야 한다.

**2. nginx 가 `/service` 를 `.html` 로 안 넘긴다.** `rewrite` 규칙은 `/숫자` 와
`/a/b` 2단 경로만 처리한다. 한 단계 경로는 404 다. 그래서 링크에 `.html` 을 그대로
쓴다(`/form.html`). 깔끔한 주소를 원하면 nginx 에 rewrite 를 추가해야 하는데,
**서버 변경은 운영자 확인을 받고 할 것.**

**3. 이사 견적 폼은 청소와 다르고, iframe 에 넣으면 안 된다.** nginx 에
`/go/quote`(청소, 코드 BtMoZvIUJs)와 `/go/move-quote`(이사, 코드 H4VMTQ4Rha)가
따로 있다. 섞으면 이사 리드가 청소 폼으로 간다.

**이사 폼은 `daum.Postcode` 주소검색을 쓰는데 `window.open` 팝업을 띄운다.**
iframe 안에서는 (특히 모바일) 그 팝업이 막혀 **주소 검색이 안 먹는다** —
상세주소 입력만 되니 겉보기엔 멀쩡해서 놓치기 쉽다. 남의 폼이라 밖에서 못 고친다.
그래서 `cta.<업종>.formMode` 로 갈랐다:
  - `embed`  우리 `/form/` 페이지에 iframe 으로 끼운다 (청소 — 주소 API 를 안 쓴다)
  - `direct` 외부 폼으로 바로 보낸다. `/form/` 페이지를 아예 안 만든다 (이사)
청소 폼에 나중에 주소검색이 붙으면 청소도 `direct` 로 바꿔야 한다.

**4. 서브도메인 자산을 끌어다 쓰지 말 것.** 청소 사진 500장(`apps/cleaning-ravi/public/cleaning`)과
배관 9장은 서브도메인 2만 개가 이미 쓰고 있다. apex 에 같은 이미지를 얹으면
"네트워크와 달라 보이게" 라는 목적이 무너진다. 스타일시트도 마찬가지 —
서브도메인은 `assets.<루트>/site/v4/styles.css` 를 쓴다.

**5. 루트에서 서브도메인으로 링크하지 말 것.** 루트가 서브도메인 2만 개를 가리키면
지금 의심받는 구조를 네이버에 그대로 확인시켜 준다. sitemap 에도 안 넣는다.

**6. 갤러리 CSS 스코프.** `preview-apex-gallery.mjs` 는 셀렉터마다 `.pv` 를 붙여
재사용한다. body 에 붙는 클래스(`.l-* .v-* .t-* .ttl-*`)는 **공백 없이** 이어붙여야
하고, `@keyframes` 는 손대면 안 된다. 새 body 클래스를 추가하면 프리픽서의 정규식
`/^\.(l-|v-|t-|ttl-)/` 도 같이 고칠 것.

**7. `grid-row: 1 / span N` + `gap`.** 좌우 배치에서 h2 를 여러 행에 걸칠 때 `row-gap`
이 살아 있으면 **빈 행마다 간격이 붙어 화면 몇 개 분량의 공백**이 생긴다.
지금은 `row-gap:0` 으로 막고 형제 `margin-top` 으로 간격을 준다. 건드리지 말 것.

**8. 리빌은 `.js` 가 있을 때만 숨긴다.** `page.html` head 의 인라인 스크립트가
`html` 에 `.js` 를 붙인다. 스크립트가 없으면 아무것도 안 숨겨서 그냥 다 보인다.
`[data-reveal]{opacity:0}` 을 `.js` 없이 쓰면 JS 실패 시 백지가 된다.

**9. 히어로 격자는 사진에도 있다.** CSS 무늬는 `blueprint`(모눈)와
`emergency`(하단 줄무늬) 둘뿐이다. 그런데 배관 사진 몇 장은 배경이 **타일 벽**이라
줄눈이 격자로 보인다. CSS 를 뒤져도 안 나오면 사진을 의심할 것.

**10. R2 는 immutable 이다.** 자산은 `site/<assetVersion>/` 에 올라가고 엣지에
1년 캐시된다. **같은 폴더에 덮어쓰면 되돌릴 수 없다.** CSS 를 고쳤으면
`apex-content.json` 의 `assetVersion` 을 올리고 새 폴더로 업로드해야 한다.
업로드 스크립트가 `--version` 과 `assetVersion` 을 대조해 준다.
`node scripts/upload-apex-assets-to-r2.mjs --version apex-vN`

**11. 글자색을 `--ink`/`--mute` 로 직접 박지 말 것.** 면 토큰
`--fg` / `--fg-mute` / `--fg-line` 만 쓴다. 어두운 밴드·연락 섹션·히어로에서
자동으로 뒤집힌다. 테마가 밴드 밝기를 바꾸면 그 테마에서 토큰만 다시 정한다.
고친 뒤에는 `node scripts/check-apex-contrast.mjs` 로 검증할 것 —
30개 면/글자 쌍의 WCAG 대비를 계산하고 4.5 미만이면 exit 1 이다.

**12. 변수 닫는 괄호 뒤에 CSS 괄호를 붙이지 말 것.** page.html 의 인라인 팔레트에서
마지막 값을 변수로 끝내고 바로 CSS 닫는 괄호를 붙이면, 템플릿 엔진이 괄호 셋을
한 태그로 먹어 **CSS 블록이 안 닫힌 채로 나간다.** 브라우저는 관대해서 그냥
넘어가지만 팔레트가 통째로 무효가 될 수 있다. 마지막 값 뒤에 세미콜론을 둘 것.
주석 안에도 변수 표기를 쓰면 안 된다 — 엔진이 주석을 구분하지 않는다.

**13. 대비는 눈으로 잡지 말 것.** `node scripts/check-apex-contrast.mjs` 가
빌드된 CSS 를 파싱해 명시도·!important·등장 순서대로 **실제 적용될 색**을 계산한다
(220쌍, 4.5 미만이면 exit 1). 손으로 면 구성을 적어 두는 방식은 테마가 카드
배경을 바꿀 때마다 어긋나 "어두운 배경 + 어두운 글씨"를 세 번 연속 놓쳤다.
**요소가 제 배경을 정하면 그 안은 새 면이다** — `--fg`/`--fg-mute` 를 같이
뒤집지 않으면 바깥 밴드의 글씨색이 그대로 흘러들어 안 보인다.

**14. bash heredoc 이 자주 깨진다.** 이 저장소에서 긴 CSS/JS 를 `cat <<'EOF'` 로
쓰다가 여러 번 깨졌다. 파일 쓰기는 에디터 도구를 쓰거나 `python -` 로 할 것.

---

## 아직 안 한 것

- [x] **배포** (2026-08-26) — `scripts/deploy-apex-sites.mjs`. 10개 루트 홈 200,
      폼 5개(`/form/`) 200, 배관 5개는 폼이 없어 `/form/` 404 가 정상이다.
      자산은 R2 `site/apex-v4`
- [x] **심볼릭 링크 4개 제거** (2026-08-26) — 배포 스크립트가 전송 전에 `-L` 로
      확인하고 링크만 지운다. 대상 서브도메인 4개는 142파일 그대로 무사.
      **이 단계를 빼면 tar 가 링크를 따라가 서브도메인 청소 사이트를 덮는다**
- [ ] **서치어드바이저 등록** — 지금 apex 로 Yeti 가 한 번도 안 온다(서브도메인
      107,076회 대 apex 0회). 인바운드 링크가 0이라 발견 경로가 없다. 등록이 사실상
      필수인데, **기존 102개 계정(2만 서브도메인 보유)에 얹으면 같은 묶음으로 보인다.**
      새 계정 하나를 파서 apex 10개만 넣는 쪽을 권함
- [ ] **후기·작업사례 교체** — 지금 값은 **지어낸 예시다.** 그대로 배포하면
      표시광고법상 거짓·과장 광고 소지가 있고, 지금 피하려는 저품질 판정의 표적이
      된다. 실제 기록으로 바꿔야 한다. 이름·날짜를 일부러 안 넣은 것도 그래서다
- [x] **커밋** (2026-08-26) — be64f8b

---

## 확인 안 된 가정

- apex 를 세우면 색인이 돌아온다는 보장은 없다. 생존군과 3:0 대 0:10 으로 갈리는
  유일한 항목이라 시도하는 것이지, 인과가 증명된 게 아니다
- 도메인 나이(30일)와 서브도메인 규모(루트당 2,000)는 apex 로 못 바꾼다.
  생존군은 최소 2년에 서브도메인 1개였다
- 웹폰트를 Google Fonts 에서 받는다. 한글 폰트라 용량이 있고 외부 의존이다.
  셀프호스팅으로 바꿀 수 있다
