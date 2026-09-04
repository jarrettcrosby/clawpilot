#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manager = readFileSync(
  new URL('./manage-local-development-domain.sh', import.meta.url),
  'utf8',
)
const devStart = readFileSync(new URL('./dev-start.sh', import.meta.url), 'utf8')

assert.match(manager, /DOMAIN="dev\.aiapp\.eigenracing\.com"/)
assert.match(manager, /127\.0\.0\.1 \$\{?domain\}?|127\.0\.0\.1 \{domain\}/)
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
assert.match(devStart, /CLAWPILOT_LOCAL_PUBLIC_URL/)
assert.match(devStart, /CLAWPILOT_LOCAL_BIND_HOST/)
assert.match(devStart, /CLAWPILOT_PUBLIC_URL="\$PUBLIC_URL"/)
assert.match(devStart, /--hostname "\$BIND_HOST"/)

console.log(
  'local development domain contract passed: exact HTTPS hostname is loopback-only, reversible, and isolated from Railway',
)
