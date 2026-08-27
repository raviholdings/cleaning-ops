/**
 * .env 를 process.env 로 읽어 들인다.
 *
 * Git Bash 에서 `set -a; . ./.env; set +a` 를 앞에 붙이지 않고 그냥
 * `node scripts/…` 로 실행해도 AWS·R2 자격증명이 잡히게 하려는 것이다.
 * 안 붙이면 UnrecognizedClientException("security token is invalid") 이 난다.
 *
 * 이미 셸에 있는 값은 덮지 않는다 — 셸 쪽이 우선이다.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadLocalEnv(file = '.env') {
  let text;
  try {
    text = readFileSync(resolve(projectRoot, file), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
