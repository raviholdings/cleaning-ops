# 견적 폼 접수 기록

## 왜 이런 방식인가

Free Quote 섹션의 폼은 우리 폼이 아니다. 제휴사 페이지를 iframe 으로 끼운 것이다.

```html
<iframe src="https://replyalba.com/intros/_frm/index.php?code=wKSpzJlHMP">
```

방문자가 넣은 이름·전화번호는 전부 replyalba 서버로 간다. 브라우저 동일 출처
정책 때문에 우리 스크립트는 그 iframe 안을 읽을 수 없다. 그래서
`lead_submissions` 가 0 행이었다. 데이터가 들어올 경로 자체가 없었다.

제휴사가 우리에게 보내주는 신호도 없다. 실측으로 확인했다.

```
부모가 받은 postMessage 1건
  [https://replyalba.com] [iFrameSizer]ifrCCAl:762:1080:init

replyalba 페이지의 postMessage 코드: 없음
```

유일하게 오는 것이 iFrameResize 의 높이 메시지다. 여기에 `:init` 이 붙는데,
iframe 안에서 **새 문서가 뜰 때마다** 온다. 폼은 `action` 없이 `method=post`
라 자기 자신에게 제출한다. 즉 제출 = 새 문서 = `:init` 한 번 더.

## 정확도의 한계

이 신호는 "제출 성공" 이 아니라 "화면이 다음으로 넘어감" 이다. 입력값 검증에
걸려 오류 화면이 떠도 `:init` 이 온다. 그래서 이벤트 이름도 `submit` 이 아니라
`advance` 로 뒀다. **실제 접수 건수의 상한으로 읽어야 한다.**

정확한 건수가 필요하면 제휴사에서 전환 리포트를 받아야 한다. 우리 식별자는
`code=wKSpzJlHMP` 다.

## 구조

정적 사이트라 백엔드가 없다. nginx 가 받아 로그만 남기고, 나중에 DB 로 옮긴다.

```
브라우저  ──sendBeacon──>  /_e?t=advance&p=/37.html
nginx     ──204──>         /var/log/nginx/lead.log
스크립트  ──일 1회──>       lead_submissions
```

### 1. nginx (서버에 적용 필요)

`/etc/nginx/conf.d/cleaning-sites.conf` 의 server 블록 안에 넣는다.

```nginx
# 견적 폼 이벤트 수집. 본문 없이 204 만 주고 접근 로그에 남긴다.
log_format lead '$time_iso8601\t$host\t$arg_t\t$arg_p';

location = /_e {
    access_log /var/log/nginx/lead.log lead;
    return 204;
}
```

`log_format` 은 http 블록에 있어야 한다. server 안에 두면 nginx 가 뜨지 않는다.

로그 회전은 기본 logrotate 가 `/var/log/nginx/*.log` 를 잡으므로 따로 설정할 것이 없다.

### 2. 수집

```bash
node scripts/ingest-lead-beacon.mjs --dry-run
node scripts/ingest-lead-beacon.mjs
```

## 확인 방법

배포 뒤 아무 서브도메인이나 열고 폼을 한 번 제출해 본 다음:

```bash
aws ssm send-command --instance-ids i-039361b55ae33808b \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["tail -5 /var/log/nginx/lead.log"]'
```

`view` 한 줄과 `advance` 한 줄이 보이면 정상이다.
