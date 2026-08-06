#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultEndpoint = 'https://siwol-alert.vercel.app/card';
const defaultChannelName = 'bc1536b2-5b66-43cb-4bcc-61f5721de7c8';
const defaultReportPath = 'reports/naver-site-search/manual-crawl-submit-all-posts-ju-random-2026-05-20.json';

const sessionFailurePattern = /Naver login is required|Naver auto login failed|login did not complete|credentials were not found|anti-automation|captcha|CAPTCHA|보안문자|자동입력|Search Advisor API session|could not extract Search Advisor API session|api auth expired|auth\/login|nid\.naver\.com|oauth2\.0\/authorize|로그인에 문제가 발생|로그인이 필요|로그인 후|로그인하세요|로그인해 주세요/i;

export function isNaverCrawlSessionFailure(value) {
  if (!value) return false;
  const status = String(value.status || '');
  const note = String(value.note || value.message || value.error || value);
  const apiCode = Number(value.apiCode);

  if (isRecoverableSearchAdvisorCallbackProblem(note)) {
    return false;
  }

  return sessionFailurePattern.test(note)
    || (status === 'blocked' && apiCode === 601)
    || (status === 'blocked' && /automation|security|captcha|보안|자동/i.test(note));
}

function isRecoverableSearchAdvisorCallbackProblem(note) {
  const text = String(note || '');
  if (!/auth\/callback|searchadvisor\.naver\.com\/auth\/callback/i.test(text)) {
    return false;
  }

  if (/Naver login is required|Naver login page appeared|nid\.naver\.com|oauth2\.0\/authorize/i.test(text)) {
    return false;
  }

  return /crawl page hit Search Advisor auth callback|crawl page did not load expected site UI|문제가 발생|로그인에 문제가 발생|메인으로 이동/i.test(text);
}

export async function sendNaverCrawlSessionAlertSafe(params = {}) {
  try {
    return await sendNaverCrawlSessionAlert(params);
  } catch (error) {
    console.warn(`[crawl-alert] alert send failed: ${error?.message || String(error)}`);
    return { sent: false, reason: 'send-error', error };
  }
}

export async function sendNaverCrawlOperationalAlert({
  title = process.env.NAVER_CRAWL_ALERT_TITLE || 'Naver crawl runner alert',
  message = process.env.NAVER_CRAWL_ALERT_MESSAGE || '',
  infoList = [],
  dryRun = isEnabled(process.env.NAVER_CRAWL_ALERT_DRY_RUN),
} = {}) {
  const config = readAlertConfig();
  const payload = {
    channelName: config.channelName,
    title,
    message,
    infoList: normalizeInfoList(infoList),
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return { sent: false, reason: 'dry-run', payload };
  }

  if (!config.enabled) {
    return { sent: false, reason: 'disabled' };
  }

  if (!config.apiKey) {
    console.warn('[crawl-alert] skipped because NAVER_CRAWL_ALERT_API_KEY, SIWOL_ALERT_API_KEY, or INTERNAL_API_KEY is missing.');
    return { sent: false, reason: 'missing-api-key' };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  console.log(`[crawl-alert] sent NAVER WORKS alert to ${config.channelName}`);
  return { sent: true, status: response.status, bodyText };
}

export async function sendNaverCrawlSessionAlert({
  report,
  reportPath = process.env.NAVER_CRAWL_REPORT || defaultReportPath,
  queuePath = process.env.NAVER_CRAWL_QUEUE || '',
  row = null,
  error = null,
  runId = process.env.NAVER_CRAWL_RUN_ID || '',
  targetProject = process.env.NAVER_CRAWL_TARGET_PROJECT || 'watermelon-piping',
  triggerType = process.env.NAVER_CRAWL_TRIGGER || 'manual',
  dryRun = isEnabled(process.env.NAVER_CRAWL_ALERT_DRY_RUN),
} = {}) {
  const config = readAlertConfig();
  const rows = collectSessionFailureRows(report, row, error);

  if (!rows.length && !isNaverCrawlSessionFailure(error)) {
    return { sent: false, reason: 'no-session-failure' };
  }

  const representative = row
    || (isNaverCrawlSessionFailure(error) ? normalizeError(error) : null)
    || rows[0]
    || normalizeError(error);
  const payload = buildAlertPayload({
    report,
    reportPath,
    queuePath,
    row: representative,
    error,
    rows,
    runId,
    targetProject,
    triggerType,
    channelName: config.channelName,
  });

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return { sent: false, reason: 'dry-run', payload };
  }

  if (!config.enabled) {
    return { sent: false, reason: 'disabled' };
  }

  if (!config.apiKey) {
    console.warn('[crawl-alert] skipped because NAVER_CRAWL_ALERT_API_KEY, SIWOL_ALERT_API_KEY, or INTERNAL_API_KEY is missing.');
    return { sent: false, reason: 'missing-api-key' };
  }

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  console.log(`[crawl-alert] sent NAVER WORKS alert to ${config.channelName}`);
  return { sent: true, status: response.status, bodyText };
}

export function collectSessionFailureRows(report, row = null, error = null) {
  const rows = [];
  const hasSessionError = isNaverCrawlSessionFailure(error);
  if (row && isNaverCrawlSessionFailure(row)) rows.push(row);
  if (!row && hasSessionError) rows.push(normalizeError(error));
  if (!row && !hasSessionError && report?.results?.length) {
    for (const result of report.results) {
      if (isNaverCrawlSessionFailure(result)) rows.push(result);
    }
  }

  return dedupeRows(rows).slice(0, 10);
}

