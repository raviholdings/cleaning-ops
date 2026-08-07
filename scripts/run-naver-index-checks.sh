#!/usr/bin/env bash
set -u

ROOT_DIR="${ROOT_DIR:-/home/test02/watermelon-crawl-requests}"
INDEX_LOCK_FILE="${NAVER_INDEX_LOCK_FILE:-/tmp/naver-index-checks.lock}"
CRAWL_LOCK_FILE="${CRAWL_LOCK_FILE:-/tmp/watermelon-naver-crawl.lock}"
CRAWL_LOCK_WAIT_SECONDS="${CRAWL_LOCK_WAIT_SECONDS:-7200}"
LOG_FILE="$ROOT_DIR/logs/naver-index-checks.log"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
REQUEST_DELAY_MS="${NAVER_INDEX_REQUEST_DELAY_MS:-1250}"
HOST_DELAY_MS="${NAVER_INDEX_HOST_DELAY_MS:-0}"
DELAY_JITTER_MS="${NAVER_INDEX_DELAY_JITTER_MS:-0}"
INDEX_CHECK_CONCURRENCY="${NAVER_INDEX_CHECK_CONCURRENCY:-150}"
INDEX_PROXY_ENABLED="${NAVER_INDEX_PROXY_ENABLED:-1}"
INDEX_PROXY_FILE="${NAVER_INDEX_PROXY_FILE:-private/webshare-proxies-13628755.txt}"
INDEX_PROXY_TIMEOUT_MS="${NAVER_SITE_CHECK_PROXY_TIMEOUT_MS:-15000}"
INDEX_PROXY_ACTIVE_LIMIT="${NAVER_INDEX_PROXY_ACTIVE_LIMIT:-150}"
BLOCK_BACKOFF_MS="${NAVER_INDEX_BLOCK_BACKOFF_MS:-0}"
INDEX_ALERT_ENABLED="${NAVER_INDEX_ALERT_ENABLED:-1}"
BLOCK_MAX_ATTEMPTS="${NAVER_INDEX_BLOCK_MAX_ATTEMPTS:-3}"
NO_RESULT_RETRIES="${NAVER_INDEX_NO_RESULT_RETRIES:-1}"
NO_RESULT_RETRY_DELAY_MS="${NAVER_INDEX_NO_RESULT_RETRY_DELAY_MS:-2500}"
GROUP_MAX_ATTEMPTS="${NAVER_INDEX_GROUP_MAX_ATTEMPTS:-1}"
GROUP_RETRY_COOLDOWN_SECONDS="${NAVER_INDEX_GROUP_RETRY_COOLDOWN_SECONDS:-300}"
SKIP_COMPLETED_GROUPS="${NAVER_INDEX_SKIP_COMPLETED_GROUPS:-1}"
INDEX_PROJECTS="${NAVER_INDEX_PROJECTS:-}"
INDEX_PROJECTS_FALLBACK="${NAVER_INDEX_PROJECTS_FALLBACK:-watermelon dadream gosim bbungbbung rss_test}"
STALE_LOCK_BREAK_ENABLED="${NAVER_INDEX_STALE_LOCK_BREAK_ENABLED:-1}"
STALE_LOCK_MIN_AGE_SECONDS="${NAVER_INDEX_STALE_LOCK_MIN_AGE_SECONDS:-21600}"
STALE_LOCK_TERM_GRACE_SECONDS="${NAVER_INDEX_STALE_LOCK_TERM_GRACE_SECONDS:-10}"
GROUP_TIMEOUT_SECONDS="${NAVER_INDEX_GROUP_TIMEOUT_SECONDS:-7200}"
export TZ="${TZ:-Asia/Seoul}"

mkdir -p "$ROOT_DIR/logs"

log() {
  echo "[$(date -Is)] $*" >> "$LOG_FILE"
}

process_start_epoch() {
  local pid="$1"
  local start_text
  start_text="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" || return 1
  [[ -n "$start_text" ]] || return 1
  date -d "$start_text" +%s 2>/dev/null
}

index_lock_holder_pids() {
  command -v fuser >/dev/null 2>&1 || return 0
  fuser "$INDEX_LOCK_FILE" 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+$/ { print }'
}

kill_stale_process_groups() {
  local signal="$1"
  shift
  local own_pgid
  own_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"

  local pid
  local pgid
  local killed_pgids=""
  for pid in "$@"; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || true
    [[ "$pgid" =~ ^[0-9]+$ ]] || continue
    [[ "$pgid" != "$own_pgid" ]] || continue
    [[ " $killed_pgids " != *" $pgid "* ]] || continue
    log "sending ${signal} to stale naver index check process group pgid=${pgid} holder_pid=${pid}"
    kill "-${signal}" "-${pgid}" 2>/dev/null || true
    killed_pgids="${killed_pgids} ${pgid}"
  done
}

