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

const targetZones = ['pipe-oneshot.com', 'oneshot-sewer.com', 'naoheg.com', 'one-qfast.com'];

for (const zoneName of targetZones) {
  const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${zoneName}`, {
    headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' }
  });
  const zonesData = await zonesRes.json();
  const zoneId = zonesData.result?.[0]?.id;
  if (!zoneId) continue;

  // Check Certs
  const certRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/ssl/certificate_packs`, {
    headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' }
  });
  const certData = await certRes.json();

  console.log(`=== Cloudflare Cert Status for ${zoneName} ===`);
  certData.result?.forEach(pack => {
    console.log(`  Type: ${pack.type}, Status: ${pack.status}, Hosts: ${pack.hosts?.join(', ')}`);
  });
}
