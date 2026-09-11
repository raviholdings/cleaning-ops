/**
 * 브랜드 사이트 트래픽 집계용 awk 프로그램.
 *
 * 로그 포맷 (nginx log_format main)
 *   $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
 *   "$http_referer" "$http_user_agent" "$http_x_forwarded_for" "$host"
 *
 * ⚠ $remote_addr 은 Cloudflare IP 다. 진짜 방문자는 뒤에서 두 번째 따옴표 필드
 *   ($http_x_forwarded_for) 에 있다. 여기를 봐야 한다.
 *   XFF 에 여러 개가 콤마로 들어오면 맨 앞이 원 클라이언트다.
 *
 * ⚠⚠ 오리진은 t3.small — 메모리 2GB, 스왑 없음 ⚠⚠
 * 2026-08-27 에 로그 집계가 nginx 를 OOM 으로 죽인 적이 있다. sort 를 물리지
 * 않는다. 집계는 연관배열 한 패스로 끝내고, 정렬은 상위 N 개만 awk 안에서 한다.
 *
 * 규칙: 이 프로그램에 작은따옴표를 쓰지 말 것 — 셸 인용이 깨진다.
 */

/**
 * @param hosts 볼 호스트 목록 (예: ssac3.kr, dosadosa.kr)
 * @param topN  IP 상위 몇 개를 보여줄지
 */
