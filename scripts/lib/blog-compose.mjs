/**
 * 블로그형 본문 조립기.
 *
 * data/brands/_blog-library.json 의 문안 조각을 받아 한 편의 글로 엮는다.
 * 레퍼런스(뚜러썬설비 공주 신관동 글 · 하수구박사 rainpipe)의 뼈대를 따른다.
 *
 *   질문형 소제목        "싱크대 물이 천천히 빠지는 것도 막힘의 신호일까요?"
 *   ↳ 짧은 라벨          "천천히 빠지는 것도 신호"
 *   ↳ 문단 2~3개
 *   ↳ 표·번호목록·체크리스트·강조상자 중 하나 (구역마다 다르게)
 *
 * 질문이 그대로 목차가 된다. 그래서 목차를 따로 지어낼 필요가 없다.
 *
 * 같은 (사이트, 지역, 키워드) 면 언제 다시 구워도 같은 글이 나온다 — 시드 하나로
 * 고르기 때문이다. 주소가 바뀌지 않는 것과 같은 이유로 본문도 흔들리면 안 된다.
 *
 * 사이트마다 plan 이 다르다. 그게 "다섯 곳이 서로 다른 형태" 의 실체다.
 */

/* ── 고르기 ── */

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * 배열에서 n 개를 시드로 골라 순서까지 정한다.
 *
 * 서로소인 보폭으로 돌면 같은 것을 두 번 집지 않으면서 시드마다 다른 조합이 나온다.
 * nCk 를 직접 세는 방식은 목록이 길어지면 자릿수가 넘쳐 늘 첫 조합만 나왔다 —
 * 3,072편이 같은 글이 되던 원인이라 여기서는 쓰지 않는다.
 */
export function pickN(arr, n, seed) {
  const len = arr.length;
  if (!len) return [];
  const k = Math.min(n, len);
  const s = Math.abs(seed) >>> 0;
  let stride = len > 1 ? 1 + (Math.floor(s / 7) % (len - 1)) : 1;
  while (len > 1 && gcd(stride, len) !== 1) stride = (stride % (len - 1)) + 1;
  const out = [];
  let i = s % len;
  for (let c = 0; c < k; c += 1) {
    out.push(arr[i]);
    i = (i + stride) % len;
  }
  return out;
}

const one = (arr, seed) => arr[Math.abs(seed) % arr.length];

/* ── 자리표시자 ── */

/**
 * 조사 짝 — 받침이 있으면 앞의 것, 없으면 뒤의 것.
 * "싱크대막힘가 생겼을 때" 처럼 어긋나면 사람이 쓴 글로 안 읽힌다.
 */
const JOSA = {
  은: ['은', '는'], 는: ['은', '는'],
  이: ['이', '가'], 가: ['이', '가'],
  을: ['을', '를'], 를: ['을', '를'],
  과: ['과', '와'], 와: ['과', '와'],
  으로: ['으로', '로'], 로: ['으로', '로'],
  이나: ['이나', '나'], 나: ['이나', '나'],
  이라: ['이라', '라'], 라: ['이라', '라'],
  이며: ['이며', '며'], 며: ['이며', '며'],
  이라면: ['이라면', '라면'], 라면: ['이라면', '라면'],
};

/** ㄹ 받침은 '로/으로' 앞에서만 받침 없는 것처럼 군다 (서울로, 지하로). */
function hasBatchim(word, forRo = false) {
  const ch = word.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return /[0-9lmnrLMNR]$/i.test(ch);
  const jong = (code - 0xac00) % 28;
  if (jong === 0) return false;
  return forRo ? jong !== 8 : true;   // 8 = ㄹ
}

/*
 * 조사는 자리표시자 바로 뒤에 붙고 그 뒤가 공백·문장부호일 때만 고친다.
 * 그러지 않으면 "{지역}은행" 의 '은' 까지 조사로 보고 바꿔 버린다.
 * 긴 것부터 나열해야 '으로' 가 '로' 에 먼저 걸리지 않는다.
 */
const JOSA_RE = new RegExp(
  '\\{([^}{\\s]{1,20})\\}(이라면|라면|으로|이나|이라|이며|은|는|이|가|을|를|과|와|로|나|라|며)'
  + '(?=[\\s,.·)\\]"\'!?]|$)',
  'g',
);

