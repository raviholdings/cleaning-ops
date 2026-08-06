-- =============================================================================
-- Cleaning-Ops :: Lead Submissions & Daily Analytics Table
-- =============================================================================

begin;

create table if not exists public.lead_submissions (
  id uuid primary key default gen_random_uuid(),
  group_key text not null default 'cleaning-ravi',
  host text,
  site_url text,
  area_name text,
  customer_name text,
  customer_phone text,
  service_type text,
  request_notes text,
  referer text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_submissions_group_created
  on public.lead_submissions(group_key, created_at desc);

create index if not exists idx_lead_submissions_host
  on public.lead_submissions(host);

commit;