export function buildBrandTrafficAwk(hosts, topN = 15) {
  return [
    'BEGIN {',
    `  n = split(${JSON.stringify(hosts.join(' '))}, hs, " ");`,
    '  for (i = 1; i <= n; i++) want[hs[i]] = 1;',
    '  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mo, " ");',
    '  for (i = 1; i <= 12; i++) mnum[mo[i]] = sprintf("%02d", i);',
    `  TOP = ${Number(topN)};`,
    '}',
    '{',
    // 뒤에서부터 따옴표 필드 두 개: host, xff
    '  if (!match($0, /"[^"]*"$/)) next;',
    '  host = substr($0, RSTART + 1, RLENGTH - 2);',
    '  if (!(host in want)) next;',
    '  rest = substr($0, 1, RSTART - 2);',
    '  if (!match(rest, /"[^"]*"$/)) next;',
    '  xff = substr(rest, RSTART + 1, RLENGTH - 2);',
    '  rest2 = substr(rest, 1, RSTART - 2);',
    '  if (!match(rest2, /"[^"]*"$/)) next;',
    '  ua = substr(rest2, RSTART + 1, RLENGTH - 2);',
    // ⚠ 리퍼러는 여기서 바로 꺼낸다. 아래 ispage 판정이 match() 를 또 부르면
    //   RSTART 가 덮여서 위치를 잃는다 (2026-09-10 실제로 전부 direct 로 찍혔다).
    '  rest3 = substr(rest2, 1, RSTART - 2);',
    '  ref = "-";',
    '  if (match(rest3, /"[^"]*"$/)) ref = substr(rest3, RSTART + 1, RLENGTH - 2);',
    '',
    // XFF 는 콤마로 여러 개가 올 수 있다. 맨 앞이 원 클라이언트.
    '  ip = xff;',
    '  c = index(ip, ",");',
    '  if (c > 0) ip = substr(ip, 1, c - 1);',
    '  gsub(/ /, "", ip);',
    '  if (ip == "" || ip == "-") ip = "(없음)";',
    '',
    '  b = index($0, "[");',
    '  if (!b) next;',
    '  split(substr($0, b + 1, 11), dp, "/");',
    '  if (!(dp[2] in mnum)) next;',
    '  d = dp[3] "-" mnum[dp[2]] "-" dp[1];',
    '  dseen[d] = 1;',
    '',
    // 봇 판정. 자칭 UA 라 완벽하지 않지만 대량 크롤러는 다 걸린다.
    '  isbot = (ua ~ /bot|Bot|spider|Spider|crawler|Crawler|Yeti|Applebot|Googlebot|bingbot|PetalBot|YandexBot|Bytespider|GPTBot|ClaudeBot|facebookexternalhit/);',
    '',
    /*
     * 페이지 요청만 따로 센다. 한 번 방문하면 이미지·CSS·파비콘까지 여러 건이
     * 찍혀서, 요청 수를 방문 수로 읽으면 20배쯤 부풀어 보인다
     * (2026-09-10 운영자 지적: "사람이 1000명이나 들어왔다고?").
     */
    '  ispage = 0;',
    '  if (match($0, /"(GET|HEAD)[^"]*"/)) {',
    '    req = substr($0, RSTART + 1, RLENGTH - 2);',
    '    sp1 = index(req, " ");',
    '    pth = substr(req, sp1 + 1);',
    '    sp2 = index(pth, " ");',
    '    if (sp2 > 0) pth = substr(pth, 1, sp2 - 1);',
    '    qm = index(pth, "?");',
    '    if (qm > 0) pth = substr(pth, 1, qm - 1);',
    '    ispage = !(pth ~ /^\\/assets\\/|\\.(css|js|mjs|ico|png|jpg|jpeg|webp|gif|svg|woff|woff2|ttf|eot|map|xml|txt|json)$/);',
    '  }',
    '',
    // 리퍼러 분류. 벤더가 "노출로 찍고 직접 진입" 한다고 해서 직접(리퍼러 없음)과
    // 검색 유입을 갈라 본다. ref 는 위에서 이미 꺼내 뒀다.
    '  if (ref == "-" || ref == "") refclass = "direct";',
    '  else if (ref ~ /naver\\./) refclass = "naver";',
    '  else if (ref ~ /google\\./) refclass = "google";',
    '  else if (ref ~ /daum\\.|kakao\\./) refclass = "daum";',
    '  else if (index(ref, host) > 0) refclass = "self";',
    '  else refclass = "other";',
    '',
    '  tot[host, d]++;',
    '  if (isbot) { bot[host, d]++; }',
    '  else {',
    '    hum[host, d]++;',
    '    if (ispage) pg[host, d]++;',
    // 서로 다른 IP 는 봇을 뺀 것만 센다. 봇을 섞으면 사람 IP 수를 못 읽는다.
    '    if (!((host, d, ip) in seenip)) { seenip[host, d, ip] = 1; uniq[host, d]++ }',
    '    if (ispage) ipcnt[host SUBSEP ip]++;',
    '    ref2[host, d, refclass]++;',
    '  }',
    '}',
    'END {',
    '  nd = 0; for (k in dseen) dl[++nd] = k;',
    '  for (i = 2; i <= nd; i++) { kk = dl[i]; j = i - 1;',
    '    while (j > 0 && dl[j] > kk) { dl[j+1] = dl[j]; j-- } dl[j+1] = kk }',
    '  if (nd == 0) { print "  (해당 호스트 로그 없음)"; exit }',
    '',
    '  for (hi = 1; hi <= n; hi++) {',
    '    h = hs[hi];',
    '    print "";',
    '    print "=== " h " ===";',
    '    printf "  %-12s %9s %9s %9s %9s %9s\\n", "date", "req-all", "bot-req", "usr-req", "usr-page", "usr-ip";',
    '    ht = 0; hh = 0; hb = 0; hp = 0;',
    '    for (i = 1; i <= nd; i++) {',
    '      d = dl[i];',
    '      if (tot[h, d] + 0 == 0) continue;',
    '      printf "  %-12s %9d %9d %9d %9d %9d\\n", d, tot[h,d]+0, bot[h,d]+0, hum[h,d]+0, pg[h,d]+0, uniq[h,d]+0;',
    '      ht += tot[h,d]; hh += hum[h,d]; hb += bot[h,d]; hp += pg[h,d];',
    '    }',
    '    printf "  %-12s %9d %9d %9d %9d\\n", "합계", ht, hb, hh, hp;',
    '',
    // 사람 요청의 리퍼러 분포. direct 가 튀면 벤더가 말한 그 방식이다.
    '    print "";',
    '    printf "  -- referer (bot 제외) --\\n";',
    '    printf "  %-12s %9s %9s %9s %9s %9s\\n", "date", "direct", "naver", "google", "daum", "other";',
    '    for (i = 1; i <= nd; i++) {',
    '      d = dl[i];',
    '      if (hum[h, d] + 0 == 0) continue;',
    '      printf "  %-12s %9d %9d %9d %9d %9d\\n", d,',
    '        ref2[h,d,"direct"]+0, ref2[h,d,"naver"]+0, ref2[h,d,"google"]+0,',
    '        ref2[h,d,"daum"]+0, ref2[h,d,"other"]+ref2[h,d,"self"]+0;',
    '    }',
    '',
    // 사람 UA 기준 상위 IP. 삽입 정렬을 상위 TOP 개로만 돌린다.
    '    cnt = 0;',
    '    for (k in ipcnt) {',
    '      if (index(k, h SUBSEP) != 1) continue;',
    '      v = ipcnt[k]; kip = substr(k, length(h) + 2);',
    '      if (cnt < TOP) { cnt++; tv[cnt] = v; tk[cnt] = kip }',
    '      else if (v > tv[cnt]) { tv[cnt] = v; tk[cnt] = kip }',
    '      else continue;',
    '      for (j = cnt; j > 1 && tv[j] > tv[j-1]; j--) {',
    '        sv = tv[j]; tv[j] = tv[j-1]; tv[j-1] = sv;',
    '        sk = tk[j]; tk[j] = tk[j-1]; tk[j-1] = sk;',
    '      }',
    '    }',
    '    if (cnt > 0) {',
    '      print "";',
    '      printf "  -- IP top %d (페이지 요청 기준, bot 제외) --\\n", cnt;',
    '      for (i = 1; i <= cnt; i++) printf "    %-18s %6d\\n", tk[i], tv[i];',
    '    }',
    '    for (i = 1; i <= cnt; i++) { delete tv[i]; delete tk[i] }',
    '  }',
    '}',
  ].join('\n');
}
