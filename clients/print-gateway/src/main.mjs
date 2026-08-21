import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  session,
  Tray,
} from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { GatewayStateStore } from './lib/state-store.mjs'
import {
  abandonInstanceCleanupRequest,
  archiveResolvedInstance,
  assertInstanceLedgerCanBeRemoved,
  commitInstanceCleanupResolution,
  prepareInstanceCleanupRequest,
  readInstanceCleanupResolution,
  removeInstanceDirectory,
} from './lib/instance-removal.mjs'
import {
  assertCleanupStatusRemovalSafe,
  requestInstanceCleanupStatus,
} from './lib/cleanup-status.mjs'
import { probeRawPrinter } from './lib/printer-probe.mjs'
import { pairGatewayInstance } from './lib/pair-instance.mjs'
import { runProtectedGatewayStartup } from './lib/startup-guard.mjs'
import {
  assertTrustedRendererIpc,
  rendererNavigationIsTrusted,
} from './lib/renderer-security.mjs'
import {
  assertLegacyMacMigrationComplete,
  legacyMacMigrationIsBlocked,
  legacyMacMigrationMessage,
  legacyMacPrintAgentDetection,
} from './lib/legacy-macos-agent.mjs'
import {
  assertStableGatewayInstall,
  gatewayInstallLocationStatus,
} from './lib/install-location.mjs'
import { normalizedLoginItemStatus } from './lib/login-item-status.mjs'
import {
  normalizePrinterHost,
  normalizePrinterPort,
} from './lib/validation.mjs'
import { WorkerManager } from './lib/worker-manager.mjs'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

let mainWindow
let tray
let store
let workers
let pendingPairingContext = null
let quitting = false
let legacyMacDetection = {
  clawPilotInstances: [],
  tauriLaunchAgentPresent: false,
  tauriProcessRunning: false,
}
let installLocationStatus = { ready: true, status: 'initializing', warning: null }
let shutdownInProgress = false
let shutdownComplete = false
const rendererUrl = pathToFileURL(
  path.join(import.meta.dirname, 'renderer', 'index.html'),
).href

function localDevelopmentIsAllowed() {
  return !app.isPackaged && process.env.CLAWPILOT_GATEWAY_ALLOW_LOCAL_DEVELOPMENT === '1'
}

function runtimeDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.resolve(import.meta.dirname, '../../../scripts')
}

function runtimePath(relativePath) {
  return path.join(runtimeDirectory(), relativePath)
}

function publicSnapshot() {
  legacyMacDetection = legacyMacPrintAgentDetection()
  const publicState = store.publicState()
  return {
    ...publicState,
    autoStartStatus: loginItemStatus(publicState.autoStart),
    statuses: workers.statuses(),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    platform: process.platform,
    appVersion: app.getVersion(),
    pairingContext: pendingPairingContext,
    localDevelopmentAllowed: localDevelopmentIsAllowed(),
    legacyMacInstances: legacyMacDetection.clawPilotInstances,
    legacyMacTauriAgent: {
      launchAgentPresent: legacyMacDetection.tauriLaunchAgentPresent,
      processRunning: legacyMacDetection.tauriProcessRunning,
    },
    legacyMacMigrationBlocked: legacyMacMigrationIsBlocked(legacyMacDetection),
    legacyMacMigrationMessage: legacyMacMigrationMessage(legacyMacDetection),
    installLocationStatus,
  }
}

function assertGatewayOperationReady() {
  assertStableGatewayInstall(installLocationStatus)
  legacyMacDetection = legacyMacPrintAgentDetection()
  assertLegacyMacMigrationComplete(legacyMacDetection)
}

function showWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(hidden = false) {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: 'ClawPilot Print Agent',
    backgroundColor: '#f4f0e8',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.loadURL(rendererUrl)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (!rendererNavigationIsTrusted(destination, rendererUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-frame-navigate', (event, details) => {
    if (
      details?.isMainFrame !== true
      || !rendererNavigationIsTrusted(details?.url, rendererUrl)
    ) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => {
    if (!hidden || pendingPairingContext) showWindow()
  })
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAfUlEQVR42mNgQAX/Gf4z/Gf4z4AHMGr8Z/jP8J/hP8N/hv8M/xn+M/xn+M/wH4YGEKj4z/Cf4T/Df4b/DH8Y/jP8Z/jP8B+GBhCo+M/wn+E/w3+G/wx/GP4z/Gf4z/AfhgYQqPjP8J/hP8N/hv8Mfxj+M/xn+M/wH4YGEKj4DwAz9B6F3SOGYAAAAABJRU5ErkJggg==',
  )
  tray = new Tray(icon)
  tray.setToolTip('ClawPilot Print Agent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Gateway', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('double-click', showWindow)
}

function applyLoginItem(enabled) {
  if (process.env.CLAWPILOT_GATEWAY_TEST_MODE === '1') return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: ['--hidden'],
  })
}

