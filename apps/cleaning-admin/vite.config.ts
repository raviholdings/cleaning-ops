import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

// Load root .env
try {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, 'utf8');
    envText.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[key] = value;
      }
    });
  }
} catch (e) {
  console.error('Failed loading .env in vite.config:', e);
}

const { Client } = pg;

function dbApiPlugin() {
  return {
    name: 'db-api-plugin',
    configureServer(server: any) {
      // 1. Dev Tasks CRUD Middleware
      server.middlewares.use('/api/dev-tasks', async (req: any, res: any) => {
        const tasksFilePath = path.resolve(__dirname, '../../data/dev_tasks.json');
        
        const readTasks = () => {
          try {
            if (fs.existsSync(tasksFilePath)) {
              return JSON.parse(fs.readFileSync(tasksFilePath, 'utf8'));
            }
          } catch (e) {
            console.error('Error reading dev_tasks.json:', e);
          }
          return [];
        };

        const writeTasks = (tasks: any[]) => {
          try {
            fs.mkdirSync(path.dirname(tasksFilePath), { recursive: true });
            fs.writeFileSync(tasksFilePath, JSON.stringify(tasks, null, 2), 'utf8');
            return true;
          } catch (e) {
            console.error('Error writing dev_tasks.json:', e);
            return false;
          }
        };

        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          const tasks = readTasks();
          return res.end(JSON.stringify(tasks));
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const newTask = JSON.parse(body);
              newTask.id = newTask.id || `task-${Date.now()}`;
              const tasks = readTasks();
              tasks.unshift(newTask);
              writeTasks(tasks);
              res.statusCode = 201;
              return res.end(JSON.stringify(newTask));
            } catch (e: any) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: any) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const updatedTask = JSON.parse(body);
              let tasks = readTasks();
              tasks = tasks.map((t: any) => t.id === updatedTask.id ? { ...t, ...updatedTask } : t);
              writeTasks(tasks);
              return res.end(JSON.stringify(updatedTask));
            } catch (e: any) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          const urlObj = new URL(req.url, `http://${req.headers.host}`);
          const taskId = urlObj.searchParams.get('id');
          if (!taskId) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: 'Missing task id' }));
          }
          let tasks = readTasks();
          tasks = tasks.filter((t: any) => t.id !== taskId);
          writeTasks(tasks);
          return res.end(JSON.stringify({ success: true, id: taskId }));
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });

      // 2. Comprehensive 5-Ops Monitoring Stats API Middleware
      server.middlewares.use('/api/stats', async (_req: any, res: any) => {
        try {
          const client = new Client({
            connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
            ssl: { rejectUnauthorized: false }
          });
          await client.connect();

          // 1) Accounts list
          const accountsRes = await client.query(`
            select account_id, account_order, provider, organization_name,
                   account_identity_type, planned_domain_limit, status, phone,
                   searchadvisor_session_saved_at, searchadvisor_session_validated_at,
                   searchadvisor_session_saved_public_ip, created_at
              from public.naver_searchadvisor_accounts
             order by account_order asc;
          `);

          // 2) Domains & Deployment & Ownership
          const domainsRes = await client.query(`
            select host as domain_name, project_key, naver_account_id, area_name,
                   naver_registration_status, naver_meta_tag as naver_meta_tag_content,
                   deployed_at, created_at, updated_at
              from public.naver_project_domains
             order by host asc;
          `);

          // 3) Crawl Request Daily Aggregates
          const crawlRes = await client.query(`
            select to_char(requested_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as date,
                   status,
                   count(*)::int as count
              from public.naver_searchadvisor_crawl_request_results
             group by 1, 2
             order by 1;
          `);

          // 4) Recent Crawl Request Logs
          const recentCrawlLogsRes = await client.query(`
            select id, host as domain_name, url as path, status, note as response_message, requested_at
              from public.naver_searchadvisor_crawl_request_results
             order by requested_at desc limit 50;
          `);

          // 5) Indexing Runs
          const indexRunsRes = await client.query(`
            select count(*)::int as count from public.naver_index_check_runs;
          `);

          // 5-1) 계정 요약 — 전체 500개 기준. 활성만 세면 실제 보유량을 알 수 없다.
          //      "소유확인 완료 계정"은 배정된 도메인 100개가 전부 verified 인 계정.
          const accountSummaryRes = await client.query(`
            with per_account as (
              select a.account_id,
                     a.status,
                     count(d.id)::int                                                        as domains,
                     count(d.id) filter (where d.naver_registration_status = 'verified')::int as verified
                from public.naver_searchadvisor_accounts a
                left join public.naver_project_domains d on d.naver_account_id = a.account_id
               group by a.account_id, a.status
            )
            select count(*)::int                                                      as total,
                   count(*) filter (where status = 'active')::int                     as usable,
                   count(*) filter (where status <> 'active')::int                    as suspended,
                   count(*) filter (where domains > 0)::int                           as assigned,
                   count(*) filter (where domains > 0 and verified = domains)::int    as fully_verified,
                   count(*) filter (where domains > 0 and verified > 0
                                      and verified < domains)::int                    as partially_verified
              from per_account;
          `);

          // 5-2) 소유확인 요약 — 네이버 등록 전 / 완료 / 대기
          //      pending = 아직 서치어드바이저 인증키를 못 받은 것
          //      registered = 인증키는 있고 소유확인만 남은 것
          const ownershipSummaryRes = await client.query(`
            select count(*)::int                                                              as total,
                   count(*) filter (where naver_registration_status = 'pending')::int         as not_registered,
                   count(*) filter (where naver_registration_status = 'verified')::int        as verified,
                   count(*) filter (where naver_registration_status = 'registered')::int      as waiting,
                   count(*) filter (where deployed_at is not null)::int                       as deployed
              from public.naver_project_domains;
          `);

          // 5-3) 오늘(KST) 수집요청. 누적과 섞으면 일일 한도와 비교할 수 없다.
          const crawlTodayRes = await client.query(`
            select count(*) filter (where status = 'submitted')::int        as submitted,
                   count(*) filter (where status = 'quota-stop')::int       as quota_stop,
                   count(*) filter (where status = 'failed')::int           as failed,
                   count(distinct host)::int                                as hosts
              from public.naver_searchadvisor_crawl_request_results
             where (requested_at at time zone 'Asia/Seoul')::date
                   = (now() at time zone 'Asia/Seoul')::date;
          `);

          // 6) Lead Submissions
          const leadsRes = await client.query(`
            select * from public.lead_submissions order by created_at desc limit 50;
          `);

          await client.end();

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            accounts: accountsRes.rows,
            domains: domainsRes.rows,
            crawlDaily: crawlRes.rows,
            recentCrawlLogs: recentCrawlLogsRes.rows,
            accountSummary: accountSummaryRes.rows[0],
            ownershipSummary: ownershipSummaryRes.rows[0],
            crawlToday: crawlTodayRes.rows[0],
            // 사이트당 하루 50건. 배정된 도메인 수로 계산해야 실제 한도가 나온다.
            crawlDailyQuota: (ownershipSummaryRes.rows[0]?.total || 0) * 50,
            todayKst: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
            indexRunCount: indexRunsRes.rows[0]?.count || 0,
            leads: leadsRes.rows
          }));
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), dbApiPlugin()],
  server: {
    port: 3000,
    host: true,
  },
});

