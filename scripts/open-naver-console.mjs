#!/usr/bin/env node
/**
 * 저장된 세션으로 서치어드바이저 콘솔을 눈에 보이는 크롬으로 연다 (사람이 직접 보고 만지는 용도).
 *
 *   node scripts/open-naver-console.mjs --account jtyw13691
 *   node scripts/open-naver-console.mjs --account jtyw13691 --minutes 60
 *   node scripts/open-naver-console.mjs --account jtyw13691 --ignore-ip   # IP 안 맞아도 강행(비권장)
 *
 * open-naver-session.mjs 와 같은 일을 하되 DATABASE_URL 을 환경변수에서 받는다(naverops 래퍼용).
 * 창을 닫으면 스크립트도 끝난다. 아무것도 자동으로 누르지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb) => { const i = args.indexOf(flag); return i === -1 ? fb : args[i + 1]; };
const account = valueOf('--account', '');
const minutes = Number(valueOf('--minutes', 60));
const ignoreIp = args.includes('--ignore-ip');
const url = valueOf('--url', 'https://searchadvisor.naver.com/console/board');
if (!account) throw new Error('--account <아이디> 필요');

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
if (!connectionString) throw new Error('DATABASE_URL 필요 (naverops 래퍼로 실행)');

const c = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await c.connect();
const a = (await c.query(
  `select account_id, status, searchadvisor_session_secret_id is not null as has_session,
          host(searchadvisor_session_validated_public_ip) as ip
     from public.naver_searchadvisor_accounts where account_id = $1`, [account])).rows[0];
const d = (await c.query(
  `select count(*) as total,
          count(*) filter (where naver_registration_status = 'registered') as registered,
          count(*) filter (where naver_registration_status = 'verified') as verified,
          count(*) filter (where naver_registration_status = 'pending') as pending
     from public.naver_project_domains where naver_account_id = $1`, [account])).rows[0];
await c.end();
if (!a) throw new Error(`DB 에 없는 계정: ${account}`);
if (!a.has_session) throw new Error('저장된 세션이 없습니다. 먼저 캡처하세요.');

const curIp = execFileSync('curl', ['-s', '--max-time', '15', `https://api.ipify.org?_ts=${Date.now()}`], { encoding: 'utf8' }).trim();
console.log(`계정      : ${a.account_id} (${a.status})`);
console.log(`배정 IP   : ${a.ip}`);
console.log(`현재 IP   : ${curIp}  ${curIp === a.ip ? '✅ 일치' : '❌ 불일치'}`);
console.log(`이 계정 사이트: 총 ${d.total}건 / 등록 ${d.registered} / 소유확인 ${d.verified} / 남음 ${d.pending}`);
if (curIp !== a.ip && !ignoreIp) {
  console.log('IP 가 달라 중단합니다. Hai-IP 로 배정 IP 로 맞추거나 --ignore-ip 를 쓰세요.');
  process.exit(1);
}

const statePath = resolve(projectRoot, `tmp/naver-login/${account}.storage.json`);
mkdirSync(dirname(statePath), { recursive: true });
execFileSync(process.execPath, [resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'), '--account', account, '--output', statePath], { stdio: 'pipe', env: process.env });

const ctx = await chromium.launchPersistentContext(resolve(projectRoot, `tmp/naver-login/${account}-view`), {
  headless: false, channel: 'chrome', viewport: null, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--lang=ko-KR'],
  ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
const { readFileSync } = await import('node:fs');
await ctx.addCookies(JSON.parse(readFileSync(statePath, 'utf8')).cookies || []);
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
console.log(`\n브라우저를 띄웠습니다: ${page.url()}`);
console.log(`창을 닫으면 끝납니다 (최대 ${minutes}분). 자동으로 아무것도 누르지 않습니다.`);

let closed = false;
ctx.on('close', () => { closed = true; });
const deadline = Date.now() + minutes * 60_000;
while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
if (!closed) { console.log('시간이 지나 창을 닫습니다.'); await ctx.close().catch(() => {}); }
console.log('종료했습니다.');
