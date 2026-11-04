#!/usr/bin/env node
// Bounded source + actual PHP value checks only. No DB/container/provider work.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {isAbsolute} from 'node:path'
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const source=read('services/suitecrm/email-audience/NativeEmailStartupOrigin.php')
for(const value of ['final class ClawPilotNativeEmailStartupOriginAuthority','private function __construct(',
  'function fromProtectedFile(','function assertFor(','function assertLocked(','root_cli_required',
  'cp_initial_private($certificatePath,262144)','cp_initial_installation_verify(',"cp_initial_exact_schema(",
  "'clawpilot-native-email-initial-activation-origin'","'clawpilot-suitecrm-startup'",'OPENSSL_KEYTYPE_RSA',
  "$details['bits']===3072",'openssl_verify(',"$row['state']??null)==='committed'",'function verifyAnchors(',
  "'pipeline_anchor'","'identity_anchor'","'managed_scope_required'","'service_identity'",
  'SELECT DATABASE() AS databaseName,CURRENT_USER() AS databaseUser','ClawPilotNativeEmailRuntime::attest($db)'])assert.ok(source.includes(value),value)
assert.doesNotMatch(source,/\b(?:file_put_contents|openssl_sign|putenv|shell_exec|exec)\s*\(/)
assert.doesNotMatch(source,/\b(?:INSERT INTO|DELETE FROM|UPDATE [a-z_]+ SET)\b/)
assert.doesNotMatch(source,/\b(?:allowUnverified|skipAuth|trusted\s*=\s*true|fakeToken)\b/)
for(const value of ['installationRootOperationId','installationLineageHash','function verifyArtifact(',
  'cp_initial_cli_installation_files($this->artifact)',"cp_initial_cli_installation($this->artifact,$db,'resolve')",
  '$history->inspectCancelledHistory(',"'authorization'=>$this->artifact['authorization']"])assert.ok(source.includes(value),value)
const core=read('services/suitecrm/email-audience/NativeEmailAuthorityTransition.php')
assert.match(core,/function inspectStartupOrigin\(ClawPilotNativeEmailStartupOriginAuthority \$origin\)/)
assert.match(core,/function inspectLocked\(ClawPilotNativeEmailTransaction \$tx,\?ClawPilotNativeEmailStartupOriginAuthority \$origin=null\)/)
assert.ok(core.includes('if($origin===null)$this->caller();'),'ordinary OAuth gate remains mandatory')
assert.ok(core.includes('else $origin->assertLocked($this->db,$this->profile,$this->callerId,$this->oauthClientId,$tx);'))
assert.match(core,/\$snapshot=\$this->inspectLocked\(\$tx,\$origin\);[\s\S]*?\$tx->rollback\(\);return \$snapshot;/)
console.log('PASS startup-origin source/token contract: separate historical fact, protected root capability, same current native invariant body; static only')
const args=process.argv.slice(2);assert.ok(args.length<=1&&(!args.length||args[0].startsWith('--php=')))
const php=args.length?args[0].slice(6):'php';if(args.length)assert.ok(isAbsolute(php))
const result=spawnSync(php,['scripts/fixtures/native-email-startup-origin.php'],{encoding:'utf8',timeout:20000,maxBuffer:100000})
if(result.error?.code==='ENOENT'&&!args.length){console.log('SKIP actual PHP origin validation: local PHP unavailable; execute fixture in parent-owned PHP runtime');process.exit(0)}
assert.ifError(result.error);assert.equal(result.status,0,(result.stderr||'')+(result.stdout||''))
assert.match(result.stdout,/NATIVE_STARTUP_ORIGIN_PURE_PASSED=[1-9][0-9]*/);process.stdout.write(result.stdout)
