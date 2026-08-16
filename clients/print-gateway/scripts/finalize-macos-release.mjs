import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const outputDirectory = path.resolve('dist')
const dmgs = readdirSync(outputDirectory)
  .filter((name) => name.endsWith('.dmg'))
  .map((name) => path.join(outputDirectory, name))
if (dmgs.length !== 1) throw new Error(`Expected exactly one macOS DMG, found ${dmgs.length}`)

const [dmgPath] = dmgs
const identity = String(process.env.MACOS_DEVELOPER_ID_APPLICATION || '').trim()
execFileSync('/usr/bin/codesign', [
  '--force',
  '--timestamp',
  '--sign',
  identity,
  dmgPath,
], { stdio: 'inherit' })

const result = JSON.parse(execFileSync('/usr/bin/xcrun', [
  'notarytool',
  'submit',
  dmgPath,
  '--key',
  process.env.APPLE_API_KEY,
  '--key-id',
  process.env.APPLE_API_KEY_ID,
  '--issuer',
  process.env.APPLE_API_ISSUER,
  '--wait',
  '--output-format',
  'json',
], { encoding: 'utf8' }))
if (result.status !== 'Accepted') {
  throw new Error(`Apple notarization did not accept the DMG (${result.status || 'unknown'})`)
}
execFileSync('/usr/bin/xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' })
execFileSync('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' })
