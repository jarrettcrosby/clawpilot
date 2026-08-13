import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveWearablePendingConfirmationState } from '../../lib/operations/wearablePicking.ts'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('wearable queue is signed-worker scoped and read only', () => {
  const persistence = read('lib/persistence/wearablePicking.ts')
  assert.match(persistence, /lower\(pick\.assigned_to\) = \$2/)
  assert.match(persistence, /pick\.status = 'ready'/)
  assert.match(persistence, /orders\.status = 'released'/)
  assert.match(persistence, /plan\.status = 'released'/)
  assert.match(persistence, /wave\.status = 'released'/)
  assert.match(persistence, /operations_product_channel_states channel/)
  assert.match(persistence, /channel\.provider_barcode/)
  assert.match(persistence, /channel\.provider_sku = line\.channel_sku/)
  assert.match(persistence, /crm_product_image_assets asset/)
  assert.match(persistence, /asset\.is_primary = true/)
  assert.match(persistence, /publicCrmProductImageUrl/)
  assert.doesNotMatch(persistence, /line\.barcode_snapshot/)
  assert.doesNotMatch(persistence, /\b(?:INSERT|UPDATE|DELETE)\b/)
})

test('pending confirmation recovery rejects duplicate evidence and requires exact zero-write reconciliation', () => {
  const exact = {
    orderStatus: 'cancelled',
    orderRowVersion: 8,
    planStatus: 'cancelled',
    reconciliationRequired: false,
    reconciliationGlobalId: 'gsfr0000001',
    providerWriteCount: 0,
    reconciliationIsAuthoritative: true,
  }
  const resolved = resolveWearablePendingConfirmationState({
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 7,
    candidates: [exact],
  })
  assert.equal(resolved.state, 'reconciled_external_fulfillment')
  assert.equal(resolved.providerWrites, 0)

  const duplicates = resolveWearablePendingConfirmationState({
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 7,
    candidates: [exact, { ...exact, reconciliationGlobalId: 'gsfr0000002' }],
  })
  assert.equal(duplicates.state, 'unresolved')
  assert.equal(duplicates.reconciliationGlobalId, null)

  const providerWrite = resolveWearablePendingConfirmationState({
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 7,
    candidates: [{ ...exact, providerWriteCount: 1 }],
  })
  assert.equal(providerWrite.state, 'unresolved')
})

test('location-first scanning is an explicit audited per-warehouse policy that defaults off', () => {
  const migration = read('../db/migrations/0264_operations_wearable_location_scan_policy.sql')
  const policy = read('lib/persistence/wearableLocationScanPolicy.ts')
  const labels = read('lib/persistence/operationBarcodeLabels.ts')
  const route = read('app/api/operations/barcode-labels/route.ts')
  const dialog = read('components/operations/BarcodeLabelsDialog.tsx')

  assert.match(migration, /operations_wearable_location_scan_policies/)
  assert.match(migration, /location_scan_required boolean NOT NULL DEFAULT false/)
  assert.match(migration, /row_version bigint NOT NULL DEFAULT 0/)
  assert.match(migration, /operations_wearable_location_scan_policy_commands/)
  assert.match(migration, /PRIMARY KEY \(organization_id, idempotency_key\)/)
  assert.match(migration, /rows are immutable/)
  assert.doesNotMatch(
    migration,
    /INSERT INTO operations_wearable_location_scan_policies/,
    'Migration must not silently enable or materialize a policy for any warehouse',
  )

  assert.match(policy, /locationScanRequired: row\.location_scan_required === true/)
  assert.match(policy, /row_version = operations_wearable_location_scan_policies\.row_version \+ 1/)
  assert.match(policy, /OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_STALE/)
  assert.match(policy, /OPERATIONS_WEARABLE_LOCATION_SCAN_POLICY_IDEMPOTENCY_REUSED/)
  assert.match(policy, /operations\.wearable_location_scan_policy\.updated/)
  assert.match(labels, /readWearableLocationScanPoliciesFromPostgres/)
  assert.match(route, /'update-location-scan-policy'/)
  assert.match(route, /expectedRowVersion/)
  assert.match(route, /capabilities\.canManage/)
  assert.match(dialog, /Require location label before product scan/)
  assert.match(dialog, /Warehouse-specific and off by default/)
})