break_stale_index_lock_if_needed() {
  [[ "$STALE_LOCK_BREAK_ENABLED" == "1" ]] || return 0

  if /usr/bin/flock -n "$INDEX_LOCK_FILE" -c true >/dev/null 2>&1; then
    return 0
  fi

  local today_start_epoch
  local now_epoch
  today_start_epoch="$(date -d "$(date +%F) 00:00:00" +%s 2>/dev/null)" || return 0
  now_epoch="$(date +%s)"

  local holder_pids=()
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && holder_pids+=("$pid")
  done < <(index_lock_holder_pids)

  if [[ "${#holder_pids[@]}" -eq 0 ]]; then
    log "index lock is busy, but no holder pids were found; leaving lock untouched"
    return 0
  fi

  local stale_pids=()
  local start_epoch
  local age_seconds
  for pid in "${holder_pids[@]}"; do
    start_epoch="$(process_start_epoch "$pid" || true)"
    [[ "$start_epoch" =~ ^[0-9]+$ ]] || continue
    age_seconds=$((now_epoch - start_epoch))
    if [[ "$start_epoch" -lt "$today_start_epoch" && "$age_seconds" -ge "$STALE_LOCK_MIN_AGE_SECONDS" ]]; then
      stale_pids+=("$pid")
    fi
  done

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    log "index lock is busy, but holders are not stale enough to break: holders=${holder_pids[*]}"
    return 0
  fi

  log "breaking stale naver index lock file=${INDEX_LOCK_FILE} holders=${holder_pids[*]} stale=${stale_pids[*]} min_age_seconds=${STALE_LOCK_MIN_AGE_SECONDS}"
  kill_stale_process_groups TERM "${stale_pids[@]}"
  sleep "$STALE_LOCK_TERM_GRACE_SECONDS"

  local remaining_stale_pids=()
  for pid in "${stale_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      remaining_stale_pids+=("$pid")
    fi
  done

  if [[ "${#remaining_stale_pids[@]}" -gt 0 ]]; then
    log "stale naver index processes survived TERM; sending KILL pids=${remaining_stale_pids[*]}"
    kill_stale_process_groups KILL "${remaining_stale_pids[@]}"
  fi
}

if [[ "${NAVER_INDEX_CHECKS_LOCKED:-0}" != "1" ]]; then
  break_stale_index_lock_if_needed
  exec /usr/bin/flock -n "$INDEX_LOCK_FILE" /usr/bin/env NAVER_INDEX_CHECKS_LOCKED=1 "$0" "$@"
fi

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

run_logged() {
  local label="$1"
  shift
  log "starting ${label}"
  "$@" >> "$LOG_FILE" 2>&1
  local status=$?
  log "finished ${label} status=${status}"
  return "$status"
}

run_sheet_update() {
  local label="$1"
  shift
  run_logged "${label} google sheet update" "$@"
}

index_group_already_complete() {
  local project="$1"
  local run_id="$2"

  if [[ "$SKIP_COMPLETED_GROUPS" != "1" ]]; then
    return 1
  fi

  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    return 1
  fi

  local status
  status="$("$NODE_BIN" --input-type=module - "$run_id" <<'NODE' 2>> "$LOG_FILE"
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { NAVER_INDEX_CLASSIFIER_VERSION } from './scripts/lib/naver-index-url-classifier.mjs';

const projectRoot = process.cwd();
loadLocalEnv(resolve(projectRoot, '.env'));
loadLocalEnv(resolve(projectRoot, '.env.local'));

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;
const runId = process.argv[2] || '';
if (!connectionString || !runId) {
  console.log('run');
  process.exit(0);
}

const client = new pg.Client(createClientConfig(connectionString));
await client.connect();
try {
  const classifierVersion = NAVER_INDEX_CLASSIFIER_VERSION;
  const { rows } = await client.query(
    `select status, target_domain_count, checked_domain_count, error_domain_count
            , source_payload
       from public.naver_index_check_runs
      where run_id = $1`,
    [runId]
  );
  const run = rows[0];
  const complete = run
    && run.status === 'succeeded'
    && Number(run.error_domain_count || 0) === 0
    && Number(run.checked_domain_count || 0) >= Number(run.target_domain_count || 0);
  const currentClassifier = run?.source_payload?.classifierVersion === classifierVersion;
  console.log(complete && currentClassifier ? 'complete' : 'run');
} finally {
  await client.end();
}

function loadLocalEnv(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}

function createClientConfig(value) {
  const url = new URL(value);
  const requiresSsl = url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('ssl');

  return {
    connectionString: url.toString(),
    ssl: requiresSsl ? { rejectUnauthorized: false } : undefined
  };
}
NODE
  )" || return 1

  if [[ "$status" == "complete" ]]; then
    log "skipping ${project} generic index flow run_id=${run_id}: already succeeded with error_domain_count=0"
    return 0
  fi

  return 1
}

