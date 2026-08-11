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

@Test("rate limiting gives the worker an actionable retry delay")
func rateLimitDescription() {
    let error = PickingAPIError.rateLimited(retryAfterSeconds: 42)
    #expect(error.errorDescription == "Too many code requests. Try again in 42 seconds.")
}
