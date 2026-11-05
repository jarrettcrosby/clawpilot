#!/usr/bin/env node
// Pure PHP row-transport gate. Never starts Docker, a DB, or SuiteCRM.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
const path='services/suitecrm/email-audience/NativeEmailInitialPolicyDelta.php'
const source=readFileSync(new URL('../'+path,import.meta.url),'utf8')
for(const method of ['tables','fingerprint','assertBefore','restoreBefore','projectAfter'])assert.ok(source.includes('function '+method+'('))
assert.match(source,/initial_delta_default_identity/);assert.match(source,/initial_delta_email_link_not_new/)
assert.match(source,/initial_delta_postimage_changed/);assert.doesNotMatch(source,/\b(?:mysqli|PDO|exec|shell_exec|file_put_contents)\s*\(/)
console.log('PASS initial policy delta static contract exposes exact row transport only; not PHP/native execution proof')
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')),'Use optional --php=/absolute/php')
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const result=spawnSync(php,['scripts/fixtures/native-email-initial-policy-delta.php'],{encoding:'utf8',timeout:10000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length){console.log('SKIP pure PHP execution: local PHP is unavailable; run the fixture in the separately owned PHP runtime');process.exit(0)}
assert.ifError(result.error);assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''))
assert.match(result.stdout,/NATIVE_INITIAL_POLICY_DELTA_PASSED=6/);process.stdout.write(result.stdout)
