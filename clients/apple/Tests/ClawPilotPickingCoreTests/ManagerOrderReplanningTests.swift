import Foundation
import Testing
@testable import ClawPilotPickingApple
@testable import ClawPilotPickingCore

private let replanningFingerprint = String(repeating: "a", count: 64)
private let replanningOrganizationId = "11111111-1111-4111-8111-111111111111"

private func replanningAction(
    fingerprint: String = replanningFingerprint
) -> ManagerOrderActionAvailability {
    ManagerOrderActionAvailability(
        action: "reopen_for_replanning",
        label: "Reopen for replanning",
        enabled: true,
        blockedReason: nil,
        consequenceSummary: "Cancels an unreleased local plan and makes no provider calls.",
        expectedPlanGlobalId: "gfp0000001",
        expectedPlanVersion: 3,
        expectedCorrectionFingerprint: fingerprint
    )
}

private func replanningOrder(
    actions: [ManagerOrderActionAvailability]? = nil
) -> ManagerOrderDetail {
    ManagerOrderDetail(
        globalId: "gor0000001",
        orderNumber: "1001",
        customerName: "Bakery Bites",
        status: "planned",
        warehouseName: "Main warehouse",
        rowVersion: 7,
        planStatus: "planned",
        waveStatus: nil,
        pickTaskCount: 0,
        readyPickTaskCount: 0,
        pickedPickTaskCount: 0,
        availableActions: actions ?? [replanningAction()]
    )
}

private func replanningCommand() throws -> ManagerOrderReplanningCommand {
    try ManagerOrderReplanningCommand(
        order: replanningOrder(),
        organizationId: replanningOrganizationId,
        workerEmail: "manager@example.com",
        reason: "  Rebuild the warehouse plan.  ",
        idempotencyKey: "fixed-correction"
    )
}

private func replanningRequestBody(_ request: URLRequest) -> [String: Any]? {
    let data: Data
    if let body = request.httpBody {
        data = body
    } else if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
        defer { buffer.deallocate() }
        var collected = Data()
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 4_096)
            if count <= 0 { break }
            collected.append(buffer, count: count)
        }
        data = collected
    } else {
        return nil
    }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

private final class ManagerOrderReplanningURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let status: Int
        let responseBody: String
        if request.httpMethod == "GET" {
            status = 200
            responseBody = #"{"ok":true,"operations":{"orders":[],"selectedOrder":{"globalId":"gor0000001","orderNumber":"1001","customerName":"Bakery Bites","status":"planned","warehouseName":"Main warehouse","rowVersion":7,"planStatus":"planned","waveStatus":null,"pickTaskCount":0,"readyPickTaskCount":0,"pickedPickTaskCount":0,"availableActions":[{"action":"reopen_for_replanning","label":"Reopen for replanning","enabled":true,"blockedReason":null,"blockedCode":null,"consequenceSummary":"Cancels an unreleased local plan and makes no provider calls.","expectedPlanGlobalId":"gfp0000001","expectedPlanVersion":3,"expectedCorrectionFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}}"#
        } else {
            let body = replanningRequestBody(request)
            let valid = request.value(forHTTPHeaderField: "Idempotency-Key")
                    == "manager-replanning:fixed-correction"
                && body?["action"] as? String == "reopen-order-for-replanning"
                && body?["orderGlobalId"] as? String == "gor0000001"
                && body?["expectedRowVersion"] as? Int == 7
                && body?["expectedPlanGlobalId"] as? String == "gfp0000001"
                && body?["expectedPlanVersion"] as? Int == 3
                && body?["expectedCorrectionFingerprint"] as? String
                    == replanningFingerprint
                && body?["reason"] as? String == "Rebuild the warehouse plan."
            status = valid ? 201 : 422
            responseBody = valid
                ? #"{"ok":true,"result":{"orderGlobalId":"gor0000001","orderStatus":"imported","previousRowVersion":7,"rowVersion":8,"correctionGlobalId":"gorc0000001","cancelledPlanGlobalId":"gfp0000001","releasedLocalReservationCount":1,"releasedProviderCommitmentCount":0,"releasedPackagingClaimCount":1,"providerReads":0,"providerWrites":0,"replayed":false}}"#
                : #"{"ok":false,"code":"BAD_REPLANNING_COMMAND","error":"Bad command"}"#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerOrderReplanningInProgressURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 409,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"code":"OPERATIONS_COMMAND_IN_PROGRESS","error":"This order command is already being processed"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerOrderReplanningMalformedConflictURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 409,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("not-json".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test("manager correction exists only from an exact enabled server projection")
func managerReplanningProjectionIsAuthoritative() throws {
    let command = try replanningCommand()
    #expect(command.action == "reopen-order-for-replanning")
    #expect(command.organizationId == replanningOrganizationId)
    #expect(command.workerEmail == "manager@example.com")
    #expect(command.expectedRowVersion == 7)
    #expect(command.expectedPlanGlobalId == "gfp0000001")
    #expect(command.expectedPlanVersion == 3)
    #expect(command.expectedCorrectionFingerprint == replanningFingerprint)
    #expect(command.reason == "Rebuild the warehouse plan.")
    #expect(command.idempotencyKey == "manager-replanning:fixed-correction")

    #expect(throws: ManagerOrderReplanningClientError.invalidServerProjection) {
        _ = try ManagerOrderReplanningCommand(
            order: replanningOrder(actions: []),
            organizationId: replanningOrganizationId,
            workerEmail: "manager@example.com",
            reason: "Rebuild the plan.",
            idempotencyKey: "fixed-correction"
        )
    }
    #expect(throws: ManagerOrderReplanningClientError.invalidServerProjection) {
        _ = try ManagerOrderReplanningCommand(
            order: replanningOrder(actions: [replanningAction(fingerprint: "bad")]),
            organizationId: replanningOrganizationId,
            workerEmail: "manager@example.com",
            reason: "Rebuild the plan.",
            idempotencyKey: "fixed-correction"
        )
    }
}

