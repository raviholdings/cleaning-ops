/**
 * 루트 도메인 색인 모니터 (초경량)
 *
 * 왜 있는가: 2026-08-22 네이버가 루트 단위로 site: 노출을 통째로 걷어냈다.
 * 그때 "당한 건지 원래 그랬는지"를 가릴 과거 스냅샷이 색인 조사 리포트뿐이었다.
 * 루트 10개만 계속 찍어두면 다음엔 판별이 필요 없다 — 기록이 답이 된다.
 *
 * 밤(22:00~09:00) 15분 · 낮(09:00~22:00) 30분 간격으로 돈다
 * (작업 스케줄러 ravi-root-index-monitor, 트리거 2개). 하루 1회로는 부족한데,
 * 색인이 4시간짜리로 붙었다 떨어졌다 하기 때문이다
 * (2026-08-25 naoheg 16:42 20건 → 21:06 0건).
 * 밤을 조인 이유는 아침에 밤사이 기록을 보기 때문이다.
 *
 * 회차당 11쿼리(루트 10 + 대조군 1) · 하루 770쿼리(밤 44회 + 낮 26회).
 * 차단 한계 1,400~1,900/일 의 41~55%. 이 예산은 색인 조사 배치
 * (check-naver-indexed-posts.mjs)와 같은 IP 를 쓰니, 그 배치를 같이 돌릴 거면
 * 간격을 30분으로 되돌릴 것. 안 그러면 둘 다 차단당한다.
 *
 *   node scripts/check-naver-root-index-daily.mjs [--roots a.com,b.com] [--delay-ms 7000] [--dry-run]
 *
 * 결과는 reports/naver-root-index/root-index-daily.jsonl 에 한 줄씩 append.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const projectRoot = process.cwd();
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : (argv[i + 1] ?? fallback);
};
const dryRun = argv.includes('--dry-run');
const delayMs = Number(argValue('--delay-ms', 7000));
const outPath = resolve(projectRoot, argValue('--out', 'reports/naver-root-index/root-index-daily.jsonl'));

const USER_AGENT = process.env.NAVER_SITE_CHECK_USER_AGENT
	|| 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 대조군 — 절대 색인이 빠질 리 없는 사이트 하나.
 *
 * 막는 건 세 가지고, 셋 다 "10개 루트 전멸" 로 똑같이 보인다.
 *   1. 파서 고장 — 네이버가 마크업을 바꾸면 templateId":"webItem 이 사라져 영구히 0
 *   2. 내 IP 의 site: 조회 차단
 *   3. HaiIP · 프록시가 엉뚱한 페이지를 돌려주는 경우
 * 대조군이 20건인데 내 도메인만 0이면 진짜 색인 소실, 대조군도 0이면 위 셋 중 하나다.
 *
 * 루트 뒤에 한 번만 던진다. 셋 다 회차 내내 지속되는 상태라 1회로 잡힌다
 * (앞뒤 2회는 "회차 도중 막히기 시작한 경우" 만 더 잡는데 예산의 8% 를 더 쓴다).
 *
 * wikipedia.org 를 쓰는 이유: 우리 도메인과 같은 외부 사이트다.
 * blog.naver.com 은 네이버 자사라 외부 도메인이 통째로 빠지는 상황을 못 잡는다.
 * naver.com 은 쓰지 말 것 — 자사 도메인이라 site: 가 403 으로 막혀 있다.
 */
const CONTROL_HOST = 'wikipedia.org';

function loadRoots() {
	const override = argValue('--roots', '');
	if (override) return override.split(',').map((v) => v.trim()).filter(Boolean);
	const configPath = resolve(projectRoot, 'config/cleaning-domains.json');
	if (!existsSync(configPath)) throw new Error(`루트 목록을 못 찾았다: ${configPath}`);
	return JSON.parse(readFileSync(configPath, 'utf8')).map((row) => row.host).filter(Boolean);
}

function searchUrl(root) {
	const url = new URL('https://search.naver.com/search.naver');
	url.searchParams.set('nso', '');
	url.searchParams.set('query', `site:${root}`);
	url.searchParams.set('sm', 'tab_pge');
	url.searchParams.set('ssc', 'tab.ur.all');
	url.searchParams.set('start', '1');
	url.searchParams.set('page', '2');
	return url.toString();
}

