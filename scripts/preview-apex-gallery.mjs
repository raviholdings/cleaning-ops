#!/usr/bin/env node
/**
 * apex 시안 10개를 한 페이지에 모아 비교용 HTML 을 만든다.
 *
 *   node scripts/build-apex-site.mjs --all --preview   # 먼저 시안을 뽑고
 *   node scripts/preview-apex-gallery.mjs              # 그다음 이걸 돌린다
 *   -> tmp/apex-gallery.html
 *
 * iframe 도 스크립트도 안 쓴다. 아티팩트/샌드박스 환경에서 srcdoc iframe 과
 * <dialog>.showModal() 이 막히는 경우가 있어서, 사이트 본문을 그대로 인라인하고
 * CSS 를 .pv 로 스코프해 넣는다. 히어로 사진은 data URI 로 박는다.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(repo, 'tmp', 'apex-gallery.html');
const content = JSON.parse(readFileSync(join(repo, 'data/apex/apex-content.json'), 'utf8'));
const rawCss = [
  readFileSync(join(repo, 'apps/apex-static/apex-template/assets/apex.css'), 'utf8'),
  readFileSync(join(repo, 'apps/apex-static/apex-template/assets/themes.css'), 'utf8'),
].join('\n');

/** 셀렉터마다 접두사를 붙인다. body/:root/html 은 래퍼 자체가 되고,
 *  레이아웃 변주 클래스(.l-*, .v-*)도 래퍼에 붙으므로 공백 없이 이어 붙인다. */
function prefixCss(css, prefix) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const sel = css.slice(i, open).trim();
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = css.slice(open + 1, j);
    if (sel.startsWith('@media')) {
      out += `${sel}{${prefixCss(body, prefix)}}`;
    } else if (sel.startsWith('@')) {
      // @keyframes 안의 0%/from 은 셀렉터가 아니다. 접두사를 붙이면 깨진다.
      out += `${sel}{${body}}`;
    } else {
      const scoped = sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        if (s === ':root' || s === 'html' || s === 'body') return prefix;
        if (s.startsWith('body')) return prefix + s.slice(4);
        if (/^.(l-|v-|t-|ttl-)/.test(s)) return prefix + s;   // body 에 붙는 클래스들
        return `${prefix} ${s}`;
      });
      out += `${scoped.join(',')}{${body}}`;
    }
    i = j + 1;
  }
  return out;
}

const sites = [];
for (const [root, conf] of Object.entries(content.roots)) {
  const file = join(repo, 'tmp/apex', root, 'index.html');
  if (!existsSync(file)) { console.log('없음:', file); continue; }
  const html = readFileSync(file, 'utf8');
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/);
  if (!bodyMatch) { console.log('body 못 찾음:', root); continue; }
  const bodyClass = (bodyMatch[1].match(/class="([^"]*)"/) || [, ''])[1];
  let inner = bodyMatch[2];
  inner = inner.replace(/<a class="skip"[\s\S]*?<\/a>/, '');           // 페이지 내 건너뛰기 링크는 미리보기에서 불필요
  inner = inner.replace(/<a\b([^>]*)href="[^"]*"/g, '<span$1 data-link');  // 갤러리 안에서 이동하지 않게
  inner = inner.replace(/<\/a>/g, '</span>');
  // 리빌 스크립트는 갤러리에서 필요 없다. html 에 .js 클래스가 없어 전부 그냥 보인다.
  inner = inner.replace(/<script[\s\S]*?<\/script>/g, '');
  // 견적 폼은 /go/quote 로 302 되는 외부 폼이라 아티팩트 안에서는 못 띄운다.
  inner = inner.replace(/<iframe[\s\S]*?<\/iframe>/g,
    '<div class="form-stub"><strong>무료 견적 폼</strong>'
    + '<span>/go/quote — 청소 서브도메인이 쓰는 폼 그대로. 실제 배포본에서만 뜹니다.</span></div>');
  // 히어로 사진은 상대경로라 아티팩트에서 못 읽는다. data URI 로 박아 넣는다.
  const heroPath = join(repo, 'tmp/apex', root, 'assets/hero.webp');
  if (existsSync(heroPath)) {
    const b64 = readFileSync(heroPath).toString('base64');
    inner = inner.split('src="assets/hero.webp"').join(`src="data:image/webp;base64,${b64}"`);
  }
  const spec = content.specialties[conf.specialty];
  const theme = content.themes[conf.theme];
  const palette = theme.palette;
  const layout = content.layouts[conf.variant % content.layouts.length];
  const headline = content.headlines[conf.variant % content.headlines.length];
  sites.push({
    root, brand: conf.brand, label: spec.label, tagline: spec.tagline,
    vertical: content.verticals[spec.vertical].label,
    accent: palette.accent, 
    layout: layout.name, order: layout.order, headline: headline.h1,
    theme: conf.theme, themeLabel: theme.label,
    vars: `--ink:${palette.ink};--paper:${palette.paper};--accent:${palette.accent};--haze:${palette.haze};--mute:${palette.mute};--line:${palette.line}`,
    bodyClass, inner,
  });
}

