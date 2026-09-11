#!/usr/bin/env node
/**
 * 오리진에 브랜드 트래픽 스냅샷 cron 을 설치한다.
 *
 *   node scripts/install-brand-traffic-snapshot.mjs             # 설치될 내용만 출력
 *   node scripts/install-brand-traffic-snapshot.mjs --apply     # 실제 설치
 *   node scripts/install-brand-traffic-snapshot.mjs --status    # 설치 상태·최근 스냅샷
 *   node scripts/install-brand-traffic-snapshot.mjs --remove    # 제거
 *
 * 왜 오리진에 두나
 *   로그가 거기 있고 서버는 항상 켜져 있다. 이 PC 의 작업 스케줄러에 걸면 PC 가
 *   꺼진 동안 구멍이 난다. 게다가 nginx 로그는 10일치만 남아서, 그 안에 스냅샷을
 *   떠 두지 않으면 지난 데이터를 되살릴 방법이 없다.
 *
 * 무엇을 남기나 (6시간마다)
 *   /var/log/brand-traffic/YYYY-MM-DD_HH.txt   그 시점까지의 당일 누계
 *   하루 4개. 그날 마지막 것이 그 날의 최종치다 (logrotate 가 자정에 돈다).
 *
 * ⚠⚠ 오리진은 t3.small(2GB, 스왑 없음). sort 를 쓰지 않는다 — 2026-08-27 에
 *    로그 집계가 nginx 를 OOM 으로 죽였다. awk 연관배열 한 패스로 끝내고
 *    nice -n 19 로 돌린다.
 *
 * ⚠ 서버 설정 변경이다. --apply 는 운영자 확인을 받고 실행할 것.
 *
 * ⚠ cron 이 아니라 systemd timer 를 쓴다. 오리진은 Amazon Linux 2023 인데
 *   cronie 가 안 깔려 있다 — /etc/cron.d 도 crontab 명령도 없고 crond 는 inactive다
 *   (2026-09-10 확인). systemd 252 는 있다.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';
import { loadLocalEnv } from './lib/local-env.mjs';
import { buildBrandTrafficAwk } from './lib/brand-traffic-awk.mjs';

loadLocalEnv();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag, fb = '') => { const i = args.indexOf(flag); return i === -1 ? fb : (args[i + 1] ?? fb); };
const apply = args.includes('--apply');
const status = args.includes('--status');
const remove = args.includes('--remove');
const mode = args.includes('--ssm') ? 'ssm' : 'direct';
const hosts = valueOf('--hosts', 'ssac3.kr,dosadosa.kr').split(',').map((s) => s.trim()).filter(Boolean);

const OUT_DIR = '/var/log/brand-traffic';
const SCRIPT_PATH = '/usr/local/bin/brand-traffic-snapshot.sh';
const UNIT = 'brand-traffic-snapshot';
const SERVICE_PATH = `/etc/systemd/system/${UNIT}.service`;
const TIMER_PATH = `/etc/systemd/system/${UNIT}.timer`;
const KEEP_DAYS = 120; // 스냅샷은 작아서 넉넉히 둔다

const BSLASH = String.fromCharCode(92);
const q = (v) => `'${String(v).split("'").join(`'${BSLASH}''`)}'`;
const toPosix = (p) => p.split(BSLASH).join('/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

const hostGrep = hosts.map((h) => h.replace(/\./g, '\\.')).join('|');
const awkProg = buildBrandTrafficAwk(hosts, 25);

/* 오리진에 놓을 셸 스크립트. awk 프로그램은 파일로 따로 둔다 — 인용이 안 깨진다. */
const AWK_PATH = '/usr/local/lib/brand-traffic.awk';
const snapshotSh = `#!/bin/sh
# 브랜드 트래픽 스냅샷. systemd timer 가 6시간마다 부른다.
# 설치: scripts/install-brand-traffic-snapshot.mjs (레포)
# 로그가 10일치만 남으므로 여기 남긴 스냅샷이 유일한 장기 기록이다.
#
# ⚠ access.log 만 보면 안 된다. logrotate 가 자정에 돌아서, 00:05 회차는 그 날
#   5분치밖에 없고 전날은 통째로 빠진다. 가장 최근 회전분을 같이 읽어야 전날이
#   완전한 하루로 남는다 (회전 직후분은 delaycompress 라 .gz 가 아니다 — zcat -f).
set -e
OUT=${OUT_DIR}
mkdir -p "$OUT"
STAMP=$(date +%Y-%m-%d_%H)
LOGS="/var/log/nginx/access.log $(ls -1t /var/log/nginx/access.log-* 2>/dev/null | head -1)"
{
  echo "# snapshot $(date -Is)"
  echo "# hosts: ${hosts.join(', ')}"
  echo "# source: $LOGS"
  echo
  nice -n 19 zcat -f $LOGS 2>/dev/null \\
    | nice -n 19 grep -E '${hostGrep}' \\
    | nice -n 19 awk -f ${AWK_PATH}
} > "$OUT/$STAMP.txt" 2>&1
# 오래된 것 정리
find "$OUT" -name '*.txt' -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
`;

const serviceFile = `[Unit]
Description=브랜드 트래픽 스냅샷 (ssac3.kr / dosadosa.kr)
Documentation=https://github.com/raviholdings/cleaning-ops scripts/install-brand-traffic-snapshot.mjs

[Service]
Type=oneshot
ExecStart=${SCRIPT_PATH}
# nginx 와 경쟁하지 않게 최저 우선순위로 돈다. 오리진은 t3.small 이다.
Nice=19
IOSchedulingClass=idle
`;

