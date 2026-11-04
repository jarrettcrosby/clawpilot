#!/usr/bin/env node
// Real TS issuer/real PHP verifier, synthetic trusted-store edge. No DB/Docker.
import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {isAbsolute} from 'node:path'
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')))
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const raw=execFileSync(process.execPath,['scripts/test-native-email-initial-approval.mjs','--emit-fixture'],{encoding:'utf8',timeout:15000})
const prefix='CLAWPILOT_NATIVE_INITIAL_APPROVAL_FIXTURE=',lines=raw.split('\n').filter(line=>line.startsWith(prefix))
assert.equal(lines.length,1);const fixture=JSON.parse(lines[0].slice(prefix.length));assert.equal(fixture.syntheticOnly,true)
const result=spawnSync(php,['scripts/fixtures/native-email-initial-approval-interop.php'],{input:JSON.stringify(fixture),encoding:'utf8',timeout:15000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length){console.log('SKIP actual TS/PHP initial approval interop: local PHP unavailable; execute fixture in parent-owned PHP runtime');process.exit(0)}
assert.ifError(result.error);assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''));assert.match(result.stdout,/NATIVE_INITIAL_TS_PHP_APPROVAL_PASSED=1/)
process.stdout.write(result.stdout)
