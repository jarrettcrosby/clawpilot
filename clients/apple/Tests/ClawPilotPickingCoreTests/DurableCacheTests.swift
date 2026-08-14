import Foundation
import Testing
@testable import ClawPilotPickingCore
@testable import ClawPilotPickingApple

@Test("durable cache preserves the exact outbox idempotency key")
func durableOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-pick-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000001", sequence: 1,
        productGlobalId: "gp0000001", productName: "Widget",
        channelSku: "W-1", barcode: "123", locationCode: "A-1", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000001", orderNumber: "1001",
        rowVersion: 2, tasks: [task]
    )
    let command = ConfirmPicksCommand(order: order, idempotencyKey: "fixed-key")
    try await cache.saveOutbox(command)
    #expect(try await cache.loadOutbox() == command)
}

@Test("durable cache preserves the exact picker handoff independently")
func durablePickHandoffOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-pick-handoff-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000001", sequence: 1,
        productGlobalId: "gp0000001", productName: "Widget",
        channelSku: "W-1", barcode: "123", locationCode: "A-1", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000001", orderNumber: "1001",
        rowVersion: 2, tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [order]
    )
    let confirmation = ConfirmPicksCommand(order: order, idempotencyKey: "blocked-key")
    let handoff = try PickHandoffCommand(
        queue: queue,
        order: order,
        reason: "Manager review requested.",
        blockedConfirmationIdempotencyKey: confirmation.idempotencyKey,
        idempotencyKey: "fixed-handoff-key"
    )
    try await cache.saveOutbox(confirmation)
    try await cache.saveHandoffOutbox(handoff)

    #expect(try await cache.loadOutbox() == confirmation)
    #expect(try await cache.loadHandoffOutbox() == handoff)
    try await cache.clearHandoffOutbox()
    #expect(try await cache.loadHandoffOutbox() == nil)
    #expect(try await cache.loadOutbox() == confirmation)
}

@Test("durable outbox preserves offline scan facts until server acknowledgement")
func durableScanEvidenceOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-scan-evidence-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000002", sequence: 1,
        productGlobalId: "gp0000002", productName: "Widget",
        channelSku: "W-2", barcode: "123456789012",
        locationCode: "A-2",
        warehouseGlobalId: "gwh0000002",
        locationGlobalId: "gwl0000002",
        locationBarcode: "CP1L-GWL0000002",
        locationScanRequired: true,
        locationScanPolicyRowVersion: 4,
        quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000002", orderNumber: "1002",
        rowVersion: 8, tasks: [task]
    )
    let location = try BarcodeObservation(
        value: "CP1L-GWL0000002",
        source: .metaGlasses,
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let product = try BarcodeObservation(
        value: "123456789012",
        source: .iPhoneCamera,
        capturedAt: Date(timeIntervalSince1970: 1_700_000_003)
    )
    let evidence = try PickTaskScanEvidence(
        task: task,
        location: location,
        product: product
    )
    let command = ConfirmPicksCommand(
        order: order,
        scanEvidence: [evidence],
        idempotencyKey: "offline-fixed-key"
    )

    try await cache.saveOutbox(command)
    let restored = try #require(try await cache.loadOutbox())
    #expect(restored == command)
    #expect(restored.scanEvidenceIdempotencyKey == "wearable-scan:offline-fixed-key")
    #expect(restored.scanEvidence?.first?.location.source == .metaGlasses)
    #expect(restored.scanEvidence?.first?.product.source == .iPhoneCamera)
}

@Test("durable cache preserves exact multi-unit count evidence and progress")
func durableCountEvidenceAndProgress() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-count-evidence-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000004", sequence: 1,
        productGlobalId: "gp0000004", productName: "Four pack",
        channelSku: "FOUR-4", barcode: "444444444444",
        locationCode: "A-4", quantity: 4
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000004", orderNumber: "1004",
        rowVersion: 9, tasks: [task]
    )
    let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)
    let product = try BarcodeObservation(
        value: "444444444444", source: .metaGlasses, capturedAt: capturedAt
    )
    let count = try PickTaskCountEvidence(
        task: task,
        enteredQuantity: 4,
        product: product,
        countedAt: capturedAt.addingTimeInterval(2),
        countSource: .watch
    )
    let command = ConfirmPicksCommand(
        order: order,
        countEvidence: [count],
        idempotencyKey: "count-fixed-key"
    )
    try await cache.saveOutbox(command)
    let restored = try #require(try await cache.loadOutbox())
    #expect(restored.countEvidenceIdempotencyKey == "wearable-count:count-fixed-key")
    #expect(restored.countEvidence == [count])

    let token = UUID().uuidString.lowercased()
    let progress = PickSessionProgress(
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        order: order,
        scannedTaskIDs: [],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: [task.pickTaskGlobalId: product],
        countEvidence: [:],
        stageContextTokens: [task.pickTaskGlobalId: token]
    )
    try await cache.saveProgress(progress)
    #expect(try await cache.loadProgress() == progress)
}

