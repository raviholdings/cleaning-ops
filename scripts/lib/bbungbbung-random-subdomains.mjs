import { createHash } from 'node:crypto';

export const BBUNGBBUNG_SUBDOMAIN_STRATEGIES = Object.freeze({
  REGIONAL_LOCATION: 'regional-location',
  RANDOM_TWO_WORDS: 'random-two-words',
});

export function validateRandomSubdomainWords(values) {
  const words = (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(words)];
  if (unique.length !== words.length) {
    throw new Error(`Random subdomain word list contains ${words.length - unique.length} duplicate(s).`);
  }
  for (const word of unique) {
    if (!/^[a-z][a-z0-9]{2,15}$/.test(word)) {
      throw new Error(`Unsafe random subdomain word: ${word}`);
    }
  }
  if (unique.length < 300) {
    throw new Error(`At least 300 random subdomain words are required; found ${unique.length}.`);
  }
  return unique;
}

export function createRandomTwoWordCandidates(values, seed = 'bbungbbung-random-two-words-v1') {
  const words = validateRandomSubdomainWords(values);
  const candidates = [];
  for (const firstWord of words) {
    for (const secondWord of words) {
      if (firstWord === secondWord) continue;
      candidates.push({
        firstWord,
        secondWord,
        subdomain: `${firstWord}-${secondWord}`,
      });
    }
  }
  deterministicShuffle(candidates, seed);
  return candidates;
}

export function pickAvailableRandomSubdomains({
  candidates,
  count,
  domainRoots,
  usedHosts = new Set(),
  usedSubdomains = new Set(),
}) {
  const roots = [...new Set(
    (domainRoots || []).map(normalizeHost).filter(Boolean),
  )];
  if (!roots.length) throw new Error('At least one domain root is required.');
  const requested = Number(count);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error(`Invalid random subdomain count: ${count}`);
  }

  const selected = [];
  let cursor = 0;
  while (selected.length < requested && cursor < candidates.length) {
    const candidate = candidates[cursor];
    const root = roots[selected.length % roots.length];
    cursor += 1;
    if (usedSubdomains.has(candidate.subdomain)) continue;
    const host = `${candidate.subdomain}.${root}`;
    if (usedHosts.has(host)) continue;
    usedSubdomains.add(candidate.subdomain);
    usedHosts.add(host);
    selected.push({ ...candidate, domainRoot: root, host });
  }
  if (selected.length !== requested) {
    throw new Error(
      `Only ${selected.length} collision-free random subdomains remain; requested ${requested}.`,
    );
  }
  return selected;
}

function deterministicShuffle(values, seed) {
  let state = seedToUint32(seed);
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = xorshift32(state);
    const selected = state % (index + 1);
    [values[index], values[selected]] = [values[selected], values[index]];
  }
}

function seedToUint32(seed) {
  const digest = createHash('sha256').update(String(seed)).digest();
  return digest.readUInt32BE(0) || 0x9e3779b9;
}

function xorshift32(value) {
  let state = value >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}