const SECTION_KO = { intro:'소개', services:'서비스', price:'요금', cases:'사례', faq:'FAQ', process:'과정', reviews:'후기', area:'지역' };
const scopedCss = prefixCss(rawCss, '.pv');

const card = (s, i) => `
    <article class="card">
      <div class="thumb"><div class="pv ${s.bodyClass}" style="${s.vars}">${s.inner}</div></div>
      <div class="meta">
        <div class="idline">
          <span class="dot" style="background:${s.accent}"></span>
          <h2>${s.brand}</h2>
          <span class="tag">${s.vertical}</span><span class="tag">${s.themeLabel}</span>
        </div>
        <p class="spec">${s.label}</p>
        <p class="host">${s.root}</p>
        <p class="head">&ldquo;${s.headline}&rdquo;</p>
        <ul class="order">${s.order.map((o) => `<li>${SECTION_KO[o] || o}</li>`).join('')}</ul>
      </div>
    </article>`;

const full = (s, i) => `
    <details class="full"${i === 0 ? ' open' : ''}>
      <summary>
        <span class="dot" style="background:${s.accent}"></span>
        <strong>${s.brand}</strong>
        <span class="sm">${s.label} · ${s.themeLabel} · ${s.root}</span>
      </summary>
      <div class="stage"><div class="pv ${s.bodyClass}" style="${s.vars}">${s.inner}</div></div>
    </details>`;

