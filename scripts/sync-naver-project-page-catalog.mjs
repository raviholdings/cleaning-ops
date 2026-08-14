#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  createPageComboOverrideMirror,
  pageComboOverrideItem,
  pageComboOverrideMirrorsMatch
} from './lib/page-combo-overrides.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const groupKey = process.env.NAVER_PAGE_CATALOG_GROUP_KEY || 'bbungbbung';
const siteModulePath = resolve(
  projectRoot,
  process.env.NAVER_PAGE_CATALOG_SITE_MODULE || defaultSiteModuleForGroup(groupKey)
);
const schemaPath = resolve(
  projectRoot,
  process.env.NAVER_PAGE_CATALOG_SCHEMA_FILE
    || 'supabase/migrations/20260713100000_create_naver_project_page_catalog.sql'
);
const applySchema = process.env.NAVER_PAGE_CATALOG_APPLY_SCHEMA === '1';
const dryRun = process.env.NAVER_PAGE_CATALOG_DRY_RUN === '1';
const force = process.env.NAVER_PAGE_CATALOG_FORCE === '1';
const incrementalRunId = String(process.env.NAVER_PAGE_CATALOG_INCREMENTAL_RUN_ID || '').trim();
const sourceRunId = String(process.env.NAVER_PAGE_CATALOG_SOURCE_RUN_ID || '').trim();
const accountRolloutRoles = splitList(process.env.NAVER_PAGE_CATALOG_ACCOUNT_ROLES || '');
const expectedDomains = optionalInteger(process.env.NAVER_PAGE_CATALOG_EXPECTED_DOMAINS);
const domainLimit = optionalInteger(process.env.NAVER_PAGE_CATALOG_DOMAIN_LIMIT);
const batchDomainCount = positiveInteger(process.env.NAVER_PAGE_CATALOG_BATCH_DOMAINS, 20);
const dictionaryBatchSize = positiveInteger(process.env.NAVER_PAGE_CATALOG_DICTIONARY_BATCH_SIZE, 5000);

if (sourceRunId && incrementalRunId) {
  throw new Error('NAVER_PAGE_CATALOG_SOURCE_RUN_ID cannot be used with incremental mode.');
}
if (sourceRunId && domainLimit !== null) {
  throw new Error('NAVER_PAGE_CATALOG_DOMAIN_LIMIT cannot be used with a source run filter.');
}

loadEnv(resolve(projectRoot, '.env'));

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');
if (!existsSync(siteModulePath)) throw new Error(`Site module does not exist: ${siteModulePath}`);

const client = new pg.Client(createClientConfig(connectionString));
await client.connect();

