import fs from 'fs';
import path from 'path';

// Load .env
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

console.log('Using Cloudflare Email:', email);

async function checkZone(zoneName) {
  const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zoneName}`, {
    headers: {
      'X-Auth-Email': email,
      'X-Auth-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });
  const zonesData = await zonesRes.json();
  if (!zonesData.result || zonesData.result.length === 0) {
    console.log(`❌ Zone not found for ${zoneName}`);
    return;
  }

  const zoneId = zonesData.result[0].id;
  const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
    headers: {
      'X-Auth-Email': email,
      'X-Auth-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });
  const dnsData = await dnsRes.json();
  console.log(`\n=== Cloudflare DNS Records for ${zoneName} (Zone: ${zoneId}) ===`);
  dnsData.result?.forEach(rec => {
    console.log(`  [${rec.type}] ${rec.name} -> ${rec.content} (Proxied: ${rec.proxied})`);
  });
}

const targetZones = ['pipe-oneshot.com', 'oneshot-sewer.com', 'naoheg.com', 'one-qfast.com'];
for (const z of targetZones) {
  await checkZone(z);
}
