import { existsSync } from 'node:fs'

const platform = process.argv[2]
const missing = []

function requireValue(name, pattern) {
  const value = String(process.env[name] || '').trim()
  if (!value || (pattern && !pattern.test(value))) missing.push(name)
  return value
}

if (process.env.CLAWPILOT_ALLOW_UNSIGNED_LOCAL_BUILD === '1') {
  throw new Error('A customer release cannot use the unsigned local-build override')
}

if (platform === 'macos') {
  requireValue('CSC_LINK')
  requireValue('CSC_KEY_PASSWORD')
  requireValue('MACOS_DEVELOPER_ID_APPLICATION', /^Developer ID Application:/)
  requireValue('APPLE_TEAM_ID', /^[A-Z0-9]{10}$/)
  const apiKey = requireValue('APPLE_API_KEY')
  requireValue('APPLE_API_KEY_ID', /^[A-Z0-9]{10}$/)
  requireValue('APPLE_API_ISSUER', /^[0-9a-f-]{36}$/i)
  if (apiKey && !existsSync(apiKey)) missing.push('APPLE_API_KEY:file')
} else if (platform === 'windows') {
  requireValue('WIN_CSC_LINK')
  requireValue('WIN_CSC_KEY_PASSWORD')
  requireValue('WIN_SIGNING_SUBJECT')
  requireValue('WIN_SIGNING_THUMBPRINT', /^[A-F0-9]{40}$/i)
} else {
  throw new Error('Expected release platform macos or windows')
}

if (missing.length) {
  throw new Error(`Customer release signing is blocked; missing or invalid: ${missing.join(', ')}`)
}

process.stdout.write(`Customer ${platform} release environment is present; artifact verification remains mandatory.\n`)
