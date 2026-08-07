/**
 * 초경량 템플릿 엔진 (Mustache 부분집합).
 *
 * Astro 를 걷어내는 목적이라 의존성을 새로 들이면 안 된다. 필요한 문법은
 * 네 가지뿐이고, 전부 합쳐 200줄이 안 된다.
 *
 *   {{name}}          값을 HTML 이스케이프해서 넣는다
 *   {{{name}}}        이스케이프 없이 그대로 넣는다 (JSON-LD, 미리 만든 마크업)
 *   {{#name}}…{{/name}}   배열이면 반복, 참이면 한 번, 거짓/빈배열이면 생략
 *   {{^name}}…{{/name}}   거짓/빈배열일 때만 렌더 (else 자리)
 *
 * 반복 안에서는 `{{.}}` 이 현재 항목, `{{field}}` 가 항목의 속성이다.
 * 항목에 없는 이름은 바깥 스코프에서 찾는다 (Mustache 와 같은 규칙).
 * `{{a.b}}` 처럼 점으로 파고들 수 있다.
 *
 * 없는 이름은 조용히 빈 문자열이 되지 않는다. 30만 페이지를 찍는데 오타 하나가
 * 조용히 빈칸으로 나가면 배포하고 나서야 안다. strict 모드(기본값)에서는
 * 던진다. 일부러 비울 자리는 {{#name}} 로 감싸면 된다.
 */

const TAG = /\{\{(\{)?\s*([#^/&]?)\s*([\w.$]+)\s*(\})?\}\}/g;

/** HTML 텍스트 노드/속성값 이스케이프. Astro 의 기본 동작과 같은 범위. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 템플릿 문자열 -> 토큰 트리.
 * 같은 템플릿을 사이트마다 100번씩 쓰므로 한 번만 파싱하고 재사용한다.
 */
export function parseTemplate(source, templateName = '<template>') {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let cursor = 0;

  TAG.lastIndex = 0;
  let match = TAG.exec(source);

  while (match) {
    const [raw, tripleOpen, sigil, name, tripleClose] = match;
    const top = stack[stack.length - 1];

    if (match.index > cursor) {
      top.children.push({ type: 'text', value: source.slice(cursor, match.index) });
    }
    cursor = match.index + raw.length;

    // {{{x}}} 와 {{&x}} 는 같은 뜻이다.
    const isRaw = Boolean(tripleOpen && tripleClose) || sigil === '&';

    if (sigil === '#' || sigil === '^') {
      const node = { type: 'section', name, inverted: sigil === '^', children: [], line: lineOf(source, match.index) };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      if (stack.length === 1) {
        throw new Error(`${templateName}:${lineOf(source, match.index)} 여는 태그 없이 {{/${name}}} 가 나왔습니다.`);
      }
      const opened = stack.pop();
      if (opened.name !== name) {
        throw new Error(
          `${templateName}:${lineOf(source, match.index)} {{#${opened.name}}} 를 {{/${name}}} 로 닫으려 했습니다.`,
        );
      }
    } else {
      top.children.push({ type: 'value', name, raw: isRaw, line: lineOf(source, match.index) });
    }

    match = TAG.exec(source);
  }

  if (cursor < source.length) {
    stack[stack.length - 1].children.push({ type: 'text', value: source.slice(cursor) });
  }
  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1];
    throw new Error(`${templateName}:${unclosed.line} {{#${unclosed.name}}} 가 닫히지 않았습니다.`);
  }

  return { name: templateName, root };
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

const MISSING = Symbol('missing');

/** 스코프 체인을 안쪽부터 훑는다. 못 찾으면 MISSING. */
function lookup(scopes, name) {
  if (name === '.') return scopes[scopes.length - 1];

  const path = name.split('.');
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    let value = scopes[i];
    if (value === null || value === undefined) continue;
    if (!(path[0] in Object(value))) continue;

    let ok = true;
    for (const key of path) {
      if (value === null || value === undefined || !(key in Object(value))) { ok = false; break; }
      value = value[key];
    }
    if (ok) return value;
  }
  return MISSING;
}

/**
 * 토큰 트리 렌더.
 * @param {{name:string, root:object}} template parseTemplate 결과
 * @param {object} data 최상위 스코프
 * @param {{strict?: boolean}} options
 */
export function renderTemplate(template, data, options = {}) {
  const strict = options.strict !== false;
  const out = [];

  function walk(node, scopes) {
    for (const child of node.children) {
      if (child.type === 'text') {
        out.push(child.value);
        continue;
      }

      const value = lookup(scopes, child.name);

      if (child.type === 'value') {
        if (value === MISSING) {
          if (strict) {
            throw new Error(`${template.name}:${child.line} 템플릿 변수 {{${child.name}}} 를 데이터에서 찾을 수 없습니다.`);
          }
          continue;
        }
        if (value === null || value === undefined || value === false) continue;
        out.push(child.raw ? String(value) : escapeHtml(value));
        continue;
      }

      // section
      const resolved = value === MISSING ? undefined : value;
      const truthy = Array.isArray(resolved) ? resolved.length > 0 : Boolean(resolved);

      if (child.inverted) {
        if (!truthy) walk(child, scopes);
        continue;
      }
      if (!truthy) continue;

      if (Array.isArray(resolved)) {
        for (const item of resolved) {
          scopes.push(item);
          walk(child, scopes);
          scopes.pop();
        }
      } else if (typeof resolved === 'object') {
        scopes.push(resolved);
        walk(child, scopes);
        scopes.pop();
      } else {
        // 스칼라 참 -> 조건문처럼 한 번만
        walk(child, scopes);
      }
    }
  }

  walk(template.root, [data]);
  return out.join('');
}

/** 파싱 + 렌더 한 번에. 반복 호출할 거면 parseTemplate 를 캐시할 것. */
export function render(source, data, options = {}) {
  return renderTemplate(parseTemplate(source, options.name), data, options);
}

/**
 * 템플릿이 요구하는 변수 이름 전부. Gemini 가 만든 HTML 을 받았을 때
 * "이 자리들을 채워야 한다"를 기계적으로 확인하는 용도.
 */
export function templateVariables(template) {
  const names = new Set();
  (function walk(node) {
    for (const child of node.children) {
      if (child.type === 'text') continue;
      if (child.name !== '.') names.add(child.name);
      if (child.type === 'section') walk(child);
    }
  })(template.root);
  return [...names].sort();
}
