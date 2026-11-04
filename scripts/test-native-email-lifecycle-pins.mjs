#!/usr/bin/env node
// Fast source-contract check only. This does not prove native installation,
// native ACL behavior, timing, database transactions or production acceptance.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function hashMap(source, start, end) {
  const from = source.indexOf(start)
  assert.ok(from >= 0 && source.indexOf(start, from + start.length) === -1, 'Unique pinned declaration required')
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, 'Complete pinned declaration required')
  const entries = [...source.slice(from + start.length, to).matchAll(/'([^']+)'\s*=>\s*'([a-f0-9]{64})'/g)]
    .map(match => [match[1], match[2]])
  assert.ok(entries.length > 0)
  assert.equal(new Set(entries.map(([path]) => path)).size, entries.length, 'Duplicate source pin refused')
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

const patch = readFileSync('services/suitecrm/native-email-scope/Patch.php', 'utf8')
const lifecycle = readFileSync('scripts/fixtures/native-email-audience-real/managed-email-lifecycle-helper.php', 'utf8')
const outputs = hashMap(patch, 'function clawpilot_native_scope_output_hashes(): array', '\n}\n')
const independent = hashMap(lifecycle, '    $expected = [', '\n    ];')
assert.equal(Object.keys(outputs).length, 6, 'Reviewed native scope contains six patched stock files')
assert.deepEqual(independent, outputs, 'Independent lifecycle inventory must attest every exact prepared output')
const profile = hashMap(lifecycle, '    $pins = [', '\n    ];')
assert.equal(profile['modules/SecurityGroups/SecurityGroup.php'], outputs['modules/SecurityGroups/SecurityGroup.php'],
  'Lifecycle profile must attest the prepared SecurityGroup implementation, not its stock input')
assert.match(lifecycle, /hash_equals\(\$hash,\$manifest\[\$path\]\)/,
  'Manifest values must be compared with independent reviewed pins, not merely with their own files')
assert.match(lifecycle, /!is_link\(\$path\)/, 'Prepared native files cannot be substituted with symlinks')
console.log('PASS independent lifecycle inventory and profile match all six reviewed prepared native outputs; source contract only')