/**
 * {지역} {메인키워드} 같은 자리를 채우고 뒤따르는 조사를 맞춘다.
 *
 * 없는 이름은 던진다. 문안을 새로 쓰다 {출동시간} 같은 걸 적어 넣으면
 * 3,000장에 그대로 박혀 나가는데, 그건 지어낸 사실이라 나가면 안 된다.
 * 해시태그의 {지역하수구막힘} 처럼 지역+말 붙임꼴은 따로 받는다.
 */
export function fillVars(text, vars) {
  const value = (name) => {
    if (name in vars) return vars[name];
    if (name.startsWith('지역') && name.length > 2) {
      const head = vars.해시지역 === undefined ? vars.지역 : vars.해시지역;
      return head + name.slice(2);
    }
    throw new Error(`본문 자리표시자 {${name}} 를 채울 값이 없습니다.`);
  };
  return String(text)
    .replace(JOSA_RE, (m, name, josa) => {
      const v = value(name);
      const pair = JOSA[josa];
      if (!pair) return v + josa;
      return v + (hasBatchim(v, pair[0] === '으로') ? pair[0] : pair[1]);
    })
    .replace(/\{([^}{\s]{1,20})\}/g, (m, name) => value(name));
}

/**
 * 한 페이지가 쓸 값 한 벌.
 * 지어내면 안 되는 것(경력·고객수·출동시간)은 여기 없다. 장비와 운영시간은
 * 사이트 json 의 facts 에서 오고, 그건 운영자가 확인해 준 값이다.
 */
export function makeVars({
  dict, site, kwLabel, sido, sigungu, dongs = [], neighbors = [], seed, shortLabel,
}) {
  const profile = (() => {
    const p = dict.keywords[kwLabel];
    if (!p) throw new Error(`_blog-vars.json 에 키워드 "${kwLabel}" 가 없습니다.`);
    return p.alias ? dict.keywords[p.alias] : p;
  })();
  const c = dict.common;
  const facts = site.facts || {};
  const equip = facts.equipment || [];
  const region = [sido, sigungu].filter(Boolean).join(' ');

  const pick = (arr, salt) => one(arr, seed + salt);

  return {
    지역: region,
    해시지역: shortLabel || sigungu || sido,
    시도: sido,
    구: sigungu,
    동: dongs[0] || sigungu || sido,
    동2: dongs[1] || dongs[0] || sigungu || sido,
    동3: dongs[2] || dongs[0] || sigungu || sido,
    세부지역: dongs.slice(0, 3).join(' · ') || sigungu || sido,
    인접지역: neighbors.slice(0, 3).join(' · ') || sido,

    메인키워드: kwLabel,
    키워드: kwLabel,
    보조키워드: profile.보조키워드,
    문제장소: profile.문제장소,
    막힘증상: pick(profile.막힘증상, 11),
    역류지점: pick(profile.역류지점, 17),
    발생과정: pick(profile.발생과정, 23),
    회수이물질: pick(profile.회수이물질, 29),

    건물유형: pick(c.건물유형, 31),
    상가종류: pick(c.상가종류, 37),
    점검방법: pick(c.점검방법, 41),
    진단결과: pick(c.진단결과, 43),
    검수방법: pick(c.검수방법, 47),
    작업결과: pick(c.작업결과, 53),
    재발방지안내: pick(c.재발방지안내, 59),
    사례구분: pick(c.사례구분, 61),
    기름유입원인: pick(c.기름유입원인, 67),

    업체명: site.brand,
    전화번호: site.phone,
    운영시간: facts.hours || '',
    출동시간: facts.dispatch || '',
    사용장비: equip.length ? pickN(equip, 2, seed + 71).join('와 ') : '',
    서비스목록: (site.serviceList || []).join(' · '),
  };
}

/* ── 조각 해석 ── */

/** "1. 어쩌고" 줄들 → 번호 목록 */
const asOl = (t) => t.split('\n').map((l) => l.trim())
  .filter((l) => /^\d+\.\s/.test(l))
  .map((l) => l.replace(/^\d+\.\s*/, ''));

/** "✔️ 어쩌고" 줄들 → 체크 목록 */
const asCheck = (t) => t.split('\n').map((l) => l.trim())
  .filter((l) => l.startsWith('✔'))
  .map((l) => l.replace(/^✔️?\s*/, ''));

