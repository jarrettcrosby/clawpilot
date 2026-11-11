#!/usr/bin/env node
// Component proof only: real candidate entrypoint, cached Linux Apache and
// the real maintenance responder, with synthetic volume/DB-facing fixtures.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const emulated = process.argv[2] === '--rosetta-component' && process.platform === 'darwin'
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && emulated),
  'Only the exact cached component image is allowed; --rosetta-component is local to macOS')
const image = 'sha256:0a93e1915ecc872bd05ae169ce66b5eea123b8540d3df231b40b84a556e797e0'
const docker = (args, timeout = 10000) => execFileSync('docker', args, {encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout, maxBuffer:1024*1024}).trim()
assert.equal(docker(['image','inspect','--format','{{.Id}}',image]), image)
const temp = mkdtempSync(join(tmpdir(), 'clawpilot-suitecrm-canary-component-'))
const id = randomUUID(), container = 'clawpilot-suitecrm-canary-component-' + id
const fixture = (name, text, mode=0o644) => writeFileSync(join(temp,name),text,{mode})
const entry = join(temp,'entrypoint.sh')
let created = false, canary, done, err = ''

try {
  let source = readFileSync(resolve('services/suitecrm/entrypoint.sh'),'utf8')
  if (emulated) {
    // Rosetta reports the translator, not Python, from another PID's exe
    // symlink. Modify the disposable copy only, and still require the exact
    // Python executable mapping, argv, comm and maintenance HTTP responder.
    const native = '"$(readlink -f /proc/1/exe)" == "$(readlink -f /usr/bin/python3)"'
    assert.equal(source.split(native).length,2)
    source = source.replace(native, '"$(readlink /proc/1/exe)" == /run/rosetta/rosetta && "$(awk -v exe="$(readlink -f /usr/bin/python3)" \'$2 == "r-xp" && $6 == exe {print "yes"; exit}\' /proc/1/maps)" == yes')
  }
  fixture('entrypoint.sh',source)
  chmodSync(entry,0o755)
  fixture('VERSION','8.10.2\n')
  fixture('index.html','Synthetic SuiteCRM canary component\n')
  fixture('php',`#!/bin/sh
set -eu
case "\${1-}" in
  /opt/clawpilot/native-email-startup-check.php) printf 'legacy\n' ;;
  -r|/opt/clawpilot/bootstrap-client.php) ;;
  '') cat >/dev/null; if [ -z "\${SUITECRM_CONFIG_PATH:-}" ]; then printf 'crm.example.test'; fi ;;
  *) exit 49 ;;
esac
`,0o755)
  fixture('su',`#!/bin/sh
set -eu
case "$*" in
  *cache:clear*|*cache:warmup*|*bootstrap-global-id.php*|*install-email-audience.php*|*bootstrap-image-principals.php*) exit 0 ;;
  *) printf 'Unexpected mock su: %s\n' "$*" >&2; exit 50 ;;
esac
`,0o755)
  const setup = `set -eu
    root=/var/lib/suitecrm/app
    mkdir -p "$root/public/legacy/Api/V8/OAuth2"
    cp /fixture/VERSION "$root/VERSION"
    cp /fixture/index.html "$root/public/index.html"
    touch "$root/public/legacy/config.php"
    cp /fixture/VERSION "$root/public/legacy/Api/V8/OAuth2/private.key"
    cp /fixture/VERSION "$root/public/legacy/Api/V8/OAuth2/public.key"
    exec /usr/local/bin/entrypoint.sh`
  const env = {CLAWPILOT_NATIVE_INITIAL_MAINTENANCE:'1',SUITECRM_VERSION:'8.10.2',PORT:'8080',
    SUITECRM_DB_HOST:'fixture',SUITECRM_DB_PORT:'3306',SUITECRM_DB_NAME:'fixture',SUITECRM_DB_USER:'fixture',
    SUITECRM_DB_PASSWORD:'synthetic',SUITECRM_PUBLIC_URL:'https://crm.example.test',SUITECRM_ADMIN_USER:'fixture',
    SUITECRM_ADMIN_PASSWORD:'synthetic_fixture_admin_password',SUITECRM_CLIENT_ID:'0'.repeat(36),SUITECRM_CLIENT_SECRET:'0'.repeat(32),
    PATH:'/fixture:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}
  docker(['run','--detach','--pull','never','--name',container,'--label','clawpilot.suitecrm.canary-fixture='+id,
    '--platform','linux/amd64','--network','none','--read-only','--memory','240m','--memory-swap','240m','--pids-limit','64','--cpus','1',
    '--tmpfs','/run:rw,size=12m','--tmpfs','/tmp:rw,size=16m','--tmpfs','/var/lib/suitecrm:rw,size=16m','--workdir','/',
    '--mount',`type=bind,src=${temp},dst=/fixture,readonly`,
    '--mount',`type=bind,src=${entry},dst=/usr/local/bin/entrypoint.sh,readonly`,
    '--mount',`type=bind,src=${join(temp,'VERSION')},dst=/opt/suitecrm/VERSION,readonly`,
    ...Object.entries(env).flatMap(([key,value])=>['--env',key+'='+value]),'--entrypoint','/bin/bash',image,'-c',setup],30000)
  created = true
  const run = (...args) => docker(['exec',container,...args])
  const http = (port,path,method='GET') => run('curl','--noproxy','*','--silent','--max-time','3','-X',method,
    '--write-out','\n%{http_code}',`http://127.0.0.1:${port}${path}`)
  const waitFor = async (action, check) => {
    const until = Date.now()+18000
    while (Date.now()<until) {
      try { if (check(action())) return } catch { /* pending */ }
      await delay(200)
    }
    throw Error('Component readiness deadline reached: '+err)
  }
  await waitFor(()=>http(8080,'/'),result=>result.endsWith('\n503'))
  const args = ['/usr/local/bin/entrypoint.sh','--upgrade-canary']
  assert.throws(()=>run(...args),/requires the deliberately upgraded installed volume/)
  run('touch','/var/lib/suitecrm/.installed-8.10.2','/var/lib/suitecrm/.installed-8.10.1')
  assert.throws(()=>run(...args),/requires the deliberately upgraded installed volume/)
  run('rm','/var/lib/suitecrm/.installed-8.10.1')
  canary = spawn('docker',['exec',container,...args],{stdio:['ignore','ignore','pipe']})
  done=once(canary,'exit');canary.stderr.on('data',chunk=>{err+=chunk})
  await waitFor(()=>http(18080,'/index.html'),result=>result==='Synthetic SuiteCRM canary component\n\n200')
  const socketRows = run('cat','/proc/net/tcp','/proc/net/tcp6').split('\n').map(s=>s.trim().split(/\s+/))
  assert.deepEqual(socketRows.filter(row=>row[1]?.endsWith(':46A0') && row[3]==='0A').map(row=>row[1]),['0100007F:46A0'])
  assert.match(http(8080,'/_clawpilot/liveness'),/"mode":"maintenance".*\n+200$/)
  assert.match(http(8080,'/index.html'),/"ready":false.*\n+503$/)
  assert.match(http(8080,'/Api/access_token','POST'),/"method_not_allowed".*\n+405$/)
  assert.throws(()=>run(...args),error=>error.status===1 && !String(error.stderr).includes('upgrade canary held'))
  assert.equal(canary.exitCode,null)
  console.log('PASS installed-marker refusals, real loopback-only Apache, serial canary, and unchanged public maintenance responses' +
    (emulated ? ' (fixture-only Rosetta process-identity adaptation; not native release proof)' : ''))
} finally {
  if (created && docker(['inspect','--format','{{index .Config.Labels "clawpilot.suitecrm.canary-fixture"}}',container])===id) {
    docker(['rm','--force',container],15000)
  }
  if (canary) await done.catch(()=>{})
  rmSync(temp,{recursive:true,force:true})
}
