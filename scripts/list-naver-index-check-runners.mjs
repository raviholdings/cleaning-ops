#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const projectRoot = process.cwd();

loadLocalEnv(resolve(projectRoot, '.env'));
loadLocalEnv(resolve(projectRoot, '.env.local'));

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	const { rows } = await client.query(`
		select
			group_key as runner,
			run_order
		from public.naver_project_groups
		where index_check_enabled is true
			and group_key is not null
		order by run_order, group_key
	`);

	const ordered = rows
		.sort((a, b) => (a.run_order - b.run_order) || a.runner.localeCompare(b.runner))
		.map((row) => row.runner)
		.filter(Boolean);

	console.log(ordered.join('\n'));
} finally {
	await client.end();
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