/** 마크다운 표 → { head, rows }. 구분선(| --- |)은 버린다. */
function asTable(t) {
  const rows = t.split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const body = rows.filter((r) => !r.every((c) => /^-{2,}$/.test(c)));
  return { head: body[0] || [], rows: body.slice(1) };
}

/** "**Q. …**\n\nA. …" → { q, a } */
function asFaq(t) {
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  // 문서에 별표를 붙인 것과 안 붙인 것이 섞여 있다. 둘 다 받는다.
  const q = (lines.find((l) => /^\*{0,2}Q\./.test(l)) || '')
    .replace(/^\*{0,2}\s*Q\.\s*/, '').replace(/\*{0,2}$/, '').trim();
  const a = lines.filter((l) => l.startsWith('A.')).map((l) => l.replace(/^A\.\s*/, ''))
    .join(' ').trim();
  return { q, a };
}

/** 소제목 두 줄 → { h, label } */
function asHead(t) {
  const [h, label] = t.split('\n').map((l) => l.trim()).filter(Boolean);
  return { h, label: label || '' };
}

/** 상자 이름에 든 말로 색을 정한다. 💡 안내 / ⚠️ 경고 */
const boxTone = (name) => (name.includes('주의') ? 'warn' : 'tip');
const boxTitle = (name) => (name.includes('주의') ? '⚠️ 주의하세요' : '💡 알아두세요');

/* ── 조립 ── */

/**
 * @param {object} o.lib      _blog-library.json 의 groups
 * @param {Array}  o.plan     사이트별 구역 계획
 * @param {object} o.vars     makeVars 결과
 * @param {number} o.seed     (사이트, 지역, 키워드) 시드
 * @param {object} o.extras   { price, contactRows } 빌더가 만들어 주는 것
 */
