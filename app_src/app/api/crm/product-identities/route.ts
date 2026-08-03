import { NextRequest, NextResponse } from 'next/server'
import { GLOBAL_ID_MAX_LENGTH } from '@/lib/globalIds.mjs'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  listProductIdentitySuggestionsInPostgres,
  reconcileProductIdentityBatchInPostgres,
  reconcileProductIdentityInPostgres,
  resolveProductIdentityInPostgres,
  type ProductIdentityEvidenceType,
  type ReconcileProductIdentityInput,
} from '@/lib/persistence/productIdentity'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const EVIDENCE_TYPES: ProductIdentityEvidenceType[] = [
  'exact_sku',
  'exact_gtin',
  'exact_barcode',
  'operator_confirmed',
]

async function selectedPipeline(req: NextRequest, actor: AppUser) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value
    || undefined
  return resolvePipelineSpaceAccess({
    actorEmail: actor,
    pipelineId: selected,
  }).catch(() => resolvePipelineSpaceAccess({
    actorEmail: actor,
  }))
}

function stringValue(value: unknown, max = 500) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > max) {
    throw new Error('Product identity value is invalid')
  }
  return normalized
}

function errorResponse(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : 'Product identity review failed'
  const status = message === 'Unauthorized'
    ? 401
    : /permission|view-only|denied/i.test(message)
      ? 403
      : /changed|already linked|overlap/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 400
  return NextResponse.json(
    { ok: false, error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  )
}

function stringArrayValue(
  value: unknown,
  input: {
    label: string
    maxItems?: number
    maxLength?: number
  },
) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > (input.maxItems || 100)
  ) {
    throw new Error(`${input.label} is invalid`)
  }
  const normalized = value.map((item) => (
    stringValue(item, input.maxLength || 64)
  ))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${input.label} contains duplicate values`)
  }
  return normalized
}

function reconciliationInput(
  body: Record<string, unknown>,
): Omit<
  ReconcileProductIdentityInput,
  'pipelineId' | 'actorEmail' | 'refreshDropdown'
> {
  const evidenceType = stringValue(
    body.evidenceType,
    50,
  ) as ProductIdentityEvidenceType
  if (!EVIDENCE_TYPES.includes(evidenceType)) {
    throw new Error('Product identity evidence type is invalid')
  }
  return {
    canonicalGlobalId: stringValue(body.canonicalGlobalId, GLOBAL_ID_MAX_LENGTH),
    duplicateGlobalId: stringValue(body.duplicateGlobalId, GLOBAL_ID_MAX_LENGTH),
    expectedCanonicalSourceHash: stringValue(
      body.expectedCanonicalSourceHash,
      64,
    ),
    expectedDuplicateSourceHash: stringValue(
      body.expectedDuplicateSourceHash,
      64,
    ),
    expectedCanonicalUpdatedAt: stringValue(
      body.expectedCanonicalUpdatedAt,
      100,
    ),
    expectedDuplicateUpdatedAt: stringValue(
      body.expectedDuplicateUpdatedAt,
      100,
    ),
    expectedCanonicalMappingGlobalIds: stringArrayValue(
      body.expectedCanonicalMappingGlobalIds,
      { label: 'Canonical mapping review set' },
    ),
    expectedDuplicateMappingGlobalIds: stringArrayValue(
      body.expectedDuplicateMappingGlobalIds,
      { label: 'Duplicate mapping review set' },
    ),
    evidenceType,
    operatorConfirmed: body.operatorConfirmed === true,
  }
}

async function context(req: NextRequest) {
  if (!isPostgresStorageEnabled()) {
    throw new Error('Product identity review requires Postgres storage')
  }
  const actor = await requireRequestUser(req)
  const pipeline = await selectedPipeline(req, actor)
  requireResourceEditor(pipeline)
  if (!operationsCapabilities(actor).canManage) {
    throw new Error(
      'Operations-management permission is required to reconcile product identity',
    )
  }
  return { actor, pipeline }
}

export async function GET(req: NextRequest) {
  try {
    const { pipeline } = await context(req)
    const resolveGlobalId = req.nextUrl.searchParams.get('resolve')
    if (resolveGlobalId) {
      const resolution = await resolveProductIdentityInPostgres({
        pipelineId: pipeline.id,
        productGlobalId: stringValue(resolveGlobalId, GLOBAL_ID_MAX_LENGTH),
      })
      return NextResponse.json(
        { ok: true, resolution },
        {
          headers: {
            'Cache-Control': 'no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      )
    }
    const suggestions = await listProductIdentitySuggestionsInPostgres({
      pipelineId: pipeline.id,
    })
    return NextResponse.json(
      {
        ok: true,
        suggestions,
        summary: {
          total: suggestions.length,
          identifierMatches: suggestions.filter(
            (suggestion) => suggestion.confidence === 'identifier_match',
          ).length,
          operatorReviews: suggestions.filter(
            (suggestion) => suggestion.confidence === 'operator_review',
          ).length,
          blocked: suggestions.filter(
            (suggestion) => !suggestion.canApply,
          ).length,
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const { actor, pipeline } = await context(req)
    const body = await req.json() as Record<string, unknown>
    if (Array.isArray(body.items)) {
      if (
        body.confirmBatch !== true
        || body.items.length < 1
        || body.items.length > 250
      ) {
        throw new Error(
          'Confirm a batch of 1 to 250 product identity decisions',
        )
      }
      const result = await reconcileProductIdentityBatchInPostgres({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        items: body.items.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('Product identity batch item is invalid')
          }
          return reconciliationInput(item as Record<string, unknown>)
        }),
      })
      return NextResponse.json({
        ok: result.failed === 0,
        result,
      }, {
        status: result.failed === 0 ? 200 : 207,
      })
    }
    const requested = reconciliationInput(body)
    const result = await reconcileProductIdentityInPostgres({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      ...requested,
    })
    return NextResponse.json({
      ok: true,
      result,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