function loginItemStatus(desired) {
  if (process.env.CLAWPILOT_GATEWAY_TEST_MODE === '1') {
    return { desired, effective: desired, status: 'test-mode', warning: null }
  }
  return normalizedLoginItemStatus({
    desired,
    settings: app.getLoginItemSettings({ args: ['--hidden'] }),
    platform: process.platform,
  })
}

function runWindowsLoginItemReleaseSmoke() {
  if (!process.argv.includes('--release-smoke-login-item')) return false
  if (
    process.platform !== 'win32'
    || !app.isPackaged
    || process.env.CLAWPILOT_RELEASE_INSTALL_SMOKE !== '1'
  ) throw new Error('The login-item release smoke is available only to the packaged Windows release gate')
  const settings = {
    openAtLogin: true,
    openAsHidden: true,
    args: ['--hidden'],
  }
  app.setLoginItemSettings(settings)
  const enabled = normalizedLoginItemStatus({
    desired: true,
    settings: app.getLoginItemSettings({ args: ['--hidden'] }),
    platform: 'win32',
  })
  if (!enabled.effective) {
    throw new Error(enabled.warning || 'Windows did not register the installed login item')
  }
  app.setLoginItemSettings({ ...settings, openAtLogin: false })
  const disabled = app.getLoginItemSettings({ args: ['--hidden'] })
  if (disabled.openAtLogin || disabled.executableWillLaunchAtLogin) {
    throw new Error('Windows did not remove the release-smoke login item')
  }
  app.exit(0)
  return true
}

function parsePairingContext(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'clawpilot-print-gateway:' || parsed.hostname !== 'pair') return null
    const context = String(parsed.searchParams.get('context') || '').trim().slice(0, 200)
    const organization = String(parsed.searchParams.get('organization') || '').trim().slice(0, 120)
    const warehouse = String(parsed.searchParams.get('warehouse') || '').trim().slice(0, 120)
    if (!context && !organization && !warehouse) return null
    return { context, organization, warehouse }
  } catch {
    return null
  }
}

function receiveDeepLink(values) {
  const url = values.find((value) => String(value).startsWith('clawpilot-print-gateway://'))
  const context = parsePairingContext(url)
  if (!context) return
  pendingPairingContext = context
  if (mainWindow) {
    mainWindow.webContents.send('gateway:status', { pairingContext: context })
    showWindow()
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(?:cppair|cpprint)\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gi, '[secret redacted]')
}

function diagnostics() {
  const snapshot = publicSnapshot()
  return {
    generatedAt: new Date().toISOString(),
    appVersion: snapshot.appVersion,
    platform: snapshot.platform,
    autoStart: snapshot.autoStart,
    secureStorageAvailable: snapshot.secureStorageAvailable,
    instances: snapshot.instances.map((instance) => ({
      id: instance.id,
      displayName: instance.displayName,
      enabled: instance.enabled,
      status: snapshot.statuses[instance.id],
    })),
  }
}

