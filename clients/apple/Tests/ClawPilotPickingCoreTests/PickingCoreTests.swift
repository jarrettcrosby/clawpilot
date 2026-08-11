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

private func locationFirstQueue() throws -> PickQueue {
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000003",
        sequence: 1,
        productGlobalId: "gp0000003",
        productName: "Green Widget",
        channelSku: "GREEN-1",
        barcode: "4006381333931",
        locationCode: "B-02-03",
        warehouseGlobalId: "gwh0000003",
        locationGlobalId: "gwl0000003",
        locationBarcode: "CP1L-GWL0000003",
        locationScanRequired: true,
        locationScanPolicyRowVersion: 2,
        quantity: 3
    )
    return try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [try PickOrder(
            orderGlobalId: "gor0000002",
            orderNumber: "1002",
            rowVersion: 3,
            tasks: [task]
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
    #expect(first.scanEvidence == nil)
    #expect(first.scanEvidenceIdempotencyKey == nil)
    let encoded = try JSONEncoder().encode(first)
    let body = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    #expect(body["action"] as? String == "confirm-picks")
    #expect((body["idempotencyKey"] as? String)?.hasPrefix("wearable-pick:") == true)
    #expect(body["scanEvidence"] == nil)
    #expect(body["scanEvidenceIdempotencyKey"] == nil)
}

@Test("location-first tasks require an exact location label before product acceptance")
func locationFirstAcceptance() async throws {
    let session = PickingSession(cache: MemoryCache())
    try await session.replaceQueue(locationFirstQueue())
    let now = Date()

    #expect(await session.currentScanStage() == .location)
    await #expect(throws: PickingContractError.locationBarcodeMismatch) {
        _ = try await session.accept(BarcodeObservation(
            value: "4006381333931",
            source: .metaGlasses,
            capturedAt: now
        ), now: now)
    }
    await #expect(throws: PickingContractError.locationBarcodeMismatch) {
        _ = try await session.accept(BarcodeObservation(
            value: "cp1l-gwl0000003",
            source: .iPhoneCamera,
            capturedAt: now
        ), now: now)
    }

    let location = try await session.accept(BarcodeObservation(
        value: "CP1L-GWL0000003",
        source: .metaGlasses,
        capturedAt: now
    ), now: now)
    #expect(location.stage == .location)
    #expect(location.task.pickTaskGlobalId == "gpk0000003")
    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000003")
    #expect(await session.currentScanStage() == .product)
    #expect(await session.makeWatchSnapshot()?.current?.locationScanRequired == false)

    await #expect(throws: PickingContractError.productBarcodeMismatch) {
        _ = try await session.accept(BarcodeObservation(
            value: "CP1L-GWL0000003",
            source: .iPhoneCamera,
            capturedAt: now
        ), now: now)
    }
    let product = try await session.accept(BarcodeObservation(
        value: "4006381333931",
        source: .iPhoneCamera,
        capturedAt: now
    ), now: now)
    #expect(product.stage == .product)
    #expect(await session.currentTask() == nil)

    let command = try await session.persistConfirmation()
    let evidence = try #require(command.scanEvidence)
    #expect(command.scanEvidenceIdempotencyKey?.hasPrefix("wearable-scan:") == true)
    #expect(evidence.count == 1)
    #expect(evidence[0].pickTaskGlobalId == "gpk0000003")
    #expect(evidence[0].policyRowVersion == 2)
    #expect(evidence[0].location.barcode == "CP1L-GWL0000003")
    #expect(evidence[0].location.source == .metaGlasses)
    #expect(evidence[0].product.barcode == "4006381333931")
    #expect(evidence[0].product.source == .iPhoneCamera)
}

