# gzip + 외부 자산 배포

2026-08-13 적용. 페이지 크기를 47.6KB 에서 5.5KB 로 줄인 작업의 기록과 운영 지침.

---

## ⚠️ 131 장으로 늘릴 때 반드시 읽을 것

지금 배포 명령에는 **`--no-feeds`** 가 붙어 있다.

```bash
node scripts/build-and-deploy-sites.mjs --renderer static --templates templates-merged \
  --extend merged --gzip --no-feeds ...
```

이 플래그는 `sitemap.xml` · `rss.xml` · `robots.txt` 를 **다시 만들지 않는다.** 서버에
있던 파일이 그대로 남는다. 페이지 본문만 바뀌는 배포에서 이걸 다시 쓰면 sitemap 의
`<lastmod>` 가 배포일로 갱신되어 **100만 개 URL 의 수정일이 하루에 몰려 바뀐다.**
네이버가 그걸 어떻게 볼지 알 수 없어(재크롤링 유도 vs 품질 의심) 건드리지 않기로 했다.

**그런데 사이트당 페이지 수를 100 → 131 로 늘릴 때는 사정이 다르다.**

- 사이트맵에 101 개 URL 만 적혀 있다. 새로 만든 `101.html` ~ `131.html` 이 빠진다
- 네이버가 사이트맵으로 발견하지 못하므로 수집요청에만 의존하게 된다

**그때는 `--no-feeds` 를 빼야 한다.** 그 배포에서는 URL 이 실제로 늘어나므로
`lastmod` 가 갱신되는 것이 오히려 정직하다.

```bash
# 131 장으로 늘리는 배포 — --no-feeds 없음
node scripts/build-and-deploy-sites.mjs --renderer static --templates templates-merged \
  --extend merged --gzip --chunk-sites 250 --chunk-retries 3 \
  --from-order N --to-order M
```

페이지 수는 `naver_project_domains.page_count` 가 정한다. 131 로 늘리려면 그 값을
먼저 바꿔야 하고, 그러면 `sync-naver-project-page-catalog.mjs` 도 다시 돌려야
카탈로그가 맞는다. 조합 재고는 1,312,884 개뿐이라 **131 장이 상한**이다
([INDEX-CHECK-HANDOVER.md](INDEX-CHECK-HANDOVER.md) 참고).

---

## 무엇을 바꿨나

| | 전 | 후 |
|---|---|---|
| 페이지 하나 | 47,594 B | **5,541 B** (8.6배) |
| 10,000 사이트 | 44.8 GB | **4.6 GB** |
| 100 사이트 배포 | — | 102초 (빌드 12 + 전송 90) |

세 가지를 동시에 했다.

1. **CSS 를 R2 로** — `<style>{{{pageCss}}}</style>` (21,362 B) 를 `<link>` 한 줄로
2. **JS 를 R2 로** — 인라인 `<script>` (3,836 B) 를 `<src>` 한 줄로
3. **gzip 저장** — `.html` 대신 `.html.gz` 만 만들어 nginx 가 그대로 내보낸다

## 자산 파일

원본은 `apps/cleaning-static/templates-merged/assets/` 에 있다.

```
assets/styles.css   21,362 B   (templates-merged/styles.css 와 같은 내용)
assets/app.js        3,836 B   (갤러리 회전 + 이미지 캐러셀)
```

올리는 명령:

```bash
node scripts/upload-site-assets-to-r2.mjs --dry-run   # 확인
node scripts/upload-site-assets-to-r2.mjs             # 실제 업로드
```

버킷 `cleaning-assets` 의 `site/<버전>/` 아래로 올라가고, 루트도메인 10 개의
`assets.<루트>` 가 같은 버킷을 본다. 즉 **한 번 올리면 10 개 도메인 전부에 적용된다.**

### 버전을 나누는 이유

`site/v1/styles.css` 처럼 버전 폴더를 쓴다. 고정 이름이면 내용을 고쳐도 Cloudflare 와
브라우저 캐시에 옛 파일이 남아 새 페이지와 섞인다. 캐시를 `immutable` 로 길게 잡는
대신, 바꿀 때는 새 버전으로 올리고 템플릿 경로만 옮긴다.

```bash
# CSS 를 고쳤을 때
PUBLIC_ASSET_VERSION=v2 node scripts/upload-site-assets-to-r2.mjs --version v2
# 그리고 재배포 (템플릿이 {{assetVersion}} 를 읽는다)
PUBLIC_ASSET_VERSION=v2 node scripts/build-and-deploy-sites.mjs ...
```

