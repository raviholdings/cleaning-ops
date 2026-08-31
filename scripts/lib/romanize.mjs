/**
 * 한글 지명 → 로마자 (URL 용).
 *
 * 클린배관(xn--zb0bp4v40b457a.com)처럼 /{시도}/{시군구}/{키워드} 3단계를 만들려면
 * 시도 16개와 시군구 256개에 로마자 조각이 필요하다. 행정표준코드 자료에는 없다.
 *
 * 국어의 로마자 표기법(문화체육관광부 고시)을 따르되 URL 용으로 줄인다.
 *   - 붙임표(-)를 안 쓴다.  종로구 → jongnogu   (표기법대로면 Jongno-gu)
 *   - 전부 소문자.
 *   - 음운 변화 중 지명에 실제로 나타나는 것만 반영한다:
 *     비음화(종로→종노, 왕십리→왕심니), 유음화(신라→실라), ㄴ첨가는 다루지 않는다.
 *
 * 표기법을 100% 재현하지 않는다. URL 조각이므로 사람이 읽을 수 있고 결정적이면 된다.
 * 예외가 필요한 이름은 OVERRIDES 에 적는다 — 자동 변환을 고치지 말 것.
 */

// 초성 19
const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
// 중성 21
const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo',
  'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
// 종성 28 (0 = 없음). 로마자는 대표음.
const JONG = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l',
  'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// 종성 자모 인덱스 → 자음 이름 (음운 변화 판정용)
const JONG_KO = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ',
  'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const CHO_KO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ',
  'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 자동 변환이 어색해지는 이름만 손으로 적는다. */
const OVERRIDES = {
  서울특별시: 'seoul',
  세종특별자치시: 'sejong',
  제주특별자치도: 'jeju',
  강원특별자치도: 'gangwon',
  전북특별자치도: 'jeonbuk',
  충청북도: 'chungbuk',
  충청남도: 'chungnam',
  전라남도: 'jeonnam',
  경상북도: 'gyeongbuk',
  경상남도: 'gyeongnam',
  경기도: 'gyeonggi',
  부산광역시: 'busan',
  대구광역시: 'daegu',
  인천광역시: 'incheon',
  광주광역시: 'gwangju',
  대전광역시: 'daejeon',
  울산광역시: 'ulsan',
};

function decompose(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  return { cho: Math.floor(code / 588), jung: Math.floor((code % 588) / 28), jong: code % 28 };
}

/**
 * 앞 글자의 받침과 뒷 글자의 첫소리가 만나 소리가 바뀌는 경우.
 * 지명에 실제로 나오는 것만 처리한다. 못 찾으면 그대로 둔다.
 */
function assimilate(prevJong, nextCho) {
  const j = JONG_KO[prevJong];
  const c = CHO_KO[nextCho];
  // 유음화 — 신라 silla, 대관령 daegwallyeong
  if (j === 'ㄴ' && c === 'ㄹ') return { jong: 8, cho: 5 };      // ㄴ+ㄹ → ㄹ+ㄹ
  if (j === 'ㄹ' && c === 'ㄴ') return { jong: 8, cho: 5 };      // ㄹ+ㄴ → ㄹ+ㄹ
  // 비음화 — 종로 jongno, 왕십리 wangsimni, 백마 baengma
  if (j === 'ㅇ' && c === 'ㄹ') return { jong: 21, cho: 2 };     // ㅇ+ㄹ → ㅇ+ㄴ
  if (j === 'ㅁ' && c === 'ㄹ') return { jong: 16, cho: 2 };     // ㅁ+ㄹ → ㅁ+ㄴ
  if ((j === 'ㄱ' || j === 'ㄲ' || j === 'ㅋ') && (c === 'ㄴ' || c === 'ㅁ')) return { jong: 21, cho: nextCho };
  if ((j === 'ㅂ' || j === 'ㅍ') && (c === 'ㄴ' || c === 'ㅁ')) return { jong: 16, cho: nextCho };
  if ((j === 'ㄷ' || j === 'ㅅ' || j === 'ㅆ' || j === 'ㅈ' || j === 'ㅊ' || j === 'ㅌ')
    && (c === 'ㄴ' || c === 'ㅁ')) return { jong: 4, cho: nextCho };
  if ((j === 'ㄱ' || j === 'ㅂ') && c === 'ㄹ') {
    // 백령 baengnyeong — 받침은 비음, 뒤 ㄹ은 ㄴ 으로
    return { jong: j === 'ㄱ' ? 21 : 16, cho: 2 };
  }
  return null;
}

/** 한글 한 덩어리를 로마자로. 한글이 아닌 문자는 버린다. */
export function romanize(name) {
  if (OVERRIDES[name]) return OVERRIDES[name];
  const parts = [];
  for (const ch of name) {
    const d = decompose(ch);
    if (d) parts.push(d);
    // 한글이 아니면(공백·한자·숫자) 건너뛴다 — URL 조각이라 붙여 쓴다
  }
  if (!parts.length) return '';

  // 음운 변화를 앞에서부터 적용
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!parts[i].jong) continue;
    const r = assimilate(parts[i].jong, parts[i + 1].cho);
    if (r) { parts[i].jong = r.jong; parts[i + 1].cho = r.cho; }
  }

  let out = '';
  for (const p of parts) out += CHO[p.cho] + JUNG[p.jung] + JONG[p.jong];
  return out.replace(/[^a-z]/g, '');
}

/**
 * 같은 로마자가 두 번 나오면 안 된다 — 중구는 다섯 시도에, 고성군은 두 시도에 있다.
 * 겹치는 이름은 상위 지역을 앞에 붙여 가른다 (서울 중구 → seoul-junggu).
 *
 * items 는 { key, name, prefix } 의 배열이다. 이름으로 키를 잡으면 같은 이름끼리
 * 뭉개지므로 반드시 고유한 key(행정코드)를 준다. 반환값도 key 로 찾는다.
 */
export function romanizeUnique(items) {
  const seen = new Map();
  for (const it of items) seen.set(it.name, (seen.get(it.name) || 0) + 1);
  const taken = new Set();
  const out = new Map();
  for (const it of items) {
    const base = romanize(it.name) || 'x';
    let slug = base;
    if (seen.get(it.name) > 1 && it.prefix) {
      const p = romanize(it.prefix);
      if (p) slug = `${p}-${base}`;
    }
    let n = 2;
    const root = slug;
    while (taken.has(slug)) { slug = `${root}${n}`; n += 1; }
    taken.add(slug);
    out.set(it.key, slug);
  }
  return out;
}
