# 오리진 nginx 지도 (읽은 날 2026-09-01)

`/etc/nginx/conf.d/cleaning-sites.conf` 144줄을 그대로 읽고 정리한 것이다.
SSM 출력이 24KB 에서 잘려 세 번 나눠 받았다 — 다음에 또 읽지 않아도 되게 여기 적는다.

- 인스턴스 `i-039361b55ae33808b` (ap-northeast-2), `AWS_PROFILE=cleaning-ops`
- 웹루트 `/srv/group-page-origin/sites/<host>/`
- 공용 자산 `/srv/group-page-origin/shared/`
- 디스크 60GB 중 41GB 사용, 여유 20GB · 메모리 1.9GB 중 여유 734MB (2026-09-01)
- `sites/` 아래 폴더 **20,010개** — `du -sh` 를 걸면 2분이 지나도 안 끝난다. 걸지 말 것

## 새 도메인은 nginx 를 안 고쳐도 된다

이게 제일 중요하다.

    server_name _;                                  # 80·443 둘 다 default_server
    root /srv/group-page-origin/sites/$host;
    index index.html;

**Host 헤더로 폴더를 찾는 와일드카드**다. `sites/<도메인>/` 폴더만 만들면 그 도메인이
바로 뜬다. server 블록을 새로 넣을 필요도, nginx 를 다시 읽힐 필요도 없다.

거꾸로 말하면 폴더가 없으면 404 다. 도메인이 Cloudflare 를 지나 여기 닿아도
폴더가 없으면 `HTTP 404 · Server: cloudflare` 로 보인다 (2026-09-01 실제로 그랬다).

## server 블록은 둘, 내용이 같다

80(평문)과 443(TLS)에 같은 규칙이 들어 있다. **한쪽만 고치면 반쪽만 바뀐다.**
443 쪽에만 있는 것은 인증서 세 줄과 `/_e`·`/go/*` 뿐이다.

## 파일을 어떻게 찾나

    rewrite ^/$         /index.html  last;      # /            -> index.html
    rewrite ^/([0-9]+)$ /$1.html     last;      # /123         -> 123.html   (배관 대량배포)
    if (!-e $request_filename) {
      rewrite ^/(.+)/([^/.]+)$ /$1/$2.html last;   # /a/b     -> /a/b.html
    }

브랜드 사이트는 `/foo/index.html` 꼴이라 `index index.html` 이 받는다.
끝에 슬래시가 없는 주소(`/foo`)는 마지막 규칙이 `/foo.html` 로 바꾸려다 없으면 404 다 —
링크 끝에 슬래시를 붙여 굽고 있으므로 문제 없다.

## gzip — .html.gz 를 미리 만들어 올린다

    gzip_static always;     # $uri.gz 를 먼저 찾는다
    gunzip on;              # gzip 을 못 받는 클라이언트에는 풀어서 준다
    gzip on;                # .gz 가 없는 것(sitemap.xml 등)은 그때그때 압축
    gzip_types text/html text/css application/xml application/rss+xml application/json;

`always` 라서 `.html.gz` 만 있어도 되고, `gunzip on` 이 없으면 그런 요청이 404 가 된다.
배관·청소는 `.html.gz` 만 올린다 (docs/GZIP-ASSET-DEPLOY 참고).
브랜드 사이트도 같은 방식으로 올리면 디스크와 대역을 아낀다.

## 공용 자산은 shared 로 샌다

    location /img/                     -> /srv/group-page-origin/shared/img/
    location ~ ^/(favicon\.ico|favicon\.svg|favicon-32\.png|apple-touch-icon\.png)$
                                       -> /srv/group-page-origin/shared/

### 파비콘은 사이트별로 고쳐 뒀다 (2026-09-01)

원래는 `/favicon.ico` 가 무조건 shared 로 가서 브랜드 사이트 다섯이 대량배포
2만 개와 같은 아이콘을 물었다. 아래처럼 바꿨다.

    location ~ ^/(favicon\.ico|...)$ {
      root /srv/group-page-origin/sites/$host;   # 사이트 것을 먼저
      try_files $uri @shared_icon;               # 없으면 공용으로
      ...
    }
    location @shared_icon {
      root /srv/group-page-origin/shared;
      try_files $uri =404;
      ...
    }

**기존 2만 개는 그대로다** — 자기 폴더에 파비콘이 없으니 `@shared_icon` 으로 떨어진다.
`sites/<host>/favicon.ico` 를 놓은 사이트만 자기 것을 쓴다.

백업: `cleaning-sites.conf.bak-favicon-20260901063043`.
80·443 두 블록 모두 고쳤고 `nginx -t` 통과 후 reload 했다.

## 그 밖

    location = /_e   { access_log /var/log/nginx/lead.log lead; return 204; }
    location = /go/quote|/go/c1|/go/c2|/go/c3|/go/move-quote  -> replyalba.com 302

`/_e` 는 리드 비콘 수집구다. `log_format lead` 로 시각·호스트·`?t=`·`?p=`·UA 만 남긴다.

**`/api/lead` 는 nginx 에 없다.** 접수폼은 Cloudflare Worker 가 존마다 라우트로 받는다
(`workers/brand-lead`). 오리진은 정적 파일만 준다.

## TLS

    ssl_certificate     /etc/nginx/ssl/origin.crt;
    ssl_certificate_key /etc/nginx/ssl/origin.key;

주석에 "Cloudflare SSL 모드가 full 이라 도메인이 맞는지는 검사하지 않는다.
full (strict) 로 올릴 땐 Cloudflare Origin CA 인증서로 교체한다" 고 적혀 있다.
**즉 새 도메인에 인증서를 따로 받을 필요가 없다.** Cloudflare 가 앞에서 끊어 준다.

## 백업이 다섯 개 쌓여 있다

    cleaning-sites.conf.bak-20260813
    cleaning-sites.conf.bak-ext-20260819054248
    cleaning-sites.conf.bak-go
    cleaning-sites.conf.bak-lead-20260818022721
    cleaning-sites.conf.bak-ua-1787203281

고칠 일이 있으면 같은 방식으로 하나 더 뜨고 시작한다.
