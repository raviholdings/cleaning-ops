#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import pg from 'pg';
import {
  buildCrawlRunId,
  connectCrawlRequestDb,
  hydrateCrawlResultPageLinks,
  upsertCrawlRequestResults,
  upsertCrawlRequestRun,
} from './naver-searchadvisor-crawl-db.mjs';
import {
  isNaverCrawlSessionFailure,
  sendNaverCrawlSessionAlertSafe,
} from './naver-searchadvisor-crawl-alert.mjs';
import {
  resolveCrawlExposureStatuses,
  resolveCrawlExposurePriority,
} from './lib/naver-crawl-exposure-statuses.mjs';
import {
  logProxyBanner,
  playwrightProxy,
  resolveProxyConfig,
} from './lib/naver-proxy.mjs';

const args = new Set(process.argv.slice(2));
const { Client } = pg;

const rootDir = process.cwd();
const defaultQueuePath = 'reports/naver-site-search/all-post-crawl-queue-ju-random-2026-05-20.json';
const defaultReportPath = 'reports/naver-site-search/manual-crawl-submit-all-posts-ju-random-2026-05-20.json';
const searchAdvisorMainButtonText = '\uBA54\uC778\uC73C\uB85C \uC774\uB3D9';
const webmasterToolsText = '\uC6F9\uB9C8\uC2A4\uD130 \uB3C4\uAD6C';
const searchAdvisorProblemText = '\uBB38\uC81C\uAC00 \uBC1C\uC0DD';
const searchAdvisorAccessDeniedText = '\uC811\uADFC\uAD8C\uD55C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4';

const help = `
Submit Naver Search Advisor crawl requests from a saved file queue or DB-backed post queue.

Usage:
  pnpm naver:crawl-requests
  NAVER_CRAWL_BATCH_SIZE=50 pnpm naver:crawl-requests
  pnpm naver:crawl-requests --dry-run
  pnpm naver:crawl-requests --login-only

Important env:
  NAVER_CRAWL_QUEUE_SOURCE       file (file or db)
  NAVER_CRAWL_QUEUE              ${defaultQueuePath}
  NAVER_CRAWL_REPORT             ${defaultReportPath}
  NAVER_CRAWL_USER_DATA_DIR      .naver-searchadvisor-profile-ju
  NAVER_CRAWL_STORAGE_STATE      optional Playwright storage state JSON
  NAVER_CRAWL_BATCH_SIZE         0 (0/empty means no batch limit)
  NAVER_CRAWL_LOOP               1
  NAVER_CRAWL_CONCURRENCY        1
  NAVER_CRAWL_MAX_CONCURRENCY    12
  NAVER_CRAWL_DB_QUEUE_ORDER     host (host or round-robin)
  NAVER_CRAWL_DB_URL_SOURCE      auto (auto, catalog, page-count, sitemap)
  NAVER_CRAWL_CATALOG_PROJECTS   bbungbbung-piping,gosim,recovery-law
  NAVER_CRAWL_CATALOG_ONLY_PENDING 1
  NAVER_CRAWL_EXPOSURE_PRIORITY_ENABLED empty (explicit 1/0 emergency override; DB is the default)
  NAVER_CRAWL_EXPOSURE_STATUSES  empty (optional strict status filter)
  NAVER_CRAWL_UNEXPOSED_ONLY_PROJECTS empty (optional strict unexposed-only projects)
  NAVER_CRAWL_SITEMAP_ONLY_PROJECTS empty unless legacy fallback is intentional
  NAVER_CRAWL_USE_DB_DONE_URLS   1
  NAVER_CRAWL_QUEUE_ORDER        host (host or queue)
  NAVER_CRAWL_SUBMIT_MODE        api (api or ui)
  NAVER_CRAWL_API_FALLBACK       1
  NAVER_CRAWL_API_TIMEOUT_MS     20000
  NAVER_CRAWL_API_AUTH_RETRIES   2
  NAVER_CRAWL_API_SESSION_MAX_MS 1800000
  NAVER_CRAWL_API_SESSION_SCOPE  site (site or account)
  NAVER_CRAWL_QUOTA_ACTION       defer-host (defer-host or stop)
  NAVER_CRAWL_QUOTA_INSPECT_UI   0
  NAVER_CRAWL_QUOTA_INSPECT_DIR  reports/naver-site-search/quota-inspections
  NAVER_CRAWL_BATCH_DELAY_MS     30000
  NAVER_CRAWL_HEADLESS           0
  NAVER_CRAWL_BROWSER_CHANNEL    chrome (use "none" for Playwright Chromium)
  NAVER_CRAWL_PREFLIGHT          0
  NAVER_CRAWL_UI_READY_TIMEOUT_MS 30000
  NAVER_CRAWL_UI_READY_RETRIES   2
  NAVER_CRAWL_AUTH_CALLBACK_FAST_RETRY_MS 2500
  NAVER_CRAWL_CONFIRM_TIMEOUT_MS 30000
  NAVER_CRAWL_CONFIRM_POLL_MS    2500
  NAVER_CRAWL_WAIT_FOR_LOGIN     auto (TTY only; use 1 to force)
  NAVER_CRAWL_AUTO_LOGIN         0 (use stored DB password to fill login form)
  NAVER_CRAWL_LOCAL_REPORT       0 for DB queues, 1 for file queues unless overridden
  NAVER_CRAWL_SAVE_EVERY_RESULTS 20
  NAVER_CRAWL_SAVE_INTERVAL_MS   30000
  NAVER_CRAWL_RUN_HEARTBEAT_RESULTS 100
  NAVER_CRAWL_RUN_HEARTBEAT_MS   60000
  NAVER_CRAWL_PAUSE_WINDOWS      siwol-win2 default: 09:40-19:05 KST before account/browser start (0/off disables)
  NAVER_CRAWL_PAUSE_SLEEP_CHUNK_MS 60000
  NAVER_CRAWL_PROFILE            0
  NAVER_CRAWL_PROFILE_LOG_EVERY  100
  NAVER_CRAWL_STOP_ON_UNKNOWN    0
  NAVER_CRAWL_STOP_ON_FAILED     0
  NAVER_CRAWL_STOP_ON_SESSION_FAILURE 1
  NAVER_CRAWL_STOP_ON_BROWSER_CLOSED 1
  NAVER_CRAWL_ADVANCE_ON_FAILED  1
  NAVER_CRAWL_ALERT_ENABLED      1
  NAVER_CRAWL_ALERT_ENDPOINT     https://siwol-alert.vercel.app/card
  NAVER_CRAWL_ALERT_API_KEY      optional; falls back to SIWOL_ALERT_API_KEY or INTERNAL_API_KEY
  NAVER_CRAWL_ALERT_CHANNEL_NAME bc1536b2-5b66-43cb-4bcc-61f5721de7c8
`;

if (args.has('--help') || args.has('-h')) {
  console.log(help.trim());
  process.exit(0);
}

await loadEnvFile(path.join(rootDir, '.env'));

const targetProject = process.env.NAVER_CRAWL_TARGET_PROJECT || 'watermelon-piping';
const exposureStatuses = resolveCrawlExposureStatuses({
  project: targetProject,
  configuredStatuses: process.env.NAVER_CRAWL_EXPOSURE_STATUSES,
  unexposedOnlyProjects: process.env.NAVER_WINDOWS_CRAWL_UNEXPOSED_ONLY_PROJECTS
    ?? process.env.NAVER_CRAWL_UNEXPOSED_ONLY_PROJECTS
    ?? '',
});
const configuredExposurePriority = process.env.NAVER_CRAWL_EXPOSURE_PRIORITY_ENABLED;
const initialExposurePriority = resolveCrawlExposurePriority({
  databaseEnabled: false,
  configuredEnabled: configuredExposurePriority,
  exposureStatuses,
});

const forceSequential = process.env.NAVER_CRAWL_FORCE_SEQUENTIAL !== '0'
  && (process.env.NAVER_CRAWL_TRIGGER === 'windows-scheduled-task'
    || isEnabled(process.env.NAVER_CRAWL_REQUIRE_IP_ROTATION));

const options = {
  runnerPc: normalizeRunnerPc(process.env.NAVER_CRAWL_RUNNER_PC || process.env.NAVER_WINDOWS_CRAWL_RUNNER_PC || ''),
  queueSource: normalizeQueueSource(process.env.NAVER_CRAWL_QUEUE_SOURCE || 'file'),
  queuePath: resolvePath(process.env.NAVER_CRAWL_QUEUE || defaultQueuePath),
  reportPath: resolvePath(process.env.NAVER_CRAWL_REPORT || defaultReportPath),
  userDataDir: resolvePath(process.env.NAVER_CRAWL_USER_DATA_DIR || '.naver-searchadvisor-profile-ju'),
  storageStatePath: process.env.NAVER_CRAWL_STORAGE_STATE ? resolvePath(process.env.NAVER_CRAWL_STORAGE_STATE) : '',
  batchSize: readOptionalPositiveInt(process.env.NAVER_CRAWL_BATCH_SIZE),
  loop: process.env.NAVER_CRAWL_LOOP !== '0',
  concurrency: forceSequential
    ? 1
    : clamp(
      readInt(process.env.NAVER_CRAWL_CONCURRENCY, 1),
      1,
      clamp(readInt(process.env.NAVER_CRAWL_MAX_CONCURRENCY, 12), 1, 64),
    ),
  queueOrder: normalizeQueueOrder(process.env.NAVER_CRAWL_QUEUE_ORDER || 'host'),
  dbQueueOrder: normalizeDbQueueOrder(process.env.NAVER_CRAWL_DB_QUEUE_ORDER || 'host'),
  dbUrlSource: normalizeDbUrlSource(process.env.NAVER_CRAWL_DB_URL_SOURCE || process.env.NAVER_CRAWL_DB_QUEUE_URL_SOURCE || 'auto'),
  // 사이트맵 경로. 청소는 /sitemap.xml, 이사는 /이사/sitemap.xml (인코딩 형태로 넘겨도 된다).
  sitemapPath: process.env.NAVER_CRAWL_SITEMAP_PATH || '/sitemap.xml',
  catalogOnlyPending: process.env.NAVER_CRAWL_CATALOG_ONLY_PENDING !== '0',
  exposureStatuses,
  configuredExposurePriority,
  exposurePriorityEnabled: initialExposurePriority.enabled,
  exposurePrioritySource: initialExposurePriority.source,
  exposurePriorityGroups: [],
  useDbDoneUrls: process.env.NAVER_CRAWL_USE_DB_DONE_URLS !== '0',
  /*
   * 재수집 기준선 (2026-08-23, 네이버 노출 초기화 사태 후 전량 재수집용).
   * 이 시각 이전의 제출 기록은 "안 한 것"으로 친다 — 후보 선정과 dedup 양쪽에
   * 적용된다. 이후의 기록은 그대로 dedup 되므로 회차 안에서 이중 제출은 없다.
   * ISO 예: 2026-08-23T00:00:00+09:00. 다음 회차는 날짜만 다시 올리면 된다.
   */
  doneSince: process.env.NAVER_CRAWL_DONE_SINCE || '',
  submitMode: normalizeSubmitMode(process.env.NAVER_CRAWL_SUBMIT_MODE || process.env.NAVER_CRAWL_MODE || 'api'),
  apiFallback: process.env.NAVER_CRAWL_API_FALLBACK !== '0',
  apiTimeoutMs: readInt(process.env.NAVER_CRAWL_API_TIMEOUT_MS, 20000),
  apiAuthRetries: clamp(readInt(process.env.NAVER_CRAWL_API_AUTH_RETRIES, 2), 0, 5),
  apiSessionMaxMs: readInt(process.env.NAVER_CRAWL_API_SESSION_MAX_MS, 30 * 60 * 1000),
  apiSessionScope: process.env.NAVER_CRAWL_API_SESSION_SCOPE === 'account' ? 'account' : 'site',
  quotaAction: normalizeQuotaAction(process.env.NAVER_CRAWL_QUOTA_ACTION || 'defer-host'),
  quotaInspectUi: isEnabled(process.env.NAVER_CRAWL_QUOTA_INSPECT_UI),
  quotaInspectDir: resolvePath(process.env.NAVER_CRAWL_QUOTA_INSPECT_DIR || 'reports/naver-site-search/quota-inspections'),
  headless: isEnabled(process.env.NAVER_CRAWL_HEADLESS),
  dryRun: args.has('--dry-run') || isEnabled(process.env.NAVER_CRAWL_DRY_RUN),
  loginOnly: args.has('--login-only') || isEnabled(process.env.NAVER_CRAWL_LOGIN_ONLY),
  // 프록시를 쓰면 IP 를 프록시가 정하므로 HaiIP 로 로컬 IP 를 돌릴 필요가 없다.
  useProxy: args.has('--use-proxy') || args.has('--use-brightdata'),
  browserChannel: normalizeBrowserChannel(process.env.NAVER_CRAWL_BROWSER_CHANNEL),
  navigationDelayMs: readInt(process.env.NAVER_CRAWL_NAV_DELAY_MS, 2500),
  uiReadyTimeoutMs: readInt(process.env.NAVER_CRAWL_UI_READY_TIMEOUT_MS, 30000),
  uiReadyRetries: readInt(process.env.NAVER_CRAWL_UI_READY_RETRIES, 2),
  authCallbackFastRetryMs: clamp(readInt(process.env.NAVER_CRAWL_AUTH_CALLBACK_FAST_RETRY_MS, 2500), 0, 30000),
  submitWaitMs: readInt(process.env.NAVER_CRAWL_SUBMIT_WAIT_MS, 6500),
  confirmTimeoutMs: readInt(process.env.NAVER_CRAWL_CONFIRM_TIMEOUT_MS, 30000),
  confirmPollMs: readInt(process.env.NAVER_CRAWL_CONFIRM_POLL_MS, 2500),
  betweenDelayMs: readInt(process.env.NAVER_CRAWL_BETWEEN_DELAY_MS, 1000),
  batchDelayMs: readInt(process.env.NAVER_CRAWL_BATCH_DELAY_MS, 30000),
  preflight: isEnabled(process.env.NAVER_CRAWL_PREFLIGHT),
  accountId: process.env.NAVER_CRAWL_ACCOUNT_ID || '',
  autoLogin: isEnabled(process.env.NAVER_CRAWL_AUTO_LOGIN),
  waitForLogin: process.env.NAVER_CRAWL_WAIT_FOR_LOGIN === '1'
    || (process.env.NAVER_CRAWL_WAIT_FOR_LOGIN !== '0' && Boolean(input.isTTY)),
  stopOnUnknown: isEnabled(process.env.NAVER_CRAWL_STOP_ON_UNKNOWN),
  stopOnFailed: isEnabled(process.env.NAVER_CRAWL_STOP_ON_FAILED),
  stopOnSessionFailure: process.env.NAVER_CRAWL_STOP_ON_SESSION_FAILURE !== '0',
  advanceOnFailed: process.env.NAVER_CRAWL_ADVANCE_ON_FAILED !== '0',
  slowMo: readInt(process.env.NAVER_CRAWL_SLOW_MO_MS, 0),
  saveEveryResults: clamp(readInt(process.env.NAVER_CRAWL_SAVE_EVERY_RESULTS, 20), 1, 1000),
  saveIntervalMs: clamp(readInt(process.env.NAVER_CRAWL_SAVE_INTERVAL_MS, 30000), 0, 10 * 60 * 1000),
  runHeartbeatEveryResults: clamp(readInt(process.env.NAVER_CRAWL_RUN_HEARTBEAT_RESULTS, 100), 1, 10000),
  runHeartbeatIntervalMs: clamp(readInt(process.env.NAVER_CRAWL_RUN_HEARTBEAT_MS, 60000), 0, 30 * 60 * 1000),
  pauseSleepChunkMs: clamp(readInt(process.env.NAVER_CRAWL_PAUSE_SLEEP_CHUNK_MS, 60000), 1000, 10 * 60 * 1000),
  stopOnBrowserClosed: process.env.NAVER_CRAWL_STOP_ON_BROWSER_CLOSED !== '0',
  dbCloseTimeoutMs: clamp(readInt(process.env.NAVER_CRAWL_DB_CLOSE_TIMEOUT_MS, 3000), 500, 30000),
  profile: isEnabled(process.env.NAVER_CRAWL_PROFILE),
  profileLogEvery: clamp(readInt(process.env.NAVER_CRAWL_PROFILE_LOG_EVERY, 100), 1, 100000),
};
options.pauseWindows = parseCrawlPauseWindows(
  process.env.NAVER_CRAWL_PAUSE_WINDOWS ?? defaultPauseWindowsForRunner(options.runnerPc),
);

