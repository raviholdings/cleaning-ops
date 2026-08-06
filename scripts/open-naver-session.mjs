import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import pg from 'pg';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env','utf8');
const g = k => (env.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim();
const ACCOUNT = process.argv[2] || 'lguxp4nlw';

const c = new pg.Client({ connectionString: g('DATABASE_URL'), ssl:{rejectUnauthorized:false} });
await c.connect();
const a = (await c.query(
  `select account_id, host(searchadvisor_session_validated_public_ip) ip from public.naver_searchadvisor_accounts where account_id=$1`, [ACCOUNT])).rows[0];
const doms = (await c.query(
  `select count(*) total, count(naver_verification_token) with_token,
          count(*) filter (where naver_registration_status='registered') registered
     from public.naver_project_domains where naver_account_id=$1`, [ACCOUNT])).rows[0];
await c.end();

const curIp = execFileSync('curl',['-s','--max-time','15',`https://api.ipify.org?_ts=${Date.now()}`],{encoding:'utf8'}).trim();
console.log(`계정      : ${a.account_id}`);
console.log(`배정 IP   : ${a.ip}`);
console.log(`현재 IP   : ${curIp}  ${curIp===a.ip ? '✅ 일치' : '❌ 불일치'}`);
console.log(`이 계정 사이트: 총 ${doms.total}건 / 등록됨 ${doms.registered} / 토큰보유 ${doms.with_token}`);
if (curIp !== a.ip) { console.log('IP 가 달라 중단합니다.'); process.exit(1); }

execFileSync(process.execPath, ['scripts/export-naver-searchadvisor-session.mjs','--account',ACCOUNT,'--output',`tmp/naver-login/${ACCOUNT}.storage.json`], {stdio:'pipe'});

const ctx = await chromium.launchPersistentContext(`tmp/naver-login/${ACCOUNT}-view`, {
  headless: false, channel: 'chrome', viewport: null, locale: 'ko-KR',
  args: ['--disable-blink-features=AutomationControlled','--start-maximized'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const state = JSON.parse(readFileSync(`tmp/naver-login/${ACCOUNT}.storage.json`,'utf8'));
await ctx.addCookies(state.cookies);
const p = ctx.pages()[0] || await ctx.newPage();
await p.goto('https://searchadvisor.naver.com/console/board', { waitUntil:'domcontentloaded', timeout:60000 });
console.log('\n브라우저를 띄웠습니다. 직접 보세요. (20분 뒤 자동 종료)');
console.log('현재 화면:', p.url());
await p.waitForTimeout(20*60*1000);
await ctx.close();
