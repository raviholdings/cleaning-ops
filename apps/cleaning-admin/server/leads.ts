import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentUser } from './auth';

/*
 * 배관 리드 조회·처리 API. lead-dashboard.uloung.com 화면이 이것만 쓴다.
 *
 * 테이블(lead_submissions)은 업종 공용이고 group_key 로 가른다 — 나누지 않기로
 * 확정(2026-08-25). 배관 Worker(workers/piping-lead)가 'piping-ravi' 로 넣는다.
 * 청소·이사 리드는 같은 테이블에 있지만 이 화면에는 띄우지 않는다.
 */
const GROUP_KEY = 'piping-ravi';

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

    const where: string[] = ['group_key = $1'];
    const params: unknown[] = [GROUP_KEY];
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
              host, site_url, handled_at, handled_by, memo
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

    params.push(id, GROUP_KEY);
    const updated = await query(
      `update public.lead_submissions set ${sets.join(', ')}
        where id = $${params.length - 1} and group_key = $${params.length}
        returning id, handled_at, handled_by, memo`,
      params,
    );
    if (!updated.rows.length) { send(res, 404, { error: '해당 리드를 찾을 수 없습니다.' }); return; }
    send(res, 200, updated.rows[0]);
    return;
  }

  send(res, 405, { error: 'method not allowed' });
}
