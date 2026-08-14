/**
 * 개발현황 탭 CRUD.
 *
 * 예전에는 data/dev_tasks.json 파일을 직접 읽고 썼다. 화면에서 과제를 하나
 * 고칠 때마다 저장소가 더러워졌고, VM 들이 git pull 할 때 그 파일 때문에
 * 막히기도 했다. 여러 명이 동시에 고치면 마지막 저장이 앞의 것을 통째로
 * 덮어썼다. 그래서 DB(public.dev_tasks)로 옮겼다.
 *
 * 화면은 camelCase 를 쓰고 DB 는 snake_case 라서 양쪽에서 한 번씩 변환한다.
 * 화면 코드를 건드리지 않으려고 서버에서 맞춰준다.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbQuery } from './auth';

interface TaskRow {
  id: string;
  title: string;
  category: string | null;
  assignee: string | null;
  priority: string;
  status: string;
  start_date: string | null;
  target_date: string | null;
  completed_date: string | null;
  progress: number;
  description: string | null;
  notes: string | null;
}

const asDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

function toClient(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    category: row.category ?? '',
    assignee: row.assignee ?? '',
    priority: row.priority,
    status: row.status,
    startDate: row.start_date ?? '',
    targetDate: row.target_date ?? '',
    completedDate: row.completed_date ?? undefined,
    progress: Number(row.progress ?? 0),
    description: row.description ?? '',
    notes: row.notes ?? '',
  };
}

// date 컬럼은 pg 가 Date 객체로 준다. 그대로 JSON 에 넣으면 UTC 로 밀려
// 하루 전 날짜가 찍힌다. 문자열로 받아 그 문제를 피한다.
const SELECT = `
  select id, title, category, assignee, priority, status,
         to_char(start_date, 'YYYY-MM-DD')     as start_date,
         to_char(target_date, 'YYYY-MM-DD')    as target_date,
         to_char(completed_date, 'YYYY-MM-DD') as completed_date,
         progress, description, notes
    from public.dev_tasks`;

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

export async function handleDevTasks(query: DbQuery, req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') {
    // 새 과제가 위로 오게. sort_order 가 없던 행은 만든 시각으로 정렬한다.
    const { rows } = await query(`${SELECT} order by sort_order desc nulls last, created_at desc`);
    return send(res, 200, rows.map(toClient));
  }

  if (req.method === 'POST') {
    const task = await readJson(req);
    const id = String(task.id || `task-${Date.now()}`);
    const { rows } = await query(
      `insert into public.dev_tasks
         (id, title, category, assignee, priority, status,
          start_date, target_date, completed_date, progress, description, notes,
          sort_order)
       values ($1,$2,$3,$4,
               coalesce(nullif($5,''),'medium'), coalesce(nullif($6,''),'pending'),
               $7::date, $8::date, $9::date, coalesce($10,0), $11, $12,
               coalesce((select max(sort_order) from public.dev_tasks), 0) + 1)
       returning id`,
      [id, String(task.title || '(제목 없음)'), task.category ?? null, task.assignee ?? null,
        task.priority ?? '', task.status ?? '',
        asDate(task.startDate), asDate(task.targetDate), asDate(task.completedDate),
        Number.isFinite(Number(task.progress)) ? Number(task.progress) : 0,
        task.description ?? null, task.notes ?? null],
    );
    const created = await query(`${SELECT} where id = $1`, [rows[0].id]);
    return send(res, 201, toClient(created.rows[0]));
  }

  if (req.method === 'PUT') {
    const task = await readJson(req);
    if (!task.id) return send(res, 400, { error: 'id 가 없습니다.' });

    // 화면이 보낸 항목만 바꾼다. coalesce 로 두면 빈 문자열로 지우는 걸
    // 구분하지 못하므로, 키가 왔는지를 따로 넘겨 판단한다.
    const has = (key: string) => Object.prototype.hasOwnProperty.call(task, key);
    const { rows } = await query(
      `update public.dev_tasks set
         title          = case when $2  then $3  else title end,
         category       = case when $4  then $5  else category end,
         assignee       = case when $6  then $7  else assignee end,
         priority       = case when $8  then $9  else priority end,
         status         = case when $10 then $11 else status end,
         start_date     = case when $12 then $13::date else start_date end,
         target_date    = case when $14 then $15::date else target_date end,
         completed_date = case when $16 then $17::date else completed_date end,
         progress       = case when $18 then $19 else progress end,
         description    = case when $20 then $21 else description end,
         notes          = case when $22 then $23 else notes end,
         updated_at     = now()
       where id = $1
       returning id`,
      [String(task.id),
        has('title'), task.title ?? null,
        has('category'), task.category ?? null,
        has('assignee'), task.assignee ?? null,
        has('priority'), task.priority || 'medium',
        has('status'), task.status || 'pending',
        has('startDate'), asDate(task.startDate),
        has('targetDate'), asDate(task.targetDate),
        has('completedDate'), asDate(task.completedDate),
        has('progress'), Number.isFinite(Number(task.progress)) ? Number(task.progress) : 0,
        has('description'), task.description ?? null,
        has('notes'), task.notes ?? null],
    );
    if (!rows.length) return send(res, 404, { error: '없는 과제입니다.' });
    const updated = await query(`${SELECT} where id = $1`, [rows[0].id]);
    return send(res, 200, toClient(updated.rows[0]));
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return send(res, 400, { error: 'id 가 없습니다.' });
    const { rowCount } = await query('delete from public.dev_tasks where id = $1', [id]);
    return send(res, 200, { success: rowCount > 0, id });
  }

  return send(res, 405, { error: 'Method not allowed' });
}
