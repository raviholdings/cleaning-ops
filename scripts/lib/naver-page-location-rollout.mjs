import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PAGE_LOCATION_ROLLOUT_SCHEMA_VERSION = 1;
export const PAGE_LOCATION_ROLLOUT_SOURCES = Object.freeze([
  'legal',
  'administrative',
  'checklist'
]);
export const EXPECTED_PAGE_LOCATION_ROLLOUT_COUNTS = Object.freeze({
  legal: 55_360,
  administrative: 12_909,
  checklist: 4_669,
  total: 72_938
});

const LOCATION_ARRAY_KEYS = Object.freeze({
  legal: ['variants'],
  administrative: ['uniqueVariants'],
  checklist: ['locations', 'additions', 'variants']
});

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function buildPageLocationRolloutPlan({
  legalData,
  administrativeData,
  additionsData,
  enforceExpectedCounts = true
}) {
  const legalBase = locationArrayFromData(legalData, 'legal');
  const administrativeBase = locationArrayFromData(administrativeData, 'administrative');
  const checklist = normalizedUniqueLocations(
    locationArrayFromData(additionsData, 'checklist'),
    'checklist additions'
  );

  const legal = expandLocationVariantList(normalizedUniqueLocations(legalBase, 'legal variants'));
  const legalSet = new Set(legal);
  const administrative = expandLocationVariantList(
    normalizedUniqueLocations(administrativeBase, 'administrative variants')
  ).filter((name) => !legalSet.has(name));
  const priorNames = new Set([...legal, ...administrative]);
  const checklistOverlap = checklist.filter((name) => priorNames.has(name));
  if (checklistOverlap.length) {
    throw new Error(
      `Checklist additions overlap legal/administrative rollout names: ${checklistOverlap.slice(0, 10).join(', ')}`
    );
  }

  const locations = [...legal, ...administrative, ...checklist];
  const counts = Object.freeze({
    legal: legal.length,
    administrative: administrative.length,
    checklist: checklist.length,
    total: locations.length
  });
  if (enforceExpectedCounts) assertExpectedCounts(counts);

  const hashes = Object.freeze({
    legal: pageLocationRolloutHash(legal),
    administrative: pageLocationRolloutHash(administrative),
    checklist: pageLocationRolloutHash(checklist),
    all: pageLocationRolloutHash(locations)
  });
  const rows = [];
  let rolloutOrder = 1;
  for (const [rolloutSource, names] of [
    ['legal', legal],
    ['administrative', administrative],
    ['checklist', checklist]
  ]) {
    for (const name of names) {
      rows.push({ name, rolloutOrder, rolloutSource });
      rolloutOrder += 1;
    }
  }

  return Object.freeze({
    legal: Object.freeze(legal),
    administrative: Object.freeze(administrative),
    checklist: Object.freeze(checklist),
    locations: Object.freeze(locations),
    counts,
    hashes,
    rows: Object.freeze(rows)
  });
}

export function loadPageLocationRolloutPlan({ legalPath, administrativePath, additionsPath }) {
  return buildPageLocationRolloutPlan({
    legalData: readJsonFile(legalPath),
    administrativeData: readJsonFile(administrativePath),
    additionsData: readJsonFile(additionsPath)
  });
}

export function expandLocationVariantList(values) {
  const expanded = new Set();
  for (const value of values) {
    const tokens = normalizeLocationName(value).split(/\s+/).filter(Boolean);
    let variants = [''];
    for (const token of tokens) {
      const choices = locationTokenAliases(token);
      variants = variants.flatMap((base) => choices.map((choice) => base ? `${base} ${choice}` : choice));
    }
    for (const variant of variants) if (variant) expanded.add(variant);
  }
  return [...expanded];
}

export function locationTokenAliases(token) {
  const aliases = new Set([token]);
  if (/^[가-힣]+[시구]$/.test(token) && token.length > 1) aliases.add(token.slice(0, -1));
  const metroAliases = new Map([
    ['서울', '서울시'], ['부산', '부산시'], ['대구', '대구시'], ['인천', '인천시'],
    ['광주', '광주시'], ['대전', '대전시'], ['울산', '울산시'], ['세종', '세종시']
  ]);
  if (metroAliases.has(token)) aliases.add(metroAliases.get(token));
  return [...aliases];
}

export function normalizeLocationName(value) {
  const normalized = String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Location names must not be blank.');
  return normalized;
}

