import Foundation
import Testing
@testable import ClawPilotPickingCore

private actor MemoryCache: PickCache {
    var queue: PickQueue?
    var outbox: ConfirmPicksCommand?

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws { self.queue = queue }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_ command: ConfirmPicksCommand) async throws { outbox = command }
    func loadOutbox() async throws -> ConfirmPicksCommand? { outbox }
    func clearOutbox() async throws { outbox = nil }
}

@Test("workspace changes clear cached pick identity and progress")
func clearWorkspaceQueue() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    try await session.replaceQueue(fixtureQueue())
    _ = try await session.accept(BarcodeObservation(
        value: "0012345678905", source: .metaGlasses
    ))

    try await session.clearQueue()

    #expect(await session.currentOrder() == nil)
    #expect(await session.currentTask() == nil)
    #expect(try await cache.loadQueue() == nil)
}

private func fixtureQueue() throws -> PickQueue {
    let tasks = try [
        PickTask(
            pickTaskGlobalId: "gpk0000001", sequence: 1,
            productGlobalId: "gp0000001", productName: "Blue Widget",
            channelSku: "BLUE-1",
            productImageURL: URL(string: "https://example.com/product.png"),
            barcode: "012345678905",
            locationCode: "A-01-01", quantity: 2
        ),
        PickTask(
            pickTaskGlobalId: "gpk0000002", sequence: 2,
            productGlobalId: "gp0000002", productName: "Red Widget",
            channelSku: "RED-1", barcode: "998877665544",
            locationCode: "A-01-02", quantity: 1
        ),
    ]
    return try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [try PickOrder(
            orderGlobalId: "gor0000001",
            orderNumber: "1001",
            rowVersion: 7,
            tasks: tasks
        )]
    )
}

@Test("barcode matching is exact except for Apple UPC-A EAN-13 representation")
func barcodeMatching() {
    #expect(BarcodeMatcher.matches(observed: "012345678905", expected: "012345678905"))
    #expect(BarcodeMatcher.matches(observed: "0012345678905", expected: "012345678905"))
    #expect(!BarcodeMatcher.matches(observed: "012345678905 ", expected: "012345678905"))
    #expect(!BarcodeMatcher.matches(observed: "012345678906", expected: "012345678905"))
}

@Test("session scans in order and persists one exact confirmation command")
func persistedConfirmation() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    try await session.replaceQueue(fixtureQueue())
    let now = Date()
    _ = try await session.accept(BarcodeObservation(
        value: "0012345678905", source: .metaGlasses, capturedAt: now
    ), now: now)
    _ = try await session.accept(BarcodeObservation(
        value: "998877665544", source: .iPhoneCamera, capturedAt: now
    ), now: now)
    let first = try await session.persistConfirmation()
    let replay = try await session.persistConfirmation()
    #expect(first == replay)
    #expect(first.orderGlobalId == "gor0000001")
    #expect(first.expectedRowVersion == 7)
    let encoded = try JSONEncoder().encode(first)
    let body = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(body["action"] as? String == "confirm-picks")
    #expect((body["idempotencyKey"] as? String)?.hasPrefix("wearable-pick:") == true)
}

@Test("Watch projection carries display data but no barcode or mutation authority")
func safeWatchProjection() async throws {
    let session = PickingSession(cache: MemoryCache())
    try await session.replaceQueue(fixtureQueue())
    let snapshot = try #require(await session.makeWatchSnapshot())
    let data = try JSONEncoder().encode(snapshot)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("Blue Widget"))
    #expect(snapshot.current?.productImageURL?.absoluteString == "https://example.com/product.png")
    #expect(!text.contains("012345678905"))
    #expect(!text.contains("orderGlobalId"))
    #expect(snapshot.upcoming.count == 1)
}

@Test("Watch commands carry bounded actions but no pick or order identity")
func safeWatchCommand() throws {
    let command = WatchPickCommand(id: "watch-command-1", action: .confirmPick)
    let data = try JSONEncoder().encode(command)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("confirm_pick"))
    #expect(!text.contains("orderGlobalId"))
    #expect(!text.contains("pickTaskGlobalId"))
}

@Test("voice grammar is bounded and never supplies task identity")
func voiceGrammar() {
    #expect(PickVoice.isConfirmation("confirm pick"))
    #expect(PickVoice.isConfirmation("Confirmed pick."))
    #expect(PickVoice.isConfirmation("confirm picks"))
    #expect(PickVoice.action(for: "start glasses scan") == .startMetaScan)
    #expect(PickVoice.action(for: "scan with glasses") == .startMetaScan)
    #expect(PickVoice.action(for: "stop scan") == .stopMetaScan)
    #expect(PickVoice.action(for: "repeat instruction") == .readInstruction)
    #expect(!PickVoice.isConfirmation("pick order 1001 quantity 10"))
    #expect(PickVoice.action(for: "pick order 1001 quantity 10") == nil)
}
