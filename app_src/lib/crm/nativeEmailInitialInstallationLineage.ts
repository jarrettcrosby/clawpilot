import {
  nativeEmailCanonicalJson,
  nativeEmailDigest,
  requireNativeEmail,
} from './nativeEmailPublication'

export type NativeEmailInitialInstallationLineage = Readonly<{
  version: 1
  purpose: 'clawpilot-native-email-initial-installation-lineage'
  rootOperationId: string
  rootInstallationJournalFingerprint: string
  rootSourceArtifactDigest: string
  rootStockRuntimeFingerprint: string
  predecessorOperationId: string
  predecessorPlanHash: string
  predecessorApprovalHash: string
  predecessorCancellationReceiptHash: string
  previousLineageHash: string | null
  depth: number
  cancelledHistoryFingerprint: string
  freshSourceArtifactDigest: string
  freshInstalledRuntimeFingerprint: string
}>

/** Pre-capture anchors only: never include the digest of the source artifact
 * that will contain this context. Complete lineage is finalized afterwards. */
export type NativeEmailInitialReplanContext = Readonly<Omit<NativeEmailInitialInstallationLineage,
  'purpose' | 'freshSourceArtifactDigest' | 'freshInstalledRuntimeFingerprint'> & {
  purpose: 'clawpilot-native-email-initial-replan-context'
}>

const HASH = /^[a-f0-9]{64}(?![\s\S])/
const HASH_KEYS = [
  'rootOperationId', 'rootInstallationJournalFingerprint', 'rootSourceArtifactDigest', 'rootStockRuntimeFingerprint',
  'predecessorOperationId', 'predecessorPlanHash', 'predecessorApprovalHash', 'predecessorCancellationReceiptHash',
  'cancelledHistoryFingerprint', 'freshSourceArtifactDigest', 'freshInstalledRuntimeFingerprint',
] as const
const KEYS = ['version', 'purpose', ...HASH_KEYS, 'previousLineageHash', 'depth'] as const
const CONTEXT_HASH_KEYS = HASH_KEYS.filter(key => key !== 'freshSourceArtifactDigest'
  && key !== 'freshInstalledRuntimeFingerprint')
const CONTEXT_KEYS = ['version', 'purpose', ...CONTEXT_HASH_KEYS, 'previousLineageHash', 'depth'] as const
const hash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)

function prepareValue(
  value: unknown,
  currentOperationId: string,
  context: boolean,
) {
  const expectedKeys = context ? CONTEXT_KEYS : KEYS
  const hashKeys = context ? CONTEXT_HASH_KEYS : HASH_KEYS
  requireNativeEmail(hash(currentOperationId), 'initial_installation_lineage_operation')
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  'initial_installation_lineage_shape')
  const keys = Reflect.ownKeys(value)
  requireNativeEmail(keys.length === expectedKeys.length && keys.every(key => typeof key === 'string'
    && (expectedKeys as readonly string[]).includes(key)), 'initial_installation_lineage_shape')
  const properties = Object.getOwnPropertyDescriptors(value)
  requireNativeEmail(expectedKeys.every(key => properties[key]?.enumerable === true
    && Object.hasOwn(properties[key], 'value')), 'initial_installation_lineage_shape')
  // Read only the accepted own data properties; getters and hidden aliases
  // cannot influence validation or the subsequent canonical defensive copy.
  const row = Object.fromEntries(expectedKeys.map(key => [key, properties[key].value]))
  requireNativeEmail(row.version === 1 && row.purpose === (context
    ? 'clawpilot-native-email-initial-replan-context' : 'clawpilot-native-email-initial-installation-lineage'),
    'initial_installation_lineage_domain')
  requireNativeEmail(hashKeys.every(key => hash(row[key]))
    && (row.previousLineageHash === null || hash(row.previousLineageHash)), 'initial_installation_lineage_hash')
  requireNativeEmail(typeof row.depth === 'number' && Number.isSafeInteger(row.depth)
    && row.depth >= 1 && row.depth <= 500, 'initial_installation_lineage_depth')
  requireNativeEmail(row.rootOperationId !== currentOperationId && row.predecessorOperationId !== currentOperationId,
    'initial_installation_lineage_self')
  requireNativeEmail(row.depth === 1
    ? row.predecessorOperationId === row.rootOperationId && row.previousLineageHash === null
    : row.predecessorOperationId !== row.rootOperationId && hash(row.previousLineageHash),
  'initial_installation_lineage_predecessor')
  return Object.freeze(JSON.parse(nativeEmailCanonicalJson(row)))
}

/** VALUE VALIDATION ONLY. This neither authorizes a replan nor proves a
 * cancellation, installation, predecessor chain or current native state.
 * Trusted SQL/native boundaries must independently verify all those facts.
 * Append this value to the later plan AFTER fresh source capture: the fresh
 * source artifact must not contain its own freshSourceArtifactDigest. */
export function prepareNativeEmailInitialInstallationLineage(
  value: unknown,
  currentOperationId: string,
): NativeEmailInitialInstallationLineage {
  return prepareValue(value, currentOperationId, false) as NativeEmailInitialInstallationLineage
}

/** Pure pre-capture validation; no authority or cancellation attestation. */
export function prepareNativeEmailInitialReplanContext(value: unknown, currentOperationId: string): NativeEmailInitialReplanContext {
  return prepareValue(value, currentOperationId, true) as NativeEmailInitialReplanContext
}

export function nativeEmailInitialReplanContextFromLineage(value: unknown, currentOperationId: string): NativeEmailInitialReplanContext {
  const {freshSourceArtifactDigest,freshInstalledRuntimeFingerprint,...anchors} =
    prepareNativeEmailInitialInstallationLineage(value,currentOperationId)
  void freshSourceArtifactDigest; void freshInstalledRuntimeFingerprint
  return prepareNativeEmailInitialReplanContext({...anchors,purpose:'clawpilot-native-email-initial-replan-context'},currentOperationId)
}

/** Call only AFTER hashing the separately captured source bytes. The context
 * rejects both fresh fields, so that artifact cannot contain its own digest. */
export function finalizeNativeEmailInitialInstallationLineage(
  context: unknown,
  currentOperationId: string,
  freshSourceArtifactDigest: string,
  freshInstalledRuntimeFingerprint: string,
): NativeEmailInitialInstallationLineage {
  return prepareNativeEmailInitialInstallationLineage({
    ...prepareNativeEmailInitialReplanContext(context, currentOperationId),
    purpose: 'clawpilot-native-email-initial-installation-lineage',
    freshSourceArtifactDigest,
    freshInstalledRuntimeFingerprint,
  }, currentOperationId)
}

/** Stable value digest only, not a signature, native receipt or authority. */
export function nativeEmailInitialInstallationLineageDigest(value: unknown, currentOperationId: string): string {
  return nativeEmailDigest(prepareNativeEmailInitialInstallationLineage(value, currentOperationId))
}

/** Value binding only. The root journal must still be independently verified
 * against the immutable installer, not learned from a caller's lineage. */
export function effectiveNativeEmailInitialInstallationJournalFingerprint(value: unknown, currentOperationId: string): string {
  const lineage = prepareNativeEmailInitialInstallationLineage(value, currentOperationId)
  return nativeEmailDigest({version: 1, purpose: 'clawpilot-native-email-initial-effective-installation',
    rootInstallationJournalFingerprint: lineage.rootInstallationJournalFingerprint,
    installationLineageHash: nativeEmailDigest(lineage)})
}
