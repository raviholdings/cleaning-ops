import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { handleAuth, requireApproved } from './server/auth';
import { handleDevTasks } from './server/devTasks';

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
 *
 * 예전에는 요청마다 new Client() 로 새로 연결했다. Supabase 까지 왕복이
 * 한 번에 300ms 인데, /api/stats 는 인증 게이트에서 한 번 + 본문에서 한 번,
 * 총 두 번을 열어서 연결에만 600ms 를 썼다. 게다가 커넥션이 하나뿐이라
 * 쿼리를 병렬로 던져도 서버가 순서대로 처리해 아무 이득이 없었다.
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
    // 개발 서버와 빌드본 미리보기(preview) 둘 다에 같은 API 를 붙인다.
    //
    // 예전에는 configureServer 에만 붙어 있어서 개발 모드로만 돌 수 있었다.
    // 그런데 개발 모드는 모듈을 하나씩 그때그때 변환해 내려주므로 요청이
    // 100개가 넘는다. Cloudflare 터널을 왕복하면 한 장 여는 데 몇 초씩 걸렸다.
    // 빌드본은 번들 두세 개만 받으면 되므로 훨씬 빠르다.
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

      // 데이터 API 는 승인된 사용자만. 어드민은 계정 ID·도메인·배정 IP 를
      // 전부 보여주므로 로그인 없이 열리면 안 된다.
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

      /*
       * 색인 현황.
       *
       * naver_index_check_results 는 한 도메인에 여러 행이 쌓인다. 조사를
       * 여러 번 돌리기 때문이다. 게다가 프록시가 막히면 error 가 찬 행이
       * 같이 저장된다 (2026-08-14 에 9,497 건, 08-17 에 828 건).
       *
       * 그래서 화면에 쓰는 값은 항상 "도메인별 최신 정상 행" 하나로 접는다.
       * error 행을 세면 색인 안 된 것처럼 보여 통계가 통째로 틀어진다.
       */
      const LATEST_INDEX = `
        select distinct on (domain)
               domain, indexed, indexed_post_count, indexed_url_count, checked_at
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
          // 기본은 색인된 것만. 운영자가 보고 싶은 건 "된 애들"이다.
          const filter = url.searchParams.get('filter') || 'indexed';

          const where: string[] = [];
          const params: unknown[] = [];
          if (q) { params.push(`%${q}%`); where.push(`l.domain ilike $${params.length}`); }
          if (filter === 'indexed') where.push('l.indexed');
          if (filter === 'not_indexed') where.push('not l.indexed');
          const clause = where.length ? `where ${where.join(' and ')}` : '';

          const [summaryRes, bucketRes, rootRes, rowsRes, countRes] = await Promise.all([
            // 조사 진행률까지 같이 낸다. 448/503 만 보면 1만 개 중 얼마인지 알 수 없다.
            pool.query(`
              with l as (${LATEST_INDEX})
              select (select count(*)::int from public.naver_project_domains
                       where group_key = 'cleaning-ravi')            as total_domains,
                     count(*)::int                                    as checked,
                     count(*) filter (where l.indexed)::int           as indexed,
                     coalesce(sum(l.indexed_post_count), 0)::int      as indexed_posts,
                     max(l.checked_at)                                as last_checked
                from l
            `),
            // 수집요청을 얼마나 넣었느냐에 따라 색인률이 갈리는지 — 이 표가 핵심이다.
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
            pool.query(`with l as (${LATEST_INDEX}) select count(*)::int as total from l ${clause}`, params),
          ]);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            summary: summaryRes.rows[0],
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
       * 도메인 목록은 따로 뺀다.
       *
       * 예전에는 /api/stats 가 10,000행을 통째로 내려주고 브라우저가 거기서
       * 검색·필터를 했다. 응답만 1.9MB 라 화면 한 장 여는 데 2초가 그것으로
       * 갔다. 화면에 보이는 건 수십 행뿐이므로 필요한 만큼만 보낸다.
       */
      server.middlewares.use('/api/domains', async (req: any, res: any) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const page = Math.max(1, Number(url.searchParams.get('page') || 1));
          const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
          const q = (url.searchParams.get('q') || '').trim();
          const status = url.searchParams.get('status') || '';
          const account = url.searchParams.get('account') || '';
          const deployed = url.searchParams.get('deployed') || '';

          const where: string[] = [];
          const params: unknown[] = [];
          if (q) { params.push(`%${q}%`); where.push(`(host ilike $${params.length} or naver_account_id ilike $${params.length})`); }
          if (status) { params.push(status); where.push(`naver_registration_status = $${params.length}`); }
          if (account) { params.push(account); where.push(`naver_account_id = $${params.length}`); }
          if (deployed === 'yes') where.push('deployed_at is not null');
          if (deployed === 'no') where.push('deployed_at is null');
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

      // 1. 개발현황 CRUD. 예전에는 data/dev_tasks.json 파일을 직접 읽고 썼는데,
      //    화면에서 하나 고칠 때마다 git 저장소가 더러워지고 동시 편집이
      //    통째로 덮어써서 DB 로 옮겼다.
      server.middlewares.use('/api/dev-tasks', async (req: any, res: any) => {
        try {
          await withDb((q) => handleDevTasks(q, req, res));
        } catch (error: any) {
          console.error('[dev-tasks]', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error?.message || error) }));
        }
      });

      // 2. Comprehensive 5-Ops Monitoring Stats API Middleware
      server.middlewares.use('/api/stats', async (_req: any, res: any) => {
        try {
          // 쿼리를 순차로 기다리면 각 왕복 시간이 그대로 더해진다. 서로
          // 의존하지 않으므로 전부 던져놓고 한 번에 받는다. 풀이 커넥션을
          // 여러 개 쥐고 있어야 실제로 동시에 처리된다.

          // 1) Accounts list
          const accountsP = pool.query(`
            select account_id, account_order, provider, organization_name,
                   account_identity_type, planned_domain_limit, status, phone,
                   searchadvisor_session_saved_at, searchadvisor_session_validated_at,
                   searchadvisor_session_saved_public_ip, created_at
              from public.naver_searchadvisor_accounts
             order by account_order asc;
          `);

          // 2) 계정별 도메인 수. 예전에는 도메인 10,000행을 다 내려보내
          //    브라우저에서 계정별로 세었다. 세는 건 DB 가 훨씬 잘한다.
          //    목록 자체는 /api/domains 가 필요한 만큼만 준다.
          const accountDomainCountsP = pool.query(`
            select naver_account_id,
                   count(*)::int                                                        as domains,
                   count(*) filter (where naver_registration_status = 'verified')::int  as verified,
                   count(*) filter (where deployed_at is not null)::int                 as deployed
              from public.naver_project_domains
             where naver_account_id is not null
             group by naver_account_id;
          `);

          // 3) Crawl Request Daily Aggregates
          const crawlP = pool.query(`
            select to_char(requested_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') as date,
                   status,
                   count(*)::int as count
              from public.naver_searchadvisor_crawl_request_results
             group by 1, 2
             order by 1;
          `);

          // 4) Recent Crawl Request Logs
          //    requested_at 단독 인덱스가 없어 22만행을 통째로 정렬했다(450ms).
          //    최근 것만 보면 되므로 범위로 잘라 (status, requested_at DESC)
          //    인덱스를 타게 한다. 하루치가 비면 아래 fallback 이 받는다.
          const recentCrawlLogsP = pool.query(`
            select id, host as domain_name, url as path, status, note as response_message, requested_at
              from public.naver_searchadvisor_crawl_request_results
             where requested_at > now() - interval '3 days'
             order by requested_at desc limit 50;
          `);

          // 5) Indexing Runs
          const indexRunsP = pool.query(`
            select count(*)::int as count from public.naver_index_check_runs;
          `);

          // 5-1) 계정 요약 — 전체 500개 기준. 활성만 세면 실제 보유량을 알 수 없다.
          //      "소유확인 완료 계정"은 배정된 도메인 100개가 전부 verified 인 계정.
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

          // 5-2) 소유확인 요약 — 네이버 등록 전 / 완료 / 대기
          //      pending = 아직 서치어드바이저 인증키를 못 받은 것
          //      registered = 인증키는 있고 소유확인만 남은 것
          const ownershipSummaryP = pool.query(`
            select count(*)::int                                                              as total,
                   count(*) filter (where naver_registration_status = 'pending')::int         as not_registered,
                   count(*) filter (where naver_registration_status = 'verified')::int        as verified,
                   count(*) filter (where naver_registration_status = 'registered')::int      as waiting,
                   count(*) filter (where deployed_at is not null)::int                       as deployed
              from public.naver_project_domains;
          `);

          // 5-3) 오늘(KST) 수집요청. 누적과 섞으면 일일 한도와 비교할 수 없다.
          //      칼럼에 함수를 씌우면(= (requested_at at time zone ...)::date)
          //      인덱스를 못 타고 22만행을 다 훑는다(260ms). 같은 조건을
          //      범위로 바꿔 requested_at 인덱스를 타게 한다.
          const crawlTodayP = pool.query(`
            with today as (
              select (date_trunc('day', now() at time zone 'Asia/Seoul')
                      at time zone 'Asia/Seoul') as start_at
            )
            select count(*) filter (where status = 'submitted')::int        as submitted,
                   count(*) filter (where status = 'quota-stop')::int       as quota_stop,
                   count(*) filter (where status = 'failed')::int           as failed,
                   count(distinct host)::int                                as hosts
              from public.naver_searchadvisor_crawl_request_results, today
             where requested_at >= today.start_at
               and requested_at <  today.start_at + interval '1 day';
          `);

          // 5-4) 배포 요약 — 도메인 수만으로는 실제 규모가 안 보인다.
          //      서브도메인 1개 = page_count 장이므로 페이지 기준을 같이 낸다.
          //      활성 = 소유확인까지 끝나 색인 파이프라인에 들어갈 수 있는 것.
          //      예비 = 배포는 됐지만 아직 소유확인 전이라 못 쓰는 것.
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

          // 5-5) 루트도메인별 내역. 배포현황 표 아래에 붙인다.
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

          // 6) Lead Submissions
          const leadsP = pool.query(`
            select * from public.lead_submissions order by created_at desc limit 50;
          `);

          const [
            accountsRes, accountDomainCountsRes, crawlRes, recentCrawlLogsRes, indexRunsRes,
            accountSummaryRes, ownershipSummaryRes, crawlTodayRes,
            deploymentSummaryRes, rootDomainRes, leadsRes,
          ] = await Promise.all([
            accountsP, accountDomainCountsP, crawlP, recentCrawlLogsP, indexRunsP,
            accountSummaryP, ownershipSummaryP, crawlTodayP,
            deploymentSummaryP, rootDomainP, leadsP,
          ]);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            accounts: accountsRes.rows,
            accountDomainCounts: accountDomainCountsRes.rows,
            crawlDaily: crawlRes.rows,
            recentCrawlLogs: recentCrawlLogsRes.rows,
            accountSummary: accountSummaryRes.rows[0],
            ownershipSummary: ownershipSummaryRes.rows[0],
            deploymentSummary: deploymentSummaryRes.rows[0],
            rootDomains: rootDomainRes.rows,
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
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), dbApiPlugin()],
  server: {
    port: 3000,
    host: true,
    // Cloudflare 터널이 admin.uloung.com 호스트 헤더로 들어온다.
    // Vite 는 모르는 호스트를 403 으로 막으므로 여기에 적어줘야 한다.
    // (DNS 리바인딩 방어라 아무 호스트나 열어두면 안 된다.)
    allowedHosts: ['admin.uloung.com', 'localhost'],
  },
  // 터널이 바라보는 건 이쪽이다. 빌드본을 3000 으로 서비스한다.
  preview: {
    port: 3000,
    host: true,
    allowedHosts: ['admin.uloung.com', 'localhost'],
  },
});

