#!/usr/bin/env node
// Never starts Docker/DB or accesses providers. PHP gate is explicit if local
// PHP is unavailable; a static check is not native execution proof.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const source=read('services/suitecrm/email-audience/NativeEmailInitialEnrollment.php')
for(const method of ['inspectSource','project','prepare','execute','resolve','cancelExpired','validatePlan'])assert.ok(source.includes('function '+method+'('))
assert.match(source,/clawpilot-native-email-initial-enrollment-approval/)
assert.match(source,/clawpilot-pg-initial-enrollment/)
assert.match(source,/clawpilot-native-email-initial-enrollment-receipt/)
assert.match(source,/initial_outcome_unknown/)
assert.match(source,/initial_approval_not_expired/)
assert.match(source,/initial_operation_cancelled/)
assert.match(source,/verifyCancelledBefore/)
assert.match(source,/admitInitialPolicyDelta/)
assert.match(source,/initial_before_matrix_or_content_changed/)
assert.match(source,/initial_after_matrix_or_content_changed/)
assert.ok(source.indexOf("$this->verifyApproval($plan,$forecast,$authorization,$installation)")<source.indexOf('$tx->admitInitialPolicyDelta($delta)'))
assert.ok(source.indexOf("'approval_json'=>self::canonical($authorization)")<source.indexOf('$tx->commit()'))
assert.doesNotMatch(source,/\b(?:file_put_contents|openssl_sign|putenv|shell_exec|exec)\s*\(/)
assert.doesNotMatch(source,/\$GLOBALS\['sugar_config'\]\s*\[/)
const transaction=read('services/suitecrm/email-audience/NativeEmailTransaction.php')
assert.match(transaction,/COMMIT_DEADLINE_SECONDS = 5/)
assert.match(transaction,/initial_delta_already_admitted/)
assert.match(transaction,/initialPolicyDelta->restoreBefore\(\$table,\$rows\)|\$initialDelta->restoreBefore\(\$table,\$rows\)/)
const runtime=read('services/suitecrm/email-audience/NativeEmailRuntime.php')
for(const stage of ['attestInitialSource','attestInitialInstalled','projectInitialAfter'])assert.ok(runtime.includes('function '+stage+'('))
assert.match(source,/ClawPilotNativeEmailRuntime::attest\(\$this->db\)/)
console.log('PASS initial enrollment source contract keeps prediction, actual runtime stages, signed execution and terminal resolution separate; static only')
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')),'Use optional --php=/absolute/php')
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const result=spawnSync(php,['scripts/fixtures/native-email-initial-enrollment.php'],{encoding:'utf8',timeout:15000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length){console.log('SKIP pure PHP execution: local PHP unavailable; run fixture in parent-owned PHP runtime');process.exit(0)}
assert.ifError(result.error);assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''))
assert.match(result.stdout,/NATIVE_INITIAL_ENROLLMENT_PURE_PASSED=5/);process.stdout.write(result.stdout)