const catalogDbProjects = new Set(splitEnv(
  process.env.NAVER_CRAWL_CATALOG_PROJECTS || 'bbungbbung-piping,gosim,recovery-law',
));
const sitemapOnlyDbProjects = new Set(splitEnv(
  process.env.NAVER_CRAWL_SITEMAP_ONLY_PROJECTS || '',
));

if (options.doneSince && Number.isNaN(Date.parse(options.doneSince))) {
  throw new Error(`NAVER_CRAWL_DONE_SINCE 를 해석할 수 없습니다: ${options.doneSince} (예: 2026-08-23T00:00:00+09:00)`);
}

const crawlDb = {
  enabled: process.env.NAVER_CRAWL_RECORD_DB !== '0',
  runId: process.env.NAVER_CRAWL_RUN_ID || buildCrawlRunId(options.reportPath),
  targetProject,
  triggerType: process.env.NAVER_CRAWL_TRIGGER || 'manual',
};

options.localReport = process.env.NAVER_CRAWL_LOCAL_REPORT == null
  ? options.queueSource !== 'db'
  : isEnabled(process.env.NAVER_CRAWL_LOCAL_REPORT);

/*
 * 응답 원문은 DB 에 넣지 않고 로컬 jsonl 에 쌓는다 (2026-08-21 운영자 결정).
 * 하루 1파일(KST 날짜)·기계명 포함. R2 업로드는 scripts/upload-crawl-raw-logs.mjs,
 * 메인 PC 다운로드는 scripts/fetch-crawl-raw-logs.mjs 가 담당한다.
 * DB 행과의 연결 고리는 (runId, idx) = (run_id, result_index).
 */
const rawLog = {
  enabled: process.env.NAVER_CRAWL_RAW_LOG !== '0',
  dir: process.env.NAVER_CRAWL_RAW_LOG_DIR || path.join(rootDir, 'logs', 'naver-raw'),
  machine: (process.env.NAVER_CRAWL_MACHINE || hostname()).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
};

const blockedPattern = /자동|보안문자|captcha|CAPTCHA|로봇|자동입력|보안 절차/;
const quotaStopPattern = /(?:오늘|일일|하루)[\s\S]{0,40}(?:모두|전부|소진|초과|마감|없습니다|없음|불가)|(?:더 이상|추가)[\s\S]{0,30}(?:요청|수집)[\s\S]{0,30}(?:불가|할 수 없습니다|가능하지 않습니다)|요청 가능 횟수\s*[:：]?\s*0(?:\D|$)|0\s*\/\s*0/;
const loginProblemPattern = /로그인에 문제가 발생|로그인이 필요|로그인 후|로그인하세요|로그인해 주세요|login required|sign in/i;
const doneStatuses = new Set(['submitted', 'already-present', 'skipped', 'skipped-missing', 'skipped-reserved-path']);
// 이사 사이트맵 생성 폴백 캐시. 선언이 await main() 보다 위에 있어야 한다 (TDZ).
let movingLibCache = null;
const apiCodeMessages = new Map([
  [100, 'system error'],
  [101, 'invalid URL'],
  [105, 'access denied'],
  [110, 'daily site request quota exceeded'],
  [139, 'already requested URL'],
  [160, 'post does not exist'],
  [161, 'input validation failed'],
  [400, 'bad request'],
  [404, 'site is not registered'],
  [413, 'URL is too long'],
  [429, 'registration limit exceeded'],
  [502, 'server error'],
  [601, 'automation or security check'],
]);

let interrupted = false;
const apiSessions = new Map();
const apiSessionPromises = new Map();
let crawlDbClientPromise = null;
let crawlSourceDbClientPromise = null;
let crawlDbWriteQueue = Promise.resolve();
let crawlDbWarningShown = false;
let crawlSessionAlertSent = false;
let inMemoryReport = null;
let reportFileWriteQueue = Promise.resolve();
const persistedDoneUrlCache = new Set();

function createProfileStats() {
  return {
    readReportMs: 0,
    planMs: 0,
    alreadyDoneSetMs: 0,
    deferredHostsMs: 0,
    alreadyDoneSkipped: 0,
    deferredHostSkipped: 0,
    submitCount: 0,
    submitMs: 0,
    submitMaxMs: 0,
    saveCount: 0,
    saveMs: 0,
    saveMaxMs: 0,
    dbCount: 0,
    dbMs: 0,
    dbMaxMs: 0,
    alertCount: 0,
    alertMs: 0,
    alertMaxMs: 0,
    startedAt: Date.now(),
  };
}

function addProfileTiming(stats, key, durationMs) {
  if (!stats) return;
  stats[key] = (stats[key] || 0) + durationMs;
  const maxKey = `${key.replace(/Ms$/, '')}MaxMs`;
  if (Object.hasOwn(stats, maxKey)) stats[maxKey] = Math.max(stats[maxKey] || 0, durationMs);
}

function profileSummary(stats) {
  if (!stats) return null;
  const summary = Object.fromEntries(Object.entries(stats)
    .filter(([key]) => key !== 'startedAt')
    .map(([key, value]) => [
      key,
      typeof value === 'number' ? Number(value.toFixed(1)) : value,
    ]));
  summary.elapsedMs = Date.now() - stats.startedAt;
  summary.submitAvgMs = profileAverage(stats, 'submitMs', 'submitCount');
  summary.saveAvgMs = profileAverage(stats, 'saveMs', 'saveCount');
  summary.dbAvgMs = profileAverage(stats, 'dbMs', 'dbCount');
  return summary;
}

function profileAverage(stats, totalKey, countKey) {
  if (!stats || !stats[countKey]) return 0;
  return Number((stats[totalKey] / stats[countKey]).toFixed(1));
}
process.on('SIGINT', () => {
  interrupted = true;
  console.log('\nStopping after the current URL and saving progress...');
});

try {
  await main();
} catch (error) {
  await recordCrawlRunFailure(error);
  await sendCrawlSessionAlertOnce({ error });
  throw error;
} finally {
  await closeCrawlDb();
}

async function main() {
  const { queueDoc, sourceTasks } = await loadQueueSource();
  if (!Array.isArray(sourceTasks) || sourceTasks.length === 0) {
    if (queueDoc?.dbUrlSource === 'catalog') {
      console.log(JSON.stringify({
        accountId: options.accountId,
        targetProject: crawlDb.targetProject,
        queueSource: 'db',
        dbUrlSource: 'catalog',
        pendingTasks: 0,
        status: 'complete',
      }));
      return;
    }
    throw new Error(`Queue has no tasks: ${options.queueSource === 'db' ? `db:${crawlDb.targetProject}:${options.accountId || 'all'}` : options.queuePath}`);
  }

  const report = await readReport(options.reportPath);
  const taskPlan = planTasks(sourceTasks, report);
  const tasks = taskPlan.tasks;
  const cursor = taskPlan.nextIndex;
  const previewEnd = options.batchSize
    ? cursor + Math.max(options.batchSize, 5)
    : cursor + 10;
  let nextTasks = previewPendingTasks(tasks, cursor, report, Math.max(10, previewEnd - cursor));

  if (options.dryRun) {
    const previewAlreadyDone = new Set(
      (report.results || [])
        .filter((result) => doneStatuses.has(result.status))
        .map((result) => result.url),
    );
    await addDbDoneUrls(previewAlreadyDone, tasks, { allowDryRun: true });
    const previewDeferredHosts = activeQuotaDeferredHosts(report);
    await addDbQuotaDeferredHosts(previewDeferredHosts, tasks, { allowDryRun: true });
    nextTasks = previewPendingTasks(tasks, cursor, report, Math.max(10, previewEnd - cursor), {
      alreadyDone: previewAlreadyDone,
      deferredHosts: previewDeferredHosts,
    });
    console.log(JSON.stringify({
      queuePath: options.queuePath,
      queueSource: options.queueSource,
      reportPath: options.localReport ? options.reportPath : null,
      localReport: options.localReport,
      nextIndex: cursor,
      previousOrder: report.order || 'deterministic-random',
      taskOrder: taskPlan.order,
      orderCursorReset: taskPlan.cursorReset,
      totalTasks: tasks.length,
      sourceDomainCount: queueDoc.domainCount || null,
      sourcePageCount: queueDoc.totalCandidatePages || null,
      submittedOrPresent: report.submittedOrPresent || 0,
      batchSize: options.batchSize || 'unlimited',
      loop: options.loop,
      concurrency: options.concurrency,
      forceSequential,
      submitMode: options.submitMode,
      apiFallback: options.apiFallback,
      quotaAction: options.quotaAction,
      quotaInspectUi: options.quotaInspectUi,
      exposureStatuses: options.exposureStatuses,
      exposurePriorityEnabled: options.exposurePriorityEnabled,
      exposurePrioritySource: options.exposurePrioritySource,
      exposurePriorityGroups: options.exposurePriorityGroups,
      priorityOrder: queueDoc.priorityOrder || 'disabled',
      accountId: options.accountId || nextTasks[0]?.account || 'db-first-active',
      storageStatePath: options.storageStatePath || '',
      preview: nextTasks.slice(0, 10).map(({
        host,
        postId,
        url,
        exposureStatus,
        crawlPriority,
      }) => ({ host, postId, url, exposureStatus, crawlPriority })),
    }, null, 2));
    return;
  }

  if (await completeWithoutBrowserIfNoPending({ report, queueDoc, tasks, taskPlan })) {
    return;
  }

  await waitForCrawlPauseWindowIfNeeded('before launching browser');
  if (interrupted) return;

  if (!options.loginOnly) {
    await recordCrawlRunSafe('running', report, queueDoc);
  }

  await fs.mkdir(options.userDataDir, { recursive: true });
  const context = await launchContext();
  const page = context.pages()[0] || await context.newPage();

  try {
    if (options.loginOnly) {
      const loginTask = tasks[cursor] || tasks[0];
      await openLoginCheckPage(page, loginTask);
      await sleep(options.navigationDelayMs);
      if (await needsNaverLogin(page)) {
        const origin = new URL(loginTask.url).origin;
        const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;
        await resolveLogin(page, crawlPage, loginTask);
      }
      console.log('Login profile saved:', options.userDataDir);
      return;
    }

    if (options.submitMode === 'api') {
      try {
        await ensureApiSession(page, tasks[cursor] || tasks[0], { force: true });
      } catch (error) {
        if (!options.apiFallback) throw error;
        console.warn(`API session warmup failed; UI fallback remains available. ${error?.message || String(error)}`);
      }
    } else {
      await ensureCrawlAccess(page, tasks[cursor] || tasks[0]);
    }
    const pages = [page];
    while (pages.length < options.concurrency) {
      pages.push(await context.newPage());
    }

    let keepGoing = true;
    while (keepGoing && !interrupted) {
      const result = await runBatch({ pages, queueDoc, sourceTasks });
      console.log(formatBatchSummary(result));
      keepGoing = Boolean(options.batchSize)
        && options.loop
        && result.nextIndex < result.totalTasks
        && !result.stopped
        && !interrupted;
      if (keepGoing) {
        console.log(`Waiting ${options.batchDelayMs}ms before the next batch...`);
        await sleep(options.batchDelayMs);
      }
    }

    if (!options.loginOnly) {
      const finalReport = await readReport(options.reportPath);
      await recordCrawlRunSafe(finalRunStatus(finalReport, tasks), finalReport, queueDoc);
    }
  } finally {
    await persistContextStorageState(context);
    await context.close().catch((error) => {
      console.warn(`Could not close Playwright context cleanly: ${error?.message || String(error)}`);
    });
  }
}

function formatBatchSummary(report) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const counts = {};
  for (const result of results) {
    const status = result?.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }

  const account = report?.account || options.accountId || '';
  const project = report?.project || crawlDb.targetProject || '';
  const nextIndex = Number.isInteger(report?.nextIndex) ? report.nextIndex : 0;
  const totalTasks = Number.isInteger(report?.totalTasks) ? report.totalTasks : 0;
  const hostQuotaStopCount = Object.keys(report?.hostQuotaStops || {}).length;
  const statusSummary = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');

  return [
    '[crawl-summary]',
    `account=${account}`,
    `project=${project}`,
    `next=${nextIndex}/${totalTasks}`,
    `results=${results.length}`,
    statusSummary,
    `hostQuotaStops=${hostQuotaStopCount}`,
    `report=${reportStorageLabel()}`,
  ].filter(Boolean).join(' ');
}