try {
  await client.query(`set statement_timeout = 0`);
  if (applySchema) await client.query(readFileSync(schemaPath, 'utf8'));

  const activeDomains = await loadDomains(client, sourceRunId);
  const recoveryManifestDomains = groupKey === 'recovery-law'
    && (sourceRunId || accountRolloutRoles.length)
    ? await loadDomains(client, '', [])
    : activeDomains;
  configureSiteEnvironment(activeDomains);
  const site = await import(`${pathToFileURL(siteModulePath).href}?catalog=${Date.now()}`);
  if (typeof site.pageCatalogDimensions !== 'function' || typeof site.pageCatalogEntryForRequestId !== 'function') {
    throw new Error(`${siteModulePath} must export pageCatalogDimensions and pageCatalogEntryForRequestId.`);
  }
  if (groupKey === 'recovery-law') {
    if (site.PAGE_COMBO_OVERRIDE_SCHEMA_VERSION !== 1
      || typeof site.configurePageComboOverrides !== 'function') {
      throw new Error(
        `${siteModulePath} must support Recovery page combo override schema version 1.`
      );
    }
    site.configurePageComboOverrides(pageComboOverrideManifest(recoveryManifestDomains));
  }
  if (expectedDomains !== null && activeDomains.length !== expectedDomains) {
    const selection = sourceRunId ? `active domains for source run ${sourceRunId}` : 'active domains';
    throw new Error(`Expected ${expectedDomains} ${selection}, found ${activeDomains.length}.`);
  }
  if (incrementalRunId && domainLimit !== null) {
    throw new Error('NAVER_PAGE_CATALOG_DOMAIN_LIMIT cannot be used with incremental mode.');
  }

  const domains = incrementalRunId
    ? await loadIncrementalDomains(client, activeDomains, incrementalRunId)
    : activeDomains;
  const limitedDomains = domainLimit === null ? domains : domains.slice(0, domainLimit);
  const contentVersion = resolveContentVersion(limitedDomains, site, incrementalRunId);
  const expectedPages = limitedDomains.reduce((sum, domain) => sum + domain.page_count, 0);
  const affectedPages = incrementalRunId
    ? limitedDomains.reduce((sum, domain) => sum + incrementalAffectedPageCount(domain), 0)
    : expectedPages;

  validateSitePageCounts(site, limitedDomains);
  const dimensions = normalizeDimensions(site.pageCatalogDimensions(limitedDomains));
  dimensions.locations = uniqueStrings([
    ...dimensions.locations,
    ...pageComboOverrideLocations(limitedDomains)
  ]);
  dimensions.mainKeywords = uniqueStrings([
    ...dimensions.mainKeywords,
    ...pageComboOverrideKeywords(limitedDomains)
  ]);

  console.log(JSON.stringify({
    phase: 'plan',
    groupKey,
    incrementalRunId: incrementalRunId || null,
    sourceRunId: sourceRunId || null,
    accountRolloutRoles,
    dryRun,
    force,
    domains: limitedDomains.length,
    pages: expectedPages,
    affectedPages,
    contentVersion,
    locations: dimensions.locations.length,
    mainKeywords: dimensions.mainKeywords.length,
    batchDomainCount
  }));

  if (dryRun) {
    validateSampleMappings(site, limitedDomains);
    if (incrementalRunId) await validateIncrementalBaseline(client, limitedDomains);
    process.exitCode = 0;
  } else {
    const locationIds = await loadDictionaryIds(client, 'naver_page_locations', dimensions.locations);
    const keywordIds = await syncDictionary(client, 'naver_page_keywords', dimensions.mainKeywords);
    if (incrementalRunId) {
      await validateIncrementalBaseline(client, limitedDomains);
      const verification = await syncIncrementalCatalog(
        client,
        site,
        limitedDomains,
        locationIds,
        keywordIds,
        contentVersion
      );
      console.log(JSON.stringify({
        phase: 'complete',
        ...verification,
        sourceRunId: sourceRunId || null
      }, null, 2));
    } else {
      const completed = force ? new Map() : await loadCompletedDomains(client, limitedDomains, contentVersion);
      const pending = limitedDomains.filter((domain) => completed.get(String(domain.id)) !== domain.page_count);

      console.log(JSON.stringify({
        phase: 'resume',
        completeDomains: limitedDomains.length - pending.length,
        pendingDomains: pending.length
      }));

      let insertedPages = 0;
      const startedAt = Date.now();
      for (let offset = 0; offset < pending.length; offset += batchDomainCount) {
        const batch = pending.slice(offset, offset + batchDomainCount);
        const values = buildBatch(site, batch, locationIds, keywordIds);
        await replaceDomainBatch(client, batch, values, contentVersion);
        insertedPages += values.requestIds.length;
        const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        console.log(JSON.stringify({
          phase: 'load',
          processedDomains: Math.min(offset + batch.length, pending.length),
          pendingDomains: pending.length,
          insertedPages,
          rowsPerSecond: Math.round(insertedPages / elapsedSeconds)
        }));
      }

      if (domainLimit === null && !sourceRunId) await pruneInactiveDomains(client);
      await client.query('analyze public.naver_project_pages');
      const verification = await verifyCatalog(client, limitedDomains, contentVersion);
      console.log(JSON.stringify({
        phase: 'complete',
        ...verification,
        sourceRunId: sourceRunId || null
      }, null, 2));
    }
  }
} finally {
  await client.end();
}