export function composeArticle(o) {
  const {
    lib, plan, vars, seed, extras = {}, dispatchLine = '',
  } = o;
  /*
   * share = { i, n } 이면 묶음을 n 등분해서 i 번째만 쓴다.
   *
   * 다섯 브랜드가 서로 다른 회사로 보여야 하는데, 한 라이브러리를 그대로 나눠 쓰면
   * 두 사이트에 같은 문장이 실린다. 검색엔진이 같은 운영자로 묶어 보기 딱 좋다.
   * 그래서 아예 겹치지 않게 잘라 준다 — 8개짜리 묶음이면 사이트당 4개다.
   */
  const share = o.share;
  const G = (name) => {
    const g = lib[name];
    if (!g || !g.length) throw new Error(`문안 묶음 "${name}" 이 라이브러리에 없습니다.`);
    if (!share || share.n <= 1) return g;
    const mine = g.filter((_, i) => i % share.n === share.i);
    if (!mine.length) throw new Error(`묶음 "${name}" 을 ${share.n} 등분하니 ${share.i} 번 몫이 비었습니다.`);
    return mine;
  };
  const F = (t) => fillVars(t, vars);

  /*
   * 소제목은 "증상 1" 처럼 앞말로 묶여 있다.
   *
   * 나누기를 **종류 안에서** 한다. 전체 목록을 통으로 잘라 나누면 어떤 사이트는
   * FAQ 소제목이 0개가 되어 굽기가 멈춘다 (5등분에서 실제로 났다).
   * 종류마다 따로 나누면 어느 사이트든 모든 종류를 최소 하나는 갖는다.
   */
  const allHeads = {};
  for (const x of (lib['소제목'] || [])) {
    const kind = x.name.replace(/\s*\d+$/, '').trim();
    (allHeads[kind] ||= []).push(x);
  }
  const heads = {};
  for (const [kind, arr] of Object.entries(allHeads)) {
    const mine = (!share || share.n <= 1)
      ? arr
      : arr.filter((_, i) => i % share.n === share.i % Math.max(1, Math.min(share.n, arr.length)));
    heads[kind] = mine.length ? mine : arr;
  }

  /*
   * "site:원인" 은 사이트가 직접 들고 있는 문단을 쓴다는 뜻이다.
   *
   * 공용 라이브러리만으로 3,072편을 찍으면 구역당 문안이 네 개뿐이라 같은 문단이
   * 절반의 글에 실린다. 각 사이트에는 이미 키워드별로 쓴 문단이 있고(싹쓰리는
   * 키워드마다 35개, 도사는 증상·원인·방법별로) 말투도 그 브랜드 것이다.
   * 뼈대와 부속(소제목·표·목록·상자·문답)은 라이브러리에서, 설명 문단은 사이트에서.
   */
  const sitePools = o.sitePools || {};
  const P = (name) => {
    if (!name.startsWith('site:')) return null;
    const key = name.slice(5);
    const arr = sitePools[key];
    if (!arr || !arr.length) throw new Error(`사이트 문단 묶음 "${key}" 가 비었습니다.`);
    /*
     * 빌더가 카드({t,b} · {title,body} · {kw,body})를 문단으로 이어 붙이는데,
     * 필드 이름을 하나 잘못 적으면 "undefined. 의성군 세면대막힘은…" 이 256장에
     * 그대로 박혀 나갔다 (2026-09-01). 조용히 통과시키지 않는다.
     */
    arr.forEach((text, i) => {
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`사이트 문단 "${key}#${i}" 가 글이 아닙니다: ${JSON.stringify(text)}`);
      }
      if (text.includes('undefined') || text.includes('[object Object]')) {
        throw new Error(`사이트 문단 "${key}#${i}" 에 빈 값이 섞였습니다 — 필드 이름을 확인하세요:\n  ${text.slice(0, 90)}`);
      }
    });
    return arr.map((text, i) => ({ name: `${key}#${i}`, text }));
  };

  /* 한 글 안에서 같은 문안을 두 번 쓰지 않는다. */
  const used = new Set();
  const take = (group, n, salt) => {
    const all = P(group) || G(group);
    const pool = all.filter((x) => !used.has(`${group}|${x.name}`));
    const got = pickN(pool.length ? pool : all, n, seed + salt);
    for (const x of got) used.add(`${group}|${x.name}`);
    return got;
  };

  const secs = [];
  plan.forEach((step, n) => {
    const salt = (n + 1) * 101;
    const id = `s${n + 1}`;

    const hPool = heads[step.h];
    if (!hPool) throw new Error(`소제목 묶음 "${step.h}" 이 없습니다.`);
    const hx = pickN(hPool, 1, seed + salt)[0];
    const { h, label } = asHead(hx.text);

    const blocks = [];
    /*
     * 설명 문단. from 을 배열로 주면 여러 묶음에서 나눠 가져온다 —
     * 사이트 제 문단(짧고 그 브랜드 말투)에 라이브러리 문단을 한둘 얹어
     * 길이와 폭을 함께 잡는 데 쓴다. FAQ·요약처럼 문단 없는 구역도 있다.
     */
    const froms = step.from ? [].concat(step.from) : [];
    const counts = [].concat(step.n ?? 2);
    const paras = [];
    froms.forEach((gname, fi) => {
      const cnt = counts[fi] ?? counts[counts.length - 1] ?? 0;
      if (cnt > 0) paras.push(...take(gname, cnt, salt + 7 + fi * 5).map((x) => ({ t: F(x.text) })));
    });
    if (paras.length) blocks.push({ isP: true, p: paras });

    /*
     * 부속은 "ol:원인" 처럼 콜론 뒤에 원하는 문안을 적을 수 있다.
     * 원인을 설명하는 구역에 "부르기 전에 확인할 것" 목록이 붙으면 글이 어긋난다.
     * 지정한 것이 이 사이트 몫에 없으면 그냥 아무거나 가져온다.
     */
    const add = (step.add ? [].concat(step.add) : []).map((x) => {
      const [kind, want] = String(x).split(':');
      return { kind, want };
    });
    /*
     * 힌트에 맞는 것이 **둘 이상일 때만** 힌트를 쓴다.
     *
     * 하나만 맞으면 그 하나가 모든 글에 실린다 — 실제로 드림의 100% 반복 상위가
     * 이것이었다 (2026-09-03). 라이브러리를 삼등분하면 "ol:해결" 에 맞는 것이
     * 사이트당 한 개뿐인 일이 흔하다. 주제가 조금 어긋나는 것보다 256장에 같은
     * 목록이 박히는 편이 나쁘다.
     */
    const prefer = (group, want, n, s2) => {
      if (!want) return take(group, n, s2);
      const hit = G(group).filter((x) => x.name.includes(want));
      if (hit.length < 2) return take(group, n, s2);
      const got = pickN(hit, n, seed + s2);
      for (const x of got) used.add(`${group}|${x.name}`);
      return got;
    };
    add.forEach(({ kind, want }, ai) => {
      const s2 = salt + 13 * (ai + 1);
      if (kind === 'ol') {
        const x = prefer('번호 목록', want, 1, s2)[0];
        blocks.push({ isOl: true, ol: asOl(x.text).map((t) => ({ t: F(t) })) });
      } else if (kind === 'summary') {
        const x = prefer('핵심 요약', want, 1, s2)[0];
        const items = asOl(x.text);
        if (items.length) blocks.push({ isOl: true, ol: items.map((t) => ({ t: F(t) })) });
        else blocks.push({ isP: true, p: [{ t: F(x.text) }] });
      } else if (kind === 'table') {
        const x = prefer('예방 표', want, 1, s2)[0];
        const { head, rows } = asTable(x.text);
        blocks.push({
          isTable: true,
          head: head.map((t) => ({ t: F(t) })),
          rows: rows.map((r) => ({ cells: r.map((t) => ({ t: F(t) })) })),
        });
      } else if (kind === 'check') {
        const x = prefer('체크리스트', want, 1, s2)[0];
        blocks.push({ isCheck: true, items: asCheck(x.text).map((t) => ({ t: F(t) })) });
      } else if (kind === 'box') {
        const x = prefer('강조 상자', want, 1, s2)[0];
        blocks.push({
          isBox: true, boxTone: boxTone(x.name), boxTitle: boxTitle(x.name), boxText: F(x.text),
        });
      } else if (kind === 'faq') {
        const got = take('FAQ', step.faqCount ?? 4, s2).map((x) => {
          const { q, a } = asFaq(x.text);
          return { q: F(q), a: F(a) };
        }).filter((x) => x.q && x.a);
        if (got.length) blocks.push({ isFaq: true, faq: got });
      } else if (kind === 'price') {
        if (extras.price) blocks.push({ isTable: true, head: extras.price.head, rows: extras.price.rows });
      } else if (kind === 'cost') {
        const x = prefer('비용 설명', want, 1, s2)[0];
        blocks.push({ isP: true, p: [{ t: F(x.text) }] });
      } else {
        throw new Error(`모르는 구역 부속 "${kind}"`);
      }
    });

    secs.push({ id, h: F(h), label: F(label), blocks });
  });

  /*
   * 출동시간은 구조화 데이터(LocalBusiness.slogan)에도 들어간다. 화면에 없는 말을
   * 스키마에만 적으면 구조화 데이터 위반이라, 마지막 구역에 한 줄로 노출한다.
   *
   * 문안은 사이트 json 의 facts.dispatchLine 에서 온다. 여기에 문장을 박아 두면
   * 세 사이트에 똑같은 줄이 실린다 — 처음에 그렇게 썼다가 검사에서 시군구 수만큼
   * (256건씩) 겹치는 것으로 잡혔다. 사실은 같아도 말투는 브랜드 것이어야 한다.
   */
  if (vars.출동시간 && dispatchLine && secs.length) {
    secs[secs.length - 1].blocks.push({ isP: true, p: [{ t: F(dispatchLine) }] });
  }

  /* 도입부 = 공감 문단 + 본문으로 넘기는 한 줄 (레퍼런스의 "그렇다면 …") */
  const intro = take('도입부', 1, 3)[0];
  const bridge = take('도입 마무리 문장', 1, 5)[0];

  /*
   * 해시태그. 문서에 섞인 인용(>) 줄은 버린다 — 그대로 두면
   * "중괄호를 제거하고 …" 같은 작성 지침이 태그 자리에 찍힌다.
   * 태그 안의 {지역} 은 시군구만 쓴다. "충남 공주시" 를 넣으면 공백에서 끊긴다.
   */
  const tagVars = { ...vars, 지역: vars.해시지역 };
  const tagLine = take('해시태그', 1, 9)[0];
  const tagSrc = tagLine.text.split('\n').filter((l) => !l.trim().startsWith('>')).join(' ');
  const hashtags = [...new Set([
    `#${vars.해시지역}${vars.메인키워드}`,
    ...fillVars(tagSrc, tagVars).split(/\s+/).filter((t) => /^#\S/.test(t)),
  ])].slice(0, 7);

  return {
    intro: F(intro.text),
    bridge: F(bridge.text),
    secs,
    toc: secs.map((x) => ({ id: x.id, h: x.h })),
    hashtags: hashtags.map((t) => ({ t })),
  };
}

