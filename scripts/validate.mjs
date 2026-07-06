#!/usr/bin/env node
// Validates the front matter and required sections of every AIP in AIPS/.
// Zero dependencies — runs on Node >= 18. Usage: node scripts/validate.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AIPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'AIPS');

const HEADER_ORDER = [
  'aip',
  'title',
  'description',
  'author',
  'discussions-to',
  'status',
  'last-call-deadline',
  'type',
  'category',
  'created',
  'requires',
  'withdrawal-reason',
];
const REQUIRED = ['aip', 'title', 'description', 'author', 'discussions-to', 'status', 'type', 'created'];
const STATUSES = ['Draft', 'Review', 'Last Call', 'Final', 'Stagnant', 'Withdrawn', 'Living'];
const TYPES = ['Standards Track', 'Meta', 'Informational'];
const CATEGORIES = ['Core', 'Contracts', 'Interface', 'Economics', 'ASRC'];

let failures = 0;

function fail(file, message) {
  console.error(`  ✗ ${file}: ${message}`);
  failures++;
}

/** Parse a simple `key: value` front matter block. Returns null if malformed. */
function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const fields = [];
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (!kv) return null;
    fields.push([kv[1], kv[2].trim()]);
  }
  return fields;
}

const files = readdirSync(AIPS_DIR).filter((f) => f.endsWith('.md')).sort();
if (files.length === 0) {
  console.error('No AIP files found in AIPS/');
  process.exit(1);
}

for (const file of files) {
  const failuresBefore = failures;
  const content = readFileSync(join(AIPS_DIR, file), 'utf8');

  const fields = parseFrontMatter(content);
  if (!fields) {
    fail(file, 'missing or malformed YAML front matter block');
    continue;
  }
  const map = Object.fromEntries(fields);
  const keys = fields.map(([k]) => k);

  // Unknown or duplicate headers
  for (const key of keys) {
    if (!HEADER_ORDER.includes(key)) fail(file, `unknown front matter field "${key}"`);
  }
  if (new Set(keys).size !== keys.length) fail(file, 'duplicate front matter fields');

  // Canonical header order
  const expected = HEADER_ORDER.filter((k) => keys.includes(k));
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail(file, `front matter fields out of order (expected: ${expected.join(', ')})`);
  }

  // Required fields
  for (const key of REQUIRED) {
    if (!(key in map) || map[key] === '') fail(file, `missing required field "${key}"`);
  }

  // Field values
  if (map.aip && !/^\d+$/.test(map.aip)) {
    fail(file, `"aip" must be a number, got "${map.aip}"`);
  } else if (map.aip && file !== `aip-${map.aip}.md`) {
    fail(file, `filename should be aip-${map.aip}.md to match the aip field`);
  }
  if (map.status && !STATUSES.includes(map.status)) {
    fail(file, `invalid status "${map.status}" (expected one of: ${STATUSES.join(', ')})`);
  }
  if (map.type && !TYPES.includes(map.type)) {
    fail(file, `invalid type "${map.type}" (expected one of: ${TYPES.join(', ')})`);
  }
  if (map.type === 'Standards Track') {
    if (!map.category) fail(file, 'Standards Track AIPs require a "category" field');
    else if (!CATEGORIES.includes(map.category)) {
      fail(file, `invalid category "${map.category}" (expected one of: ${CATEGORIES.join(', ')})`);
    }
  } else if (map.category) {
    fail(file, `"category" is only allowed on Standards Track AIPs`);
  }
  if (map.created && !/^\d{4}-\d{2}-\d{2}$/.test(map.created)) {
    fail(file, `"created" must be in YYYY-MM-DD format, got "${map.created}"`);
  }
  if (map.status === 'Last Call' && !map['last-call-deadline']) {
    fail(file, 'status "Last Call" requires a "last-call-deadline" field');
  }
  if (map['last-call-deadline'] && !/^\d{4}-\d{2}-\d{2}$/.test(map['last-call-deadline'])) {
    fail(file, `"last-call-deadline" must be in YYYY-MM-DD format`);
  }
  if (map.status === 'Withdrawn' && !map['withdrawal-reason']) {
    fail(file, 'status "Withdrawn" requires a "withdrawal-reason" field');
  }
  if (map.author && !/[(@<]/.test(map.author)) {
    fail(file, '"author" must include a GitHub username (@handle) or an <email> for at least one author');
  }
  if (map['discussions-to'] && !/^https?:\/\//.test(map['discussions-to'])) {
    fail(file, '"discussions-to" must be a URL');
  }

  // Required sections
  if (!/^## Security Considerations\s*$/m.test(content)) {
    fail(file, 'missing "## Security Considerations" section');
  }
  if (!content.includes('Copyright and related rights waived via [CC0](../LICENSE).')) {
    fail(file, 'missing CC0 copyright waiver (see AIP-1)');
  }

  if (failures === failuresBefore) console.log(`  ✓ ${file}`);
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} AIP(s) valid.`);
