#!/usr/bin/env node
// Apply SQL files from supabase/migrations to the project database.
//
//   node scripts/apply-migrations.mjs                 # apply every .sql, in name order
//   node scripts/apply-migrations.mjs <file> [...]    # apply specific files
//   node scripts/apply-migrations.mjs --dry-run       # list what would run
//
// Uses DIRECT_URL when it resolves, otherwise falls back to DATABASE_URL.
// Each file is sent as one simple query so in-file BEGIN/COMMIT works.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicit = args.filter((arg) => !arg.startsWith('--'));

loadLocalEnv('.env');

const migrationsDir = resolve('supabase/migrations');
const files = explicit.length
  ? explicit.map((file) => resolve(file))
  : readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => resolve(migrationsDir, name));

if (!files.length) {
  console.log('no migration files found');
  process.exit(0);
}

if (dryRun) {
  console.log(files.map((file) => `would apply ${basename(file)}`).join('\n'));
  process.exit(0);
}

const connectionString = await pickConnectionString();
const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  statement_timeout: 600000,
});

await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const started = Date.now();
    await client.query(sql);
    console.log(`applied ${basename(file)} (${Date.now() - started}ms)`);
  }
} finally {
  await client.end();
}

async function pickConnectionString() {
  const direct = process.env.DIRECT_URL;
  const pooled = process.env.DATABASE_URL;
  if (!direct && !pooled) throw new Error('DIRECT_URL or DATABASE_URL is required');
  if (!direct) return pooled;

  // Supabase direct hosts are IPv6-only on newer projects; probe before using.
  try {
    const probe = new pg.Client({
      connectionString: direct,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    await probe.connect();
    await probe.end();
    return direct;
  } catch (error) {
    if (!pooled) throw error;
    console.log(`DIRECT_URL unreachable (${error.code || error.message}); using DATABASE_URL`);
    return pooled;
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
