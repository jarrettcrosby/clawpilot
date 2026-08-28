const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

export const DEFAULT_PIPELINE_REPORTING_PRESET = 'last_3_calendar_months'
export const MAX_CUSTOM_PIPELINE_REPORTING_DAYS = 5 * 366

export const PIPELINE_REPORTING_PRESETS = [
  'last_30_days',
  DEFAULT_PIPELINE_REPORTING_PRESET,
  'year_to_date',
  'custom',
]

export class PipelineReportingPeriodError extends Error {
  constructor(message, code = 'PIPELINE_REPORTING_PERIOD_INVALID') {
    super(message)
    this.name = 'PipelineReportingPeriodError'
    this.code = code
    this.status = 400
  }
}

function dateParts(value) {
  const match = DATE_ONLY_PATTERN.exec(String(value || '').trim())
  if (!match) return null
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const checked = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  if (
    checked.getUTCFullYear() !== parts.year
    || checked.getUTCMonth() + 1 !== parts.month
    || checked.getUTCDate() !== parts.day
  ) return null
  return parts
}

function formatDateParts(parts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function requiredDate(value, label) {
  const parts = dateParts(value)
  if (!parts) {
    throw new PipelineReportingPeriodError(
      `${label} must be a real calendar date in YYYY-MM-DD format`,
      'PIPELINE_REPORTING_DATE_INVALID',
    )
  }
  return formatDateParts(parts)
}

function addDays(value, days) {
  const parts = dateParts(value)
  if (!parts) throw new PipelineReportingPeriodError('Pipeline reporting date is invalid')
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return formatDateParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  })
}

function monthStart(value, offset = 0) {
  const parts = dateParts(value)
  if (!parts) throw new PipelineReportingPeriodError('Pipeline reporting date is invalid')
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + offset, 1))
  return formatDateParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: 1,
  })
}

function calendarDayNumber(value) {
  const parts = dateParts(value)
  if (!parts) throw new PipelineReportingPeriodError('Pipeline reporting date is invalid')
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000)
}

export function normalizePipelineReportingTimeZone(value) {
  const requested = String(value || '').trim() || 'UTC'
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: requested }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function wallClockParts(epoch, timeZone) {
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
  }
  if (!Object.values(parts).every(Number.isFinite)) {
    throw new PipelineReportingPeriodError('Pipeline reporting timezone could not be resolved')
  }
  return parts
}

function wallClockEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0)
}

function dateInTimeZone(value, timeZone) {
  const parts = wallClockParts(value.getTime(), timeZone)
  return formatDateParts(parts)
}

function firstInstantOfLocalDate(value, timeZone, matchingEpoch) {
  if (dateInTimeZone(new Date(matchingEpoch - 1), timeZone) !== value) return matchingEpoch

  let lower = matchingEpoch - (36 * 60 * 60 * 1000)
  while (dateInTimeZone(new Date(lower), timeZone) >= value) {
    lower -= 36 * 60 * 60 * 1000
  }
  let upper = matchingEpoch
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (dateInTimeZone(new Date(middle), timeZone) < value) lower = middle
    else upper = middle
  }
  if (dateInTimeZone(new Date(upper), timeZone) !== value) {
    throw new PipelineReportingPeriodError('Pipeline reporting boundary does not exist in the selected timezone')
  }
  return upper
}

function matchingLocalDateEpoch(value, timeZone, targetWallClock) {
  const searchWindow = 36 * 60 * 60 * 1000
  const searchStep = 30 * 60 * 1000
  for (let offset = -searchWindow; offset <= searchWindow; offset += searchStep) {
    const epoch = targetWallClock + offset
    if (dateInTimeZone(new Date(epoch), timeZone) === value) return epoch
  }
  throw new PipelineReportingPeriodError('Pipeline reporting boundary does not exist in the selected timezone')
}

function localMidnightIso(value, timeZone) {
  const parts = dateParts(value)
  if (!parts) throw new PipelineReportingPeriodError('Pipeline reporting boundary is invalid')
  const targetWallClock = Date.UTC(parts.year, parts.month - 1, parts.day)
  let epoch = targetWallClock
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rendered = wallClockParts(epoch, timeZone)
    const difference = targetWallClock - wallClockEpoch(rendered)
    if (difference === 0) {
      return new Date(firstInstantOfLocalDate(value, timeZone, epoch)).toISOString()
    }
    epoch += difference
  }
  const matchingEpoch = dateInTimeZone(new Date(epoch), timeZone) === value
    ? epoch
    : matchingLocalDateEpoch(value, timeZone, targetWallClock)
  return new Date(firstInstantOfLocalDate(value, timeZone, matchingEpoch)).toISOString()
}

function presetValue(value) {
  const preset = String(value || '').trim() || DEFAULT_PIPELINE_REPORTING_PRESET
  if (!PIPELINE_REPORTING_PRESETS.includes(preset)) {
    throw new PipelineReportingPeriodError(
      'Pipeline reporting preset is invalid',
      'PIPELINE_REPORTING_PRESET_INVALID',
    )
  }
  return preset
}

function nowValue(value) {
  const now = value === undefined ? new Date() : new Date(value)
  if (!Number.isFinite(now.getTime())) {
    throw new PipelineReportingPeriodError('Pipeline reporting current time is invalid')
  }
  return now
}

/**
 * Resolve one activity reporting period using calendar dates in the user's timezone.
 * startAt is inclusive and endAtExclusive is the next local midnight after endDate.
 *
 * @param {{
 *   preset?: string | null
 *   startDate?: string | null
 *   endDate?: string | null
 *   timeZone?: string | null
 *   now?: Date | string | number
 * }} [input]
 */
export function normalizePipelineReportingPeriod(input = {}) {
  const preset = presetValue(input.preset)
  const timeZone = normalizePipelineReportingTimeZone(input.timeZone)
  const currentDate = dateInTimeZone(nowValue(input.now), timeZone)
  let startDate
  let endDate
  let label

  if (preset === 'custom') {
    startDate = requiredDate(input.startDate, 'Custom start date')
    endDate = requiredDate(input.endDate, 'Custom end date')
    label = `Custom: ${startDate} to ${endDate}`
  } else if (preset === 'last_30_days') {
    startDate = addDays(currentDate, -29)
    endDate = currentDate
    label = 'Last 30 days'
  } else if (preset === 'year_to_date') {
    startDate = `${currentDate.slice(0, 4)}-01-01`
    endDate = currentDate
    label = 'Year to date'
  } else {
    startDate = monthStart(currentDate, -2)
    endDate = currentDate
    label = 'Last 3 calendar months'
  }

  if (startDate > endDate) {
    throw new PipelineReportingPeriodError(
      'Pipeline reporting start date must be on or before the end date',
      'PIPELINE_REPORTING_RANGE_INVALID',
    )
  }
  if (
    preset === 'custom'
    && calendarDayNumber(endDate) - calendarDayNumber(startDate) + 1 > MAX_CUSTOM_PIPELINE_REPORTING_DAYS
  ) {
    throw new PipelineReportingPeriodError(
      `Custom pipeline reporting ranges cannot exceed ${MAX_CUSTOM_PIPELINE_REPORTING_DAYS} days`,
      'PIPELINE_REPORTING_RANGE_TOO_LARGE',
    )
  }

  return {
    preset,
    label,
    startDate,
    endDate,
    snapshotDate: currentDate,
    timeZone,
    startAt: localMidnightIso(startDate, timeZone),
    endAtExclusive: localMidnightIso(addDays(endDate, 1), timeZone),
  }
}