async function completeWithoutBrowserIfNoPending({ report, queueDoc, tasks, taskPlan }) {
  if (options.loginOnly) return false;

  const alreadyDone = new Set(
    (report.results || [])
      .filter((result) => doneStatuses.has(result.status))
      .map((result) => result.url),
  );
  await addDbDoneUrls(alreadyDone, tasks);

  const deferredHosts = activeQuotaDeferredHosts(report);
  await addDbQuotaDeferredHosts(deferredHosts, tasks);

  const preview = previewPendingTasks(tasks, taskPlan.nextIndex, report, 1, { alreadyDone, deferredHosts });
  if (preview.length > 0) return false;

  await saveReport(report, queueDoc, tasks, tasks.length, taskPlan.order);
  const finalReport = await readReport(options.reportPath);
  console.log(formatBatchSummary(finalReport));
  await recordCrawlRunSafe(finalRunStatus(finalReport, tasks), finalReport, queueDoc);
  return true;
}

async function runBatch({ pages, queueDoc, sourceTasks }) {
  const profile = options.profile ? createProfileStats() : null;
  let timer = Date.now();
  let report = await readReport(options.reportPath);
  addProfileTiming(profile, 'readReportMs', Date.now() - timer);
  if (!Array.isArray(report.results)) report.results = [];
  timer = Date.now();
  const taskPlan = planTasks(sourceTasks, report);
  const tasks = taskPlan.tasks;
  addProfileTiming(profile, 'planMs', Date.now() - timer);

  timer = Date.now();
  const alreadyDone = new Set(
    report.results
      .filter((result) => doneStatuses.has(result.status))
      .map((result) => result.url),
  );
  await addDbDoneUrls(alreadyDone, tasks);
  addProfileTiming(profile, 'alreadyDoneSetMs', Date.now() - timer);
  timer = Date.now();
  const deferredHosts = activeQuotaDeferredHosts(report);
  await addDbQuotaDeferredHosts(deferredHosts, tasks);
  addProfileTiming(profile, 'deferredHostsMs', Date.now() - timer);

  const startIndex = taskPlan.nextIndex;
  let claimIndex = startIndex;
  let nextIndex = startIndex;
  let processed = 0;
  let stopped = false;
  const batchResults = [];
  const maxToProcess = options.batchSize || Number.POSITIVE_INFINITY;
  const settledIndexes = new Set();
  let saveQueue = Promise.resolve();
  let runHeartbeatQueue = Promise.resolve();
  let dirtyChanges = 0;
  let runHeartbeatChanges = 0;
  let lastSaveAt = Date.now();
  let lastRunHeartbeatAt = Date.now();

  const markSettled = (index) => {
    settledIndexes.add(index);
    while (settledIndexes.has(nextIndex)) {
      settledIndexes.delete(nextIndex);
      nextIndex += 1;
    }
  };

  const markHostSettledFrom = (startIndex, host) => {
    let skipped = 0;
    for (let index = startIndex; index < tasks.length; index += 1) {
      const taskHost = tasks[index]?.host || safeHost(tasks[index]?.url);
      if (taskHost === host) {
        markSettled(index);
        skipped += 1;
      }
    }
    return skipped;
  };

  const saveProgress = ({ changes = 1, force = false, important = false } = {}) => {
    dirtyChanges += changes;
    const intervalDue = options.saveIntervalMs > 0 && Date.now() - lastSaveAt >= options.saveIntervalMs;
    const countDue = dirtyChanges >= options.saveEveryResults;
    if (!force && !important && !intervalDue && !countDue) return saveQueue;

    dirtyChanges = 0;
    saveQueue = saveQueue.then(async () => {
      const startedAt = Date.now();
      await saveReport(report, queueDoc, tasks, nextIndex, taskPlan.order);
      const durationMs = Date.now() - startedAt;
      lastSaveAt = Date.now();
      addProfileTiming(profile, 'saveMs', durationMs);
      if (profile) profile.saveCount += 1;
    });
    return saveQueue;
  };

  const recordRunHeartbeat = ({ changes = 1, force = false } = {}) => {
    runHeartbeatChanges += changes;
    const intervalDue = options.runHeartbeatIntervalMs > 0 && Date.now() - lastRunHeartbeatAt >= options.runHeartbeatIntervalMs;
    const countDue = runHeartbeatChanges >= options.runHeartbeatEveryResults;
    if (!force && !intervalDue && !countDue) return runHeartbeatQueue;

    runHeartbeatChanges = 0;
    runHeartbeatQueue = runHeartbeatQueue
      .catch(() => {})
      .then(async () => {
        await recordCrawlRunSafe('running', report, queueDoc);
        lastRunHeartbeatAt = Date.now();
      });
    return runHeartbeatQueue;
  };

  const claimNextTask = async () => {
    while (claimIndex < tasks.length && processed < maxToProcess && !interrupted && !stopped) {
      const currentIndex = claimIndex;
      claimIndex += 1;
      if (settledIndexes.has(currentIndex)) {
        markSettled(currentIndex);
        continue;
      }

      const task = tasks[currentIndex];
      if (!task || alreadyDone.has(task.url)) {
        markSettled(currentIndex);
        if (profile) profile.alreadyDoneSkipped += 1;
        continue;
      }

      const host = task.host || safeHost(task.url);
      if (options.quotaAction === 'defer-host' && host && deferredHosts.has(host)) {
        const skipped = markHostSettledFrom(currentIndex, host);
        if (profile) profile.deferredHostSkipped += Math.max(1, skipped);
        await saveProgress({ changes: Math.max(1, skipped) });
        continue;
      }

      processed += 1;
      return { currentIndex, task };
    }

    return null;
  };

  const workerCount = Math.min(options.concurrency, pages.length, Number.isFinite(maxToProcess) ? maxToProcess : pages.length);
  const workers = pages.slice(0, workerCount).map((workerPage, workerIndex) => runWorker(workerPage, workerIndex + 1));
  await Promise.all(workers);
  await saveProgress({ changes: 0, force: true });
  await saveQueue;
  await recordRunHeartbeat({ changes: 0, force: true });
  await runHeartbeatQueue;

  async function runWorker(workerPage, workerId) {
    while (!interrupted && !stopped) {
      const claimed = await claimNextTask();
      if (!claimed) return;

      const { currentIndex, task } = claimed;
      const submitStartedAt = Date.now();
      const row = await submitOne(workerPage, task);
      addProfileTiming(profile, 'submitMs', Date.now() - submitStartedAt);
      if (profile) profile.submitCount += 1;
      row.worker = workerId;
      if (shouldHoldBrowserClosedFailure(row)) {
        row.note = row.note
          ? `${row.note}; stopping current run because browser context closed`
          : 'stopping current run because browser context closed';
      }

      if (row.status === 'quota-stop' && options.quotaInspectUi) {
        await inspectQuotaStopInUi(workerPage, task, row);
      }

      report.results.push(row);
      const resultIndex = report.results.length - 1;
      batchResults.push(row);
      const host = task.host || safeHost(task.url);

      if (row.status === 'quota-stop' && options.quotaAction === 'defer-host') {
        if (host) {
          row.note = row.note
            ? `${row.note}; deferred host until next KST day`
            : 'deferred host until next KST day';
          report.hostQuotaStops ||= {};
          report.hostQuotaStops[host] = {
            date: currentKstDateKey(),
            at: row.at,
            url: row.url,
            note: row.note,
            mode: row.mode,
            apiCode: row.apiCode,
            apiMessage: row.apiMessage,
            apiResponse: row.apiResponse,
            quotaUiInspection: row.quotaUiInspection,
          };
          deferredHosts.add(host);
          const skipped = markHostSettledFrom(currentIndex + 1, host);
          if (profile) profile.deferredHostSkipped += skipped;
        }
        markSettled(currentIndex);
      } else if (shouldAdvance(row)) {
        markSettled(currentIndex);
      } else {
        stopped = true;
      }

      await saveProgress({ important: row.status === 'quota-stop' || shouldStop(row) || interrupted });
      const dbStartedAt = Date.now();
      await recordCrawlResultsSafe([row], resultIndex);
      await recordRunHeartbeat({ force: row.status === 'quota-stop' || shouldStop(row) || interrupted });
      addProfileTiming(profile, 'dbMs', Date.now() - dbStartedAt);
      if (profile) profile.dbCount += 1;
      const alertStartedAt = Date.now();
      await sendCrawlSessionAlertOnce({ row, report });
      addProfileTiming(profile, 'alertMs', Date.now() - alertStartedAt);
      if (profile) profile.alertCount += 1;
      console.log(`[crawl:${workerId}] ${row.status}${row.mode ? ` mode=${row.mode}` : ''} index=${currentIndex} next=${nextIndex} ${row.url}${row.note ? ` note=${row.note}` : ''}`);
      if (profile && profile.submitCount % options.profileLogEvery === 0) {
        const elapsedMs = Date.now() - profile.startedAt;
        const ratePerMinute = elapsedMs > 0 ? Number(((profile.submitCount / elapsedMs) * 60000).toFixed(1)) : 0;
        console.log(`[profile] processed=${processed} submitCount=${profile.submitCount} next=${nextIndex}/${tasks.length} elapsedMs=${elapsedMs} ratePerMinute=${ratePerMinute} submitAvgMs=${profileAverage(profile, 'submitMs', 'submitCount')} saveAvgMs=${profileAverage(profile, 'saveMs', 'saveCount')} dbAvgMs=${profileAverage(profile, 'dbMs', 'dbCount')} saveCount=${profile.saveCount} dirtyChanges=${dirtyChanges}`);
      }

      if (shouldStop(row)) {
        stopped = true;
      }

      await sleep(options.betweenDelayMs);
    }
  }

  report = await readReport(options.reportPath);
  return {
    nextIndex: report.nextIndex,
    processed,
    submittedOrPresent: report.submittedOrPresent,
    skippedMissing: report.skippedMissing,
    totalTasks: report.totalTasks,
    taskOrder: report.order,
    stopped,
    batchResults,
    profile: profileSummary(profile),
  };
}

async function loadQueueSource() {
  if (options.queueSource === 'db') {
    return loadDbQueueSource();
  }

  const queueDoc = await readJson(options.queuePath);
  const sourceTasks = Array.isArray(queueDoc.tasks) ? queueDoc.tasks : queueDoc.queue;
  return { queueDoc, sourceTasks };
}

async function loadDbQueueSource() {
  const client = await getCrawlSourceDbClient();
  if (!client) {
    throw new Error('NAVER_CRAWL_QUEUE_SOURCE=db requires DATABASE_URL or DIRECT_URL');
  }

  const accountId = options.accountId;
  if (!accountId) {
    throw new Error('NAVER_CRAWL_QUEUE_SOURCE=db requires NAVER_CRAWL_ACCOUNT_ID');
  }

	const registryTargets = await loadRegistryDbQueueTargets(client, accountId, crawlDb.targetProject);
	const targets = registryTargets || [];

  if (shouldUseCatalogDbQueue()) {
    return loadCatalogDbQueueSource({ client, accountId, targets });
  }

  if (shouldUseSitemapDbQueue()) {
    return loadSitemapDbQueueSource({ accountId, targets });
  }

  const postUrlBuilder = await loadDbPostUrlBuilder();
  const sourceTasks = [];
  for (const target of targets) {
    const pageCount = Math.max(0, Number(target.pageCount || 0));
    if (target.includeRoot) {
      sourceTasks.push({
        account: accountId,
        project: crawlDb.targetProject,
        host: target.host,
        postId: null,
        url: String(target.siteUrl || '').replace(/\/+$/, ''),
        areaSlug: target.areaSlug,
        areaName: target.areaName,
        regionLabel: target.regionLabel,
        pageCount,
        source: 'db',
        urlKind: 'root',
        accountSlotOrder: target.accountSlotOrder,
        routeStyle: target.routeStyle,
        postRouteMode: target.postRouteMode,
        rssMode: target.rssMode,
        experimentGroup: target.experimentGroup,
      });
    }

    for (let postId = 1; postId <= pageCount; postId += 1) {
      const postUrl = postUrlBuilder
        ? postUrlBuilder(target, postId)
        : { url: buildPostUrl(target, postId) };
      sourceTasks.push({
        account: accountId,
        project: crawlDb.targetProject,
        host: target.host,
        postId,
        url: postUrl.url,
        areaSlug: target.areaSlug,
        areaName: target.areaName,
        regionLabel: target.regionLabel,
        pageCount,
        source: 'db',
        urlKind: 'post',
        requestId: postUrl.requestId,
        mappedPage: postUrl.mappedPage,
        routePath: postUrl.routePath,
        accountSlotOrder: target.accountSlotOrder,
        routeStyle: target.routeStyle,
        postRouteMode: target.postRouteMode,
        rssMode: target.rssMode,
        experimentGroup: target.experimentGroup,
      });
    }
  }

  const totalCandidatePages = targets.reduce((sum, target) => (
    sum + Math.max(0, Number(target.pageCount || 0)) + (target.includeRoot ? 1 : 0)
  ), 0);
  const pageCounts = targets.map((target) => Math.max(0, Number(target.pageCount || 0)));
  return {
    queueDoc: {
      account: accountId,
      project: crawlDb.targetProject,
      queueSource: 'db',
      domainCount: targets.length,
      totalCandidatePages,
      minPageCount: pageCounts.length ? Math.min(...pageCounts) : 0,
      maxPageCount: pageCounts.length ? Math.max(...pageCounts) : 0,
      generatedAt: new Date().toISOString(),
      order: dbQueueOrder(),
    },
    sourceTasks,
  };
}

