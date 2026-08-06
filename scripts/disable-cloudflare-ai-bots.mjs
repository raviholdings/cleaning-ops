import fs from 'fs';

const envText = fs.readFileSync('.env', 'utf8');
const env = {};
envText.split(/\r?\n/).forEach(line => {
  const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let v = match[2] || '';
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    env[match[1]] = v;
  }
});

const apiKey = env.CLOUDFLARE_API_KEY;
const email = env.CLOUDFLARE_EMAIL;

const targetZones = ['amunsa.com', 'neverfoul.com', 'daddul.com', 'ddulea.com', 'anclose.com', 'uloung.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'naoheg.com', 'one-qfast.com'];

for (const zoneName of targetZones) {
  const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zoneName}`, {
    headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' }
  });
  const zonesData = await zonesRes.json();
  const zoneId = zonesData.result?.[0]?.id;
  if (!zoneId) continue;

  // Turn off AI Scraper Managed Robots.txt
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ai_scrapers_and_crawlers`, {
    method: 'PATCH',
    headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'off' })
  });
  const data = await res.json();
  console.log(`Disabled Cloudflare Managed robots.txt for ${zoneName}:`, data.success || data.errors?.[0]?.message);
}
