#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const projectRoot = process.cwd();

loadLocalEnv(resolve(projectRoot, '.env'));

const includeGroups = splitEnv(process.env.NAVER_CRAWL_INCLUDE_GROUPS || '');
const excludeGroups = new Set(splitEnv(process.env.NAVER_CRAWL_EXCLUDE_GROUPS || ''));
const includeAccounts = splitEnv(process.env.NAVER_CRAWL_INCLUDE_ACCOUNTS || '');
const excludeAccounts = new Set(splitEnv(process.env.NAVER_CRAWL_EXCLUDE_ACCOUNTS || ''));
const runnerPc = normalizeRunnerPc(
	process.env.NAVER_CRAWL_RUNNER_PC
	|| process.env.NAVER_WINDOWS_CRAWL_RUNNER_PC
	|| ''
);
const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	const values = [];
	const filters = [];
	if (includeGroups.length > 0) {
		values.push(includeGroups);
		filters.push(`group_key = any($${values.length}::text[])`);
	}
	if (excludeGroups.size > 0) {
		values.push(Array.from(excludeGroups));
		filters.push(`not (group_key = any($${values.length}::text[]))`);
	}
	if (includeAccounts.length > 0) {
		values.push(includeAccounts);
		filters.push(`naver_account_id = any($${values.length}::text[])`);
	}
	if (excludeAccounts.size > 0) {
		values.push(Array.from(excludeAccounts));
		filters.push(`not (naver_account_id = any($${values.length}::text[]))`);
	}
	if (runnerPc) {
		values.push(runnerPc);
		filters.push(`crawl_runner_pc = $${values.length}`);
	}

	const where = filters.length ? `where ${filters.join('\n  and ')}` : '';
	const { rows } = await client.query(
		`
			select
				group_key,
				target_project,
				crawl_runner_pc,
				naver_account_id,
				domain_count,
				page_count,
				run_order
			from public.naver_project_group_crawl_accounts
			${where}
			order by run_order, group_key, naver_account_id
		`,
		values
	);
	const runs = rows.map((row) => ({
		Account: row.naver_account_id,
		Project: row.target_project,
		GroupKey: row.group_key,
		RunnerPc: row.crawl_runner_pc,
		DomainCount: Number(row.domain_count || 0),
		PageCount: Number(row.page_count || 0),
	}));
	console.log(JSON.stringify(runs, null, 2));
} finally {
	await client.end();
}

function splitEnv(value) {
	return String(value || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeRunnerPc(value) {
	return String(value || '').trim().toLowerCase();
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
		process.env[match[1]] = value.replace(/\\n/g, '\n');
	}
}

function createClientConfig(value) {
	const url = new URL(value);
	const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
	url.searchParams.delete('sslmode');
	url.searchParams.delete('ssl');

	return {
		connectionString: url.toString(),
		ssl: requiresSsl ? { rejectUnauthorized: false } : undefined
	};
}
