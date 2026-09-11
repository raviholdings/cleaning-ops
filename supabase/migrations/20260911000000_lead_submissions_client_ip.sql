-- lead_submissions 에 방문자 IP 칸을 추가한다.
--
-- 왜: 2026-09-11 에 silver-bamboo.daddul.com 에 여러 번 찍힌 비콘이 누구인지
-- 알아내려고 시각을 맞춰 nginx 로그를 뒤져야 했다. IP 가 같이 남으면 한 번의
-- 쿼리로 끝난다.
--
-- 타입이 inet 인 이유: 대역 조회가 된다 (where client_ip << '222.239.104.0/24').
-- 값이 IP 형식이 아니면 insert 가 실패하므로, 넣는 쪽(Worker·비콘 수집기)에서
-- 형식을 검사하고 아니면 null 을 넣는다.
--
-- ⚠ 이 값은 Cloudflare 의 CF-Connecting-IP 다. 오리진이 공개돼 있어 Cloudflare 를
--   건너뛰고 직접 요청하면 위조할 수 있다. 참고용이지 증거가 아니다.

begin;

alter table public.lead_submissions
  add column if not exists client_ip inet;

comment on column public.lead_submissions.client_ip is
  '방문자 IP (Cloudflare CF-Connecting-IP). 위조 가능하므로 참고용. 2026-09-11 추가.';

-- 특정 IP 로 찾는 조회가 주 용도다. 6,700행 규모라 인덱스가 꼭 필요하진 않지만
-- 앞으로 쌓이므로 미리 둔다.
create index if not exists idx_lead_submissions_client_ip
  on public.lead_submissions (client_ip)
  where client_ip is not null;

commit;
