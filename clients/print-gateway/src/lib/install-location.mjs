export function gatewayInstallLocationStatus({
  platform = process.platform,
  packaged = false,
  inApplicationsFolder = true,
  executablePath = process.execPath,
} = {}) {
  if (platform !== 'darwin' || !packaged) {
    return { ready: true, status: packaged ? 'installed' : 'development', warning: null }
  }
  if (inApplicationsFolder === true) {
    return { ready: true, status: 'applications-folder', warning: null }
  }
  const translocated = String(executablePath || '').includes('/AppTranslocation/')
  return {
    ready: false,
    status: translocated ? 'app-translocation' : 'unstable-location',
    warning: 'ClawPilot Print Agent is running from a disk image, download, or translocated path. Quit the app, drag it to Applications (or your user Applications folder), eject the installer disk image, then reopen it from Applications. Pairing, worker start, and login-item registration are blocked until then.',
  }
}

export function assertStableGatewayInstall(status) {
  if (status?.ready === true) return
  throw new Error(status?.warning || 'Install ClawPilot Print Agent in Applications before starting it')
}
