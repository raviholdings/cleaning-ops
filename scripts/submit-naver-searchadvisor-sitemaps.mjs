#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const rootDir = process.cwd();
const dryRun = process.argv.includes('--dry-run');

console.log(`=== Naver Search Advisor Sitemap Submitter (pure fetch, dryRun=${dryRun}) ===`);

const client = new Client({
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
  ssl: { rejectUnauthorized: false }
});
await client.connect();

const verifiedDomainsRes = await client.query(`
  select id, host, site_url, naver_account_id
    from public.naver_project_domains
   where naver_registration_status = 'verified'
   order by naver_account_id, host;
`);

const domains = verifiedDomainsRes.rows;
console.log(`Found ${domains.length} verified domains in DB.`);

const accountsMap = {};
domains.forEach(d => {
  if (!accountsMap[d.naver_account_id]) accountsMap[d.naver_account_id] = [];
  accountsMap[d.naver_account_id].push(d);
});

console.log(`Accounts to process (${Object.keys(accountsMap).length}): ${Object.keys(accountsMap).join(', ')}`);

if (dryRun) {
  console.log('[DRY-RUN] Will submit sitemaps for the following accounts and domains:');
  Object.entries(accountsMap).forEach(([accId, doms]) => {
    console.log(`  - Account ${accId}: ${doms.length} domains (e.g. ${doms[0].host})`);
  });
  await client.end();
  process.exit(0);
}

for (const [accountId, accDomains] of Object.entries(accountsMap)) {
  console.log(`\n▶ Processing Account ${accountId} (${accDomains.length} domains)...`);
  
  // Find storage state session
  const sessionPath = path.join(rootDir, `tmp/naver-crawl-runtime`, `${accountId}-cleaning-ravi.storage.json`);
  let cookieHeader = '';
  try {
    const rawState = await fs.readFile(sessionPath, 'utf8');
    const state = JSON.parse(rawState);
    const cookies = state.cookies || [];
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`  Loaded ${cookies.length} session cookies from ${path.basename(sessionPath)}`);
  } catch (e) {
    console.warn(`  ⚠️ Session cookie file not found: ${sessionPath}`);
  }

  let submittedCount = 0;
  let errorCount = 0;

  for (const domain of accDomains) {
    const origin = domain.site_url.replace(/\/+$/, '');
    const sitemapUrl = `${origin}/sitemap.xml`;
    const refererUrl = `https://searchadvisor.naver.com/console/site/request/sitemap?site=${encodeURIComponent(origin)}`;

    try {
      const response = await fetch('https://searchadvisor.naver.com/api-console/request/sitemap', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
          cookie: cookieHeader,
          origin: 'https://searchadvisor.naver.com',
          referer: refererUrl,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          site: origin,
          sitemap: sitemapUrl
        })
      });

      const resText = await response.text();
      if (response.ok || resText.includes('success') || resText.includes('등록') || resText.includes('완료') || resText.includes('이미')) {
        submittedCount++;
        process.stdout.write('.');
      } else {
        errorCount++;
        console.log(`\n  ⚠️ [${domain.host}] response (${response.status}): ${resText.slice(0, 120)}`);
      }
    } catch (err) {
      errorCount++;
      console.log(`\n  ✗ [${domain.host}] failed: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`\n  ✅ Account ${accountId} finished: Submitted ${submittedCount}, Errors ${errorCount}`);
}

await client.end();
console.log('\n=== Sitemap Submit Pipeline Completed ===');
