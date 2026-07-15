const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
const OFFSET_DATE_TIME_PATTERN = /(?:z|[+-]\d{2}:\d{2})$/i

type DateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return true
  } catch {
    return false
  }
}

function wallTime(parts: DateTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  )
}

function parseLocalDateTime(value: string): DateTimeParts | null {
  const match = value.match(LOCAL_DATE_TIME_PATTERN)
  if (!match) return null
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '').padEnd(3, '0') || 0),
  }
  const checked = new Date(wallTime(parts))
  if (
    checked.getUTCFullYear() !== parts.year
    || checked.getUTCMonth() + 1 !== parts.month
    || checked.getUTCDate() !== parts.day
    || checked.getUTCHours() !== parts.hour
    || checked.getUTCMinutes() !== parts.minute
    || checked.getUTCSeconds() !== parts.second
    || checked.getUTCMilliseconds() !== parts.millisecond
  ) return null
  return parts
}

function partsInTimeZone(epoch: number, timeZone: string): DateTimeParts | null {
  const values = new Map(
    new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(epoch)).map((part) => [part.type, part.value]),
  )
  const parts = {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
    millisecond: new Date(epoch).getUTCMilliseconds(),
  }
  return Object.values(parts).every(Number.isFinite) ? parts : null
}

export function zonedDateTimeToIso(value: unknown, timeZoneValue: unknown): string | null {
  const raw = String(value || '').trim()
  const timeZone = String(timeZoneValue || '').trim()
  if (!raw || !timeZone || !validTimeZone(timeZone)) return null
  if (OFFSET_DATE_TIME_PATTERN.test(raw)) {
    const instant = new Date(raw)
    return Number.isFinite(instant.getTime()) ? instant.toISOString() : null
  }

  const target = parseLocalDateTime(raw)
  if (!target) return null
  const targetWallTime = wallTime(target)
  let epoch = targetWallTime
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rendered = partsInTimeZone(epoch, timeZone)
    if (!rendered) return null
    const difference = targetWallTime - wallTime(rendered)
    if (difference === 0) return new Date(epoch).toISOString()
    epoch += difference
  }
  const rendered = partsInTimeZone(epoch, timeZone)
  return rendered && wallTime(rendered) === targetWallTime ? new Date(epoch).toISOString() : null
}

export function dateTimeLocalValue(value: unknown, timeZoneValue: unknown): string {
  const date = new Date(String(value || ''))
  const timeZone = String(timeZoneValue || '').trim()
  if (!Number.isFinite(date.getTime()) || !timeZone || !validTimeZone(timeZone)) return ''
  const parts = partsInTimeZone(date.getTime(), timeZone)
  if (!parts) return ''
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}
