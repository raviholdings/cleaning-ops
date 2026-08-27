#!/usr/bin/env node
/**
 * 루트 색인 모니터 기록을 읽는다 (읽기 전용, 네트워크 안 씀).
 *
 * check-naver-root-index-daily.mjs 가 30분/15분마다 append 한 jsonl 은
 * 하루 800줄이 넘어 눈으로 못 읽는다. 격자 + 변화 지점으로 압축한다.
 *
 *   node scripts/show-root-index-history.mjs              # 최근 24시간
 *   node scripts/show-root-index-history.mjs --hours 12
 *   node scripts/show-root-index-history.mjs --changes    # 변화 지점만
 *
 * 셀 표기: 숫자=웹문서 건수 · `.`=0건 · `?`=대조군 실패(판정 불가) · `X`=차단 · `E`=에러
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const argValue = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : (argv[i + 1] ?? d); };
const hours = Number(argValue('--hours', 24));
const changesOnly = argv.includes('--changes');
const path = resolve(process.cwd(), argValue('--in', 'reports/naver-root-index/root-index-daily.jsonl'));

if (!existsSync(path)) { console.error(`기록이 없다: ${path}`); process.exit(1); }

const since = Date.now() - hours * 3600_000;
const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean)
	.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
	.filter((r) => new Date(r.checked_at).getTime() >= since);

if (!rows.length) { console.log(`최근 ${hours}시간 기록이 없다.`); process.exit(0); }

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
const roots = [...new Set(rows.map((r) => r.root))].sort();
const rounds = [...new Set(rows.map((r) => r.checked_at))].sort();
const at = new Map(rows.map((r) => [`${r.checked_at}|${r.root}`, r]));

const cell = (r) => {
	if (!r) return '-';
	if (r.status === 'blocked') return 'X';
	if (r.status === 'unverifiable') return '?';
	if (r.status === 'error') return 'E';
	return r.webItemCount > 0 ? String(r.webItemCount) : '.';
};
const label = (root) => root.replace(/\.com$/, '').slice(0, 4);

if (!changesOnly) {
	console.log(`=== 최근 ${hours}시간 · ${rounds.length}회차 (KST) ===`);
	console.log('  시각   ' + roots.map((r) => label(r).padStart(5)).join('') + '   대조군');
	for (const round of rounds) {
		const any = at.get(`${round}|${roots[0]}`);
		// 대조군은 2026-08-25 저녁에 앞뒤 2회 -> 뒤 1회로 줄였다. 옛 회차도 읽히게 둘 다 받는다.
		const ctl = any?.control_ok === undefined ? '?'
			: !any.control_ok ? '실패'
			: String(any.control_count ?? `${any.control_before}/${any.control_after}`);
		console.log(
			'  ' + kst(round).slice(5, 16).replace('T', ' ')
			+ roots.map((r) => cell(at.get(`${round}|${r}`)).padStart(5)).join('')
			+ '   ' + ctl
		);
	}
	console.log('');
}

console.log('=== 변화 지점 ===');
let found = 0;
for (const root of roots) {
	let prev = null;
	for (const round of rounds) {
		const r = at.get(`${round}|${root}`);
		if (!r || r.status === 'unverifiable' || r.status === 'blocked' || r.status === 'error') continue;
		const now = r.webItemCount > 0;
		if (prev !== null && prev !== now) {
			console.log(`  ${kst(round).slice(5, 16).replace('T', ' ')}  ${root.padEnd(20)} ${now ? `색인 등장 (${r.webItemCount}건)` : '색인 사라짐'}`);
			found += 1;
		}
		prev = now;
	}
}
if (!found) console.log('  변화 없음 — 이 구간 내내 상태가 같았다.');

const live = roots.filter((r) => { const last = at.get(`${rounds[rounds.length - 1]}|${r}`); return last?.webItemCount > 0; });
console.log(`\n마지막 회차(${kst(rounds[rounds.length - 1]).slice(5, 16).replace('T', ' ')}) 기준 색인 살아있는 루트: ${live.length}/${roots.length}${live.length ? ` — ${live.join(', ')}` : ''}`);
const bad = rows.filter((r) => r.control_ok === false);
if (bad.length) console.log(`⚠ 대조군 실패 회차 ${new Set(bad.map((r) => r.checked_at)).size}개 — 위 표에서 ? 로 표시했다`);
