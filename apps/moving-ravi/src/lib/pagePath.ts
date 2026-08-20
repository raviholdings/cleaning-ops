/**
 * 이사 페이지의 주소를 만든다.
 *
 *   movingPagePath('경기 성남시 분당구 정자동', '포장이사')
 *     -> '/이사/분당구-정자동/포장이사'
 *
 * 지역과 키워드를 경로 단계로 나눈다. 한 덩어리로 잇는 것보다 낫다.
 *   · 네이버 가이드가 "콘텐츠 분류에 맞게 이해하기 쉬운 구조" 를 권한다
 *   · 나중에 /이사/분당구-정자동/ 에 그 지역 목록 페이지를 둘 수 있다
 *
 * 이 함수를 여섯 곳이 같이 쓴다. 한 곳이라도 다른 형태를 만들면 어긋난다.
 *
 *   렌더러      파일을 어디에 쓸지 (sites/<host>/이사/….html.gz)
 *   템플릿      canonical · og:url
 *   사이트맵    <loc>
 *   내부 링크   인근 지역 · 이전/다음
 *   수집요청    네이버에 제출할 URL
 *   색인 조사   검색 결과가 우리 URL 인지 판별
 *
 * 특히 수집요청과 색인 조사가 어긋나면 조용히 손해가 난다. 보낸 URL 과
 * 저장한 URL 의 형태가 다르면 "아직 안 보냈다" 로 판단해 같은 곳에 또
 * 보내고, 하루 50건 할당량을 중복으로 태운다.
 *
 * 그래서 인코딩은 하지 않고 한글 그대로 돌려준다. 인코딩이 필요한 쪽
 * (수집요청 제출 등)에서 한 번만 encodeURI 를 태운다. 여기서 인코딩해
 * 돌려주면 어떤 호출자는 두 번 인코딩하게 된다.
 */

/** 주소 앞에 붙는 구획. 청소(/1.html)와 섞이지 않게 나눈다. */
export const MOVING_PREFIX = '이사';

/**
 * 지역명에서 주소에 쓸 부분을 뽑는다.
 *
 * 운영자 지시로 뒤 두 토큰을 쓴다(구 + 동).
 *   '경기 성남시 분당구 정자동' -> '분당구 정자동'
 *   '서울 중구 무교동'          -> '중구 무교동'
 *
 * 다만 1토큰짜리 지역이 8,966개 있다(예: '서울'). 그때는 있는 것만 쓴다.
 */
export function pathLocation(location: string): string {
  const tokens = cleanLocation(location).split(/\s+/).filter(Boolean);
  return tokens.slice(-2).join(' ');
}

/**
 * 주소에 넣기 곤란한 문자를 걷어낸다.
 *
 * 지역명 361개에 한자 병기나 점이 붙어 있다.
 *   '충북 청주시 상당구 미원면 기암리(岐岩)' -> '충북 청주시 상당구 미원면 기암리'
 *
 * 이걸 안 걷으면 주소에 괄호와 한자가 들어가고, 파일명·로그·수집요청에서
 * 제각각 다르게 처리될 위험이 생긴다.
 */
function cleanLocation(location: string): string {
  return String(location)
    .replace(/\([^)]*\)/g, ' ')   // 한자 병기 등 괄호 묶음
    .replace(/[·.]/g, ' ')        // 가운뎃점·마침표
    .replace(/\s+/g, ' ')
    .trim();
}

/** 주소 한 조각으로 쓸 수 있게 다듬는다. 공백은 '-' 로 잇는다. */
function slug(value: string): string {
  return String(value)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * (지역, 메인키워드) -> 주소.
 *
 * 확장자를 붙이지 않는다. nginx 가 확장자 없는 요청에 .html 을 붙여 찾는다.
 */
export function movingPagePath(location: string, main: string): string {
  return `/${MOVING_PREFIX}/${slug(pathLocation(location))}/${slug(main)}`;
}

/**
 * 디스크에 떨굴 파일 이름. 주소 끝 조각에 .html 을 붙인 것이다.
 *
 *   '/이사/분당구-정자동/포장이사' -> '이사/분당구-정자동/포장이사.html'
 */
export function movingFilePath(location: string, main: string): string {
  return `${MOVING_PREFIX}/${slug(pathLocation(location))}/${slug(main)}.html`;
}

/** 절대 URL. canonical·사이트맵·수집요청이 쓴다. */
export function movingPageUrl(siteUrl: string, location: string, main: string): string {
  return `${String(siteUrl).replace(/\/+$/, '')}${movingPagePath(location, main)}`;
}