@Test("legacy cached tasks decode with location verification disabled")
func legacyCachedTaskLocationPolicyIsOff() throws {
    let legacy = Data(#"""
    {
      "pickTaskGlobalId":"gpk0000001",
      "sequence":1,
      "productGlobalId":"gp0000001",
      "productName":"Blue Widget",
      "channelSku":"BLUE-1",
      "barcode":"012345678905",
      "locationCode":"A-01-01",
      "quantity":2
    }
    """#.utf8)
    let task = try JSONDecoder().decode(PickTask.self, from: legacy)
    #expect(task.locationBarcode == nil)
    #expect(task.locationScanRequired == nil)
    #expect(task.locationScanPolicyRowVersion == nil)
}

@Test("Watch projection carries display data but no barcode or mutation authority")
func safeWatchProjection() async throws {
    let session = PickingSession(cache: MemoryCache())
    try await session.replaceQueue(fixtureQueue())
    let snapshot = try #require(await session.makeWatchSnapshot(
        instructionLanguageCode: "es",
        readInstructionOnPhone: true
    ))
    let data = try JSONEncoder().encode(snapshot)
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("Blue Widget"))
    #expect(snapshot.current?.productImageURL?.absoluteString == "https://example.com/product.png")
    #expect(!text.contains("012345678905"))
    #expect(!text.contains("orderGlobalId"))
    #expect(snapshot.upcoming.count == 1)
    #expect(snapshot.instructionLanguageCode == "es")
    #expect(snapshot.readInstructionOnPhone == true)
}

@Test("Watch instruction uses the same bounded pick wording as iPhone")
func watchInstructionText() {
    #expect(PickVoice.instruction(
        productName: "Blue Widget",
        locationCode: "PICK-01",
        quantity: 2
    ) == "Pick 2 of Blue Widget from location pick zero one. Scan the product barcode.")
}

@Test("location-first voice instruction never asks for the product first")
func locationFirstInstructionText() {
    #expect(PickVoice.instruction(
        productName: "Blue Widget",
        locationCode: "PICK-01",
        quantity: 2,
        locationScanRequired: true
    ) == "Go to location pick zero one. Scan the location label before the product.")
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

@Test("Watch command results acknowledge the exact command without mutation authority")
func safeWatchCommandResult() throws {
    let command = WatchPickCommand(id: "watch-refresh-1", action: .refreshQueue)
    let result = WatchPickCommandResult(
        command: command,
        succeeded: true,
        message: String(repeating: "a", count: 300),
        completedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let data = try JSONEncoder().encode(result)
    let text = String(decoding: data, as: UTF8.self)

    #expect(result.schemaVersion == 1)
    #expect(result.commandId == command.id)
    #expect(result.action == .refreshQueue)
    #expect(result.succeeded)
    #expect(result.message.count == 240)
    #expect(!text.contains("orderGlobalId"))
    #expect(!text.contains("pickTaskGlobalId"))
    #expect(!text.contains("barcode"))
}

@Test("Watch cards can advertise a future location-first phase without enforcing it")
func optionalWatchLocationScanPhase() throws {
    let card = WatchPickCard(
        productName: "Blue Widget",
        channelSku: "BLUE-1",
        productImageURL: nil,
        locationCode: "A-01-01",
        locationBarcode: "LOC-A-01-01",
        locationScanRequired: true,
        quantity: 2,
        progress: "1 of 2"
    )
    let encoded = try JSONEncoder().encode(card)
    let decoded = try JSONDecoder().decode(WatchPickCard.self, from: encoded)
    #expect(decoded.locationBarcode == "LOC-A-01-01")
    #expect(decoded.locationScanRequired == true)

    let legacy = Data(#"{"productName":"Blue Widget","channelSku":"BLUE-1","locationCode":"A-01-01","quantity":2,"progress":"1 of 2"}"#.utf8)
    let legacyCard = try JSONDecoder().decode(WatchPickCard.self, from: legacy)
    #expect(legacyCard.locationBarcode == nil)
    #expect(legacyCard.locationScanRequired == nil)
}

@Test("Watch product thumbnails stay inside the current-state transfer budget")
func watchProductImageTransferBudget() throws {
    #expect(WatchConnectivityPayloadBudget.fits(
        productImageBytes: WatchConnectivityPayloadBudget.maximumProductImageBytes,
        nonImageBytes: WatchConnectivityPayloadBudget.reservedNonImageBytes
    ))

    let worstCaseNormalContext: [String: Any] = [
        "pickSnapshot": Data(count: 14 * 1_024),
        "pickProductImageData": Data(
            count: WatchConnectivityPayloadBudget.maximumProductImageBytes
        ),
        "pickProductImageSource": String(repeating: "u", count: 512),
        "pickCommandResult": Data(count: 1_024),
    ]
    let encoded = try PropertyListSerialization.data(
        fromPropertyList: worstCaseNormalContext,
        format: .binary,
        options: 0
    )
    #expect(encoded.count <= WatchConnectivityPayloadBudget.maximumApplicationContextBytes)
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

@Test("warehouse location codes are spoken without losing leading zeroes")
func warehouseLocationCodesAreSpokenExactly() {
    #expect(PickVoice.spokenLocationCode("PICK-01") == "pick zero one")
    #expect(PickVoice.spokenLocationCode("A-01-02") == "A zero one zero two")
    #expect(PickVoice.spokenLocationCode("PICK-01", languageCode: "es") == "pick cero uno")
}

@Test("spoken product names omit channel suffixes and expand warehouse units")
func spokenProductNamesAreClear() {
    #expect(PickVoice.spokenProductName("Bacon Bits 20lb · Shopify") == "Bacon Bits 20 pounds")
    #expect(PickVoice.spokenProductName("Coffee 12oz", languageCode: "es") == "Coffee 12 onzas")
}
