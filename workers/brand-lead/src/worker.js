/**
 * 브랜드 사이트 5개의 접수폼 수신 Worker.
 *
 * 배관 대량배포용(workers/piping-lead)과 따로 둔다. 도메인도 다르고 넣는
 * group_key 도 다르며, 무엇보다 그쪽은 이미 돌고 있어서 건드릴 이유가 없다.
 *
 * 알림은 다섯 사이트가 **한 곳으로** 간다 (운영자 지시 2026-08-31).
 * TELEGRAM_CHAT_ID 를 배관 Worker 와 같은 값으로 넣으면 같은 방으로 온다.
 * 대신 어느 브랜드에서 왔는지를 첫 줄에 적는다 — 안 그러면 다섯이 섞여서
 * 어느 사이트 손님인지 알 수가 없다.
 *
 *   페이지 폼(app.js) --POST /api/lead--> 이 Worker
 *       -> Supabase REST 로 lead_submissions insert   (저장)
 *       -> 텔레그램 sendMessage                        (알림)
 *       -> {ok:true} 응답
 *
 * 저장이 성공하면 텔레그램이 실패해도 접수는 성공으로 답한다 (알림은 부가 기능).
 * 저장이 실패하면 사용자에게 재시도를 안내한다 — 리드를 조용히 잃지 않기 위해서다.
 */

const TABLE = 'lead_submissions';

/*
 * 다섯을 한 group_key 로 묶는다. 알림이 한 방으로 오는 것과 같은 이유로
 * 관리자 화면에서도 한 목록으로 보는 편이 낫다. 어느 브랜드인지는
 * service_type 으로 갈린다 (form:brand-dream …).
 */
const GROUP_KEY = 'brand-ravi';

/*
 * 폼이 보내는 project 값만 받는다. 모르는 값이면 저장하지 않는다 —
 * 아무 문자열이나 받으면 남이 우리 표에 마음대로 행을 넣을 수 있다.
 */
const BRANDS = {
  'brand-dream': '드림컴뚜러',
  'brand-thunder': '썬더배관',
  'brand-mole': '비버배관',
  'brand-ssak': '싹쓰리배관',
  'brand-dosa': '하수구도사',
};

/** 봇 트래픽. 비콘 수집기(ingest-lead-beacon)와 같은 기준을 쓴다. */
const BOT_UA = /bot|crawler|spider|slurp|yeti|bingpreview|facebookexternalhit|headlesschrome|python-requests|curl\/|wget/i;

/* 접수는 우리 도메인 5개(와 그 서브도메인)에서만 받는다. */
const ROOT_DOMAINS = [
  'dreamcome.kr', 'thunderdrain.kr', 'beaverpipe.kr', 'ssac3.kr', 'dosadosa.kr',
];

function allowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname;
    const ok = ROOT_DOMAINS.some((r) => host === r || host.endsWith(`.${r}`));
    return ok ? origin : null;
  } catch {
    return null;
  }
}

const json = (body, status = 200, origin = null) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    ...(origin ? { 'access-control-allow-origin': origin, 'vary': 'Origin' } : {}),
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
  },
});

/*
 * IP 당 접수 횟수 제한. KV·Durable Object 바인딩 없이 Cache API 로 센다 —
 * 콜로(엣지 거점)별로 세므로 정확한 전역 카운터는 아니고, 한 곳에서 쏟아지는
 * 것을 막는 용도다. 정밀한 제어가 필요하면 Cloudflare Rate Limiting 룰을 쓴다.
 *
 * 사람은 한 번 접수하면 끝이라 창 안에서 여러 건이면 이미 비정상이다.
 */
const RATE_LIMIT = 20;       // 창 안에서 허용할 접수 수 (통신사 NAT 로 한 IP 를 여럿이 쓰는 경우까지 감안)
const RATE_WINDOW_SEC = 600; // 창 길이(초) = 10분

