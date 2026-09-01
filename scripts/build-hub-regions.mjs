#!/usr/bin/env node
/**
 * 법정동코드 전체자료(행정표준코드) → data/hub/regions.json
 *
 *   node scripts/build-hub-regions.mjs --src "<법정동코드 전체자료.txt 경로>"
 *
 * 원본은 CP949 · 탭 구분 · CRLF 다. 컬럼은 [법정동코드, 법정동명, 폐지여부].
 * 코드 10자리 = 시도2 + 시군구3 + 읍면동3 + 리2.
 *   ...00000000  시도
 *   ...  000 00  시군구
 *   ...      00  읍면동   ← 여기까지 쓴다
 *   그 외         리      ← 버린다 (검색량 거의 없고 출장 채산도 안 맞는다)
 *
 * 세종특별자치시는 시군구 계층이 없다 (3611000000 -> 3611010100 반곡동).
 * 그래서 시도 자신을 시군구 하나로 세워 계층을 맞춘다.
 *
 * 표기 — 원본이 최신 개편을 반영해 "전남광주통합특별시" 같은 명칭을 쓰는데,
 * 검색어로는 아무도 그렇게 안 친다. 페이지에 쓸 통용 명칭을 shortName 으로 따로 둔다.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : '';
};

const src = valueOf('--src');
if (!src) throw new Error('--src "<법정동코드 전체자료.txt>" 가 필요합니다.');

// CP949 → UTF-8. iconv 가 없으면 원본이 이미 UTF-8 이라고 보고 그대로 읽는다.
let text;
try {
  text = execFileSync('iconv', ['-f', 'CP949', '-t', 'UTF-8', src], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  text = readFileSync(src, 'utf8');
}

/** 검색어로 통하는 짧은 이름. 원본 명칭이 길거나 개편 명칭이면 여기서 바로잡는다. */
const SHORT = {
  서울특별시: '서울',
  부산광역시: '부산',
  대구광역시: '대구',
  인천광역시: '인천',
  대전광역시: '대전',
  울산광역시: '울산',
  전남광주통합특별시: '광주',
  세종특별자치시: '세종',
  경기도: '경기',
  강원특별자치도: '강원',
  충청북도: '충북',
  충청남도: '충남',
  전북특별자치도: '전북',
  전라남도: '전남',
  경상북도: '경북',
  경상남도: '경남',
  제주특별자치도: '제주',
};

const sidos = new Map();     // 코드2 -> { code, name, shortName, sigungu: Map }
const rows = text.split(/\r?\n/).slice(1);
let abolished = 0;
let riSkipped = 0;

for (const line of rows) {
  if (!line) continue;
  const [code, name, state] = line.split('\t');
  if (!code || !name) continue;
  if (state !== '존재') { abolished += 1; continue; }

  const sidoCode = code.slice(0, 2);
  const sggPart = code.slice(2, 5);
  const emdPart = code.slice(5, 8);
  const riPart = code.slice(8, 10);

  if (sggPart === '000') {
    sidos.set(sidoCode, {
      code, name, shortName: SHORT[name] || name, sigungu: new Map(),
    });
    continue;
  }

  let sido = sidos.get(sidoCode);
  if (!sido) {
    /*
     * 세종특별자치시는 시도 코드가 3611000000 이라 시군구 모양으로 들어온다.
     * 부모 시도가 없으면 그 행 자체를 시도로 세운다.
     */
    if (emdPart === '000' && riPart === '00') {
      sidos.set(sidoCode, { code, name, shortName: SHORT[name] || name, sigungu: new Map() });
      continue;
    }
    continue;
  }

  if (emdPart === '000') {
    // "서울특별시 종로구" -> 종로구
    sido.sigungu.set(code.slice(0, 5), {
      code, name, shortName: name.replace(sido.name, '').trim(), dong: [],
    });
    continue;
  }

  if (riPart !== '00') { riSkipped += 1; continue; }

  const sggCode = code.slice(0, 5);
  let sgg = sido.sigungu.get(sggCode);
  if (!sgg) {
    /*
     * 세종처럼 시군구 계층이 없는 시도. 시도 자신을 시군구 하나로 세운다.
     * 이렇게 해야 "시도 -> 시군구 -> 동" 이 전국에서 같은 모양이 된다.
     */
    sgg = { code: `${sggCode}00000`, name: sido.name, shortName: sido.shortName, dong: [] };
    sido.sigungu.set(sggCode, sgg);
  }
  const leaf = name.split(' ').pop();
  sgg.dong.push({ code, name, shortName: leaf, kind: leafKind(leaf) });
}

/*
 * 대표 동 이름. 법정동은 종로1가~6가, 동소문동1가~7가 처럼 잘게 쪼개져 있는데
 * 사람들은 그렇게 검색하지 않는다 ("종로 하수구막힘"이지 "종로3가 하수구막힘"이 아니다).
 * 레퍼런스(하림배관)도 성북구 법정동 39개를 대표 이름 11개로 접어서 쓴다.
 *   동소문동1가~7가 -> 동소문동 · 종로1가~6가 -> 종로 · 상도1동 -> 상도동
 */
function repDongName(leaf) {
  const ga = leaf.replace(/[0-9]+가$/, '');
  if (ga !== leaf) return ga;
  const dong = leaf.replace(/[0-9]+동$/, '동');
  return dong;
}

function leafKind(leaf) {
  if (/읍$/.test(leaf)) return '읍';
  if (/면$/.test(leaf)) return '면';
  if (/동$|동[0-9]*가$/.test(leaf)) return '동';
  return '기타';
}

const out = {
  source: '행정표준코드 법정동코드 전체자료',
  builtFrom: src,
  note: '리(里)는 제외했다. shortName 은 검색어로 통하는 통용 명칭이다 '
    + '(원본의 "전남광주통합특별시" 같은 개편 명칭을 그대로 쓰면 아무도 검색하지 않는다).',
  counts: { sido: 0, sigungu: 0, dong: 0, byKind: {} },
  sido: [],
};

for (const s of [...sidos.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const sggList = [...s.sigungu.values()]
    .filter((g) => g.dong.length)
    .sort((a, b) => a.code.localeCompare(b.code));
  if (!sggList.length) continue;
  out.sido.push({
    code: s.code, name: s.name, shortName: s.shortName,
    sigungu: sggList.map((g) => ({
      code: g.code,
      name: g.name,
      shortName: g.shortName,
      dongCount: g.dong.length,
      // 페이지에 실제로 쓰는 것은 이쪽이다 (중복 제거된 대표 이름).
      repDong: [...new Set(g.dong.map((d) => repDongName(d.shortName)))],
      dong: g.dong,
    })),
  });
  out.counts.sigungu += sggList.length;
  for (const g of sggList) {
    out.counts.dong += g.dong.length;
    for (const d of g.dong) out.counts.byKind[d.kind] = (out.counts.byKind[d.kind] || 0) + 1;
  }
}
out.counts.sido = out.sido.length;

mkdirSync(resolve(projectRoot, 'data/hub'), { recursive: true });
const dest = resolve(projectRoot, 'data/hub/regions.json');
writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);

console.log(`폐지 ${abolished.toLocaleString()}건 · 리 ${riSkipped.toLocaleString()}건 제외`);
console.log(`시도 ${out.counts.sido} · 시군구 ${out.counts.sigungu} · 읍면동 ${out.counts.dong.toLocaleString()}`);
console.log(`  ${Object.entries(out.counts.byKind).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(' · ')}`);
console.log(`저장: ${dest}`);
