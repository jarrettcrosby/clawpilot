if (process.platform === 'win32') {
  await import('./build-windows-lock-helper.mjs')
} else {
  process.stdout.write('No platform-native helper build is required on this operating system.\n')
}
