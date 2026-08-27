/**
 * 오리진 접근 로그에서 Yeti 방문을 집계하는 awk 프로그램을 만든다.
 *
 * 왜 awk 인가: 오리진은 t3.small(2GB, 스왑 없음)이다. 2026-08-27 09:13 KST 에
 * `sort | uniq -c` 로 180만 줄을 집계하다 sort 가 1.76GB 를 잡아 nginx 가
 * OOM 으로 죽고 전 사이트가 HTTP 521 이 됐다. awk 연관배열은 키가 호스트
 * 10여 개 × 날짜라 입력이 아무리 커도 메모리가 상수다.
 *
 * 정렬도 awk 안에서 끝낸다 — 바깥 sort 를 붙이면 섹션 제목까지 섞이고,
 * 무엇보다 큰 입력에 sort 를 물리는 습관 자체를 남기지 않으려는 것이다.
 * 정렬 대상은 수십~수백 개뿐이라 삽입정렬로 충분하다.
 *
 * 규칙: 이 프로그램에 작은따옴표를 쓰지 말 것 — 셸 인용이 깨진다.
 */

/** @param roots apex 루트 도메인 목록 */
export function buildYetiAwk(roots) {
  return [
    'BEGIN {',
    `  n = split(${JSON.stringify(roots.join(' '))}, a, " ");`,
    '  for (i = 1; i <= n; i++) isRoot[a[i]] = 1;',
    '}',
    '{',
    // 호스트는 줄 끝 따옴표 안이다. -F 를 쓰면 셸 인용이 한 겹 더 늘어난다.
    '  if (!match($0, /"[^"]*"$/)) next;',
    '  host = substr($0, RSTART + 1, RLENGTH - 2);',
    '  b = index($0, "[");',
    '  d = b ? substr($0, b + 1, 11) : "?";',
    // 루트 판별은 정규식이 아니라 배열 조회다 — 점을 이스케이프할 일이 없다.
    '  if (host in isRoot) { apex[host " " d]++; na_seen = 1; next }',
    '  m = split(host, p, ".");',
    // 마지막 조각이 문자로 시작할 때만 도메인으로 본다 (IP 필드가 섞인 줄 제외).
    '  if (m > 2 && p[m] ~ /^[a-z]/) subs[p[m-1] "." p[m]]++;',
    '  other++;',
    '}',
    'END {',
    '  print "=== apex 루트 (서브도메인 제외) ===";',
    '  na = 0;',
    '  for (k in apex) ak[++na] = k;',
    // 키(호스트+날짜) 오름차순
    '  for (i = 2; i <= na; i++) {',
    '    kk = ak[i]; j = i - 1;',
    '    while (j > 0 && ak[j] > kk) { ak[j+1] = ak[j]; j-- }',
    '    ak[j+1] = kk;',
    '  }',
    '  for (i = 1; i <= na; i++) printf "  %8d  %s\\n", apex[ak[i]], ak[i];',
    '  if (na == 0) print "  (없음 - apex 방문 0회)";',
    '  print "";',
    '  print "=== 서브도메인 (대조군, 루트별 합계) ===";',
    '  ns = 0;',
    '  for (k in subs) sk[++ns] = k;',
    // 횟수 내림차순
    '  for (i = 2; i <= ns; i++) {',
    '    kk = sk[i]; j = i - 1;',
    '    while (j > 0 && subs[sk[j]] < subs[kk]) { sk[j+1] = sk[j]; j-- }',
    '    sk[j+1] = kk;',
    '  }',
    '  for (i = 1; i <= ns; i++) printf "  %8d  %s\\n", subs[sk[i]], sk[i];',
    '  printf "\\n  %8d  %s\\n", other, "서브도메인 합계";',
    '}',
  ].join('\n');
}

export const APEX_ROOTS = [
  'amunsa.com', 'anclose.com', 'daddul.com', 'ddulea.com', 'naoheg.com',
  'neverfoul.com', 'one-qfast.com', 'oneshot-sewer.com', 'pipe-oneshot.com', 'uloung.com',
];
