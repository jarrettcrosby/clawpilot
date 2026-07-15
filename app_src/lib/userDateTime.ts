export const DEFAULT_USER_TIME_ZONE = 'America/New_York'
export const DEFAULT_USER_LOCALE = 'en-US'
export const USER_DATE_TIME_SETTINGS_EVENT = 'clawpilot:user-date-time-settings'

export type UserDateTimeSettings = {
  timeZone: string
  locale: string
}

type DateTimeInput = string | number | Date | null | undefined
type FormatOptions = Intl.DateTimeFormatOptions & { fallback?: string }

export function normalizeUserTimeZone(value: unknown): string {
  const candidate = String(value || '').trim() || DEFAULT_USER_TIME_ZONE
  try {
    return new Intl.DateTimeFormat(DEFAULT_USER_LOCALE, { timeZone: candidate }).resolvedOptions().timeZone
  } catch {
    return DEFAULT_USER_TIME_ZONE
  }
}

export function normalizeUserLocale(value: unknown): string {
  const candidate = String(value || '').trim() || DEFAULT_USER_LOCALE
  try {
    return Intl.getCanonicalLocales(candidate)[0] || DEFAULT_USER_LOCALE
  } catch {
    return DEFAULT_USER_LOCALE
  }
}

export function normalizeUserDateTimeSettings(value: unknown): UserDateTimeSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    timeZone: normalizeUserTimeZone(input.timeZone ?? input.timezone),
    locale: normalizeUserLocale(input.locale),
  }
}

export function formatUserDateTime(
  value: DateTimeInput,
  settings: UserDateTimeSettings,
  options: FormatOptions = {},
): string {
  const { fallback = '', ...dateTimeOptions } = options
  if (value === null || value === undefined || value === '') return fallback

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return fallback

  return new Intl.DateTimeFormat(settings.locale, {
    ...dateTimeOptions,
    timeZone: settings.timeZone,
  }).format(date)
}

export function hourInUserTimeZone(value: DateTimeInput, timeZoneValue: unknown): number {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) return new Date().getHours()

  const hour = new Intl.DateTimeFormat(DEFAULT_USER_LOCALE, {
    timeZone: normalizeUserTimeZone(timeZoneValue),
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date).find((part) => part.type === 'hour')?.value

  return Number(hour)
}

export function announceUserDateTimeSettings(value: unknown) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(USER_DATE_TIME_SETTINGS_EVENT, {
    detail: normalizeUserDateTimeSettings(value),
  }))
}