async function overRateLimit(request, ctx) {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return false;
  const key = new Request(`https://ratelimit.invalid/lead/${encodeURIComponent(ip)}`);
  const cache = caches.default;
  let count = 0;
  try {
    const hit = await cache.match(key);
    if (hit) count = Number(await hit.text()) || 0;
  } catch {
    return false; // 카운터가 고장 나도 접수를 막지는 않는다
  }
  if (count >= RATE_LIMIT) return true;
  ctx.waitUntil(cache.put(key, new Response(String(count + 1), {
    headers: { 'cache-control': `max-age=${RATE_WINDOW_SEC}` },
  })).catch(() => {}));
  return false;
}

const digits = (v) => String(v || '').replace(/\D+/g, '');
const clean = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

function validate(payload) {
  // 허니팟: 사람은 절대 못 채우는 칸. 채워져 있으면 봇이다.
  // 봇이 눈치채고 우회하지 않도록 오류가 아니라 성공으로 답하되 저장은 안 한다.
  if (clean(payload.company, 100)) return { drop: true };

  const name = clean(payload.name, 60);
  const phone = digits(payload.phone);
  const message = clean(payload.message, 2000);

  // 폼이 보낸 project 가 우리 다섯 중 하나여야 한다.
  const brand = BRANDS[clean(payload.project, 40)];
  if (!brand) return { drop: true };

  if (name.length < 2) return { error: '이름을 입력해 주세요.' };
  if (phone.length < 9 || phone.length > 11) return { error: '연락처를 정확히 입력해 주세요.' };
  if (!message) return { error: '문의내용을 입력해 주세요.' };
  if (payload.consent !== true) return { error: '개인정보 수집 및 이용에 동의해 주세요.' };

  return { name, phone, message, brand, project: clean(payload.project, 40) };
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
async function notifyTelegram(env, row, brand) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      // 다섯이 한 방으로 오므로 어느 브랜드인지가 첫 줄에 있어야 한다.
      text: `🔧 ${brand} 신규 접수\n이름: ${row.customer_name}`,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request);
    const reply = (body, status = 200) => json(body, status, origin);

    // Origin 이 붙어 있는데 우리 도메인이 아니면 남의 사이트에서 쏘는 것이다.
    // (Origin 이 없는 요청은 CORS 헤더 없이 통과시키고 아래 레이트리밋으로 받는다)
    if (request.headers.get('origin') && !origin) {
      return json({ ok: false, error: '허용되지 않은 출처입니다.' }, 403);
    }
    if (request.method === 'OPTIONS') return reply({ ok: true });
    if (request.method !== 'POST') return reply({ ok: false, error: 'POST 만 받습니다.' }, 405);
    if (await overRateLimit(request, ctx)) {
      return reply({ ok: false, error: '잠시 후 다시 시도해 주세요.' }, 429);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return reply({ ok: false, error: '요청 형식이 올바르지 않습니다.' }, 400);
    }

    const ua = request.headers.get('user-agent') || '';
    if (BOT_UA.test(ua)) return reply({ ok: true });

    const checked = validate(payload);
    if (checked.drop) return reply({ ok: true });
    if (checked.error) return reply({ ok: false, error: checked.error }, 400);

    const url = new URL(request.url);
    const row = {
      group_key: GROUP_KEY,
      host: clean(payload.sourceDomain, 200) || url.hostname,
      site_url: clean(payload.pageUrl, 500),
      area_name: clean(payload.area, 200),
      customer_name: checked.name,
      customer_phone: checked.phone,
      service_type: `form:${checked.project}`,
      request_notes: checked.message,
      referer: clean(payload.referrer, 500),
      user_agent: ua.slice(0, 500),
    };

    try {
      await insertLead(env, row);
    } catch (error) {
      console.error('lead insert 실패', error.message);
      return reply({ ok: false, error: '접수 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
    }

    // 저장이 끝났으면 접수는 성공이다. 알림은 응답을 붙잡지 않고 뒤에서 보낸다.
    ctx.waitUntil(notifyTelegram(env, row, checked.brand)
      .catch((e) => console.error('telegram 실패', e.message)));

    return reply({ ok: true });
  },
};
