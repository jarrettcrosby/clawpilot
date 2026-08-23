export function normalizedLoginItemStatus({ desired, settings, platform }) {
  const macStatus = platform === 'darwin' ? String(settings?.status || '') : null
  const effective = platform === 'darwin'
    ? macStatus === 'enabled' && settings?.openAtLogin === true
    : platform === 'win32'
      ? settings?.openAtLogin === true && settings?.executableWillLaunchAtLogin === true
      : settings?.openAtLogin === true
  let warning = null
  if (desired && macStatus === 'requires-approval') {
    warning = 'macOS requires approval for ClawPilot Print Agent in System Settings > General > Login Items before background printing will start after sign-in.'
  } else if (desired !== effective) {
    warning = desired
      ? 'The operating system has not enabled this login item. Review the system Login Items or Startup Apps settings before relying on background printing after sign-in.'
      : 'The operating system still reports this login item as enabled. Remove ClawPilot Print Agent from the system Login Items or Startup Apps settings.'
  }
  return {
    desired: desired === true,
    effective,
    status: macStatus || (effective ? 'enabled' : 'not-registered'),
    warning,
  }
}
