#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

loadLocalEnv('.env');

const args = process.argv.slice(2);
const accountId = optionValue('--account') || process.env.NAVER_SESSION_ACCOUNT_ID || '';
const outputPath = resolve(process.cwd(), optionValue('--output') || process.env.NAVER_SESSION_OUTPUT || `tmp/naver-login/${accountId}.storage.json`);

if (!accountId) throw new Error('--account is required.');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	const result = await client.query(
		`
			select account.account_id,
			       account.searchadvisor_session_secret_id,
			       account.searchadvisor_session_cookie_count,
			       account.searchadvisor_session_bytes,
			       account.status as account_status,
			       secret.decrypted_secret
			from public.naver_searchadvisor_accounts account
			left join vault.decrypted_secrets secret
			  on secret.id = account.searchadvisor_session_secret_id
			where account.account_id = $1
			limit 1
		`,
		[accountId]
	);

	if (!result.rowCount) throw new Error(`Naver Search Advisor account does not exist: ${accountId}`);
	const row = result.rows[0];
	if (!row.searchadvisor_session_secret_id || !row.decrypted_secret) {
		throw new Error(`No stored Search Advisor session for account: ${accountId}`);
	}

	JSON.parse(row.decrypted_secret);
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, row.decrypted_secret);
	chmodSync(outputPath, 0o600);

	console.log(JSON.stringify({
		accountId,
		outputPath,
		cookieCount: row.searchadvisor_session_cookie_count,
		byteCount: row.searchadvisor_session_bytes,
		accountStatus: row.account_status
	}, null, 2));
} finally {
	await client.end();
}

function optionValue(name) {
	const index = args.indexOf(name);
	if (index === -1) return '';
	return args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : '';
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
		if (!match) continue;

		const [, key, rawValue] = match;
		if (process.env[key] !== undefined) continue;

		let value = rawValue.trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		process.env[key] = value.replace(/\\n/g, '\n');
	}
}
