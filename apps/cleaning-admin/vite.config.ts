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
            crawlDailyQuota: 50000,
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

