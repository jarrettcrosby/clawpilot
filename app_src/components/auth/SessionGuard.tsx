'use client'

import { useEffect } from 'react'

export const SESSION_CHANGED_EVENT = 'clawpilot:session-changed'
export const SESSION_REFRESH_EVENT = 'clawpilot:session-refresh'

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/login?next=${encodeURIComponent(next)}`)
}
export default function SessionGuard({ enabled, onSession, onUnavailable }: { enabled: boolean; onSession?: (payload: unknown) => void; onUnavailable?: () => void }) {
  useEffect(() => {
    if (!enabled) return

    let active = true
    let lastActivitySentAt = 0
    let verificationRevision = 0
    let pendingVerification: AbortController | null = null

    async function verify() {
      const revision = ++verificationRevision
      pendingVerification?.abort()
      const controller = new AbortController()
      pendingVerification = controller
      const timeout = window.setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store', signal: controller.signal })
        if (!active || revision !== verificationRevision) return
        if (response.status === 401) {
          onSession?.(null)
          redirectToLogin()
          return
        }
        if (!response.ok) { onUnavailable?.(); return }
        const payload = await response.json()
        if (!active || revision !== verificationRevision) return
        onSession?.(payload)
        window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT, { detail: payload }))
      } catch {
        // A transient network failure must not sign the user out.
        if (active && revision === verificationRevision) onUnavailable?.()
      } finally {
        window.clearTimeout(timeout)
      }
    }

    async function reportActivity() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastActivitySentAt < 4 * 60 * 1000) return
      lastActivitySentAt = now
      try {
        const response = await fetch('/api/auth/session/activity', { method: 'POST' })
        if (active && response.status === 401) redirectToLogin()
      } catch {
        // The next interaction or visibility check retries activity renewal.
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      void verify()
      void reportActivity()
    }

    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']
    for (const eventName of activityEvents) window.addEventListener(eventName, reportActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    const onRefresh = () => { void verify() }
    window.addEventListener(SESSION_REFRESH_EVENT, onRefresh)
    const verificationInterval = window.setInterval(() => { void verify() }, 5 * 60 * 1000)
    void verify()

    return () => {
      active = false
      pendingVerification?.abort()
      for (const eventName of activityEvents) window.removeEventListener(eventName, reportActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(SESSION_REFRESH_EVENT, onRefresh)
      window.clearInterval(verificationInterval)
    }
  }, [enabled, onSession, onUnavailable])

  return null
}
