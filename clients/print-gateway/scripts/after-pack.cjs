const { spawnSync } = require('node:child_process')
const path = require('node:path')

function plist(plistPath, command, required = true) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', command, plistPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (required && (result.error || result.status !== 0)) {
    throw result.error || new Error(`PlistBuddy failed: ${command}`)
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const infoPlist = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  )

  plist(infoPlist, 'Delete :NSAppTransportSecurity', false)
  plist(infoPlist, 'Add :NSAppTransportSecurity dict')
  plist(infoPlist, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false')
  plist(infoPlist, 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true')
  plist(infoPlist, 'Delete :NSLocalNetworkUsageDescription', false)
  plist(
    infoPlist,
    'Add :NSLocalNetworkUsageDescription string ClawPilot uses the local network only to reach the Zebra printer you configure.',
  )
  plist(infoPlist, 'Add :NSAppTransportSecurity:NSExceptionDomains dict')
  for (const host of ['localhost', '127.0.0.1']) {
    plist(infoPlist, `Add :NSAppTransportSecurity:NSExceptionDomains:${host} dict`)
    plist(
      infoPlist,
      `Add :NSAppTransportSecurity:NSExceptionDomains:${host}:NSTemporaryExceptionAllowsInsecureHTTPLoads bool true`,
    )
    plist(
      infoPlist,
      `Add :NSAppTransportSecurity:NSExceptionDomains:${host}:NSIncludesSubdomains bool false`,
    )
  }

  for (const unusedPermission of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) plist(infoPlist, `Delete :${unusedPermission}`, false)
}
