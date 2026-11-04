#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// This runner never pulls an image, mounts credentials, starts a DB or touches
// a guarded PostgreSQL lease. The approved official PHP image must be cached.
const image = execFileSync('docker', ['image', 'inspect', 'php:8.2-cli-alpine', '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 10_000 }).trim()
assert.match(image, /^sha256:[a-f0-9]{64}$/)
const volumes = execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .Config.Volumes}}'], { encoding: 'utf8', timeout: 10_000 }).trim()
assert.ok(volumes === 'null' || volumes === '{}', 'The PHP image must not declare anonymous volumes')
const output = execFileSync('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
  '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1',
  '--tmpfs', '/tmp:rw,nosuid,noexec,size=16m',
  '--mount', `type=bind,source=${resolve('services/suitecrm/email-audience')},target=/source/email-audience,readonly`,
  '--mount', `type=bind,source=${resolve('services/suitecrm/install-email-audience.php')},target=/source/install-email-audience.php,readonly`,
  '--mount', `type=bind,source=${resolve('scripts/fixtures/native-email-audience')},target=/fixture,readonly`,
  image, 'sh', '-c', 'php -l /source/email-audience/EmailAudience.php && php -l /source/email-audience/routes.php && php -l /source/install-email-audience.php && cp -R /fixture /tmp/kernel && cd /tmp/kernel && php kernel.php',
], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
process.stdout.write(output)
assert.match(output, /Native Email audience PHP kernel passed 16 controlled-stub checks/)
