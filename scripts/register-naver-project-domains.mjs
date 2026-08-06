#!/usr/bin/env node
// Register Search Advisor accounts and project domains from a JSON manifest.
//
//   node scripts/register-naver-project-domains.mjs [--file config/cleaning-domains.json]
//                                                   [--dry-run] [--allow-update]
//
// The manifest shape is documented in config/cleaning-domains.example.json.
// Accounts are upserted first because naver_project_domains.naver_account_id
// references naver_searchadvisor_accounts(account_id).
//
// Existing domain rows are left untouched unless --allow-update is passed, so a
// re-run after a partial failure is safe.

import { readFileSync } from 'node:fs';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const allowUpdate = args.includes('--allow-update');
const manifestPath = optionValue('--file') || 'config/cleaning-domains.json';

loadLocalEnv('.env');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const groupKey = required(manifest.groupKey, 'groupKey');
const projectKey = required(manifest.projectKey, 'projectKey');
const targetProject = required(manifest.targetProject, 'targetProject');
const accounts = Array.isArray(manifest.accounts) ? manifest.accounts : [];
const domains = Array.isArray(manifest.domains) ? manifest.domains : [];

if (!domains.length) throw new Error(`${manifestPath} has no domains[]`);

for (const [index, domain] of domains.entries()) {
  required(domain.host, `domains[${index}].host`);
  required(domain.siteUrl, `domains[${index}].siteUrl`);
  required(domain.naverAccountId, `domains[${index}].naverAccountId`);
  if (!/^https?:\/\//.test(domain.siteUrl)) {
    throw new Error(`domains[${index}].siteUrl must be absolute: ${domain.siteUrl}`);
  }
  if (normalizeHost(domain.siteUrl) !== String(domain.host).trim().toLowerCase()) {
    throw new Error(
      `domains[${index}] host/siteUrl mismatch: ${domain.host} vs ${domain.siteUrl}`,
    );
  }
}

const duplicateHosts = domains
  .map((domain) => String(domain.host).trim().toLowerCase())
  .filter((host, index, all) => all.indexOf(host) !== index);