run_generic_index_attempt() {
  local project="$1"
  local run_id="$2"
  local attempt="$3"
  local retry_errors="${NAVER_INDEX_RETRY_ERRORS:-0}"
  local -a timeout_prefix=()

  if [[ "$attempt" -gt 1 ]]; then
    retry_errors=1
  fi

  if command -v timeout >/dev/null 2>&1 && [[ "$GROUP_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] && [[ "$GROUP_TIMEOUT_SECONDS" -gt 0 ]]; then
    timeout_prefix=(/usr/bin/timeout --preserve-status "$GROUP_TIMEOUT_SECONDS")
  fi

  run_logged "${project} generic naver index check run_id=${run_id} attempt=${attempt}/${GROUP_MAX_ATTEMPTS} retry_errors=${retry_errors}" \
    "${timeout_prefix[@]}" /usr/bin/flock -w "$CRAWL_LOCK_WAIT_SECONDS" "$CRAWL_LOCK_FILE" /usr/bin/env \
      NAVER_INDEX_GROUP_KEY="$project" \
      NAVER_INDEX_CHECK_RUN_ID="$run_id" \
      NAVER_INDEX_CHECK_TRIGGER=cron \
      NAVER_INDEX_PROXY_ENABLED="$INDEX_PROXY_ENABLED" \
      NAVER_SITE_CHECK_PROXY_ENABLED="$INDEX_PROXY_ENABLED" \
      NAVER_INDEX_PROXY_FILE="$INDEX_PROXY_FILE" \
      NAVER_SITE_CHECK_PROXY_FILE="$INDEX_PROXY_FILE" \
      NAVER_INDEX_PROXY_TIMEOUT_MS="$INDEX_PROXY_TIMEOUT_MS" \
      NAVER_SITE_CHECK_PROXY_TIMEOUT_MS="$INDEX_PROXY_TIMEOUT_MS" \
      NAVER_INDEX_PROXY_ACTIVE_LIMIT="$INDEX_PROXY_ACTIVE_LIMIT" \
      NAVER_SITE_CHECK_PROXY_ACTIVE_LIMIT="$INDEX_PROXY_ACTIVE_LIMIT" \
      NAVER_INDEX_CHECK_CONCURRENCY="$INDEX_CHECK_CONCURRENCY" \
      NAVER_SITE_CHECK_CONCURRENCY="$INDEX_CHECK_CONCURRENCY" \
      NAVER_INDEX_REQUEST_DELAY_MS="$REQUEST_DELAY_MS" \
      NAVER_INDEX_HOST_DELAY_MS="$HOST_DELAY_MS" \
      NAVER_INDEX_DELAY_JITTER_MS="$DELAY_JITTER_MS" \
      NAVER_INDEX_BLOCK_MAX_ATTEMPTS="$BLOCK_MAX_ATTEMPTS" \
      NAVER_INDEX_BLOCK_BACKOFF_MS="$BLOCK_BACKOFF_MS" \
      NAVER_INDEX_NO_RESULT_RETRIES="$NO_RESULT_RETRIES" \
      NAVER_INDEX_NO_RESULT_RETRY_DELAY_MS="$NO_RESULT_RETRY_DELAY_MS" \
      NAVER_INDEX_CHECK_RESUME=1 \
      NAVER_INDEX_RETRY_ERRORS="$retry_errors" \
      "$NODE_BIN" scripts/check-naver-indexed-posts.mjs
}

run_generic_index_group() {
  local project="$1"
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    log "failed ${project} naver index check: node not found"
    return 127
  fi

  local run_id
  run_id="$(project_run_id "$project")"
  local check_status=0
  local sheet_status=0
  local attempt=1

  if index_group_already_complete "$project" "$run_id"; then
    return 0
  fi

  while [[ "$attempt" -le "$GROUP_MAX_ATTEMPTS" ]]; do
    if [[ "$attempt" -gt 1 ]]; then
      log "${project} generic index check retry cooldown ${GROUP_RETRY_COOLDOWN_SECONDS}s before attempt ${attempt}/${GROUP_MAX_ATTEMPTS}"
      sleep "$GROUP_RETRY_COOLDOWN_SECONDS"
    fi

    run_generic_index_attempt "$project" "$run_id" "$attempt"
    check_status=$?

    if [[ "$check_status" -eq 0 ]]; then
      break
    fi

    log "${project} generic index check attempt ${attempt}/${GROUP_MAX_ATTEMPTS} failed status=${check_status}"
    attempt=$((attempt + 1))
  done

  if [[ "$check_status" -ne 0 ]]; then
    log "${project} generic index check failed after ${GROUP_MAX_ATTEMPTS} attempt(s) status=${check_status}; updating google sheet with successful partial results and previous fallback values"
    run_sheet_update "${project} generic partial sheet update after failed run_id=${run_id}" /usr/bin/env \
      NAVER_INDEX_GROUP_KEY="$project" \
      NAVER_INDEX_CHECK_RUN_ID="$run_id" \
      NAVER_INDEX_GOOGLE_SHEET_ALLOW_PARTIAL=1 \
      NAVER_INDEX_GOOGLE_SHEET_SKIP_IF_UNCONFIGURED=1 \
      NAVER_INDEX_GOOGLE_SHEET_UPDATE_CRAWL=0 \
      "$NODE_BIN" scripts/update-naver-index-google-sheet.mjs || \
      log "${project} generic crawl refresh sheet update failed after index check failure"
    return "$check_status"
  fi

  run_sheet_update "${project} generic run_id=${run_id}" /usr/bin/env \
    NAVER_INDEX_GROUP_KEY="$project" \
    NAVER_INDEX_CHECK_RUN_ID="$run_id" \
    NAVER_INDEX_GOOGLE_SHEET_SKIP_IF_UNCONFIGURED=1 \
    NAVER_INDEX_GOOGLE_SHEET_UPDATE_CRAWL=0 \
    "$NODE_BIN" scripts/update-naver-index-google-sheet.mjs
  sheet_status=$?

  return "$sheet_status"
}

project_run_id() {
  local project="$1"
  local day
  day="$(date +%Y%m%d)"

  case "$project" in
    watermelon) echo "watermelon-site-index-${day}-0900proxy" ;;
    dadream) echo "dadream-site-index-${day}-0900proxy" ;;
    gosim) echo "gosim-site-index-${day}-0900proxy" ;;
    rss_test) echo "rss-test-site-index-${day}-0900proxy" ;;
    deodream) echo "deodream-site-index-${day}-0900proxy" ;;
    bbungbbung) echo "bbungbbung-site-index-${day}-0900proxy" ;;
    *) echo "${project}-site-index-${day}-0900proxy" ;;
  esac
}