@Test("durable outbox preserves subsecond product-before-count ordering")
func durableSubsecondCountOrdering() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-subsecond-count-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000006", sequence: 1,
        productGlobalId: "gp0000006", productName: "Six pack",
        channelSku: "SIX", barcode: "666", locationCode: "A-6", quantity: 6
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000006", orderNumber: "1006", rowVersion: 3, tasks: [task]
    )
    let product = try BarcodeObservation(
        value: "666",
        source: .metaGlasses,
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123)
    )
    let count = try PickTaskCountEvidence(
        task: task,
        enteredQuantity: 6,
        product: product,
        countedAt: Date(timeIntervalSince1970: 1_700_000_000.456),
        countSource: .watch
    )
    try await cache.saveOutbox(ConfirmPicksCommand(order: order, countEvidence: [count]))
    let restored = try #require(try await cache.loadOutbox()?.countEvidence?.first)
    #expect(restored.product.capturedAt < restored.countedAt)
    #expect(restored.countedAt.timeIntervalSince(restored.product.capturedAt) > 0.3)
    #expect(restored.countedAt.timeIntervalSince(restored.product.capturedAt) < 0.4)
}

@Test("rate limiting gives the worker an actionable retry delay")
func rateLimitDescription() {
    let error = PickingAPIError.rateLimited(retryAfterSeconds: 42)
    #expect(error.errorDescription == "Too many code requests. Try again in 42 seconds.")
}

@Test("workspace transition journal resolves only the exact authenticated scope")
func durableWorkspaceTransitionScopeResolution() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-workspace-transition-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let transition = try WorkspaceTransition(
        sourceOrganizationId: "11111111-1111-4111-8111-111111111111",
        targetOrganizationId: "22222222-2222-4222-8222-222222222222",
        workerEmail: "Picker@Example.com",
        pickerCachePolicy: .clearScopedData,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )

    try await cache.saveWorkspaceTransition(transition)
    let relaunched = try DurablePickCache(directory: directory)
    #expect(try await relaunched.loadWorkspaceTransition() == transition)
    #expect(transition.resolution(
        activeOrganizationId: transition.sourceOrganizationId,
        effectiveWorkerEmail: "picker@example.com"
    ) == .sourceWorkspace)
    #expect(transition.resolution(
        activeOrganizationId: transition.targetOrganizationId,
        effectiveWorkerEmail: "PICKER@example.com"
    ) == .targetWorkspaceClearScopedData)
    #expect(transition.resolution(
        activeOrganizationId: "33333333-3333-4333-8333-333333333333",
        effectiveWorkerEmail: "picker@example.com"
    ) == .blockedIdentity)
    #expect(transition.resolution(
        activeOrganizationId: transition.targetOrganizationId,
        effectiveWorkerEmail: "other@example.com"
    ) == .blockedIdentity)

    let different = try WorkspaceTransition(
        sourceOrganizationId: transition.sourceOrganizationId,
        targetOrganizationId: "33333333-3333-4333-8333-333333333333",
        workerEmail: transition.workerEmail,
        pickerCachePolicy: .clearScopedData,
        startedAt: transition.startedAt
    )
    await #expect(throws: PickingContractError.contextMismatch) {
        try await relaunched.clearWorkspaceTransition(different)
    }
    #expect(try await relaunched.loadWorkspaceTransition() == transition)
    try await relaunched.clearWorkspaceTransition(transition)
    #expect(try await relaunched.loadWorkspaceTransition() == nil)
}

