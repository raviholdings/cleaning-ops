#!/usr/bin/env node
/**
 * 저장된 세션으로 서치어드바이저 콘솔에 실제로 들어가지는지 확인한다.
 *
 *   node scripts/check-naver-session-alive.mjs --account <id>
 *   -> 살아 있으면 exit 0, 죽었으면 exit 1
 *
 * DB 에 secret_id 가 있는지만 보는 건 소용이 없다. 값이 있어도 네이버가
 * 로그인 화면을 돌려주는 경우가 있어서(2026-08-06) 실제 접속으로 판정한다.
 * 무인 러너가 이걸로 걸러 죽은 세션 계정은 건너뛴다.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(resolve(projectRoot, '.env'));

const args = process.argv.slice(2);
const accountId = optionValue('--account');
if (!accountId) throw new Error('--account 가 필요합니다.');

const statePath = resolve(projectRoot, 'tmp/naver-login', `${accountId}.alive.json`);
mkdirSync(dirname(statePath), { recursive: true });

let ok = false;
let reason = '';
try {
  execFileSync(process.execPath, [
    resolve(projectRoot, 'scripts/export-naver-searchadvisor-session.mjs'),
    '--account', accountId, '--output', statePath,
  ], { stdio: 'pipe' });
} catch (error) {
  console.log(JSON.stringify({ accountId, alive: false, reason: '저장된 세션 없음' }));
  process.exit(1);
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ storageState: statePath, locale: 'ko-KR' });
  const page = await context.newPage();
  await page.goto('https://searchadvisor.naver.com/console/board', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  const title = (await page.title()) || '';
  const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ');

  if (url.includes('nid.naver.com')) reason = '로그인 페이지로 튕김';
  else if (/아이디 또는 전화번호|로그인 상태 유지|추가 확인을 해주세요/.test(body)) reason = '로그인 화면';
  else if (!/사이트 관리|웹마스터 도구/.test(body)) reason = `콘솔 화면 아님: ${body.slice(0, 50)}`;
  else ok = true;

  console.log(JSON.stringify({ accountId, alive: ok, title: title.slice(0, 40), reason }));
} catch (error) {
  console.log(JSON.stringify({ accountId, alive: false, reason: error.message.split('\n')[0] }));
} finally {
  await browser.close().catch(() => {});
  rmSync(statePath, { force: true });
}

process.exit(ok ? 0 : 1);

function optionValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
