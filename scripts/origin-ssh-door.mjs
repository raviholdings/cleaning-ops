#!/usr/bin/env node
/**
 * 오리진 SSH "문"(보안그룹 22/tcp 규칙) 수동 조작.
 *
 *   node scripts/origin-ssh-door.mjs --status   # 지금 열린 규칙 목록
 *   node scripts/origin-ssh-door.mjs --open     # 내 현재 IP 로 연다 (+접속 명령 출력)
 *   node scripts/origin-ssh-door.mjs --close    # 22 규칙 전부 닫는다
 *
 * 배포 스크립트는 자동으로 열고 닫는다 — 이건 배포가 죽어서 규칙이 남았거나,
 * 배포 없이 큰 파일을 빠르게 옮기고 싶을 때 쓰는 수동 도구.
 */

import { closeSshDoor, getMyPublicIp, getOriginPublicIp, listSshDoor, openSshDoor } from './lib/origin-ssh.mjs';

const args = new Set(process.argv.slice(2));

if (args.has('--open')) {
  const myIp = await getMyPublicIp();
  const originIp = getOriginPublicIp();
  const state = openSshDoor(myIp);
  console.log(`문 ${state === 'already-open' ? '이미 열려 있음' : '열림'}: ${myIp}/32 -> 22/tcp`);
  console.log(`접속: ssh -i /c/Users/LD/Desktop/ravi/_secure/cleaning-ravi-20260731.pem ec2-user@${originIp}`);
  console.log('다 쓰면: node scripts/origin-ssh-door.mjs --close');
} else if (args.has('--close')) {
  const closedCidrs = closeSshDoor();
  console.log(closedCidrs.length ? `닫음: ${closedCidrs.join(', ')}` : '이미 닫혀 있음 (22 규칙 없음)');
} else {
  const open = listSshDoor();
  console.log(open.length ? `열린 22 규칙: ${open.join(', ')}` : '닫혀 있음 (22 규칙 없음)');
}
