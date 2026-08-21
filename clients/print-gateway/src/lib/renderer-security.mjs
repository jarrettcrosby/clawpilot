export function rendererNavigationIsTrusted(destination, rendererUrl) {
  try {
    return new URL(String(destination)).href === new URL(String(rendererUrl)).href
  } catch {
    return false
  }
}

export function assertTrustedRendererIpc(event, mainWindow, rendererUrl) {
  const frame = event?.senderFrame
  if (
    !mainWindow
    || event?.sender !== mainWindow.webContents
    || !frame
    || frame !== frame.top
    || !rendererNavigationIsTrusted(frame.url, rendererUrl)
  ) throw new Error('Privileged print-agent IPC is available only to the main packaged renderer')
}
