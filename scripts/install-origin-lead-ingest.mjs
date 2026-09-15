#!/usr/bin/env node
/**
 * 오리진에 lead 비콘 수집 타이머를 설치한다 — 5분마다 lead.log → lead_submissions.
 *
 *   node scripts/install-origin-lead-ingest.mjs            # 설치·갱신
 *   node scripts/install-origin-lead-ingest.mjs --status   # 타이머 상태만
 *
 * 왜: 원래 수집은 이 PC 가 하루 한 번 SSH 로 가져오는 방식이라 (run-lead-ingest-task.cmd)
 * 전화 클릭이 DB 에 보이기까지 최대 하루가 걸리고, HaiIP 가 켜져 있으면 그 회차는
 * SSH 가 안 붙어 실패한다. 오리진 안에서 돌리면 둘 다 없다 (운영자 지시 2026-09-15).
 *
 * 무엇을 올리나 (/srv/lead-ingest)
 *   scripts/ingest-lead-beacon.mjs   이 저장소 것 그대로. --log /var/log/nginx/lead.log 로
 *                                    로컬 파일을 읽는다 (회전분은 PC 쪽 일일 작업이 맡는다)
 *   .env                             DATABASE_URL 한 줄. root 만 읽게 600
 *   node_modules/pg                  npm i pg
 *   systemd  lead-ingest.service + lead-ingest.timer (OnUnitActiveSec=5min)
 *
 * ⚠ t3.small — 스크립트는 로그 몇 줄을 읽어 insert 만 한다. sort 없음. 부담 없다.
 * ⚠ 배포와 같이 돌리지 말 것 — 둘 다 직결 SSH 라 보안그룹 정리가 서로를 끊는다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './lib/local-env.mjs';
import { prepareOriginSsh } from './lib/origin-ssh.mjs';

loadLocalEnv();
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statusOnly = process.argv.includes('--status');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL 이 .env 에 없습니다');

function shq(v) {
  const BS = String.fromCharCode(92);
  return `'${String(v).split("'").join(`'${BS}''`)}'`;
}

const SERVICE = `[Unit]
Description=lead beacon log -> DB (5min)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/lead-ingest
ExecStart=/usr/bin/env node /srv/lead-ingest/scripts/ingest-lead-beacon.mjs --log /var/log/nginx/lead.log
Nice=19
`;
const TIMER = `[Unit]
Description=run lead-ingest every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
`;

const origin = await prepareOriginSsh({ mode: 'direct' });
const ssh = (cmd) => execFileSync('bash', ['-c', `${origin.sshCommand} ${shq(cmd)}`], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
const pipe = (input, cmd) => execFileSync('bash', ['-c', `${origin.sshCommand} ${shq(cmd)}`], {
  input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});

try {
  if (statusOnly) {
    console.log(ssh('systemctl status lead-ingest.timer --no-pager 2>&1 | head -6; echo; sudo journalctl -u lead-ingest.service -n 12 --no-pager 2>&1 | tail -12'));
  } else {
    console.log('1. node 확인');
    console.log('   ' + ssh('node -v 2>/dev/null || echo "node 없음"').trim());
    console.log('2. 파일 올리기');
    ssh('sudo mkdir -p /srv/lead-ingest/scripts && sudo chown -R ec2-user /srv/lead-ingest');
    pipe(readFileSync(join(projectRoot, 'scripts/ingest-lead-beacon.mjs'), 'utf8'),
      'cat > /srv/lead-ingest/scripts/ingest-lead-beacon.mjs');
    pipe(`DATABASE_URL=${dbUrl}\n`, 'umask 077 && cat > /srv/lead-ingest/.env');
    console.log('3. pg 설치 (없을 때만)');
    console.log('   ' + ssh('cd /srv/lead-ingest && ([ -d node_modules/pg ] && echo "pg 있음" || (npm init -y >/dev/null 2>&1; npm i pg --silent 2>&1 | tail -1; echo "pg 설치"))').trim());
    console.log('4. systemd 등록');
    pipe(SERVICE, 'sudo tee /etc/systemd/system/lead-ingest.service >/dev/null');
    pipe(TIMER, 'sudo tee /etc/systemd/system/lead-ingest.timer >/dev/null');
    ssh('sudo chown -R root:root /srv/lead-ingest && sudo chmod 600 /srv/lead-ingest/.env && sudo systemctl daemon-reload && sudo systemctl enable --now lead-ingest.timer');
    console.log('5. 한 번 즉시 실행');
    console.log(ssh('sudo systemctl start lead-ingest.service; sudo journalctl -u lead-ingest.service -n 8 --no-pager 2>&1 | tail -8'));
    console.log(ssh('systemctl list-timers lead-ingest.timer --no-pager 2>&1 | head -3'));
  }
} finally {
  if (typeof origin.cleanup === 'function') origin.cleanup();
}