/** 글자수 — 태그를 빼고 순수 본문만. 검수용. */
export function charCount(art) {
  const parts = [art.intro, art.bridge];
  for (const s of art.secs) {
    parts.push(s.h, s.label);
    for (const b of s.blocks) {
      if (b.isP) parts.push(...b.p.map((x) => x.t));
      if (b.isOl) parts.push(...b.ol.map((x) => x.t));
      if (b.isCheck) parts.push(...b.items.map((x) => x.t));
      if (b.isBox) parts.push(b.boxText);
      if (b.isFaq) parts.push(...b.faq.map((x) => `${x.q}${x.a}`));
      if (b.isTable) {
        for (const r of b.rows) parts.push(...r.cells.map((x) => x.t));
      }
    }
  }
  return parts.join('').replace(/\s+/g, '').length;
}

/* ── 마크업 ── */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 조립한 글을 HTML 로 뽑는다.
 *
 * 클래스 이름은 다섯 사이트가 같고 CSS 만 다르다. 마크업까지 사이트마다 다르게
 * 만들면 문안을 하나 고칠 때마다 다섯 군데를 손봐야 한다 — 구조가 아니라
 * 생김새로 구분되게 둔다.
 *
 * 표는 가로로 넘칠 수 있어 감싸는 상자에 스크롤을 준다. 모바일에서 표 하나가
 * 페이지 전체를 옆으로 밀어버리는 일을 막는다.
 */
