/**
 * apex 홈페이지용 SVG 그래픽.
 *
 * heroArt() 는 히어로 사진이 없는 루트의 폴백이다. 2026-08-26 에 운영자가
 * 사진 10장을 넣어서 지금은 열 개 다 사진을 쓴다 — 사진이 빠지거나 루트가
 * 늘면 다시 이 도식이 나온다.
 *
 * 서브도메인이 쓰는 청소 500장·배관 9장은 여기 끌어다 쓰지 말 것.
 * apex 를 만드는 이유가 "네트워크와 달라 보이게" 인데 같은 이미지를 얹으면
 * 그 부분이 무너진다. 히어로 사진은 apex 전용으로 따로 받은 것이다.
 */

/** variant 를 씨앗으로 쓰는 결정적 난수. 같은 루트는 항상 같은 그림이 나온다. */
function seeded(seed) {
  let s = (seed + 1) * 9301;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/**
 * 히어로 도식 — 배관 라인이 꺾여 흐르는 모양. 청소·이사에서는 동선으로 읽힌다.
 * variant 마다 꺾이는 지점과 분기가 달라진다.
 */
export function heroArt(variant, accent) {
  const rnd = seeded(variant);
  const W = 720;
  const H = 260;
  const cols = 7;
  const step = W / cols;
  const lanes = [70, 130, 190];

  const runs = [];
  for (let r = 0; r < 3; r += 1) {
    let y = lanes[Math.floor(rnd() * lanes.length)];
    let d = `M 0 ${y}`;
    const nodes = [];
    for (let c = 1; c <= cols; c += 1) {
      const x = c * step;
      const turn = rnd() > 0.45;
      if (turn) {
        const ny = lanes[Math.floor(rnd() * lanes.length)];
        if (ny !== y) {
          const midX = x - step * 0.45;
          d += ` L ${midX - 14} ${y} Q ${midX} ${y} ${midX} ${y + (ny > y ? 14 : -14)}`;
          d += ` L ${midX} ${ny + (ny > y ? -14 : 14)} Q ${midX} ${ny} ${midX + 14} ${ny}`;
          nodes.push([midX, ny]);
          y = ny;
        }
      }
      d += ` L ${x} ${y}`;
    }
    runs.push({ d, nodes, w: r === 0 ? 5 : 2.5, o: r === 0 ? 1 : 0.28 });
  }

  const ticks = Array.from({ length: cols + 1 }, (_, c) => c * step);

  return `<svg class="art" viewBox="0 0 ${W} ${H}" role="img" aria-label="작업 흐름 도식" preserveAspectRatio="xMidYMid slice">
  <g class="art-grid">${ticks.map((x) => `<line x1="${x}" y1="24" x2="${x}" y2="${H - 24}" />`).join('')}</g>
  ${runs.map((r) => `<path d="${r.d}" fill="none" stroke="${accent}" stroke-width="${r.w}" stroke-opacity="${r.o}" stroke-linecap="round" stroke-linejoin="round" />`).join('\n  ')}
  ${runs[0].nodes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6.5" fill="${accent}" /><circle cx="${x}" cy="${y}" r="12" fill="none" stroke="${accent}" stroke-opacity=".3" />`).join('\n  ')}