async function loadCatalogDbQueueSource({ client, accountId, targets }) {
  const priorityPolicy = await loadCatalogExposurePriorityPolicy(client, targets);
  options.exposurePriorityEnabled = priorityPolicy.enabled;
  options.exposurePrioritySource = priorityPolicy.source;
  options.exposurePriorityGroups = priorityPolicy.groups;
  // doneSince 가 있으면 그 이전 완료는 미완료로 취급한다 (재수집 회차).
  const pendingClause = options.catalogOnlyPending
    ? (options.doneSince
      ? 'and (candidate.last_done_at is null or candidate.last_done_at < $5::timestamptz)'
      : 'and candidate.last_done_at is null')
    : '';
  const { rows } = await client.query(
    `
      with ranked as (
        select
          candidate.group_key,
          candidate.domain_id,
          candidate.request_id,
          candidate.path,
          candidate.host,
          candidate.page_url,
          candidate.page_count,
          candidate.route_style,
          candidate.post_route_mode,
          candidate.rss_mode,
          candidate.area_slug,
          candidate.area_name,
          candidate.region_label,
          candidate.location_id,
          candidate.location,
          candidate.location_search_name,
          candidate.main_keyword_id,
          candidate.main_keyword,
          candidate.exposure_target_id,
          candidate.exposure_status,
          candidate.exposure_query_text,
          candidate.exposure_observed_at,
          candidate.last_attempt_at,
          candidate.last_done_at,
          case
            when $3::boolean and candidate.exposure_status = 'unexposed' then 0
            else 1
          end as effective_exposure_priority,
          row_number() over (
            partition by
              candidate.group_key,
              case
                when $3::boolean and candidate.exposure_status = 'unexposed' then 0
                else 1
              end,
              candidate.location_search_name,
              candidate.main_keyword_id
            order by
              candidate.last_attempt_at nulls first,
              candidate.domain_id,
              candidate.request_id
          ) as combination_round
        from public.naver_crawl_request_page_candidates candidate
        where candidate.naver_account_id = $1
          and candidate.target_project = $2
          ${pendingClause}
          and (cardinality($4::text[]) = 0 or candidate.exposure_status = any($4::text[]))
      )
      select *
      from ranked
      order by
        effective_exposure_priority,
        combination_round,
        location_search_name,
        main_keyword_id,
        domain_id,
        request_id
    `,
    [accountId, crawlDb.targetProject, options.exposurePriorityEnabled, options.exposureStatuses,
      ...(options.catalogOnlyPending && options.doneSince ? [options.doneSince] : [])],
  );

  if (rows.length === 0 && !options.catalogOnlyPending) {
    throw new Error(`DB page catalog has no rows for ${accountId}/${crawlDb.targetProject}`);
  }

  const sourceTasks = [];
  for (const target of targets) {
    if (!target.includeRoot || options.exposureStatuses.length > 0) continue;
    sourceTasks.push({
      account: accountId,
      project: crawlDb.targetProject,
      host: target.host,
      postId: null,
      url: String(target.siteUrl || '').replace(/\/+$/, ''),
      areaSlug: target.areaSlug,
      areaName: target.areaName,
      regionLabel: target.regionLabel,
      pageCount: target.pageCount,
      source: 'db-catalog',
      urlKind: 'root',
      crawlPriority: 1,
      accountSlotOrder: target.accountSlotOrder,
      routeStyle: target.routeStyle,
      postRouteMode: target.postRouteMode,
      rssMode: target.rssMode,
      experimentGroup: target.experimentGroup,
    });
  }

  for (const row of rows) {
    sourceTasks.push({
      account: accountId,
      project: crawlDb.targetProject,
      host: row.host,
      postId: Number(row.request_id),
      pageDomainId: Number(row.domain_id),
      pageRequestId: Number(row.request_id),
      url: row.page_url,
      areaSlug: row.area_slug || '',
      areaName: row.area_name || '',
      regionLabel: row.region_label || '',
      pageCount: Number(row.page_count || 0),
      source: 'db-catalog',
      urlKind: 'post',
      requestId: Number(row.request_id),
      routePath: row.path,
      locationId: Number(row.location_id),
      location: row.location,
      mainKeywordId: Number(row.main_keyword_id),
      mainKeyword: row.main_keyword,
      exposureTargetId: row.exposure_target_id ? Number(row.exposure_target_id) : null,
      exposureStatus: row.exposure_status,
      exposureQueryText: row.exposure_query_text,
      exposureObservedAt: row.exposure_observed_at,
      crawlPriority: Number(row.effective_exposure_priority),
      combinationRound: Number(row.combination_round),
      lastDoneAt: row.last_done_at,
      accountSlotOrder: row.account_slot_order,
      routeStyle: row.route_style || '',
      postRouteMode: row.post_route_mode || '',
      rssMode: row.rss_mode || '',
      experimentGroup: row.group_key || '',
    });
  }

  const pageCounts = targets.map((target) => Math.max(0, Number(target.pageCount || 0)));
  return {
    queueDoc: {
      account: accountId,
      project: crawlDb.targetProject,
      queueSource: 'db',
      dbUrlSource: 'catalog',
      domainCount: targets.length,
      totalCandidatePages: sourceTasks.length,
      catalogPageCount: rows.length,
      minPageCount: pageCounts.length ? Math.min(...pageCounts) : 0,
      maxPageCount: pageCounts.length ? Math.max(...pageCounts) : 0,
      generatedAt: new Date().toISOString(),
      order: dbQueueOrder(),
      exposureStatuses: options.exposureStatuses,
      exposurePriorityEnabled: options.exposurePriorityEnabled,
      exposurePrioritySource: options.exposurePrioritySource,
      exposurePriorityGroups: options.exposurePriorityGroups,
      priorityOrder: options.exposureStatuses.length > 0
        ? `${options.exposureStatuses.join('-')}-only`
        : options.exposurePriorityEnabled
        ? 'unexposed-then-other-pending'
        : 'disabled',
    },
    sourceTasks,
  };
}

async function loadCatalogExposurePriorityPolicy(client, targets) {
  const groupKeys = [...new Set(targets
    .map((target) => String(target.experimentGroup || '').trim())
    .filter(Boolean))];
  if (groupKeys.length === 0) {
    throw new Error(`DB catalog targets have no group key for ${crawlDb.targetProject}.`);
  }

  let rows;
  try {
    ({ rows } = await client.query(
      `
        select group_key, unexposed_priority_enabled
        from public.naver_project_groups
        where group_key = any($1::text[])
        order by group_key
      `,
      [groupKeys],
    ));
  } catch (error) {
    if (error?.code === '42703') {
      throw new Error(
        'DB crawl priority requires public.naver_project_groups.unexposed_priority_enabled; apply the current migration.',
      );
    }
    throw error;
  }

  const byGroup = new Map(rows.map((row) => [row.group_key, row.unexposed_priority_enabled === true]));
  const missing = groupKeys.filter((groupKey) => !byGroup.has(groupKey));
  if (missing.length > 0) {
    throw new Error(`DB crawl priority is missing project group(s): ${missing.join(', ')}`);
  }

  const groups = groupKeys.sort().map((groupKey) => ({
    groupKey,
    databaseEnabled: byGroup.get(groupKey),
  }));
  const policies = groups.map((group) => ({
    ...group,
    ...resolveCrawlExposurePriority({
      databaseEnabled: group.databaseEnabled,
      configuredEnabled: options.configuredExposurePriority,
      exposureStatuses: options.exposureStatuses,
    }),
  }));
  const enabledValues = [...new Set(policies.map((policy) => policy.enabled))];
  if (enabledValues.length !== 1) {
    throw new Error(
      `DB crawl priority has mixed group policies for one account/project queue: ${policies
        .map((policy) => `${policy.groupKey}=${policy.enabled ? 'on' : 'off'}`)
        .join(', ')}`,
    );
  }

  return {
    enabled: enabledValues[0],
    source: policies[0].source,
    groups: policies,
  };
}

async function loadSitemapDbQueueSource({ accountId, targets }) {
  const sourceTasks = [];
  const sitemapSummaries = [];

  for (const target of targets) {
    const sitemapTasks = await loadTargetSitemapTasks(accountId, target);
    sourceTasks.push(...sitemapTasks);
    sitemapSummaries.push({
      host: target.host,
      urlCount: sitemapTasks.length,
      pageCount: Math.max(0, Number(target.pageCount || 0)),
    });
  }

  const pageCounts = targets.map((target) => Math.max(0, Number(target.pageCount || 0)));
  return {
    queueDoc: {
      account: accountId,
      project: crawlDb.targetProject,
      queueSource: 'db',
      dbUrlSource: 'sitemap',
      domainCount: targets.length,
      totalCandidatePages: sourceTasks.length,
      minPageCount: pageCounts.length ? Math.min(...pageCounts) : 0,
      maxPageCount: pageCounts.length ? Math.max(...pageCounts) : 0,
      generatedAt: new Date().toISOString(),
      order: dbQueueOrder(),
      sitemapSummaries,
    },
    sourceTasks,
  };
}

async function loadTargetSitemapTasks(accountId, target) {
  const sitemapUrl = joinOriginPath(target.siteUrl, options.sitemapPath);
  let urls;
  try {
    urls = await fetchSitemapUrls(sitemapUrl, target.siteUrl);
  } catch (error) {
    if (options.dbUrlSource === 'sitemap' || requiresSitemapDbQueue()) {
      /*
       * fetch 가 막힌 호스트 (one-qfast.com — Cloudflare 엣지 IP 가 국내망에서
       * TCP 단계부터 차단, 간헐적). 이사는 배포와 같은 생성기로 URL 을 만들 수
       * 있으므로 로컬 생성으로 폴백한다. 실패하면 이번 회차 스킵 — 다음 실행이
       * 다시 본다 (dedup 이 완료분을 걸러 주므로 잃는 것이 없다).
       */
      if (crawlDb.targetProject === 'moving-ravi') {
        try {
          urls = await movingGeneratedSitemapUrls(target);
          console.warn(`[crawl:db] sitemap fetch failed for ${target.host}; generated ${urls.length} urls from catalog (${error.message})`);
        } catch (fallbackError) {
          console.warn(`[crawl:db] sitemap fetch skipped for ${target.host}: ${error.message} / 생성 폴백 실패: ${fallbackError.message}`);
          return [];
        }
      } else {
        console.warn(`[crawl:db] sitemap fetch skipped for ${target.host}: ${error.message}`);
        return [];
      }
    } else {
      console.warn(`[crawl:db] sitemap queue fallback for ${target.host}: ${error.message}`);
      return loadPageCountTasks(accountId, target);
    }
  }

  return urls
    .filter((url) => target.includeRoot || normalizedUrlPath(url) !== '/')
    .map((url, index) => {
      const pathname = normalizedUrlPath(url);
      const numericPostId = Number(pathname.match(/^\/(\d+)\/?$/)?.[1] || 0);
      return {
        account: accountId,
        project: crawlDb.targetProject,
        host: target.host,
        postId: numericPostId || null,
        url,
        areaSlug: target.areaSlug,
        areaName: target.areaName,
        regionLabel: target.regionLabel,
        pageCount: Math.max(0, Number(target.pageCount || 0)),
        source: 'db-sitemap',
        urlKind: pathname === '/' ? 'root' : 'post',
        requestId: numericPostId || null,
        routePath: pathname,
        sitemapIndex: index,
        accountSlotOrder: target.accountSlotOrder,
        routeStyle: target.routeStyle,
        postRouteMode: target.postRouteMode,
        rssMode: target.rssMode,
        experimentGroup: target.experimentGroup,
      };
    });
}

/** one-qfast 류 fetch 불가 호스트용 — 배포 생성기로 사이트맵 URL 을 만든다. */
async function movingGeneratedSitemapUrls(target) {
  if (!movingLibCache) {
    const mod = await import(pathToFileURL(path.join(rootDir, 'scripts/lib/moving-page-data.mjs')).href);
    movingLibCache = {
      mod,
      lib: await mod.loadMovingLib(rootDir),
      locations: mod.loadLocations(rootDir),
    };
  }
  const client = await getCrawlSourceDbClient();
  const { rows } = await client.query(
    `select (source_payload->>'globalSiteOrder')::int as ord
       from public.naver_project_domains where host = $1`,
    [target.host],
  );
  const ord = Number(rows[0]?.ord || 0);
  if (!ord) throw new Error(`${target.host}: globalSiteOrder 없음`);
  return movingLibCache.mod.movingSitemapUrlsForSite({
    projectRoot: rootDir,
    lib: movingLibCache.lib,
    locations: movingLibCache.locations,
    siteIndex: ord - 1,
    siteUrl: String(target.siteUrl || `https://${target.host}`).replace(/\/+$/, ''),
  });
}

function loadPageCountTasks(accountId, target) {
  const pageCount = Math.max(0, Number(target.pageCount || 0));
  const tasks = [];
  if (target.includeRoot) {
    tasks.push({
      account: accountId,
      project: crawlDb.targetProject,
      host: target.host,
      postId: null,
      url: String(target.siteUrl || '').replace(/\/+$/, ''),
      areaSlug: target.areaSlug,
      areaName: target.areaName,
      regionLabel: target.regionLabel,
      pageCount,
      source: 'db',
      urlKind: 'root',
      accountSlotOrder: target.accountSlotOrder,
      routeStyle: target.routeStyle,
      postRouteMode: target.postRouteMode,
      rssMode: target.rssMode,
      experimentGroup: target.experimentGroup,
    });
  }

  for (let postId = 1; postId <= pageCount; postId += 1) {
    tasks.push({
      account: accountId,
      project: crawlDb.targetProject,
      host: target.host,
      postId,
      url: buildPostUrl(target, postId),
      areaSlug: target.areaSlug,
      areaName: target.areaName,
      regionLabel: target.regionLabel,
      pageCount,
      source: 'db',
      urlKind: 'post',
      accountSlotOrder: target.accountSlotOrder,
      routeStyle: target.routeStyle,
      postRouteMode: target.postRouteMode,
      rssMode: target.rssMode,
      experimentGroup: target.experimentGroup,
    });
  }

  return tasks;
}