@Test("disabled server correction remains visible with exact blocker but cannot construct command")
func managerReplanningDisabledProjectionRemainsVisible() throws {
    let blocked = ManagerOrderActionAvailability(
        action: "reopen_for_replanning",
        label: "Reopen for replanning",
        enabled: false,
        blockedReason: "Current-version scan evidence exists.",
        blockedCode: "OPERATIONS_REPLANNING_PHYSICAL_WORK_EXISTS",
        consequenceSummary: nil,
        expectedPlanGlobalId: "gfp0000001",
        expectedPlanVersion: 3,
        expectedCorrectionFingerprint: nil
    )
    let order = replanningOrder(actions: [blocked])
    let availability = try #require(order.replanningCorrectionAvailability)
    #expect(availability.blockedReason == "Current-version scan evidence exists.")
    #expect(availability.blockedCode == "OPERATIONS_REPLANNING_PHYSICAL_WORK_EXISTS")
    #expect(order.replanningCorrectionAction == nil)
    #expect(throws: ManagerOrderReplanningClientError.invalidServerProjection) {
        _ = try ManagerOrderReplanningCommand(
            order: order,
            organizationId: replanningOrganizationId,
            workerEmail: "manager@example.com",
            reason: "Rebuild the plan.",
            idempotencyKey: "fixed-correction"
        )
    }
}

@Test("iPhone renders disabled server correction and its exact blocker")
func managerReplanningDisabledProjectionUIContract() throws {
    let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let source = try String(
        contentsOf: appleRoot.appendingPathComponent(
            "Apps/iPhone/ClawPilotAppShellView.swift"
        ),
        encoding: .utf8
    )
    #expect(source.contains("order.replanningCorrectionAvailability"))
    #expect(source.contains("correction.blockedReason"))
    #expect(source.contains("correction.blockedCode"))
    #expect(source.contains("!correction.isExactReplanningCorrectionProjection"))
}

