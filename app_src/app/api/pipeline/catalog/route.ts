import { NextRequest, NextResponse } from 'next/server'
import { parse } from 'csv-parse/sync'
import { isIso4217CurrencyCode } from '@/lib/currency'
import {
  readPipelineCatalogInPostgres,
  upsertPipelineCatalogPersonInPostgres,
  upsertPipelineCatalogProductInPostgres,
} from '@/lib/persistence/crm'
import { isPostgresPipelineStoreEnabled } from '@/lib/persistence/pipeline'
import { readMeasurementPreferences } from '@/lib/persistence/measurementPreferences'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'
import type { ProductPackagingProfileInput } from '@/lib/persistence/productPackaging'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

const MAX_CSV_BYTES = 1024 * 1024
const MAX_CSV_ROWS = 500

function clean(value: unknown, max = 500) {
  const text = String(value ?? '').trim()
  if (text.length > max) throw new Error('Pipeline catalog field is too long')
  return text
}

function emailValue(value: unknown) {
  const email = clean(value, 254).toLowerCase()
  if (email && !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
    throw new Error('Pipeline person email is invalid')
  }
  return email
}

function booleanValue(value: unknown, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = clean(value, 20).toLowerCase()
  if (['true', '1', 'yes', 'active'].includes(normalized)) return true
  if (['false', '0', 'no', 'inactive'].includes(normalized)) return false
  throw new Error('Active must be true or false')
}

function amountValue(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`)
  return number
}

function positiveIntegerValue(value: unknown, label: string, maximum: number) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return number
}

function positiveNumberValue(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero`)
  return number
}

function measurementSystemValue(value: unknown): ProductPackagingProfileInput['measurementSystem'] {
  const normalized = clean(value, 20).toLowerCase() || 'metric'
  if (normalized !== 'metric' && normalized !== 'imperial') {
    throw new Error('Package measurement system must be metric or imperial')
  }
  return normalized
}

function canonicalMeasurement(value: unknown, label: string, factor: number, maximum: number) {
  return positiveIntegerValue(Math.round(positiveNumberValue(value, label) * factor), label, maximum)
}

function packagingFields(
  input: Record<string, unknown>,
  source: ProductPackagingProfileInput['source'],
): ProductPackagingProfileInput | null {
  const legacyMeasurements = [input.lengthMm, input.widthMm, input.heightMm, input.weightGrams]
  const displayMeasurements = [input.length, input.width, input.height, input.weight]
  const legacySupplied = legacyMeasurements.filter((value) => value !== undefined && value !== null && value !== '')
  const displaySupplied = displayMeasurements.filter((value) => value !== undefined && value !== null && value !== '')
  if (legacySupplied.length === 0 && displaySupplied.length === 0) return null
  if (legacySupplied.length > 0 && displaySupplied.length > 0) {
    throw new Error('Use either display-unit package measurements or legacy canonical measurements, not both')
  }
  const measurements = displaySupplied.length > 0 ? displayMeasurements : legacyMeasurements
  const supplied = displaySupplied.length > 0 ? displaySupplied : legacySupplied
  if (supplied.length !== measurements.length) {
    throw new Error('Package length, width, height, and weight must be supplied together')
  }
  const packageType = (clean(input.packageType, 30) || 'each') as ProductPackagingProfileInput['packageType']
  if (!['each', 'inner_pack', 'case', 'carton', 'pallet'].includes(packageType)) {
    throw new Error('Package type is invalid')
  }
  const measurementSystem = measurementSystemValue(input.measurementSystem)
  const usesDisplayUnits = displaySupplied.length > 0
  const dimensionFactor = measurementSystem === 'imperial' ? 25.4 : 10
  const weightFactor = measurementSystem === 'imperial' ? 453.59237 : 1_000
  return {
    profileName: clean(input.packageName, 120) || 'Default package',
    packageType,
    unitOfMeasure: clean(input.unitOfMeasure, 50) || 'each',
    unitsPerPackage: positiveIntegerValue(input.unitsPerPackage || 1, 'Units per package', 1_000_000),
    measurementSystem,
    lengthMm: usesDisplayUnits
      ? canonicalMeasurement(input.length, 'Package length', dimensionFactor, 100_000)
      : positiveIntegerValue(input.lengthMm, 'Package length', 100_000),
    widthMm: usesDisplayUnits
      ? canonicalMeasurement(input.width, 'Package width', dimensionFactor, 100_000)
      : positiveIntegerValue(input.widthMm, 'Package width', 100_000),
    heightMm: usesDisplayUnits
      ? canonicalMeasurement(input.height, 'Package height', dimensionFactor, 100_000)
      : positiveIntegerValue(input.heightMm, 'Package height', 100_000),
    weightGrams: usesDisplayUnits
      ? canonicalMeasurement(input.weight, 'Package weight', weightFactor, 100_000_000)
      : positiveIntegerValue(input.weightGrams, 'Package weight', 100_000_000),
    active: booleanValue(input.packagingActive),
    source,
  }
}

