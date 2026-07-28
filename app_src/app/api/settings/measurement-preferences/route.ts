import { NextRequest, NextResponse } from 'next/server'
import { resolveSuiteCrmCurrencyId } from '@/lib/crm/suiteCrmClient'
import { isIso4217CurrencyCode } from '@/lib/currency'
import { isMeasurementSystem } from '@/lib/measurements'
import {
  MeasurementPreferenceError,
  readMeasurementPreferences,
  updateOrganizationCurrencyCode,
  updateOrganizationMeasurementDefault,
  updateUserMeasurementOverride,
} from '@/lib/persistence/measurementPreferences'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4_096
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' }

function canManageOrganizationDefault(actor: AppUser): boolean {
  const role = effectiveAuthorizationRole(actor)
  return role === 'owner' || role === 'admin'
}

function preferencesResponse(
  actor: AppUser,
  preferences: Awaited<ReturnType<typeof readMeasurementPreferences>>,
) {
  return {
    ...preferences,
    canManageOrganizationDefault: canManageOrganizationDefault(actor),
  }
}

function errorStatus(error: unknown): number {
  if (error instanceof MeasurementPreferenceError) return error.status
  if (error instanceof Error && error.message === 'Unauthorized') return 401
  if (error instanceof SyntaxError) return 400
  return 500
}

function errorMessage(error: unknown): string {
  if (error instanceof MeasurementPreferenceError) return error.message
  if (error instanceof Error && error.message === 'Unauthorized') return error.message
  if (error instanceof SyntaxError) return 'Request body must be valid JSON'
  return 'Unable to update measurement preferences'
}

function errorCode(error: unknown): string {
  if (error instanceof MeasurementPreferenceError) return error.code
  if (error instanceof Error && error.message === 'Unauthorized') return 'unauthorized'
  if (error instanceof SyntaxError) return 'invalid_json'
  return 'measurement_preferences_failed'
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowedFields: string[],
) {
  const unexpected = Object.keys(body).filter((field) => !allowedFields.includes(field))
  if (unexpected.length > 0) {
    throw new MeasurementPreferenceError(
      `Unexpected request field: ${unexpected[0]}`,
      400,
      'unexpected_request_field',
    )
  }
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new MeasurementPreferenceError(
      'Measurement preference request is too large',
      413,
      'request_too_large',
    )
  }
  const text = await req.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new MeasurementPreferenceError(
      'Measurement preference request is too large',
      413,
      'request_too_large',
    )
  }
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MeasurementPreferenceError(
      'Request body must be a JSON object',
      400,
      'request_body_invalid',
    )
  }
  return value as Record<string, unknown>
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const preferences = await readMeasurementPreferences(actor)
    return NextResponse.json({
      ok: true,
      preferences: preferencesResponse(actor, preferences),
    }, { headers: NO_STORE_HEADERS })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof MeasurementPreferenceError
        ? error.message
        : error instanceof Error && error.message === 'Unauthorized'
          ? error.message
          : 'Unable to load measurement preferences',
      code: errorCode(error),
    }, {
      status: errorStatus(error),
      headers: NO_STORE_HEADERS,
    })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const body = await readBody(req)
    const action = String(body.action || '')

    if (action === 'set-user-override') {
      assertOnlyFields(body, ['action', 'measurementSystem'])
      if (!Object.prototype.hasOwnProperty.call(body, 'measurementSystem')) {
        throw new MeasurementPreferenceError(
          'Measurement system override is required',
          400,
          'measurement_system_required',
        )
      }
      if (body.measurementSystem !== null && !isMeasurementSystem(body.measurementSystem)) {
        throw new MeasurementPreferenceError(
          'Measurement system must be imperial, metric, or null',
          400,
          'measurement_system_invalid',
        )
      }
      const preferences = await updateUserMeasurementOverride({
        actor,
        measurementSystem: body.measurementSystem,
      })
      return NextResponse.json({
        ok: true,
        preferences: preferencesResponse(actor, preferences),
      }, { headers: NO_STORE_HEADERS })
    }

    if (action === 'set-organization-default') {
      assertOnlyFields(body, ['action', 'measurementSystem', 'expectedRevision'])
      if (!isMeasurementSystem(body.measurementSystem)) {
        throw new MeasurementPreferenceError(
          'Measurement system must be imperial or metric',
          400,
          'measurement_system_invalid',
        )
      }
      const expectedRevision = body.expectedRevision
      if (
        typeof expectedRevision !== 'number'
        || !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 1
      ) {
        throw new MeasurementPreferenceError(
          'A valid organization preference revision is required',
          400,
          'organization_revision_invalid',
        )
      }
      const preferences = await updateOrganizationMeasurementDefault({
        actor,
        measurementSystem: body.measurementSystem,
        expectedRevision,
      })
      return NextResponse.json({
        ok: true,
        preferences: preferencesResponse(actor, preferences),
      }, { headers: NO_STORE_HEADERS })
    }

    if (action === 'set-organization-currency') {
      assertOnlyFields(body, ['action', 'currencyCode', 'expectedRevision'])
      if (!canManageOrganizationDefault(actor)) {
        throw new MeasurementPreferenceError(
          'Organization admin permission is required',
          403,
          'organization_admin_required',
        )
      }
      const currencyCode = String(body.currencyCode || '').trim().toUpperCase()
      if (!isIso4217CurrencyCode(currencyCode)) {
        throw new MeasurementPreferenceError(
          'Currency must be a supported ISO 4217 code',
          400,
          'currency_code_invalid',
        )
      }
      const expectedRevision = body.expectedRevision
      if (
        typeof expectedRevision !== 'number'
        || !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 1
      ) {
        throw new MeasurementPreferenceError(
          'A valid organization preference revision is required',
          400,
          'organization_revision_invalid',
        )
      }
      if (process.env.CRM_ENABLED === '1') {
        try {
          await resolveSuiteCrmCurrencyId(currencyCode)
        } catch (error) {
          throw new MeasurementPreferenceError(
            error instanceof Error
              ? error.message
              : 'SuiteCRM currency configuration could not be verified',
            409,
            'suitecrm_currency_configuration_required',
          )
        }
      }
      const preferences = await updateOrganizationCurrencyCode({
        actor,
        currencyCode,
        expectedRevision,
      })
      return NextResponse.json({
        ok: true,
        preferences: preferencesResponse(actor, preferences),
      }, { headers: NO_STORE_HEADERS })
    }

    throw new MeasurementPreferenceError(
      'Workspace preference action is not supported',
      400,
      'measurement_preference_action_invalid',
    )
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: errorMessage(error),
      code: errorCode(error),
    }, {
      status: errorStatus(error),
      headers: NO_STORE_HEADERS,
    })
  }
}
