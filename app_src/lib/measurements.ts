export type MeasurementSystem = 'imperial' | 'metric'
export type MeasurementPreferenceSource = 'user' | 'organization' | 'fallback'

export type MeasurementPreferenceSnapshot = {
  measurementSystem: MeasurementSystem
  effectiveSource: MeasurementPreferenceSource
  organizationDefault: MeasurementSystem
  organizationRevision: number
  userOverride: MeasurementSystem | null
}

export type MeasurementUnits = {
  length: 'in' | 'cm'
  weight: 'lb' | 'kg'
  volume: 'ft³' | 'm³'
}

export type CanonicalDimensionsMm = {
  lengthMm: number
  widthMm: number
  heightMm: number
}

export type MeasurementFormatOptions = {
  locale?: string
  maximumFractionDigits?: number
  minimumFractionDigits?: number
}

export const DEFAULT_MEASUREMENT_SYSTEM: MeasurementSystem = 'imperial'
export const MILLIMETERS_PER_INCH = 25.4
export const MILLIMETERS_PER_CENTIMETER = 10
export const GRAMS_PER_POUND = 453.59237
export const GRAMS_PER_KILOGRAM = 1_000
export const CUBIC_FEET_PER_CUBIC_METER = 35.31466672148859
export const POUNDS_PER_KILOGRAM = 2.2046226218487757

export function isMeasurementSystem(value: unknown): value is MeasurementSystem {
  return value === 'imperial' || value === 'metric'
}

export function normalizeMeasurementSystem(
  value: unknown,
  fallback: MeasurementSystem = DEFAULT_MEASUREMENT_SYSTEM,
): MeasurementSystem {
  return isMeasurementSystem(value) ? value : fallback
}

export function measurementUnits(system: MeasurementSystem): MeasurementUnits {
  return system === 'metric'
    ? { length: 'cm', weight: 'kg', volume: 'm³' }
    : { length: 'in', weight: 'lb', volume: 'ft³' }
}

function requireNonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite, non-negative number`)
  }
  return value
}

function formatMeasurement(
  value: number,
  unit: string,
  options: MeasurementFormatOptions,
  defaultMaximumFractionDigits: number,
): string {
  const {
    locale = 'en-US',
    maximumFractionDigits = defaultMaximumFractionDigits,
    minimumFractionDigits = 0,
  } = options
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits,
  }).format(value)} ${unit}`
}

export function millimetersToDisplayLength(
  millimeters: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(millimeters, 'millimeters')
  return system === 'metric'
    ? value / MILLIMETERS_PER_CENTIMETER
    : value / MILLIMETERS_PER_INCH
}

export function displayLengthToMillimeters(
  length: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(length, 'length')
  return Math.round(system === 'metric'
    ? value * MILLIMETERS_PER_CENTIMETER
    : value * MILLIMETERS_PER_INCH)
}

export function gramsToDisplayWeight(
  grams: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(grams, 'grams')
  return system === 'metric'
    ? value / GRAMS_PER_KILOGRAM
    : value / GRAMS_PER_POUND
}

export function displayWeightToGrams(
  weight: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(weight, 'weight')
  return Math.round(system === 'metric'
    ? value * GRAMS_PER_KILOGRAM
    : value * GRAMS_PER_POUND)
}

export function cubicMetersToDisplayVolume(
  cubicMeters: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(cubicMeters, 'cubicMeters')
  return system === 'metric' ? value : value * CUBIC_FEET_PER_CUBIC_METER
}

export function displayVolumeToCubicMeters(
  volume: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(volume, 'volume')
  return system === 'metric' ? value : value / CUBIC_FEET_PER_CUBIC_METER
}

export function kilogramsToDisplayWeight(
  kilograms: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(kilograms, 'kilograms')
  return system === 'metric' ? value : value * POUNDS_PER_KILOGRAM
}

export function displayWeightToKilograms(
  weight: number,
  system: MeasurementSystem,
): number {
  const value = requireNonNegativeFinite(weight, 'weight')
  return system === 'metric' ? value : value / POUNDS_PER_KILOGRAM
}

export function formatMillimeters(
  millimeters: number,
  system: MeasurementSystem,
  options: MeasurementFormatOptions = {},
): string {
  return formatMeasurement(
    millimetersToDisplayLength(millimeters, system),
    measurementUnits(system).length,
    options,
    2,
  )
}

export function formatGrams(
  grams: number,
  system: MeasurementSystem,
  options: MeasurementFormatOptions = {},
): string {
  return formatMeasurement(
    gramsToDisplayWeight(grams, system),
    measurementUnits(system).weight,
    options,
    2,
  )
}

export function formatDimensionsMm(
  dimensions: CanonicalDimensionsMm,
  system: MeasurementSystem,
  options: MeasurementFormatOptions = {},
): string {
  const unit = measurementUnits(system).length
  const formatted = [
    millimetersToDisplayLength(dimensions.lengthMm, system),
    millimetersToDisplayLength(dimensions.widthMm, system),
    millimetersToDisplayLength(dimensions.heightMm, system),
  ].map((value) => formatMeasurement(value, '', options, 2).trim())
  return `${formatted.join(' × ')} ${unit}`
}

export function formatCubicMeters(
  cubicMeters: number,
  system: MeasurementSystem,
  options: MeasurementFormatOptions = {},
): string {
  return formatMeasurement(
    cubicMetersToDisplayVolume(cubicMeters, system),
    measurementUnits(system).volume,
    options,
    3,
  )
}

export function formatKilograms(
  kilograms: number,
  system: MeasurementSystem,
  options: MeasurementFormatOptions = {},
): string {
  return formatMeasurement(
    kilogramsToDisplayWeight(kilograms, system),
    measurementUnits(system).weight,
    options,
    2,
  )
}