버전 기본값은 `scripts/lib/merged-page-data.mjs` 의 `ASSET_VERSION` 이고
`PUBLIC_ASSET_VERSION` 으로 덮어쓴다.

## nginx 설정 — 여기서 두 번 걸렸다

`/etc/nginx/conf.d/cleaning-sites.conf` (백업: `.bak-20260813`)

```nginx
gzip_static always;
gunzip on;

location / {
  rewrite ^/$         /index.html  last;
  rewrite ^/([0-9]+)$ /$1.html     last;
}
```

**함정 ① `try_files` 를 쓰면 안 된다.** 원래 설정은
`try_files $uri $uri.html $uri/index.html =404;` 였는데, `try_files` 는 **실제 파일이
있어야** 통과한다. `.html` 을 지우고 `.html.gz` 만 두면 여기서 전부 404 가 난다.
파일 찾기를 `gzip_static` 에 맡기고 경로 정리만 `rewrite` 로 한다.

**함정 ② `gzip_static on` 이 아니라 `always` 여야 한다.** `on` 이면 gzip 을 받을 수
있다고 선언한 클라이언트에게만 `.gz` 를 준다. 그렇지 않은 클라이언트는 원본
`.html` 을 찾다가 404 를 받는다. `always` 면 무조건 `.gz` 를 꺼내 쓰고, 그때
`gunzip on` 이 풀어서 내보낸다. **`gunzip on` 만 넣고 `on` 을 쓰면 안 통한다.**

검증은 8080/8082 포트에 임시 server 블록을 만들어 했다. 경로 3 가지
(`/1.html`, `/1`, `/`) × 클라이언트 2 가지(gzip 받음/못 받음) 여섯 경우 전부 200 을
확인한 뒤에 운영에 넣었다. **설정을 바꿀 때는 같은 방식으로 먼저 시험할 것.**

## 배포 순서 — 뒤집으면 사이트가 죽는다

1. **nginx 설정 먼저.** 이 단계만으로는 아무것도 안 바뀐다. `.gz` 가 없으면 평문을
   쓰기 때문이다. 그래서 안전하다
2. **자산을 R2 에 올린다**
3. **`--gzip --no-feeds` 로 배포.** `.html.gz` 가 기존 `.html` **옆에** 쌓인다.
   nginx 는 `.gz` 를 우선 쓰므로 이 순간부터 새 페이지가 나간다
4. **실제로 열리는지 확인**
5. **옛 `.html` 삭제**

3 번에서 디스크가 잠깐 늘어난다(사이트당 4.9MB → 6.0MB). 60GB 중 47GB 를 쓰고 있어
전량을 한꺼번에 하면 넘칠 수 있다. 계정 구간을 나눠서 하고, 중간에 5 번을 끼우면 된다.

### 옛 .html 지우기

```bash
ssh ... 'sudo find /srv/group-page-origin/sites -name "*.html" \
           -path "*/<호스트패턴>/*" -delete'
```

**`.html.gz` 는 `-name "*.html"` 에 안 걸린다** (확장자가 `.gz`). 그래도 실행 전에
`-delete` 를 빼고 `| head` 로 먼저 확인할 것.

## VM 작업과 겹칠 때

배포와 충돌하는 건 **소유확인의 사전점검** 하나뿐이다.
`verify-naver-searchadvisor-sites.mjs` 는 계정을 시작할 때 그 계정의 전 도메인에
curl 을 날려 메타태그를 확인하는데(`filterLiveDomains`), 하필 그 순간 파일이
교체되면 "메타태그 없음 → 재배포 필요" 로 판정해 **건너뛴다.** 손실은 아니지만
그 계정 진행분이 날아간다.

- **수집요청은 겹치지 않는다.** 우리 페이지를 열어보지 않는다
  (`checkPostExists` 는 `--preflight` 를 줬을 때만 돌고, 러너는 안 준다)
- **배포는 HaiIP 를 안 쓴다.** AWS SSM 으로 붙으므로 VM 들의 IP 와 무관하다

즉 **소유확인이 도는 계정 구간만 피하면 된다.**

## 되돌리기

- nginx: `sudo cp /etc/nginx/conf.d/cleaning-sites.conf.bak-20260813 /etc/nginx/conf.d/cleaning-sites.conf && sudo nginx -t && sudo systemctl reload nginx`
- 템플릿: git 에 있다
- 배포: 옛 `.html` 을 안 지웠다면 `.html.gz` 만 지우면 원래대로 돌아간다
