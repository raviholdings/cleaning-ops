/**
 * 네이버 자동화 스크립트가 공통으로 쓰는 프록시 설정 해석기.
 *
 * 목적은 IP 관리다. HaiIP 는 회선 하나로 동시에 IP 를 하나만 유지할 수 있어
 * 계정을 순차로만 돌릴 수 있는데, 프록시를 쓰면 계정별 IP 를 동시에 잡을 수 있다.
 *
 * 우선순위
 *   1) NAVER_PROXY_ACCOUNT_MAP 파일에 계정별 항목이 있으면 그것
 *   2) 없으면 전역 환경변수 한 벌
 *
 * 환경변수는 두 이름을 다 받는다. 중립적인 NAVER_PROXY_* 를 권장하고,
 * BRIGHT_DATA_PROXY_* 는 지시서 호환용으로 유지한다. 어느 업체든 동일하게 쓴다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on']);

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function enabledByEnv() {
  const value = env('NAVER_PROXY_ENABLED', 'BRIGHT_DATA_PROXY_ENABLED');
  return TRUTHY.has(value.toLowerCase());
}

/** server 값이 스킴 없이 오는 경우가 흔해서 기본 스킴을 붙여준다. */
function normalizeServer(value) {
  const server = String(value || '').trim();
  if (!server) return '';
  return /^[a-z0-9+.-]+:\/\//i.test(server) ? server : `http://${server}`;
}

function loadAccountMap(projectRoot) {
  const configured = env('NAVER_PROXY_ACCOUNT_MAP');
  if (!configured) return {};
  const path = isAbsolute(configured) ? configured : resolve(projectRoot, configured);
  if (!existsSync(path)) {
    console.warn(`[proxy] NAVER_PROXY_ACCOUNT_MAP 파일이 없습니다: ${path}`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn(`[proxy] NAVER_PROXY_ACCOUNT_MAP 파싱 실패: ${error.message}`);
    return {};
  }
}

/**
 * 프록시 설정을 해석한다.
 *
 * @param {object} params
 * @param {boolean} params.cliFlag        --use-proxy / --use-brightdata 등이 들어왔는지
 * @param {string}  params.accountId      계정별 매핑을 찾을 키 (선택)
 * @param {string}  params.projectRoot    상대경로 기준
 * @returns {{enabled:boolean, server:string, username:string, password:string,
 *            source:string, accountId:string}}
 */
export function resolveProxyConfig({ cliFlag = false, accountId = '', projectRoot = process.cwd() } = {}) {
  const enabled = Boolean(cliFlag) || enabledByEnv();
  const disabled = { enabled: false, server: '', username: '', password: '', source: 'disabled', accountId };
  if (!enabled) return disabled;

  const map = loadAccountMap(projectRoot);
  const perAccount = accountId && map[accountId] ? map[accountId] : null;

  const server = normalizeServer(
    perAccount?.server || env('NAVER_PROXY_SERVER', 'BRIGHT_DATA_PROXY_SERVER'),
  );
  const username = String(perAccount?.username || env('NAVER_PROXY_USERNAME', 'BRIGHT_DATA_PROXY_USERNAME') || '');
  const password = String(perAccount?.password || env('NAVER_PROXY_PASSWORD', 'BRIGHT_DATA_PROXY_PASSWORD') || '');

  if (!server) {
    throw new Error(
      '프록시를 켰지만 서버 주소가 없습니다. NAVER_PROXY_SERVER(또는 BRIGHT_DATA_PROXY_SERVER) 를 설정하거나 '
      + 'NAVER_PROXY_ACCOUNT_MAP 에 해당 계정 항목을 넣으세요.',
    );
  }

  return {
    enabled: true,
    server,
    username,
    password,
    source: perAccount ? 'account-map' : 'env',
    accountId,
  };
}

/** Playwright launch 옵션에 넣을 proxy 객체. 비활성이면 undefined 를 준다. */
export function playwrightProxy(config) {
  if (!config?.enabled || !config.server) return undefined;
  const proxy = { server: config.server };
  if (config.username) proxy.username = config.username;
  if (config.password) proxy.password = config.password;
  return proxy;
}

/** 로그에 찍어도 되는 형태. 자격증명은 가린다. */
export function describeProxy(config) {
  if (!config?.enabled) return { enabled: false };
  return {
    enabled: true,
    server: config.server,
    username: config.username ? `${config.username.slice(0, 4)}***` : '',
    hasPassword: Boolean(config.password),
    source: config.source,
    accountId: config.accountId || undefined,
  };
}

/**
 * 프록시를 쓰면 IP 는 프록시가 결정하므로 HaiIP 로 로컬 IP 를 바꿀 이유가 없다.
 * 기존 --no-haiip 와 같은 효과를 내되, 이유를 로그로 남긴다.
 */
export function resolveCdpUrl(options = {}) {
  const cdpUrl = String(
    options.cdpUrl
    || options.cdp
    || process.env.BRIGHT_DATA_CDP_URL
    || process.env.NAVER_CDP_URL
    || '',
  ).trim();
  return cdpUrl;
}

export function shouldSkipHaiIp(config, explicitSkip = false, cdpUrl = '') {
  if (explicitSkip) return { skip: true, reason: 'no-haiip 플래그' };
  if (cdpUrl) return { skip: true, reason: 'Bright Data Scraping Browser CDP 모드' };
  if (config?.enabled) return { skip: true, reason: '프록시 모드' };
  return { skip: false, reason: '' };
}

export function logProxyBanner(config, label, cdpUrl = '') {
  if (cdpUrl) {
    console.log(`[BRIGHT-DATA-CDP] Enabled for ${label} (Scraping Browser)`);
    return;
  }
  if (!config?.enabled) return;
  console.log(`[BRIGHT-DATA-PROXY] Enabled for ${label}`);
  console.log(`[proxy] ${JSON.stringify(describeProxy(config))}`);
}
