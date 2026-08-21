import {
  legacyMacMigrationIsBlocked,
  legacyMacMigrationMessage,
} from './legacy-macos-agent.mjs'

const EMPTY_DETECTION = Object.freeze({
  clawPilotInstances: [],
  tauriLaunchAgentPresent: false,
  tauriProcessRunning: false,
})

function detectionFailureMessage(error) {
  const detail = String(error instanceof Error ? error.message : error).slice(0, 500)
  return `Legacy local printing state could not be verified, so all Electron print workers were stopped safely and Pair, Start, and enabling start-at-login are blocked for this app session. Reopen the app only after legacy auto-start entries are disabled and legacy processes have quit. This app did not stop, delete, uninstall, or revoke either older runtime. ${detail}`
}

export class LegacyMacMigrationGuard {
  constructor({
    detect,
    stopWorkers,
    intervalMs = 1_000,
    onQuiesced = () => undefined,
    onError = () => undefined,
    setIntervalImplementation = setInterval,
    clearIntervalImplementation = clearInterval,
  }) {
    if (typeof detect !== 'function' || typeof stopWorkers !== 'function') {
      throw new Error('Legacy Mac migration guard dependencies are invalid')
    }
    if (
      !Number.isSafeInteger(intervalMs)
      || intervalMs < 250
      || intervalMs > 60_000
    ) throw new Error('Legacy Mac migration guard interval is invalid')
    this.detect = detect
    this.stopWorkers = stopWorkers
    this.intervalMs = intervalMs
    this.onQuiesced = onQuiesced
    this.onError = onError
    this.setIntervalImplementation = setIntervalImplementation
    this.clearIntervalImplementation = clearIntervalImplementation
    this.detection = { ...EMPTY_DETECTION }
    this.blockMessage = null
    this.quiesced = false
    this.checkPromise = null
    this.quiescePromise = null
    this.timer = null
  }

  refreshAndLatch() {
    if (this.blockMessage) return
    try {
      const detection = this.detect()
      legacyMacMigrationIsBlocked(detection)
      this.detection = {
        clawPilotInstances: [...detection.clawPilotInstances],
        tauriLaunchAgentPresent: detection.tauriLaunchAgentPresent,
        tauriProcessRunning: detection.tauriProcessRunning,
      }
      const message = legacyMacMigrationMessage(detection)
      if (message) this.blockMessage = message
    } catch (error) {
      this.blockMessage = detectionFailureMessage(error)
    }
  }

  async quiesce() {
    if (!this.blockMessage || this.quiesced) return
    if (this.quiescePromise) return this.quiescePromise
    this.quiescePromise = (async () => {
      await this.stopWorkers()
      this.quiesced = true
      await this.onQuiesced(this.snapshot())
    })().finally(() => {
      this.quiescePromise = null
    })
    return this.quiescePromise
  }

  assertReady() {
    this.refreshAndLatch()
    if (!this.blockMessage) return
    void this.quiesce().catch((error) => this.onError(error))
    throw new Error(this.blockMessage)
  }

  checkNow() {
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = (async () => {
      this.refreshAndLatch()
      await this.quiesce()
      return this.snapshot()
    })().finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  start() {
    if (this.timer !== null) return
    const check = () => {
      void this.checkNow().catch((error) => this.onError(error))
    }
    this.timer = this.setIntervalImplementation(check, this.intervalMs)
    this.timer?.unref?.()
    check()
  }

  stop() {
    if (this.timer === null) return
    this.clearIntervalImplementation(this.timer)
    this.timer = null
  }

  snapshot() {
    return {
      detection: {
        clawPilotInstances: [...this.detection.clawPilotInstances],
        tauriLaunchAgentPresent: this.detection.tauriLaunchAgentPresent,
        tauriProcessRunning: this.detection.tauriProcessRunning,
      },
      blocked: Boolean(this.blockMessage),
      message: this.blockMessage,
      quiesced: this.quiesced,
    }
  }
}
