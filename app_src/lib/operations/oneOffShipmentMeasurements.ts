import {
  displayLengthToMillimeters,
  displayWeightToGrams,
  gramsToDisplayWeight,
  millimetersToDisplayLength,
  type MeasurementSystem,
} from '@/lib/measurements'

function displayDraftNumber(value: number) {
  return String(Number(value.toFixed(3)))
}

export function positiveDisplayMeasurement(value: string) {
  const parsed = Number(value)
  return value.trim() && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : null
}

export function displayLengthFromMillimeters(
  millimeters: number | null,
  system: MeasurementSystem,
) {
  return millimeters === null
    ? ''
    : displayDraftNumber(millimetersToDisplayLength(millimeters, system))
}

export function displayWeightFromGrams(
  grams: number | null,
  system: MeasurementSystem,
) {
  return grams === null
    ? ''
    : displayDraftNumber(gramsToDisplayWeight(grams, system))
}

export function canonicalLengthFromDisplay(
  value: string,
  system: MeasurementSystem,
) {
  const parsed = positiveDisplayMeasurement(value)
  if (parsed === null) return null
  const millimeters = displayLengthToMillimeters(parsed, system)
  return Number.isSafeInteger(millimeters) && millimeters > 0
    ? millimeters
    : null
}

export function canonicalWeightFromDisplay(
  value: string,
  system: MeasurementSystem,
) {
  const parsed = positiveDisplayMeasurement(value)
  if (parsed === null) return null
  const grams = displayWeightToGrams(parsed, system)
  return Number.isSafeInteger(grams) && grams > 0 ? grams : null
}

export function rebaseDisplayLength(
  value: string,
  from: MeasurementSystem,
  to: MeasurementSystem,
) {
  if (from === to || !value.trim()) return value
  const millimeters = canonicalLengthFromDisplay(value, from)
  return millimeters === null
    ? value
    : displayLengthFromMillimeters(millimeters, to)
}

export function rebaseDisplayWeight(
  value: string,
  from: MeasurementSystem,
  to: MeasurementSystem,
) {
  if (from === to || !value.trim()) return value
  const grams = canonicalWeightFromDisplay(value, from)
  return grams === null ? value : displayWeightFromGrams(grams, to)
}