function safeSpreadsheetValue(value: unknown, max: number) {
  const text = clean(value, max)
  if (/^[=+\-@]/.test(text)) throw new Error('CSV values cannot begin with a spreadsheet formula character')
  return text
}

function productFields(input: Record<string, unknown>) {
  const name = clean(input.name, 250)
  if (!name) throw new Error('Product name is required')
  const sku = clean(input.sku, 25)
  const currency = clean(input.currency, 3).toUpperCase()
  if (currency && !isIso4217CurrencyCode(currency)) {
    throw new Error('Product currency must be a supported ISO 4217 code')
  }
  const url = clean(input.url, 2_000)
  if (url && !/^https?:\/\//i.test(url)) throw new Error('Product URL must use http or https')
  return {
    name,
    sku,
    productType: clean(input.productType, 100) || 'Good',
    category: clean(input.category, 100),
    status: clean(input.status, 100) || 'Active',
    price: amountValue(input.price, 'Product price'),
    cost: amountValue(input.cost, 'Product cost'),
    currency,
    url,
    description: clean(input.description, 10_000),
    active: booleanValue(input.active),
  }
}

function normalizeCsvHeader(value: unknown) {
  return clean(value, 100).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function parseCsv(text: string) {
  const seenHeaders = new Set<string>()
  const rows = parse(text, {
    bom: true,
    columns: (headers: string[]) => headers.map((header) => {
      const normalized = normalizeCsvHeader(header)
      if (!normalized || seenHeaders.has(normalized)) throw new Error('CSV headers must be present and unique')
      seenHeaders.add(normalized)
      return normalized
    }),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: false,
  }) as Array<Record<string, unknown>>
  if (rows.length === 0) throw new Error('CSV file contains no records')
  if (rows.length > MAX_CSV_ROWS) throw new Error(`CSV files may contain at most ${MAX_CSV_ROWS} records`)
  return rows
}

async function selectedPipeline(req: NextRequest, actor: AppUser) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  return selected
    ? resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
    : resolvePipelineSpaceAccess({ actorEmail: actor })
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Pipeline catalog request failed'
  const status = message === 'Unauthorized'
    ? 401
    : /denied|view-only/i.test(message)
      ? 403
      : /not found/i.test(message)
        ? 404
        : /not initialized/i.test(message)
          ? 409
          : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  if (!isPostgresPipelineStoreEnabled()) {
    return NextResponse.json({ ok: false, error: 'Pipeline setup requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    const catalog = await readPipelineCatalogInPostgres({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      reconcile: pipeline.accessRole !== 'viewer',
    })
    return NextResponse.json({
      ok: true,
      pipelineId: pipeline.id,
      canEdit: pipeline.accessRole !== 'viewer',
      scope: {
        organizationId: pipeline.workspaceOrganizationId,
        pipelineName: pipeline.name,
      },
      ...catalog,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  if (!isPostgresPipelineStoreEnabled()) {
    return NextResponse.json({ ok: false, error: 'Pipeline setup requires Postgres storage' }, { status: 409 })
  }
  try {
    const actor = await requireRequestUser(req)
    const pipeline = await selectedPipeline(req, actor)
    requireResourceEditor(pipeline)
    const preferences = await readMeasurementPreferences(actor)
    const defaultCurrencyCode = preferences.organizationCurrencyCode

    const contentType = req.headers.get('content-type') || ''
    if (contentType.includes('multipart/form-data')) {
      const length = Number(req.headers.get('content-length') || 0)
      if (length > MAX_CSV_BYTES + 100_000) throw new Error('CSV file is too large')
      const form = await req.formData()
      const kind = clean(form.get('kind'), 20)
      if (!['people', 'products'].includes(kind)) throw new Error('CSV import type is invalid')
      const file = form.get('file')
      if (!(file instanceof File)) throw new Error('CSV file is required')
      if (file.size > MAX_CSV_BYTES) throw new Error('CSV files must be 1 MB or smaller')
      const rows = parseCsv(await file.text())
      const errors: Array<{ row: number; error: string }> = []
      let imported = 0
      for (const [index, row] of rows.entries()) {
        try {
          if (kind === 'people') {
            const fullName = safeSpreadsheetValue(row.fullname, 250)
            if (!fullName) throw new Error('Full name is required')
            await upsertPipelineCatalogPersonInPostgres({
              pipelineId: pipeline.id,
              actorEmail: actor.email,
              fullName,
              email: emailValue(row.email),
              jobTitle: safeSpreadsheetValue(row.jobtitle, 250),
              active: booleanValue(row.active),
              deferDropdownSync: true,
            })
          } else {
            const packaging = packagingFields({
              packageName: safeSpreadsheetValue(row.packagename, 120),
              packageType: safeSpreadsheetValue(row.packagetype, 30),
              unitOfMeasure: safeSpreadsheetValue(row.unitofmeasure, 50),
              unitsPerPackage: row.unitsperpackage,
              measurementSystem: safeSpreadsheetValue(row.measurementsystem, 20),
              length: row.length,
              width: row.width,
              height: row.height,
              weight: row.weight,
              lengthMm: row.lengthmm,
              widthMm: row.widthmm,
              heightMm: row.heightmm,
              weightGrams: row.weightgrams,
              packagingActive: row.packagingactive,
            }, 'csv_import')
            await upsertPipelineCatalogProductInPostgres({
              pipelineId: pipeline.id,
              actorEmail: actor.email,
              deferDropdownSync: true,
              defaultCurrencyCode,
              packaging,
              fields: productFields({
                name: safeSpreadsheetValue(row.name, 250),
                sku: safeSpreadsheetValue(row.sku, 25),
                productType: safeSpreadsheetValue(row.producttype, 100),
                category: safeSpreadsheetValue(row.category, 100),
                status: safeSpreadsheetValue(row.status, 100),
                price: row.price,
                cost: row.cost,
                currency: safeSpreadsheetValue(row.currency, 3),
                url: safeSpreadsheetValue(row.url, 2_000),
                description: safeSpreadsheetValue(row.description, 10_000),
                active: row.active,
              }),
            })
          }
          imported += 1
        } catch (error) {
          errors.push({ row: index + 2, error: error instanceof Error ? error.message : 'Invalid record' })
        }
      }
      if (imported > 0) await readPipelineCatalogInPostgres({ pipelineId: pipeline.id, actorEmail: actor.email })
      return NextResponse.json({
        ok: true,
        import: { imported, failed: errors.length, errors },
      }, { status: errors.length ? 207 : 200 })
    }

    const body = await req.json() as Record<string, unknown>
    const action = clean(body.action, 50)
    if (action === 'upsert-person') {
      const fullName = clean(body.fullName, 250)
      if (!fullName) throw new Error('Full name is required')
      const person = await upsertPipelineCatalogPersonInPostgres({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        id: clean(body.id, 50) || null,
        fullName,
        email: emailValue(body.email),
        jobTitle: clean(body.jobTitle, 250),
        active: booleanValue(body.active),
      })
      return NextResponse.json({ ok: true, person })
    }
    if (action === 'upsert-product') {
      const product = await upsertPipelineCatalogProductInPostgres({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        id: clean(body.id, 50) || null,
        defaultCurrencyCode,
        fields: productFields(body),
        packaging: packagingFields(body, 'manual'),
      })
      return NextResponse.json({ ok: true, product })
    }
    throw new Error('Pipeline catalog action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
