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
