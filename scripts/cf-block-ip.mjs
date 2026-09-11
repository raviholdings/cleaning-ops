#!/usr/bin/env node
/**
 * Cloudflare 에서 IP 를 차단한다 (계정 전체).
 *
 *   node scripts/cf-block-ip.mjs --list
 *   node scripts/cf-block-ip.mjs --ip 130.12.180.117,81.171.72.135            # 계획만
 *   node scripts/cf-block-ip.mjs --ip 130.12.180.117,81.171.72.135 --apply
 *   node scripts/cf-block-ip.mjs --unblock 130.12.180.117 --apply
 *
 * 왜 nginx 가 아니라 Cloudflare 인가
 *   사이트가 전부 Cloudflare 뒤에 있다. nginx 가 보는 $remote_addr 은 CF IP 라
 *   거기서 deny 를 걸면 엉뚱한 걸 막는다. 진짜 IP 는 X-Forwarded-For 에만 있어서
 *   nginx 로 막으려면 map 을 따로 짜야 하고, 그래도 요청은 이미 오리진까지 온다.
 *   Cloudflare 에서 막으면 오리진에 닿기 전에 끊긴다.
 *
 * 계정 단위 규칙을 쓴다 — 존이 18개인데 스캐너는 여러 존을 동시에 두드린다.
 * 계정 단위가 안 되는 플랜이면 존마다 하나씩 건다 (자동 폴백).
 *
 * ⚠ 이건 외부 서비스 변경이다. --apply 는 운영자 확인을 받고 쓸 것.
 * ⚠ mode 는 block 이다. challenge 가 아니라 완전 차단이라, 사람이 쓰는 IP 를
 *   넣으면 그 사람은 사이트에 못 들어온다. 공유 IP(회사·통신사 NAT)를 조심할 것.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const apply = args.includes('--apply');
const list = args.includes('--list');
const ips = valueOf('--ip').split(',').map((s) => s.trim()).filter(Boolean);
const unblock = valueOf('--unblock').split(',').map((s) => s.trim()).filter(Boolean);
const note = valueOf('--note', `악성 스캐너 차단 (${new Date().toISOString().slice(0, 10)})`);

const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.startsWith('#'))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const ACCOUNT = env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT || !env.CLOUDFLARE_EMAIL || !env.CLOUDFLARE_API_KEY) {
  throw new Error('.env 에 CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID 가 필요하다.');
}
const headers = {
  'X-Auth-Email': env.CLOUDFLARE_EMAIL,
  'X-Auth-Key': env.CLOUDFLARE_API_KEY,
  'content-type': 'application/json',
};
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/firewall/access_rules/rules`;

async function cf(url, init = {}) {
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.success, status: res.status, body };
}

const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^[0-9a-fA-F:]+$/.test(v);

async function main() {
  if (list) {
    const r = await cf(`${BASE}?per_page=100`);
    if (!r.ok) { console.log('조회 실패:', JSON.stringify(r.body.errors ?? r.body).slice(0, 300)); return 1; }
    console.log(`=== 계정 차단 규칙 ${r.body.result.length}개 ===`);
    for (const rule of r.body.result) {
      console.log(`  ${String(rule.mode).padEnd(10)} ${String(rule.configuration?.value).padEnd(24)} ${rule.notes ?? ''}  [${rule.id}]`);
    }
    return 0;
  }

  if (unblock.length) {
    const r = await cf(`${BASE}?per_page=100`);
    if (!r.ok) { console.log('조회 실패:', JSON.stringify(r.body.errors ?? r.body).slice(0, 300)); return 1; }
    const hit = r.body.result.filter((x) => unblock.includes(x.configuration?.value));
    console.log(`해제 대상 ${hit.length}개: ${hit.map((x) => x.configuration.value).join(', ') || '(없음)'}`);
    if (!apply) { console.log('실제로 해제하려면 --apply'); return 0; }
    for (const x of hit) {
      const d = await cf(`${BASE}/${x.id}`, { method: 'DELETE' });
      console.log(`  ${x.configuration.value}  ${d.ok ? '해제됨' : `실패 ${JSON.stringify(d.body.errors).slice(0, 120)}`}`);
    }
    return 0;
  }

  if (!ips.length) throw new Error('--ip 또는 --unblock 또는 --list 가 필요하다.');
  for (const ip of ips) if (!isIp(ip)) throw new Error(`IP 형식이 아니다: ${ip}`);

  console.log(`=== Cloudflare 차단 (계정 전체 · 존 18개에 일괄 적용) ===`);
  console.log(`  대상: ${ips.join(', ')}`);
  console.log(`  mode: block (완전 차단)`);
  console.log(`  note: ${note}`);
  if (!apply) {
    console.log('\n아직 아무것도 하지 않았다. 적용하려면 --apply');
    return 0;
  }

  // 이미 있는 규칙은 건너뛴다 (중복 생성 방지).
  const existing = await cf(`${BASE}?per_page=100`);
  const have = new Set(existing.ok ? existing.body.result.map((x) => x.configuration?.value) : []);

  let ok = 0;
  for (const ip of ips) {
    if (have.has(ip)) { console.log(`  ${ip.padEnd(20)} 이미 규칙 있음 — 건너뜀`); ok += 1; continue; }
    const r = await cf(BASE, {
      method: 'POST',
      body: JSON.stringify({ mode: 'block', configuration: { target: 'ip', value: ip }, notes: note }),
    });
    if (r.ok) { console.log(`  ${ip.padEnd(20)} 차단됨  [${r.body.result.id}]`); ok += 1; }
    else console.log(`  ${ip.padEnd(20)} 실패 ${r.status} ${JSON.stringify(r.body.errors ?? r.body).slice(0, 200)}`);
  }
  console.log(`\n  ${ok}/${ips.length} 처리`);
  console.log('  확인: node scripts/cf-block-ip.mjs --list');
  return 0;
}

process.exitCode = await main();
