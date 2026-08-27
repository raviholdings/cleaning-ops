/**
 * IndexNow 파일럿 감시용 awk 프로그램.
 *
 * 제출군 200 호스트와 대조군 200 호스트의 Yeti 방문을 날짜별로 센다.
 * 두 군을 비교해야 IndexNow 효과인지 배경 변동인지 갈린다 — 색인·크롤은
 * 원래 붙었다 떨어졌다 한다(운영자 확인, 2026-08-25 naoheg 16:42 20건 -> 21:06 0건).
 *
 * ⚠⚠ 오리진은 t3.small — 메모리 2GB, 스왑 없음 ⚠⚠
 * 2026-08-27 09:13 KST 에 로그 집계가 nginx 를 OOM 으로 죽인 적이 있다.
 * 큰 입력에 sort 를 물리지 않는다. 집계는 연관배열 한 패스로 끝낸다.
 * 키는 (400 호스트 + 날짜) 정도라 입력이 아무리 커도 메모리가 상수다.
 *
 * 규칙: 이 프로그램에 작은따옴표를 쓰지 말 것 — 셸 인용이 깨진다.
 */

/**
 * @param submit  제출군 호스트 목록
 * @param control 대조군 호스트 목록
 */
export function buildPilotAwk(submit, control) {
  return [
    'BEGIN {',
    // 호스트 -> 군 이름. 400개라 BEGIN 에서 다 올려도 부담이 없다.
    `  n = split(${JSON.stringify(submit.join(' '))}, s, " ");`,
    '  for (i = 1; i <= n; i++) grp[s[i]] = "submit";',
    `  m = split(${JSON.stringify(control.join(' '))}, c, " ");`,
    '  for (i = 1; i <= m; i++) grp[c[i]] = "control";',
    '  nsub = n; nctl = m;',
    '  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mo, " ");',
    '  for (i = 1; i <= 12; i++) mnum[mo[i]] = sprintf("%02d", i);',
    '}',
    '{',
    '  if (!match($0, /"[^"]*"$/)) next;',
    '  host = substr($0, RSTART + 1, RLENGTH - 2);',
    '  if (!(host in grp)) next;',
    '  b = index($0, "[");',
    '  if (!b) next;',
    '  split(substr($0, b + 1, 11), dp, "/");',
    '  if (!(dp[2] in mnum)) next;',
    '  d = dp[3] "-" mnum[dp[2]] "-" dp[1];',
    '  dseen[d] = 1;',
    '  g = grp[host];',
    '  hits[g, d]++;',
    // 호스트 몇 개가 실제로 방문받았는지도 센다 — 총량은 한 호스트가 끌어올릴 수 있다.
    '  if (!((host, d) in seenhd)) { seenhd[host, d] = 1; uniq[g, d]++ }',
    '  tot[g]++;',
    '}',
    'END {',
    '  nd = 0; for (k in dseen) dl[++nd] = k;',
    '  for (i = 2; i <= nd; i++) { kk = dl[i]; j = i - 1;',
    '    while (j > 0 && dl[j] > kk) { dl[j+1] = dl[j]; j-- } dl[j+1] = kk }',
    '',
    '  if (nd == 0) { print "  (두 군 모두 Yeti 방문 0회)"; exit }',
    '',
    '  print "=== Yeti 방문 수 (일자별) ===";',
    '  printf "  %-22s", "group";',
    '  for (i = 1; i <= nd; i++) printf "%9s", substr(dl[i], 6);',
    '  printf "%10s\\n", "total";',
    '  printf "  %-22s", "submit (200)";',
    '  for (i = 1; i <= nd; i++) printf "%9d", hits["submit", dl[i]] + 0;',
    '  printf "%10d\\n", tot["submit"] + 0;',
    '  printf "  %-22s", "control (200)";',
    '  for (i = 1; i <= nd; i++) printf "%9d", hits["control", dl[i]] + 0;',
    '  printf "%10d\\n", tot["control"] + 0;',
    '',
    '  print "";',
    '  print "=== 방문받은 호스트 수 (일자별, 200개 중) ===";',
    '  printf "  %-22s", "group";',
    '  for (i = 1; i <= nd; i++) printf "%9s", substr(dl[i], 6);',
    '  printf "\\n";',
    '  printf "  %-22s", "submit";',
    '  for (i = 1; i <= nd; i++) printf "%9d", uniq["submit", dl[i]] + 0;',
    '  printf "\\n";',
    '  printf "  %-22s", "control";',
    '  for (i = 1; i <= nd; i++) printf "%9d", uniq["control", dl[i]] + 0;',
    '  printf "\\n";',
    '',
    '  print "";',
    '  printf "  합계  제출군 %d회 / 대조군 %d회", tot["submit"] + 0, tot["control"] + 0;',
    '  if (tot["control"] > 0) printf "  (배수 %.2f)", (tot["submit"] + 0) / tot["control"];',
    '  else if (tot["submit"] > 0) printf "  (대조군 0 — 제출군만 방문)";',
    '  printf "\\n";',
    '}',
  ].join('\n');
}