async function loadDomains(client, exactSourceRunId = '', rolloutRoles = accountRolloutRoles) {
  const result = await client.query(
    `
      select id, host, page_count, source_run_id, source_payload
      from public.naver_project_domains
      where group_key = $1
        and deployment_status = 'active'
        and is_visible = true
        and ($2::text = '' or source_run_id = $2)
        and (
          cardinality($3::text[]) = 0
          or exists (
            select 1
            from public.naver_project_group_account_controls control
            where control.group_key = naver_project_domains.group_key
              and control.naver_account_id = naver_project_domains.naver_account_id
              and control.rollout_role = any($3::text[])
          )
        )
      order by coalesce((source_payload->>'globalSiteOrder')::integer, 2147483647), id
    `,
    [groupKey, exactSourceRunId, rolloutRoles]
  );
  const domains = result.rows;
  if (['gosim', 'bbungbbung', 'recovery-law'].includes(groupKey)) {
    await attachPageComboOverrideMirrors(client, domains, groupKey);
  }
  return domains;
}

async function attachPageComboOverrideMirrors(client, domains, overrideGroupKey) {
  const byId = new Map(domains.map((domain) => [String(domain.id), []]));
  const result = await client.query(
    `
      select override.domain_id, override.source_page_id, override.global_slot,
             override.location_id, override.location_search_name,
             location.name as location, location.search_name as resolved_location_search_name,
             override.main_keyword_id, keyword.name as main_keyword
      from public.naver_project_page_combo_overrides override
      join public.naver_page_locations location on location.id = override.location_id
      join public.naver_page_keywords keyword on keyword.id = override.main_keyword_id
      where override.group_key = $1
        and override.domain_id = any($2::bigint[])
      order by override.domain_id, override.source_page_id
    `,
    [overrideGroupKey, domains.map((domain) => domain.id)]
  );
  for (const row of result.rows) {
    const items = byId.get(String(row.domain_id));
    if (!items) throw new Error(`${overrideGroupKey} override references unknown domain_id=${row.domain_id}.`);
    if (String(row.location_search_name) !== String(row.resolved_location_search_name)) {
      throw new Error(
        `${overrideGroupKey} override location search key mismatch for domain_id=${row.domain_id}`
        + ` source_page_id=${row.source_page_id}.`
      );
    }
    items.push(pageComboOverrideItem(row));
  }

  for (const domain of domains) {
    const items = byId.get(String(domain.id)) || [];
    const mirror = createPageComboOverrideMirror(items);
    const payloadMirror = domain.source_payload?.pageComboOverrides;
    if (payloadMirror && !pageComboOverrideMirrorsMatch(payloadMirror, mirror)) {
      throw new Error(`${domain.host}: source_payload page combo overrides differ from DB.`);
    }
    domain.source_payload = { ...(domain.source_payload || {}), pageComboOverrides: mirror };
  }
}

