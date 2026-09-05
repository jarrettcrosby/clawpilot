#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const managerUrl = new URL('./manage-remote-local-development.sh', import.meta.url)
const manager = readFileSync(managerUrl, 'utf8')
const gateway = JSON.parse(readFileSync(
  new URL('../infra/vercel-remote-local-gateway/vercel.json', import.meta.url),
  'utf8',
))

assert.equal(gateway.framework, null)
assert.equal(gateway.routes.length, 2)
const [route] = gateway.routes
assert.equal(route.src, '/(.*)')
assert.deepEqual(route.has, [{
  type: 'host',
  value: '^dev\\.aiapp\\.eigenracing\\.com$',
}])
assert.equal(route.dest, '${CLAWPILOT_REMOTE_LOCAL_ORIGIN}/$1')
assert.deepEqual(route.env, ['CLAWPILOT_REMOTE_LOCAL_ORIGIN'])
assert.equal(route.respectOriginCacheControl, false)
assert.deepEqual(gateway.routes[1], { src: '/(.*)', status: 404 })

const ingressTransform = route.transforms.find(
  (transform) => transform.target?.key === 'x-clawpilot-remote-local-ingress',
)
assert.ok(ingressTransform)
assert.equal(ingressTransform.type, 'request.headers')
assert.equal(ingressTransform.op, 'set')
assert.equal(ingressTransform.args, '$CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET')
assert.deepEqual(ingressTransform.env, ['CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET'])
assert.ok(route.transforms.some(
  (transform) => transform.target?.key === 'x-forwarded-host'
    && transform.args === 'dev.aiapp.eigenracing.com',
))
assert.ok(route.transforms.some(
  (transform) => transform.target?.key === 'x-forwarded-proto'
    && transform.args === 'https',
))

assert.match(manager, /http:\/\/127\.0\.0\.1:\$\{?INGRESS_PORT/)
assert.match(manager, /@vercel header %s %s/)
assert.match(manager, /basic_auth/)
assert.match(manager, /reverse_proxy 127\.0\.0\.1:4002/)
assert.match(manager, /header_up Host %s/)
assert.match(manager, /header_up -Authorization/)
assert.match(manager, /header_up -%s/)
assert.match(manager, /payload\.get\("driver"\) == "postgres"/)
assert.match(manager, /payload\.get\("database"\) == "reachable"/)
assert.match(manager, /payload\.get\("databaseFingerprint"\) == sys\.argv\[2\]/)
assert.match(manager, /CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT/)
assert.match(manager, /require_expected_database_fingerprint/)
assert.match(manager, /ps -p "\$pid" -o command=/)
assert.match(manager, /PID \$pid is not the managed Caddy process/)
assert.match(manager, /protected API did not return 401/)
assert.match(manager, /did not redirect to the exact HTTPS login origin/)
assert.doesNotMatch(manager, /"\$REPO_ROOT\/scripts\/dev-start\.sh"/)
assert.doesNotMatch(manager, /tailscale funnel --bg[^']*\n[^']*\$\(/)
assert.doesNotMatch(manager, /railway\s+(up|down|delete)/)
assert.doesNotMatch(manager, /sudo|rewrite_hosts|manage-local-development-hosts/)

const stateRoot = mkdtempSync(join(tmpdir(), 'clawpilot-remote-local-'))
const secret = 'a'.repeat(43)
const passwordHash = execFileSync('caddy', ['hash-password', '--plaintext', 'test-only-password'], {
  encoding: 'utf8',
}).trim()

try {
  execFileSync('/bin/bash', [managerUrl.pathname, 'prepare'], {
    env: {
      ...process.env,
      CLAWPILOT_REMOTE_LOCAL_STATE_ROOT: stateRoot,
      CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET: secret,
      CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH: passwordHash,
    },
    stdio: 'pipe',
  })
  const caddyfile = readFileSync(join(stateRoot, 'Caddyfile'), 'utf8')
  assert.match(caddyfile, new RegExp(`X-ClawPilot-Remote-Local-Ingress ${secret}`))
  assert.match(caddyfile, /basic_auth \{/)
  assert.match(caddyfile, /operator \$2[aby]\$/)
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:4002/)
  assert.match(caddyfile, /header_up -Authorization/)
  assert.match(caddyfile, /header_up -X-ClawPilot-Remote-Local-Ingress/)
  execFileSync('caddy', ['validate', '--config', join(stateRoot, 'Caddyfile'), '--adapter', 'caddyfile'], {
    stdio: 'pipe',
  })

  assert.throws(() => execFileSync('/bin/bash', [managerUrl.pathname, 'prepare'], {
    env: {
      ...process.env,
      CLAWPILOT_REMOTE_LOCAL_STATE_ROOT: stateRoot,
      CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET: 'too-short',
      CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH: passwordHash,
    },
    stdio: 'pipe',
  }))
  assert.throws(() => execFileSync('/bin/bash', [managerUrl.pathname, 'prepare'], {
    env: {
      ...process.env,
      CLAWPILOT_REMOTE_LOCAL_STATE_ROOT: stateRoot,
      CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET: secret,
      CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH: 'plaintext-is-not-accepted',
    },
    stdio: 'pipe',
  }))
  assert.throws(() => execFileSync('/bin/bash', [managerUrl.pathname, 'prepare'], {
    env: {
      ...process.env,
      CLAWPILOT_REMOTE_LOCAL_STATE_ROOT: stateRoot,
      CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET: secret,
      CLAWPILOT_REMOTE_LOCAL_PASSWORD_HASH: `${passwordHash}\nrespond 200`,
    },
    stdio: 'pipe',
  }))

  const missingFingerprint = spawnSync('/bin/bash', [managerUrl.pathname, 'status'], {
    env: {
      ...process.env,
      CLAWPILOT_REMOTE_LOCAL_STATE_ROOT: stateRoot,
      CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET: secret,
    },
    encoding: 'utf8',
  })
  assert.notEqual(missingFingerprint.status, 0)
  assert.match(
    missingFingerprint.stderr,
    /CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT must be the exact UUID/,
  )
} finally {
  rmSync(stateRoot, { recursive: true, force: true })
}

console.log(
  'remote-local gateway contract passed: Vercel injects a private ingress secret, Caddy requires separate operator auth, and both app-facing listeners remain loopback-only',
)
