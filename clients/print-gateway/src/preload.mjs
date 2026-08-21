import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('clawpilotGateway', Object.freeze({
  snapshot: () => ipcRenderer.invoke('gateway:snapshot'),
  probe: (input) => ipcRenderer.invoke('gateway:probe', input),
  pair: (input) => ipcRenderer.invoke('gateway:pair', input),
  setEnabled: (id, enabled) => ipcRenderer.invoke('gateway:set-enabled', { id, enabled }),
  testInstance: (id) => ipcRenderer.invoke('gateway:test-instance', { id }),
  updateEndpoint: (id, printerHost, printerPort) => ipcRenderer.invoke(
    'gateway:update-endpoint',
    { id, printerHost, printerPort },
  ),
  removeLocalInstance: (id, confirmation) => ipcRenderer.invoke(
    'gateway:remove-local-instance',
    { id, confirmation },
  ),
  setAutoStart: (enabled) => ipcRenderer.invoke('gateway:set-auto-start', { enabled }),
  exportDiagnostics: () => ipcRenderer.invoke('gateway:export-diagnostics'),
  onStatus: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('gateway:status', handler)
    return () => ipcRenderer.removeListener('gateway:status', handler)
  },
}))
