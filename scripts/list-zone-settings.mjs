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

const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=amunsa.com`, {
  headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' }
});
const zonesData = await zonesRes.json();
const zoneId = zonesData.result?.[0]?.id;

const settingsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings`, {
  headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey, 'Content-Type': 'application/json' }
});
const settingsData = await settingsRes.json();
console.log('Available Settings ID List:');
settingsData.result?.forEach(s => console.log(' -', s.id, ':', s.value));
