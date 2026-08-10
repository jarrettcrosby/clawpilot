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

@Test("rate limiting gives the worker an actionable retry delay")
func rateLimitDescription() {
    let error = PickingAPIError.rateLimited(retryAfterSeconds: 42)
    #expect(error.errorDescription == "Too many code requests. Try again in 42 seconds.")
}