async function loadIncrementalDomains(client, activeDomains, runId) {
  const runResult = await client.query(
    `
      select run_id, group_key, target_domain_count
      from public.weekly_page_expansion_runs
      where run_id = $1
    `,
    [runId]
  );
  if (!runResult.rowCount) throw new Error(`Weekly expansion run not found: ${runId}`);
  const run = runResult.rows[0];
  if (run.group_key !== groupKey) {
    throw new Error(`Weekly expansion run ${runId} belongs to ${run.group_key}, not ${groupKey}.`);
  }

  const targetResult = await client.query(
    `
      select host, previous_page_count, target_page_count, status, metadata
      from public.weekly_page_expansion_targets
      where run_id = $1
      order by host
    `,
    [runId]
  );
  if (targetResult.rowCount !== run.target_domain_count) {
    throw new Error(
      `Weekly expansion target count mismatch for ${runId}: ${targetResult.rowCount}/${run.target_domain_count}.`
    );
  }
  const incomplete = targetResult.rows.filter((target) => target.status !== 'complete');
  if (incomplete.length) {
    throw new Error(`Weekly expansion run ${runId} still has ${incomplete.length} incomplete targets.`);
  }

  const activeByHost = new Map(activeDomains.map((domain) => [domain.host, domain]));
  return targetResult.rows.map((target) => {
    const domain = activeByHost.get(target.host);
    if (!domain) throw new Error(`${target.host}: weekly target is not an active visible domain.`);
    if (domain.page_count !== target.target_page_count) {
      throw new Error(
        `${target.host}: DB page_count=${domain.page_count}, weekly target=${target.target_page_count}.`
      );
    }
    if (['gosim', 'bbungbbung', 'recovery-law'].includes(groupKey)) {
      const frozenMirror = target.metadata?.pageComboOverrides;
      const dbMirror = domain.source_payload?.pageComboOverrides;
      if (!pageComboOverrideMirrorsMatch(frozenMirror, dbMirror)) {
        throw new Error(`${target.host}: frozen ${groupKey} override mirror differs from DB.`);
      }
    }
    return {
      ...domain,
      incremental_target: {
        previousPageCount: target.previous_page_count,
        targetPageCount: target.target_page_count,
        metadata: target.metadata || {}
      }
    };
  });
}

function pageComboOverrideKeywords(domains) {
  return uniqueStrings((domains || []).flatMap((domain) => (
    domain.source_payload?.pageComboOverrides?.items || []
  ).map((item) => item?.mainKeyword)));
}

function pageComboOverrideLocations(domains) {
  return uniqueStrings((domains || []).flatMap((domain) => (
    domain.source_payload?.pageComboOverrides?.items || []
  ).map((item) => item?.location)));
}

function pageComboOverrideManifest(domains) {
  const emptyMirror = createPageComboOverrideMirror([]);
  return {
    schemaVersion: 1,
    hosts: Object.fromEntries((domains || []).map((domain) => [
      domain.host,
      domain.source_payload?.pageComboOverrides || emptyMirror
    ]))
  };
}

function resolveContentVersion(domains, site, runId = '') {
  const explicit = String(process.env.NAVER_PAGE_CATALOG_CONTENT_VERSION || '').trim();
  if (explicit) return explicit;
  if (runId) return runId;
  if (typeof site.pageCatalogContentVersion === 'function') {
    const generated = String(site.pageCatalogContentVersion(domains) || '').trim();
    if (!generated) throw new Error(`${siteModulePath} returned an empty page catalog content version.`);
    return generated;
  }
  const versions = [...new Set(domains.map((domain) => String(domain.source_run_id || '').trim()).filter(Boolean))];
  if (versions.length !== 1) {
    throw new Error(`Set NAVER_PAGE_CATALOG_CONTENT_VERSION when active domains have ${versions.length} source versions.`);
  }
  return versions[0];
}

function validateSitePageCounts(site, domains) {
  if (typeof site.pageCountForHost !== 'function') return;
  for (const domain of domains) {
    const modulePageCount = site.pageCountForHost(domain.host, domain);
    if (modulePageCount !== domain.page_count) {
      throw new Error(`${domain.host}: DB page_count=${domain.page_count}, site module=${modulePageCount}.`);
    }
  }
}

function normalizeDimensions(value) {
  const locations = uniqueStrings(value?.locations);
  const mainKeywords = uniqueStrings(value?.mainKeywords);
  if (!locations.length || !mainKeywords.length) throw new Error('Page catalog dimensions are empty.');
  return { locations, mainKeywords };
}

function validateSampleMappings(site, domains) {
  for (const domain of [domains[0], domains[Math.floor(domains.length / 2)], domains.at(-1)].filter(Boolean)) {
    for (const requestId of [1, Math.min(51, domain.page_count), domain.page_count]) {
      const entry = site.pageCatalogEntryForRequestId(requestId, domain.host, domain);
      if (!entry?.path || !entry?.location || !entry?.mainKeyword) {
        throw new Error(`${domain.host}/${requestId}: invalid page catalog entry.`);
      }
      console.log(JSON.stringify({ phase: 'sample', host: domain.host, ...entry }));
    }
  }
}

