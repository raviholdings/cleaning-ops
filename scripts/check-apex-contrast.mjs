#!/usr/bin/env node
/**
 * apex 시안의 글자/배경 대비를 실제 CSS 캐스케이드를 풀어서 검사한다.
 *
 *   node scripts/build-apex-site.mjs --all --preview   # 먼저 빌드
 *   node scripts/check-apex-contrast.mjs
 *   node scripts/check-apex-contrast.mjs --all         # 통과한 것까지 전부 출력
 *
 * 왜 이렇게 만들었나: 처음에는 면 구성을 손으로 적어 두고 검사했는데,
 * 테마가 카드 배경을 바꿀 때마다 모델이 어긋나서 "어두운 배경에 어두운 글씨"를
 * 세 번 연속 놓쳤다. 이제는 빌드된 apex.css 를 파싱해서 우선순위(명시도 ·
 * !important · 등장 순서)대로 실제 적용될 색을 계산한다.
 *
 * 한계: 가상요소(::before)·hover·미디어쿼리는 건너뛴다. 본문 글자만 본다.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const showAll = process.argv.includes('--all');
const buildDir = resolve(projectRoot, 'tmp/apex');
if (!existsSync(buildDir)) {
  throw new Error('tmp/apex 가 없다. node scripts/build-apex-site.mjs --all --preview 를 먼저 돌릴 것.');
}

/* ── 색 계산 ─────────────────────────────────────────── */
const NAMED = { white: '#ffffff', black: '#000000', transparent: 'transparent' };

function parseColor(v) {
  if (!v) return null;
  const s = v.trim();
  if (NAMED[s]) return s === 'transparent' ? { t: true } : parseColor(NAMED[s]);
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const f = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)), a: 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: p.slice(0, 3).map(Math.round), a: p[3] === undefined ? 1 : p[3] };
  }
  // color-mix(in srgb, X N%, Y)
  m = s.match(/^color-mix\(\s*in\s+srgb\s*,(.+)\)$/i);
  if (m) {
    const parts = splitTop(m[1]);
    if (parts.length !== 2) return null;
    const [aRaw, bRaw] = parts;
    const pm = aRaw.match(/(.+?)\s+([\d.]+)%\s*$/);
    if (!pm) return null;
    const pct = parseFloat(pm[2]) / 100;
    const A = parseColor(pm[1].trim());
    const B = parseColor(bRaw.trim());
    if (!A || !B) return null;
    if (A.t) return { rgb: B.rgb, a: (B.a ?? 1) * (1 - pct) };
    if (B.t) return { rgb: A.rgb, a: (A.a ?? 1) * pct };
    return { rgb: A.rgb.map((c, i) => Math.round(c * pct + B.rgb[i] * (1 - pct))), a: 1 };
  }
  return null;
}
function splitTop(str) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of str) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const composite = (fg, bg) => (!fg ? bg : fg.t ? bg : fg.a >= 1 ? fg.rgb
  : fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a))));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/* ── CSS 파싱 · 매칭 ─────────────────────────────────── */
/** 중괄호를 직접 세면서 최상위 규칙만 뽑는다.
 *  정규식으로 @media 를 걷어내려다 뒤에 오는 규칙까지 통째로 먹은 적이 있다. */
function parseRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let order = 0;
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const head = src.slice(i, open).trim();
    let depth = 0;
    let j = open;
    for (; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = src.slice(open + 1, j);
    i = j + 1;
    if (head.startsWith('@')) continue;   // @media·@keyframes 안쪽은 안 본다
    for (const sel of head.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/::|:hover|:focus/.test(sel)) continue;
      rules.push({ sel, parts: sel.split(/\s+/), decls: body, order: order += 1, spec: specificity(sel) });
    }
  }
  return rules;
}
const specificity = (sel) => (sel.match(/\./g) || []).length * 10 + (sel.match(/\[/g) || []).length * 10
  + (sel.split(/\s+/).filter((p) => /^[a-z]/i.test(p)).length);

/** el = {tag, classes:[]}, path = 조상부터 자신까지 */
const matchPart = (part, el) => {
  const tag = part.match(/^[a-z]+/i);
  if (tag && el.tag !== tag[0]) return false;
  for (const c of part.match(/\.[a-zA-Z0-9_-]+/g) || []) if (!el.classes.includes(c.slice(1))) return false;
  return true;
};
function matches(parts, path) {
  let i = parts.length - 1;
  let j = path.length - 1;
  if (!matchPart(parts[i], path[j])) return false;
  i -= 1; j -= 1;
  while (i >= 0) {
    let found = false;
    while (j >= 0) { if (matchPart(parts[i], path[j])) { found = true; j -= 1; break; } j -= 1; }
    if (!found) return false;
    i -= 1;
  }
  return true;
}
function declValue(decls, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+?)(\\s*!important)?\\s*(?=;|$)', 'g');
  let last = null;
  for (const m of decls.matchAll(re)) last = { value: m[1].trim(), important: Boolean(m[2]) };
  return last;
}
/** path 의 마지막 원소에 적용될 prop 값 (var() 는 vars 로 푼다) */
function resolve1(rules, path, prop, vars) {
  let best = null;
  for (const r of rules) {
    if (!matches(r.parts, path)) continue;
    const d = declValue(r.decls, prop);
    if (!d) continue;
    const key = [d.important ? 1 : 0, r.spec, r.order];
    if (!best || cmp(key, best.key) > 0) best = { key, value: d.value };
  }
  return best ? expand(best.value, vars) : null;
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
function expand(v, vars, depth = 0) {
  if (depth > 8) return v;
  return v.replace(/var\(\s*(--[a-z-]+)\s*(?:,([^)]*))?\)/gi, (_, name, fb) => {
    const got = vars[name];
    return got !== undefined ? expand(got, vars, depth + 1) : (fb ? fb.trim() : '');
  });
}
/** 조상들이 선언한 커스텀 프로퍼티를 모아 내려온다 */
function collectVars(rules, path, seed) {
  const vars = { ...seed };
  for (let d = 1; d <= path.length; d += 1) {
    const sub = path.slice(0, d);
    const found = [];
    for (const r of rules) {
      if (!matches(r.parts, sub)) continue;
      if (!matchPart(r.parts[r.parts.length - 1], sub[sub.length - 1])) continue;
      for (const m of r.decls.matchAll(/(?:^|;)\s*(--[a-z-]+)\s*:\s*([^;]+?)(\s*!important)?\s*(?=;|$)/g)) {
        found.push({ name: m[1], value: m[2].trim(), key: [m[3] ? 1 : 0, r.spec, r.order] });
      }
    }
    const bestOf = {};
    for (const f of found) if (!bestOf[f.name] || cmp(f.key, bestOf[f.name].key) > 0) bestOf[f.name] = f;
    for (const [n, f] of Object.entries(bestOf)) vars[n] = expand(f.value, vars);
  }
  return vars;
}
/** 배경은 투명하면 조상으로 올라간다 */
function effectiveBg(rules, path, vars) {
  for (let d = path.length; d >= 1; d -= 1) {
    const sub = path.slice(0, d);
    const raw = resolve1(rules, sub, 'background-color', vars) || firstColorOf(resolve1(rules, sub, 'background', vars));
    const c = parseColor(raw);
    if (c && !c.t && c.a > 0) {
      if (c.a >= 1) return c.rgb;
      const under = effectiveBg(rules, path.slice(0, d - 1), vars) || [255, 255, 255];
      return composite(c, under);
    }
  }
  return null;
}
const firstColorOf = (v) => {
  if (!v) return null;
  const m = v.match(/^(#[0-9a-f]{3,6}|rgba?\([^)]*\)|color-mix\([^]*\)|transparent|white|black)/i);
  return m ? m[1] : null;
};
/** 색은 상속된다 */
function effectiveColor(rules, path, vars) {
  for (let d = path.length; d >= 1; d -= 1) {
    const raw = resolve1(rules, path.slice(0, d), 'color', vars);
    const c = parseColor(raw);
    if (c && !c.t) return c;
  }
  return null;
}

/* ── 검사 대상 ───────────────────────────────────────── */
const el = (tag, ...classes) => ({ tag, classes });
const CHECKS = [
  ['카드 본문', ['section', 'div.wrap', 'ul.grid.cards', 'li.card', 'div.card-body', 'p']],
  ['카드 제목', ['section', 'div.wrap', 'ul.grid.cards', 'li.card', 'div.card-body', 'h3']],
  ['사례 본문', ['section', 'div.wrap', 'ol.cases', 'li', 'p']],
  ['사례 제목', ['section', 'div.wrap', 'ol.cases', 'li', 'h3']],
  ['후기 본문', ['section', 'div.wrap', 'ul.reviews', 'li', 'p']],
  ['순서 본문', ['section', 'div.wrap', 'ol.steps', 'li', 'p']],
  ['순서 제목', ['section', 'div.wrap', 'ol.steps', 'li', 'h3']],
  ['요금 셀', ['section', 'div.wrap', 'div.tbl-wrap', 'table.tbl', 'tbody', 'td']],
  ['FAQ 답변', ['section', 'div.wrap', 'dl.faq', 'dd']],
  ['지역 칩', ['section', 'div.wrap', 'ul.chips', 'li']],
  ['섹션 본문', ['section', 'div.wrap', 'p.body']],
];
const toEl = (s) => {
  const tag = (s.match(/^[a-z]+/i) || [''])[0];
  return el(tag, ...(s.match(/\.[a-zA-Z0-9_-]+/g) || []).map((c) => c.slice(1)));
};

let worst = { r: 99 };
let fails = 0;
let checked = 0;
const roots = readdirSync(buildDir).filter((d) => existsSync(join(buildDir, d, 'assets/apex.css')));

for (const root of roots) {
  const html = readFileSync(join(buildDir, root, 'index.html'), 'utf8');
  const bodyClasses = (html.match(/<body class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
  const rules = parseRules(readFileSync(join(buildDir, root, 'assets/apex.css'), 'utf8'));
  const seed = {};
  for (const m of (html.match(/<style>:root\{([^}]*)\}<\/style>/) || [, ''])[1].matchAll(/(--[a-z-]+):([^;]+)/g)) {
    seed[m[1]] = m[2].trim();
  }

  const bad = [];
  for (const band of ['', 'alt']) {
    const bandEl = el('section', 'band', ...(band ? ['alt'] : []));
    for (const [label, chain] of CHECKS) {
      const path = [el('body', ...bodyClasses), bandEl, ...chain.slice(1).map(toEl)];
      const vars = collectVars(rules, path, seed);
      const bg = effectiveBg(rules, path, vars);
      const fg = effectiveColor(rules, path, vars);
      if (!bg || !fg) continue;
      const fgRgb = composite(fg, bg);
      const r = ratio(fgRgb, bg);
      checked += 1;
      if (r < worst.r) worst = { r, root, label, band };
      if (r < 4.5) { fails += 1; bad.push(`${band ? '어두운밴드' : '밝은밴드'} ${label} ${r.toFixed(1)}`); }
    }
  }
  if (bad.length || showAll) {
    console.log(`  ${root.padEnd(19)} ${bad.length ? '✗ ' + bad.join(' · ') : '통과'}`);
  }
}

console.log(`\n${checked}쌍 검사 · 4.5 미만 ${fails}건`
  + (worst.root ? ` · 최저 ${worst.r.toFixed(1)}:1 (${worst.root} ${worst.band ? '어두운밴드' : '밝은밴드'} ${worst.label})` : ''));
if (fails) process.exitCode = 1;