</svg>`;
}

/** 서비스 카드용 선 아이콘. 업종별로 4종. */
const ICONS = {
  drop: '<path d="M12 3.2 C 12 3.2 5.5 10.4 5.5 14.4 a6.5 6.5 0 0 0 13 0 C 18.5 10.4 12 3.2 12 3.2 Z"/>',
  wrench: '<path d="M15.4 3.6a5 5 0 0 0-6.2 6.2L3.6 15.4a2 2 0 0 0 2.8 2.8l5.6-5.6a5 5 0 0 0 6.2-6.2l-2.8 2.8-2.4-.6-.6-2.4z"/>',
  gauge: '<circle cx="12" cy="12" r="8.4"/><path d="M12 12 15.6 8.4M12 3.6v1.8M20.4 12h-1.8M12 20.4v-1.8M3.6 12h1.8"/>',
  pipe: '<path d="M3.2 8.4h9.2a4 4 0 0 1 4 4v7.2M3.2 5.6v5.6M16.4 15.2h4.4"/>',
  spray: '<path d="M9.2 8.4h5.6v12H9.2zM9.2 8.4V5.6h5.6v2.8M17.2 4.4l2.4-.8M17.2 7.6l2.4.4M17.2 10.8l2.4 1.6"/>',
  house: '<path d="M3.6 10.8 12 4l8.4 6.8v8.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z"/>',
  sparkle: '<path d="M12 3.6l1.9 5.3 5.3 1.9-5.3 1.9L12 18l-1.9-5.3L4.8 10.8l5.3-1.9zM18.8 16.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  brush: '<path d="M6.4 14.8 14.8 6.4a2.6 2.6 0 0 1 3.6 3.6L10 18.4zM6.4 14.8 4 20.8l6-2.4"/>',
  box: '<path d="M3.6 7.6 12 3.6l8.4 4v8.8L12 20.4l-8.4-4z"/><path d="M3.6 7.6 12 11.6l8.4-4M12 11.6v8.8"/>',
  truck: '<path d="M2.8 6.4h10.4v9.2H2.8zM13.2 9.6h3.6l3.6 3.2v2.8h-7.2z"/><circle cx="6.8" cy="18" r="1.8"/><circle cx="17.2" cy="18" r="1.8"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.2 2"/>',
  route: '<circle cx="5.6" cy="6" r="2.4"/><circle cx="18.4" cy="18" r="2.4"/><path d="M5.6 8.4v5.2a4 4 0 0 0 4 4h6.4"/>',
  valve: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.2v5.6M12 15.2v5.6M3.2 12h5.6M15.2 12h5.6"/>',
  hose: '<path d="M4 19.2c0-6 3.2-8 8-8s6-1.6 6-4.4"/><circle cx="18" cy="4.4" r="2"/><path d="M2.8 19.2h3.2"/>',
  camera: '<rect x="3" y="7.2" width="13" height="10" rx="2"/><path d="M16 11l4.4-2.4v7.2L16 13.4z"/>',
  alert: '<path d="M12 3.6 21.2 20H2.8z"/><path d="M12 10v4M12 17h.01"/>',
  window: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="1.6"/><path d="M12 3.6v16.8M3.6 12h16.8"/>',
  mop: '<path d="M12 2.8v9.2"/><path d="M8 12h8l-1.2 8.4H9.2z"/><path d="M9.6 15.6h4.8"/>',
  air: '<path d="M3.2 8h11.2a2.8 2.8 0 1 0-2.8-2.8"/><path d="M3.2 12.8h14a3.2 3.2 0 1 1-3.2 3.2"/>',
  shine: '<path d="M12 4.4v3.2M12 16.4v3.2M4.4 12h3.2M16.4 12h3.2M6.6 6.6l2.3 2.3M15.1 15.1l2.3 2.3M17.4 6.6l-2.3 2.3M8.9 15.1l-2.3 2.3"/><circle cx="12" cy="12" r="2.6"/>',
  ladder: '<path d="M7.2 3.2v17.6M16.8 3.2v17.6M7.2 7.6h9.6M7.2 12h9.6M7.2 16.4h9.6"/>',
  wrap: '<path d="M4 8.4h16v11.2H4z"/><path d="M4 8.4 8 3.6h8l4 4.8M12 3.6v16"/>',
  calendar: '<rect x="3.6" y="5.2" width="16.8" height="15.2" rx="1.6"/><path d="M3.6 10h16.8M8 3.2v4M16 3.2v4"/>',
  store: '<path d="M3.6 8.8 5.2 4h13.6l1.6 4.8"/><path d="M3.6 8.8h16.8v11.6H3.6z"/><path d="M9.2 20.4v-6h5.6v6"/>',
};

// 업종마다 8종. 루트마다 시작 위치를 달리해서 같은 업종이라도 아이콘이 겹치지 않는다.
const ICON_SET = {
  piping: ['drop', 'pipe', 'wrench', 'gauge', 'valve', 'hose', 'camera', 'alert'],
  cleaning: ['spray', 'house', 'sparkle', 'brush', 'window', 'mop', 'air', 'shine'],
  moving: ['box', 'truck', 'route', 'clock', 'ladder', 'wrap', 'calendar', 'store'],
};

// 테마별 고유 입체감 이모지/배지 세트 (3D 깊이감 및 테마 정체성 부여)
const THEME_EMOJIS = {
  appish: ['📦', '🚚', '🗺️', '⏱️', '🪜', '🎁', '📅', '🏬'],
  'warm-utility': ['🚰', '🚽', '🛠️', '🔍', '🫧', '🚿', '👨‍🔧', '🏡'],
  emergency: ['🚨', '⚡', '🪠', '🌊', '🚜', '🔴', '🚒', '⏱️'],
  organic: ['🌿', '🧼', '🫧', '🍋', '🪟', '🍃', '🏡', '🌸'],
  brutal: ['⚡', '💥', '🧹', '🏢', '🏗️', '🧽', '💨', '💰'],
  glass: ['💧', '🫧', '🧪', '🛡️', '🌊', '🌪️', '💎', '🧊'],
  luxe: ['⚜️', '📦', '🗝️', '🕰️', '🏛️', '💎', '🏷️', '👑'],
  clinic: ['🔬', '🧪', '🩺', '🛡️', '🫧', '🧼', '🥼', '✨'],
  hud: ['📡', '🎯', '🔍', '📊', '⚡', '💻', '📐', '🛡️'],
  blueprint: ['📐', '⚙️', '🔩', '📏', '🔧', '🚰', '📋', '🎯'],
};

export function serviceIcon(vertical, i, offset = 0, themeKey = '') {
  if (themeKey && THEME_EMOJIS[themeKey]) {
    const list = THEME_EMOJIS[themeKey];
    const emoji = list[(i + offset) % list.length];
    return `<div class="dim-ico ${themeKey}"><span class="dim-emoji" role="img" aria-hidden="true">${emoji}</span></div>`;
  }
  const names = ICON_SET[vertical] || ICON_SET.cleaning;
  const key = names[(i + offset) % names.length];
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key]}</svg>`;
}

/** CTA 버튼 앞 아이콘. 전화면 수화기, 견적이면 문서. */
export function ctaIcon(type) {
  const d = type === 'phone'
    ? '<path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z"/>'
    : '<path d="M6 2.6h8l4.4 4.4v14.4H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2.6V7h4.4M9 12.4h6M9 16h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 24 24" fill="${type === 'phone' ? 'currentColor' : 'none'}" aria-hidden="true">${d}</svg>`;
}
