const { spawnSync } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.error || result.status !== 0) {
    if (!options.capture) process.stderr.write(output)
    throw result.error || new Error(`${command} failed with exit ${result.status}`)
  }
  if (!options.capture && output) process.stdout.write(output)
  return output
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CLAWPILOT_ALLOW_UNSIGNED_LOCAL_BUILD === '1') return

  const identity = String(process.env.MACOS_DEVELOPER_ID_APPLICATION || '').trim()
  const teamId = String(process.env.APPLE_TEAM_ID || '').trim()
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(appPath)) throw new Error(`Signed application is missing: ${appPath}`)

  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const signature = execute('/usr/bin/codesign', ['-d', '--verbose=4', appPath], { capture: true })
  if (!signature.includes(`Authority=${identity}`) || !signature.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error('The macOS application does not have the required Developer ID identity and team')
  }
  if (!/flags=0x[0-9a-f]+\(runtime\)/i.test(signature)) {
    throw new Error('The macOS application signature is missing the hardened-runtime flag')
  }

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-notary-app-'))
  const archivePath = path.join(temporaryDirectory, 'ClawPilot-Print-Agent.zip')
  try {
    execute('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archivePath])
    const resultText = execute('/usr/bin/xcrun', [
      'notarytool',
      'submit',
      archivePath,
      '--key',
      process.env.APPLE_API_KEY,
      '--key-id',
      process.env.APPLE_API_KEY_ID,
      '--issuer',
      process.env.APPLE_API_ISSUER,
      '--wait',
      '--output-format',
      'json',
    ], { capture: true })
    const result = JSON.parse(resultText)
    if (result.status !== 'Accepted') {
      throw new Error(`Apple notarization did not accept the application (${result.status || 'unknown'})`)
    }
    execute('/usr/bin/xcrun', ['stapler', 'staple', appPath])
    execute('/usr/bin/xcrun', ['stapler', 'validate', appPath])
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