function buildAlertPayload({
  report,
  reportPath,
  queuePath,
  row,
  error,
  rows,
  runId,
  targetProject,
  triggerType,
  channelName,
}) {
  const failedCount = countSessionFailures(report, rows, row, error);
  const account = row?.account || report?.account || process.env.NAVER_CRAWL_ACCOUNT_ID || '-';
  const host = row?.host || safeHost(row?.url) || '-';
  const note = shorten(row?.note || error?.message || String(error || ''), 180);
  const occurredAt = row?.at || report?.updatedAt || new Date().toISOString();

  const infoList = [
    { label: '프로젝트', value: targetProject || '-' },
    { label: '실행구분', value: triggerType || '-' },
    { label: '계정', value: account },
    { label: '대상도메인', value: host },
    { label: '세션오류', value: String(failedCount) },
    { label: '리포트', value: relativePath(reportPath) },
    { label: '발생시각', value: formatKst(occurredAt) },
    { label: '조치', value: '원격 서버에서 네이버 로그인 세션을 갱신해주세요.' },
  ];

  if (runId) {
    infoList.splice(2, 0, { label: '실행ID', value: shorten(runId, 80) });
  }

  if (queuePath) {
    infoList.splice(6, 0, { label: '큐', value: relativePath(queuePath) });
  }

  if (row?.url && isHttpUrl(row.url)) {
    infoList.splice(5, 0, { label: '최근URL', value: shorten(row.url, 120), url: row.url });
  }

  if (note) {
    infoList.push({ label: '오류내용', value: note });
  }

  return {
    channelName,
    title: '수집요청 세션 확인 필요',
    message: '네이버 서치어드바이저 수집요청 중 로그인 세션 문제로 보이는 실패가 감지되었습니다.',
    infoList,
  };
}

function readAlertConfig() {
  return {
    enabled: process.env.NAVER_CRAWL_ALERT_ENABLED !== '0',
    endpoint: process.env.NAVER_CRAWL_ALERT_ENDPOINT
      || process.env.WATERMELON_CRAWL_ALERT_ENDPOINT
      || defaultEndpoint,
    apiKey: process.env.NAVER_CRAWL_ALERT_API_KEY
      || process.env.WATERMELON_CRAWL_ALERT_API_KEY
      || process.env.SIWOL_ALERT_API_KEY
      || process.env.INTERNAL_API_KEY
      || '',
    channelName: process.env.NAVER_CRAWL_ALERT_CHANNEL_NAME
      || process.env.WATERMELON_CRAWL_ALERT_CHANNEL_NAME
      || defaultChannelName,
  };
}

function countSessionFailures(report, rows, row = null, error = null) {
  if (row || isNaverCrawlSessionFailure(error)) return rows.length || 1;
  if (!report?.results?.length) return rows.length || 1;
  return report.results.filter(isNaverCrawlSessionFailure).length || rows.length || 1;
}

function dedupeRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = [row.url, row.at, row.note, row.message].filter(Boolean).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function normalizeInfoList(infoList) {
  if (!Array.isArray(infoList)) return [];
  return infoList
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      label: shorten(item.label || item.name || '-', 80),
      value: shorten(item.value ?? item.text ?? '-', 500),
      ...(item.url && isHttpUrl(item.url) ? { url: item.url } : {}),
    }));
}

function normalizeError(error) {
  return {
    account: process.env.NAVER_CRAWL_ACCOUNT_ID || '',
    host: '',
    url: '',
    status: 'failed',
    note: error?.message || String(error || ''),
    at: new Date().toISOString(),
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function relativePath(filePath) {
  if (!filePath) return '-';
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return path.relative(process.cwd(), absolutePath) || absolutePath;
}

function shorten(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function formatKst(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function isEnabled(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loadEnvFile(filePath) {
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, '\n');
  }

  return value;
}

function cliArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function parseInfoJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(`[crawl-alert] invalid --info-json ignored: ${error?.message || String(error)}`);
    return [];
  }
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  await loadEnvFile(path.join(process.cwd(), '.env'));
  if (process.argv.includes('--operational') || process.argv.includes('--force')) {
    await sendNaverCrawlOperationalAlert({
      title: cliArg('--title') || process.env.NAVER_CRAWL_ALERT_TITLE || 'Naver crawl runner alert',
      message: cliArg('--message') || cliArg('--error') || process.env.NAVER_CRAWL_ALERT_MESSAGE || '',
      infoList: parseInfoJson(cliArg('--info-json')),
      dryRun: process.argv.includes('--dry-run') || isEnabled(process.env.NAVER_CRAWL_ALERT_DRY_RUN),
    });
  } else {
    const reportPath = path.resolve(cliArg('--report') || process.env.NAVER_CRAWL_REPORT || defaultReportPath);
    const report = await readJson(reportPath).catch(() => null);
    const errorMessage = cliArg('--error') || '';
    await sendNaverCrawlSessionAlert({
      report,
      reportPath,
      error: errorMessage ? new Error(errorMessage) : null,
      dryRun: process.argv.includes('--dry-run') || isEnabled(process.env.NAVER_CRAWL_ALERT_DRY_RUN),
    });
  }
}
