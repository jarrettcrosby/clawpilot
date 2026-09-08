export type PosClearingReconciliationStatus =
  | 'pending'
  | 'settled'
  | 'partially_settled'
  | 'ambiguous'
  | 'overdue_unresolved';

export interface PosClearingScope {
  readonly organizationId: string;
  readonly quickBooksCompanyId: string;
  readonly locationId: string;
  readonly currencyCode: string;
  readonly clearingAccountId: string;
}

export interface PosClearingEvidenceReference {
  readonly evidenceId: string;
  readonly entityType: 'JournalEntry' | 'SalesReceipt' | 'Payment' | 'Other';
  readonly providerTransactionId?: string;
  readonly documentNumber?: string;
  readonly lineId?: string;
}

export interface PosClearingCapture {
  readonly captureId: string;
  readonly scope: PosClearingScope;
  readonly businessDate: string;
  readonly expectedSettlementBusinessDate?: string;
  readonly amountCents: number;
  readonly evidence: readonly PosClearingEvidenceReference[];
}

export interface PosClearingRelease {
  readonly releaseId: string;
  readonly scope: PosClearingScope;
  readonly businessDate: string;
  readonly amountCents: number;
  readonly evidence: readonly PosClearingEvidenceReference[];
}

export interface PosClearingReconciliationInput {
  readonly asOfBusinessDate: string;
  readonly overdueGraceDays: number;
  readonly captures: readonly PosClearingCapture[];
  readonly releases: readonly PosClearingRelease[];
}

export interface PosClearingAllocation {
  readonly captureId: string;
  readonly releaseId: string;
  readonly amountCents: number;
  readonly captureEvidence: readonly PosClearingEvidenceReference[];
  readonly releaseEvidence: readonly PosClearingEvidenceReference[];
}

export interface PosClearingCaptureResult {
  readonly captureId: string;
  readonly scope: PosClearingScope;
  readonly businessDate: string;
  readonly expectedSettlementBusinessDate?: string;
  readonly dueBusinessDate: string | null;
  readonly amountCents: number;
  readonly allocatedCents: number;
  readonly remainingCents: number;
  readonly status: PosClearingReconciliationStatus;
  readonly matchedReleaseIds: readonly string[];
  readonly sourceEvidence: readonly PosClearingEvidenceReference[];
}

export interface PosClearingReleaseResult {
  readonly releaseId: string;
  readonly scope: PosClearingScope;
  readonly businessDate: string;
  readonly amountCents: number;
  readonly allocatedCents: number;
  readonly remainingCents: number;
  readonly status: PosClearingReconciliationStatus;
  readonly receiptBacked: boolean;
  readonly matchedCaptureIds: readonly string[];
  readonly ambiguousCandidateCaptureIds: readonly string[];
  readonly sourceEvidence: readonly PosClearingEvidenceReference[];
}

export interface PosClearingPartitionResult {
  readonly partitionKey: string;
  readonly scope: PosClearingScope;
  readonly status: PosClearingReconciliationStatus;
  readonly captureIds: readonly string[];
  readonly releaseIds: readonly string[];
  readonly capturedCents: number;
  readonly releasedCents: number;
  readonly allocatedCents: number;
  readonly unresolvedCaptureCents: number;
  readonly unresolvedReleaseCents: number;
}

export interface PosClearingStatusCounts {
  readonly pending: number;
  readonly settled: number;
  readonly partially_settled: number;
  readonly ambiguous: number;
  readonly overdue_unresolved: number;
}

export interface PosClearingReconciliationResult {
  readonly asOfBusinessDate: string;
  readonly overdueGraceDays: number;
  readonly allocations: readonly PosClearingAllocation[];
  readonly captures: readonly PosClearingCaptureResult[];
  readonly releases: readonly PosClearingReleaseResult[];
  readonly partitions: readonly PosClearingPartitionResult[];
  readonly captureStatusCounts: PosClearingStatusCounts;
  readonly releaseStatusCounts: PosClearingStatusCounts;
}

interface NormalizedCapture extends PosClearingCapture {
  readonly partitionKey: string;
}

interface NormalizedRelease extends PosClearingRelease {
  readonly partitionKey: string;
}

interface MutableCaptureState {
  readonly capture: NormalizedCapture;
  allocatedCents: number;
  readonly matchedReleaseIds: string[];
  ambiguous: boolean;
}

