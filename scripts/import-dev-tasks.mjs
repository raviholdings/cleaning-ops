#!/usr/bin/env node
/**
 * data/dev_tasks.json 을 public.dev_tasks 로 옮긴다. 한 번만 돌리면 된다.
 *
 *   node scripts/import-dev-tasks.mjs --dry-run
 *   node scripts/import-dev-tasks.mjs
 *
 * 같은 id 가 이미 있으면 덮어쓰지 않고 건너뛴다. 실수로 두 번 돌려도
 * 화면에서 고친 내용이 파일 값으로 되돌아가지 않게 하기 위해서다.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const dryRun = process.argv.includes('--dry-run');
const tasks = JSON.parse(readFileSync(resolve(projectRoot, 'data/dev_tasks.json'), 'utf8'));

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 또는 DIRECT_URL 이 필요합니다.');
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('begin');

  const before = await client.query('select count(*)::int n from public.dev_tasks');
  let inserted = 0;
  let skipped = 0;

  // 파일의 앞쪽이 최신이었다. sort_order 를 크게 줘서 위로 오게 한다.
  const total = tasks.length;
  for (const [index, task] of tasks.entries()) {
    const id = String(task.id || `task-${Date.now()}-${index}`);
    const exists = await client.query('select 1 from public.dev_tasks where id = $1', [id]);
    if (exists.rowCount) { skipped += 1; continue; }

    await client.query(
      `insert into public.dev_tasks
         (id, title, category, assignee, priority, status,
          start_date, target_date, completed_date, progress, description, notes, sort_order)
       values ($1,$2,$3,$4,
               coalesce(nullif($5,''), 'medium'), coalesce(nullif($6,''), 'pending'),
               nullif($7,'')::date, nullif($8,'')::date, nullif($9,'')::date,
               coalesce($10, 0), $11, $12, $13)`,
      [id, String(task.title || '(제목 없음)'), task.category ?? null, task.assignee ?? null,
        task.priority ?? '', task.status ?? '',
        task.startDate ?? '', task.targetDate ?? '', task.completedDate ?? '',
        Number.isFinite(Number(task.progress)) ? Number(task.progress) : 0,
        task.description ?? null, task.notes ?? null, total - index],
    );
    inserted += 1;
  }

  const after = await client.query('select count(*)::int n from public.dev_tasks');
  console.log(JSON.stringify({
    phase: dryRun ? 'dry-run' : 'complete',
    fileTasks: tasks.length,
    inserted,
    skipped,
    rowsBefore: before.rows[0].n,
    rowsAfter: after.rows[0].n,
  }, null, 2));

  if (dryRun) {
    await client.query('rollback');
    console.log('\n(dry-run: 롤백했습니다.)');
  } else {
    await client.query('commit');
  }
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch { /* .env 없으면 환경변수로 준 것을 쓴다 */ }
}