@Test("manager correction outbox is exact and picker work blocks save and replay")
func managerReplanningOutboxBlocksDurablePickerWork() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-manager-replanning-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let command = try replanningCommand()
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000001",
        sequence: 1,
        productGlobalId: "gp0000001",
        productName: "Widget",
        channelSku: "W-1",
        barcode: "123",
        locationCode: "A-1",
        quantity: 1
    )
    let pickOrder = try PickOrder(
        orderGlobalId: command.orderGlobalId,
        orderNumber: "1001",
        rowVersion: command.expectedRowVersion,
        tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: replanningOrganizationId,
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [pickOrder]
    )

    try await cache.saveOutbox(ConfirmPicksCommand(
        order: pickOrder,
        idempotencyKey: "fixed-confirmation"
    ))
    do {
        try await cache.saveManagerOrderReplanningOutbox(command)
        Issue.record("same-order confirmation should block correction save")
    } catch {
        #expect(error as? ManagerOrderReplanningClientError == .pickerCommandPending)
    }
    try await cache.clearOutbox()

    let handoff = try PickHandoffCommand(
        queue: queue,
        order: pickOrder,
        reason: "Manager help requested.",
        idempotencyKey: "fixed-handoff"
    )
    try await cache.saveHandoffOutbox(handoff)
    do {
        try await cache.saveManagerOrderReplanningOutbox(command)
        Issue.record("same-order handoff should block correction save")
    } catch {
        #expect(error as? ManagerOrderReplanningClientError == .pickerCommandPending)
    }
    try await cache.clearHandoffOutbox()

    let progress = PickSessionProgress(
        organizationId: replanningOrganizationId,
        workerEmail: "picker@example.com",
        order: pickOrder,
        scannedTaskIDs: [task.pickTaskGlobalId],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: [:],
        countEvidence: [:],
        stageContextTokens: [:]
    )
    try await cache.saveProgress(progress)
    do {
        try await cache.saveManagerOrderReplanningOutbox(command)
        Issue.record("same-order picker progress should block correction save")
    } catch {
        #expect(error as? ManagerOrderReplanningClientError == .pickerCommandPending)
    }
    try await cache.clearProgress()

    try await cache.saveManagerOrderReplanningOutbox(command)
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)

    try await cache.saveOutbox(ConfirmPicksCommand(
        order: pickOrder,
        idempotencyKey: "replay-block"
    ))
    do {
        try await cache.requireManagerOrderReplanningReplayIsUnblocked(command)
        Issue.record("same-order confirmation should block correction replay")
    } catch {
        #expect(error as? ManagerOrderReplanningClientError == .pickerCommandPending)
    }
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)
}

@Test("terminal stale correction moves out of replay path and retains full quarantine")
func managerReplanningQuarantineIsDurable() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-manager-replanning-stale-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let command = try replanningCommand()
    try await cache.saveManagerOrderReplanningOutbox(command)
    let quarantine = try await cache.quarantineManagerOrderReplanningOutbox(
        command,
        code: "OPERATIONS_REPLANNING_FINGERPRINT_CONFLICT",
        message: "Warehouse commitments changed.",
        quarantinedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    #expect(quarantine.command == command)
    #expect(try await cache.loadManagerOrderReplanningOutbox() == nil)
    let quarantines = try await cache.loadManagerOrderReplanningQuarantines()
    #expect(quarantines.count == 1)
    #expect(quarantines.first?.command == command)
    #expect(quarantines.first?.code == "OPERATIONS_REPLANNING_FINGERPRINT_CONFLICT")
}

@Test("workspace recovery preserves exact manager correction and idempotency")
func managerReplanningWorkspaceRecoveryPreservesOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-manager-replanning-workspace-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let command = try replanningCommand()
    let sourceTask = try PickTask(
        pickTaskGlobalId: "gpk0000002",
        sequence: 1,
        productGlobalId: "gp0000002",
        productName: "Source workspace item",
        channelSku: "SOURCE-1",
        barcode: "456",
        locationCode: "B-1",
        quantity: 1
    )
    let sourceOrder = try PickOrder(
        orderGlobalId: "gor0000002",
        orderNumber: "2002",
        rowVersion: 1,
        tasks: [sourceTask]
    )
    let sourceQueue = try PickQueue(
        schemaVersion: 1,
        organizationId: "22222222-2222-4222-8222-222222222222",
        workerEmail: command.workerEmail,
        generatedAt: Date(),
        orders: [sourceOrder]
    )
    try await cache.saveQueue(sourceQueue)
    try await cache.saveManagerOrderReplanningOutbox(command)

    let invalidClear = try WorkspaceTransition(
        sourceOrganizationId: "22222222-2222-4222-8222-222222222222",
        targetOrganizationId: replanningOrganizationId,
        workerEmail: command.workerEmail,
        pickerCachePolicy: .clearScopedData,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    do {
        try await cache.saveWorkspaceTransition(invalidClear)
        Issue.record("correction recovery must not use destructive scoped cleanup")
    } catch {
        #expect(error as? PickingContractError == .contextMismatch)
    }

    let recovery = try WorkspaceTransition(
        sourceOrganizationId: "22222222-2222-4222-8222-222222222222",
        targetOrganizationId: command.organizationId,
        workerEmail: command.workerEmail,
        pickerCachePolicy: .preserveProtectedCommand,
        startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    try await cache.saveWorkspaceTransition(recovery)
    let picking = PickingSession(cache: cache)
    try await picking.clearQueue()
    #expect(try await cache.loadWorkspaceTransition() == recovery)
    #expect(try await cache.loadQueue() == nil)
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)
    #expect(
        try await cache.loadManagerOrderReplanningOutbox()?.idempotencyKey
            == "manager-replanning:fixed-correction"
    )
    try await cache.clearWorkspaceTransition(recovery)
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)
}