list_index_projects() {
  if [[ -n "$INDEX_PROJECTS" ]]; then
    printf '%s\n' "$INDEX_PROJECTS"
    return 0
  fi

  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    log "falling back to static index project list because node not found"
    printf '%s\n' "$INDEX_PROJECTS_FALLBACK"
    return 0
  fi

  local projects
  if projects="$("$NODE_BIN" scripts/list-naver-index-check-runners.mjs 2>> "$LOG_FILE")" && [[ -n "$projects" ]]; then
    printf '%s\n' "$projects"
    return 0
  fi

  log "falling back to static index project list because DB active runner list is empty or unavailable"
  printf '%s\n' "$INDEX_PROJECTS_FALLBACK"
}

send_index_alert() {
  local project="$1"
  local status="$2"
  local stage="${3:-index-flow}"
  local run_id
  run_id="$(project_run_id "$project")"

  if [[ "$INDEX_ALERT_ENABLED" == "0" ]]; then
    log "skipping ${project} failure alert because NAVER_INDEX_ALERT_ENABLED=0"
    return 0
  fi

  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    log "skipping ${project} failure alert because node not found"
    return 0
  fi

  "$NODE_BIN" scripts/naver-index-check-alert.mjs \
    --project "$project" \
    --run-id "$run_id" \
    --status "$status" \
    --stage "$stage" \
    --log "$LOG_FILE" \
    --message "test02 Naver index check failed; crawl status sheet refresh was attempted from the latest successful index run." >> "$LOG_FILE" 2>&1 || true
}

main() {
  cd "$ROOT_DIR" || exit 1

  log "starting unified naver index checks request_delay_ms=${REQUEST_DELAY_MS} host_delay_ms=${HOST_DELAY_MS} delay_jitter_ms=${DELAY_JITTER_MS} concurrency=${INDEX_CHECK_CONCURRENCY} proxy_enabled=${INDEX_PROXY_ENABLED} proxy_active_limit=${INDEX_PROXY_ACTIVE_LIMIT} proxy_file=${INDEX_PROXY_FILE} skip_completed_groups=${SKIP_COMPLETED_GROUPS}"

  local final_status=0
  local projects
  projects="$(list_index_projects)"
  log "active index runners: ${projects//$'\n'/ }"

  for project in $projects; do
    run_generic_index_group "$project"
    local status=$?
    if [[ "$status" -ne 0 ]]; then
      log "${project} index flow failed status=${status}; continuing to next project"
      send_index_alert "$project" "$status" "index-flow"
      final_status=1
    fi
  done

  log "finished unified naver index checks status=${final_status}"
  exit "$final_status"
}

main "$@"