async function syncDictionary(client, tableName, names) {
  for (let offset = 0; offset < names.length; offset += dictionaryBatchSize) {
    const batch = names.slice(offset, offset + dictionaryBatchSize);
    await client.query(
      `insert into public.${tableName} (name)
       select value from unnest($1::text[]) as input(value)
       on conflict (name) do nothing`,
      [batch]
    );
  }

  const ids = new Map();
  for (let offset = 0; offset < names.length; offset += dictionaryBatchSize) {
    const batch = names.slice(offset, offset + dictionaryBatchSize);
    const result = await client.query(
      `select id, name from public.${tableName} where name = any($1::text[])`,
      [batch]
    );
    for (const row of result.rows) ids.set(row.name, row.id);
  }
  if (ids.size !== names.length) throw new Error(`${tableName}: expected ${names.length} IDs, found ${ids.size}.`);
  return ids;
}

async function loadDictionaryIds(client, tableName, names) {
  const ids = new Map();
  for (let offset = 0; offset < names.length; offset += dictionaryBatchSize) {
    const batch = names.slice(offset, offset + dictionaryBatchSize);
    const result = await client.query(
      `select id, name from public.${tableName} where name = any($1::text[])`,
      [batch]
    );
    for (const row of result.rows) ids.set(row.name, row.id);
  }
  if (ids.size !== names.length) {
    const missing = names.filter((name) => !ids.has(name)).slice(0, 10);
    throw new Error(
      `${tableName}: DB rollout source is missing ${names.length - ids.size}/${names.length} names: ${missing.join(', ')}`
    );
  }
  return ids;
}

async function loadCompletedDomains(client, domains, contentVersion) {
  const ids = domains.map((domain) => domain.id);
  const result = await client.query(
    `
      select domain_id, count(*)::integer as page_count
      from public.naver_project_pages
      where group_key = $1
        and content_version = $2
        and domain_id = any($3::bigint[])
      group by domain_id
    `,
    [groupKey, contentVersion, ids]
  );
  return new Map(result.rows.map((row) => [String(row.domain_id), row.page_count]));
}

function buildBatch(site, domains, locationIds, keywordIds) {
  const values = {
    domainIds: [],
    requestIds: [],
    paths: [],
    locationIds: [],
    keywordIds: []
  };

  for (const domain of domains) {
    for (let requestId = 1; requestId <= domain.page_count; requestId += 1) {
      const entry = site.pageCatalogEntryForRequestId(requestId, domain.host, domain);
      if (!entry) throw new Error(`${domain.host}/${requestId}: page catalog entry is missing.`);
      const locationId = locationIds.get(entry.location);
      const keywordId = keywordIds.get(entry.mainKeyword);
      if (!locationId || !keywordId) {
        throw new Error(`${domain.host}/${requestId}: missing dictionary ID for ${entry.location} / ${entry.mainKeyword}.`);
      }
      values.domainIds.push(domain.id);
      values.requestIds.push(requestId);
      values.paths.push(entry.path);
      values.locationIds.push(locationId);
      values.keywordIds.push(keywordId);
    }
  }
  return values;
}