async function fetchSitemapUrls(sitemapUrl, siteUrl) {
  /*
   * HaiIP 로 IP 를 바꾼 직후에는 Cloudflare 접속이 한동안 안 열리기도 한다.
   * 2026-08-20 VM1 에서 첫 사이트맵 fetch 가 connect timeout 으로 죽어
   * 계정 실행 전체가 실패했다. 그래서 시도 3회 + 시도당 15초 제한을 둔다.
   */
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(sitemapUrl, {
        headers: { accept: 'application/xml,text/xml,*/*;q=0.8' },
        signal: AbortSignal.timeout(15000),
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  if (!response) throw lastError;
  if (!response.ok) throw new Error(`sitemap fetch failed ${response.status} ${sitemapUrl}`);

  const origin = new URL(siteUrl).origin;
  const text = await response.text();
  const urls = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeXmlEntities(match[1].trim()))
    .filter(Boolean)
    .filter((url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    });

  if (urls.length === 0) throw new Error(`sitemap has no same-origin loc entries: ${sitemapUrl}`);
  return [...new Set(urls)];
}

function normalizedUrlPath(url) {
  try {
    const pathname = decodeURI(new URL(url).pathname || '/');
    return pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function shouldUseSitemapDbQueue() {
  if (requiresSitemapDbQueue()) return true;
  if (options.dbUrlSource === 'sitemap') return true;
  if (options.dbUrlSource === 'page-count') return false;
  return false;
}

function shouldUseCatalogDbQueue(project = crawlDb.targetProject) {
  if (options.dbUrlSource === 'catalog') return true;
  if (options.dbUrlSource !== 'auto') return false;
  return catalogDbProjects.has(project);
}

function requiresSitemapDbQueue(project = crawlDb.targetProject) {
  return sitemapOnlyDbProjects.has(project);
}


async function loadRegistryDbQueueTargets(client, accountId, project) {
  try {
    const { rows } = await client.query(
      `
        select
          group_key,
          host,
          site_url,
          area_slug,
          area_name,
          region_label,
          page_count,
          route_style,
          post_route_mode,
          post_url_pattern,
          rss_mode,
          rss_post_count,
          source_table,
          source_pk
        from public.naver_crawl_request_target_domains
        where naver_account_id = $1
          and target_project = $2
        order by run_order, group_key, area_slug nulls last, host
      `,
      [accountId, project],
    );
    if (rows.length === 0) return null;
    return rows.map((row) => ({
      host: row.host,
      siteUrl: row.site_url || `https://${row.host}`,
      areaSlug: row.area_slug || '',
      areaName: row.area_name || '',
      regionLabel: row.region_label || '',
      pageCount: Number(row.page_count || 0),
      routeStyle: row.route_style || '',
      postRouteMode: row.post_route_mode || '',
      postUrlPattern: row.post_url_pattern || '',
      rssMode: row.rss_mode || '',
      rssPostCount: Number(row.rss_post_count || 0),
      experimentGroup: row.group_key || '',
      includeRoot: ['bbungbbung-piping', 'woodrel-piping'].includes(project),
      sourceTable: row.source_table || '',
      sourcePk: row.source_pk || '',
    }));
	  } catch (error) {
	    if (['42P01', '42703'].includes(error?.code)) {
	      throw new Error(`DB crawl queue requires public.naver_crawl_request_target_domains: ${error.message}`);
	    }
	    throw error;
	  }
	}


async function loadDbPostUrlBuilder() {
  if (crawlDb.targetProject !== 'woodrel-piping') return null;

  const modulePath = path.join(rootDir, 'apps/woodrel-piping/src/site.mjs');
  let siteModule;
  try {
    siteModule = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new Error(`woodrel-piping DB crawl queue requires ${modulePath}: ${error.message}`);
  }

  if (typeof siteModule.postRoutePathForRequestId !== 'function') {
    throw new Error(`woodrel-piping DB crawl queue requires postRoutePathForRequestId export from ${modulePath}`);
  }

  return (target, postId) => {
    const routePath = siteModule.postRoutePathForRequestId(postId, target.host);
    const pageCount = Math.max(1, Number(target.pageCount || 0));
    return {
      url: joinOriginPath(target.siteUrl, routePath),
      routePath,
      requestId: postId,
      mappedPage: typeof siteModule.mappedPageFromRequestId === 'function'
        ? siteModule.mappedPageFromRequestId(postId, pageCount)
        : undefined,
    };
  };
}

function buildPostUrl(target, postId) {
  const origin = String(target?.siteUrl || target || '').replace(/\/+$/, '');
  const pattern = String(target?.postUrlPattern || '').trim();
  if (pattern) {
    const path = pattern
      .replaceAll(':postId', String(postId))
      .replaceAll('{postId}', String(postId));
    return joinOriginPath(origin, path);
  }

  const suffix = usesSlashlessPostUrls(crawlDb.targetProject) ? `/${postId}` : `/${postId}/`;
  return `${origin}${suffix}`;
}

function usesSlashlessPostUrls(project) {
  return ['dadream-mobile', 'deodream-mobile', 'gosim', 'thedream-mobile'].includes(project);
}

function joinOriginPath(siteUrl, routePath) {
  const origin = String(siteUrl || '').replace(/\/+$/, '');
  const pathname = String(routePath || '/');
  return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function dbQueueOrder() {
  if (crawlDb.targetProject === 'woodrel-piping') {
    return `${crawlDb.targetProject}:db-account-slot-post-sequential`;
  }
  const source = shouldUseCatalogDbQueue()
    ? options.exposurePriorityEnabled ? 'catalog-priority' : 'catalog'
    : shouldUseSitemapDbQueue()
      ? 'sitemap'
      : 'page-count';
  return `${crawlDb.targetProject}:db-${options.dbQueueOrder}-${source}`;
}

function planTasks(sourceTasks, report) {
  if (options.queueSource === 'db') {
    const tasks = orderDbTasks(sourceTasks);
    return {
      tasks,
      nextIndex: findNextPendingIndex(tasks, report, true),
      order: dbQueueOrder(),
      cursorReset: true,
    };
  }

  if (options.queueOrder !== 'host') {
    const tasks = sourceTasks;
    const cursorReset = false;
    return {
      tasks,
      nextIndex: findNextPendingIndex(tasks, report, cursorReset),
      order: 'deterministic-random',
      cursorReset,
    };
  }

  const order = 'host-grouped-random-posts';
  const tasks = groupTasksByHost(sourceTasks);
  const cursorReset = report.order !== order;
  return {
    tasks,
    nextIndex: findNextPendingIndex(tasks, report, cursorReset),
    order,
    cursorReset,
  };
}

function groupTasksByHost(sourceTasks) {
  const groups = new Map();
  for (const task of sourceTasks) {
    const host = task?.host || safeHost(task?.url) || '';
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(task);
  }

  return [...groups.values()].flat();
}

function roundRobinTasksByHost(sourceTasks) {
  const groups = new Map();
  for (const task of groupTasksByHost(sourceTasks)) {
    const host = task?.host || safeHost(task?.url) || '';
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(task);
  }

  const groupRows = [...groups.values()];
  const tasks = [];
  let added = true;
  for (let offset = 0; added; offset += 1) {
    added = false;
    for (const rows of groupRows) {
      if (offset < rows.length) {
        tasks.push(rows[offset]);
        added = true;
      }
    }
  }
  return tasks;
}

function orderDbTasks(sourceTasks) {
  if (sourceTasks.some((task) => Number.isFinite(task?.crawlPriority))) {
    const priorities = [...new Set(sourceTasks.map((task) => Number(task.crawlPriority || 0)))].sort((a, b) => a - b);
    return priorities.flatMap((priority) => {
      const bucket = sourceTasks.filter((task) => Number(task.crawlPriority || 0) === priority);
      return options.dbQueueOrder === 'round-robin'
        ? roundRobinTasksByHost(bucket)
        : groupTasksByHost(bucket);
    });
  }
  return options.dbQueueOrder === 'round-robin'
    ? roundRobinTasksByHost(sourceTasks)
    : groupTasksByHost(sourceTasks);
}

function previewPendingTasks(tasks, cursor, report, limit, overrides = {}) {
  const alreadyDone = overrides.alreadyDone || new Set(
    (report.results || [])
      .filter((result) => doneStatuses.has(result.status))
      .map((result) => result.url),
  );
  const deferredHosts = overrides.deferredHosts || activeQuotaDeferredHosts(report);
  const preview = [];
  for (let index = cursor; index < tasks.length && preview.length < limit; index += 1) {
    const task = tasks[index];
    if (!task || alreadyDone.has(task.url)) continue;
    const host = task.host || safeHost(task.url);
    if (host && deferredHosts.has(host)) continue;
    preview.push(task);
  }
  return preview;
}

function findNextPendingIndex(tasks, report, cursorReset) {
  const alreadyDone = new Set(
    (report.results || [])
      .filter((result) => doneStatuses.has(result.status))
      .map((result) => result.url),
  );
  const deferredHosts = activeQuotaDeferredHosts(report);
  const hint = cursorReset || !Number.isInteger(report.nextIndex) ? 0 : report.nextIndex;

  for (let index = 0; index < tasks.length; index += 1) {
    if (index < hint && !hasExpiredQuotaStops(report)) continue;
    const task = tasks[index];
    if (!task || alreadyDone.has(task.url)) continue;
    const host = task.host || safeHost(task.url);
    if (host && deferredHosts.has(host)) continue;
    return index;
  }

  return tasks.length;
}

function findNextHostBoundary(tasks, startIndex, host) {
  let index = startIndex + 1;
  while (index < tasks.length) {
    const taskHost = tasks[index]?.host || safeHost(tasks[index]?.url);
    if (taskHost !== host) break;
    index += 1;
  }
  return index;
}

function activeQuotaDeferredHosts(report) {
  const today = currentKstDateKey();
  const stops = report.hostQuotaStops || {};
  return new Set(
    Object.entries(stops)
      .filter(([, value]) => quotaStopDate(value) === today)
      .map(([host]) => host),
  );
}

function hasExpiredQuotaStops(report) {
  const today = currentKstDateKey();
  return Object.values(report.hostQuotaStops || {}).some((value) => {
    const date = quotaStopDate(value);
    return date && date !== today;
  });
}

function quotaStopDate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.date || '';
}

function currentKstDateKey() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function kstParts(nowMs = Date.now()) {
  const kstDate = new Date(nowMs + 9 * 60 * 60 * 1000);
  const iso = kstDate.toISOString();
  return {
    dateKey: iso.slice(0, 10),
    minuteOfDay: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
  };
}

function nextKstMidnightMs(nowMs = Date.now()) {
  const kstDate = new Date(nowMs + 9 * 60 * 60 * 1000);
  kstDate.setUTCDate(kstDate.getUTCDate() + 1);
  const nextDateKey = kstDate.toISOString().slice(0, 10);
  return new Date(`${nextDateKey}T00:00:00+09:00`).getTime();
}

function findActiveCrawlPauseWindow(nowMs = Date.now()) {
  if (!options.pauseWindows.length) return null;

  const parts = kstParts(nowMs);
  const dayStartMs = new Date(`${parts.dateKey}T00:00:00+09:00`).getTime();

  for (const window of options.pauseWindows) {
    if (window.startMinute < window.endMinute) {
      if (parts.minuteOfDay >= window.startMinute && parts.minuteOfDay < window.endMinute) {
        return {
          ...window,
          endMs: dayStartMs + window.endMinute * 60 * 1000,
        };
      }
      continue;
    }

    if (parts.minuteOfDay >= window.startMinute) {
      return {
        ...window,
        endMs: dayStartMs + (24 * 60 + window.endMinute) * 60 * 1000,
      };
    }
    if (parts.minuteOfDay < window.endMinute) {
      return {
        ...window,
        endMs: dayStartMs + window.endMinute * 60 * 1000,
      };
    }
  }

  return null;
}

function formatKstDateTime(ms = Date.now()) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

async function waitForCrawlPauseWindowIfNeeded(reason = '') {
  if (!options.pauseWindows.length || options.dryRun || options.loginOnly) return;

  while (!interrupted) {
    const nowMs = Date.now();
    const activeWindow = findActiveCrawlPauseWindow(nowMs);
    if (!activeWindow) return;

    const resumeAtMs = Math.min(activeWindow.endMs, nextKstMidnightMs(nowMs));
    const totalWaitMs = Math.max(0, resumeAtMs - nowMs);
    if (totalWaitMs <= 0) return;

    console.log([
      '[crawl-pause]',
      `runnerPc=${options.runnerPc || 'unknown'}`,
      `window=${activeWindow.label}`,
      `nowKst=${formatKstDateTime(nowMs)}`,
      `resumeKst=${formatKstDateTime(resumeAtMs)}`,
      `waitMinutes=${Math.ceil(totalWaitMs / 60000)}`,
      reason ? `reason=${reason}` : '',
    ].filter(Boolean).join(' '));

    let remainingMs = totalWaitMs;
    while (remainingMs > 0 && !interrupted) {
      const chunkMs = Math.min(remainingMs, options.pauseSleepChunkMs);
      await sleep(chunkMs);
      remainingMs -= chunkMs;
    }
  }
}

function currentKstDayStartIso() {
  return new Date(`${currentKstDateKey()}T00:00:00+09:00`).toISOString();
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function normalizeHostValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return 0;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function shouldAdvance(row) {
  if (shouldHoldBrowserClosedFailure(row)) return false;
  if (shouldHoldSessionFailure(row)) return false;

  return row.status === 'submitted'
    || row.status === 'already-present'
    || row.status === 'skipped'
    || row.status === 'skipped-missing'
    || row.status === 'skipped-reserved-path'
    || row.status === 'unknown'
    || (row.status === 'failed' && options.advanceOnFailed);
}

function shouldStop(row) {
  return row.status === 'blocked'
    || (row.status === 'quota-stop' && options.quotaAction === 'stop')
    || shouldHoldBrowserClosedFailure(row)
    || shouldHoldSessionFailure(row)
    || (row.status === 'failed' && options.stopOnFailed)
    || (row.status === 'unknown' && options.stopOnUnknown);
}

function shouldHoldBrowserClosedFailure(row) {
  return options.stopOnBrowserClosed
    && row?.status === 'failed'
    && isBrowserClosedErrorNote(row.note);
}

function isBrowserClosedErrorNote(note) {
  return /Target page, context or browser has been closed|browser has been closed|context has been closed|Target closed|Page closed/i.test(String(note || ''));
}

function shouldHoldSessionFailure(row) {
  return options.stopOnSessionFailure && isNaverCrawlSessionFailure(row);
}

async function submitOne(page, task) {
  if (isReservedPostPath(task.url)) {
    return buildResult(task, 'skipped-reserved-path', 'reserved numeric path is excluded from crawl requests');
  }

  if (options.preflight) {
    const preflight = await checkPostExists(task.url);
    if (!preflight.ok) {
      return buildResult(task, 'skipped-missing', preflight.note);
    }
  }

  if (options.submitMode === 'api') {
    const apiRow = await submitOneViaApi(page, task);
    if (apiRow.status !== 'failed' || !options.apiFallback) {
      return apiRow;
    }
    if (shouldHoldSessionFailure(apiRow)) {
      return apiRow;
    }

    const uiRow = await submitOneViaUi(page, task);
    uiRow.mode = 'ui-fallback';
    uiRow.note = [
      `api failed: ${apiRow.note}`,
      uiRow.note ? `ui: ${uiRow.note}` : '',
    ].filter(Boolean).join('; ');
    return uiRow;
  }

  return submitOneViaUi(page, task);
}

async function submitOneViaApi(page, task) {
  let lastResult = null;

  for (let attempt = 0; attempt <= options.apiAuthRetries; attempt += 1) {
    const forceSession = attempt > 0;
    const result = await submitOneViaApiOnce(page, task, forceSession);
    lastResult = result;

    if (result.status !== 'failed' || !isApiAuthFailureNote(result.note)) {
      if (attempt > 0 && result.status !== 'failed') {
        result.note = result.note ? `${result.note}; refreshed API session` : 'refreshed API session';
      }
      return result;
    }

    clearApiSessionForTask(task);
  }

  return lastResult || buildResult(task, 'failed', 'API session recovery did not produce a result', { mode: 'api' });
}

async function submitOneViaApiOnce(page, task, forceSession) {
  const urlObject = new URL(task.url);
  const origin = urlObject.origin;
  const documentPath = `${urlObject.pathname}${urlObject.search}`.replace(/^\//, '');
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;

  try {
    const session = await ensureApiSession(page, task, { force: forceSession });
    const response = await page.context().request.post('https://searchadvisor.naver.com/api-console/request/crawl', {
      timeout: options.apiTimeoutMs,
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        origin: 'https://searchadvisor.naver.com',
        referer: crawlPage,
      },
      data: {
        user_enc_id: session.userEncId,
        site: origin,
        document: documentPath,
        _csrf: session.csrfToken,
      },
    });

    const bodyText = await response.text();
    if (isApiAuthFailureResponse(response.status(), bodyText)) {
      return buildResult(task, 'failed', `api auth expired; HTTP ${response.status()}`, { mode: 'api' });
    }

    const body = parseJsonOrNull(bodyText);
    if (!body) {
      const shortBody = bodyText.replace(/\s+/g, ' ').slice(0, 180);
      return buildResult(task, 'failed', `api returned non-json HTTP ${response.status()}: "${shortBody}"`, { mode: 'api' });
    }

    return buildApiResult(task, body, response.status());
  } catch (error) {
    return buildResult(task, 'failed', error?.message || String(error), { mode: 'api' });
  }
}

function buildApiResult(task, body, httpStatus) {
  const code = Number(body?.code);
  const apiDetails = apiResponseDetails(body);
  if (code === 0 || code === 200) {
    return buildResult(task, 'submitted', '', { mode: 'api', apiCode: code });
  }

  if (code === 139) {
    return buildResult(task, 'already-present', 'API says URL was already requested', { mode: 'api', apiCode: code, ...apiDetails });
  }

  if (code === 110) {
    return buildResult(task, 'quota-stop', 'API says daily site request quota was exceeded', { mode: 'api', apiCode: code, ...apiDetails });
  }

  if (code === 601) {
    return buildResult(task, 'blocked', 'API says automation or security check was triggered', { mode: 'api', apiCode: code, ...apiDetails });
  }

  const message = body?.message || body?.error || apiCodeMessages.get(code) || 'unknown API code';
  return buildResult(task, 'failed', `API HTTP ${httpStatus} code ${Number.isFinite(code) ? code : 'unknown'}: ${message}`, {
    mode: 'api',
    apiCode: Number.isFinite(code) ? code : undefined,
    ...apiDetails,
  });
}

function apiResponseDetails(body) {
  const apiMessage = body?.message || body?.error || body?.msg || '';
  return stripUndefined({
    apiMessage: apiMessage || undefined,
    apiResponse: safeShortJson(body),
  });
}

async function submitOneViaUi(page, task) {
  const urlObject = new URL(task.url);
  const origin = urlObject.origin;
  const pathName = urlObject.pathname;
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;

  let status = 'unknown';
  let note = '';

  try {
    await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(options.navigationDelayMs);

    if (await needsNaverLogin(page)) {
      await resolveLogin(page, crawlPage, task);
    }

    const ready = await waitForCrawlPageReady(page, crawlPage, origin);
    let bodyText = ready.bodyText;

    if (blockedPattern.test(bodyText)) {
      status = 'blocked';
      note = 'anti-automation text appeared before submit';
    } else if (isQuotaStopText(bodyText, [pathName, task.url])) {
      status = 'quota-stop';
      note = 'request quota/limit stop text appeared before submit';
    } else if (!ready.ok) {
      status = 'failed';
      note = ready.note;
    } else if (bodyText.includes(pathName) || bodyText.includes(task.url)) {
      status = 'already-present';
      note = 'URL already visible in request history';
    } else {
      const inputBox = page.getByRole('textbox').first();
      await inputBox.fill(task.url, { timeout: 10000 });
      await page.getByRole('button', { name: '확인' }).first().click({ timeout: 10000 });
      await sleep(options.submitWaitMs);

      const confirmation = await waitForSubmissionConfirmation(page, task, pathName);
      status = confirmation.status;
      note = confirmation.note;
    }
  } catch (error) {
    status = 'failed';
    note = error?.message || String(error);
  }

  return buildResult(task, status, note, { mode: 'ui' });
}

async function inspectQuotaStopInUi(page, task, row) {
  const urlObject = new URL(task.url);
  const origin = urlObject.origin;
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeHostName = (task.host || safeHost(task.url) || 'unknown-host').replace(/[^a-zA-Z0-9.-]/g, '_');
  const screenshotPath = path.join(options.quotaInspectDir, `${stamp}-${safeHostName}-${task.postId || 'post'}.png`);

  try {
    await fs.mkdir(options.quotaInspectDir, { recursive: true });
    await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(options.navigationDelayMs);

    if (await needsNaverLogin(page)) {
      await resolveLogin(page, crawlPage, task);
    }

    const ready = await waitForCrawlPageReady(page, crawlPage, origin);
    let submitAttempted = false;
    let uiApiResponse = null;
    if (ready.ok) {
      const inputBox = page.getByRole('textbox').first();
      await inputBox.fill(task.url, { timeout: 10000 });
      const responsePromise = page.waitForResponse(
        (response) => response.url().includes('/api-console/request/crawl'),
        { timeout: 15000 },
      ).catch(() => null);
      await page.getByRole('button', { name: '확인' }).first().click({ timeout: 10000 });
      submitAttempted = true;
      uiApiResponse = await responseDetails(responsePromise);
      await sleep(options.submitWaitMs);
    }

    const bodyText = await readBodyText(page);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    row.quotaUiInspection = {
      at: new Date().toISOString(),
      pageUrl: page.url(),
      screenshotPath,
      ready: ready.ok,
      submitAttempted,
      uiApiResponse,
      note: ready.note || '',
      bodyText: shortenText(bodyText, 1200),
    };
    console.log(`[quota-ui] screenshot=${screenshotPath}`);
  } catch (error) {
    row.quotaUiInspection = {
      at: new Date().toISOString(),
      pageUrl: page.url(),
      screenshotPath,
      error: error?.message || String(error),
    };
    console.warn(`[quota-ui] failed ${task.url}: ${error?.message || String(error)}`);
  }
}

async function waitForSubmissionConfirmation(page, task, pathName) {
  const deadline = Date.now() + Math.max(options.confirmTimeoutMs, 1000);
  let lastBodyText = '';

  while (Date.now() < deadline) {
    const bodyText = await readBodyText(page);
    lastBodyText = bodyText;

    if (blockedPattern.test(bodyText)) {
      return {
        status: 'blocked',
        note: 'anti-automation text appeared after submit',
      };
    }

    if (isQuotaStopText(bodyText, [pathName, task.url])) {
      return {
        status: 'quota-stop',
        note: 'request quota/limit stop text appeared after submit',
      };
    }

    if (bodyText.includes(pathName) || bodyText.includes(task.url)) {
      return {
        status: 'submitted',
        note: '',
      };
    }

    await sleep(options.confirmPollMs);
  }

  const shortBody = lastBodyText.replace(/\s+/g, ' ').slice(0, 180);
  return {
    status: 'unknown',
    note: `submitted but URL was not confirmed before timeout; body="${shortBody}"`,
  };
}

async function responseDetails(responsePromise) {
  const response = await responsePromise;
  if (!response) return null;
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }

  return {
    url: response.url(),
    status: response.status(),
    bodyText: shortenText(bodyText, 1200),
  };
}

async function waitForCrawlPageReady(page, crawlPage, origin) {
  let lastBodyText = '';
  let lastUrl = page.url();
  let lastFastRetryNote = '';
  const attempts = Math.max(0, options.uiReadyRetries) + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(options.navigationDelayMs);
    }

    const deadline = Date.now() + Math.max(options.uiReadyTimeoutMs, 1000);
    let fastRetryAttempt = false;
    while (Date.now() < deadline) {
      lastUrl = page.url();
      lastBodyText = await readBodyText(page);

      if (isNaverLoginPage(lastUrl)) {
        return {
          ok: false,
          bodyText: lastBodyText,
          note: 'Naver login page appeared while waiting for crawl UI',
        };
      }

      if (isSearchAdvisorAuthCallbackUrl(lastUrl)) {
        if (options.authCallbackFastRetryMs > 0) {
          await sleep(options.authCallbackFastRetryMs);
          lastUrl = page.url();
          lastBodyText = await readBodyText(page);
          if (!isSearchAdvisorAuthCallbackUrl(lastUrl)) {
            continue;
          }
        }

        lastFastRetryNote = `crawl page hit Search Advisor auth callback; fast retrying; finalUrl=${lastUrl}; body="${lastBodyText.replace(/\s+/g, ' ').slice(0, 180)}"`;
        fastRetryAttempt = true;
        break;
      }

      if (lastBodyText.includes(origin) && lastBodyText.includes('웹 페이지 수집')) {
        return {
          ok: true,
          bodyText: lastBodyText,
          note: '',
        };
      }

      await sleep(1500);
    }

    if (fastRetryAttempt) continue;
  }

  return {
    ok: false,
    bodyText: lastBodyText,
    note: lastFastRetryNote || `crawl page did not load expected site UI; finalUrl=${lastUrl}; body="${lastBodyText.replace(/\s+/g, ' ').slice(0, 180)}"`,
  };
}

function isSearchAdvisorAuthCallbackUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'searchadvisor.naver.com'
      && url.pathname.replace(/\/+$/, '') === '/auth/callback';
  } catch {
    return /searchadvisor\.naver\.com\/auth\/callback/i.test(String(value || ''));
  }
}