if (duplicateHosts.length) {
  throw new Error(`duplicate hosts in manifest: ${[...new Set(duplicateHosts)].join(', ')}`);
}

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required');

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const { rowCount: groupExists } = await client.query(
    'select 1 from public.naver_project_groups where group_key = $1',
    [groupKey],
  );
  if (!groupExists) {
    throw new Error(
      `naver_project_groups row not found: ${groupKey}. Apply supabase/migrations first.`,
    );
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          manifestPath,
          groupKey,
          accounts: accounts.map((account) => account.accountId),
          domains: domains.map((domain) => domain.host),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  await client.query('begin');

  const accountResults = [];
  for (const account of accounts) {
    const accountId = required(account.accountId, 'accounts[].accountId');
    const { rows } = await client.query(
      `
        insert into public.naver_searchadvisor_accounts (
          account_id, account_order, provider, organization_name,
          account_identity_type, planned_domain_limit, status,
          password_plain, personal_email, personal_name, phone, notes
        ) values (
          $1, $2, coalesce($3, 'naver'), coalesce($4, '라비홀딩스'),
          coalesce($5, '비실계'), coalesce($6, 100), coalesce($7, 'active'),
          nullif($8, ''), nullif($9, ''), nullif($10, ''), nullif($11, ''), nullif($12, '')
        )
        on conflict (account_id) do update set
          provider = coalesce(excluded.provider, public.naver_searchadvisor_accounts.provider),
          organization_name = coalesce(excluded.organization_name, public.naver_searchadvisor_accounts.organization_name),
          account_identity_type = coalesce(excluded.account_identity_type, public.naver_searchadvisor_accounts.account_identity_type),
          planned_domain_limit = coalesce(excluded.planned_domain_limit, public.naver_searchadvisor_accounts.planned_domain_limit),
          status = coalesce(excluded.status, public.naver_searchadvisor_accounts.status),
          password_plain = coalesce(excluded.password_plain, public.naver_searchadvisor_accounts.password_plain),
          personal_email = coalesce(excluded.personal_email, public.naver_searchadvisor_accounts.personal_email),
          personal_name = coalesce(excluded.personal_name, public.naver_searchadvisor_accounts.personal_name),
          phone = coalesce(excluded.phone, public.naver_searchadvisor_accounts.phone),
          notes = coalesce(excluded.notes, public.naver_searchadvisor_accounts.notes),
          updated_at = now()
        returning account_id, (xmax = 0) as inserted
      `,
      [
        accountId,
        account.accountOrder ?? null,
        account.provider ?? null,
        account.organizationName ?? null,
        account.accountIdentityType ?? null,
        account.plannedDomainLimit ?? null,
        account.status ?? null,
        account.passwordPlain ?? '',
        account.personalEmail ?? '',
        account.personalName ?? '',
        account.phone ?? '',
        account.notes ?? '',
      ],
    );
    accountResults.push({ accountId, action: rows[0].inserted ? 'inserted' : 'updated' });
  }

  const domainResults = [];
  for (const domain of domains) {
    const host = String(domain.host).trim().toLowerCase();
    const siteUrl = String(domain.siteUrl).trim().replace(/\/+$/, '');

    const { rowCount: accountExists } = await client.query(
      'select 1 from public.naver_searchadvisor_accounts where account_id = $1',
      [domain.naverAccountId],
    );
    if (!accountExists) {
      throw new Error(
        `naver_searchadvisor_accounts row not found: ${domain.naverAccountId} (host ${host}). ` +
          'Add it to accounts[] in the manifest.',
      );
    }

    const conflictAction = allowUpdate
      ? `do update set
           group_key = excluded.group_key,
           project_key = excluded.project_key,
           target_project = excluded.target_project,
           site_url = excluded.site_url,
           provider = coalesce(excluded.provider, public.naver_project_domains.provider),
           naver_account_id = excluded.naver_account_id,
           page_count = excluded.page_count,
           static_page_count = excluded.static_page_count,
           sitemap_url_count = excluded.sitemap_url_count,
           route_style = coalesce(excluded.route_style, public.naver_project_domains.route_style),
           post_route_mode = coalesce(excluded.post_route_mode, public.naver_project_domains.post_route_mode),
           area_slug = coalesce(excluded.area_slug, public.naver_project_domains.area_slug),
           area_name = coalesce(excluded.area_name, public.naver_project_domains.area_name),
           region_label = coalesce(excluded.region_label, public.naver_project_domains.region_label),
           subdomain_generation_strategy = excluded.subdomain_generation_strategy,
           naver_registration_status = excluded.naver_registration_status,
           naver_meta_tag = coalesce(excluded.naver_meta_tag, public.naver_project_domains.naver_meta_tag),
           naver_console_url = coalesce(excluded.naver_console_url, public.naver_project_domains.naver_console_url),
           updated_at = now()`
      : 'do nothing';

    const { rows } = await client.query(
      `
        insert into public.naver_project_domains (
          group_key, project_key, target_project, host, site_url, provider,
          naver_account_id, deployment_status, is_visible,
          page_count, static_page_count, sitemap_url_count,
          route_style, post_route_mode, area_slug, area_name, region_label,
          subdomain_generation_strategy, naver_registration_status,
          naver_meta_tag, naver_console_url, source_table, source_run_id, source_payload
        ) values (
          $1, $2, $3, $4, $5, nullif($6, ''),
          $7, coalesce(nullif($8, ''), 'active'), coalesce($9, true),
          coalesce($10, 0), coalesce($11, 0), coalesce($12, 0),
          nullif($13, ''), nullif($14, ''), nullif($15, ''), nullif($16, ''), nullif($17, ''),
          coalesce(nullif($18, ''), 'manual'), coalesce(nullif($19, ''), 'pending'),
          nullif($20, ''), nullif($21, ''), 'cleaning-domains-manifest', nullif($22, ''), $23::jsonb
        )
        on conflict (host) ${conflictAction}
        returning id, host, naver_registration_status, (xmax = 0) as inserted
      `,
      [
        groupKey,
        projectKey,
        targetProject,
        host,
        siteUrl,
        domain.provider ?? '',
        domain.naverAccountId,
        domain.deploymentStatus ?? '',
        domain.isVisible ?? null,
        domain.pageCount ?? null,
        domain.staticPageCount ?? null,
        domain.sitemapUrlCount ?? null,
        domain.routeStyle ?? '',
        domain.postRouteMode ?? '',
        domain.areaSlug ?? '',
        domain.areaName ?? '',
        domain.regionLabel ?? '',
        domain.subdomainGenerationStrategy ?? '',
        domain.naverRegistrationStatus ?? '',
        domain.naverMetaTag ?? '',
        domain.naverConsoleUrl ?? '',
        manifest.sourceRunId ?? '',
        JSON.stringify(domain.sourcePayload ?? {}),
      ],
    );

    if (!rows.length) {
      domainResults.push({ host, action: 'skipped-existing' });
      continue;
    }
    domainResults.push({
      host: rows[0].host,
      id: Number(rows[0].id),
      registrationStatus: rows[0].naver_registration_status,
      action: rows[0].inserted ? 'inserted' : 'updated',
    });
  }

  await client.query('commit');

  console.log(
    JSON.stringify(
      { manifestPath, groupKey, accounts: accountResults, domains: domainResults },
      null,
      2,
    ),
  );
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return '';
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function required(value, label) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === undefined || text === null || text === '') {
    throw new Error(`${label} is required`);
  }
  return text;
}

function normalizeHost(siteUrl) {
  try {
    return new URL(siteUrl).host.toLowerCase();
  } catch {
    return '';
  }
}

function loadLocalEnv(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
