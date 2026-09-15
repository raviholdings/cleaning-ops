import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentUser } from './auth';

/*
 * 접수 조회·처리 API. lead-dashboard.uloung.com 화면이 이것만 쓴다.
 *
 * 테이블(lead_submissions)은 업종 공용이고 group_key 로 가른다 — 나누지 않기로
 * 확정(2026-08-25).
 *   piping-ravi  배관 Worker(workers/piping-lead)
 *   brand-ravi   브랜드 Worker(workers/brand-lead) — .kr 6개 (2026-09-14 추가)
 *
 * 청소·이사는 띄우지 않는다. 그쪽 group_key 로 들어오는 건 대부분 'beacon:view'
 * (폼이 화면에 떴다는 신호)라 전화할 대상이 아니다 — 6,458건이 섞여 들어온다.
 */
const GROUP_KEYS = ['piping-ravi', 'brand-ravi'];

type DbQuery = (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function handleLeads(query: DbQuery, req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') {
    const url = new URL(req.url || '/', 'http://localhost');
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
    const status = url.searchParams.get('status') || 'all';
    const q = (url.searchParams.get('q') || '').trim();

    const where: string[] = ['group_key = any($1::text[])'];
    const params: unknown[] = [GROUP_KEYS];
    if (status === 'unhandled') where.push('handled_at is null');
    if (status === 'handled') where.push('handled_at is not null');
    if (q) {
      params.push(`%${q}%`);
      where.push(`(customer_name ilike $${params.length} or customer_phone ilike $${params.length}`
        + ` or area_name ilike $${params.length} or request_notes ilike $${params.length})`);
    }
    const clause = `where ${where.join(' and ')}`;

    params.push(pageSize, (page - 1) * pageSize);
    const rowsP = query(
      `select id, created_at, area_name, customer_name, customer_phone, request_notes,
              host, site_url, handled_at, handled_by, memo, group_key,
              host(client_ip) as client_ip
         from public.lead_submissions
         ${clause}
        order by handled_at is not null, created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const countP = query(
      `select count(*)::int as total,
              count(*) filter (where handled_at is null)::int as unhandled
         from public.lead_submissions ${clause}`,
      params.slice(0, params.length - 2),
    );
    const [rowsRes, countRes] = await Promise.all([rowsP, countP]);
    send(res, 200, {
      rows: rowsRes.rows,
      total: countRes.rows[0]?.total ?? 0,
      unhandled: countRes.rows[0]?.unhandled ?? 0,
      page,
      pageSize,
    });
    return;
  }

  if (req.method === 'PATCH' || req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '').trim();
    if (!id) { send(res, 400, { error: 'id 가 필요합니다.' }); return; }

    // 누가 전화했는지 남긴다. 화면에서 보내온 값을 믿지 않고 세션에서 꺼낸다.
    const user = await currentUser(query as any, req);
    const who = user ? (user.name || user.username) : null;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof body.handled === 'boolean') {
      if (body.handled) {
        params.push(who);
        sets.push(`handled_at = now(), handled_by = $${params.length}`);
      } else {
        sets.push('handled_at = null, handled_by = null');
      }
    }
    if (typeof body.memo === 'string') {
      params.push(body.memo.slice(0, 2000));
      sets.push(`memo = $${params.length}`);
    }
    if (!sets.length) { send(res, 400, { error: '바꿀 값이 없습니다.' }); return; }

    // 조회와 같은 범위여야 한다 — 화면에 보이는데 "전화함" 이 안 먹는 일이 없게.
    params.push(id, GROUP_KEYS);
    const updated = await query(
      `update public.lead_submissions set ${sets.join(', ')}
        where id = $${params.length - 1} and group_key = any($${params.length}::text[])
        returning id, handled_at, handled_by, memo`,
      params,
    );
    if (!updated.rows.length) { send(res, 404, { error: '해당 리드를 찾을 수 없습니다.' }); return; }
    send(res, 200, updated.rows[0]);
    return;
  }

  send(res, 405, { error: 'method not allowed' });
}
