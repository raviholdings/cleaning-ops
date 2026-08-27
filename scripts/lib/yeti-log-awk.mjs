/**
 * 오리진 접근 로그에서 Yeti 방문을 집계하는 awk 프로그램을 만든다.
 *
 * 왜 awk 인가: 오리진은 t3.small(2GB, 스왑 없음)이다. 2026-08-27 09:13 KST 에
 * `sort | uniq -c` 로 180만 줄을 집계하다 sort 가 1.76GB 를 잡아 nginx 가
 * OOM 으로 죽고 전 사이트가 HTTP 521 이 됐다. awk 연관배열은 키가 호스트
 * 10여 개 × 날짜뿐이라 입력이 아무리 커도 메모리가 상수다.
 *
 * 정렬도 awk 안에서 끝낸다 — 바깥 sort 를 붙이면 섹션 제목까지 섞이고,
 * 무엇보다 큰 입력에 sort 를 물리는 습관을 남기지 않으려는 것이다.
 * 정렬 대상은 수십 개뿐이라 삽입정렬로 충분하다.
 *
 * 출력은 루트 × 날짜 매트릭스다. 하루하루 움직임을 봐야 IndexNow 가 발견
 * 경로를 열었는지 알 수 있다 — 기간 합계로는 구별이 안 된다.
 *
 * ⚠ 2026-08-25 이전 회전 로그는 log_format 에 $host 가 없다. 마지막 필드가
 *   XFF(IP)라 어느 호스트로 온 요청인지 알 수 없다 — 0 으로 세지 말고
 *   "호스트 미상" 으로 따로 보고할 것.
 *
 * 규칙: 이 프로그램에 작은따옴표를 쓰지 말 것 — 셸 인용이 깨진다.
 */

/** @param roots apex 루트 도메인 목록 */
export function buildYetiAwk(roots) {
  return [
    'BEGIN {',
    `  n = split(${JSON.stringify(roots.join(' '))}, a, " ");`,
    '  for (i = 1; i <= n; i++) isRoot[a[i]] = 1;',
    '  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ");',
    '  for (i = 1; i <= 12; i++) mnum[mn[i]] = sprintf("%02d", i);',
    '}',
    '{',
    // 호스트는 줄 끝 따옴표 안이다. -F 를 쓰면 셸 인용이 한 겹 더 늘어난다.
    '  if (!match($0, /"[^"]*"$/)) next;',
    '  host = substr($0, RSTART + 1, RLENGTH - 2);',
    // 27/Aug/2026 -> 2026-08-27 (정렬 가능한 형태로)
    '  b = index($0, "[");',
    '  d = "?";',
    '  if (b) {',
    '    split(substr($0, b + 1, 11), dp, "/");',
    '    if (dp[2] in mnum) d = dp[3] "-" mnum[dp[2]] "-" dp[1];',
    '  }',
    '  dseen[d] = 1; total++;',
    // 루트 판별은 정규식이 아니라 배열 조회다 — 점을 이스케이프할 일이 없다.
    '  if (host in isRoot) { A[host, d]++; arow[host] = 1; atot[host]++; n_apex++; next }',
    '  m = split(host, p, ".");',
    '  if (m > 2 && p[m] ~ /^[a-z]/) {',
    '    r = p[m-1] "." p[m];',
    '    S[r, d]++; srow[r] = 1; stot[r]++; n_sub++; next;',
    '  }',
    '  U[d]++; n_unknown++;',
    '  if (n_samp < 5 && !(host in seen)) { seen[host] = 1; samp[++n_samp] = host }',
    '}',
    'END {',
    // 날짜 오름차순
    '  nd = 0; for (k in dseen) dl[++nd] = k;',
    '  for (i = 2; i <= nd; i++) { kk = dl[i]; j = i - 1;',
    '    while (j > 0 && dl[j] > kk) { dl[j+1] = dl[j]; j-- } dl[j+1] = kk }',
    '',
    '  print "=== apex 루트 (일자별) ===";',
    '  na = 0; for (k in arow) al[++na] = k;',
    '  for (i = 2; i <= na; i++) { kk = al[i]; j = i - 1;',
    '    while (j > 0 && atot[al[j]] < atot[kk]) { al[j+1] = al[j]; j-- } al[j+1] = kk }',
    '  if (na == 0) print "  (없음 - apex 방문 0회)";',
    '  else { header(); for (i = 1; i <= na; i++) row(al[i], A, atot[al[i]]) }',
    '',
    '  print "";',
    '  print "=== 서브도메인 (대조군, 일자별) ===";',
    '  ns = 0; for (k in srow) sl[++ns] = k;',
    '  for (i = 2; i <= ns; i++) { kk = sl[i]; j = i - 1;',
    '    while (j > 0 && stot[sl[j]] < stot[kk]) { sl[j+1] = sl[j]; j-- } sl[j+1] = kk }',
    '  if (ns == 0) print "  (없음)";',
    '  else { header(); for (i = 1; i <= ns; i++) row(sl[i], S, stot[sl[i]]) }',
    '',
    '  if (n_unknown > 0) {',
    '    print "";',
    '    print "=== 호스트 미상 (옛 log_format, $host 없음 - 집계 불가) ===";',
    '    header();',
    '    printf "  %-20s", "(unknown)";',
    '    for (i = 1; i <= nd; i++) printf "%9d", U[dl[i]] + 0;',
    '    printf "%10d\\n", n_unknown;',
    '    if (n_samp > 0) {',
    '      print "";',
    '      print "  표본 (XFF IP 가 마지막 필드):";',
    '      for (i = 1; i <= n_samp; i++) printf "    %s\\n", samp[i];',
    '    }',
    '  }',
    '',
    '  print "";',
    '  printf "  Yeti 요청 전체: %d  (apex %d · 서브도메인 %d · 미상 %d)\\n",',
    '    total + 0, n_apex + 0, n_sub + 0, n_unknown + 0;',
    '}',
    '',
    // 정렬되는 칸은 ASCII 로 둔다. 한글은 표시폭이 2칸인데 awk printf 는 문자
    // 수(로케일이 C 면 바이트 수)로 패딩해서 열이 어긋난다.
    'function header(  i) {',
    '  printf "  %-20s", "host";',
    '  for (i = 1; i <= nd; i++) printf "%9s", substr(dl[i], 6);',
    '  printf "%10s\\n", "total";',
    '}',
    // M 은 2차원 배열, t 는 그 행의 합계.
    'function row(name, M, t,   i) {',
    '  printf "  %-20s", name;',
    '  for (i = 1; i <= nd; i++) printf "%9d", M[name, dl[i]] + 0;',
    '  printf "%10d\\n", t;',
    '}',
  ].join('\n');
}

export const APEX_ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];
