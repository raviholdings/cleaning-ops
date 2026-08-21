/**
 * 오리진 EC2 SSH 연결 준비 — 직결(기본)과 SSM 터널(폴백).
 *
 * 직결 모드 (2026-08-22 운영자 확정, 기본값):
 *   1. 내 공인 IP 조회 (checkip.amazonaws.com)
 *   2. 보안그룹에 22/tcp 를 그 IP /32 로만 잠깐 연다
 *   3. 서버 공인 IP 로 바로 ssh — SSM 터널(실측 6.4Mbps)을 안 타서
 *      전량 배포 전송이 87분 → 회선 속도(수 분)로 줄어든다
 *   4. cleanup() 이 규칙을 닫는다 (배포 스크립트의 exit/signal 훅에서 호출)
 *
 * 주의
 *   - 배포 중 HaiIP 로 IP 를 바꾸면 연결이 끊긴다 (SSM 도 마찬가지).
 *     배포 도는 동안은 이 PC 에서 수집요청을 돌리지 말 것.
 *   - cleanup 은 SG 의 22 규칙을 전부 지운다. 배포가 죽어 규칙이 남았어도
 *     다음 실행의 cleanup 이 수렴시킨다. 수동 조작: scripts/origin-ssh-door.mjs
 *   - SSM 폴백: prepareOriginSsh({ mode: 'ssm' }) — 배포 스크립트 --ssm 플래그.
 */

import { execFileSync } from 'node:child_process';

const DEFAULTS = {
  instance: process.env.ORIGIN_SSM_INSTANCE_ID || 'i-039361b55ae33808b',
  sgId: process.env.ORIGIN_SG_ID || 'sg-0c97415cf43611194',
  sshKey: process.env.ORIGIN_SSH_KEY || '/c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem',
  profile: process.env.AWS_PROFILE || 'cleaning-ops',
  region: process.env.AWS_DEFAULT_REGION || 'ap-northeast-2',
};

function aws(args, cfg) {
  return execFileSync('aws', [...args, '--region', cfg.region, '--profile', cfg.profile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function getMyPublicIp() {
  const response = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(15000) });
  const ip = (await response.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`공인 IP 조회 실패: "${ip}"`);
  return ip;
}

export function getOriginPublicIp(cfg = DEFAULTS) {
  const ip = aws(['ec2', 'describe-instances', '--instance-ids', cfg.instance,
    '--query', 'Reservations[0].Instances[0].PublicIpAddress', '--output', 'text'], cfg);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`오리진 공인 IP 조회 실패: "${ip}"`);
  return ip;
}

export function openSshDoor(myIp, cfg = DEFAULTS) {
  try {
    aws(['ec2', 'authorize-security-group-ingress', '--group-id', cfg.sgId,
      '--protocol', 'tcp', '--port', '22', '--cidr', `${myIp}/32`], cfg);
    return 'opened';
  } catch (error) {
    const message = String(error?.stderr || error?.message || error);
    if (message.includes('InvalidPermission.Duplicate')) return 'already-open';
    throw new Error(`SG 22 규칙 추가 실패: ${message.slice(0, 300)}`);
  }
}

/** SG 의 22/tcp 인바운드 규칙을 전부 지운다. 닫을 게 없으면 0. */
export function closeSshDoor(cfg = DEFAULTS) {
  const raw = aws(['ec2', 'describe-security-groups', '--group-ids', cfg.sgId,
    '--query', 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp', '--output', 'json'], cfg);
  const cidrs = JSON.parse(raw || '[]');
  for (const cidr of cidrs) {
    aws(['ec2', 'revoke-security-group-ingress', '--group-id', cfg.sgId,
      '--protocol', 'tcp', '--port', '22', '--cidr', cidr], cfg);
  }
  return cidrs;
}

export function listSshDoor(cfg = DEFAULTS) {
  const raw = aws(['ec2', 'describe-security-groups', '--group-ids', cfg.sgId,
    '--query', 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp', '--output', 'json'], cfg);
  return JSON.parse(raw || '[]');
}

/**
 * 배포 스크립트용 진입점. sshCommand 는 셸 문자열(기존 sshBase 자리에 그대로).
 * 반환한 cleanup 을 exit/signal 훅에 반드시 걸 것 — 직결 모드에서 문을 닫는다.
 */
export async function prepareOriginSsh({ mode = 'direct', config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const commonArgs = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-i', cfg.sshKey,
    '-o', 'ServerAliveInterval=30',
  ];

  if (mode === 'ssm') {
    const args = [...commonArgs,
      '-o', `ProxyCommand=aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region ${cfg.region} --profile ${cfg.profile}`,
      `ec2-user@${cfg.instance}`];
    return { mode, sshCommand: args.map(shellQuote).join(' '), myIp: null, originIp: null, doorState: null, cleanup: () => {} };
  }

  const myIp = await getMyPublicIp();
  const originIp = getOriginPublicIp(cfg);
  const doorState = openSshDoor(myIp, cfg);
  const args = [...commonArgs, `ec2-user@${originIp}`];

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      closeSshDoor(cfg);
    } catch (error) {
      console.warn(`[origin-ssh] SG 22 규칙 닫기 실패 — scripts/origin-ssh-door.mjs --close 로 직접 닫을 것: ${error?.message || error}`);
    }
  };

  return { mode, sshCommand: args.map(shellQuote).join(' '), myIp, originIp, doorState, cleanup };
}