interface MutableReleaseState {
  readonly release: NormalizedRelease;
  allocatedCents: number;
  status: PosClearingReconciliationStatus;
  readonly matchedCaptureIds: string[];
  readonly ambiguousCandidateCaptureIds: string[];
}

interface MutableAmbiguousPartitionState {
  balanceCents: number;
  brokenChronology: boolean;
  lastReleaseBusinessDate: string;
  readonly captureIds: Set<string>;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_EXACT_SUBSET_CANDIDATES = 32;
const MAX_EXACT_SUBSET_STATES = 100_000;

function assertNonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function parseBusinessDate(value: string, fieldName: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} must be a valid calendar date`);
  }
  return timestamp / DAY_MILLISECONDS;
}

function formatBusinessDate(day: number): string {
  return new Date(day * DAY_MILLISECONDS).toISOString().slice(0, 10);
}

function assertAmountCents(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer number of cents`);
  }
  return value;
}

function freezeScope(scope: PosClearingScope, fieldName: string): PosClearingScope {
  return Object.freeze({
    organizationId: assertNonEmpty(scope.organizationId, `${fieldName}.organizationId`),
    quickBooksCompanyId: assertNonEmpty(
      scope.quickBooksCompanyId,
      `${fieldName}.quickBooksCompanyId`,
    ),
    locationId: assertNonEmpty(scope.locationId, `${fieldName}.locationId`),
    currencyCode: assertNonEmpty(scope.currencyCode, `${fieldName}.currencyCode`).toUpperCase(),
    clearingAccountId: assertNonEmpty(
      scope.clearingAccountId,
      `${fieldName}.clearingAccountId`,
    ),
  });
}

function partitionKey(scope: PosClearingScope): string {
  return JSON.stringify([
    scope.organizationId,
    scope.quickBooksCompanyId,
    scope.locationId,
    scope.currencyCode,
    scope.clearingAccountId,
  ]);
}

function freezeEvidence(
  evidence: readonly PosClearingEvidenceReference[],
  fieldName: string,
  seenEvidenceIds: Set<string>,
): readonly PosClearingEvidenceReference[] {
  if (evidence.length === 0) {
    throw new Error(`${fieldName} must contain at least one immutable evidence reference`);
  }

  return Object.freeze(
    evidence.map((reference, index) => {
      const evidenceId = assertNonEmpty(
        reference.evidenceId,
        `${fieldName}[${index}].evidenceId`,
      );
      if (seenEvidenceIds.has(evidenceId)) {
        throw new Error(`Duplicate evidenceId: ${evidenceId}`);
      }
      seenEvidenceIds.add(evidenceId);

      return Object.freeze({
        evidenceId,
        entityType: reference.entityType,
        ...(reference.providerTransactionId
          ? {
              providerTransactionId: assertNonEmpty(
                reference.providerTransactionId,
                `${fieldName}[${index}].providerTransactionId`,
              ),
            }
          : {}),
        ...(reference.documentNumber
          ? {
              documentNumber: assertNonEmpty(
                reference.documentNumber,
                `${fieldName}[${index}].documentNumber`,
              ),
            }
          : {}),
        ...(reference.lineId
          ? { lineId: assertNonEmpty(reference.lineId, `${fieldName}[${index}].lineId`) }
          : {}),
      });
    }),
  );
}

function compareDatedIds(
  left: { readonly businessDate: string },
  leftId: string,
  right: { readonly businessDate: string },
  rightId: string,
): number {
  return left.businessDate.localeCompare(right.businessDate) || leftId.localeCompare(rightId);
}

interface ExactSubsetState {
  readonly ways: 1 | 2;
  readonly uniqueMask?: bigint;
  readonly participantMask: bigint;
}