const page = `<title>Apex 홈페이지 시안</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hahmlet:wght@500;700&family=IBM+Plex+Sans+KR:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --bg:#eef0f3;--surface:#fff;--surface-2:#f6f7f9;
  --fg:#171a20;--muted:#5f6773;--faint:#8b929e;
  --line:#dcdfe6;--line-strong:#c6cad4;--accent:#3d4a6b;
  --shadow:0 1px 2px rgba(20,24,34,.06),0 10px 28px rgba(20,24,34,.07);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#101318;--surface:#191d24;--surface-2:#14171d;
  --fg:#e6e9ef;--muted:#98a0ad;--faint:#6d7681;
  --line:#272c35;--line-strong:#39404b;--accent:#9aa8cd;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#101318;--surface:#191d24;--surface-2:#14171d;
  --fg:#e6e9ef;--muted:#98a0ad;--faint:#6d7681;
  --line:#272c35;--line-strong:#39404b;--accent:#9aa8cd;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px rgba(0,0,0,.35);
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;
  line-height:1.65;word-break:keep-all;-webkit-font-smoothing:antialiased}
.wrap{width:min(100% - 2.5rem,82rem);margin-inline:auto}

header.top{padding:clamp(2.6rem,6vw,4.2rem) 0 0}
.kicker{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.72rem;
  letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0 0 1rem}
h1{font-family:"Hahmlet","Apple SD Gothic Neo",serif;font-weight:700;
  font-size:clamp(1.9rem,4.4vw,3rem);line-height:1.25;letter-spacing:-.025em;
  margin:0 0 .7rem;text-wrap:balance}
.sub{color:var(--muted);max-width:46rem;margin:0;font-size:clamp(.98rem,1.6vw,1.06rem)}
.axes{display:flex;flex-wrap:wrap;margin:2.2rem 0 0;border:1px solid var(--line);
  border-radius:12px;background:var(--surface);overflow:hidden;box-shadow:var(--shadow)}
.axis{flex:1 1 8rem;padding:.95rem 1.1rem;border-right:1px solid var(--line)}
.axis:last-child{border-right:none}
.axis dt{font-size:.73rem;letter-spacing:.05em;color:var(--faint);margin:0 0 .25rem}
.axis dd{margin:0;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:1.3rem;
  font-weight:500;font-variant-numeric:tabular-nums}
.axis dd small{font-family:"IBM Plex Sans KR",sans-serif;font-size:.78rem;font-weight:400;
  color:var(--muted);margin-left:.25rem}

h3.sec{font-family:"Hahmlet",serif;font-size:1.3rem;font-weight:700;letter-spacing:-.02em;
  margin:3rem 0 .4rem}
p.secnote{color:var(--muted);font-size:.9rem;margin:0 0 1.3rem;max-width:46rem}

.grid{display:grid;gap:1.1rem;grid-template-columns:repeat(auto-fill,minmax(18.5rem,1fr))}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column}
.thumb{height:240px;overflow:hidden;border-bottom:1px solid var(--line);
  background:var(--surface-2);position:relative}
.thumb .pv{zoom:.30;width:1240px}
.meta{padding:1rem 1.1rem 1.15rem;flex:1}
.idline{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.dot{width:.64rem;height:.64rem;border-radius:50%;flex:none;
  box-shadow:inset 0 0 0 1px rgba(0,0,0,.14)}
.meta h2{font-family:"Hahmlet",serif;font-weight:700;font-size:1.14rem;margin:0;
  letter-spacing:-.02em;line-height:1.3}
.tag{font-size:.69rem;letter-spacing:.04em;color:var(--muted);
  border:1px solid var(--line-strong);border-radius:999px;padding:.06rem .48rem}
.spec{margin:.45rem 0 0;font-size:.89rem}
.host{margin:.12rem 0 0;font-family:"IBM Plex Mono",ui-monospace,monospace;
  font-size:.75rem;color:var(--faint)}
.head{margin:.65rem 0 0;font-size:.85rem;color:var(--muted);font-style:italic}
.order{display:flex;flex-wrap:wrap;gap:.28rem;list-style:none;padding:0;margin:.75rem 0 0}
.order li{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.67rem;color:var(--muted);
  background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:.08rem .36rem}

.full{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin-bottom:.7rem;overflow:hidden;box-shadow:var(--shadow)}
.full summary{cursor:pointer;padding:.85rem 1.1rem;display:flex;align-items:center;
  gap:.6rem;flex-wrap:wrap;list-style:none;user-select:none}
.full summary::-webkit-details-marker{display:none}
.full summary::after{content:"펼치기";margin-left:auto;font-size:.76rem;color:var(--accent)}
.full[open] summary::after{content:"접기"}
.full summary:hover{background:var(--surface-2)}
.full summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.full summary strong{font-family:"Hahmlet",serif;font-size:1.05rem;letter-spacing:-.02em}
.full summary .sm{font-size:.8rem;color:var(--muted)}
.stage{border-top:1px solid var(--line);overflow-x:auto;background:var(--surface-2)}
.stage .pv{zoom:.66;width:1240px}

footer.note{border-top:1px solid var(--line);margin-top:3rem;padding:1.6rem 0 3.5rem;
  color:var(--muted);font-size:.87rem}
footer.note p{margin:0 0 .6rem;max-width:54rem}
footer.note strong{color:var(--fg);font-weight:600}
footer.note code{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:.85em;
  background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.05em .35em}

/* 인라인된 시안 본문. 갤러리 안에서는 고정 헤더와 링크가 방해가 된다. */
.pv{border-radius:0}
.pv header.site{position:static !important}
.pv [data-link]{text-decoration:none;cursor:default}
.pv .skip{display:none}
.pv .fab{display:none !important}
.pv header.site{position:static !important;backdrop-filter:none}
.pv .band.split .wrap > h2{position:static !important}
.pv .hero.has-photo{min-height:420px}
.pv .fab{display:none !important}
.pv header.site{position:static !important;backdrop-filter:none}
.pv .band.split .wrap > h2{position:static !important}
.pv .form-stub{display:flex;flex-direction:column;gap:.35rem;align-items:center;
  justify-content:center;min-height:200px;padding:2rem 1.5rem;text-align:center;
  border:1px dashed var(--line-strong);border-radius:8px;background:var(--surface-2)}
.pv .form-stub strong{font-size:1rem;color:var(--fg)}
.pv .form-stub span{font-size:.85rem;color:var(--muted)}
@media (max-width:40rem){.axis{flex-basis:50%;border-bottom:1px solid var(--line)}}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}

${scopedCss}
</style>

<div class="wrap">
  <header class="top">
    <p class="kicker">apex / root domain</p>
    <h1>루트 도메인 10개에 세울 홈페이지</h1>
    <p class="sub">지금 루트는 6개가 404, 4개가 서브도메인 심볼릭 링크입니다. 8/22 사태를 넘긴 참고 사이트 세 곳은 전부 루트에 실체가 있었고 우리만 없었습니다. 그 자리를 채울 시안 10종 — 배관은 전화, 청소·이사는 견적 폼으로 갈렸고 섹션 제목도 루트마다 다릅니다.</p>
    <dl class="axes">
      <div class="axis"><dt>루트</dt><dd>10<small>개</small></dd></div>
      <div class="axis"><dt>세부 분야</dt><dd>10<small>종</small></dd></div>
      <div class="axis"><dt>레이아웃</dt><dd>5<small>종</small></dd></div>
      <div class="axis"><dt>팔레트</dt><dd>10<small>종</small></dd></div>
      <div class="axis"><dt>디자인 방향</dt><dd>10<small>종</small></dd></div>
    </dl>
  </header>

  <main>
    <h3 class="sec">한눈에</h3>
    <p class="secnote">루트마다 디자인 방향이 통째로 다릅니다 — 폰트·색·모서리·테두리·그림자·장식이 전부 갈립니다. 실제 사이트에서는 스크롤에 따라 순차로 올라오지만, 갤러리는 스크립트 없이 도는 미리보기라 전부 펼쳐진 상태입니다.</p>
    <div class="grid">${sites.map(card).join('')}
    </div>

    <h3 class="sec">크게 보기</h3>
    <p class="secnote">제목을 누르면 펼쳐집니다. 좁은 화면에서는 옆으로 밀어서 보실 수 있습니다.</p>
    ${sites.map(full).join('')}
  </main>

  <footer class="note">
    <p><strong>서로 겹치지 않게 한 것</strong> — 같은 배관이라도 분야를 갈랐습니다(막힘 / 주방·욕실 / 악취 / 하수관 / 누수). 서비스·요금·사례·FAQ가 전부 다른 내용이고 섹션 순서·팔레트도 다릅니다. 브랜드명과 도메인명을 지운 뒤 본문 해시를 떠도 10개가 전부 다릅니다.</p>
    <p><strong>서브도메인과 겹치지 않게 한 것</strong> — 스타일시트를 따로 씁니다(서브도메인은 assets.&lt;루트&gt;/site/v4). 지역은 시/도 단위만 씁니다(서브도메인은 읍면동). 루트에서 서브도메인으로 링크하지 않습니다.</p>
    <p><strong>연락 동선</strong> — 배관 5개는 헤더·히어로·하단·우측 하단 버튼이 전부 <code>tel:070-7106-5241</code> 로 갑니다. 청소·이사 5개는 <code>/form.html</code> 전용 페이지로 보내고 본문에서는 폼을 뺐습니다. 청소는 <code>/go/quote</code>, 이사는 <code>/go/move-quote</code> 로 서로 다른 폼입니다.</p>
    <p><strong>배포 전에 반드시 바꿔야 할 것</strong> — 이용후기와 작업사례는 제가 지어낸 예시입니다. 지어낸 후기를 그대로 두면 표시광고법상 거짓·과장 광고 소지가 있고, 지금 피하려는 저품질 판정에서 정확히 표적이 되는 신호입니다. 실제 후기·작업기록으로 교체해야 합니다. 이름·날짜를 안 넣은 것도 그래서입니다. 브랜드명 10개도 제가 지은 것이라 바꾸실 수 있습니다.</p>
  </footer>
</div>
`;

writeFileSync(outFile, page, 'utf8');
console.log(`사이트 ${sites.length}개 · ${(Buffer.byteLength(page) / 1024).toFixed(0)}KB → ${outFile}`);
console.log(`iframe ${page.includes('<iframe') ? '있음(문제)' : '없음'} · script ${page.includes('<script') ? '있음(문제)' : '없음'} · dialog ${page.includes('<dialog') ? '있음(문제)' : '없음'}`);