function isQuotaStopText(bodyText, allowedNeedles = []) {
  if (allowedNeedles.some((needle) => needle && bodyText.includes(needle))) {
    return false;
  }

  return quotaStopPattern.test(bodyText);
}

async function ensureApiSession(page, task, { force = false } = {}) {
  if (!task) {
    throw new Error('Cannot initialize Naver API session without a task');
  }

  const origin = new URL(task.url).origin;
  const sessionKey = apiSessionKeyForOrigin(origin);
  const cachedSession = apiSessions.get(sessionKey);
  const sessionIsFresh = cachedSession
    && (options.apiSessionScope === 'account' || cachedSession.site === origin)
    && (!options.apiSessionMaxMs || Date.now() - cachedSession.loadedAt < options.apiSessionMaxMs);
  if (!force && sessionIsFresh) {
    return cachedSession;
  }

  const cachedPromise = apiSessionPromises.get(sessionKey);
  if (cachedPromise && !force) {
    return cachedPromise;
  }

  const sessionPromise = loadApiSession(page, task, { force })
    .then((session) => {
      apiSessions.set(sessionKey, session);
      return session;
    })
    .finally(() => {
      apiSessionPromises.delete(sessionKey);
    });
  apiSessionPromises.set(sessionKey, sessionPromise);
  return sessionPromise;
}

function apiSessionKeyForOrigin(origin) {
  return options.apiSessionScope === 'account' ? 'account' : origin;
}

function clearApiSessionForTask(task) {
  try {
    const origin = new URL(task.url).origin;
    const sessionKey = apiSessionKeyForOrigin(origin);
    apiSessions.delete(sessionKey);
    apiSessionPromises.delete(sessionKey);
  } catch {}
}

async function loadApiSession(page, task) {
  const origin = new URL(task.url).origin;
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;

  await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(options.navigationDelayMs);

  if (await needsNaverLogin(page)) {
    await resolveLogin(page, crawlPage, task);
  }

  const ready = await waitForCrawlPageReady(page, crawlPage, origin);
  if (blockedPattern.test(ready.bodyText)) {
    throw new Error('anti-automation text appeared while initializing API session');
  }

  if (!ready.ok) {
    const recovered = await recoverSearchAdvisorConsoleSession(page, ready);
    if (recovered?.userEncId && recovered?.csrfToken) {
      return {
        ...recovered,
        site: origin,
        loadedAt: Date.now(),
      };
    }

    throw new Error(ready.note);
  }

  const extracted = await extractSearchAdvisorSession(page);
  return {
    ...extracted,
    site: origin,
    loadedAt: Date.now(),
  };
}

async function recoverSearchAdvisorConsoleSession(page, ready = {}) {
  const bodyText = ready.bodyText || await readBodyText(page).catch(() => '');
  if (!isRecoverableSearchAdvisorConsoleProblem(bodyText, page.url())) {
    return null;
  }

  const recovered = {
    recovery: 'main-webmaster',
    initialUrl: page.url(),
  };

  const clickedMain = await clickSearchAdvisorText(page, searchAdvisorMainButtonText);
  recovered.clickedMain = clickedMain;
  if (clickedMain) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(options.navigationDelayMs);
  }

  const clickedWebmaster = await clickSearchAdvisorText(page, webmasterToolsText);
  recovered.clickedWebmaster = clickedWebmaster;
  if (clickedWebmaster) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(options.navigationDelayMs);
  }

  let session = await extractSearchAdvisorSessionOrNull(page);
  if (!session?.userEncId || !session?.csrfToken) {
    await page.goto('https://searchadvisor.naver.com/console/board', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(options.navigationDelayMs);
    session = await extractSearchAdvisorSessionOrNull(page);
    recovered.directBoardFallback = true;
  }

  if (!session?.userEncId || !session?.csrfToken) {
    return null;
  }

  console.log(`[crawl] recovered Search Advisor API session via main/webmaster navigation: ${page.url()}`);
  return {
    ...session,
    recovery: recovered,
  };
}

function isRecoverableSearchAdvisorConsoleProblem(bodyText, url = '') {
  const text = String(bodyText || '');
  return /searchadvisor\.naver\.com/i.test(String(url || ''))
    && (
      text.includes(searchAdvisorProblemText)
      || text.includes(searchAdvisorAccessDeniedText)
      || text.includes(searchAdvisorMainButtonText)
    );
}

async function clickSearchAdvisorText(page, text) {
  const escaped = escapeRegExp(text);
  const locators = [
    page.getByRole('button', { name: new RegExp(escaped) }),
    page.getByRole('link', { name: new RegExp(escaped) }),
    page.getByText(text),
    page.locator(`text=${text}`),
  ];

  for (const locator of locators) {
    try {
      if (await locator.count() <= 0) continue;
      await locator.first().click({ timeout: 7000 });
      return true;
    } catch {}
  }

  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function extractSearchAdvisorSession(page) {
  const deadline = Date.now() + 15000;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await page.evaluate(() => {
      const nuxtState = window.$nuxt?.$store?.state || window.__NUXT__?.state || {};
      const authUser = nuxtState.authUser || {};
      const metaCsrf = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.getAttribute('content') || '';
      return {
        userEncId: authUser.enc_id || authUser.encId || '',
        csrfToken: nuxtState.csrfToken || metaCsrf,
        appBarUrl: nuxtState.appBarUrl || '',
        accountId: authUser.id || '',
        email: authUser.email || '',
      };
    }).catch(() => null);

    if (lastState?.userEncId && lastState?.csrfToken) {
      return lastState;
    }

    await sleep(500);
  }

  throw new Error(`could not extract Search Advisor API session; state=${JSON.stringify(lastState || {})}`);
}

