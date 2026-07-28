'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  DEFAULT_WORKSPACE_CURRENCY_CODE,
  normalizeCurrencyCode,
} from '@/lib/currency'
import {
  DEFAULT_MEASUREMENT_SYSTEM,
  normalizeMeasurementSystem,
  type MeasurementPreferenceSnapshot,
  type MeasurementPreferenceSource,
  type MeasurementSystem,
} from '@/lib/measurements'
import { WORKSPACE_CHANGED_EVENT } from '@/lib/workspaceClient'

export type { MeasurementPreferenceSource } from '@/lib/measurements'

export type MeasurementPreferences = MeasurementPreferenceSnapshot & {
  canManageOrganizationDefault: boolean
}

type MeasurementSystemContextValue = MeasurementPreferences & {
  loading: boolean
  error: string | null
  preferencesWritable: boolean
  refresh: () => Promise<void>
  setUserOverride: (value: MeasurementSystem | null) => Promise<void>
  setOrganizationDefault: (value: MeasurementSystem) => Promise<void>
  setOrganizationCurrencyCode: (value: string) => Promise<void>
}

type PreferencesResponse = {
  ok?: boolean
  error?: string
  code?: string
  preferences?: unknown
}

const FALLBACK_PREFERENCES: MeasurementPreferences = {
  measurementSystem: DEFAULT_MEASUREMENT_SYSTEM,
  effectiveSource: 'fallback',
  organizationDefault: DEFAULT_MEASUREMENT_SYSTEM,
  organizationCurrencyCode: DEFAULT_WORKSPACE_CURRENCY_CODE,
  organizationRevision: 1,
  userOverride: null,
  canManageOrganizationDefault: false,
}

const MeasurementSystemContext = createContext<MeasurementSystemContextValue>({
  ...FALLBACK_PREFERENCES,
  loading: true,
  error: null,
  preferencesWritable: false,
  refresh: async () => undefined,
  setUserOverride: async () => undefined,
  setOrganizationDefault: async () => undefined,
  setOrganizationCurrencyCode: async () => undefined,
})

class MeasurementPreferenceRequestError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'MeasurementPreferenceRequestError'
    this.code = code
  }
}

function normalizePreferences(value: unknown): MeasurementPreferences {
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const organizationDefault = normalizeMeasurementSystem(input.organizationDefault)
  const userOverride = input.userOverride === null
    ? null
    : (input.userOverride === 'imperial' || input.userOverride === 'metric'
        ? input.userOverride
        : null)
  const effectiveSource: MeasurementPreferenceSource = input.effectiveSource === 'user'
    || input.effectiveSource === 'organization'
    ? input.effectiveSource
    : 'fallback'
  const revision = Number(input.organizationRevision)

  return {
    measurementSystem: normalizeMeasurementSystem(
      input.measurementSystem,
      userOverride || organizationDefault,
    ),
    effectiveSource,
    organizationDefault,
    organizationCurrencyCode: normalizeCurrencyCode(
      input.organizationCurrencyCode,
      DEFAULT_WORKSPACE_CURRENCY_CODE,
    ),
    organizationRevision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1,
    userOverride,
    canManageOrganizationDefault: input.canManageOrganizationDefault === true,
  }
}

async function readResponse(response: Response): Promise<MeasurementPreferences> {
  const payload = await response.json().catch(() => null) as PreferencesResponse | null
  if (!response.ok || !payload?.preferences) {
    throw new MeasurementPreferenceRequestError(
      payload?.error || `Measurement preference request failed (${response.status})`,
      typeof payload?.code === 'string' ? payload.code : null,
    )
  }
  return normalizePreferences(payload.preferences)
}

export function useMeasurementSystem(): MeasurementSystemContextValue {
  return useContext(MeasurementSystemContext)
}

export function MeasurementSystemProvider({
  children,
  persistenceEnabled = true,
}: {
  children: ReactNode
  persistenceEnabled?: boolean
}) {
  const [preferences, setPreferences] = useState<MeasurementPreferences>(FALLBACK_PREFERENCES)
  const [loading, setLoading] = useState(persistenceEnabled)
  const [error, setError] = useState<string | null>(null)
  const [preferencesWritable, setPreferencesWritable] = useState(persistenceEnabled)
  const requestSequence = useRef(0)

  const refresh = useCallback(async (resetToFallback = false) => {
    const requestId = ++requestSequence.current
    if (resetToFallback) setPreferences(FALLBACK_PREFERENCES)
    if (!persistenceEnabled) {
      setPreferences(FALLBACK_PREFERENCES)
      setPreferencesWritable(false)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/measurement-preferences', {
        cache: 'no-store',
      })
      const next = await readResponse(response)
      if (requestSequence.current === requestId) {
        setPreferences(next)
        setPreferencesWritable(true)
      }
    } catch (caught) {
      if (requestSequence.current === requestId) {
        setPreferences(FALLBACK_PREFERENCES)
        if (
          caught instanceof MeasurementPreferenceRequestError
          && caught.code === 'active_workspace_required'
        ) {
          setPreferencesWritable(false)
          setError(null)
        } else {
          setPreferencesWritable(true)
          setError(caught instanceof Error
            ? caught.message
            : 'Unable to load measurement preferences')
        }
      }
    } finally {
      if (requestSequence.current === requestId) setLoading(false)
    }
  }, [persistenceEnabled])

  useEffect(() => {
    function onWorkspaceChange() {
      void refresh(true)
    }

    window.addEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChange)
    void refresh()
    return () => {
      requestSequence.current += 1
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, onWorkspaceChange)
    }
  }, [refresh])

  const update = useCallback(async (body: Record<string, unknown>) => {
    if (!preferencesWritable) return
    const requestId = ++requestSequence.current
    setError(null)
    const response = await fetch('/api/settings/measurement-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const next = await readResponse(response)
    if (requestSequence.current === requestId) setPreferences(next)
  }, [preferencesWritable])

  const setUserOverride = useCallback(async (value: MeasurementSystem | null) => {
    try {
      await update({
        action: 'set-user-override',
        measurementSystem: value,
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to update measurement preference'
      setError(message)
      throw caught
    }
  }, [update])

  const setOrganizationDefault = useCallback(async (value: MeasurementSystem) => {
    try {
      await update({
        action: 'set-organization-default',
        measurementSystem: value,
        expectedRevision: preferences.organizationRevision,
      })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to update organization measurement default'
      setError(message)
      throw caught
    }
  }, [preferences.organizationRevision, update])

  const setOrganizationCurrencyCode = useCallback(async (value: string) => {
    try {
      await update({
        action: 'set-organization-currency',
        currencyCode: value,
        expectedRevision: preferences.organizationRevision,
      })
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : 'Unable to update organization currency'
      setError(message)
      throw caught
    }
  }, [preferences.organizationRevision, update])

  const value = useMemo<MeasurementSystemContextValue>(() => ({
    ...preferences,
    loading,
    error,
    preferencesWritable,
    refresh,
    setUserOverride,
    setOrganizationDefault,
    setOrganizationCurrencyCode,
  }), [
    error,
    loading,
    preferences,
    preferencesWritable,
    refresh,
    setOrganizationDefault,
    setOrganizationCurrencyCode,
    setUserOverride,
  ])

  return (
    <MeasurementSystemContext.Provider value={value}>
      {children}
    </MeasurementSystemContext.Provider>
  )
}

export default MeasurementSystemProvider
