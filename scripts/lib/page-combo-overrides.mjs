import { createHash } from 'node:crypto';

export function pageComboOverrideItem(row) {
  return {
    sourcePageId: Number(row?.sourcePageId ?? row?.source_page_id),
    globalSlot: Number(row?.globalSlot ?? row?.global_slot),
    locationId: Number(row?.locationId ?? row?.location_id),
    location: String(row?.location || ''),
    mainKeywordId: Number(row?.mainKeywordId ?? row?.main_keyword_id),
    mainKeyword: String(row?.mainKeyword ?? row?.main_keyword ?? '')
  };
}

export function createPageComboOverrideMirror(items) {
  const canonicalItems = (items || [])
    .map(pageComboOverrideItem)
    .sort((left, right) => left.sourcePageId - right.sourcePageId);
  return {
    schemaVersion: 1,
    count: canonicalItems.length,
    sha256: createHash('sha256').update(JSON.stringify(canonicalItems)).digest('hex'),
    items: canonicalItems
  };
}

export function pageComboOverrideMirrorsMatch(left, right) {
  return Boolean(left && right)
    && Number(left.schemaVersion) === 1
    && Number(right.schemaVersion) === 1
    && Number(left.count) === Number(right.count)
    && String(left.sha256 || '').trim().toLowerCase()
      === String(right.sha256 || '').trim().toLowerCase();
}

export function pageComboOverrideMirrorExtends(previous, next) {
  const empty = createPageComboOverrideMirror([]);
  const previousMirror = previous || empty;
  const nextMirror = next || empty;
  const canonicalPrevious = createPageComboOverrideMirror(previousMirror.items || []);
  const canonicalNext = createPageComboOverrideMirror(nextMirror.items || []);
  if (!pageComboOverrideMirrorsMatch(previousMirror, canonicalPrevious)
    || !pageComboOverrideMirrorsMatch(nextMirror, canonicalNext)
    || canonicalNext.count < canonicalPrevious.count) {
    return false;
  }

  const nextBySourcePageId = new Map(canonicalNext.items.map((item) => [item.sourcePageId, item]));
  for (const item of canonicalPrevious.items) {
    if (JSON.stringify(nextBySourcePageId.get(item.sourcePageId)) !== JSON.stringify(item)) return false;
  }
  const previousIds = new Set(canonicalPrevious.items.map((item) => item.sourcePageId));
  const previousMaxSourcePageId = canonicalPrevious.items.at(-1)?.sourcePageId || 0;
  return canonicalNext.items.every((item) => (
    previousIds.has(item.sourcePageId) || item.sourcePageId > previousMaxSourcePageId
  ));
}
