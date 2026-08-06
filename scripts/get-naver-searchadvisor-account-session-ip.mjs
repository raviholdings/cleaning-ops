#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

loadLocalEnv('.env');

const args = process.argv.slice(2);
const accountId = optionValue('--account') || process.env.NAVER_SESSION_ACCOUNT_ID || '';
const publicIp = optionValue('--ip') || process.env.NAVER_SESSION_PUBLIC_IP || '';
const excludeAccountId = optionValue('--exclude-account') || process.env.NAVER_SESSION_EXCLUDE_ACCOUNT_ID || '';

if (!accountId && !publicIp) throw new Error('--account or --ip is required.');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	if (publicIp) {
		const result = await client.query(
			`
				select account_id,
				       host(searchadvisor_session_validated_public_ip) as validated_public_ip,
				       host(searchadvisor_session_saved_public_ip) as saved_public_ip,
				       searchadvisor_session_validated_at,
				       searchadvisor_session_saved_at,
				       status as account_status
				from public.naver_searchadvisor_accounts
				where (
					searchadvisor_session_validated_public_ip = $1::inet
					or searchadvisor_session_saved_public_ip = $1::inet
				)
				and ($2 = '' or account_id <> $2)
				order by searchadvisor_session_validated_at desc nulls last,
				         searchadvisor_session_saved_at desc nulls last,
				         account_id
			`,
			[publicIp, excludeAccountId]
		);

		console.log(JSON.stringify({
			publicIp,
			excludeAccountId,
			conflict: result.rowCount > 0,
			accounts: result.rows.map((row) => ({
				accountId: row.account_id,
				validatedPublicIp: row.validated_public_ip || '',
				savedPublicIp: row.saved_public_ip || '',
				validatedAt: row.searchadvisor_session_validated_at,
				savedAt: row.searchadvisor_session_saved_at,
				accountStatus: row.account_status || ''
			}))
		}, null, 2));
	} else {
		const result = await client.query(
			`
				select account_id,
				       host(searchadvisor_session_validated_public_ip) as validated_public_ip,
				       host(searchadvisor_session_saved_public_ip) as saved_public_ip,
				       searchadvisor_session_validated_at,
				       searchadvisor_session_saved_at,
				       status as account_status
				from public.naver_searchadvisor_accounts
				where account_id = $1
				limit 1
			`,
			[accountId]
		);

		if (!result.rowCount) {
			throw new Error(`Naver Search Advisor account does not exist: ${accountId}`);
		}

		const row = result.rows[0];
		const preferredPublicIp = row.validated_public_ip || row.saved_public_ip || '';
		console.log(JSON.stringify({
			accountId: row.account_id,
			preferredPublicIp,
			validatedPublicIp: row.validated_public_ip || '',
			savedPublicIp: row.saved_public_ip || '',
			validatedAt: row.searchadvisor_session_validated_at,
			savedAt: row.searchadvisor_session_saved_at,
			accountStatus: row.account_status || ''
		}, null, 2));
	}
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
