# 이사 프로젝트 설계 (moving-ravi)

2026-08-18 운영자와 확정한 값. 착수 전에 이 문서로 맞춰본다.
청소(`cleaning-ravi`)는 **건드리지 않는다.**

## 확정된 값

| 항목 | 값 |
|---|---|
| `group_key` | `moving-ravi` |
| 앱 폴더 | `apps/moving-ravi/` |
| 템플릿 | `apps/moving-static/templates-moving/` |
| 원본 디자인 | `C:\Users\LD\Desktop\관련 폴더\MOVING~1\moving_cpa_landing.html` |
| 페이지 수 | **서브도메인당 50장** |
| 주소 | `/이사/{지역}-{키워드}` — 한글, 구분자 `-` |
| 이미지 | R2 `moving/` · 500장 (25종 × 20장) |
| 자산(CSS·JS) | R2 `site/moving-v1/` |
| 업체 수 | **5곳** |

## 업체 5곳

원본 HTML 에는 카드가 7개("7곳")였다. 그중 둘(이사방청소 / 24번가 이사)은
링크를 받지 못했고 운영자가 5개로 확정했다. 문구도 "5곳" 으로 바꾼다.

| 업체 | CPA 링크 |
|---|---|
| 이사타임 | `https://replyalba.com/pt/DpJPm14nB5` |
| 포장이사 24번가 | `https://replyalba.com/pt/ELDSfIhN3C` |
| 다이사 | `https://replyalba.com/pt/TvEscQQdOx` |
| 서경석의 이사방 | `https://replyalba.com/pt/10OydhStxiu` |
| 모두이사 | `https://replyalba.com/pt/H4VMTQ4Rha` |

`vendorCount = 5`. 히어로의 h2 유도 문구가 이 값을 쓰므로 자동으로
"아래 5곳 중 …" 이 된다.

## 신청폼

모두이사 코드(`H4VMTQ4Rha`)를 쓴다. 청소와 같은 iframe + iFrameResize 구조다.

```html
<iframe name="ifrm_icode" id="ifrCCAl" scrolling="no" frameborder="0" width="100%"
        src="https://replyalba.com/intros/_frm/index.php?code=H4VMTQ4Rha"></iframe>
```

청소와 마찬가지로 **입력값은 제휴사로만 간다.** 우리 DB 에는 "넘어갔다" 만
남는다 (`/_e` 비콘, docs/LEAD-BEACON.md 참고). 폼 id 가 `ifrCCAl` 로 같으므로
비콘 코드도 그대로 동작한다.

## 조합 재고

지역은 청소와 같은 72,938개(읍·면·동·리)를 쓴다.

```
키워드 96개 × 지역 72,938 = 7,002,048 조합
서브도메인 10,000 × 50장  =   500,000 사용  (7%)
```

여유가 크다. 나중에 131장이든 700장이든 늘릴 수 있다.
(청소는 18키워드라 131장이 상한이었다 — 재고의 99.8% 를 썼다.)

## 이미지

`scripts/rename-moving-images.mjs` 로 이름을 카탈로그 규칙에 맞췄다.

```
001_포장이사_01.webp   =  전체순번_유형_그유형에서몇번째
```

청소가 `001_거실_01.webp`(공간 10곳 × 50장)인 것과 같은 구조다. 이사는
유형 25종 × 20장. 그래서 `merged-page-data.mjs` 의 `imageAt()`/`pickInRoom()`
을 그대로 쓸 수 있다 — 상수만 바꾸면 된다.

원본: `C:\Users\LD\Desktop\moving-ads-500-centered (2)\moving-ads-500-centered-webp\renamed\`
총 45MB.

## 착수 순서

1. `appDir`·이미지 경로 옵션화 — 지금 `apps/cleaning-ravi` 와 `/cleaning/` 이
   박혀 있다. 기본값을 지금 값으로 두면 청소는 영향 없다.
2. `apps/moving-ravi` 뼈대 + 키워드 96개 (`data/keywords/moving.txt`)
3. 템플릿 이식 — 인라인 CSS 8.5KB 를 R2 로 뺀다. 안 빼면 50만 장에 그대로 복제된다.
4. 미리보기 한 장 → 운영자 확인
5. **주소 체계** — 여기가 제일 크다. 아래 참고.

## 주소 체계가 왜 별도 작업인가

청소는 `/1.html` ~ `/131.html` 이다. 이사는 `/이사/{지역}-{키워드}` 로 간다.
바뀌는 곳이 한둘이 아니다.

| | 청소 | 이사 |
|---|---|---|
| 파일명 | `1.html.gz` | 한글 경로를 어떻게 파일로 떨굴지 |
| nginx | `rewrite ^/([0-9]+)$ /$1.html` | `/이사/...` 매핑 |
| 사이트맵 | `/1` ~ `/131` | 새 주소 |
| 수집요청 | `page_count` 로 URL 생성 | 지역+키워드로 생성 |
| 색인 조사 | URL 패턴 판별 | 새 패턴 |
| 카탈로그 | `(사이트, 번호) → (지역, 키워드)` | 역방향도 필요 |

**청소 131만 장은 주소를 바꾸지 않는다.** 색인이 94% 붙어 있어서 주소를
바꾸면 전부 날아간다. 새 체계는 이사·철거에만 적용한다.

## 철거는 나중에

키워드 173개는 `data/keywords/demolition.txt` 에 저장해 뒀다.
조합 재고 12,618,274 (1,261장/사이트). 랜딩페이지는 이사와 별도로 만든다.