function incrementalStartRequestId(domain) {
  const target = domain.incremental_target;
  if (!target) throw new Error(`${domain.host}: incremental target metadata is missing.`);
  const previousPageCount = optionalInteger(target.previousPageCount);
  const targetPageCount = positiveInteger(target.targetPageCount, 0);
  if (previousPageCount === null || targetPageCount !== domain.page_count) {
    throw new Error(`${domain.host}: invalid incremental page counts.`);
  }

  let startRequestId = previousPageCount + 1;
  if (groupKey === 'gosim') {
    const semanticPageCount = positiveInteger(
      target.metadata?.legacySemanticPostCount,
      positiveInteger(domain.source_payload?.legacySemanticPostCount, 0)
    );
    if (!semanticPageCount || semanticPageCount > previousPageCount) {
      throw new Error(`${domain.host}: invalid gosim legacy semantic page count ${semanticPageCount}.`);
    }
    startRequestId = previousPageCount - semanticPageCount + 1;
  }

  if (startRequestId < 1 || startRequestId > targetPageCount) {
    throw new Error(`${domain.host}: invalid incremental range ${startRequestId}-${targetPageCount}.`);
  }
  return startRequestId;
}

function incrementalAffectedPageCount(domain) {
  return domain.page_count - incrementalStartRequestId(domain) + 1;
}

function buildIncrementalBatch(site, domains, locationIds, keywordIds) {
  const values = {
    domainIds: [],
    requestIds: [],
    paths: [],
    locationIds: [],
    keywordIds: []
  };

  for (const domain of domains) {
    const startRequestId = incrementalStartRequestId(domain);
    for (let requestId = startRequestId; requestId <= domain.page_count; requestId += 1) {
      const entry = site.pageCatalogEntryForRequestId(requestId, domain.host, domain);
      if (!entry) throw new Error(`${domain.host}/${requestId}: page catalog entry is missing.`);
      const locationId = locationIds.get(entry.location);
      const keywordId = keywordIds.get(entry.mainKeyword);
      if (!locationId || !keywordId) {
        throw new Error(`${domain.host}/${requestId}: missing dictionary ID for ${entry.location} / ${entry.mainKeyword}.`);
      }
      values.domainIds.push(domain.id);
      values.requestIds.push(requestId);
      values.paths.push(entry.path);
      values.locationIds.push(locationId);
      values.keywordIds.push(keywordId);
    }
  }
  return values;
}

