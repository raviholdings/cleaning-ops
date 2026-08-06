import pg from 'pg';

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

const res = await client.query(
  "update public.naver_project_domains set naver_registration_status = 'registered', naver_verified_at = null where naver_account_id = 'noiuhejawrjjyso4n'"
);

console.log('Reverted DB rows for Account 2:', res.rowCount);
await client.end();
