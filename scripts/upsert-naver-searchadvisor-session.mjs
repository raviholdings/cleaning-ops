#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

loadLocalEnv('.env');

const args = process.argv.slice(2);
const accountId = optionValue('--account') || process.env.NAVER_SESSION_ACCOUNT_ID || '';
const storageStatePath = optionValue('--storage-state') || process.env.NAVER_SESSION_STORAGE_STATE || '';
const savedPublicIp = optionValue('--saved-ip') || process.env.NAVER_SESSION_SAVED_PUBLIC_IP || null;
const validatedPublicIp = optionValue('--validated-ip') || process.env.NAVER_SESSION_VALIDATED_PUBLIC_IP || savedPublicIp;
const sessionValidationStatus = optionValue('--status') || process.env.NAVER_SESSION_STATUS || 'valid';
const note = optionValue('--note') || process.env.NAVER_SESSION_NOTE || '';

if (!accountId) throw new Error('--account is required.');
if (!storageStatePath) throw new Error('--storage-state is required.');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL or DIRECT_URL is required.');

const storageStateText = readFileSync(storageStatePath, 'utf8');
const storageState = JSON.parse(storageStateText);
const cookieCount = Array.isArray(storageState.cookies) ? storageState.cookies.length : 0;
const originCount = Array.isArray(storageState.origins) ? storageState.origins.length : 0;
const byteCount = Buffer.byteLength(storageStateText);
const cookieNames = new Set((Array.isArray(storageState.cookies) ? storageState.cookies : []).map((cookie) => cookie?.name).filter(Boolean));
const normalizedStatus = String(sessionValidationStatus || '').trim().toLowerCase();

if (!cookieCount) {
	throw new Error(`Storage state has no cookies: ${storageStatePath}`);
}

if (normalizedStatus === 'valid' && (!cookieNames.has('NID_AUT') || !cookieNames.has('NID_SES'))) {
	throw new Error(`Storage state is missing Naver login cookies NID_AUT/NID_SES: ${storageStatePath}`);
}

const client = new Client(createClientConfig(connectionString));
await client.connect();

try {
	await ensureSchema(client);

	const existing = await client.query(
		`
			select account_id, searchadvisor_session_secret_id
			from public.naver_searchadvisor_accounts
			where account_id = $1
			limit 1
		`,
		[accountId]
	);
	if (!existing.rowCount) {
		throw new Error(`Naver Search Advisor account does not exist: ${accountId}`);
	}

	const secretName = `naver-searchadvisor-session:${accountId}`;
	const secretDescription = `Naver Search Advisor Playwright storage state for ${accountId}`;
	let secretId = existing.rows[0].searchadvisor_session_secret_id || null;

	if (secretId) {
		await client.query(
			'select vault.update_secret($1::uuid, $2::text, $3::text, $4::text, null::uuid)',
			[secretId, storageStateText, secretName, secretDescription]
		);
	} else {
		const created = await client.query(
			'select vault.create_secret($1::text, $2::text, $3::text, null::uuid) as id',
			[storageStateText, secretName, secretDescription]
		);
		secretId = created.rows[0]?.id || null;
	}

	const updated = await client.query(
		`
			update public.naver_searchadvisor_accounts
			set status = case
			      when lower($8) = 'valid' and status <> 'site_limit_full' then 'active'
			      when lower($8) in ('blocked', 'invalid', 'expired', 'failed', 'stored-local-unvalidated') then 'blocked'
			      else status
			    end,
			    searchadvisor_session_secret_id = $2::uuid,
			    searchadvisor_session_saved_at = now(),
			    searchadvisor_session_validated_at = now(),
			    searchadvisor_session_cookie_count = $3,
			    searchadvisor_session_origin_count = $4,
			    searchadvisor_session_bytes = $5,
			    searchadvisor_session_saved_public_ip = nullif($6, '')::inet,
			    searchadvisor_session_validated_public_ip = nullif($7, '')::inet,
			    searchadvisor_session_note = nullif($9, ''),
			    updated_at = now()
			where account_id = $1
			returning status
		`,
		[
			accountId,
			secretId,
			cookieCount,
			originCount,
			byteCount,
			savedPublicIp || '',
			validatedPublicIp || '',
			sessionValidationStatus,
			note
		]
	);

	console.log(JSON.stringify({
		accountId,
		hasSessionSecret: Boolean(secretId),
		cookieCount,
		originCount,
		byteCount,
		accountStatus: updated.rows[0]?.status || '',
		sessionValidationStatus,
		savedPublicIp,
		validatedPublicIp
	}, null, 2));
} finally {
	await client.end();
}

async function ensureSchema(client) {
	await client.query(`
		alter table public.naver_searchadvisor_accounts
		  add column if not exists searchadvisor_session_secret_id uuid,
		  add column if not exists searchadvisor_session_saved_at timestamptz,
		  add column if not exists searchadvisor_session_validated_at timestamptz,
		  add column if not exists searchadvisor_session_cookie_count integer,
		  add column if not exists searchadvisor_session_origin_count integer,
		  add column if not exists searchadvisor_session_bytes integer,
		  add column if not exists searchadvisor_session_saved_public_ip inet,
		  add column if not exists searchadvisor_session_validated_public_ip inet,
		  add column if not exists searchadvisor_session_note text;
	`);
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