async function validateIncrementalBaseline(client, domains) {
  const ranges = domains.map((domain) => ({
    domain_id: domain.id,
    start_request_id: incrementalStartRequestId(domain)
  }));
  const result = await client.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as row(domain_id bigint, start_request_id integer)
      )
      select input.domain_id, input.start_request_id,
             count(page.request_id)::integer as retained_pages
      from input
      left join public.naver_project_pages page
        on page.domain_id = input.domain_id
       and page.group_key = $2
       and page.request_id < input.start_request_id
      group by input.domain_id, input.start_request_id
      having count(page.request_id) <> input.start_request_id - 1
    `,
    [JSON.stringify(ranges), groupKey]
  );
  if (result.rowCount) {
    throw new Error(`Incremental catalog baseline mismatch: ${JSON.stringify(result.rows.slice(0, 10))}`);
  }
  console.log(JSON.stringify({ phase: 'incremental-baseline', domains: domains.length, status: 'ok' }));
}

async function syncIncrementalCatalog(client, site, domains, locationIds, keywordIds, contentVersion) {
  let insertedPages = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < domains.length; offset += batchDomainCount) {
    const batch = domains.slice(offset, offset + batchDomainCount);
    const values = buildIncrementalBatch(site, batch, locationIds, keywordIds);
    await replaceIncrementalBatch(client, batch, values, contentVersion);
    insertedPages += values.requestIds.length;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    console.log(JSON.stringify({
      phase: 'incremental-load',
      processedDomains: Math.min(offset + batch.length, domains.length),
      domains: domains.length,
      insertedPages,
      rowsPerSecond: Math.round(insertedPages / elapsedSeconds)
    }));
  }
  return await verifyIncrementalCatalog(client, domains, contentVersion, insertedPages);
}

async function replaceIncrementalBatch(client, domains, values, contentVersion) {
  const ranges = domains.map((domain) => ({
    domain_id: domain.id,
    start_request_id: incrementalStartRequestId(domain)
  }));
  await client.query('begin');
  try {
    await client.query(
      `
        delete from public.naver_project_pages page
        using jsonb_to_recordset($1::jsonb) as input(domain_id bigint, start_request_id integer)
        where page.domain_id = input.domain_id
          and page.request_id >= input.start_request_id
      `,
      [JSON.stringify(ranges)]
    );
    await client.query(
      `
        insert into public.naver_project_pages (
          group_key, domain_id, request_id, path,
          location_id, main_keyword_id, content_version
        )
        select $1, input.domain_id, input.request_id, input.path,
               input.location_id, input.main_keyword_id, $2
        from unnest(
          $3::bigint[], $4::integer[], $5::text[], $6::integer[], $7::integer[]
        ) as input(domain_id, request_id, path, location_id, main_keyword_id)
      `,
      [
        groupKey,
        contentVersion,
        values.domainIds,
        values.requestIds,
        values.paths,
        values.locationIds,
        values.keywordIds
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function verifyIncrementalCatalog(client, domains, contentVersion, insertedPages) {
  const ranges = domains.map((domain) => ({
    domain_id: domain.id,
    start_request_id: incrementalStartRequestId(domain),
    target_page_count: domain.page_count
  }));
  const result = await client.query(
    `
      with input as (
        select *
        from jsonb_to_recordset($1::jsonb) as row(
          domain_id bigint,
          start_request_id integer,
          target_page_count integer
        )
      )
      select input.domain_id,
             count(page.request_id)::integer as total_pages,
             count(page.request_id) filter (
               where page.request_id >= input.start_request_id
             )::integer as affected_pages,
             count(page.request_id) filter (
               where page.request_id >= input.start_request_id
                 and page.content_version = $3
             )::integer as current_version_pages,
             input.start_request_id,
             input.target_page_count
      from input
      left join public.naver_project_pages page
        on page.domain_id = input.domain_id
       and page.group_key = $2
      group by input.domain_id, input.start_request_id, input.target_page_count
      having count(page.request_id) <> input.target_page_count
         or count(page.request_id) filter (
              where page.request_id >= input.start_request_id
            ) <> input.target_page_count - input.start_request_id + 1
         or count(page.request_id) filter (
              where page.request_id >= input.start_request_id
                and page.content_version = $3
            ) <> input.target_page_count - input.start_request_id + 1
    `,
    [JSON.stringify(ranges), groupKey, contentVersion]
  );
  if (result.rowCount) {
    throw new Error(`Incremental catalog verification failed: ${JSON.stringify(result.rows.slice(0, 10))}`);
  }
  return {
    groupKey,
    incrementalRunId,
    contentVersion,
    domains: domains.length,
    pages: domains.reduce((sum, domain) => sum + domain.page_count, 0),
    affectedPages: insertedPages
  };
}

async function replaceDomainBatch(client, domains, values, contentVersion) {
  const domainIds = domains.map((domain) => domain.id);
  await client.query('begin');
  try {
    await client.query(
      `delete from public.naver_project_pages where domain_id = any($1::bigint[])`,
      [domainIds]
    );
    await client.query(
      `
        insert into public.naver_project_pages (
          group_key, domain_id, request_id, path,
          location_id, main_keyword_id, content_version
        )
        select $1, input.domain_id, input.request_id, input.path,
               input.location_id, input.main_keyword_id, $2
        from unnest(
          $3::bigint[], $4::integer[], $5::text[], $6::integer[], $7::integer[]
        ) as input(domain_id, request_id, path, location_id, main_keyword_id)
      `,
      [
        groupKey,
        contentVersion,
        values.domainIds,
        values.requestIds,
        values.paths,
        values.locationIds,
        values.keywordIds
      ]
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function pruneInactiveDomains(client) {
  const result = await client.query(
    `
      delete from public.naver_project_pages page
      where page.group_key = $1
        and not exists (
          select 1
          from public.naver_project_domains domain
          where domain.id = page.domain_id
            and domain.group_key = $1
            and domain.deployment_status = 'active'
            and domain.is_visible = true
        )
    `,
    [groupKey]
  );
  console.log(JSON.stringify({ phase: 'prune', deletedPages: result.rowCount }));
}

async function verifyCatalog(client, domains, contentVersion) {
  const domainIds = domains.map((domain) => domain.id);
  const expectedPages = domains.reduce((sum, domain) => sum + domain.page_count, 0);
  const result = await client.query(
    `
      select count(*)::bigint as pages,
             count(distinct domain_id)::integer as domains,
             count(distinct location_id)::integer as locations,
             count(distinct main_keyword_id)::integer as main_keywords,
             count(*) filter (where content_version = $2)::bigint as current_version_pages
      from public.naver_project_pages
      where group_key = $1
        and domain_id = any($3::bigint[])
    `,
    [groupKey, contentVersion, domainIds]
  );
  const row = result.rows[0];
  if (Number(row.pages) !== expectedPages || row.domains !== domains.length || Number(row.current_version_pages) !== expectedPages) {
    throw new Error(`Catalog verification failed: ${JSON.stringify(row)}, expected pages=${expectedPages}, domains=${domains.length}.`);
  }
  return { groupKey, contentVersion, expectedPages, ...row };
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultSiteModuleForGroup(value) {
  if (value === 'recovery-law') return 'apps/recovery-law/src/site.mjs';
  if (value === 'gosim') return 'apps/gosim/src/lib/pageCatalog.mjs';
  if (value === 'gosim-dynamic') return 'apps/gosim-dynamic/src/lib/pageCatalog.mjs';
  if (value === 'dabom') return 'apps/dabom-plumbing/dist/site.mjs';
  return 'apps/bbungbbung-piping/src/site.mjs';
}

function splitList(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function configureSiteEnvironment(domains) {
  if (groupKey !== 'recovery-law' || !domains.length) return;

  const pageCount = uniqueInteger(domains.map((domain) => domain.page_count), 'page_count');
  const runtimeValues = {
    PUBLIC_NUMERIC_PAGE_COUNT: pageCount,
    RECOVERY_LAW_NUMERIC_PAGE_COUNT: pageCount,
    RECOVERY_LAW_LINK_ROUTE_STYLE: 'slug',
    RECOVERY_LAW_EXPANSION_BASE_PAGE_COUNT: uniquePayloadInteger(domains, 'expansionBasePageCount'),
    RECOVERY_LAW_EXPANSION_HOST_COUNT: uniquePayloadInteger(domains, 'expansionHostCount'),
    RECOVERY_LAW_EXPANSION_INCREMENT: uniquePayloadInteger(domains, 'expansionIncrement'),
    RECOVERY_LAW_EXPANSION_GLOBAL_SLOT_BASE: uniquePayloadInteger(domains, 'expansionGlobalSlotBase')
  };

  for (const [name, value] of Object.entries(runtimeValues)) {
    if (value === null) continue;
    if (process.env[name] !== undefined && process.env[name] !== String(value)) {
      throw new Error(`${name}=${process.env[name]} does not match the DB runtime value ${value}.`);
    }
    process.env[name] = String(value);
  }

  console.log(JSON.stringify({ phase: 'runtime', groupKey, ...runtimeValues }));
}

function uniquePayloadInteger(domains, key) {
  const values = domains
    .map((domain) => domain.source_payload?.[key])
    .filter((value) => value !== undefined && value !== null && value !== '');
  if (!values.length) return null;
  return uniqueInteger(values, `source_payload.${key}`);
}

function uniqueInteger(values, label) {
  const numbers = [...new Set(values.map(Number))];
  if (numbers.length !== 1 || !Number.isSafeInteger(numbers[0]) || numbers[0] < 0) {
    throw new Error(`${label} must have one non-negative integer value; found ${numbers.join(', ')}.`);
  }
  return numbers[0];
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}

function createClientConfig(value) {
  const url = new URL(value);
  const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');
  return { connectionString: url.toString(), ssl: requiresSsl ? { rejectUnauthorized: false } : undefined };
}