const timerFile = `[Unit]
Description=브랜드 트래픽 스냅샷 6시간마다

[Timer]
OnCalendar=*-*-* 00,06,12,18:05:00
# 서버가 꺼져 있어 놓친 회차는 부팅 후 한 번 따라잡는다.
Persistent=true
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
`;

if (!apply && !status && !remove) {
  console.log('=== 설치될 내용 (아직 아무것도 하지 않음) ===\n');
  console.log(`■ ${SCRIPT_PATH}`);
  console.log(snapshotSh.split('\n').map((l) => `   ${l}`).join('\n'));
  console.log(`■ ${SERVICE_PATH}`);
  console.log(serviceFile.split('\n').map((l) => `   ${l}`).join('\n'));
  console.log(`■ ${TIMER_PATH}`);
  console.log(timerFile.split('\n').map((l) => `   ${l}`).join('\n'));
  console.log(`■ ${AWK_PATH}   (집계 프로그램 ${awkProg.split('\n').length}줄)`);
  console.log(`■ ${OUT_DIR}/   스냅샷 보관 (하루 4개 · ${KEEP_DAYS}일 유지)`);
  console.log('\n실제로 설치하려면 --apply');
  process.exit(0);
}

const ssh = await prepareOriginSsh({ mode });
process.on('exit', ssh.cleanup);
process.on('SIGINT', () => { ssh.cleanup(); process.exit(130); });

/** 원격 스크립트는 stdin 으로 흘린다 — 인자로 넘기면 중첩 인용이 깨진다. */
const runRemote = (script) => {
  const p = resolve(projectRoot, 'tmp/.brand-traffic-remote.sh');
  writeFileSync(p, script, 'utf8');
  return execSync(`cat ${q(toPosix(p))} | ${ssh.sshCommand} ${q('sudo bash -s')}`,
    { shell: 'bash', encoding: 'utf8' });
};

try {
  if (status) {
    console.log(runRemote([
      'set +e',
      `echo "== 타이머 =="; systemctl list-timers ${UNIT}.timer --no-pager 2>/dev/null | head -4`,
      `echo; echo "== 마지막 실행 =="; systemctl status ${UNIT}.service --no-pager 2>/dev/null | head -8`,
      `echo; echo "== 스크립트 =="; ls -la ${SCRIPT_PATH} ${AWK_PATH} 2>/dev/null || echo "  (없음)"`,
      `echo; echo "== 스냅샷 (최근 8개) =="; ls -1t ${OUT_DIR}/*.txt 2>/dev/null | head -8 || echo "  (아직 없음)"`,
      `echo; printf "== 총 개수: "; ls -1 ${OUT_DIR}/*.txt 2>/dev/null | wc -l`,
    ].join('\n')).trimEnd());
    process.exit(0);
  }
  if (remove) {
    runRemote([
      'set +e',
      `systemctl disable --now ${UNIT}.timer 2>/dev/null`,
      `rm -f ${TIMER_PATH} ${SERVICE_PATH} ${SCRIPT_PATH} ${AWK_PATH}`,
      'systemctl daemon-reload',
      `echo "제거 완료 (스냅샷 ${OUT_DIR} 는 남겨둠)"`,
    ].join('\n'));
    console.log(`제거했습니다. 남은 스냅샷은 ${OUT_DIR} 에 그대로 있습니다.`);
    process.exit(0);
  }

  // --apply: awk 프로그램 -> 셸 -> cron 순으로 놓고, 즉시 한 번 돌려본다.
  const install = [
    'set -e',
    `mkdir -p ${OUT_DIR} /usr/local/lib`,
    `cat > ${AWK_PATH} <<'AWKEOF'`,
    awkProg,
    'AWKEOF',
    `cat > ${SCRIPT_PATH} <<'SHEOF'`,
    snapshotSh,
    'SHEOF',
    `chmod 755 ${SCRIPT_PATH}`,
    `cat > ${SERVICE_PATH} <<'SVCEOF'`,
    serviceFile,
    'SVCEOF',
    `cat > ${TIMER_PATH} <<'TMREOF'`,
    timerFile,
    'TMREOF',
    `chmod 644 ${SERVICE_PATH} ${TIMER_PATH}`,
    'systemctl daemon-reload',
    `systemctl enable --now ${UNIT}.timer`,
    'echo "-- 설치 완료, 즉시 1회 실행 --"',
    `systemctl start ${UNIT}.service`,
    `systemctl is-active ${UNIT}.timer | sed "s/^/  타이머: /"`,
    `systemctl show ${UNIT}.service -p Result --value | sed "s/^/  실행 결과: /"`,
    `ls -la ${OUT_DIR}/ | tail -3`,
    'echo "-- 방금 만든 스냅샷 앞부분 --"',
    `head -16 "$(ls -1t ${OUT_DIR}/*.txt | head -1)"`,
    'echo; echo "-- 다음 실행 예정 --"',
    `systemctl list-timers ${UNIT}.timer --no-pager | head -3`,
  ].join('\n');
  console.log(runRemote(install).trimEnd());
  console.log(`상태 확인: node scripts/install-brand-traffic-snapshot.mjs --status`);
} finally {
  ssh.cleanup();
}
