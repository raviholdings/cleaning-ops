/**
 * 배관 접수폼 수신 Worker.
 *
 * 오리진은 정적 파일만 서빙해서 POST 를 받을 곳이 없다. 10개 루트가 전부
 * Cloudflare 프록시를 지나므로, 존마다 `*.루트/api/lead` 라우트에 이 Worker 를
 * 붙이면 오리진·페이지 재배포 없이 접수 창구가 생긴다.
 *
 *   페이지 폼(piping.js) --POST /api/lead--> 이 Worker
 *       -> Supabase REST 로 lead_submissions insert   (저장)
 *       -> 텔레그램 sendMessage                        (알림)
 *       -> {ok:true} 응답
 *
 * 저장이 성공하면 텔레그램이 실패해도 접수는 성공으로 답한다 (알림은 부가 기능).
 * 저장이 실패하면 사용자에게 재시도를 안내한다 — 리드를 조용히 잃지 않기 위해서다.
 */

const TABLE = 'lead_submissions';
const GROUP_KEY = 'piping-ravi';
const SERVICE_TYPE = 'form:piping';

/** 봇 트래픽. 비콘 수집기(ingest-lead-beacon)와 같은 기준을 쓴다. */
const BOT_UA = /bot|crawler|spider|slurp|yeti|bingpreview|facebookexternalhit|headlesschrome|python-requests|curl\/|wget/i;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
  },
});

const digits = (v) => String(v || '').replace(/\D+/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

function validate(payload) {
  // 허니팟: 사람은 절대 못 채우는 칸. 채워져 있으면 봇이다.
  // 봇이 눈치채고 우회하지 않도록 오류가 아니라 성공으로 답하되 저장은 안 한다.
  if (clean(payload.company, 100)) return { drop: true };

  const name = clean(payload.name, 60);
  const phone = digits(payload.phone);
  const message = clean(payload.message, 2000);

  if (name.length < 2) return { error: '이름을 입력해 주세요.' };
  if (phone.length < 9 || phone.length > 11) return { error: '연락처를 정확히 입력해 주세요.' };
  if (!message) return { error: '문의내용을 입력해 주세요.' };
  if (payload.consent !== true) return { error: '개인정보 수집 및 이용에 동의해 주세요.' };

  return { name, phone, message };
}

async function insertLead(env, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/*
 * 알림은 "왔다"와 "누구"까지만 보낸다 (운영자 확정 2026-08-24).
 * 연락처·주소·문의내용은 텔레그램에 남기지 않고 관리자 페이지에서 확인한다.
 */
async function notifyTelegram(env, row) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `🔧 배관 신규 접수\n이름: ${row.customer_name}`,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return json({ ok: true });
    if (request.method !== 'POST') return json({ ok: false, error: 'POST 만 받습니다.' }, 405);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, 400);
    }

    const ua = request.headers.get('user-agent') || '';
    if (BOT_UA.test(ua)) return json({ ok: true });

    const checked = validate(payload);
    if (checked.drop) return json({ ok: true });
    if (checked.error) return json({ ok: false, error: checked.error }, 400);

    const url = new URL(request.url);
    const row = {
      group_key: GROUP_KEY,
      host: clean(payload.sourceDomain, 200) || url.hostname,
      site_url: clean(payload.pageUrl, 500),
      area_name: clean(payload.area, 200),
      customer_name: checked.name,
      customer_phone: checked.phone,
      service_type: SERVICE_TYPE,
      request_notes: checked.message,
      referer: clean(payload.referrer, 500),
      user_agent: ua.slice(0, 500),
    };

    try {
      await insertLead(env, row);
    } catch (error) {
      console.error('lead insert 실패', error.message);
      return json({ ok: false, error: '접수 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
    }

    // 저장이 끝났으면 접수는 성공이다. 알림은 응답을 붙잡지 않고 뒤에서 보낸다.
    ctx.waitUntil(notifyTelegram(env, row).catch((e) => console.error('telegram 실패', e.message)));

    return json({ ok: true });
  },
};
