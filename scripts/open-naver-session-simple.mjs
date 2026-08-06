import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync('tmp/naver-login/lguxp4nlw.storage.json', 'utf8'));
const ctx = await chromium.launchPersistentContext('tmp/naver-login/view', {
  headless: false, channel: 'chrome', viewport: null, locale: 'ko-KR',
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  ignoreDefaultArgs: ['--enable-automation'],
});
await ctx.addCookies(state.cookies);
const p = ctx.pages()[0] || await ctx.newPage();
await p.goto('https://searchadvisor.naver.com/console/board', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
const txt = (await p.evaluate(() => document.body?.innerText || ''));
const rows = txt.split('\n').filter(l => /amunsa|anclose|daddul|ddulea|naoheg|neverfoul|qfast|sewer|oneshot|uloung/.test(l));
console.log('화면에 보이는 사이트 행:', rows.length, '건');
rows.slice(0, 8).forEach(r => console.log('  ' + r.trim().slice(0, 90)));
console.log('\n브라우저 열어뒀습니다. 다 보시면 창을 닫아주세요.');
await new Promise((resolve) => ctx.on('close', resolve));
console.log('닫혔습니다.');
