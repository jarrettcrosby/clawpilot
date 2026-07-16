'use client'

import { useEffect } from 'react'

export const SESSION_CHANGED_EVENT = 'clawpilot:session-changed'

function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/login?next=${encodeURIComponent(next)}`)
}
export default function SessionGuard() {
  useEffect(() => {
    let active = true
    let lastActivitySentAt = 0

    async function verify() {
      try {
        const response = await fetch('/api/auth/session', { cache: 'no-store' })
        if (!active) return
        if (response.status === 401) {
          redirectToLogin()
          return
        }
        if (!response.ok) return
        const payload = await response.json()
        window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT, { detail: payload }))
      } catch {
        // A transient network failure must not sign the user out.
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
    const verificationInterval = window.setInterval(() => { void verify() }, 5 * 60 * 1000)
    void verify()

    return () => {
      active = false
      for (const eventName of activityEvents) window.removeEventListener(eventName, reportActivity)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.clearInterval(verificationInterval)
    }
  }, [])

  return null
}