async function extractSearchAdvisorSessionOrNull(page) {
  try {
    return await extractSearchAdvisorSession(page);
  } catch {
    return null;
  }
}

function buildResult(task, status, note = '', extra = {}) {
  return {
    account: task.account || 'ju1wig',
    accountOrganization: task.accountOrganization,
    project: task.project,
    areaSlug: task.areaSlug,
    areaName: task.areaName,
    urlKind: task.urlKind,
    requestId: task.requestId,
    mappedPage: task.mappedPage,
    residueSlot: task.residueSlot,
    host: task.host,
    postId: task.postId,
    pageDomainId: task.pageDomainId,
    pageRequestId: task.pageRequestId,
    locationId: task.locationId,
    location: task.location,
    mainKeywordId: task.mainKeywordId,
    mainKeyword: task.mainKeyword,
    exposureTargetId: task.exposureTargetId,
    exposureStatus: task.exposureStatus,
    exposureQueryText: task.exposureQueryText,
    crawlPriority: task.crawlPriority,
    url: task.url,
    status,
    note,
    at: new Date().toISOString(),
    ...stripUndefined(extra),
  };
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeShortJson(value) {
  // 원문은 이제 DB 가 아니라 로컬 raw 로그로 간다. 로컬 디스크는 싸므로
  // 잘라내는 한도를 800 → 4000 으로 늘렸다 (2026-08-21).
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return undefined;
  }
}

function shortenText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isApiAuthFailureResponse(status, bodyText) {
  return status === 401
    || status === 403
    || status === 419
    || /auth\/login|auth\/callback|nid\.naver\.com|oauth2\.0\/authorize/i.test(bodyText);
}

function isApiAuthFailureNote(note) {
  return /api auth expired|auth\/login|auth\/callback|nid\.naver\.com|oauth2\.0\/authorize|Naver login page appeared|Naver login is required|crawl page did not load expected site UI|could not extract Search Advisor API session/i.test(note || '');
}

async function checkPostExists(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        note: `preflight HTTP ${response.status}`,
      };
    }

    const text = await response.text();
    if (!text) {
      return {
        ok: false,
        note: 'preflight returned an empty page',
      };
    }

    const requestedPostId = postIdFromUrl(url);
    const renderedPostId = renderedCurrentPostId(text);
    if (requestedPostId != null && renderedPostId != null) {
      return renderedPostId === requestedPostId
        ? { ok: true, note: '' }
        : {
          ok: false,
          note: `preflight rendered fallback page ${renderedPostId} instead of ${requestedPostId}`,
        };
    }

    if (/not found|없는 페이지|페이지를 찾을 수 없습니다/i.test(text.slice(0, 5000))) {
      return {
        ok: false,
        note: 'preflight response looked like a missing page',
      };
    }

    return { ok: true, note: '' };
  } catch (error) {
    return {
      ok: false,
      note: `preflight failed: ${error?.message || String(error)}`,
    };
  }
}

function postIdFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/(\d+)\/?$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isReservedPostPath(url) {
  return postIdFromUrl(url) === 404;
}