@Test("native manager decodes exact projection and posts exact correction fences")
func nativeManagerReplanningRoundTrip() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerOrderReplanningURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-replanning.test")!,
        session: URLSession(configuration: configuration)
    )
    let detail = try await client.fetchManagerOrderDetail("gor0000001")
    let projection = try #require(detail.replanningCorrectionAction)
    #expect(projection.expectedPlanVersion == 3)
    #expect(projection.expectedCorrectionFingerprint == replanningFingerprint)
    let command = try ManagerOrderReplanningCommand(
        order: detail,
        organizationId: replanningOrganizationId,
        workerEmail: "manager@example.com",
        reason: "Rebuild the warehouse plan.",
        idempotencyKey: "fixed-correction"
    )
    let result = try await client.reopenManagerOrderForReplanning(command)
    #expect(result.orderStatus == "imported")
    #expect(result.rowVersion == 8)
    #expect(result.providerReads == 0)
    #expect(result.providerWrites == 0)
}

@Test("in-progress exact replay keeps durable correction and stable idempotency")
func managerReplanningInProgressPreservesOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-manager-replanning-processing-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let command = try replanningCommand()
    try await cache.saveManagerOrderReplanningOutbox(command)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerOrderReplanningInProgressURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-replanning-processing.test")!,
        session: URLSession(configuration: configuration)
    )
    do {
        _ = try await client.reopenManagerOrderForReplanning(command)
        Issue.record("in-progress command should return a structured conflict")
    } catch PickingAPIError.conflict(let code, _) {
        #expect(code == "OPERATIONS_COMMAND_IN_PROGRESS")
        #expect(
            ManagerOrderReplanningConflictDisposition.forServerCode(code)
                == .retrySameCommand
        )
    }
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)
    #expect(command.idempotencyKey == "manager-replanning:fixed-correction")
}

@Test("only terminal projection conflicts are quarantined")
func managerReplanningConflictDispositionIsFailClosed() {
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_COMMAND_IN_PROGRESS"
        ) == .retrySameCommand
    )
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_ORDER_VERSION_CONFLICT"
        ) == .quarantineStaleProjection
    )
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_REPLANNING_PLAN_CHANGED"
        ) == .quarantineStaleProjection
    )
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_IDEMPOTENCY_CONFLICT"
        ) == .retrySameCommand
    )
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_REPLANNING_FUTURE_RECOVERABLE_CONFLICT"
        ) == .retrySameCommand
    )
    #expect(
        ManagerOrderReplanningConflictDisposition.forServerCode(
            "OPERATIONS_UNCLASSIFIED_CONFLICT"
        ) == .retrySameCommand
    )
}

@Test("malformed 409 remains unclassified and retains exact correction")
func managerReplanningMalformedConflictRetainsOutbox() async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("clawpilot-manager-replanning-malformed-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try DurablePickCache(directory: directory)
    let command = try replanningCommand()
    try await cache.saveManagerOrderReplanningOutbox(command)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerOrderReplanningMalformedConflictURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-replanning-malformed.test")!,
        session: URLSession(configuration: configuration)
    )
    do {
        _ = try await client.reopenManagerOrderForReplanning(command)
        Issue.record("malformed 409 should remain a structured retry conflict")
    } catch PickingAPIError.conflict(let code, _) {
        #expect(code == "OPERATIONS_UNCLASSIFIED_CONFLICT")
        #expect(
            ManagerOrderReplanningConflictDisposition.forServerCode(code)
                == .retrySameCommand
        )
    }
    #expect(try await cache.loadManagerOrderReplanningOutbox() == command)
    #expect(
        try await cache.loadManagerOrderReplanningOutbox()?.idempotencyKey
            == "manager-replanning:fixed-correction"
    )
}