/** 색인 조사 스크립트(check-naver-indexed-posts.mjs)의 parsePage 와 같은 판정 기준을 쓴다. */
function parse(root, html) {
	const blocked = html.includes('검색 서비스 이용이 제한되었습니다') || html.includes('비정상적인 움직임이 발견');
	const noResult = html.includes('api_noresult_wrap') || html.includes('검색결과가 없습니다');
	const webItemCount = (html.match(/templateId":"webItem/g) || []).length;
	const hostPattern = new RegExp(`https?://[a-z0-9-]+\.${root.replace(/[.]/g, '\.')}[^"'<>)\s]*`, 'g');
	const hosts = new Set(Array.from(html.matchAll(hostPattern)).map((m) => {
		try { return new URL(m[0].replaceAll('&amp;', '&')).host; } catch { return null; }
	}).filter(Boolean));
	return { blocked, noResult, webItemCount, distinctSubdomains: hosts.size };
}

async function checkRoot(root) {
	const res = await fetch(searchUrl(root), {
		headers: {
			'user-agent': USER_AGENT,
			accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
		}
	});
	const html = await res.text();
	const parsed = parse(root, html);
	// blocked 는 "색인 없음" 이 아니다. 섞으면 차단당한 날이 색인 소실로 기록된다.
	const status = parsed.blocked || res.status === 403
		? 'blocked'
		: parsed.webItemCount > 0 ? 'indexed' : 'not-indexed';
	return { root, status, httpStatus: res.status, ...parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roots = loadRoots();
const checkedAt = new Date().toISOString();
console.log(`루트 ${roots.length}개 · ${delayMs}ms 간격${dryRun ? ' · DRY RUN(기록 안 함)' : ''}`);

const rows = [];
for (const [i, root] of roots.entries()) {
	let row;
	try {
		row = { checked_at: checkedAt, ...(await checkRoot(root)) };
	} catch (error) {
		row = { checked_at: checkedAt, root, status: 'error', error: String(error?.message || error) };
	}
	rows.push(row);
	console.log(
		`  ${String(i + 1).padStart(2)}. ${root.padEnd(20)} ${row.status.padEnd(13)}`
		+ ` 웹문서 ${String(row.webItemCount ?? '-').padStart(3)}건`
		+ `  서브도메인 ${String(row.distinctSubdomains ?? '-').padStart(3)}개`
		+ (row.error ? `  ${row.error}` : '')
	);
	await sleep(delayMs);
}

let controlCount = -1;
try { controlCount = (await checkRoot(CONTROL_HOST)).webItemCount; } catch { controlCount = -1; }
const controlOk = controlCount > 0;

for (const row of rows) {
	row.control_ok = controlOk;
	row.control_host = CONTROL_HOST;
	row.control_count = controlCount;
	// 대조군이 죽은 회차는 색인 통계에 쓰면 안 된다. 상태 자체를 갈아둔다.
	if (!controlOk && row.status === 'not-indexed') row.status = 'unverifiable';
}

const indexed = rows.filter((r) => r.status === 'indexed').map((r) => r.root);
const blocked = rows.filter((r) => r.status === 'blocked');
console.log(`\n대조군 ${CONTROL_HOST} ${controlCount}건 → 이 회차 ${controlOk ? '유효' : '무효'}`);
if (!controlOk) {
	console.log('⚠ 대조군이 0건이다. 색인이 빠진 게 아니라 셋 중 하나다:');
	console.log('  파서 고장(네이버 마크업 변경) · 내 IP 차단 · 프록시 이상');
	console.log('  이 회차의 not-indexed 는 unverifiable 로 기록했다 — 색인 판단에 쓰지 말 것.');
} else {
	console.log(`색인 살아있는 루트: ${indexed.length}/${rows.length}${indexed.length ? ` — ${indexed.join(', ')}` : ''}`);
}
if (blocked.length) console.log(`⚠ 차단 페이지를 받은 루트 ${blocked.length}개 — 이 루트는 색인 판단에 쓰지 말 것`);

if (!dryRun) {
	mkdirSync(dirname(outPath), { recursive: true });
	appendFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
	console.log(`기록: ${outPath}`);
}