function findExactSubset(
  candidates: readonly MutableCaptureState[],
  targetCents: number,
): { readonly kind: 'none' } | { readonly kind: 'unique'; readonly captureIds: readonly string[] } | {
  readonly kind: 'ambiguous';
  readonly captureIds: readonly string[];
  readonly blockedCaptureIds: readonly string[];
} {
  // A very large partition can otherwise create exponentially many subset
  // states. Refuse to guess when the evidence set is beyond the bounded proof.
  if (candidates.length > MAX_EXACT_SUBSET_CANDIDATES) {
    return {
      kind: 'ambiguous',
      captureIds: Object.freeze(candidates.map((candidate) => candidate.capture.captureId)),
      blockedCaptureIds: Object.freeze([]),
    };
  }

  const states = new Map<number, ExactSubsetState>();
  states.set(0, { ways: 1, uniqueMask: BigInt(0), participantMask: BigInt(0) });

  for (const [candidateIndex, candidate] of candidates.entries()) {
    const candidateMask = BigInt(1) << BigInt(candidateIndex);
    const remainingCents = candidate.capture.amountCents - candidate.allocatedCents;
    const snapshot = [...states.entries()];
    for (const [sumCents, state] of snapshot) {
      const nextSumCents = sumCents + remainingCents;
      if (nextSumCents > targetCents) continue;

      const existing = states.get(nextSumCents);
      const nextUniqueMask = state.ways === 1 && state.uniqueMask !== undefined
        ? state.uniqueMask | candidateMask
        : undefined;
      const nextParticipantMask = state.participantMask | candidateMask;
      if (!existing) {
        states.set(nextSumCents, {
          ways: state.ways,
          uniqueMask: nextUniqueMask,
          participantMask: nextParticipantMask,
        });
        continue;
      }

      const combinedWays = Math.min(2, existing.ways + state.ways) as 1 | 2;
      states.set(nextSumCents, {
        ways: combinedWays,
        uniqueMask: combinedWays === 1 ? existing.uniqueMask : undefined,
        participantMask: existing.participantMask | nextParticipantMask,
      });
    }
    if (states.size > MAX_EXACT_SUBSET_STATES) {
      return {
        kind: 'ambiguous',
        captureIds: Object.freeze(candidates.map((candidate) => candidate.capture.captureId)),
        blockedCaptureIds: Object.freeze([]),
      };
    }
  }

  const target = states.get(targetCents);
  if (!target) return { kind: 'none' };
  if (target.ways > 1 || target.uniqueMask === undefined) {
    const participantCaptureIds = Object.freeze(candidates
      .filter((_, index) => (
        target.participantMask & (BigInt(1) << BigInt(index))
      ) !== BigInt(0))
      .map((candidate) => candidate.capture.captureId));
    return {
      kind: 'ambiguous',
      captureIds: participantCaptureIds,
      blockedCaptureIds: participantCaptureIds,
    };
  }
  return {
    kind: 'unique',
    captureIds: Object.freeze(candidates
      .filter((_, index) => (
        target.uniqueMask! & (BigInt(1) << BigInt(index))
      ) !== BigInt(0))
      .map((candidate) => candidate.capture.captureId)),
  };
}

function emptyStatusCounts(): Record<PosClearingReconciliationStatus, number> {
  return {
    pending: 0,
    settled: 0,
    partially_settled: 0,
    ambiguous: 0,
    overdue_unresolved: 0,
  };
}

function freezeStatusCounts(
  statuses: readonly PosClearingReconciliationStatus[],
): PosClearingStatusCounts {
  const counts = emptyStatusCounts();
  for (const status of statuses) counts[status] += 1;
  return Object.freeze(counts);
}

function aggregatePartitionStatus(
  statuses: readonly PosClearingReconciliationStatus[],
): PosClearingReconciliationStatus {
  if (statuses.includes('ambiguous')) return 'ambiguous';
  if (statuses.includes('overdue_unresolved')) return 'overdue_unresolved';
  if (statuses.includes('partially_settled')) return 'partially_settled';
  if (statuses.includes('pending')) return 'pending';
  return 'settled';
}

/**
 * Reconciles POS clearing captures to later clearing releases without relying on
 * mutable descriptions, display document numbers, or FIFO guesses.
 *
 * Exact sums are allocated only when one unique subset exists. If more than one
 * subset can satisfy a release, the full open account cohort is held as
 * ambiguous and no allocation is emitted. Later evidence in that partition is
 * not treated as a fresh exact match until the chronological account balance
 * returns to zero. This makes retries deterministic without fabricating a
 * transaction-level allocation.
 */