function installIpcHandlers() {
  const trustedHandle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRendererIpc(event, mainWindow, rendererUrl)
    return handler(event, ...args)
  })
  trustedHandle('gateway:snapshot', () => publicSnapshot())
  trustedHandle('gateway:probe', async (_event, input = {}) => {
    try {
      const host = normalizePrinterHost(input.printerHost, {
        allowLocalDevelopment: localDevelopmentIsAllowed(),
      })
      const port = normalizePrinterPort(input.printerPort)
      return { ok: true, ...(await probeRawPrinter(host, port)) }
    } catch (error) {
      return { ok: false, error: safeError(error), bytesSent: 0 }
    }
  })
  trustedHandle('gateway:pair', async (_event, input = {}) => {
    try {
      assertGatewayOperationReady()
      const pairingModule = await import(pathToFileURL(
        runtimePath('lib/print-agent-pairing-credential.mjs'),
      ).href)
      const instance = await pairGatewayInstance({
        input,
        store,
        operationGuard: assertGatewayOperationReady,
        probe: probeRawPrinter,
        pairingCodeHash: pairingModule.printAgentPairingCodeHash,
        createRecovery: pairingModule.createPrintAgentPairingRecovery,
        redeem: (pairing, recovery) => pairingModule.redeemPrintAgentPairingGrant({
          baseUrl: pairing.baseUrl,
          pairingCode: pairing.pairingCode,
          recovery,
        }),
        allowLocalDevelopment: localDevelopmentIsAllowed(),
      })
      workers.start(instance.id)
      pendingPairingContext = null
      return {
        ok: true,
        snapshot: publicSnapshot(),
        ...(instance.pairingWarning ? { message: instance.pairingWarning } : {}),
      }
    } catch (error) {
      return { ok: false, error: safeError(error) }
    }
  })
  trustedHandle('gateway:set-enabled', async (_event, input = {}) => {
    try {
      if (input.enabled === true) assertGatewayOperationReady()
      await workers.setEnabled(String(input.id || ''), input.enabled === true)
      return { ok: true, snapshot: publicSnapshot() }
    } catch (error) {
      return { ok: false, error: safeError(error) }
    }
  })
  trustedHandle('gateway:test-instance', async (_event, input = {}) => {
    try {
      const instance = store.assertInstanceIntegrity(String(input.id || ''))
      return { ok: true, ...(await probeRawPrinter(instance.printerHost, instance.printerPort)) }
    } catch (error) {
      return { ok: false, error: safeError(error), bytesSent: 0 }
    }
  })
  trustedHandle('gateway:update-endpoint', async (_event, input = {}) => {
    const id = String(input.id || '')
    let instance
    try {
      instance = store.instanceFor(id)
      if (!instance) throw new Error('The local gateway instance was not found')
      store.assertInstanceIntegrity(id)
      const printerHost = normalizePrinterHost(input.printerHost, {
        allowLocalDevelopment: localDevelopmentIsAllowed(),
      })
      const printerPort = normalizePrinterPort(input.printerPort)
      await probeRawPrinter(printerHost, printerPort)
      await workers.stopAndWait(id)
      try {
        store.updatePrinterEndpoint(id, printerHost, printerPort)
      } catch (error) {
        if (instance.enabled) workers.resume(id)
        throw error
      }
      if (instance.enabled) workers.resume(id)
      return { ok: true, snapshot: publicSnapshot(), bytesSent: 0 }
    } catch (error) {
      if (instance?.enabled) workers.resume(id)
      return { ok: false, error: safeError(error), bytesSent: 0 }
    }
  })
  trustedHandle('gateway:remove-local-instance', async (_event, input = {}) => {
    const id = String(input.id || '')
    let instance
    let localStateRemoved = false
    let removalDisabled = false
    let cleanupProofUsed = false
    try {
      instance = store.instanceFor(id)
      if (!instance) throw new Error('The local gateway instance was not found')
      if (String(input.confirmation || '') !== instance.displayName) {
        throw new Error('Type the exact instance name to confirm local removal')
      }
      await workers.stopAndWait(id)
      store.setEnabled(id, false)
      removalDisabled = true
      const instanceDirectory = workers.pathsFor(instance).instanceDirectory
      let cleanupResolution = readInstanceCleanupResolution(instanceDirectory)
      try {
        assertInstanceLedgerCanBeRemoved(instanceDirectory)
      } catch {
        const cleanupRequest = prepareInstanceCleanupRequest(instanceDirectory)
        const cleanupStatus = await requestInstanceCleanupStatus({
          baseUrl: instance.baseUrl,
          runtimeCredential: store.credentialFor(id),
          entries: cleanupRequest.entries,
          idempotencyKey: cleanupRequest.idempotencyKey,
        })
        try {
          assertCleanupStatusRemovalSafe(cleanupStatus)
        } catch (cleanupError) {
          // A cleanup receipt is immutable for its idempotency key. Forget this
          // completed unsafe request durably so a later operator retry asks the
          // server for fresh state with a new key.
          abandonInstanceCleanupRequest(instanceDirectory, cleanupRequest.idempotencyKey)
          throw cleanupError
        }
        cleanupResolution = commitInstanceCleanupResolution(instanceDirectory, cleanupStatus)
        assertInstanceLedgerCanBeRemoved(instanceDirectory)
      }
      if (cleanupResolution) {
        archiveResolvedInstance({
          dataDirectory: store.dataDirectory,
          slug: instance.slug,
          cleanupStatus: cleanupResolution,
        })
        cleanupProofUsed = true
      }
      store.removeInstance(id)
      localStateRemoved = true
      workers.forget(id)
      let cleanupWarning = null
      try {
        removeInstanceDirectory({ dataDirectory: store.dataDirectory, slug: instance.slug })
      } catch {
        cleanupWarning = 'The credential and instance were removed, but local delivery history could not be deleted. Contact support before reusing this instance name.'
      }
      return {
        ok: true,
        snapshot: publicSnapshot(),
        message: cleanupWarning
          || (cleanupProofUsed
            ? `Removed after ClawPilot verified an exact terminal result for every protected local claim. A local audit archive was preserved. Revoke server agent ${instance.serverAgentName} (${instance.serverAgentGlobalId}) separately in ClawPilot Operations > Printing > Agents if it is still active.`
            : `Removed from this computer. Revoke server agent ${instance.serverAgentName} (${instance.serverAgentGlobalId}) separately in ClawPilot Operations > Printing > Agents.`),
      }
    } catch (error) {
      if (!localStateRemoved && !removalDisabled && instance?.enabled) workers.resume(id)
      return { ok: false, error: safeError(error), snapshot: publicSnapshot() }
    }
  })
  trustedHandle('gateway:set-auto-start', (_event, input = {}) => {
    try {
      if (input.enabled === true) assertGatewayOperationReady()
      const enabled = store.setAutoStart(input.enabled === true)
      applyLoginItem(enabled)
      return { ok: true, snapshot: publicSnapshot() }
    } catch (error) {
      return { ok: false, error: safeError(error) }
    }
  })
  trustedHandle('gateway:export-diagnostics', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export redacted gateway diagnostics',
      defaultPath: `ClawPilot-Gateway-Diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    writeFileSync(result.filePath, `${JSON.stringify(diagnostics(), null, 2)}\n`, { mode: 0o600 })
    return { ok: true, filePath: result.filePath }
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveDeepLink([url])
})
app.on('second-instance', (_event, argv) => receiveDeepLink(argv))
app.on('before-quit', (event) => {
  if (shutdownComplete || !workers) return
  event.preventDefault()
  if (shutdownInProgress) return
  quitting = true
  shutdownInProgress = true
  void workers.shutdownAndWait().then(() => {
    shutdownComplete = true
    app.quit()
  }).catch((error) => {
    quitting = false
    shutdownInProgress = false
    workers.quitting = false
    workers.startEnabled()
    dialog.showErrorBox(
      'ClawPilot Print Agent is still stopping',
      `The background worker could not stop safely, so the app remains open to prevent a duplicate print. ${safeError(error)}`,
    )
  })
})

app.whenReady().then(() => runProtectedGatewayStartup({
  initialize: () => {
    app.setAppUserModelId('com.clawpilot.site-print-gateway')
    if (runWindowsLoginItemReleaseSmoke()) return
    if (app.isPackaged && process.env.CLAWPILOT_GATEWAY_TEST_MODE !== '1') {
      app.setAsDefaultProtocolClient('clawpilot-print-gateway')
    }
    receiveDeepLink(process.argv)
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    const dataDirectory = app.getPath('userData')
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    store = new GatewayStateStore({
      dataDirectory,
      safeStorage,
      allowLocalDevelopment: localDevelopmentIsAllowed(),
    })
    installLocationStatus = gatewayInstallLocationStatus({
      platform: process.platform,
      packaged: app.isPackaged,
      inApplicationsFolder: process.platform !== 'darwin'
        || !app.isPackaged
        || app.isInApplicationsFolder(),
      executablePath: process.execPath,
    })
    legacyMacDetection = legacyMacPrintAgentDetection()
    workers = new WorkerManager({
      store,
      dataDirectory,
      runtimePath: runtimePath('run-local-print-agent.mjs'),
      allowLocalDevelopment: localDevelopmentIsAllowed(),
      startGuard: assertGatewayOperationReady,
    })
    workers.on('status', (payload) => mainWindow?.webContents.send('gateway:status', payload))
    installIpcHandlers()
    const operationReady = installLocationStatus.ready
      && !legacyMacMigrationIsBlocked(legacyMacDetection)
    if (operationReady) applyLoginItem(store.publicState().autoStart)
    createWindow(process.argv.includes('--hidden') && operationReady)
    createTray()
    if (operationReady) workers.startEnabled()
  },
  showError: (title, message) => dialog.showErrorBox(title, message),
  exit: (code) => app.exit(code),
}))
