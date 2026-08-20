# 네이버 구조화 데이터 가이드 — BreadcrumbList · 캐러셀(ItemList)

운영자가 전달한 네이버 서치어드바이저 공식 문서 발췌 (2026-08-20 저장).
이사 랜딩(moving-page-data.mjs 의 JSON-LD)이 이 가이드를 따른다.

> 두 마크업 모두 "검색결과 노출을 보장하지 않으며, 웹문서 분석 등에
> 보조적으로 활용"된다고 명시돼 있다.

## 사이트 이동 경로 (BreadcrumbList)

검색결과에 사이트 이동 경로를 나타낸다. 검색 사용자가 웹페이지의 위치를
이해하는 데 도움이 될 수 있다.

기본 가이드라인:
- 해당 페이지의 계층 구조를 **키워드로** 작성한다.
- 너무 긴 텍스트나 숫자·특수문자로만 구성되지 않도록 주의.
- **넓은 범위에서 시작해 점점 구체적으로** 순서대로 입력.
  예) 뉴스 > 스포츠 > 축구, 국내도서 > 소설 > 한국소설

속성 (schema.org BreadcrumbList):

| 속성 | 필수여부 | 설명 |
|---|---|---|
| name | 필수 | "top", "홈" 등 일반적인 단어가 아닌, 페이지를 잘 설명하는 텍스트 |
| position | 필수아님 | 계층 구조의 번호 |

JSON-LD 예제:

```html
<script type="application/ld+json">
{
 "@context": "https://schema.org",
 "@type": "BreadcrumbList",
 "itemListElement": [
  { "@type": "ListItem", "position": 1,
    "item": { "@id": "https://example.com/news.html", "name": "뉴스" } },
  { "@type": "ListItem", "position": 2,
    "item": { "@id": "https://example.com/news/sports.html", "name": "스포츠" } }
 ]
}
</script>
```

Microdata 로도 구현 가능 (ol > li[itemprop=itemListElement] + meta[itemprop=position]).

## 캐러셀 (ListItem / ItemList)

목록형 데이터를 캐러셀 형태로 표기한다.

기본 가이드라인:
- item 요소 하위에 {name, image, url} 을 작성(예제 1)하거나, item 없이
  ListItem 바로 밑에 작성(예제 2)할 수 있다.
- **1개 페이지에는 1개 ItemList 사용을 권장.**
- 개수가 적은 ListItem 은 사용하지 않는다.
- 요소 간 중복이 발생하지 않도록 주의.

이미지 가이드라인:
- 썸네일이 아닌 **원본 이미지**를 사용.
- 이미지 간 중복 금지.
- 해당 item 을 잘 나타내는 이미지 사용. **로고·기본 이미지·깨진 이미지 금지.**

속성 (schema.org ListItem):

| 속성 | 필수여부 | 설명 |
|---|---|---|
| name | 필수아님 | 각 item 의 이름 |
| image | **필수** | ImageObject 혹은 URL 포맷 |
| url | 필수아님 | 절대 경로로 입력 (상대 경로·단축 URL 금지) |
| item | 필수아님 | item 작성 시 image 는 필수. Thing 하위 모든 타입 가능 |
| position | 필수아님 | 목록 번호. Integer 포맷 |

JSON-LD 예제 1 (item 하위에 작성 — **이사 랜딩이 쓰는 형태**):

```html
<script type="application/ld+json">
{
  "@context": "http://schema.org",
  "@type": "ItemList",
  "itemListElement": [
    { "@type": "ListItem", "position": "1",
      "item": { "@type": "Organization", "name": "라인",
        "image": "https://example.com/photos/listitem-1.jpg",
        "url": "https://example.com/listitem-url-1" } },
    { "@type": "ListItem", "position": "2",
      "item": { "@type": "Organization", "name": "네이버 랩스",
        "image": "https://example.com/photos/listitem-2.jpg",
        "url": "https://example.com/listitem-url-2" } }
  ]
}
</script>
```

예제 2 는 item 래퍼 없이 ListItem 에 name/image/url/position 을 바로 둔다.
Microdata 형식도 지원된다 (ol[itemtype=ItemList] > li[itemprop=itemListElement]).

## 이사 랜딩 적용 현황

- BreadcrumbList: `지역명 > 키워드` 2단계 — "홈" 같은 일반 단어 없음 ✓
- ItemList: 업체 5곳, item{Organization, name, image=R2 compare1~5 원본, url=CPA 절대경로} ✓
- 페이지당 ItemList 1개 ✓ / 이미지·업체 간 중복 없음 ✓