function renderedCurrentPostId(text) {
  const navMatch = text.match(/<nav\b[^>]*class=["'][^"']*\bmt-4\b[^"']*["'][\s\S]*?<\/nav>/i);
  const haystack = navMatch?.[0] || text;
  const activeTag = haystack.match(/<a\b[^>]*aria-current=["']page["'][^>]*>/i);
  const href = activeTag?.[0]?.match(/href=["']([^"']+)["']/i)?.[1] || '';
  const match = href.match(/\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

async function launchContext() {
  // 프록시는 컨텍스트 생성 시점에 묶인다. 세션 재설정(601/401/403)은 같은
  // 컨텍스트 안에서 재로그인하므로 프록시 바인딩이 그대로 유지된다.
  const proxyConfig = resolveProxyConfig({
    cliFlag: options.useProxy,
    accountId: options.accountId,
    projectRoot: rootDir,
  });
  logProxyBanner(proxyConfig, 'crawl requests');
  const proxy = playwrightProxy(proxyConfig);

  const launchOptions = {
    headless: options.headless,
    slowMo: options.slowMo,
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    ...(proxy ? { proxy } : {}),
  };

  if (options.browserChannel) {
    try {
      const context = await chromium.launchPersistentContext(options.userDataDir, {
        ...launchOptions,
        channel: options.browserChannel,
      });
      await hydrateContextStorageState(context);
      return context;
    } catch (error) {
      console.warn(`Could not launch browser channel "${options.browserChannel}": ${error.message}`);
      console.warn('Trying Playwright Chromium instead.');
    }
  }

  const context = await chromium.launchPersistentContext(options.userDataDir, launchOptions);
  await hydrateContextStorageState(context);
  return context;
}

async function hydrateContextStorageState(context) {
  if (!options.storageStatePath) return;

  let state = null;
  try {
    state = JSON.parse(await fs.readFile(options.storageStatePath, 'utf8'));
  } catch (error) {
    console.warn(`Could not read NAVER_CRAWL_STORAGE_STATE=${options.storageStatePath}: ${error.message}`);
    return;
  }

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length) {
    await context.addCookies(cookies);
    console.log(`[crawl] loaded ${cookies.length} cookies from ${options.storageStatePath}`);
  }
}

async function persistContextStorageState(context) {
  if (!options.storageStatePath) return;

  try {
    await fs.mkdir(path.dirname(options.storageStatePath), { recursive: true });
    await context.storageState({ path: options.storageStatePath });
    await fs.chmod(options.storageStatePath, 0o600).catch(() => {});
    console.log(`[crawl] saved storage state to ${options.storageStatePath}`);
  } catch (error) {
    console.warn(`Could not save NAVER_CRAWL_STORAGE_STATE=${options.storageStatePath}: ${error.message}`);
  }
}

async function openLoginCheckPage(page, task) {
  const origin = new URL(task.url).origin;
  const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;
  await page.goto(crawlPage, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function ensureCrawlAccess(page, task) {
  if (!task) return;

  await openLoginCheckPage(page, task);
  await sleep(options.navigationDelayMs);

  if (await needsNaverLogin(page)) {
    const origin = new URL(task.url).origin;
    const crawlPage = `https://searchadvisor.naver.com/console/site/request/crawl?site=${encodeURIComponent(origin)}`;
    await resolveLogin(page, crawlPage, task);
  }
}

async function resolveLogin(page, returnUrl, task) {
  if (!options.waitForLogin) {
    const bodyText = await readBodyText(page).catch(() => '');
    throw new Error(`Naver login is required for profile ${options.userDataDir}; url=${page.url()}; body="${shortenText(bodyText, 180)}". Run "pnpm naver:crawl-requests --login-only" and complete login first.`);
  }

  if (options.autoLogin) {
    const attempted = await attemptAutoLogin(page);
    if (attempted) {
      await sleep(options.navigationDelayMs);
      if (!await needsNaverLogin(page)) {
        await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(options.navigationDelayMs);
        return;
      }
      console.log('Naver auto login did not complete. Complete any remaining security step in the opened browser, then press Enter here.');
    }
  }

  console.log('Naver login is required. Complete login in the opened browser, then press Enter here.');
  await waitForEnter();
  await page.goto(returnUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(options.navigationDelayMs);
}

async function readBodyText(page) {
  return page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
}

async function getCrawlDbClient() {
  if (!crawlDb.enabled) return null;
  if (!crawlDbClientPromise) {
    crawlDbClientPromise = connectCrawlRequestDb()
      .then((client) => attachCrawlDbClientErrorHandler(client, 'write'))
      .catch((error) => {
        warnCrawlDb(`DB connection/setup failed: ${error?.message || String(error)}`);
        if (requiresDbPersistence()) {
          throw error;
        }
        return null;
      });
  }
  return crawlDbClientPromise;
}

async function getCrawlSourceDbClient() {
  if (!crawlSourceDbClientPromise) {
    crawlSourceDbClientPromise = connectCrawlRequestDb()
      .then((client) => attachCrawlDbClientErrorHandler(client, 'source'))
      .catch((error) => {
        throw new Error(`DB queue source connection/setup failed: ${error?.message || String(error)}`);
      });
  }
  return crawlSourceDbClientPromise;
}

async function addDbDoneUrls(alreadyDone, tasks, { allowDryRun = false } = {}) {
  if (!options.useDbDoneUrls || options.queueSource !== 'db' || (options.dryRun && !allowDryRun) || !options.accountId) return;

  for (const url of persistedDoneUrlCache) alreadyDone.add(url);

  const candidateUrls = [...new Set(tasks
    .map((task) => task?.url)
    .filter((url) => url && !alreadyDone.has(url)))];
  if (!candidateUrls.length) return;

  const client = await getCrawlSourceDbClient();
  const doneStatusList = [...doneStatuses];
  const pageTaskByUrl = new Map(tasks
    .filter((task) => task?.url && task?.pageDomainId && task?.pageRequestId)
    .map((task) => [task.url, task]));
  const chunkSize = 10000;
  let doneCount = 0;
  let hydratedCount = 0;

  for (let offset = 0; offset < candidateUrls.length; offset += chunkSize) {
    const urls = candidateUrls.slice(offset, offset + chunkSize);
    const { rows } = await client.query(
      `
        select distinct on (result.url)
          result.id,
          result.url,
          result.page_domain_id,
          result.page_request_id,
          result.requested_at
        from public.naver_searchadvisor_crawl_request_results result
        join public.naver_searchadvisor_crawl_request_runs run
          on run.run_id = result.run_id
        where run.target_project = $2
          and (run.account_id = $1 or result.account = $1)
          and result.status = any($4::text[])
          and result.url = any($3::text[])
          ${options.doneSince ? 'and result.requested_at >= $5::timestamptz' : ''}
        order by result.url, result.requested_at desc, result.id desc
      `,
      [options.accountId, crawlDb.targetProject, urls, doneStatusList,
        ...(options.doneSince ? [options.doneSince] : [])],
    );

    for (const row of rows) {
      if (row.url && !alreadyDone.has(row.url)) {
        alreadyDone.add(row.url);
        persistedDoneUrlCache.add(row.url);
        doneCount += 1;
      }
    }

    const links = rows.flatMap((row) => {
      const task = pageTaskByUrl.get(row.url);
      if (!task) return [];
      return [{
        resultId: Number(row.id),
        pageDomainId: Number(task.pageDomainId),
        pageRequestId: Number(task.pageRequestId),
      }];
    });
    if (!options.dryRun) {
      hydratedCount += await hydrateCrawlResultPageLinks(client, links);
    }
  }

  if (doneCount > 0) {
    console.log(`[crawl-db] loaded ${doneCount} previously completed URL(s) for ${options.accountId}/${crawlDb.targetProject}`);
  }
  if (hydratedCount > 0) {
    console.log(`[crawl-db] linked ${hydratedCount} completed result(s) to page catalog state`);
  }
}

async function addDbQuotaDeferredHosts(deferredHosts, tasks, { allowDryRun = false } = {}) {
  if (!options.useDbDoneUrls || options.queueSource !== 'db' || (options.dryRun && !allowDryRun) || !options.accountId) return;

  const candidateHosts = [...new Set(tasks
    .map((task) => task?.host || safeHost(task?.url))
    .filter((host) => host && !deferredHosts.has(host)))];
  if (!candidateHosts.length) return;

  const client = await getCrawlSourceDbClient();
  const chunkSize = 10000;
  let deferredCount = 0;

  for (let offset = 0; offset < candidateHosts.length; offset += chunkSize) {
    const hosts = candidateHosts.slice(offset, offset + chunkSize);
    const { rows } = await client.query(
      `
        select distinct result.host
        from public.naver_searchadvisor_crawl_request_results result
        join public.naver_searchadvisor_crawl_request_runs run
          on run.run_id = result.run_id
        where run.target_project = $2
          and (run.account_id = $1 or result.account = $1)
          and result.status = 'quota-stop'
          and result.host = any($3::text[])
          and result.requested_at >= $4::timestamptz
      `,
      [options.accountId, crawlDb.targetProject, hosts, currentKstDayStartIso()],
    );

    for (const row of rows) {
      if (row.host && !deferredHosts.has(row.host)) {
        deferredHosts.add(row.host);
        deferredCount += 1;
      }
    }
  }

  if (deferredCount > 0) {
    console.log(`[crawl-db] loaded ${deferredCount} quota-deferred host(s) for ${options.accountId}/${crawlDb.targetProject}`);
  }
}

async function recordCrawlRunSafe(status, report, queueDoc = {}, error = null) {
  if (!crawlDb.enabled || options.dryRun || options.loginOnly) return;

  await enqueueCrawlDbWrite(async () => {
    const client = await getCrawlDbClient();
    if (!client) {
      if (requiresDbPersistence()) {
        throw new Error('DB persistence is required because local crawl reports are disabled.');
      }
      return;
    }
    await upsertCrawlRequestRun(client, {
      runId: crawlDb.runId,
      targetProject: crawlDb.targetProject,
      triggerType: crawlDb.triggerType,
      status,
      options: {
        ...options,
        reportPath: reportStoragePath(),
      },
      report,
      queueDoc,
      error,
      sourcePayload: {
        script: 'scripts/submit-naver-searchadvisor-crawl-requests.mjs',
        localReport: options.localReport,
        reportPath: reportStoragePath(),
      },
    });
  });
}

/*
 * 응답 원문·UI 검사 스냅샷을 로컬 raw 로그에 붙인다. DB 쓰기와 독립이라
 * 실패해도 삼킨다(수집요청 진행을 막으면 안 된다). 자정을 넘기면 다음
 * 줄부터 새 날짜 파일에 붙는다.
 */
function appendCrawlRawLogSafe(rows, startIndex) {
  if (!rawLog.enabled || !rows.length) return;
  try {
    const now = Date.now();
    const kstDay = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mkdirSync(rawLog.dir, { recursive: true });
    const lines = rows.map((row, offset) => JSON.stringify({
      runId: crawlDb.runId,
      idx: startIndex + offset,
      account: row.account || options.accountId || null,
      url: row.url || null,
      status: row.status || null,
      note: row.note || undefined,
      mode: row.mode || undefined,
      apiCode: Number.isInteger(row.apiCode) ? row.apiCode : undefined,
      apiMessage: row.apiMessage || undefined,
      raw: row.apiResponse || undefined,
      quotaUiInspection: row.quotaUiInspection || undefined,
      at: row.at || new Date(now).toISOString(),
    })).join('\n');
    appendFileSync(path.join(rawLog.dir, `${kstDay}.${rawLog.machine}.jsonl`), `${lines}\n`);
  } catch (error) {
    console.warn(`[raw-log] append failed: ${error?.message || String(error)}`);
  }
}

async function recordCrawlResultsSafe(rows, startIndex) {
  if (!crawlDb.enabled || options.dryRun || options.loginOnly || !rows.length) return;

  appendCrawlRawLogSafe(rows, startIndex);
  await enqueueCrawlDbWrite(async () => {
    const client = await getCrawlDbClient();
    if (!client) {
      if (requiresDbPersistence()) {
        throw new Error('DB persistence is required because local crawl reports are disabled.');
      }
      return;
    }
    await upsertCrawlRequestResults(client, {
      runId: crawlDb.runId,
      // 원문은 위 raw 로그로 갔다. DB 에는 추출 컬럼(api_code·api_message)만 남긴다.
      rows: rows.map((row) => ({ ...row, apiResponse: undefined })),
      startIndex,
    });
  });
}

async function recordCrawlRunFailure(error) {
  if (!crawlDb.enabled || options.dryRun || options.loginOnly) return;

  let report = null;
  try {
    report = await readReport(options.reportPath);
  } catch {
    report = { results: [] };
  }

  await recordCrawlRunSafe('failed', report, {}, error?.message || String(error));
}

async function sendCrawlSessionAlertOnce({ row = null, report = null, error = null } = {}) {
  if (options.dryRun || options.loginOnly || crawlSessionAlertSent) return;

  if (!isNaverCrawlSessionFailure(row) && !isNaverCrawlSessionFailure(error)) {
    return;
  }

  crawlSessionAlertSent = true;
  let alertReport = report;
  if (!alertReport) {
    try {
      alertReport = await readReport(options.reportPath);
    } catch {
      alertReport = { results: [] };
    }
  }

  await sendNaverCrawlSessionAlertSafe({
    report: alertReport,
    reportPath: reportStoragePath(),
    queuePath: options.queuePath,
    row,
    error,
    runId: crawlDb.runId,
    targetProject: crawlDb.targetProject,
    triggerType: crawlDb.triggerType,
  });
}

async function enqueueCrawlDbWrite(write) {
  crawlDbWriteQueue = crawlDbWriteQueue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await write();
        return;
      } catch (error) {
        if (attempt === 0 && isCrawlDbConnectionError(error)) {
          markCrawlDbClientStale(error);
          warnCrawlDb(`write connection failed; retrying with a fresh DB connection: ${error?.message || String(error)}`);
          continue;
        }

        warnCrawlDb(`write failed: ${error?.message || String(error)}`);
        if (requiresDbPersistence()) {
          throw error;
        }
        return;
      }
    }
  });
  return crawlDbWriteQueue;
}

async function closeCrawlDb() {
  await crawlDbWriteQueue;
  const client = crawlDbClientPromise ? await crawlDbClientPromise.catch(() => null) : null;
  if (client) await closePgClientFast(client, 'write');
  if (crawlSourceDbClientPromise && crawlSourceDbClientPromise !== crawlDbClientPromise) {
    const sourceClient = await crawlSourceDbClientPromise.catch(() => null);
    if (sourceClient) await closePgClientFast(sourceClient, 'source');
  }
  crawlDbClientPromise = null;
  crawlSourceDbClientPromise = null;
}

async function closePgClientFast(client, role) {
  if (!client) return;

  let timedOut = false;
  const endPromise = client.end().catch((error) => {
    if (!timedOut) throw error;
  });
  await Promise.race([
    endPromise,
    sleep(options.dbCloseTimeoutMs).then(() => {
      timedOut = true;
      client.connection?.stream?.destroy?.();
    }),
  ]).catch((error) => {
    warnCrawlDb(`${role} DB close failed: ${error?.message || String(error)}`);
  });

  if (timedOut) {
    warnCrawlDb(`${role} DB close exceeded ${options.dbCloseTimeoutMs}ms; destroyed socket after pending writes finished`);
  }
}

function attachCrawlDbClientErrorHandler(client, role) {
  if (!client || client.__naverCrawlErrorHandlerAttached) return client;

  Object.defineProperty(client, '__naverCrawlErrorHandlerAttached', {
    value: true,
    enumerable: false,
  });

  client.on('error', (error) => {
    warnCrawlDb(`${role} DB connection error: ${error?.message || String(error)}`);
    if (role === 'write') {
      markCrawlDbClientStale(error);
    } else if (role === 'source') {
      crawlSourceDbClientPromise = null;
    }
  });

  return client;
}

function markCrawlDbClientStale(error) {
  const staleClientPromise = crawlDbClientPromise;
  crawlDbClientPromise = null;
  if (!staleClientPromise) return;

  staleClientPromise
    .then((client) => client?.end().catch(() => {}))
    .catch(() => {});
  if (error) {
    warnCrawlDb(`DB write connection will be recreated: ${error?.message || String(error)}`);
  }
}

function isCrawlDbConnectionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === '57P01'
    || code === '08003'
    || code === '08006'
    || message.includes('connection terminated')
    || message.includes('connection ended')
    || message.includes('connection reset')
    || message.includes('not queryable')
    || message.includes('client has encountered a connection error');
}

function finalRunStatus(report, tasks) {
  if (interrupted) return 'partial';
  const nextIndex = Number.isInteger(report.nextIndex) ? report.nextIndex : 0;
  const totalTasks = Number.isInteger(report.totalTasks) ? report.totalTasks : tasks.length;
  return nextIndex >= totalTasks ? 'succeeded' : 'partial';
}

function warnCrawlDb(message) {
  if (crawlDbWarningShown) return;
  crawlDbWarningShown = true;
  console.warn(`[crawl-db] ${message}`);
}

async function readReport(reportPath) {
  if (!options.localReport) {
    inMemoryReport ||= emptyReport();
    return inMemoryReport;
  }

  try {
    const report = await readJson(reportPath);
    report.results ||= [];
    report.hostQuotaStops ||= {};
    return report;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return emptyReport();
  }
}

async function saveReport(report, queueDoc, tasks, nextIndex, order) {
  const submittedOrPresent = report.results.filter((result) => ['submitted', 'already-present'].includes(result.status)).length;
  const skippedMissing = report.results.filter((result) => result.status === 'skipped-missing').length;
  const skippedReservedPath = report.results.filter((result) => result.status === 'skipped-reserved-path').length;
  const updated = {
    account: options.accountId || queueDoc.account || report.account || tasks[0]?.account || 'ju1wig',
    updatedAt: new Date().toISOString(),
    order,
    queueSource: options.queueSource,
    targetProject: crawlDb.targetProject,
    seed: queueDoc.seed,
    domainCount: queueDoc.domainCount,
    totalCandidatePages: queueDoc.totalCandidatePages,
    minPageCount: queueDoc.minPageCount,
    maxPageCount: queueDoc.maxPageCount,
    nextIndex,
    totalTasks: tasks.length,
    submittedOrPresent,
    skippedMissing,
    skippedReservedPath,
    hostQuotaStops: report.hostQuotaStops || {},
    sourceTrust: queueDoc.dbUrlSource === 'catalog' ? 'db-page-catalog' : 'db-page-count',
    results: report.results,
  };
  inMemoryReport = updated;
  if (!options.localReport) return;

  const writePromise = reportFileWriteQueue
    .catch(() => {})
    .then(() => writeLocalReportFile(updated));
  reportFileWriteQueue = writePromise;
  await writePromise;
}

async function writeLocalReportFile(updated) {
  const payload = JSON.stringify(updated, null, 2);
  const reportDir = path.dirname(options.reportPath);
  await fs.mkdir(reportDir, { recursive: true });

  const tempPath = `${options.reportPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, payload);
  try {
    await replaceReportFileWithRetry(tempPath, options.reportPath, payload);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function replaceReportFileWithRetry(tempPath, reportPath, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(tempPath, reportPath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReportFileError(error)) throw error;

      if (process.platform === 'win32' && attempt >= 2) {
        try {
          await fs.rm(reportPath, { force: true });
          await fs.rename(tempPath, reportPath);
          return;
        } catch (replaceError) {
          lastError = replaceError;
        }
      }
      await sleep(Math.min(1000, 100 * (attempt + 1)));
    }
  }

  try {
    await fs.writeFile(reportPath, payload);
  } catch (fallbackError) {
    const error = new Error(`Failed to save local crawl report after retrying ${reportPath}: ${fallbackError.message}`);
    error.cause = fallbackError;
    error.lastRenameError = lastError;
    throw error;
  }
}

function isRetryableReportFileError(error) {
  return ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
}

function emptyReport() {
  return {
    account: options.accountId || 'ju1wig',
    updatedAt: new Date().toISOString(),
    order: 'deterministic-random',
    nextIndex: 0,
    totalTasks: 0,
    submittedOrPresent: 0,
    skippedMissing: 0,
    hostQuotaStops: {},
    sourceTrust: 'db-page-count',
    results: [],
  };
}

function reportStoragePath() {
  return options.localReport ? options.reportPath : '';
}

function reportStorageLabel() {
  return options.localReport ? options.reportPath : 'db-only';
}

function requiresDbPersistence() {
  return crawlDb.enabled && !options.localReport && !options.dryRun && !options.loginOnly;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function waitForEnter() {
  const rl = createInterface({ input, output });
  try {
    await rl.question('Press Enter to continue...');
  } finally {
    rl.close();
  }
}

function isNaverLoginPage(url) {
  return url.includes('nid.naver.com') || url.includes('/oauth2.0/authorize');
}

async function needsNaverLogin(page) {
  if (isNaverLoginPage(page.url())) return true;
  if (await hasNaverLoginForm(page)) return true;

  const bodyText = await readBodyText(page);
  if (isLoginProblemText(bodyText)) {
    console.warn(`[crawl] ignored login-like text outside a Naver login page/form; url=${page.url()} body="${shortenText(bodyText, 180)}"`);
  }
  return false;
}

async function attemptAutoLogin(page) {
  if (!options.accountId) {
    console.log('[crawl] auto login skipped: NAVER_CRAWL_ACCOUNT_ID is empty');
    return false;
  }
  if (!isNaverLoginPage(page.url()) && !await hasNaverLoginForm(page)) return false;

  let password = await loadAccountPassword(options.accountId);
  if (!password) {
    console.log(`[crawl] auto login skipped: stored password not found for account=${options.accountId}`);
    return false;
  }

  try {
    console.log(`[crawl] filling Naver login form from DB for account=${options.accountId} without printing password`);
    await fillNaverLoginForm(page, options.accountId, password);
    return true;
  } finally {
    password = '';
  }
}

async function loadAccountPassword(accountId) {
  const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!connectionString) return '';

  const client = new Client(createClientConfig(connectionString));
  await client.connect();
  try {
    const result = await client.query(
      `
        select account.password_plain,
               secret.decrypted_secret as password_secret
        from public.naver_searchadvisor_accounts account
        left join vault.decrypted_secrets secret
          on secret.id = account.password_secret_id
        where account.account_id = $1
        limit 1
      `,
      [accountId]
    );
    return result.rows[0]?.password_plain || result.rows[0]?.password_secret || '';
  } catch (error) {
    if (['42703', '42P01'].includes(error?.code) || /does not exist|column .* does not exist/i.test(String(error?.message || ''))) {
      return '';
    }
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function fillNaverLoginForm(page, accountId, password) {
  const idInput = page.locator('#id, input[name="id"], input[placeholder*="아이디"]').first();
  const passwordInput = page.locator('#pw, input[name="pw"], input[type="password"]').first();

  await idInput.click({ timeout: 15000 });
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(accountId, { delay: 35 });

  await passwordInput.click({ timeout: 15000 });
  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(password, { delay: 35 });

  const submit = page.locator('button[type="submit"], input[type="submit"], .btn_login, #log\\.login').first();
  try {
    await submit.click({ timeout: 15000 });
  } catch {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

function isLoginProblemText(bodyText) {
  return loginProblemPattern.test(bodyText);
}

async function hasNaverLoginForm(page) {
  try {
    const count = await page.locator([
      'form[action*="nid.naver.com"]',
      'input#id',
      'input[name="id"]',
      'input#pw',
      'input[name="pw"]',
    ].join(',')).count();
    return count > 0;
  } catch {
    return false;
  }
}

function readInt(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptionalPositiveInt(value) {
  if (value == null || value === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function isEnabled(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeBrowserChannel(value) {
  if (value === 'none' || value === '0' || value === 'false') return '';
  return value || 'chrome';
}

function normalizeSubmitMode(value) {
  return value === 'ui' ? 'ui' : 'api';
}

function normalizeQuotaAction(value) {
  return value === 'stop' ? 'stop' : 'defer-host';
}

function normalizeQueueOrder(value) {
  return value === 'queue' || value === 'random' ? 'queue' : 'host';
}

function normalizeDbQueueOrder(value) {
  return value === 'round-robin' ? 'round-robin' : 'host';
}

function splitEnv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDbUrlSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['page-count', 'page_count', 'pages', 'numeric'].includes(normalized)) return 'page-count';
  if (['sitemap', 'sitemap.xml'].includes(normalized)) return 'sitemap';
  if (['catalog', 'page-catalog', 'page_catalog'].includes(normalized)) return 'catalog';
  return 'auto';
}

function normalizeRunnerPc(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'desktop-j6uplii') return 'siwol-win';
  if (normalized === 'desktop-7005n8d') return 'siwol-win2';
  return normalized;
}

function defaultPauseWindowsForRunner(runnerPc) {
  return normalizeRunnerPc(runnerPc) === 'siwol-win2' ? '09:40-19:05' : '';
}

function parseCrawlPauseWindows(value) {
  const raw = String(value || '').trim();
  if (!raw || ['0', 'false', 'off', 'none'].includes(raw.toLowerCase())) return [];

  return raw
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!match) throw new Error(`Invalid NAVER_CRAWL_PAUSE_WINDOWS item: ${item}`);
      const startMinute = parseClockMinute(match[1]);
      const endMinute = parseClockMinute(match[2]);
      if (startMinute === endMinute) throw new Error(`Invalid NAVER_CRAWL_PAUSE_WINDOWS zero-length item: ${item}`);
      return { startMinute, endMinute, label: `${formatClockMinute(startMinute)}-${formatClockMinute(endMinute)}` };
    });
}

function parseClockMinute(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid clock time: ${value}`);
  }
  return hour * 60 + minute;
}

function formatClockMinute(value) {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeQueueSource(value) {
  return value === 'db' ? 'db' : 'file';
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function createClientConfig(value) {
  const url = new URL(value);
  const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');

  return {
    connectionString: url.toString(),
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
