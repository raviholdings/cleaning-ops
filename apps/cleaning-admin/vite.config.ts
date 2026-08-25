import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { handleAuth, requireApproved, requireRole } from './server/auth';
import { handleDevTasks } from './server/devTasks';
import { handleLeads } from './server/leads';

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

const { Pool } = pg;

/**
 * 커넥션 풀을 모듈 수준에서 한 번만 만든다.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (error) => { console.error('[db-pool]', error.message); });

function dbApiPlugin() {
  return {
    name: 'db-api-plugin',
    configureServer(server: any) { attachApi(server); },
    configurePreviewServer(server: any) { attachApi(server); },
  };

  function attachApi(server: any) {
      const withDb = async (fn: (q: any) => Promise<void>) => {
        await fn((text: string, values?: unknown[]) => pool.query(text, values));
      };

      // 0. 로그인 / 가입 / 승인
      server.middlewares.use('/api/auth', async (req: any, res: any) => {
        try {
          await withDb(async (q) => {
            const done = await handleAuth(q, req, res);
            if (!done) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); }
          });
        } catch (error: any) {
          console.error('[auth]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      // 데이터 API 는 승인된 사용자만.
      const gate = async (req: any, res: any, next: () => void) => {
        try {
          let blocked = false;
          await withDb(async (q) => { blocked = await requireApproved(q, req, res); });
          if (!blocked) next();
        } catch (error: any) {
          console.error('[gate]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      };
      server.middlewares.use('/api/dev-tasks', gate);
      server.middlewares.use('/api/stats', gate);
      server.middlewares.use('/api/domains', gate);
      server.middlewares.use('/api/index-status', gate);
      // 리드는 고객 개인정보(이름·전화·문의내용)라 owner·staff 만. member 는 막는다.
      const leadGate = async (req: any, res: any, next: () => void) => {
        try {
          let blocked = false;
          await withDb(async (query) => {
            blocked = await requireRole(query, req, res, ['owner', 'staff']);
          });
          if (!blocked) next();
        } catch (error: any) {
          console.error('[leadGate]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      };
      server.middlewares.use('/api/leads', leadGate);

      /*
       * 색인 현황.
       */
      const LATEST_INDEX = `
        select distinct on (domain)
               domain, indexed, indexed_post_count, indexed_url_count, checked_at,
               group_key, indexed_post_urls_sample
          from public.naver_index_check_results
         where error is null or error = ''
         order by domain, checked_at desc
      `;

      server.middlewares.use('/api/index-status', async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
          const q = (url.searchParams.get('q') || '').trim();
          const filter = url.searchParams.get('filter') || 'indexed';
          const groupKey = (url.searchParams.get('groupKey') || url.searchParams.get('group') || '').trim();

          const where: string[] = [];
          const params: unknown[] = [];
          if (q) { params.push(`%${q}%`); where.push(`l.domain ilike $${params.length}`); }
          if (filter === 'indexed') where.push('l.indexed');
          if (filter === 'not_indexed') where.push('not l.indexed');
          
          if (groupKey && groupKey !== 'all') {
            if (groupKey === 'cleaning-ravi' || groupKey === 'cleaning') {
              where.push(`(l.group_key = 'cleaning-ravi' or d.group_key = 'cleaning-ravi')`);
            } else if (groupKey === 'moving' || groupKey === 'moving-ravi') {
              where.push(`(l.group_key = 'moving' or l.group_key = 'moving-ravi' or d.group_key = 'moving' or d.group_key = 'moving-ravi' or exists (select 1 from unnest(coalesce(l.indexed_post_urls_sample, array[]::text[])) u where u like '%/%EC%9D%B4%EC%82%AC/%' or u like '%/이사/%' or u like '%/move/%' or u like '%/moving/%'))`);
            } else if (groupKey === 'demolition' || groupKey === 'demolition-ravi') {
              where.push(`(l.group_key = 'demolition' or l.group_key = 'demolition-ravi' or d.group_key = 'demolition' or d.group_key = 'demolition-ravi' or exists (select 1 from unnest(coalesce(l.indexed_post_urls_sample, array[]::text[])) u where u like '%/%EC%B2%A0%EA%B1%B0/%' or u like '%/철거/%' or u like '%/demolition/%'))`);
            }
          }
          const clause = where.length ? `where ${where.join(' and ')}` : '';

          const [summaryRes, bucketRes, rootRes, rowsRes, countRes] = await Promise.all([
            pool.query(`
              with l as (${LATEST_INDEX})
              select (select count(*)::int from public.naver_project_domains where is_visible = true) as total_domains,
                     count(*)::int                                    as checked,
                     count(*) filter (where l.indexed)::int           as indexed,
                     coalesce(sum(l.indexed_post_count), 0)::int      as indexed_posts,
                     max(l.checked_at)                                as last_checked
                from l
                ${clause.includes('d.') ? `join public.naver_project_domains d on d.host = l.domain ${clause}` : clause}
            `, params),
            pool.query(`
              with l as (${LATEST_INDEX}),
                   r as (select host, count(*) filter (where status = 'submitted')::int n
                           from public.naver_searchadvisor_crawl_request_results
                          group by host)
              select case when coalesce(r.n, 0) = 0 then '0건'
                          when r.n < 60  then '1~59건'
                          when r.n < 110 then '60~109건'
                          else '110건+' end                           as bucket,
                     count(*)::int                                    as domains,
                     count(*) filter (where l.indexed)::int           as indexed,
                     round(avg(l.indexed_post_count), 1)::float       as avg_posts
                from l left join r on r.host = l.domain
               group by 1
               order by min(coalesce(r.n, 0))
            `),
            pool.query(`
              with l as (${LATEST_INDEX})
              select split_part(l.domain, '.', 2) || '.' || split_part(l.domain, '.', 3) as root,
                     count(*)::int                          as checked,
                     count(*) filter (where l.indexed)::int as indexed,
                     coalesce(sum(l.indexed_post_count), 0)::int as posts
                from l
               group by 1
               order by 3 desc
            `),
            pool.query(`
              with l as (${LATEST_INDEX})
              select l.domain, l.indexed, l.indexed_post_count, l.indexed_url_count,
                     l.checked_at, d.naver_account_id, a.account_order
                from l
                join public.naver_project_domains d on d.host = l.domain
                left join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
                ${clause}
               order by l.indexed_post_count desc, l.domain asc
               limit ${pageSize} offset ${(page - 1) * pageSize}
            `, params),
            pool.query(`with l as (${LATEST_INDEX}) select count(*)::int as total from l join public.naver_project_domains d on d.host = l.domain ${clause}`, params),
          ]);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            summary: summaryRes.rows[0] || { total_domains: 10000, checked: 0, indexed: 0, indexed_posts: 0 },
            buckets: bucketRes.rows,
            roots: rootRes.rows,
            rows: rowsRes.rows,
            total: countRes.rows[0]?.total || 0,
            page,
            pageSize,
          }));
        } catch (error: any) {
          console.error('[index-status]', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      /*
       * 배관 접수(리드). lead-dashboard.uloung.com 화면 전용.
       */
      server.middlewares.use('/api/leads', async (req: any, res: any) => {
        try {
          await withDb((query) => handleLeads(query, req, res));
        } catch (error: any) {
          console.error('[leads]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      server.middlewares.use('/api/domains', async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
          const q = (url.searchParams.get('q') || '').trim();
          const status = url.searchParams.get('status') || '';
          const account = url.searchParams.get('account') || '';
          const deployed = url.searchParams.get('deployed') || '';
          const groupKey = (url.searchParams.get('groupKey') || url.searchParams.get('group') || '').trim();

          const where: string[] = [];
          const params: unknown[] = [];
          if (q) { params.push(`%${q}%`); where.push(`(host ilike $${params.length} or naver_account_id ilike $${params.length})`); }
          if (status) { params.push(status); where.push(`naver_registration_status = $${params.length}`); }
          if (account) { params.push(account); where.push(`naver_account_id = $${params.length}`); }
          if (deployed === 'yes') where.push('deployed_at is not null');
          if (deployed === 'no') where.push('deployed_at is null');
          if (groupKey && groupKey !== 'all') { params.push(groupKey); where.push(`group_key = $${params.length}`); }
          const clause = where.length ? `where ${where.join(' and ')}` : '';

          const [rowsRes, countRes] = await Promise.all([
            pool.query(
              `select host as domain_name, naver_account_id, area_name,
                      naver_registration_status, deployed_at, created_at
                 from public.naver_project_domains
                 ${clause}
                order by host asc
                limit ${pageSize} offset ${(page - 1) * pageSize}`,
              params,
            ),
            pool.query(`select count(*)::int as total from public.naver_project_domains ${clause}`, params),
          ]);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            rows: rowsRes.rows,
            total: countRes.rows[0]?.total || 0,
            page,
            pageSize,
          }));
        } catch (error: any) {
          console.error('[domains]', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      // 1. 개발현황 CRUD
      server.middlewares.use('/api/dev-tasks', async (req: any, res: any) => {
        try {
          await withDb((q) => handleDevTasks(q, req, res));
        } catch (error: any) {
          console.error('[dev-tasks]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      // 2. Comprehensive Monitoring Stats API Middleware
      server.middlewares.use('/api/stats', async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const groupKey = (url.searchParams.get('groupKey') || url.searchParams.get('group') || '').trim();
          const filterGroup = groupKey && groupKey !== 'all' ? groupKey : null;

          // 1) Accounts list
          const accountsP = pool.query(`
            select account_id, account_order, provider, organization_name,
                   account_identity_type, planned_domain_limit, status, phone,
                   searchadvisor_session_saved_at, searchadvisor_session_validated_at,
                   searchadvisor_session_saved_public_ip, created_at
              from public.naver_searchadvisor_accounts
             order by account_order asc;
          `);

          // 2) 계정별 도메인 수
          const accountDomainCountsP = pool.query(`
            select naver_account_id,
                   count(*)::int                                                        as domains,
                   count(*) filter (where naver_registration_status = 'verified')::int  as verified,
                   count(*) filter (where deployed_at is not null)::int                 as deployed
              from public.naver_project_domains
             where naver_account_id is not null
             group by naver_account_id;
          `);

          // 5) 수집 대상 페이지 풀 (Candidates)
          // 원본 candidates 뷰는 100만 페이지 다중 조인이라 호출당 23초였다.
          // 집계는 머티리얼라이즈드 뷰를 읽는다 (scripts/refresh-admin-stats.mjs 가 갱신).
          const candidatesP = pool.query(`
            select target_project, total::int, done::int, pending::int
              from public.admin_crawl_page_candidate_counts;
          `);

          // 6) Indexing Runs
          const indexRunsP = pool.query(`
            select count(*)::int as count from public.naver_index_check_runs;
          `);

          // 6-1) 계정 요약
          const accountSummaryP = pool.query(`
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

          // 6-2) 소유확인 요약
          const ownershipSummaryP = pool.query(`
            select count(*)::int                                                              as total,
                   count(*) filter (where naver_registration_status = 'pending')::int         as not_registered,
                   count(*) filter (where naver_registration_status = 'verified')::int        as verified,
                   count(*) filter (where naver_registration_status = 'registered')::int      as waiting,
                   count(*) filter (where deployed_at is not null)::int                       as deployed
              from public.naver_project_domains;
          `);

          // 6-3) 오늘(KST) 수집요청 — 프로젝트 구분은 URL LIKE 가 아니라
          // run_id -> runs.target_project 조인. 시작 시각은 CTE 가 아니라 파라미터로
          // 넘겨야 requested_at 인덱스 범위 스캔을 탄다 (CTE 크로스조인은 29초,
          // 파라미터는 2초 — 2026-08-21 실측).
          const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
          kstNow.setUTCHours(0, 0, 0, 0);
          const kstDayStart = new Date(kstNow.getTime() - 9 * 3600 * 1000).toISOString();
          const crawlTodayP = pool.query(`
            select coalesce(run.target_project, 'cleaning-ravi')            as target_project,
                   count(*)::int                                            as processed,
                   count(*) filter (where result.status = 'submitted')::int as submitted,
                   count(*) filter (where result.status = 'quota-stop')::int as quota_stop,
                   count(*) filter (where result.status in ('failed', 'blocked', 'unknown'))::int as failed
              from public.naver_searchadvisor_crawl_request_results result
              left join public.naver_searchadvisor_crawl_request_runs run
                on run.run_id = result.run_id
             where result.requested_at >= $1::timestamptz
             group by 1;
          `, [kstDayStart]);

          // 6-4) 배포 요약
          const deploymentSummaryP = pool.query(`
            select count(*)::int                                                          as total_domains,
                   count(*) filter (where deployed_at is not null)::int                   as deployed_domains,
                   count(*) filter (where naver_registration_status = 'verified')::int    as active_domains,
                   count(*) filter (where naver_registration_status is distinct from 'verified')::int
                                                                                          as reserve_domains,
                   coalesce(sum(page_count), 0)::int                                       as total_pages,
                   coalesce(sum(page_count) filter (where deployed_at is not null), 0)::int
                                                                                          as deployed_pages,
                   coalesce(sum(page_count) filter (where naver_registration_status = 'verified'), 0)::int
                                                                                          as active_pages,
                   coalesce(sum(page_count) filter (where naver_registration_status is distinct from 'verified'), 0)::int
                                                                                          as reserve_pages,
                   count(distinct naver_account_id)::int                                   as accounts,
                   count(distinct split_part(host, '.', array_length(string_to_array(host, '.'), 1) - 1)
                                  || '.' ||
                                  split_part(host, '.', array_length(string_to_array(host, '.'), 1)))::int
                                                                                          as root_domains,
                   max(deployed_at)                                                        as last_deployed_at
              from public.naver_project_domains
             where deployment_status = 'active' and is_visible = true;
          `);

          // 6-5) 루트도메인별 내역
          const rootDomainP = pool.query(`
            select split_part(host, '.', array_length(string_to_array(host, '.'), 1) - 1)
                   || '.' ||
                   split_part(host, '.', array_length(string_to_array(host, '.'), 1))           as root,
                   count(*)::int                                                                as subdomains,
                   coalesce(sum(page_count), 0)::int                                            as pages,
                   count(*) filter (where deployed_at is not null)::int                         as deployed,
                   count(*) filter (where naver_registration_status = 'verified')::int          as active,
                   coalesce(sum(page_count) filter (where naver_registration_status = 'verified'), 0)::int
                                                                                                as active_pages
              from public.naver_project_domains
             where deployment_status = 'active' and is_visible = true
             group by 1
             order by 1;
          `);

          // 7) Lead Submissions
          const leadsP = pool.query(`
            select * from public.lead_submissions order by created_at desc limit 50;
          `);

          const [
            accountsRes, accountDomainCountsRes,
            candidatesRes, indexRunsRes,
            accountSummaryRes, ownershipSummaryRes, crawlTodayRes,
            deploymentSummaryRes, rootDomainRes, leadsRes,
          ] = await Promise.all([
            accountsP, accountDomainCountsP,
            candidatesP, indexRunsP,
            accountSummaryP, ownershipSummaryP, crawlTodayP,
            deploymentSummaryP, rootDomainP, leadsP,
          ]);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            accounts: accountsRes.rows,
            accountDomainCounts: accountDomainCountsRes.rows,
            candidateStats: candidatesRes.rows,
            crawlTodayByProject: crawlTodayRes.rows,
            accountSummary: accountSummaryRes.rows[0],
            ownershipSummary: ownershipSummaryRes.rows[0],
            deploymentSummary: deploymentSummaryRes.rows[0],
            rootDomains: rootDomainRes.rows,
            todayKst: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
            indexRunCount: indexRunsRes.rows[0]?.count || 0,
            leads: leadsRes.rows
          }));
        } catch (err: any) {
          console.error('[stats-api]', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), dbApiPlugin()],
  server: {
    port: 3000,
    host: true,
    allowedHosts: ['admin.uloung.com', 'lead-dashboard.uloung.com', 'localhost'],
  },
  preview: {
    port: 3000,
    host: true,
    allowedHosts: ['admin.uloung.com', 'lead-dashboard.uloung.com', 'localhost'],
  },
});
