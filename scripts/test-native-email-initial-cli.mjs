#!/usr/bin/env node
// Never starts Docker/DB. Local PHP is optional; static checks are not cold
// bootstrap or native runtime proof. Parent coordinates real PHP/container use.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {isAbsolute} from 'node:path'
const source=readFileSync('services/suitecrm/native-email-initial-cli.php','utf8')
for(const name of ['options','artifact','protected_file','identity','cold_bootstrap','installation','run'])assert.ok(source.includes('function cp_initial_cli_'+name+'('))
assert.match(source,/\$GLOBALS\['installing'\]=true;/)
assert.match(source,/finally\{unset\(\$GLOBALS\['installing'\]\);\}/)
assert.doesNotMatch(source,/call_custom_logic\s*\(|->save\s*\(|openssl_sign\s*\(|file_put_contents\s*\(|shell_exec\s*\(|\bexec\s*\(/)
assert.doesNotMatch(source,/\$sugar_config\s*\[[^\n]+\]\s*=/)
assert.ok(source.indexOf('cp_initial_cli_pins($artifact);$installed=')<source.indexOf('$db=cp_initial_cli_cold_bootstrap($artifact)'))
assert.match(source,/cp_initial_installation_verify\(\$context,\$db,\$binding\)/)
assert.match(source,/installation_verifier_unavailable/)
assert.match(source,/sourceArtifactDigest/)
assert.match(source,/\['forecast'=>\$result,'installationJournalFingerprint'=>\$installation\['installationJournalFingerprint'\]\]/)
assert.match(source,/installation_proof_action/)
assert.match(source,/SUITECRM_NATIVE_AUTHORITY_SERVICE_USER_ID/)
assert.doesNotMatch(source,/getenv\('SUITECRM_CLIENT_ID'\)/)
console.log('PASS fixed private CLI source contract; no installer/config/DDL/signing/PG activation and no ordinary after-entrypoint hooks; static only')
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')))
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const result=spawnSync(php,['scripts/fixtures/native-email-initial-cli.php'],{encoding:'utf8',timeout:15000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length){console.log('SKIP actual PHP CLI guard execution: no local PHP; requires parent-owned isolated runtime');process.exit(0)}
assert.ifError(result.error);assert.equal(result.status,0,(result.stdout??'')+(result.stderr??''));assert.match(result.stdout,/NATIVE_INITIAL_CLI_PURE_PASSED=5/);process.stdout.write(result.stdout)