export function reconcilePosClearing(
  input: PosClearingReconciliationInput,
): PosClearingReconciliationResult {
  const asOfDay = parseBusinessDate(input.asOfBusinessDate, 'asOfBusinessDate');
  if (!Number.isSafeInteger(input.overdueGraceDays) || input.overdueGraceDays < 0) {
    throw new Error('overdueGraceDays must be a non-negative integer');
  }

  const seenCaptureIds = new Set<string>();
  const seenReleaseIds = new Set<string>();
  const seenEvidenceIds = new Set<string>();

  const captures: NormalizedCapture[] = input.captures.map((capture, index) => {
    const captureId = assertNonEmpty(capture.captureId, `captures[${index}].captureId`);
    if (seenCaptureIds.has(captureId)) throw new Error(`Duplicate captureId: ${captureId}`);
    seenCaptureIds.add(captureId);

    const businessDay = parseBusinessDate(
      capture.businessDate,
      `captures[${index}].businessDate`,
    );
    if (businessDay > asOfDay) {
      throw new Error(`captures[${index}].businessDate cannot be after asOfBusinessDate`);
    }

    if (capture.expectedSettlementBusinessDate) {
      const expectedDay = parseBusinessDate(
        capture.expectedSettlementBusinessDate,
        `captures[${index}].expectedSettlementBusinessDate`,
      );
      if (expectedDay < businessDay) {
        throw new Error(
          `captures[${index}].expectedSettlementBusinessDate cannot precede businessDate`,
        );
      }
    }

    const scope = freezeScope(capture.scope, `captures[${index}].scope`);
    return Object.freeze({
      captureId,
      scope,
      partitionKey: partitionKey(scope),
      businessDate: capture.businessDate,
      ...(capture.expectedSettlementBusinessDate
        ? { expectedSettlementBusinessDate: capture.expectedSettlementBusinessDate }
        : {}),
      amountCents: assertAmountCents(capture.amountCents, `captures[${index}].amountCents`),
      evidence: freezeEvidence(
        capture.evidence,
        `captures[${index}].evidence`,
        seenEvidenceIds,
      ),
    });
  });

  const releases: NormalizedRelease[] = input.releases.map((release, index) => {
    const releaseId = assertNonEmpty(release.releaseId, `releases[${index}].releaseId`);
    if (seenReleaseIds.has(releaseId)) throw new Error(`Duplicate releaseId: ${releaseId}`);
    seenReleaseIds.add(releaseId);

    const businessDay = parseBusinessDate(
      release.businessDate,
      `releases[${index}].businessDate`,
    );
    if (businessDay > asOfDay) {
      throw new Error(`releases[${index}].businessDate cannot be after asOfBusinessDate`);
    }

    const scope = freezeScope(release.scope, `releases[${index}].scope`);
    const sourceEvidence = freezeEvidence(
      release.evidence,
      `releases[${index}].evidence`,
      seenEvidenceIds,
    );
    if (!sourceEvidence.some((reference) => reference.entityType === 'JournalEntry')) {
      throw new Error(
        `releases[${index}].evidence must include the clearing debit JournalEntry`,
      );
    }
    return Object.freeze({
      releaseId,
      scope,
      partitionKey: partitionKey(scope),
      businessDate: release.businessDate,
      amountCents: assertAmountCents(release.amountCents, `releases[${index}].amountCents`),
      evidence: sourceEvidence,
    });
  });

  captures.sort((left, right) =>
    compareDatedIds(left, left.captureId, right, right.captureId),
  );
  releases.sort((left, right) =>
    compareDatedIds(left, left.releaseId, right, right.releaseId),
  );

  const captureStates = new Map<string, MutableCaptureState>();
  for (const capture of captures) {
    captureStates.set(capture.captureId, {
      capture,
      allocatedCents: 0,
      matchedReleaseIds: [],
      ambiguous: false,
    });
  }

  const blockedCaptureIds = new Set<string>();
  const captureDueDays = new Map<string, number | null>(captures.map((capture) => [
    capture.captureId,
    capture.expectedSettlementBusinessDate
      ? parseBusinessDate(
          capture.expectedSettlementBusinessDate,
          `capture ${capture.captureId} expected settlement date`,
        ) + input.overdueGraceDays
      : null,
  ]));
  const allocations: PosClearingAllocation[] = [];
  const releaseStates: MutableReleaseState[] = [];
  const ambiguousPartitions = new Map<string, MutableAmbiguousPartitionState>();

  const allocate = (
    captureState: MutableCaptureState,
    releaseState: MutableReleaseState,
    amountCents: number,
  ) => {
    captureState.allocatedCents += amountCents;
    captureState.matchedReleaseIds.push(releaseState.release.releaseId);
    releaseState.allocatedCents += amountCents;
    releaseState.matchedCaptureIds.push(captureState.capture.captureId);
    allocations.push(
      Object.freeze({
        captureId: captureState.capture.captureId,
        releaseId: releaseState.release.releaseId,
        amountCents,
        captureEvidence: captureState.capture.evidence,
        releaseEvidence: releaseState.release.evidence,
      }),
    );
  };

  for (const release of releases) {
    const releaseState: MutableReleaseState = {
      release,
      allocatedCents: 0,
      status: 'overdue_unresolved',
      matchedCaptureIds: [],
      ambiguousCandidateCaptureIds: [],
    };
    releaseStates.push(releaseState);

    let openAmbiguity = ambiguousPartitions.get(release.partitionKey);
    if (
      openAmbiguity &&
      !openAmbiguity.brokenChronology &&
      openAmbiguity.balanceCents === 0 &&
      openAmbiguity.lastReleaseBusinessDate < release.businessDate
    ) {
      ambiguousPartitions.delete(release.partitionKey);
      openAmbiguity = undefined;
    }

    const eligible = captures
      .map((capture) => captureStates.get(capture.captureId)!)
      .filter((state) => {
        return state.capture.partitionKey === release.partitionKey &&
          state.capture.businessDate <= release.businessDate &&
          state.allocatedCents < state.capture.amountCents &&
          !blockedCaptureIds.has(state.capture.captureId);
      });

    if (openAmbiguity) {
      for (const candidate of eligible) {
        candidate.ambiguous = true;
        blockedCaptureIds.add(candidate.capture.captureId);
        openAmbiguity.captureIds.add(candidate.capture.captureId);
        if (!openAmbiguity.brokenChronology) {
          openAmbiguity.balanceCents +=
            candidate.capture.amountCents - candidate.allocatedCents;
        }
      }
      releaseState.status = 'ambiguous';
      releaseState.ambiguousCandidateCaptureIds.push(...openAmbiguity.captureIds);
      if (
        !openAmbiguity.brokenChronology &&
        release.amountCents <= openAmbiguity.balanceCents
      ) {
        openAmbiguity.balanceCents -= release.amountCents;
      } else {
        openAmbiguity.brokenChronology = true;
      }
      openAmbiguity.lastReleaseBusinessDate = release.businessDate;
      continue;
    }

    const eligibleTotalCents = eligible.reduce(
      (sum, state) => sum + state.capture.amountCents - state.allocatedCents,
      0,
    );

    const exactSubset = findExactSubset(eligible, release.amountCents);
    if (exactSubset.kind === 'ambiguous') {
      releaseState.status = 'ambiguous';
      releaseState.ambiguousCandidateCaptureIds.push(
        ...eligible.map((candidate) => candidate.capture.captureId),
      );
      for (const candidate of eligible) {
        candidate.ambiguous = true;
        blockedCaptureIds.add(candidate.capture.captureId);
      }
      ambiguousPartitions.set(release.partitionKey, {
        balanceCents: eligibleTotalCents - release.amountCents,
        brokenChronology: eligibleTotalCents < release.amountCents,
        lastReleaseBusinessDate: release.businessDate,
        captureIds: new Set(eligible.map((candidate) => candidate.capture.captureId)),
      });
      continue;
    }

    if (exactSubset.kind === 'unique') {
      for (const captureId of exactSubset.captureIds) {
        const captureState = captureStates.get(captureId)!;
        allocate(
          captureState,
          releaseState,
          captureState.capture.amountCents - captureState.allocatedCents,
        );
      }
      releaseState.status = 'settled';
      continue;
    }

    if (eligibleTotalCents > 0 && eligibleTotalCents <= release.amountCents) {
      for (const captureState of eligible) {
        allocate(
          captureState,
          releaseState,
          captureState.capture.amountCents - captureState.allocatedCents,
        );
      }
      releaseState.status =
        releaseState.allocatedCents === release.amountCents ? 'settled' : 'partially_settled';
      continue;
    }

    if (eligible.length === 1) {
      const remainingCaptureCents =
        eligible[0].capture.amountCents - eligible[0].allocatedCents;
      allocate(
        eligible[0],
        releaseState,
        Math.min(remainingCaptureCents, release.amountCents),
      );
      releaseState.status =
        releaseState.allocatedCents === release.amountCents ? 'settled' : 'partially_settled';
      continue;
    }

    if (eligible.length > 1) {
      releaseState.status = 'ambiguous';
      releaseState.ambiguousCandidateCaptureIds.push(
        ...eligible.map((state) => state.capture.captureId),
      );
      for (const candidate of eligible) {
        candidate.ambiguous = true;
        blockedCaptureIds.add(candidate.capture.captureId);
      }
      ambiguousPartitions.set(release.partitionKey, {
        balanceCents: eligibleTotalCents - release.amountCents,
        brokenChronology: false,
        lastReleaseBusinessDate: release.businessDate,
        captureIds: new Set(eligible.map((candidate) => candidate.capture.captureId)),
      });
    }
  }

  /*
   * A clearing account can be provably settled even when no individual debit
   * has a unique capture subset. For example, captures of 40 + 90 followed by
   * releases of 100 + 30 return the same scoped account to zero, but assigning
   * either release to particular captures would be an unsupported guess.
   *
   * Reconcile those residuals only as a chronological cohort: releases may
   * consume an already accumulated balance, and the cohort closes only when
   * that balance returns exactly to zero. No PosClearingAllocation is emitted
   * for the cohort, so allocations remain evidence of unique transaction-level
   * correlation. A release that exceeds all preceding residual captures breaks
   * the candidate cohort and cannot be rescued by a later capture.
   */
  const releaseStateById = new Map(
    releaseStates.map((state) => [state.release.releaseId, state]),
  );
  const residualPartitionKeys = [...new Set([
    ...captures.map((capture) => capture.partitionKey),
    ...releases.map((release) => release.partitionKey),
  ])].sort();

  for (const key of residualPartitionKeys) {
    const dates = [...new Set([
      ...captures
        .filter((capture) => capture.partitionKey === key)
        .map((capture) => capture.businessDate),
      ...releases
        .filter((release) => release.partitionKey === key)
        .map((release) => release.businessDate),
    ])].sort();
    let cohortBalanceCents = 0;
    let cohortCaptureStates: MutableCaptureState[] = [];
    let cohortReleaseStates: MutableReleaseState[] = [];

    const resetCohort = () => {
      cohortBalanceCents = 0;
      cohortCaptureStates = [];
      cohortReleaseStates = [];
    };

    for (const date of dates) {
      const dateCaptureStates = captures
        .filter((capture) => capture.partitionKey === key && capture.businessDate === date)
        .map((capture) => captureStates.get(capture.captureId)!)
        .filter((state) => state.allocatedCents < state.capture.amountCents);
      for (const state of dateCaptureStates) {
        cohortCaptureStates.push(state);
        cohortBalanceCents += state.capture.amountCents - state.allocatedCents;
      }

      const dateReleaseStates = releases
        .filter((release) => release.partitionKey === key && release.businessDate === date)
        .map((release) => releaseStateById.get(release.releaseId)!)
        .filter((state) => state.allocatedCents < state.release.amountCents);
      const dateReleaseCents = dateReleaseStates.reduce(
        (sum, state) => sum + state.release.amountCents - state.allocatedCents,
        0,
      );

      if (dateReleaseCents > cohortBalanceCents) {
        // The debit is not supported by the residual balance that existed on
        // or before this business date. Do not let future captures backfill it.
        resetCohort();
        continue;
      }

      cohortReleaseStates.push(...dateReleaseStates);
      cohortBalanceCents -= dateReleaseCents;
      if (
        cohortBalanceCents !== 0 ||
        cohortCaptureStates.length === 0 ||
        cohortReleaseStates.length === 0
      ) {
        continue;
      }

      const cohortCaptureIds = cohortCaptureStates.map((state) => state.capture.captureId);
      for (const captureState of cohortCaptureStates) {
        captureState.allocatedCents = captureState.capture.amountCents;
        captureState.ambiguous = false;
        blockedCaptureIds.delete(captureState.capture.captureId);
      }
      for (const releaseState of cohortReleaseStates) {
        releaseState.allocatedCents = releaseState.release.amountCents;
        releaseState.status = 'settled';
        // Keep cohort membership separate from matchedCaptureIds: the account
        // is settled, but no individual release-to-capture allocation was
        // proven. Downstream component builders can still join the cohort via
        // ambiguousCandidateCaptureIds without presenting a fabricated match.
        releaseState.ambiguousCandidateCaptureIds.splice(
          0,
          releaseState.ambiguousCandidateCaptureIds.length,
          ...cohortCaptureIds,
        );
      }
      resetCohort();
    }
  }

  const captureResults: PosClearingCaptureResult[] = captures.map((capture) => {
    const state = captureStates.get(capture.captureId)!;
    const remainingCents = capture.amountCents - state.allocatedCents;
    const dueDay = captureDueDays.get(capture.captureId) ?? null;
    const status: PosClearingReconciliationStatus = state.ambiguous
      ? 'ambiguous'
      : remainingCents === 0
        ? 'settled'
        : state.allocatedCents > 0
          ? 'partially_settled'
          : dueDay !== null && asOfDay > dueDay
            ? 'overdue_unresolved'
            : 'pending';

    return Object.freeze({
      captureId: capture.captureId,
      scope: capture.scope,
      businessDate: capture.businessDate,
      ...(capture.expectedSettlementBusinessDate
        ? { expectedSettlementBusinessDate: capture.expectedSettlementBusinessDate }
        : {}),
      dueBusinessDate: dueDay === null ? null : formatBusinessDate(dueDay),
      amountCents: capture.amountCents,
      allocatedCents: state.allocatedCents,
      remainingCents,
      status,
      matchedReleaseIds: Object.freeze([...state.matchedReleaseIds]),
      sourceEvidence: capture.evidence,
    });
  });

  const releaseResults: PosClearingReleaseResult[] = releaseStates.map((state) =>
    Object.freeze({
      releaseId: state.release.releaseId,
      scope: state.release.scope,
      businessDate: state.release.businessDate,
      amountCents: state.release.amountCents,
      allocatedCents: state.allocatedCents,
      remainingCents: state.release.amountCents - state.allocatedCents,
      status: state.status,
      receiptBacked: state.release.evidence.some(
        (reference) => reference.entityType === 'SalesReceipt',
      ),
      matchedCaptureIds: Object.freeze([...state.matchedCaptureIds]),
      ambiguousCandidateCaptureIds: Object.freeze([
        ...state.ambiguousCandidateCaptureIds,
      ]),
      sourceEvidence: state.release.evidence,
    }),
  );

  const allPartitionKeys = [...new Set([
    ...captures.map((capture) => capture.partitionKey),
    ...releases.map((release) => release.partitionKey),
  ])].sort();
  const partitions: PosClearingPartitionResult[] = allPartitionKeys.map((key) => {
    const scopedCaptures = captureResults.filter(
      (result) => partitionKey(result.scope) === key,
    );
    const scopedReleases = releaseResults.filter(
      (result) => partitionKey(result.scope) === key,
    );
    const scope = scopedCaptures[0]?.scope ?? scopedReleases[0].scope;
    return Object.freeze({
      partitionKey: key,
      scope,
      status: aggregatePartitionStatus([
        ...scopedCaptures.map((capture) => capture.status),
        ...scopedReleases.map((release) => release.status),
      ]),
      captureIds: Object.freeze(scopedCaptures.map((capture) => capture.captureId)),
      releaseIds: Object.freeze(scopedReleases.map((release) => release.releaseId)),
      capturedCents: scopedCaptures.reduce((sum, capture) => sum + capture.amountCents, 0),
      releasedCents: scopedReleases.reduce((sum, release) => sum + release.amountCents, 0),
      allocatedCents: scopedCaptures.reduce(
        (sum, capture) => sum + capture.allocatedCents,
        0,
      ),
      unresolvedCaptureCents: scopedCaptures.reduce(
        (sum, capture) => sum + capture.remainingCents,
        0,
      ),
      unresolvedReleaseCents: scopedReleases.reduce(
        (sum, release) => sum + release.remainingCents,
        0,
      ),
    });
  });

  return Object.freeze({
    asOfBusinessDate: input.asOfBusinessDate,
    overdueGraceDays: input.overdueGraceDays,
    allocations: Object.freeze(allocations),
    captures: Object.freeze(captureResults),
    releases: Object.freeze(releaseResults),
    partitions: Object.freeze(partitions),
    captureStatusCounts: freezeStatusCounts(captureResults.map((capture) => capture.status)),
    releaseStatusCounts: freezeStatusCounts(releaseResults.map((release) => release.status)),
  });
}