@Test("workspace transition keeps exact epoch identity and decodes legacy journals")
func durableWorkspaceTransitionEpochCompatibility() async throws {
    let legacy = Data(#"""
    {
      "schemaVersion": 1,
      "sourceOrganizationId": "11111111-1111-4111-8111-111111111111",
      "targetOrganizationId": "22222222-2222-4222-8222-222222222222",
      "workerEmail": "Picker@Example.com",
      "pickerCachePolicy": "clear_scoped_data",
      "startedAt": "2023-11-14T22:13:20.123Z"
    }
    """#.utf8)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let decoded = try decoder.decode(WorkspaceTransition.self, from: legacy)
    #expect(decoded.startedAtEpochMilliseconds == 1_700_000_000_123)
    #expect(decoded.workerEmail == "picker@example.com")

    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-workspace-epoch-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    try await cache.saveWorkspaceTransition(decoded)
    let persisted = try Data(
        contentsOf: directory.appendingPathComponent("workspace-transition.json")
    )
    let object = try #require(
        try JSONSerialization.jsonObject(with: persisted) as? [String: Any]
    )
    #expect(object["startedAt"] is String)
    #expect(object["startedAtEpochMilliseconds"] as? Int64 == 1_700_000_000_123)
    #expect(try await cache.loadWorkspaceTransition() == decoded)

    var authoritativeObject = object
    authoritativeObject["startedAt"] = "2023-11-14T22:13:20.124Z"
    let authoritative = try JSONSerialization.data(withJSONObject: authoritativeObject)
    let authoritativeDecoded = try decoder.decode(
        WorkspaceTransition.self,
        from: authoritative
    )
    #expect(authoritativeDecoded == decoded)

    var differentObject = object
    differentObject["startedAt"] = "2023-11-14T22:13:20.124Z"
    differentObject["startedAtEpochMilliseconds"] = 1_700_000_000_124
    let different = try decoder.decode(
        WorkspaceTransition.self,
        from: JSONSerialization.data(withJSONObject: differentObject)
    )
    #expect(different != decoded)
}

@Test("normal workspace transition survives every destructive crash boundary")
func durableWorkspaceTransitionClearCrashBoundaries() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-workspace-clear-crash-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000091", sequence: 1,
        productGlobalId: "gp0000091", productName: "Scoped widget",
        channelSku: "SCOPED-91", barcode: "91", locationCode: "A-91", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000091", orderNumber: "1091", rowVersion: 9, tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(timeIntervalSince1970: 1_700_000_000),
        orders: [order]
    )
    let progress = PickSessionProgress(
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        order: order,
        scannedTaskIDs: [],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: [:],
        countEvidence: [:],
        stageContextTokens: [:]
    )
    let transition = try WorkspaceTransition(
        sourceOrganizationId: queue.organizationId,
        targetOrganizationId: "22222222-2222-4222-8222-222222222222",
        workerEmail: queue.workerEmail,
        pickerCachePolicy: .clearScopedData
    )

    var cache = try DurablePickCache(directory: directory)
    try await cache.saveQueue(queue)
    try await cache.saveProgress(progress)
    try await cache.saveWorkspaceTransition(transition)

    // Crash immediately after intent persistence: old scoped data is still
    // present, but the journal forces profile-first reconciliation.
    cache = try DurablePickCache(directory: directory)
    #expect(try await cache.loadWorkspaceTransition() == transition)
    #expect(try await cache.loadQueue() == queue)
    #expect(try await cache.loadProgress() == progress)

    // Crash after queue cleanup: the journal remains, so startup stays nil and
    // finishes the remaining exact cleanup instead of publishing mixed state.
    try await cache.clearQueue()
    cache = try DurablePickCache(directory: directory)
    #expect(try await cache.loadWorkspaceTransition() == transition)
    #expect(try await cache.loadQueue() == nil)
    #expect(try await cache.loadProgress() == progress)

    // Crash after progress cleanup: only exact journal retirement remains.
    try await cache.clearProgress()
    cache = try DurablePickCache(directory: directory)
    #expect(try await cache.loadWorkspaceTransition() == transition)
    #expect(try await cache.loadQueue() == nil)
    #expect(try await cache.loadProgress() == nil)

    try await cache.clearWorkspaceTransition(transition)
    cache = try DurablePickCache(directory: directory)
    #expect(try await cache.loadWorkspaceTransition() == nil)
    #expect(try await cache.loadQueue() == nil)
    #expect(try await cache.loadProgress() == nil)
}

@Test("protected confirmation survives workspace transition crashes fail closed")
func durableProtectedWorkspaceTransitionPreservesExactConfirmation() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-workspace-protected-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000092", sequence: 1,
        productGlobalId: "gp0000092", productName: "Protected widget",
        channelSku: "PROTECTED-92", barcode: "92", locationCode: "A-92", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000092", orderNumber: "1092", rowVersion: 12, tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: "22222222-2222-4222-8222-222222222222",
        workerEmail: "picker@example.com",
        generatedAt: Date(timeIntervalSince1970: 1_700_000_000),
        orders: [order]
    )
    let confirmation = ConfirmPicksCommand(
        order: order,
        idempotencyKey: "protected-transition"
    )
    let transition = try WorkspaceTransition(
        sourceOrganizationId: "11111111-1111-4111-8111-111111111111",
        targetOrganizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        pickerCachePolicy: .preserveProtectedCommand
    )
    var cache = try DurablePickCache(directory: directory)
    try await cache.saveQueue(queue)
    try await cache.saveOutbox(confirmation)
    try await cache.saveWorkspaceTransition(transition)

    cache = try DurablePickCache(directory: directory)
    #expect(try await cache.loadWorkspaceTransition() == transition)
    #expect(try await cache.loadQueue() == queue)
    #expect(try await cache.loadOutbox() == confirmation)
    #expect(transition.resolution(
        activeOrganizationId: queue.organizationId,
        effectiveWorkerEmail: queue.workerEmail
    ) == .targetWorkspacePreserveProtectedCommand)
    #expect(transition.resolution(
        activeOrganizationId: queue.organizationId,
        effectiveWorkerEmail: "wrong@example.com"
    ) == .blockedIdentity)

    let wrong = try WorkspaceTransition(
        sourceOrganizationId: transition.sourceOrganizationId,
        targetOrganizationId: "33333333-3333-4333-8333-333333333333",
        workerEmail: transition.workerEmail,
        pickerCachePolicy: .preserveProtectedCommand,
        startedAt: transition.startedAt
    )
    await #expect(throws: PickingContractError.contextMismatch) {
        try await cache.clearWorkspaceTransition(wrong)
    }
    #expect(try await cache.loadWorkspaceTransition() == transition)
    #expect(try await cache.loadQueue() == queue)
    #expect(try await cache.loadOutbox() == confirmation)
}