export function renderArticleHtml(art, { tocTitle = '목차' } = {}) {
  const out = [];
  out.push(`<p class="alead">${esc(art.intro)}</p>`);

  out.push(`<nav class="atoc" aria-label="${esc(tocTitle)}"><p class="atoct">${esc(tocTitle)}</p><ol>`);
  for (const t of art.toc) out.push(`<li><a href="#${t.id}">${esc(t.h)}</a></li>`);
  out.push('</ol></nav>');

  out.push(`<p class="abridge">${esc(art.bridge)}</p>`);

  for (const s of art.secs) {
    out.push(`<section class="asec" id="${s.id}"><h2>${esc(s.h)}</h2>`);
    if (s.label) out.push(`<p class="alab">${esc(s.label)}</p>`);
    for (const b of s.blocks) {
      if (b.isP) for (const x of b.p) out.push(`<p>${esc(x.t)}</p>`);
      if (b.isOl) {
        out.push('<ol class="anum">');
        for (const x of b.ol) out.push(`<li>${esc(x.t)}</li>`);
        out.push('</ol>');
      }
      if (b.isCheck) {
        out.push('<ul class="achk">');
        for (const x of b.items) out.push(`<li>${esc(x.t)}</li>`);
        out.push('</ul>');
      }
      if (b.isBox) {
        out.push(`<aside class="abox abox-${b.boxTone}"><p class="aboxt">${esc(b.boxTitle)}</p>`
          + `<p>${esc(b.boxText)}</p></aside>`);
      }
      if (b.isTable) {
        out.push('<div class="atw"><table class="atab">');
        if (b.head.length) {
          out.push(`<thead><tr>${b.head.map((c) => `<th>${esc(c.t)}</th>`).join('')}</tr></thead>`);
        }
        out.push('<tbody>');
        for (const r of b.rows) {
          out.push(`<tr>${r.cells.map((c, i) => (i === 0
            ? `<th scope="row">${esc(c.t)}</th>` : `<td>${esc(c.t)}</td>`)).join('')}</tr>`);
        }
        out.push('</tbody></table></div>');
      }
      if (b.isFaq) {
        out.push('<div class="afaq">');
        for (const x of b.faq) {
          out.push(`<div class="afq"><p class="afqq">${esc(x.q)}</p><p class="afqa">${esc(x.a)}</p></div>`);
        }
        out.push('</div>');
      }
    }
    out.push('</section>');
  }
  return out.join('\n');
}

/** FAQPage 구조화 데이터용. 글 안의 문답을 그대로 넘긴다. */
export function faqEntities(art) {
  const qa = [];
  for (const s of art.secs) {
    for (const b of s.blocks) if (b.isFaq) qa.push(...b.faq);
  }
  return qa.map((x) => ({
    '@type': 'Question',
    name: x.q,
    acceptedAnswer: { '@type': 'Answer', text: x.a },
  }));
}
