import { normalizeGlobalId } from '../globalIds.mjs'

const CRM_REFERENCE_PREFIXES = ['ga', 'gc', 'gi', 'gk', 'gl', 'gm', 'go', 'gp']
const CRM_PIPELINE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Internal record navigation must stay on the current app host. Published
 * short URLs are sharing identities, not navigation targets for a signed-in UI.
 * The /crm/[reference] route remains responsible for record access checks.
 *
 * @param {unknown} referenceCode
 * @param {unknown} [pipelineId]
 * @returns {string | null}
 */
export function crmRecordNavigationPath(referenceCode, pipelineId) {
  const reference = normalizeGlobalId(referenceCode, CRM_REFERENCE_PREFIXES)
  if (!reference) return null
  const pipeline = typeof pipelineId === 'string' ? pipelineId.trim() : ''
  return `/crm/${reference}${CRM_PIPELINE_PATTERN.test(pipeline) ? `?pipeline=${pipeline}` : ''}`
}
