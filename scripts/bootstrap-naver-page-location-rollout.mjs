#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  loadPageLocationRolloutPlan,
  validatePageLocationRolloutRows
} from './lib/naver-page-location-rollout.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const options = parseOptions(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const paths = {
  legal: projectPath(options.legalFile || process.env.NAVER_PAGE_LOCATION_ROLLOUT_LEGAL_FILE
    || 'apps/gosim/src/data/legalLocationVariants.generated.json'),
  administrative: projectPath(options.administrativeFile
    || process.env.NAVER_PAGE_LOCATION_ROLLOUT_ADMINISTRATIVE_FILE
    || 'apps/gosim/src/data/administrativeLocationVariants.generated.json'),
  additions: projectPath(options.additionsFile || process.env.NAVER_PAGE_LOCATION_ROLLOUT_ADDITIONS_FILE
    || 'scripts/data/naverPageLocationDeploymentAdditions.generated.json'),
  migration: projectPath(options.migrationFile || process.env.NAVER_PAGE_LOCATION_ROLLOUT_MIGRATION_FILE
    || 'supabase/migrations/20260714190000_add_naver_page_location_rollout_order.sql')
};
const dryRun = options.dryRun || process.env.NAVER_PAGE_LOCATION_ROLLOUT_DRY_RUN === '1';
const applyMigration = options.applyMigration
  || process.env.NAVER_PAGE_LOCATION_ROLLOUT_APPLY_MIGRATION === '1';
const batchSize = positiveInteger(
  options.batchSize || process.env.NAVER_PAGE_LOCATION_ROLLOUT_BATCH_SIZE,
  5_000
);

for (const [label, path] of Object.entries(paths)) {
  if (label !== 'migration' || applyMigration) requireFile(path, label);
}

const plan = loadPageLocationRolloutPlan({
  legalPath: paths.legal,
  administrativePath: paths.administrative,
  additionsPath: paths.additions
});
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new pg.Client(createClientConfig(connectionString));
await client.connect();
let transactionStarted = false;

try {
  if (applyMigration) await client.query(readFileSync(paths.migration, 'utf8'));

  const before = await loadAllLocationRows(client);
  const summary = summarizeChanges(before, plan);
  console.log(JSON.stringify({
    phase: 'plan',
    dryRun,
    applyMigration,
    ...summary,
    counts: plan.counts,
    hashes: plan.hashes
  }, null, 2));

  if (dryRun) {
    process.exitCode = 0;
  } else {
    await client.query('begin');
    transactionStarted = true;
    await client.query('set local statement_timeout = 0');
    await client.query(`select pg_advisory_xact_lock(hashtext('naver_page_locations_rollout_bootstrap'))`);
    await client.query('lock table public.naver_page_locations in share row exclusive mode');
    await client.query(`
      create temporary table naver_page_location_rollout_plan (
        rollout_order integer primary key,
        rollout_source text not null,
        name text not null unique
      ) on commit drop
    `);

    for (let offset = 0; offset < plan.rows.length; offset += batchSize) {
      const batch = plan.rows.slice(offset, offset + batchSize);
      await client.query(
        `
          insert into naver_page_location_rollout_plan (rollout_order, rollout_source, name)
          select * from unnest($1::integer[], $2::text[], $3::text[])
        `,
        [
          batch.map((row) => row.rolloutOrder),
          batch.map((row) => row.rolloutSource),
          batch.map((row) => row.name)
        ]
      );
    }

    const inserted = await client.query(`
      insert into public.naver_page_locations (name)
      select name
      from naver_page_location_rollout_plan
      order by rollout_order
      on conflict (name) do nothing
    `);
    await client.query(`
      update public.naver_page_locations
      set rollout_order = null,
          rollout_source = null
      where rollout_order is not null
         or rollout_source is not null
    `);
    const assigned = await client.query(`
      update public.naver_page_locations location
      set rollout_order = plan.rollout_order,
          rollout_source = plan.rollout_source
      from naver_page_location_rollout_plan plan
      where location.name = plan.name
    `);
    if (assigned.rowCount !== plan.counts.total) {
      throw new Error(`Assigned rollout rows mismatch: ${assigned.rowCount}/${plan.counts.total}.`);
    }

    const rolloutRows = await loadRolloutRows(client);
    const verification = validatePageLocationRolloutRows(rolloutRows, plan);
    await client.query('commit');
    transactionStarted = false;

    console.log(JSON.stringify({
      phase: 'complete',
      insertedRows: inserted.rowCount,
      preservedRows: plan.counts.total - inserted.rowCount,
      counts: verification.counts,
      hashes: verification.hashes
    }, null, 2));
  }
} catch (error) {
  if (transactionStarted) await client.query('rollback').catch(() => {});
  throw error;
} finally {
  await client.end();
}

async function loadAllLocationRows(client) {
  const result = await client.query(`
    select id, name, rollout_order, rollout_source
    from public.naver_page_locations
    order by id
  `);
  return result.rows;
}

async function loadRolloutRows(client) {
  const result = await client.query(`
    select name, rollout_order, rollout_source
    from public.naver_page_locations
    where rollout_order is not null
       or rollout_source is not null
    order by rollout_order nulls last, id
  `);
  return result.rows;
}

function summarizeChanges(existingRows, plan) {
  const existingByName = new Map(existingRows.map((row) => [row.name, row]));
  const expectedNames = new Set(plan.locations);
  let existingPlanRows = 0;
  let assignmentsToChange = 0;
  for (const expected of plan.rows) {
    const existing = existingByName.get(expected.name);
    if (!existing) continue;
    existingPlanRows += 1;
    if (Number(existing.rollout_order) !== expected.rolloutOrder
        || existing.rollout_source !== expected.rolloutSource) {
      assignmentsToChange += 1;
    }
  }
  const staleRolloutRows = existingRows.filter((row) => (
    row.rollout_order !== null || row.rollout_source !== null
  ) && !expectedNames.has(row.name)).length;
  return {
    databaseRowsBefore: existingRows.length,
    existingPlanRows,
    rowsToInsert: plan.counts.total - existingPlanRows,
    assignmentsToChange,
    staleRolloutRows,
    databaseRowsAfter: existingRows.length + plan.counts.total - existingPlanRows
  };
}

function parseOptions(args) {
  const options = {};
  const valueOptions = new Map([
    ['--legal-file', 'legalFile'],
    ['--administrative-file', 'administrativeFile'],
    ['--additions-file', 'additionsFile'],
    ['--migration-file', 'migrationFile'],
    ['--batch-size', 'batchSize']
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--apply-migration') options.applyMigration = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      const [key, inlineValue] = arg.split('=', 2);
      const optionName = valueOptions.get(key);
      if (!optionName) throw new Error(`Unknown argument: ${arg}`);
      const value = inlineValue ?? args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${key} requires a value.`);
      options[optionName] = value;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/bootstrap-naver-page-location-rollout.mjs [options]

Assign the stable Gosim/Bbungbbung rollout order without deleting or replacing existing DB rows.

Options:
  --dry-run                    Report inserts/order changes without changing rollout data
  --apply-migration            Apply the rollout-column migration before bootstrapping
  --legal-file PATH            Override the legal-location JSON
  --administrative-file PATH   Override the administrative-location JSON
  --additions-file PATH        Override the 4,669 checklist additions JSON
  --migration-file PATH        Override the SQL migration
  --batch-size NUMBER          Temporary-plan insert batch size (default: 5000)
`);
}

function projectPath(path) {
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} file does not exist: ${path}`);
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Expected a positive integer, found ${value}.`);
  return number;
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
