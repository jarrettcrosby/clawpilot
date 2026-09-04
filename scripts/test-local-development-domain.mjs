#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const manager = readFileSync(
  new URL('./manage-local-development-domain.sh', import.meta.url),
  'utf8',
)
const devStart = readFileSync(new URL('./dev-start.sh', import.meta.url), 'utf8')
const hostsHelperUrl = new URL(
  './manage-local-development-hosts.py',
  import.meta.url,
)
const hostsHelper = readFileSync(hostsHelperUrl, 'utf8')
const hostsHelperPath = fileURLToPath(hostsHelperUrl)

const domain = 'dev.aiapp.eigenracing.com'
const begin = '# BEGIN CLAWPILOT LOCAL DEVELOPMENT'
const end = '# END CLAWPILOT LOCAL DEVELOPMENT'

function manageHosts(action, hostsPath) {
  execFileSync(
    '/usr/bin/python3',
    [hostsHelperPath, action, hostsPath, domain, begin, end],
    { stdio: 'pipe' },
  )
}

assert.match(manager, /DOMAIN="dev\.aiapp\.eigenracing\.com"/)
assert.match(manager, /bind 127\.0\.0\.1 ::1/)
assert.match(manager, /reverse_proxy 127\.0\.0\.1:4002/)
assert.match(manager, /mkcert -install/)
assert.match(manager, /launchctl bootstrap system/)
assert.match(manager, /CLAWPILOT_LOCAL_BIND_HOST="127\.0\.0\.1"/)
assert.match(manager, /rewrite_hosts disable/)
assert.match(manager, /Public DNS and Railway were not changed/)
assert.doesNotMatch(manager, /railway (up|environment delete|service delete)/)
assert.doesNotMatch(manager, /<key>HOME<\/key>/)
assert.doesNotMatch(manager, /sudo -n launchctl print/)
assert.match(manager, /--resolve "\$DOMAIN:443:127\.0\.0\.1"/)
assert.match(manager, /verify_hosts_block/)
assert.match(manager, /verify_effective_loopback_resolution/)
assert.match(manager, /is_loopback/)
assert.match(devStart, /CLAWPILOT_LOCAL_PUBLIC_URL/)
assert.match(devStart, /CLAWPILOT_LOCAL_BIND_HOST/)
assert.match(devStart, /CLAWPILOT_LOCAL_BIND_HOST:-127\.0\.0\.1/)
assert.match(devStart, /CLAWPILOT_LOCAL_ALLOW_LAN/)
assert.match(devStart, /Refusing non-loopback bind host/)
assert.match(devStart, /authentication disabled/)
assert.match(devStart, /CLAWPILOT_PUBLIC_URL="\$PUBLIC_URL"/)
assert.match(devStart, /--hostname "\$BIND_HOST"/)
assert.match(hostsHelper, /Unmanaged hosts mapping/)
assert.match(hostsHelper, /Duplicate ClawPilot hosts blocks/)

const fixtureRoot = mkdtempSync(join(tmpdir(), 'clawpilot-local-hosts-'))
try {
  const hostsPath = join(fixtureRoot, 'hosts')
  const base = '127.0.0.1 localhost\n::1 localhost\n'
  const exactBlock = [
    begin,
    `127.0.0.1 ${domain}`,
    `::1 ${domain}`,
    end,
  ].join('\n')

  writeFileSync(hostsPath, base)
  manageHosts('enable', hostsPath)
  assert.equal(readFileSync(hostsPath, 'utf8'), `${base}\n${exactBlock}\n`)
  manageHosts('verify', hostsPath)

  const enabled = readFileSync(hostsPath, 'utf8')
  manageHosts('enable', hostsPath)
  assert.equal(readFileSync(hostsPath, 'utf8'), enabled)

  manageHosts('disable', hostsPath)
  assert.equal(readFileSync(hostsPath, 'utf8'), base)
  manageHosts('disable', hostsPath)
  assert.equal(readFileSync(hostsPath, 'utf8'), base)

  const rejectedFixtures = [
    `${base}127.0.0.1 ${domain}\n`,
    `${base}203.0.113.10 ${domain}\n`,
    `${base}203.0.113.11 ${domain.toUpperCase()}\n`,
    `${base}127.0.0.1 ${domain}.\n`,
    `${base}\n${begin}\n127.0.0.1 ${domain}\n${end}\n`,
    `${base}\n${begin}\n203.0.113.12 ${domain}\n::1 ${domain}\n${end}\n`,
    `${base}\n${exactBlock}\n\n${exactBlock}\n`,
    `${base}\n${begin}\n127.0.0.1 ${domain}\n::1 ${domain}\n`,
    `${base}\n${begin}\n127.0.0.1 ${domain}\n127.0.0.1 ${domain}\n::1 ${domain}\n${end}\n`,
  ]

  rejectedFixtures.forEach((fixture, index) => {
    const invalidPath = join(fixtureRoot, `hosts-invalid-${index}`)
    writeFileSync(invalidPath, fixture)
    assert.throws(() => manageHosts('enable', invalidPath))
    assert.throws(() => manageHosts('verify', invalidPath))
    assert.throws(() => manageHosts('disable', invalidPath))
    assert.equal(readFileSync(invalidPath, 'utf8'), fixture)
  })
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

console.log(
  'local development domain contract passed: loopback is the default, hosts transforms are isolated and exact, and Railway remains untouched',
)