export function pageLocationRolloutHash(values) {
  if (!Array.isArray(values)) throw new Error('pageLocationRolloutHash requires an array.');
  const normalized = values.map((value) => normalizeLocationName(value));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function createPageLocationRolloutSnapshot(plan) {
  assertPlanShape(plan);
  return {
    schemaVersion: PAGE_LOCATION_ROLLOUT_SCHEMA_VERSION,
    source: 'public.naver_page_locations',
    orderColumn: 'rollout_order',
    sourceColumn: 'rollout_source',
    counts: { ...plan.counts },
    hashes: { ...plan.hashes },
    locations: [...plan.locations]
  };
}

export function serializePageLocationRolloutSnapshot(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function validatePageLocationRolloutRows(rows, plan) {
  assertPlanShape(plan);
  if (!Array.isArray(rows)) throw new Error('DB rollout rows must be an array.');
  if (rows.length !== plan.rows.length) {
    throw new Error(`DB rollout row count mismatch: ${rows.length}/${plan.rows.length}.`);
  }

  for (let index = 0; index < plan.rows.length; index += 1) {
    const expected = plan.rows[index];
    const actual = rows[index] || {};
    const order = Number(actual.rollout_order ?? actual.rolloutOrder);
    const source = actual.rollout_source ?? actual.rolloutSource;
    const name = normalizeLocationName(actual.name);
    if (order !== expected.rolloutOrder || source !== expected.rolloutSource || name !== expected.name) {
      throw new Error(
        `DB rollout mismatch at order ${expected.rolloutOrder}: `
        + `expected ${expected.rolloutSource}/${expected.name}, found ${source}/${name} (order ${order}).`
      );
    }
  }

  const locations = rows.map((row) => normalizeLocationName(row.name));
  const counts = countsFromOrderedRows(rows);
  const hashes = hashesFromLocations(locations, counts);
  assertSameCounts(counts, plan.counts, 'DB rollout');
  assertSameHashes(hashes, plan.hashes, 'DB rollout');
  return { counts, hashes, locations };
}

export function validatePageLocationRolloutSnapshot(snapshot, plan, label = 'rollout snapshot') {
  assertPlanShape(plan);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (snapshot.schemaVersion !== PAGE_LOCATION_ROLLOUT_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion mismatch: ${snapshot.schemaVersion}.`);
  }
  if (snapshot.source !== 'public.naver_page_locations'
      || snapshot.orderColumn !== 'rollout_order'
      || snapshot.sourceColumn !== 'rollout_source') {
    throw new Error(`${label} does not identify the naver_page_locations rollout columns.`);
  }
  if (!Array.isArray(snapshot.locations)) throw new Error(`${label}.locations must be an array.`);

  const locations = snapshot.locations.map((name) => normalizeLocationName(name));
  const counts = normalizeCounts(snapshot.counts, `${label}.counts`);
  const hashes = normalizeHashes(snapshot.hashes, `${label}.hashes`);
  assertSameCounts(counts, plan.counts, label);
  assertSameHashes(hashes, plan.hashes, label);
  if (locations.length !== counts.total) {
    throw new Error(`${label} location count mismatch: ${locations.length}/${counts.total}.`);
  }
  const calculatedHashes = hashesFromLocations(locations, counts);
  assertSameHashes(calculatedHashes, hashes, `${label} calculated`);
  if (calculatedHashes.all !== plan.hashes.all) {
    throw new Error(`${label} does not match the DB rollout hash.`);
  }
  return { counts, hashes, locations };
}

export function countsFromOrderedRows(rows) {
  const counts = { legal: 0, administrative: 0, checklist: 0, total: rows.length };
  let sourceIndex = 0;
  for (const row of rows) {
    const source = row.rollout_source ?? row.rolloutSource;
    const expectedSourceIndex = PAGE_LOCATION_ROLLOUT_SOURCES.indexOf(source);
    if (expectedSourceIndex < 0) throw new Error(`Unknown rollout source: ${source}.`);
    if (expectedSourceIndex < sourceIndex || expectedSourceIndex > sourceIndex + 1) {
      throw new Error(`Rollout source segment is not contiguous at ${source}.`);
    }
    sourceIndex = expectedSourceIndex;
    counts[source] += 1;
  }
  return counts;
}

export function hashesFromLocations(locations, counts) {
  const legalEnd = counts.legal;
  const administrativeEnd = legalEnd + counts.administrative;
  const checklistEnd = administrativeEnd + counts.checklist;
  if (checklistEnd !== locations.length || counts.total !== locations.length) {
    throw new Error(`Location segment counts do not total ${locations.length}.`);
  }
  return {
    legal: pageLocationRolloutHash(locations.slice(0, legalEnd)),
    administrative: pageLocationRolloutHash(locations.slice(legalEnd, administrativeEnd)),
    checklist: pageLocationRolloutHash(locations.slice(administrativeEnd, checklistEnd)),
    all: pageLocationRolloutHash(locations)
  };
}

function locationArrayFromData(data, source) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') throw new Error(`${source} location data must be an object or array.`);
  for (const key of LOCATION_ARRAY_KEYS[source]) {
    if (Array.isArray(data[key])) return data[key];
  }
  throw new Error(`${source} location data is missing ${LOCATION_ARRAY_KEYS[source].join(' or ')}.`);
}

function normalizedUniqueLocations(values, label) {
  const normalized = values.map((value) => normalizeLocationName(value));
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw new Error(`${label} contains ${normalized.length - unique.length} duplicate normalized names.`);
  }
  return unique;
}

function assertExpectedCounts(counts) {
  assertSameCounts(counts, EXPECTED_PAGE_LOCATION_ROLLOUT_COUNTS, 'Generated rollout plan');
  if (counts.legal + counts.administrative + counts.checklist !== counts.total) {
    throw new Error('Generated rollout segment counts do not equal the total.');
  }
}

function assertPlanShape(plan) {
  if (!plan || !Array.isArray(plan.locations) || !Array.isArray(plan.rows)) {
    throw new Error('A page-location rollout plan is required.');
  }
}

function normalizeCounts(counts, label) {
  const normalized = {};
  for (const key of ['legal', 'administrative', 'checklist', 'total']) {
    const value = Number(counts?.[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}.${key} must be a non-negative integer.`);
    normalized[key] = value;
  }
  return normalized;
}

function normalizeHashes(hashes, label) {
  const normalized = {};
  for (const key of ['legal', 'administrative', 'checklist', 'all']) {
    const value = String(hashes?.[key] || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}.${key} must be a SHA-256 hex digest.`);
    normalized[key] = value;
  }
  return normalized;
}

function assertSameCounts(actual, expected, label) {
  for (const key of ['legal', 'administrative', 'checklist', 'total']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${label} ${key} count mismatch: ${actual[key]}/${expected[key]}.`);
    }
  }
}

function assertSameHashes(actual, expected, label) {
  for (const key of ['legal', 'administrative', 'checklist', 'all']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${label} ${key} hash mismatch: ${actual[key]}/${expected[key]}.`);
    }
  }
}