test('wearable queue emits exact CP1L identity only for enabled warehouse policy', () => {
  const contract = read('lib/operations/wearablePicking.ts')
  const persistence = read('lib/persistence/wearablePicking.ts')

  assert.match(contract, /locationBarcode\?: string/)
  assert.match(contract, /locationScanRequired\?: true/)
  assert.match(persistence, /location\.global_id AS location_global_id/)
  assert.match(persistence, /LEFT JOIN operations_wearable_location_scan_policies scan_policy/)
  assert.match(persistence, /COALESCE\(scan_policy\.location_scan_required, false\)/)
  assert.match(persistence, /row\.location_scan_required \? \{/)
  assert.match(persistence, /locationBarcode\(/)
  assert.match(persistence, /locationScanRequired: true as const/)
})

test('native scan state requires location before product without giving Watch confirmation authority', () => {
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const camera = read('../clients/apple/Apps/iPhone/PhoneCameraScanner.swift')
  const meta = read('../clients/apple/Apps/iPhone/MetaWearablesBarcodeSource.swift')
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')

  assert.match(models, /public let locationBarcode: String\?/)
  assert.match(models, /public let locationScanRequired: Bool\?/)
  assert.match(models, /enum PickScanStage/)
  assert.match(session, /locationVerifiedTaskIDs/)
  assert.match(session, /observation\.value == expected/)
  assert.match(session, /PickScanAcceptance\(task: task, stage: \.location\)/)
  assert.match(session, /PickScanAcceptance\(task: task, stage: \.product\)/)
  assert.match(session, /locationScanRequired: locationPending/)
  assert.match(phone, /Location matched\. Confirm when you are ready to scan the product/)
  assert.match(phone, /acceptPhoneCameraBarcode/)
  assert.match(camera, /onBarcode: @MainActor \(String\) async -> PhoneCameraScanOutcome/)
  assert.match(meta, /struct MetaBarcodeDecodeTarget/)
  assert.match(meta, /static func location\(expectedValue: String\?\)/)
  assert.match(meta, /static func product\(expectedValue: String\?\)/)
  assert.match(meta, /init\(target: MetaBarcodeDecodeTarget\)/)
  assert.match(phone, /\.location\(expectedValue: task\.locationBarcode\)/)
  assert.match(phone, /\.product\(expectedValue: task\.barcode\)/)
  assert.match(
    phone,
    /MetaWearablesBarcodeSource\(\s*target: metaDecodeTarget\(for: initialTask, stage: initialStage\)\s*\)/,
  )
  assert.match(meta, /prepareForNextBarcode/)
  assert.match(
    phone,
    /await source\.prepareForNextBarcode\(\s*target: metaDecodeTarget\(for: task, stage: stage\),\s*suppressedValue: acceptedLocationValue\s*\)/,
  )
  assert.match(watch, /current\.locationScanRequired == true/)
  assert.doesNotMatch(watch, /ConfirmPicksCommand|PickingAPIClient/)
})

test('Meta stop invalidates the active scan before stopping its source and cannot become a timeout', () => {
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const meta = read('../clients/apple/Apps/iPhone/MetaWearablesBarcodeSource.swift')
  const cancel = phone.match(/func cancelMetaScan\(\) async \{[\s\S]*?\n    \}/)?.[0] ?? ''

  assert.match(phone, /private var activeMetaScanID: UUID\?/)
  assert.match(phone, /private enum MetaBarcodeWaitOutcome: Sendable/)
  assert.match(phone, /case timedOut/)
  assert.match(phone, /case sourceEnded/)
  assert.match(phone, /case cancelled/)
  assert.match(
    phone,
    /if activeMetaScanID == scanID \{\s*activeMetaScanID = nil\s*metaSource = nil\s*isMetaScanning = false/,
  )
  assert.match(
    cancel,
    /activeMetaScanID = nil[\s\S]*metaStatus = "Stopping Meta scan…"[\s\S]*await source\.stop\(\)[\s\S]*isMetaScanning = false/,
  )
  assert.doesNotMatch(cancel, /timeout:no-barcode|voice\.speak/)
  assert.match(
    phone,
    /let outcome = await withTaskGroup\(of: MetaBarcodeWaitOutcome\.self\)[\s\S]*guard activeMetaScanID == scanID else \{ return nil \}[\s\S]*switch outcome/,
  )
  assert.match(
    phone,
    /case \.sourceEnded:[\s\S]*source-ended:no-barcode[\s\S]*case \.cancelled:/,
  )
  assert.match(
    phone,
    /if didTimeOut \{[\s\S]*timeout:no-barcode[\s\S]*voice\.speak/,
  )
  assert.match(phone, /metaScanID: UUID\? = nil/)
  assert.match(
    phone,
    /let acceptance = try await picking\.accept[\s\S]*guard shouldApplyMetaScanResult\(metaScanID\) else/,
  )
  assert.match(phone, /Location matched just before the Meta scan stopped\. Scan the product next\./)
  assert.match(phone, /Product matched just before the Meta scan stopped\./)
  assert.match(phone, /source: \.metaGlasses,\s*metaScanID: scanID/)
  assert.match(phone, /let acceptance = await accept\(value, source: \.iPhoneCamera\)/)
  assert.match(phone, /matched:stage=\\\(acceptance\.stage\.rawValue\)/)
  assert.match(phone, /mismatch:stage=location/)
  assert.match(phone, /mismatch:stage=product/)
  assert.match(phone, /decoded:stage=\\\(currentScanStage\?\.rawValue \?\? "unknown"\)/)
  assert.equal(phone.includes('ClawPilotScanDiagnostic.record("decoded:\\(value)'), false)
  assert.equal(phone.includes('ClawPilotScanDiagnostic.record("matched:\\(acceptance.stage.rawValue):\\(value)'), false)
  assert.equal(phone.includes('ClawPilotScanDiagnostic.record("location-mismatch:\\(value)'), false)
  assert.equal(phone.includes('ClawPilotScanDiagnostic.record("product-mismatch:\\(value)'), false)
  assert.match(meta, /private var teardownTask: Task<Void, Never>\?/)
  assert.match(meta, /private var stopRequested = false/)
  assert.match(meta, /guard !stopRequested, teardownTask == nil else/)
  assert.match(
    meta,
    /guard try await Wearables\.shared\.checkPermissionStatus\(\.camera\) == \.granted[\s\S]*guard !stopRequested else/,
  )
  assert.match(meta, /func stop\(\) async \{\s*if let task = failStart\(\) \{\s*await task\.value/)
  assert.match(
    meta,
    /let states = session\.stateStream\(\)\s*session\.stop\(\)[\s\S]*timeout: \.seconds\(4\)/,
  )
  assert.match(meta, /if session\.state == \.stopped \{ return true \}/)
  assert.match(meta, /for await state in states \{\s*if state == \.stopped \{ return true \}/)
  assert.match(meta, /group\.cancelAll\(\)/)
  assert.match(meta, /session-teardown:outcome=stopped/)
  assert.match(meta, /session-teardown:outcome=timeout:state=/)
})

test('iPhone camera keeps a fast stage-aware live scan with an in-memory still fallback', () => {
  const camera = read('../clients/apple/Apps/iPhone/PhoneCameraScanner.swift')
  const lifecycle = read('../clients/apple/Sources/ClawPilotPickingApple/PhoneCameraScanLifecycle.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')

  assert.match(camera, /qualityLevel: \.fast/)
  assert.match(camera, /recognizesMultipleItems: true/)
  assert.match(camera, /isHighFrameRateTrackingEnabled: true/)
  assert.match(camera, /\.barcode\(symbologies: \[\.code128, \.ean8, \.ean13, \.upce, \.qr\]\)/)
  assert.match(camera, /for await items in scanner\.recognizedItems/)
  assert.match(camera, /didUpdate updatedItems/)
  assert.match(camera, /preferredPayload\(in payloads:/)
  assert.match(camera, /capturePhoto\(\)/)
  assert.match(camera, /VNDetectBarcodesRequest\(\)/)
  assert.match(camera, /Nothing is saved/)
  assert.match(camera, /within two seconds/)
  assert.match(camera, /fallback-start/)
  assert.match(camera, /elapsed_ms/)
  assert.doesNotMatch(
    camera.match(/private func submit[\s\S]*?@objc private func captureCurrentFrame/)?.[0] ?? '',
    /stopScanning\(\)/,
  )
  assert.match(phone, /Location matched\. Continue deliberately when you are ready to scan the product/)
  assert.match(phone, /PhoneCameraScanOutcome/)
  assert.match(phone, /interactiveDismissDisabled\(\)/)
  assert.match(camera, /import ClawPilotPickingApple/)
  assert.match(lifecycle, /public struct PhoneCameraScanLifecycle: Sendable/)
  assert.match(camera, /let submissionToken = lifecycle\.beginSubmission\(\)/)
  assert.match(camera, /guard !Task\.isCancelled,[\s\S]*lifecycle\.completeSubmission\(submissionToken\)/)
  assert.match(
    camera,
    /closeScanner\(\) \{\s*recordDiagnostic\("close-tapped"\)\s*dismissScanner\(reason: "user"\)/,
  )
  assert.match(camera, /closeButton\.addTarget\(self, action: #selector\(closeScanner\), for: \.touchUpInside\)/)
  assert.doesNotMatch(camera, /scanner\.overlayContainerView/)
  assert.match(camera, /let controlsOverlayView = PhoneCameraControlsOverlayView\(\)/)
  assert.match(
    camera,
    /view\.addSubview\(scanner\.view\)[\s\S]*view\.addSubview\(controlsOverlayView\)/,
  )
  assert.match(camera, /view\.bringSubviewToFront\(controlsOverlayView\)/)
  assert.match(
    camera,
    /final class PhoneCameraControlsOverlayView: UIView[\s\S]*override func hitTest[\s\S]*return hitView === self \? nil : hitView/,
  )
  assert.match(
    camera,
    /private func dismissScanner\(reason: String\) \{\s*guard lifecycle\.dismiss\(\) else \{ return \}[\s\S]*stopAllWork\(scanner\)[\s\S]*parent\.onClose\(\)/,
  )
  const stopAllWork = camera.match(/private func stopAllWork[\s\S]*?\n        \}/)?.[0] ?? ''
  assert.match(stopAllWork, /authorizationTask\?\.cancel\(\)/)
  assert.match(stopAllWork, /recognizedItemsTask\?\.cancel\(\)/)
  assert.match(stopAllWork, /photoTask\?\.cancel\(\)/)
  assert.match(stopAllWork, /mismatchRetryTask\?\.cancel\(\)/)
  assert.match(stopAllWork, /submissionTask\?\.cancel\(\)/)
  assert.match(stopAllWork, /scanner\.delegate = nil/)
  assert.match(stopAllWork, /scanner\.stopScanning\(\)/)
  assert.match(
    camera,
    /let image = try await scanner\.capturePhoto\(\)[\s\S]*lifecycle\.permitsCompletion\(of: operationToken\)[\s\S]*let payloads = try await Task\.detached[\s\S]*lifecycle\.permitsCompletion\(of: operationToken\)/,
  )
})

test('iPhone camera gives privacy-safe deduped voice feedback for a wrong barcode', () => {
  const camera = read('../clients/apple/Apps/iPhone/PhoneCameraScanner.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const voice = read('../clients/apple/Apps/iPhone/VoiceConfirmationController.swift')

  assert.match(camera, /struct PhoneCameraMismatchSpeechGate/)
  assert.match(camera, /minimumRetryAttemptInterval: TimeInterval = 0\.25/)
  assert.match(camera, /minimumAnnouncementInterval: TimeInterval = 1\.5/)
  assert.match(camera, /samePayloadRepeatInterval: TimeInterval = 10/)
  assert.match(camera, /pendingPayloads\.formUnion\(currentPayloads\.subtracting\(visiblePayloads\)\)/)
  assert.match(camera, /if parent\.onMismatch\(activeContext\.stage\) \{[\s\S]*recordAnnouncement\(\)/)
  assert.match(camera, /scheduleMismatchRetry\(for: activeContext\.identity\)/)
  assert.match(camera, /Task\.sleep\(for: \.milliseconds\(300\)\)/)
  assert.match(camera, /preferredPayload\(in: latestPayloads\)[\s\S]*parent\.onMismatch\(activeContext\.stage\)/)
  assert.match(camera, /values stay in memory only for dedupe and are never spoken or logged/)
  assert.match(phone, /onMismatch: \{ stage in model\.announcePhoneCameraMismatch\(stage\) \}/)
  assert.match(phone, /stage == \.location \? "Wrong location\." : "Wrong product\."/)
  assert.match(phone, /UIAccessibility\.isVoiceOverRunning/)
  assert.match(phone, /notification: \.announcement/)
  assert.match(phone, /voice\.speakIfIdle\(english, spanish: spanish\)/)
  assert.match(voice, /func speakIfIdle\([\s\S]*activeSpeechID == nil[\s\S]*recognitionTask == nil/)
})

test('wearable route keeps existing ClawPilot authorization boundary', () => {
  const route = read('app/api/operations/picks/route.ts')
  assert.match(route, /requireRequestUser\(req\)/)
  assert.match(route, /capabilities\.canView/)
  assert.match(route, /capabilities\.canExecute/)
  assert.doesNotMatch(route, /!capabilities\.canManage/)
  assert.match(route, /Cache-Control': 'private, no-store'/)
  assert.match(route, /import \{ appPublicUrl \} from '@\/lib\/publicUrl'/)
  assert.match(route, /publicOrigin: appPublicUrl\(\)/)
  assert.doesNotMatch(route, /publicOrigin: req\.nextUrl\.origin/)
})

test('Phase 1 confirmation reuses the audited Operations command', () => {
  const route = read('app/api/operations/route.ts')
  const persistence = read('lib/persistence/operations.ts')
  assert.match(route, /action === 'confirm-picks'/)
  assert.match(route, /idempotencyKeyValue\(req\)/)
  assert.match(persistence, /confirmOperationsOrderPicksFromPostgres/)
  assert.match(persistence, /OPERATIONS_ORDER_VERSION_CONFLICT/)
  assert.match(persistence, /operations\.pick\.completed/)
  assert.match(persistence, /operations\.order\.picks_confirmed/)
})

test('terminal Shopify confirmation conflicts require manager action and read-only exact recovery', () => {
  const picksRoute = read('app/api/operations/picks/route.ts')
  const wearablePersistence = read('lib/persistence/wearablePicking.ts')
  const adapter = read('../clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')

  assert.match(picksRoute, /pendingConfirmationOrderGlobalId/)
  assert.match(picksRoute, /pendingConfirmationExpectedRowVersion/)
  assert.match(picksRoute, /pendingConfirmationIdempotencyKey/)
  assert.match(picksRoute, /readWearablePendingConfirmationStateFromPostgres/)
  assert.doesNotMatch(picksRoute, /reconcileShopifyExternalFulfillmentFromPostgres/)
  assert.match(wearablePersistence, /provider_write_count = 0/)
  assert.match(wearablePersistence, /confirmation_receipt\.idempotency_key = \$4/)
  assert.match(wearablePersistence, /lower\(confirmation_receipt\.actor_email\) = \$3/)
  assert.match(wearablePersistence, /confirmation_receipt\.target_global_id = orders\.global_id/)
  assert.match(wearablePersistence, /confirmation_receipt\.status = 'failed'/)
  assert.match(wearablePersistence, /confirmation_receipt\.error_code =\s*'OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED'/)
  assert.match(wearablePersistence, /lower\(assigned_pick\.assigned_to\) = \$3/)
  assert.match(wearablePersistence, /lower\(COALESCE\(other_pick\.assigned_to, ''\)\) <> \$3/)
  assert.match(wearablePersistence, /receipt\.command_type =\s*'reconcile_shopify_external_fulfillment'/)
  assert.match(wearablePersistence, /ORDER BY candidate\.reconciled_at DESC, candidate\.id DESC\s*LIMIT 2/)
  assert.match(adapter, /if !\(200\.\.<300\)\.contains\(http\.statusCode\)[\s\S]*PickingAPIError\.rejected\(code: code, message: message\)/)
  assert.match(adapter, /func recheckPendingConfirmation/)
  assert.match(session, /durableCommand == command/)
  assert.match(session, /evidence\.orderGlobalId == command\.orderGlobalId/)
  assert.match(session, /public func finishConfirmedOrder\(_ command: ConfirmPicksCommand\)/)
  assert.match(session, /try await cache\.loadOutbox\(\) == command[\s\S]*try await cache\.saveQueue\(replacementQueue\)[\s\S]*try await cache\.clearOutbox\(\)/)
  assert.match(session, /try await cache\.clearProgress\(\)[\s\S]*try await cache\.saveQueue\(replacementQueue\)[\s\S]*try await cache\.clearOutbox\(\)/)
  assert.match(phone, /OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED/)
  assert.match(phone, /recheckPendingConfirmationAfterManagerAction/)
  assert.doesNotMatch(phone, /try\? await cache\.loadOutbox/)
  assert.match(phone, /func protectUnreadablePendingConfirmation[\s\S]*hasPendingConfirmation = true/)
  assert.match(phone, /resumeDurableConfirmationIfNeeded\(\)[\s\S]*recheckPendingConfirmation\(pending\)[\s\S]*Prior confirmation remains pending/)
  assert.match(phone, /func verifyCode\(\)[\s\S]*let restoredProfile = try await api\.fetchSessionProfile\(\)[\s\S]*isRestoringSession = true[\s\S]*isAuthenticated = true[\s\S]*recoverWorkspaceTransitionIfNeeded[\s\S]*resumeDurableConfirmationIfNeeded\(\)/)
  assert.match(phone, /func signInWithGoogle\(\)[\s\S]*let restoredProfile = try await api\.fetchSessionProfile\(\)[\s\S]*isRestoringSession = true[\s\S]*isAuthenticated = true[\s\S]*recoverWorkspaceTransitionIfNeeded[\s\S]*resumeDurableConfirmationIfNeeded\(\)/)
  assert.match(phone, /var canSwitchWorkspace:[\s\S]*!isRestoringSession[\s\S]*!isRecheckingPendingConfirmation[\s\S]*!isConfirmingOrder[\s\S]*!isRequestingPickHandoff[\s\S]*!hasPendingConfirmation/)
  assert.match(phone, /func retryPendingConfirmation\(\) async \{[\s\S]*guard !isConfirmingOrder,[\s\S]*!hasPendingWorkspaceTransition else \{ return \}[\s\S]*isConfirmingOrder = true[\s\S]*finishConfirmedOrder\(pending\)/)
  assert.match(dashboard, /Manager reconciliation required/)
  assert.match(dashboard, /Refresh after manager reconciliation/)
  assert.match(dashboard, /does not change Shopify or repeat a provider action/)
  assert.match(dashboard, /Saved confirmation protected/)
  assert.doesNotMatch(dashboard, /Abandon blocked pick|Clear blocked pick/)
})

test('native picker handoff is durable, identity fenced, deliberate, and crash recoverable', () => {
  const route = read('app/api/operations/route.ts')
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const adapter = read('../clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')

  assert.match(route, /action === 'request-pick-handoff'/)
  assert.match(route, /blockedConfirmationIdempotencyKey/)
  assert.match(models, /public struct PickHandoffCommand: Codable, Equatable, Sendable/)
  assert.match(models, /expectedAssignedTaskCount/)
  assert.match(models, /blockedConfirmationIdempotencyKey/)
  assert.match(session, /saveHandoffOutbox\(_ command: PickHandoffCommand\)/)
  assert.match(session, /persistPickHandoff/)
  assert.match(session, /localPickingProgressIsEmpty\(\)/)
  assert.match(session, /try await cache\.saveQueue\(replacementQueue\)[\s\S]*try await cache\.clearHandoffOutbox\(\)/)
  assert.match(session, /retireBlockedHandoffAfterExternalReconciliation/)
  assert.match(adapter, /func requestPickHandoff/)
  assert.match(adapter, /request\.setValue\(command\.idempotencyKey, forHTTPHeaderField: "Idempotency-Key"\)/)
  assert.match(adapter, /expectedAssignedTaskCount: command\.expectedAssignedTaskCount/)
  assert.match(phone, /resumeDurablePickHandoffIfNeeded\(\)[\s\S]*resumeDurableConfirmationIfNeeded\(\)/)
  assert.match(phone, /pendingPickHandoffRecoveryWorkspaceId/)
  assert.match(phone, /isPendingHandoffRecoverySwitch/)
  assert.match(phone, /showPhoneScanner = false[\s\S]*stopListeningForPickCommand\(\)[\s\S]*await cancelMetaScan\(\)[\s\S]*canRequestActivePickHandoff\(\)/)
  assert.match(phone, /guard !hasPendingPickHandoff, !isRequestingPickHandoff else/)
  assert.match(phone, /let queue = try await api\.fetchQueue\(\)[\s\S]*guard !hasPendingConfirmation,[\s\S]*!hasPendingPickHandoff,[\s\S]*!isRequestingPickHandoff else/)
  assert.match(phone, /recheckPendingConfirmation\(for: command\)/)
  assert.match(dashboard, /\.alert\([\s\S]*"Request manager handoff\?"/)
  assert.match(dashboard, /TextField\("Reason for manager"/)
  assert.match(dashboard, /Request manager handoff instead/)
  assert.match(dashboard, /Hand off this unstarted order/)
  assert.match(dashboard, /Retry exact handoff/)
  assert.match(dashboard, /will not clear the pick from a missing queue row alone/)
})

test('location-first scans require durable acknowledged evidence before pick confirmation', () => {
  const migration = read('../db/migrations/0266_operations_wearable_pick_scan_evidence.sql')
  const route = read('app/api/operations/route.ts')
  const persistence = read('lib/persistence/operations.ts')
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const adapter = read('../clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')

  assert.match(migration, /operations_wearable_pick_scan_evidence/)
  assert.match(migration, /server_observed_at timestamptz NOT NULL DEFAULT now\(\)/)
  assert.match(migration, /location_source IN \('iphone_camera', 'meta'\)/)
  assert.match(migration, /product_source IN \('iphone_camera', 'meta'\)/)
  assert.match(migration, /expected_location_barcode = observed_location_barcode/)
  assert.match(migration, /operations_wearable_pick_scan_evidence rows are immutable/)
  assert.match(route, /action === 'record-pick-scan-evidence'/)
  assert.match(
    route,
    /action === 'record-pick-scan-evidence'[\s\S]*!capabilities\.canView \|\| !capabilities\.canExecute/,
  )
  assert.match(
    route,
    /action === 'confirm-picks'[\s\S]*!capabilities\.canView \|\| !capabilities\.canExecute/,
  )
  assert.match(route, /wearablePickScanEvidenceValue\(body\.scanEvidence\)/)
  assert.match(route, /scanEvidenceIdempotencyKey/)
  assert.match(persistence, /commandType: 'record_wearable_pick_scan_evidence'/)
  assert.match(persistence, /OPERATIONS_WEARABLE_LOCATION_SCAN_MISMATCH/)
  assert.match(persistence, /OPERATIONS_WEARABLE_PRODUCT_SCAN_MISMATCH/)
  assert.match(persistence, /OPERATIONS_WEARABLE_SCAN_EVIDENCE_STALE/)
  assert.match(persistence, /context\.assigned_to !== input\.actorEmail/)
  assert.match(persistence, /OPERATIONS_WEARABLE_SCAN_EVIDENCE_REQUIRED/)
  assert.match(persistence, /receipt\.status !== 'succeeded'/)
  assert.match(persistence, /if \(command\.completed\) \{[\s\S]*completedWearablePickScanEvidenceResult/)
  assert.match(persistence, /scanEvidence: input\.scanEvidence/)
  assert.match(persistence, /scanEvidenceIdempotencyKey: scanEvidenceIdempotencyKey \|\| null/)
  assert.match(persistence, /if \(required\.length < 1\)[\s\S]*return \{ enforced: false/)
  assert.match(models, /public let scanEvidence: \[PickTaskScanEvidence\]\?/)
  assert.match(models, /case metaGlasses = "meta"/)
  assert.match(session, /locationObservations/)
  assert.match(session, /productObservations/)
  assert.match(adapter, /func recordScanEvidence\(_ command: ConfirmPicksCommand\)/)
  assert.match(phone, /Syncing location and product scan evidence with ClawPilot/)
  assert.match(phone, /try await api\.recordScanEvidence\(command\)[\s\S]*try await api\.confirm\(command\)/)
  assert.match(phone, /Scans are saved on this iPhone but are not yet acknowledged by ClawPilot/)
  assert.match(phone, /Confirmation stays blocked; tap Retry exact confirmation when online/)
  assert.doesNotMatch(watch, /recordScanEvidence|PickTaskScanEvidence|scanEvidenceIdempotencyKey/)
})

test('Meta universal-link metadata and callback remain public without exposing app data', () => {
  const proxy = read('proxy.ts')
  const association = read('lib/appleAppLinks.ts')
  const callback = read('app/ios/route.ts')
  assert.match(proxy, /pathname === '\/\.well-known\/apple-app-site-association'/)
  assert.match(proxy, /pathname === '\/apple-app-site-association'/)
  assert.match(proxy, /pathname === '\/ios'/)
  assert.match(proxy, /if \(isPublicAppleAppLink\(pathname\)\) return NextResponse\.next\(\)/)
  assert.match(association, /CN2T77JHQQ\.com\.eigenracing\.ios\.picking'/)
  assert.match(association, /CN2T77JHQQ\.com\.eigenracing\.ios\.picking\.dev'/)
  assert.match(association, /'\/': '\/ios\*'/)
  assert.doesNotMatch(callback, /requireRequestUser|resolveRequestSession|operations|pipeline/)
})

test('Meta DAT callback uses the app URL scheme and camera access requires registration', () => {
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  const development = read('../clients/apple/Config/Development.xcconfig')
  const production = read('../clients/apple/Config/Production.xcconfig')
  assert.match(development, /CLAWPILOT_META_URL_SCHEME = clawpilot-meta-dev/)
  assert.match(development, /CLAWPILOT_META_APP_LINK_SCHEME = clawpilot-meta-dev:\/\$\(\)\//)
  assert.match(production, /CLAWPILOT_META_URL_SCHEME = clawpilot-meta/)
  assert.match(production, /CLAWPILOT_META_APP_LINK_SCHEME = clawpilot-meta:\/\$\(\)\//)
  assert.match(app, /if ClawPilotSystemActionLink\.requestsScan\(url\)/)
  assert.match(app, /await model\.handlePendingSystemScan\(\)/)
  assert.match(app, /await model\.handleMetaURL\(url\)/)
  assert.match(app, /guard MetaWearablesAppBridge\.isRegistered else/)
  assert.match(dashboard, /else if model\.canRequestMetaCamera/)
  assert.match(dashboard, /Button\("Allow camera access"\)/)
  assert.match(app, /await loadQueue\(readAloud: false\)/)
})

test('iPhone picking UI supports a dismissible one-time-code flow and branded icon', () => {
  const project = read('../clients/apple/project.yml')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  assert.match(project, /ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon/)
  assert.match(project, /UILaunchScreen: \{\}/)
  assert.match(dashboard, /Image\("ClawPilotMark"\)/)
  assert.match(dashboard, /\.textContentType\(\.oneTimeCode\)/)
  assert.match(dashboard, /ToolbarItemGroup\(placement: \.keyboard\)/)
  assert.match(dashboard, /Button\("Done"\) \{ authenticationField = nil \}/)
  assert.match(dashboard, /\.scrollDismissesKeyboard\(\.interactively\)/)
})

test('Watch companion keeps local audio unless exact enhanced Meta playback starts', () => {
  const project = read('../clients/apple/project.yml')
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')
  const bridge = read('../clients/apple/Apps/iPhone/PhoneWatchBridge.swift')
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const voice = read('../clients/apple/Apps/iPhone/VoiceConfirmationController.swift')
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  assert.match(project, /ClawPilotPickingWatch:[\s\S]*ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon/)
  assert.match(watch, /productImage\(model\.productImage, isExpected:/)
  assert.match(watch, /CGImageSourceCreateThumbnailAtIndex/)
  assert.match(watch, /pickProductImageData/)
  assert.match(bridge, /URLSession\.shared\.data\(for: request\)/)
  assert.match(bridge, /kCGImageSourceThumbnailMaxPixelSize: 280/)
  assert.match(bridge, /updateApplicationContext\(context\)/)
  assert.doesNotMatch(watch, /AsyncImage|URLSession/)
  assert.match(watch, /model\.send\(\.requestMetaScan\)/)
  assert.match(watch, /model\.readInstruction\(\)/)
  assert.match(watch, /AVSpeechSynthesizer/)
  assert.match(watch, /Playing instruction on Apple Watch/)
  assert.match(watch, /model\.send\(\.confirmPick\)/)
  assert.match(watch, /model\.send\(\.refreshQueue\)/)
  assert.match(bridge, /decode\(WatchPickCommand\.self/)
  assert.match(bridge, /handledCommandIDs/)
  assert.match(app, /private func handleWatchCommand/)
  assert.match(
    app,
    /case \.readInstruction:[\s\S]*?await refreshMetaStatus\(\)[\s\S]*?guard metaConnectedDeviceCount == 1[\s\S]*?speakEnhancedThroughBluetoothAndWait/,
  )
  assert.doesNotMatch(
    app,
    /case \.readInstruction:[\s\S]*?readInstruction\(forceSystemVoice: true\)/,
  )
  assert.match(app, /readInstructionOnPhone: WatchInstructionPhonePlaybackPolicy\.isEligible/)
  assert.match(models, /metaConnectedDeviceCount == 1 && enhancedVoiceReady/)
  assert.match(watch, /WatchInstructionPlaybackTarget\.resolve/)
  assert.match(watch, /playInstructionLocally\(fallbackReason: result\.message\)/)
  assert.match(project, /UIBackgroundModes:[\s\S]*?- audio/)
  assert.match(voice, /beginBackgroundTask\(withName:/)
  assert.match(voice, /guard voicePackState == \.ready/)
  assert.match(voice, /case \.bluetoothA2DP, \.bluetoothHFP, \.bluetoothLE/)
  assert.match(voice, /guard let startedOutput = session\.currentRoute\.outputs/)
  assert.match(voice, /startStrictPlaybackMonitor\([\s\S]*?return startedPlayback/)
  assert.match(
    voice,
    /validateStartedBluetoothPlayback\([\s\S]*?playbackOwnershipTransferred = true[\s\S]*?startedAt: startedPlayback\.startedAt/,
  )
  const strictPlaybackMonitor = voice.slice(
    voice.indexOf('private func startStrictPlaybackMonitor'),
    voice.indexOf('private func ensureEnhancedPlaybackAuthority'),
  )
  assert.match(strictPlaybackMonitor, /while player\.isPlaying/)
  assert.match(strictPlaybackMonitor, /uid: playback\.outputUID/)
  assert.match(strictPlaybackMonitor, /portType: playback\.outputPortType/)
  assert.doesNotMatch(strictPlaybackMonitor, /deadline/)
  assert.match(bridge, /private actor PhoneWatchOutcomeRace/)
  assert.match(bridge, /handlerTask\.cancel\(\)[\s\S]*?let handlerOutcome = await handlerTask\.value/)
  assert.match(bridge, /validatedReadInstructionOutcome/)
  assert.match(bridge, /acceptsAcknowledgedPhonePlaybackStart/)
  assert.match(app, /return \.phonePlaybackStarted\(status, startedAt: playback\.startedAt\)/)
  assert.doesNotMatch(app, /Instruction requested on the connected Meta glasses audio route/)
  assert.doesNotMatch(watch, /PickingAPIClient|ConfirmPicksCommand/)
})

test('Watch instruction falls back locally when iPhone reachability drops before send', () => {
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')
  assert.match(
    watch,
    /guard let session,[\s\S]*?session\.isReachable else \{[\s\S]*?if command\.action == \.readInstruction \{[\s\S]*?playInstructionLocally\(fallbackReason: message\)[\s\S]*?return[\s\S]*?\}[\s\S]*?actionStatus = "Open ClawPilot on the paired iPhone, then try again\."/,
  )
})

test('Watch instruction falls back locally after the paired iPhone command times out', () => {
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')
  assert.match(
    watch,
    /private func startCommandTimeout\(for command: WatchPickCommand\)[\s\S]*?case \.readInstruction: \.seconds\(\s*Int64\(WatchInstructionPlaybackTiming\.watchFallbackDelay\)\s*\)[\s\S]*?if command\.action == \.readInstruction \{[\s\S]*?finishPendingCommand\(succeeded: false, message: message\)[\s\S]*?playInstructionLocally\(fallbackReason: message\)[\s\S]*?return[\s\S]*?\}[\s\S]*?message: "The iPhone action is taking too long\. Keep ClawPilot open and try again\."/,
  )
})

test('multi-unit picks require a deliberate popup count on iPhone or Watch', () => {
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const adapters = read('../clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')

  assert.match(models, /quantity\.rounded\(\.towardZero\) == quantity/)
  assert.match(models, /public struct PickTaskCountEvidence/)
  assert.match(models, /public let countEvidenceIdempotencyKey: String\?/)
  assert.match(models, /public let countEvidence: \[PickTaskCountEvidence\]\?/)
  assert.match(models, /case iPhone = "iphone"/)
  assert.match(models, /case watch = "watch"/)
  assert.match(session, /case \.count|return \.count/)
  assert.match(session, /func verifyCount\(/)
  assert.match(session, /enteredCount == required/)
  assert.match(session, /stageContextTokens\[task\.pickTaskGlobalId\] == contextToken/)
  assert.match(
    session,
    /func commitWorkflowProgress\(_ candidate: WorkflowProgressState\) async throws \{[\s\S]*?try await persistProgress\(candidate\)[\s\S]*?applyWorkflowProgress\(candidate\)/,
  )
  assert.match(adapters, /pick-progress\.json/)
  assert.match(adapters, /countEvidenceIdempotencyKey: command\.countEvidenceIdempotencyKey/)
  assert.match(adapters, /countEvidence: command\.countEvidence/)
  assert.match(phone, /\.sheet\(isPresented: \$model\.showCountEntry\)/)
  assert.match(dashboard, /struct PickedCountEntrySheet/)
  assert.match(dashboard, /TextField\("Picked count"/)
  assert.match(dashboard, /prefix\(16\)/)
  assert.match(watch, /struct WatchCountEntryView/)
  assert.match(watch, /Stepper\(/)
  assert.match(watch, /_enteredCount = State\(initialValue: 1\)/)
  assert.match(watch, /case \.submitCount|\.submitCount/)
})

test('location to product transition is explicit and keeps the Meta session alive', () => {
  const models = read('../clients/apple/Sources/ClawPilotPickingCore/PickingModels.swift')
  const session = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const phone = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  const watch = read('../clients/apple/Apps/Watch/ClawPilotPickingWatchApp.swift')

  assert.match(models, /case productReady = "product_ready"/)
  assert.match(
    session,
    /func beginProductScan\(\s*contextToken: String,\s*now: Date = Date\(\)\s*\) async throws/,
  )
  assert.match(phone, /metaProductStartContinuation/)
  assert.match(phone, /metaProductStartRequestedScanID/)
  assert.match(phone, /await withCheckedContinuation/)
  assert.match(phone, /suppressedValue: acceptedLocationValue/)
  assert.match(
    phone,
    /metaProductStartRequestedScanID == scanID[\s\S]*?currentWorkflowStage == \.product/,
  )
  assert.doesNotMatch(
    phone.match(/guard acceptance\.stage == \.location[\s\S]*?suppressedValue: acceptedLocationValue/)?.[0] ?? '',
    /Task\.sleep/,
  )
  assert.match(dashboard, /Scan product with Meta glasses/)
  assert.match(dashboard, /Scan product with iPhone/)
  assert.match(watch, /Label\("Scan product"/)
  assert.match(phone, /case \.beginProductScan:/)
  assert.match(
    phone,
    /func beginProductScanWithMeta[\s\S]*?guard isMetaScanning \|\| metaScanReady[\s\S]*?picking\.beginProductScan/,
  )
})

test('picker audio routing and Meta scan feedback stay explicit and bounded', () => {
  const voice = read('../clients/apple/Apps/iPhone/VoiceConfirmationController.swift')
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const dashboard = read('../clients/apple/Apps/iPhone/PickingDashboardView.swift')
  const meta = read('../clients/apple/Apps/iPhone/MetaWearablesBarcodeSource.swift')
  const metaPolicy = read('../clients/apple/Sources/ClawPilotPickingApple/MetaBarcodeDecodeArbitration.swift')
  const intent = read('../clients/apple/Apps/iPhone/ClawPilotScanIntent.swift')
  const settings = read('../clients/apple/Apps/iPhone/Settings.bundle/Root.plist')
  assert.match(voice, /setCategory\(\s*\.playback,/)
  assert.match(voice, /\.allowBluetoothA2DP/)
  assert.match(voice, /overrideOutputAudioPort\(\.speaker\)/)
  assert.match(settings, /clawpilot_audio_playback/)
  assert.match(settings, /clawpilot_instruction_language/)
  assert.match(settings, /Always iPhone speaker/)
  assert.doesNotMatch(settings, /clawpilot_speech_voice/)
  assert.match(voice, /let preferredNames = \["Ava", "Zoe", "Samantha", "Nicky", "Allison"\]/)
  assert.match(voice, /\$0\.quality != \.default && \$0\.identifier != systemVoice\?\.identifier/)
  assert.match(voice, /\.first \?\? systemVoice/)
  assert.match(app, /Task\.sleep\(for: \.seconds\(15\)\)/)
  assert.match(app, /Hey Siri, scan with ClawPilot/)
  assert.match(
    app,
    /await source\.stop\(\)[\s\S]*let acceptance = await accept\(\s*value,\s*source: \.metaGlasses,/,
  )
  assert.match(app, /await voice\.speakAndWait\(\s*"Item matched\. Say confirm pick to submit\.",\s*spanish: "Producto correcto\. Di confirmar pedido para enviarlo\."\s*\)/)
  assert.match(app, /await listenForConfirmation\(automatic: true\)/)
  assert.match(app, /timeout: automatic \? \.seconds\(8\) : nil/)
  assert.match(app, /voice\.speak\("Picks confirmed\.", spanish: "Pedido confirmado\."\)[\s\S]*await loadQueue\(readAloud: false\)/)
  assert.match(voice, /import SupertonicTTS/)
  assert.match(voice, /aufklarer\/Supertonic-3-CoreML-FP16/)
  assert.match(voice, /voicePackStorageRoot[\s\S]*"ClawPilotPicking"[\s\S]*"models"[\s\S]*"aufklarer"[\s\S]*"Supertonic-3-CoreML-FP16"/)
  assert.match(voice, /voicePackStorageRoot:[\s\S]*\.applicationSupportDirectory/)
  assert.match(voice, /purgeableVoicePackDirectory/)
  assert.match(voice, /moveItem\(\s*at: purgeableVoicePackDirectory,\s*to: voicePackDirectory\s*\)/)
  assert.match(voice, /values\.isExcludedFromBackup = true/)
  assert.match(voice, /voice: language == \.spanish \? "F2" : "F1"/)
  assert.match(voice, /language: language\.languageCode/)
  assert.match(voice, /SupertonicOptions\(totalStep: 8, speed: 1\.05, seed: 42\)/)
  assert.match(voice, /written: "ClawPilot",\s*spoken: "Claw Pilot"/)
  assert.match(voice, /clawpilot_pronunciation_corrections/)
  assert.match(voice, /options: \[\.caseInsensitive\]/)
  assert.match(dashboard, /Pronunciation corrections/)
  assert.match(dashboard, /Save and preview/)
  assert.match(dashboard, /model\.removePronunciationCorrection/)
  assert.match(voice, /computeUnits: \.cpuOnly/)
  assert.doesNotMatch(voice, /computeUnits: \.cpuAndGPU/)
  assert.match(voice, /private var loadTask: Task<SupertonicTTSModel, Error>\?/)
  assert.match(voice, /FileProtectionType\.completeUntilFirstUserAuthentication/)
  assert.match(voice, /applyLockedPlaybackProtection\(to: Self\.voicePackDirectory\)/)
  assert.match(voice, /case loadFailed\(String\)/)
  assert.match(voice, /var canRetryLoad: Bool/)
  assert.match(dashboard, /model\.retryEnhancedVoicePack\(\)/)
  assert.match(voice, /deadline: Date\? = nil/)
  assert.match(voice, /let routeDeadline = Date\(\)\.addingTimeInterval\(3\)/)
  assert.match(voice, /bluetoothRoutePrimerData/)
  assert.doesNotMatch(voice, /setActive\(true, options:/)
  assert.match(voice, /sampleRate: 44_100/)
  assert.match(voice, /runOfflineVoiceSelfTest/)
  assert.match(voice, /nonisolated private static func requestSpeechAuthorization/)
  assert.match(voice, /let speechStatus = await Self\.requestSpeechAuthorization\(\)/)
  assert.match(voice, /pcm\.count > 44_100, finite, peak > 0\.01/)
  assert.match(app, /CLAWPILOT_VOICE_SELF_TEST/)
  assert.match(app, /CLAWPILOT_SPEECH_AUTH_SELF_TEST/)
  assert.match(app, /CLAWPILOT_LISTENING_SELF_TEST/)
  assert.match(voice, /let recognitionHandler: @Sendable/)
  assert.match(voice, /VectorEstimator\.mlpackage\/Data\/com\.apple\.CoreML\/weights\/weight\.bin": 255_276_032/)
  assert.match(voice, /voice_styles\/F2\.json": 292_423/)
  assert.match(voice, /Apple speech remains the fallback/)
  assert.match(voice, /Voice storage is unavailable/)
  assert.match(meta, /resolution: \.high/)
  assert.match(meta, /frameRate: 15/)
  assert.match(metaPolicy, /liveFrameCadenceNanoseconds: UInt64 = 100_000_000/)
  assert.match(metaPolicy, /liveFrameDelayNanoseconds/)
  assert.match(meta, /videoProcessingQueue\.asyncAfter/)
  assert.match(metaPolicy, /maximumPendingPhotos = 1/)
  assert.match(metaPolicy, /ordinal > 1/)
  assert.match(metaPolicy, /allowsAccurateOCR: false/)
  assert.match(metaPolicy, /allowsAccurateOCR: true/)
  assert.match(meta, /photoDataPublisher\.listen[\s\S]*videoFramePublisher\.listen[\s\S]*camera\.stream\.start\(\)/)
  assert.match(meta, /vision-decode:kind=\\\(item\.kind\.rawValue\):outcome=\\\(outcome\)/)
  assert.match(meta, /case photo/)
  assert.match(meta, /case video/)
  assert.match(meta, /symbologies: \[\.code128, \.qr\]/)
  assert.match(meta, /frame\.makeUIImage\(\)/)
  assert.doesNotMatch(
    meta,
    /cmSampleBuffer: frame\.sampleBuffer,\s*orientation: \.up/,
  )
  assert.match(meta, /MetaBarcodeOrientationPlan\.photo/)
  assert.match(meta, /orientation_attempts=/)
  assert.match(meta, /orientation_winner=/)
  assert.match(meta, /VNRecognizeTextRequest\(\)/)
  assert.match(meta, /request\.recognitionLevel = \.accurate/)
  assert.match(meta, /let expectedValue = item\.target\.expectedValue/)
  assert.match(meta, /MetaExpectedBarcodeTextMatcher\.matches/)
  assert.match(meta, /MetaBarcodeCandidate\(\s*payload: expectedValue/)
  assert.match(metaPolicy, /String\(value\.filter \{ !\$0\.isWhitespace \}\)\.uppercased\(\)/)
  assert.doesNotMatch(meta, /ocr_(?:text|payload)=|orientation_(?:text|payload)=/i)
  assert.doesNotMatch(meta, /photo\.data\.write|write\(to:/)
  assert.doesNotMatch(meta, /photo-received:bytes=|video-received:/)
  assert.match(meta, /\.ean8, \.ean13, \.upce/)
  assert.match(meta, /\.code128, \.code39, \.code93/)
  assert.match(meta, /\.gs1DataBar, \.gs1DataBarExpanded, \.gs1DataBarLimited/)
  assert.doesNotMatch(voice, /import KokoroTTS/)
  assert.doesNotMatch(app, /voice\.speak\("Glasses camera started\./)
  assert.match(dashboard, /Open ClawPilot App Settings/)
  assert.match(dashboard, /MPVolumeView/)
  assert.match(dashboard, /Choose audio output/)
  assert.match(dashboard, /Preview instruction voice/)
  assert.match(meta, /withCheckedThrowingContinuation/)
  assert.match(meta, /startContinuation\?\.resume\(\)/)
  assert.match(meta, /photoDataPublisher/)
  assert.match(meta, /capturePhoto\(format: \.jpeg\)/)
  assert.match(meta, /photoCaptureAttempt < 3/)
  assert.match(meta, /handlePhotoDelivered\(\)/)
  assert.match(meta, /trigger: "photo-delivered"/)
  assert.match(meta, /VNImageRequestHandler\(\s*data: data/)
  assert.match(intent, /StartClawPilotGlassesScanIntent/)
  assert.match(intent, /Scan with \\\(.applicationName\)/)
  assert.match(intent, /OpenURLIntent\(ClawPilotSystemActionLink\.scanURL\(\)\)/)
  assert.match(intent, /clawpilot_action/)
  assert.match(intent, /clawpilot_last_scan_stage/)
  assert.match(intent, /clawpilot_scan_history/)
  assert.match(app, /ClawPilotScanDiagnostic\.record\("camera-live"\)/)
  assert.match(app, /ClawPilotScanDiagnostic\.record\("timeout:no-barcode"\)/)
  assert.match(app, /Move closer until the barcode fills at least one-third of your view/)
  assert.match(app, /for attempt in 1\.\.\.3/)
  assert.match(meta, /error == \.datAppOnTheGlassesUpdateRequired/)
  assert.match(meta, /failStart\(MetaScanError\.glassesAppUpdateRequired\)/)
  assert.match(app, /if error as\? MetaScanError == \.glassesAppUpdateRequired \{ break \}/)
  assert.match(dashboard, /Button\("Update camera software in Meta AI"\)/)
  assert.match(dashboard, /Do not reset ClawPilot or re-pair the glasses/)
  assert.match(app, /guard !isHandlingPendingSystemScan else/)
  assert.match(app, /guard !isMetaScanning else/)
  assert.match(app, /MetaWearablesAppBridge\.startUnregistration\(\)/)
  assert.match(dashboard, /Button\("Reset and open Meta AI", role: \.destructive\)/)
  assert.match(dashboard, /It does not unpair your glasses/)
  assert.match(meta, /session-error:/)
  assert.match(meta, /stream-error:/)
})

test('mobile manager assignment reuses audited Operations concurrency controls', () => {
  const route = read('app/api/operations/route.ts')
  const persistence = read('lib/persistence/operations.ts')
  const pickers = read('app/api/operations/pickers/route.ts')
  assert.match(route, /action === 'assign-picks'/)
  assert.match(route, /idempotencyKeyValue\(req\)/)
  assert.match(route, /expectedRowVersion/)
  assert.match(persistence, /assignOperationsOrderPicksFromPostgres/)
  assert.match(persistence, /commandType: 'assign_operations_order_picks'/)
  assert.match(persistence, /order\.status !== 'released'/)
  assert.match(persistence, /pick\.status = 'ready'/)
  assert.match(persistence, /SET assigned_to = \$3/)
  assert.match(persistence, /eventType: 'operations\.pick\.assigned'/)
  assert.match(pickers, /operationsCapabilities\(actor\)/)
  assert.match(pickers, /permissions\.executeWarehouse/)
})

test('picker setup and UPH use durable Operations evidence', () => {
  const session = read('app/api/auth/session/route.ts')
  const queue = read('app/api/operations/picks/route.ts')
  const performance = read('app/api/operations/picker-performance/route.ts')
  const persistence = read('lib/persistence/wearablePicking.ts')
  const migration = read('../db/migrations/0256_operations_picker_performance.sql')
  const people = read('components/settings/UserAccessDialog.tsx')
  assert.match(session, /operations\.canView && operations\.canExecute/)
  assert.match(queue, /!capabilities\.canView \|\| !capabilities\.canExecute/)
  assert.match(performance, /readPickerPerformanceFromPostgres/)
  assert.match(performance, /managerScope \? null : actor\.email/)
  assert.match(persistence, /pick\.assigned_at/)
  assert.match(persistence, /pick\.picked_at/)
  assert.match(persistence, /EXTRACT\(epoch FROM completed_at - assigned_at\)/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS assigned_at timestamptz/)
  assert.match(people, /label: 'Picker access'/)
  assert.match(people, /next\.viewOperations = true/)
})

test('mobile app gates workflows behind the shared ClawPilot session', () => {
  const session = read('app/api/auth/session/route.ts')
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const shell = read('../clients/apple/Apps/iPhone/ClawPilotAppShellView.swift')
  assert.match(session, /mobileCapabilities:/)
  assert.match(session, /canUsePicker:/)
  assert.match(session, /canUseManager:/)
  assert.match(app, /api\.fetchSessionProfile\(\)/)
  assert.match(shell, /Sign in before choosing your workflow/)
  assert.match(shell, /case \.picker/)
  assert.match(shell, /case \.manager/)
  assert.match(shell, /Wave and assign order/)
})

test('mobile organization changes are serialized, journaled, and profile fenced', () => {
  const session = read('app/api/auth/session/route.ts')
  const workspace = read('app/api/auth/workspace/route.ts')
  const app = read('../clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
  const adapters = read('../clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift')
  const pickingSession = read('../clients/apple/Sources/ClawPilotPickingCore/PickingSession.swift')
  const shell = read('../clients/apple/Apps/iPhone/ClawPilotAppShellView.swift')
  assert.match(session, /activeWorkspace:/)
  assert.match(session, /availableWorkspaces:/)
  assert.match(workspace, /switchBrowserSessionWorkspace/)
  assert.match(workspace, /clearWorkspaceSelectionCookies\(response\)/)
  assert.match(adapters, /api\/auth\/workspace/)
  assert.match(adapters, /workspaceConfiguration\.httpShouldSetCookies = false/)
  assert.match(adapters, /private func authenticatedData[\s\S]*attachStoredCookies\(to: &request\)[\s\S]*session\.data\(for: request\)/)
  assert.match(adapters, /public struct WorkspaceTransition: Codable, Equatable, Sendable/)
  assert.match(adapters, /workspace-transition\.json/)
  assert.match(adapters, /public func saveWorkspaceTransition[\s\S]*loadOutbox\(\)[\s\S]*loadHandoffOutbox\(\)/)
  assert.match(adapters, /public func clearWorkspaceTransition[\s\S]*loadWorkspaceTransition\(\) == transition/)
  assert.match(adapters, /public func switchWorkspace[\s\S]*await beginAuthenticatedMutation\(\)[\s\S]*persistResponseCookies\(response\)/)
  assert.match(adapters, /public func logout\(\) async throws \{[\s\S]*await beginAuthenticatedMutation\(\)[\s\S]*authenticatedData\(for: request\)/)
  assert.match(app, /guard canSwitchWorkspace else/)
  assert.match(app, /cache\.saveWorkspaceTransition\(transition\)[\s\S]*clearPublishedPickProjection\(\)[\s\S]*api\.switchWorkspace\(to: organizationId\)/)
  assert.match(app, /recoverWorkspaceTransitionIfNeeded[\s\S]*cache\.clearWorkspaceTransition\(transition\)[\s\S]*hasPendingWorkspaceTransition = false[\s\S]*updateProjection\(\)/)
  assert.match(app, /func logout\(\) async \{[\s\S]*authenticationGeneration &\+= 1[\s\S]*await waitForWorkspaceSwitchToFinish\(\)[\s\S]*try await api\.logout\(\)/)
  assert.match(app, /func logout\(\) async \{[\s\S]*isAuthenticated = false[\s\S]*sessionProfile = nil[\s\S]*clearPublishedPickProjection\(\)[\s\S]*await waitForWorkspaceSwitchToFinish\(\)/)
  assert.match(app, /func restoreAndRefresh\(\) async \{[\s\S]*clearPublishedPickProjection\(\)[\s\S]*api\.fetchSessionProfile\(\)[\s\S]*recoverWorkspaceTransitionIfNeeded[\s\S]*picking\.restore\(\)[\s\S]*resumeDurablePickHandoffIfNeeded\(\)[\s\S]*resumeDurableConfirmationIfNeeded\(\)[\s\S]*updateProjection\(\)/)
  assert.match(app, /private func updateProjection\(\) async \{[\s\S]*queueIdentityMatches[\s\S]*authorizedOrganizationId:[\s\S]*authorizedWorkerEmail:/)
  assert.match(app, /try await picking\.clearQueue\(\)/)
  assert.match(pickingSession, /public func clearQueue\(\) async throws/)
  assert.match(pickingSession, /public func queueIdentityMatches/)
  assert.match(shell, /WorkspaceSwitcherCard\(model: model\)/)
  assert.match(shell, /WorkspaceSwitcherCard\(model: model, compact: true\)/)
})
