'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_USER_LOCALE,
  DEFAULT_USER_TIME_ZONE,
  USER_DATE_TIME_SETTINGS_EVENT,
  normalizeUserDateTimeSettings,
  type UserDateTimeSettings,
} from '@/lib/userDateTime'

const DEFAULT_SETTINGS: UserDateTimeSettings = {
  timeZone: DEFAULT_USER_TIME_ZONE,
  locale: DEFAULT_USER_LOCALE,
}

const UserDateTimeContext = createContext<UserDateTimeSettings>(DEFAULT_SETTINGS)

export function useUserDateTime(): UserDateTimeSettings {
  return useContext(UserDateTimeContext)
}

export default function UserDateTimeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserDateTimeSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    const controller = new AbortController()

    function applySettings(value: unknown) {
      setSettings(normalizeUserDateTimeSettings(value))
    }

    function onSettingsChange(event: Event) {
      applySettings((event as CustomEvent<unknown>).detail)
    }

    window.addEventListener(USER_DATE_TIME_SETTINGS_EVENT, onSettingsChange)
    fetch('/api/users', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        const currentUser = payload && typeof payload === 'object'
          ? (payload as { currentUser?: unknown }).currentUser
          : null
        if (currentUser) applySettings(currentUser)
      })
      .catch(() => undefined)

    return () => {
      controller.abort()
      window.removeEventListener(USER_DATE_TIME_SETTINGS_EVENT, onSettingsChange)
    }
  }, [])

  const value = useMemo(() => settings, [settings])
  return <UserDateTimeContext.Provider value={value}>{children}</UserDateTimeContext.Provider>
}
