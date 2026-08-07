#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultEndpoint = 'https://siwol-alert.vercel.app/card';
const defaultChannelName = 'bc1536b2-5b66-43cb-4bcc-61f5721de7c8';

export async function sendNaverIndexCheckAlert({
  project = process.env.NAVER_INDEX_ALERT_PROJECT || '',
  runId = process.env.NAVER_INDEX_ALERT_RUN_ID || '',
  status = process.env.NAVER_INDEX_ALERT_STATUS || '',
  stage = process.env.NAVER_INDEX_ALERT_STAGE || 'index-flow',
  logPath = process.env.NAVER_INDEX_ALERT_LOG_FILE || 'logs/naver-index-checks.log',
  message = process.env.NAVER_INDEX_ALERT_MESSAGE || '',
  dryRun = isEnabled(process.env.NAVER_INDEX_ALERT_DRY_RUN),
} = {}) {
  const config = readAlertConfig();
  const payload = buildAlertPayload({
    channelName: config.channelName,
    project,
    runId,
    status,
    stage,
    logPath,
    message,
  });

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return { sent: false, reason: 'dry-run', payload };
  }

  if (!config.enabled) {
    return { sent: false, reason: 'disabled' };
  }

  if (!config.apiKey) {
    console.warn('[index-alert] skipped because NAVER_INDEX_ALERT_API_KEY, NAVER_CRAWL_ALERT_API_KEY, SIWOL_ALERT_API_KEY, or INTERNAL_API_KEY is missing.');
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

  console.log(`[index-alert] sent NAVER WORKS alert to ${config.channelName}`);
  return { sent: true, status: response.status, bodyText };
}

function buildAlertPayload({
  channelName,
  project,
  runId,
  status,
  stage,
  logPath,
  message,
}) {
  const infoList = [
    { label: '프로젝트', value: project || '-' },
    { label: '실행ID', value: runId || '-' },
    { label: '단계', value: stage || '-' },
    { label: '상태코드', value: String(status || '-') },
    { label: '서버', value: os.hostname() || '-' },
    { label: '로그', value: relativePath(logPath) },
    { label: '발생시각', value: formatKst(new Date()) },
  ];

  if (message) {
    infoList.push({ label: '메시지', value: shorten(message, 180) });
  }

  return {
    channelName,
    title: '네이버 검색확인 작업 실패',
    message: 'test02 검색확인 cron에서 실패가 감지되었습니다.',
    infoList,
  };
}

function readAlertConfig() {
  return {
    enabled: process.env.NAVER_INDEX_ALERT_ENABLED !== '0',
    endpoint: process.env.NAVER_INDEX_ALERT_ENDPOINT
      || process.env.NAVER_CRAWL_ALERT_ENDPOINT
      || process.env.WATERMELON_CRAWL_ALERT_ENDPOINT
      || defaultEndpoint,
    apiKey: process.env.NAVER_INDEX_ALERT_API_KEY
      || process.env.NAVER_CRAWL_ALERT_API_KEY
      || process.env.WATERMELON_CRAWL_ALERT_API_KEY
      || process.env.SIWOL_ALERT_API_KEY
      || process.env.INTERNAL_API_KEY
      || '',
    channelName: process.env.NAVER_INDEX_ALERT_CHANNEL_NAME
      || process.env.NAVER_CRAWL_ALERT_CHANNEL_NAME
      || process.env.WATERMELON_CRAWL_ALERT_CHANNEL_NAME
      || defaultChannelName,
  };
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

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
}

if (isDirectRun()) {
  await loadEnvFile(path.join(process.cwd(), '.env'));
  await sendNaverIndexCheckAlert({
    project: cliArg('--project') || process.env.NAVER_INDEX_ALERT_PROJECT || '',
    runId: cliArg('--run-id') || process.env.NAVER_INDEX_ALERT_RUN_ID || '',
    status: cliArg('--status') || process.env.NAVER_INDEX_ALERT_STATUS || '',
    stage: cliArg('--stage') || process.env.NAVER_INDEX_ALERT_STAGE || 'index-flow',
    logPath: cliArg('--log') || process.env.NAVER_INDEX_ALERT_LOG_FILE || 'logs/naver-index-checks.log',
    message: cliArg('--message') || process.env.NAVER_INDEX_ALERT_MESSAGE || '',
    dryRun: process.argv.includes('--dry-run') || isEnabled(process.env.NAVER_INDEX_ALERT_DRY_RUN),
  });
}
