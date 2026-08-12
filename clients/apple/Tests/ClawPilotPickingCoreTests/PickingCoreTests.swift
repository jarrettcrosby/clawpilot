import Foundation
import Testing
@testable import ClawPilotPickingCore

private enum InjectedCacheError: Error {
    case progressWrite
    case retirementWrite
}

private actor MemoryCache: PickCache {
    var queue: PickQueue?
    var outbox: ConfirmPicksCommand?
    var handoffOutbox: PickHandoffCommand?
    var progress: PickSessionProgress?
    var failProgressWrites = false

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws { self.queue = queue }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_ command: ConfirmPicksCommand) async throws { outbox = command }
    func loadOutbox() async throws -> ConfirmPicksCommand? { outbox }
    func clearOutbox() async throws { outbox = nil }
    func saveHandoffOutbox(_ command: PickHandoffCommand) async throws {
        if let handoffOutbox, handoffOutbox != command {
            throw PickingContractError.contextMismatch
        }
        handoffOutbox = command
    }
    func loadHandoffOutbox() async throws -> PickHandoffCommand? { handoffOutbox }
    func clearHandoffOutbox() async throws { handoffOutbox = nil }
    func loadProgress() async throws -> PickSessionProgress? { progress }
    func saveProgress(_ progress: PickSessionProgress) async throws {
        guard !failProgressWrites else { throw InjectedCacheError.progressWrite }
        self.progress = progress
    }
    func clearProgress() async throws { progress = nil }
    func setProgressWriteFailure(_ enabled: Bool) { failProgressWrites = enabled }
}

private actor HandoffRetirementFailureCache: PickCache {
    enum FailurePoint: Equatable {
        case clearProgress
        case saveReplacementQueue
        case clearConfirmationOutbox
        case clearHandoffOutbox
    }

    var queue: PickQueue?
    var outbox: ConfirmPicksCommand?
    var handoffOutbox: PickHandoffCommand?
    var progress: PickSessionProgress?
    var failurePoint: FailurePoint?
    var handedOffOrderGlobalId: String?

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws {
        if failurePoint == .saveReplacementQueue,
           !queue.orders.contains(where: {
               $0.orderGlobalId == handedOffOrderGlobalId
           }) {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        self.queue = queue
    }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_ command: ConfirmPicksCommand) async throws { outbox = command }
    func loadOutbox() async throws -> ConfirmPicksCommand? { outbox }
    func clearOutbox() async throws {
        if failurePoint == .clearConfirmationOutbox {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        outbox = nil
    }
    func saveHandoffOutbox(_ command: PickHandoffCommand) async throws {
        handoffOutbox = command
    }
    func loadHandoffOutbox() async throws -> PickHandoffCommand? { handoffOutbox }
    func clearHandoffOutbox() async throws {
        if failurePoint == .clearHandoffOutbox {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        handoffOutbox = nil
    }
    func loadProgress() async throws -> PickSessionProgress? { progress }
    func saveProgress(_ progress: PickSessionProgress) async throws {
        self.progress = progress
    }
    func clearProgress() async throws {
        if failurePoint == .clearProgress {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        progress = nil
    }

    func failNextRetirementWrite(
        at point: FailurePoint,
        orderGlobalId: String
    ) {
        failurePoint = point
        handedOffOrderGlobalId = orderGlobalId
    }
}

private actor BlockingHandoffCache: PickCache {
    var queue: PickQueue?
    var outbox: ConfirmPicksCommand?
    var handoffOutbox: PickHandoffCommand?
    var progress: PickSessionProgress?
    private var shouldBlockHandoffRead = false
    private var blockedContinuation: CheckedContinuation<Void, Never>?
    private var readStartedContinuation: CheckedContinuation<Void, Never>?

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws { self.queue = queue }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_ command: ConfirmPicksCommand) async throws { outbox = command }
    func loadOutbox() async throws -> ConfirmPicksCommand? { outbox }
    func clearOutbox() async throws { outbox = nil }
    func saveHandoffOutbox(_ command: PickHandoffCommand) async throws {
        handoffOutbox = command
    }
    func loadHandoffOutbox() async throws -> PickHandoffCommand? {
        if shouldBlockHandoffRead {
            shouldBlockHandoffRead = false
            readStartedContinuation?.resume()
            readStartedContinuation = nil
            await withCheckedContinuation { continuation in
                blockedContinuation = continuation
            }
        }
        return handoffOutbox
    }
    func clearHandoffOutbox() async throws { handoffOutbox = nil }
    func loadProgress() async throws -> PickSessionProgress? { progress }
    func saveProgress(_ progress: PickSessionProgress) async throws {
        self.progress = progress
    }
    func clearProgress() async throws { progress = nil }

    func blockNextHandoffRead() { shouldBlockHandoffRead = true }
    func waitUntilHandoffReadStarts() async {
        if blockedContinuation != nil { return }
        await withCheckedContinuation { continuation in
            readStartedContinuation = continuation
        }
    }
    func releaseHandoffRead() {
        blockedContinuation?.resume()
        blockedContinuation = nil
    }
}

private actor BlockingProgressCache: PickCache {
    private var queue: PickQueue?
    private var progress: PickSessionProgress?
    private var shouldBlockNextProgressWrite = false
    private var blockedContinuation: CheckedContinuation<Void, Never>?
    private var writeStartedContinuation: CheckedContinuation<Void, Never>?

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws { self.queue = queue }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_: ConfirmPicksCommand) async throws {}
    func loadOutbox() async throws -> ConfirmPicksCommand? { nil }
    func clearOutbox() async throws {}
    func loadProgress() async throws -> PickSessionProgress? { progress }
    func saveProgress(_ progress: PickSessionProgress) async throws {
        if shouldBlockNextProgressWrite {
            shouldBlockNextProgressWrite = false
            writeStartedContinuation?.resume()
            writeStartedContinuation = nil
            await withCheckedContinuation { continuation in
                blockedContinuation = continuation
            }
        }
        self.progress = progress
    }
    func clearProgress() async throws { progress = nil }

    func blockNextProgressWrite() { shouldBlockNextProgressWrite = true }
    func waitUntilProgressWriteStarts() async {
        if blockedContinuation != nil { return }
        await withCheckedContinuation { continuation in
            writeStartedContinuation = continuation
        }
    }
    func releaseProgressWrite() {
        blockedContinuation?.resume()
        blockedContinuation = nil
    }
}

private actor RetirementFailureCache: PickCache {
    enum FailurePoint: Equatable {
        case clearProgress
        case saveReplacementQueue
        case clearOutbox
    }

    var queue: PickQueue?
    var outbox: ConfirmPicksCommand?
    var progress: PickSessionProgress?
    var failurePoint: FailurePoint?
    var replacementOrderGlobalId: String?

    func loadQueue() async throws -> PickQueue? { queue }
    func saveQueue(_ queue: PickQueue) async throws {
        if failurePoint == .saveReplacementQueue,
           !queue.orders.contains(where: {
               $0.orderGlobalId == replacementOrderGlobalId
           }) {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        self.queue = queue
    }
    func clearQueue() async throws { queue = nil }
    func saveOutbox(_ command: ConfirmPicksCommand) async throws { outbox = command }
    func loadOutbox() async throws -> ConfirmPicksCommand? { outbox }
    func clearOutbox() async throws {
        if failurePoint == .clearOutbox {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        outbox = nil
    }
    func loadProgress() async throws -> PickSessionProgress? { progress }
    func saveProgress(_ progress: PickSessionProgress) async throws {
        self.progress = progress
    }
    func clearProgress() async throws {
        if failurePoint == .clearProgress {
            failurePoint = nil
            throw InjectedCacheError.retirementWrite
        }
        progress = nil
    }

    func failNextRetirementWrite(
        at point: FailurePoint,
        pendingOrderGlobalId: String
    ) {
        failurePoint = point
        replacementOrderGlobalId = pendingOrderGlobalId
    }
}

private actor OutboxReadFailureCache: PickCache {
    func loadQueue() async throws -> PickQueue? { nil }
    func saveQueue(_: PickQueue) async throws {}
    func clearQueue() async throws {}
    func saveOutbox(_: ConfirmPicksCommand) async throws {}
    func loadOutbox() async throws -> ConfirmPicksCommand? {
        throw InjectedCacheError.retirementWrite
    }
    func clearOutbox() async throws {}
    func loadProgress() async throws -> PickSessionProgress? { nil }
    func saveProgress(_: PickSessionProgress) async throws {}
    func clearProgress() async throws {}
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

@Test("restored prior-workspace queue cannot produce an authorized Watch projection")
func restoredQueueRequiresFreshWorkspaceIdentity() async throws {
    let cache = MemoryCache()
    let oldQueue = try fixtureQueue()
    try await cache.saveQueue(oldQueue)
    let restored = PickingSession(cache: cache)
    _ = try await restored.restore()

    #expect(await restored.queueIdentityMatches(
        organizationId: oldQueue.organizationId,
        workerEmail: oldQueue.workerEmail
    ))
    #expect(await restored.queueIdentityMatches(
        organizationId: "22222222-2222-4222-8222-222222222222",
        workerEmail: oldQueue.workerEmail
    ) == false)
    #expect(await restored.makeWatchSnapshot(
        authorizedOrganizationId: "22222222-2222-4222-8222-222222222222",
        authorizedWorkerEmail: oldQueue.workerEmail
    ) == nil)
    #expect(await restored.makeWatchSnapshot(
        authorizedOrganizationId: oldQueue.organizationId,
        authorizedWorkerEmail: "different-picker@example.com"
    ) == nil)
    // Preserve the old queue internally so an exact durable confirmation or
    // handoff can still guide the user back to its owning workspace.
    #expect(await restored.currentOrder() == oldQueue.orders.first)
}

@Test("exact confirmation retirement advances once under duplicate completion")
func exactConfirmationRetirementIsSingleAdvance() async throws {
    let cache = MemoryCache()
    let fixture = try fixtureQueue()
    let template = try #require(fixture.orders.first)
    let second = try PickOrder(
        orderGlobalId: "gor0000021",
        orderNumber: "1021",
        rowVersion: 21,
        tasks: template.tasks
    )
    let third = try PickOrder(
        orderGlobalId: "gor0000022",
        orderNumber: "1022",
        rowVersion: 22,
        tasks: template.tasks
    )
    let queue = try PickQueue(
        schemaVersion: fixture.schemaVersion,
        organizationId: fixture.organizationId,
        workerEmail: fixture.workerEmail,
        generatedAt: fixture.generatedAt,
        orders: [template, second, third]
    )
    let session = PickingSession(cache: cache)
    try await session.replaceQueue(queue)
    let command = ConfirmPicksCommand(
        order: template,
        idempotencyKey: "single-advance"
    )
    try await cache.saveOutbox(command)

    try await session.finishConfirmedOrder(command)
    #expect(await session.currentOrder() == second)
    #expect(try await cache.loadQueue()?.orders == [second, third])
    #expect(try await cache.loadOutbox() == nil)

    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.finishConfirmedOrder(command)
    }
    #expect(await session.currentOrder() == second)
    #expect(try await cache.loadQueue()?.orders == [second, third])
}

@Test("unstarted pick handoff persists exact owning context before transport")
func unstartedPickHandoffIsDurableAndProgressFenced() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    #expect(await session.canRequestActivePickHandoff())

    let command = try await session.persistPickHandoff(
        reason: "Location is inaccessible; manager review requested."
    )
    #expect(command.organizationId == queue.organizationId)
    #expect(command.workerEmail == queue.workerEmail)
    #expect(command.orderGlobalId == queue.orders[0].orderGlobalId)
    #expect(command.expectedRowVersion == queue.orders[0].rowVersion)
    #expect(command.expectedAssignedTaskCount == queue.orders[0].tasks.count)
    #expect(command.blockedConfirmationIdempotencyKey == nil)
    #expect(command.idempotencyKey.hasPrefix("picker-handoff:"))
    #expect(try await cache.loadHandoffOutbox() == command)

    let progressedCache = MemoryCache()
    let progressed = PickingSession(cache: progressedCache)
    try await progressed.replaceQueue(queue)
    _ = try await progressed.accept(BarcodeObservation(
        value: "012345678905",
        source: .iPhoneCamera
    ))
    #expect(!(await progressed.canRequestActivePickHandoff()))
    await #expect(throws: PickingContractError.contextMismatch) {
        _ = try await progressed.persistPickHandoff(reason: "Too late")
    }
    #expect(try await progressedCache.loadHandoffOutbox() == nil)
}

@Test("handoff persistence blocks late scans and queue replacement")
func handoffPersistenceHasAReentrancyFence() async throws {
    let cache = BlockingHandoffCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    await cache.blockNextHandoffRead()

    let persistence = Task {
        try await session.persistPickHandoff(reason: "Manager help requested.")
    }
    await cache.waitUntilHandoffReadStarts()
    await #expect(throws: PickingContractError.persistenceInFlight) {
        _ = try await session.accept(BarcodeObservation(
            value: "012345678905",
            source: .iPhoneCamera
        ))
    }
    await #expect(throws: PickingContractError.persistenceInFlight) {
        try await session.replaceQueue(queue)
    }
    await cache.releaseHandoffRead()
    _ = try await persistence.value
    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
}

@Test("terminal confirmation handoff durably binds the exact blocked command")
func blockedConfirmationHandoffBindsBothOutboxes() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let confirmation = ConfirmPicksCommand(
        order: queue.orders[0],
        idempotencyKey: "terminal-confirmation"
    )
    try await cache.saveOutbox(confirmation)

    let handoff = try await session.persistPickHandoff(
        reason: "Shopify conflict needs a manager handoff.",
        blockedConfirmation: confirmation
    )

    #expect(handoff.blockedConfirmationIdempotencyKey == confirmation.idempotencyKey)
    #expect(try await cache.loadOutbox() == confirmation)
    #expect(try await cache.loadHandoffOutbox() == handoff)
}

@Test("validated handoff result retires exact records and no queue omission alone can")
func exactPickHandoffRetirementIsAuthorityFenced() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let handoff = try await session.persistPickHandoff(reason: "Manager help requested.")
    let replacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(),
        orders: []
    )
    let evidence = try PickHandoffEvidence(
        command: handoff,
        orderGlobalId: handoff.orderGlobalId,
        orderStatus: "released",
        previousRowVersion: handoff.expectedRowVersion,
        rowVersion: handoff.expectedRowVersion + 1,
        exceptionGlobalId: "gex0000001",
        assignedTaskCount: handoff.expectedAssignedTaskCount,
        blockedConfirmationIdempotencyKey: nil,
        providerWrites: 0
    )

    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.retireHandedOffOrder(
            handoff,
            evidence: evidence,
            replacementQueue: queue
        )
    }
    #expect(try await cache.loadHandoffOutbox() == handoff)

    try await session.retireHandedOffOrder(
        handoff,
        evidence: evidence,
        replacementQueue: replacement
    )
    #expect(try await cache.loadHandoffOutbox() == nil)
    #expect(try await cache.loadQueue() == replacement)
    #expect(await session.currentOrder() == nil)
}

@Test("handoff retirement accepts only a strictly newer reassignment")
func handedOffOrderCanReturnOnlyAsFreshAssignment() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let handoff = try await session.persistPickHandoff(reason: "Manager help requested.")
    let evidence = try PickHandoffEvidence(
        command: handoff,
        orderGlobalId: handoff.orderGlobalId,
        orderStatus: "released",
        previousRowVersion: handoff.expectedRowVersion,
        rowVersion: handoff.expectedRowVersion + 1,
        exceptionGlobalId: "gex0000001",
        assignedTaskCount: handoff.expectedAssignedTaskCount,
        blockedConfirmationIdempotencyKey: nil,
        providerWrites: 0
    )
    let staleOrder = try PickOrder(
        orderGlobalId: queue.orders[0].orderGlobalId,
        orderNumber: queue.orders[0].orderNumber,
        rowVersion: evidence.rowVersion,
        tasks: queue.orders[0].tasks
    )
    let staleReplacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(),
        orders: [staleOrder]
    )
    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.retireHandedOffOrder(
            handoff,
            evidence: evidence,
            replacementQueue: staleReplacement
        )
    }

    let freshOrder = try PickOrder(
        orderGlobalId: queue.orders[0].orderGlobalId,
        orderNumber: queue.orders[0].orderNumber,
        rowVersion: evidence.rowVersion + 1,
        tasks: queue.orders[0].tasks
    )
    let freshReplacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date().addingTimeInterval(1),
        orders: [freshOrder]
    )
    try await session.retireHandedOffOrder(
        handoff,
        evidence: evidence,
        replacementQueue: freshReplacement
    )
    #expect(await session.currentOrder() == freshOrder)
    #expect(try await cache.loadHandoffOutbox() == nil)
}

@Test("deterministic blocked handoff rejection restores confirmation blocker")
func rejectedBlockedHandoffRetiresOnlyHandoff() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let confirmation = ConfirmPicksCommand(
        order: queue.orders[0],
        idempotencyKey: "still-terminal"
    )
    try await cache.saveOutbox(confirmation)
    let handoff = try await session.persistPickHandoff(
        reason: "Manager handoff requested.",
        blockedConfirmation: confirmation
    )

    try await session.retireRejectedBlockedPickHandoff(
        handoff,
        confirmation: confirmation
    )
    #expect(try await cache.loadHandoffOutbox() == nil)
    #expect(try await cache.loadOutbox() == confirmation)
    #expect(await session.currentOrder() == queue.orders[0])
}

@Test("interrupted blocked handoff replays one durable command and retires recoverably")
func interruptedBlockedPickHandoffIsRecoverable() async throws {
    for failurePoint in [
        HandoffRetirementFailureCache.FailurePoint.clearProgress,
        HandoffRetirementFailureCache.FailurePoint.saveReplacementQueue,
        .clearConfirmationOutbox,
        .clearHandoffOutbox,
    ] {
        let cache = HandoffRetirementFailureCache()
        let initial = PickingSession(cache: cache)
        let queue = try fixtureQueue()
        try await initial.replaceQueue(queue)
        let confirmation = ConfirmPicksCommand(
            order: queue.orders[0],
            idempotencyKey: "blocked-\(String(describing: failurePoint))"
        )
        try await cache.saveOutbox(confirmation)
        let handoff = try await initial.persistPickHandoff(
            reason: "Manager must take over this blocked pick.",
            blockedConfirmation: confirmation
        )
        let replacement = try PickQueue(
            schemaVersion: 1,
            organizationId: queue.organizationId,
            workerEmail: queue.workerEmail,
            generatedAt: Date(),
            orders: []
        )
        let evidence = try PickHandoffEvidence(
            command: handoff,
            orderGlobalId: handoff.orderGlobalId,
            orderStatus: "released",
            previousRowVersion: handoff.expectedRowVersion,
            rowVersion: handoff.expectedRowVersion + 1,
            exceptionGlobalId: "gex0000001",
            assignedTaskCount: handoff.expectedAssignedTaskCount,
            blockedConfirmationIdempotencyKey: confirmation.idempotencyKey,
            providerWrites: 0
        )
        await cache.failNextRetirementWrite(
            at: failurePoint,
            orderGlobalId: handoff.orderGlobalId
        )

        await #expect(throws: InjectedCacheError.retirementWrite) {
            try await initial.retireHandedOffOrder(
                handoff,
                evidence: evidence,
                replacementQueue: replacement
            )
        }
        #expect(try await cache.loadHandoffOutbox() == handoff)

        let restored = PickingSession(cache: cache)
        _ = try await restored.restore()
        try await restored.retireHandedOffOrder(
            handoff,
            evidence: evidence,
            replacementQueue: replacement
        )
        #expect(try await cache.loadHandoffOutbox() == nil)
        #expect(try await cache.loadOutbox() == nil)
        #expect(try await cache.loadQueue() == replacement)
    }
}

@Test("interrupted handoff retirement recovers a newer reassignment with fresh queue time")
func interruptedHandoffWithFreshReassignmentIsRecoverable() async throws {
    let cache = HandoffRetirementFailureCache()
    let initial = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await initial.replaceQueue(queue)
    let handoff = try await initial.persistPickHandoff(reason: "Manager help requested.")
    let evidence = try PickHandoffEvidence(
        command: handoff,
        orderGlobalId: handoff.orderGlobalId,
        orderStatus: "released",
        previousRowVersion: handoff.expectedRowVersion,
        rowVersion: handoff.expectedRowVersion + 1,
        exceptionGlobalId: "gex0000001",
        assignedTaskCount: handoff.expectedAssignedTaskCount,
        blockedConfirmationIdempotencyKey: nil,
        providerWrites: 0
    )
    let reassignedOrder = try PickOrder(
        orderGlobalId: queue.orders[0].orderGlobalId,
        orderNumber: queue.orders[0].orderNumber,
        rowVersion: evidence.rowVersion + 1,
        tasks: queue.orders[0].tasks
    )
    let firstReplacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(timeIntervalSince1970: 1_700_000_100),
        orders: [reassignedOrder]
    )
    await cache.failNextRetirementWrite(
        at: .clearHandoffOutbox,
        orderGlobalId: handoff.orderGlobalId
    )
    await #expect(throws: InjectedCacheError.retirementWrite) {
        try await initial.retireHandedOffOrder(
            handoff,
            evidence: evidence,
            replacementQueue: firstReplacement
        )
    }

    let freshReplacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(timeIntervalSince1970: 1_700_000_200),
        orders: [reassignedOrder]
    )
    let restored = PickingSession(cache: cache)
    _ = try await restored.restore()
    try await restored.retireHandedOffOrder(
        handoff,
        evidence: evidence,
        replacementQueue: freshReplacement
    )
    #expect(try await cache.loadHandoffOutbox() == nil)
    #expect(try await cache.loadQueue() == freshReplacement)
    #expect(await restored.currentOrder() == reassignedOrder)
}

@Test("manager reconciliation wins a blocked handoff race and remains crash recoverable")
func blockedHandoffExternalReconciliationRaceIsRecoverable() async throws {
    for failurePoint in [
        HandoffRetirementFailureCache.FailurePoint.clearProgress,
        HandoffRetirementFailureCache.FailurePoint.saveReplacementQueue,
        .clearConfirmationOutbox,
        .clearHandoffOutbox,
    ] {
        let cache = HandoffRetirementFailureCache()
        let initial = PickingSession(cache: cache)
        let queue = try fixtureQueue()
        try await initial.replaceQueue(queue)
        let confirmation = ConfirmPicksCommand(
            order: queue.orders[0],
            idempotencyKey: "reconciled-\(String(describing: failurePoint))"
        )
        try await cache.saveOutbox(confirmation)
        let handoff = try await initial.persistPickHandoff(
            reason: "Hand off unless manager reconciliation wins the race.",
            blockedConfirmation: confirmation
        )
        let replacement = try PickQueue(
            schemaVersion: 1,
            organizationId: queue.organizationId,
            workerEmail: queue.workerEmail,
            generatedAt: Date(),
            orders: []
        )
        let evidence = try ExternallyReconciledConfirmationEvidence(
            orderGlobalId: confirmation.orderGlobalId,
            expectedRowVersion: confirmation.expectedRowVersion,
            reconciliationGlobalId: "gsfr0000001",
            providerWrites: 0
        )
        await cache.failNextRetirementWrite(
            at: failurePoint,
            orderGlobalId: handoff.orderGlobalId
        )

        await #expect(throws: InjectedCacheError.retirementWrite) {
            try await initial.retireBlockedHandoffAfterExternalReconciliation(
                handoff,
                confirmation: confirmation,
                evidence: evidence,
                replacementQueue: replacement
            )
        }
        #expect(try await cache.loadHandoffOutbox() == handoff)

        let freshReplacement = try PickQueue(
            schemaVersion: replacement.schemaVersion,
            organizationId: replacement.organizationId,
            workerEmail: replacement.workerEmail,
            generatedAt: replacement.generatedAt.addingTimeInterval(1),
            orders: []
        )
        let restored = PickingSession(cache: cache)
        _ = try await restored.restore()
        try await restored.retireBlockedHandoffAfterExternalReconciliation(
            handoff,
            confirmation: try await cache.loadOutbox(),
            evidence: evidence,
            replacementQueue: freshReplacement
        )
        #expect(try await cache.loadHandoffOutbox() == nil)
        #expect(try await cache.loadOutbox() == nil)
        #expect(try await cache.loadQueue() == freshReplacement)
    }
}

@Test("external reconciliation rejects a stale queue that still contains the blocked order")
func blockedHandoffReconciliationRejectsMixedSnapshot() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let confirmation = ConfirmPicksCommand(
        order: queue.orders[0],
        idempotencyKey: "mixed-snapshot-confirmation"
    )
    try await cache.saveOutbox(confirmation)
    let handoff = try await session.persistPickHandoff(
        reason: "Manager should take over this blocked pick.",
        blockedConfirmation: confirmation
    )
    let evidence = try ExternallyReconciledConfirmationEvidence(
        orderGlobalId: confirmation.orderGlobalId,
        expectedRowVersion: confirmation.expectedRowVersion,
        reconciliationGlobalId: "gsfr0000004",
        providerWrites: 0
    )

    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.retireBlockedHandoffAfterExternalReconciliation(
            handoff,
            confirmation: confirmation,
            evidence: evidence,
            replacementQueue: queue
        )
    }
    #expect(try await cache.loadHandoffOutbox() == handoff)
    #expect(try await cache.loadOutbox() == confirmation)
    #expect(try await cache.loadQueue() == queue)
}

@Test("structured active handoff rejection retires only its exact outbox")
func rejectedActiveHandoffRetiresNoConfirmation() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let handoff = try await session.persistPickHandoff(reason: "Manager help requested.")
    let replacement = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(),
        orders: queue.orders
    )

    try await session.retireRejectedActivePickHandoff(
        handoff,
        replacementQueue: replacement
    )
    #expect(try await cache.loadHandoffOutbox() == nil)
    #expect(try await cache.loadOutbox() == nil)
    #expect(try await cache.loadQueue() == replacement)
}

@Test("external reconciliation retires only the exact durable confirmation")
func exactExternalReconciliationRetiresPendingConfirmation() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let order = try #require(queue.orders.first)
    let command = ConfirmPicksCommand(
        order: order,
        idempotencyKey: "exact-reconciliation"
    )
    try await cache.saveOutbox(command)
    let replacement = try PickQueue(
        schemaVersion: queue.schemaVersion,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(),
        orders: []
    )
    let evidence = try ExternallyReconciledConfirmationEvidence(
        orderGlobalId: order.orderGlobalId,
        expectedRowVersion: order.rowVersion,
        reconciliationGlobalId: "gsfr0000001",
        providerWrites: 0
    )

    try await session.retireExternallyReconciledConfirmation(
        command,
        evidence: evidence,
        replacementQueue: replacement
    )

    #expect(try await cache.loadOutbox() == nil)
    #expect(try await cache.loadProgress() == nil)
    #expect(try await cache.loadQueue() == replacement)
    #expect(await session.currentOrder() == nil)
}

@Test("external reconciliation cannot retire a mismatched outbox or active order")
func externalReconciliationRetirementFailsClosed() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let queue = try fixtureQueue()
    try await session.replaceQueue(queue)
    let order = try #require(queue.orders.first)
    let durable = ConfirmPicksCommand(order: order, idempotencyKey: "durable-command")
    let different = ConfirmPicksCommand(order: order, idempotencyKey: "different-command")
    try await cache.saveOutbox(durable)
    let evidence = try ExternallyReconciledConfirmationEvidence(
        orderGlobalId: order.orderGlobalId,
        expectedRowVersion: order.rowVersion,
        reconciliationGlobalId: "gsfr0000002",
        providerWrites: 0
    )
    let emptyReplacement = try PickQueue(
        schemaVersion: queue.schemaVersion,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(),
        orders: []
    )

    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.retireExternallyReconciledConfirmation(
            different,
            evidence: evidence,
            replacementQueue: emptyReplacement
        )
    }
    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.retireExternallyReconciledConfirmation(
            durable,
            evidence: evidence,
            replacementQueue: queue
        )
    }
    #expect(try await cache.loadOutbox() == durable)
    #expect(await session.currentOrder() == order)
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try ExternallyReconciledConfirmationEvidence(
            orderGlobalId: order.orderGlobalId,
            expectedRowVersion: order.rowVersion,
            reconciliationGlobalId: "gsfr0000003",
            providerWrites: 1
        )
    }
}

@Test("unreadable outbox cannot produce a pending confirmation context")
func unreadableOutboxFailsPendingContextClosed() async {
    let session = PickingSession(cache: OutboxReadFailureCache())
    let task = try! PickTask(
        pickTaskGlobalId: "gpk0000012", sequence: 1,
        productGlobalId: "gp0000012", productName: "Protected",
        channelSku: "PROTECTED", barcode: "12", locationCode: "A-12", quantity: 1
    )
    let order = try! PickOrder(
        orderGlobalId: "gor0000012", orderNumber: "1012", rowVersion: 12, tasks: [task]
    )
    let command = ConfirmPicksCommand(order: order)
    await #expect(throws: InjectedCacheError.retirementWrite) {
        _ = try await session.pendingConfirmationContext(for: command)
    }
}

@Test("interrupted external retirement remains blocked and recoverable")
func interruptedExternalReconciliationRetirementIsRecoverable() async throws {
    for failurePoint in [
        RetirementFailureCache.FailurePoint.clearProgress,
        .saveReplacementQueue,
        .clearOutbox,
    ] {
        let cache = RetirementFailureCache()
        let initialSession = PickingSession(cache: cache)
        let queue = try fixtureQueue()
        try await initialSession.replaceQueue(queue)
        let order = try #require(queue.orders.first)
        let command = ConfirmPicksCommand(
            order: order,
            idempotencyKey: "interrupted-\(String(describing: failurePoint))"
        )
        try await cache.saveOutbox(command)
        let replacement = try PickQueue(
            schemaVersion: queue.schemaVersion,
            organizationId: queue.organizationId,
            workerEmail: queue.workerEmail,
            generatedAt: Date(timeIntervalSince1970: 1_700_000_100),
            orders: []
        )
        let evidence = try ExternallyReconciledConfirmationEvidence(
            orderGlobalId: order.orderGlobalId,
            expectedRowVersion: order.rowVersion,
            reconciliationGlobalId: "gsfr0000004",
            providerWrites: 0
        )
        await cache.failNextRetirementWrite(
            at: failurePoint,
            pendingOrderGlobalId: order.orderGlobalId
        )

        await #expect(throws: InjectedCacheError.retirementWrite) {
            try await initialSession.retireExternallyReconciledConfirmation(
                command,
                evidence: evidence,
                replacementQueue: replacement
            )
        }
        #expect(try await cache.loadOutbox() == command)

        let restoredSession = PickingSession(cache: cache)
        _ = try await restoredSession.restore()
        try await restoredSession.retireExternallyReconciledConfirmation(
            command,
            evidence: evidence,
            replacementQueue: replacement
        )
        #expect(try await cache.loadOutbox() == nil)
        #expect(try await cache.loadProgress() == nil)
        #expect(try await cache.loadQueue() == replacement)
        #expect(await restoredSession.currentOrder() == nil)
    }
}

@Test("interrupted retirement recovers an exact pending order that was not first")
func interruptedNonFirstExternalRetirementIsRecoverable() async throws {
    let cache = RetirementFailureCache()
    let session = PickingSession(cache: cache)
    let firstQueue = try fixtureQueue()
    let secondTask = try PickTask(
        pickTaskGlobalId: "gpk0000011",
        sequence: 1,
        productGlobalId: "gp0000011",
        productName: "Second order item",
        channelSku: "SECOND-1",
        barcode: "111111111111",
        locationCode: "B-11",
        quantity: 1
    )
    let pendingOrder = try PickOrder(
        orderGlobalId: "gor0000011",
        orderNumber: "1011",
        rowVersion: 11,
        tasks: [secondTask]
    )
    let queue = try PickQueue(
        schemaVersion: firstQueue.schemaVersion,
        organizationId: firstQueue.organizationId,
        workerEmail: firstQueue.workerEmail,
        generatedAt: firstQueue.generatedAt,
        orders: firstQueue.orders + [pendingOrder]
    )
    try await session.replaceQueue(queue)
    let command = ConfirmPicksCommand(
        order: pendingOrder,
        idempotencyKey: "non-first-interrupted"
    )
    try await cache.saveOutbox(command)
    let replacement = try PickQueue(
        schemaVersion: queue.schemaVersion,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: Date(timeIntervalSince1970: 1_700_000_200),
        orders: firstQueue.orders
    )
    let evidence = try ExternallyReconciledConfirmationEvidence(
        orderGlobalId: pendingOrder.orderGlobalId,
        expectedRowVersion: pendingOrder.rowVersion,
        reconciliationGlobalId: "gsfr0000011",
        providerWrites: 0
    )
    await cache.failNextRetirementWrite(
        at: .saveReplacementQueue,
        pendingOrderGlobalId: pendingOrder.orderGlobalId
    )

    await #expect(throws: InjectedCacheError.retirementWrite) {
        try await session.retireExternallyReconciledConfirmation(
            command,
            evidence: evidence,
            replacementQueue: replacement
        )
    }
    #expect(try await cache.loadOutbox() == command)

    let restoredSession = PickingSession(cache: cache)
    _ = try await restoredSession.restore()
    #expect(await restoredSession.currentOrder() == firstQueue.orders.first)
    try await restoredSession.retireExternallyReconciledConfirmation(
        command,
        evidence: evidence,
        replacementQueue: replacement
    )
    #expect(try await cache.loadOutbox() == nil)
    #expect(try await cache.loadQueue() == replacement)
    #expect(await restoredSession.currentOrder() == firstQueue.orders.first)
}

private func locationFirstQueue(
    generatedAt: Date = Date(),
    orderRowVersion: Int = 3,
    productBarcode: String = "4006381333931",
    locationBarcode: String = "CP1L-GWL0000003",
    locationScanPolicyRowVersion: Int = 2
) throws -> PickQueue {
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000003",
        sequence: 1,
        productGlobalId: "gp0000003",
        productName: "Green Widget",
        channelSku: "GREEN-1",
        barcode: productBarcode,
        locationCode: "B-02-03",
        warehouseGlobalId: "gwh0000003",
        locationGlobalId: "gwl0000003",
        locationBarcode: locationBarcode,
        locationScanRequired: true,
        locationScanPolicyRowVersion: locationScanPolicyRowVersion,
        quantity: 3
    )
    return try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: generatedAt,
        orders: [try PickOrder(
            orderGlobalId: "gor0000002",
            orderNumber: "1002",
            rowVersion: orderRowVersion,
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

@Test("pick quantities must be positive whole JavaScript-safe integers")
func safeIntegerPickQuantity() throws {
    for invalid in [0, 0.5, 1.5, 9_007_199_254_740_992] {
        #expect(throws: PickingContractError.invalidTask) {
            _ = try PickTask(
                pickTaskGlobalId: "gpk0000009", sequence: 1,
                productGlobalId: "gp0000009", productName: "Invalid",
                channelSku: "INVALID", barcode: "123", locationCode: "A-1",
                quantity: invalid
            )
        }
    }
    let maximum = try PickTask(
        pickTaskGlobalId: "gpk0000010", sequence: 1,
        productGlobalId: "gp0000010", productName: "Maximum",
        channelSku: "MAX", barcode: "123", locationCode: "A-1",
        quantity: 9_007_199_254_740_991
    )
    #expect(maximum.quantity == 9_007_199_254_740_991)
}

@Test("multi-unit product scan waits for exact token-bound count")
func multiUnitExactCount() async throws {
    let session = PickingSession(cache: MemoryCache())
    try await session.replaceQueue(fixtureQueue())
    let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)
    _ = try await session.accept(BarcodeObservation(
        value: "012345678905",
        source: .metaGlasses,
        capturedAt: capturedAt
    ), now: capturedAt)

    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(await session.currentWorkflowStage() == .count)
    let context = try #require(await session.currentStageContext())
    await #expect(throws: PickingContractError.countMismatch(required: 2, entered: 1)) {
        _ = try await session.verifyCount(
            enteredCount: 1,
            source: .watch,
            contextToken: context.token,
            countedAt: capturedAt.addingTimeInterval(1)
        )
    }
    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
    _ = try await session.verifyCount(
        enteredCount: 2,
        source: .watch,
        contextToken: context.token,
        countedAt: capturedAt.addingTimeInterval(2)
    )
    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000002")

    await #expect(throws: PickingContractError.contextMismatch) {
        _ = try await session.verifyCount(
            enteredCount: 2,
            source: .watch,
            contextToken: context.token,
            countedAt: capturedAt.addingTimeInterval(3)
        )
    }
}

@Test("location match requires deliberate token-bound product arming")
func deliberateProductTransition() async throws {
    let session = PickingSession(cache: MemoryCache())
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await session.accept(BarcodeObservation(
        value: "CP1L-GWL0000003", source: .metaGlasses, capturedAt: now
    ), now: now)

    #expect(await session.currentWorkflowStage() == .productReady)
    await #expect(throws: PickingContractError.contextMismatch) {
        _ = try await session.accept(BarcodeObservation(
            value: "4006381333931", source: .metaGlasses, capturedAt: now
        ), now: now)
    }
    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.beginProductScan(contextToken: UUID().uuidString)
    }
    let context = try #require(await session.currentStageContext())
    try await session.beginProductScan(contextToken: context.token, now: now)
    #expect(await session.currentWorkflowStage() == .product)
    await #expect(throws: PickingContractError.contextMismatch) {
        try await session.beginProductScan(contextToken: context.token)
    }
}

@Test("failed progress write cannot accept a location")
func locationAcceptanceIsDurableBeforeVisible() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(locationFirstQueue(generatedAt: now))
    let before = try #require(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ))
    await cache.setProgressWriteFailure(true)

    await #expect(throws: InjectedCacheError.progressWrite) {
        _ = try await session.accept(BarcodeObservation(
            value: "CP1L-GWL0000003",
            source: .metaGlasses,
            capturedAt: now
        ), now: now)
    }

    #expect(await session.currentWorkflowStage() == .location)
    #expect(await session.currentScanStage() == .location)
    #expect(await session.currentStageContext() == nil)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ) == before)
    #expect(try await cache.loadProgress() == nil)
}

@Test("failed progress write cannot consume product-ready context")
func productArmingIsDurableBeforeVisible() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await session.accept(BarcodeObservation(
        value: "CP1L-GWL0000003",
        source: .metaGlasses,
        capturedAt: now
    ), now: now)
    let context = try #require(await session.currentStageContext())
    let before = try #require(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ))
    let durableBefore = try #require(try await cache.loadProgress())
    await cache.setProgressWriteFailure(true)

    await #expect(throws: InjectedCacheError.progressWrite) {
        try await session.beginProductScan(contextToken: context.token)
    }

    #expect(await session.currentWorkflowStage() == .productReady)
    #expect(await session.currentScanStage() == nil)
    #expect(await session.currentStageContext() == context)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ) == before)
    #expect(try await cache.loadProgress() == durableBefore)
}

@Test("failed progress write cannot accept a product")
func productAcceptanceIsDurableBeforeVisible() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(fixtureQueue())
    let before = try #require(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ))
    await cache.setProgressWriteFailure(true)

    await #expect(throws: InjectedCacheError.progressWrite) {
        _ = try await session.accept(BarcodeObservation(
            value: "012345678905",
            source: .iPhoneCamera,
            capturedAt: now
        ), now: now)
    }

    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(await session.currentWorkflowStage() == .product)
    #expect(await session.currentScanStage() == .product)
    #expect(await session.currentStageContext() == nil)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ) == before)
    #expect(try await cache.loadProgress() == nil)
}

@Test("failed progress write cannot verify a picked count")
func countVerificationIsDurableBeforeVisible() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(fixtureQueue())
    _ = try await session.accept(BarcodeObservation(
        value: "012345678905",
        source: .iPhoneCamera,
        capturedAt: now
    ), now: now)
    let context = try #require(await session.currentStageContext())
    let before = try #require(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ))
    let durableBefore = try #require(try await cache.loadProgress())
    await cache.setProgressWriteFailure(true)

    await #expect(throws: InjectedCacheError.progressWrite) {
        _ = try await session.verifyCount(
            enteredCount: 2,
            source: .watch,
            contextToken: context.token,
            countedAt: now.addingTimeInterval(1)
        )
    }

    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(await session.currentWorkflowStage() == .count)
    #expect(await session.currentScanStage() == nil)
    #expect(await session.currentStageContext() == context)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
        now: now
    ) == before)
    #expect(try await cache.loadProgress() == durableBefore)
}

@Test("overlapping workflow mutations fail closed while progress persistence is suspended")
func concurrentWorkflowMutationIsRejected() async throws {
    let cache = BlockingProgressCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(locationFirstQueue(generatedAt: now))
    await cache.blockNextProgressWrite()
    let first = Task {
        try await session.accept(BarcodeObservation(
            value: "CP1L-GWL0000003",
            source: .metaGlasses,
            capturedAt: now
        ), now: now)
    }
    await cache.waitUntilProgressWriteStarts()

    await #expect(throws: PickingContractError.persistenceInFlight) {
        _ = try await session.accept(BarcodeObservation(
            value: "CP1L-GWL0000003",
            source: .iPhoneCamera,
            capturedAt: now
        ), now: now)
    }
    await #expect(throws: PickingContractError.persistenceInFlight) {
        try await session.replaceQueue(locationFirstQueue(generatedAt: now.addingTimeInterval(1)))
    }
    #expect(await session.currentWorkflowStage() == .location)

    await cache.releaseProgressWrite()
    _ = try await first.value
    #expect(await session.currentWorkflowStage() == .productReady)
}

@Test("stale restored partial progress is cleared to a recoverable scan stage")
func stalePartialRestoreResetsForRescan() async throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)

    let locationCache = MemoryCache()
    let locationSession = PickingSession(cache: locationCache)
    try await locationSession.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await locationSession.accept(BarcodeObservation(
        value: "CP1L-GWL0000003",
        source: .metaGlasses,
        capturedAt: now
    ), now: now)
    let restoredLocation = PickingSession(cache: locationCache)
    _ = try await restoredLocation.restore(now: now.addingTimeInterval(30 * 60 + 1))
    #expect(await restoredLocation.currentWorkflowStage() == .location)
    #expect(await restoredLocation.currentStageContext() == nil)
    #expect(try await locationCache.loadProgress() == nil)

    let productCache = MemoryCache()
    let productSession = PickingSession(cache: productCache)
    try await productSession.replaceQueue(fixtureQueue())
    _ = try await productSession.accept(BarcodeObservation(
        value: "012345678905",
        source: .iPhoneCamera,
        capturedAt: now
    ), now: now)
    let restoredProduct = PickingSession(cache: productCache)
    _ = try await restoredProduct.restore(now: now.addingTimeInterval(30 * 60 + 1))
    #expect(await restoredProduct.currentWorkflowStage() == .product)
    #expect(await restoredProduct.currentStageContext() == nil)
    #expect(try await productCache.loadProgress() == nil)
}

@Test("stale live location or product context resets only the current task")
func staleLiveContextResetsCurrentTask() async throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)

    let locationSession = PickingSession(cache: MemoryCache())
    try await locationSession.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await locationSession.accept(BarcodeObservation(
        value: "CP1L-GWL0000003",
        source: .metaGlasses,
        capturedAt: now
    ), now: now)
    let locationContext = try #require(await locationSession.currentStageContext())
    await #expect(throws: PickingContractError.staleProgress) {
        try await locationSession.beginProductScan(
            contextToken: locationContext.token,
            now: now.addingTimeInterval(30 * 60 + 1)
        )
    }
    #expect(await locationSession.currentWorkflowStage() == .location)

    let productSession = PickingSession(cache: MemoryCache())
    try await productSession.replaceQueue(fixtureQueue())
    _ = try await productSession.accept(BarcodeObservation(
        value: "012345678905",
        source: .iPhoneCamera,
        capturedAt: now
    ), now: now)
    let countContext = try #require(await productSession.currentStageContext())
    await #expect(throws: PickingContractError.staleProgress) {
        _ = try await productSession.verifyCount(
            enteredCount: 2,
            source: .watch,
            contextToken: countContext.token,
            countedAt: now.addingTimeInterval(30 * 60 + 1)
        )
    }
    #expect(await productSession.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(await productSession.currentWorkflowStage() == .product)
}

@Test("expired evidence cannot create an outbox and resets for a full rescan")
func expiredConfirmationEvidenceIsRecoverable() async throws {
    let cache = MemoryCache()
    let session = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(fixtureQueue())
    _ = try await session.accept(BarcodeObservation(
        value: "012345678905", source: .metaGlasses, capturedAt: now
    ), now: now)
    let context = try #require(await session.currentStageContext())
    _ = try await session.verifyCount(
        enteredCount: 2,
        source: .iPhone,
        contextToken: context.token,
        countedAt: now.addingTimeInterval(1)
    )
    _ = try await session.accept(BarcodeObservation(
        value: "998877665544", source: .iPhoneCamera, capturedAt: now
    ), now: now)

    await #expect(throws: PickingContractError.staleProgress) {
        _ = try await session.persistConfirmation(
            now: now.addingTimeInterval(24 * 60 * 60 + 1)
        )
    }
    #expect(try await cache.loadOutbox() == nil)
    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(await session.currentWorkflowStage() == .product)
    #expect(try await cache.loadProgress()?.scannedTaskIDs.isEmpty == true)
}

@Test("durable progress restores an awaiting count without losing product evidence")
func durableCountProgressRestore() async throws {
    let cache = MemoryCache()
    let first = PickingSession(cache: cache)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    try await first.replaceQueue(fixtureQueue())
    _ = try await first.accept(BarcodeObservation(
        value: "012345678905", source: .iPhoneCamera, capturedAt: now
    ), now: now)
    let originalContext = try #require(await first.currentStageContext())

    let restored = PickingSession(cache: cache)
    _ = try await restored.restore(now: now.addingTimeInterval(1))
    #expect(await restored.currentWorkflowStage() == .count)
    #expect(await restored.currentStageContext()?.token == originalContext.token)
    _ = try await restored.verifyCount(
        enteredCount: 2,
        source: .iPhone,
        contextToken: originalContext.token,
        countedAt: now.addingTimeInterval(1)
    )
    #expect(await restored.currentTask()?.pickTaskGlobalId == "gpk0000002")
}

@Test("tampered durable progress cannot restore scan or count authority")
func tamperedProgressIsRejected() async throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let queue = try fixtureQueue()

    let unitTask = try PickTask(
        pickTaskGlobalId: "gpk0000011", sequence: 1,
        productGlobalId: "gp0000011", productName: "Single",
        channelSku: "SINGLE", barcode: "111", locationCode: "A-11", quantity: 1
    )
    let unitQueue = try PickQueue(
        schemaVersion: 1,
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        generatedAt: now,
        orders: [try PickOrder(
            orderGlobalId: "gor0000011", orderNumber: "1011", rowVersion: 1, tasks: [unitTask]
        )]
    )
    let missingProductCache = MemoryCache()
    try await missingProductCache.saveQueue(unitQueue)
    try await missingProductCache.saveProgress(PickSessionProgress(
        organizationId: unitQueue.organizationId,
        workerEmail: unitQueue.workerEmail,
        order: unitQueue.orders[0],
        scannedTaskIDs: [unitTask.pickTaskGlobalId],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: [:],
        countEvidence: [:],
        stageContextTokens: [:]
    ))
    let missingProductSession = PickingSession(cache: missingProductCache)
    _ = try await missingProductSession.restore()
    #expect(await missingProductSession.currentTask()?.pickTaskGlobalId == unitTask.pickTaskGlobalId)
    #expect(try await missingProductCache.loadProgress() == nil)

    let locationQueue = try locationFirstQueue(generatedAt: now)
    let wrongLocationCache = MemoryCache()
    try await wrongLocationCache.saveQueue(locationQueue)
    try await wrongLocationCache.saveProgress(PickSessionProgress(
        organizationId: locationQueue.organizationId,
        workerEmail: locationQueue.workerEmail,
        order: locationQueue.orders[0],
        scannedTaskIDs: [],
        locationVerifiedTaskIDs: ["gpk0000003"],
        productStartPendingTaskIDs: ["gpk0000003"],
        locationObservations: ["gpk0000003": try BarcodeObservation(
            value: "CP1L-GWL9999999", source: .metaGlasses, capturedAt: now
        )],
        productObservations: [:],
        countEvidence: [:],
        stageContextTokens: ["gpk0000003": UUID().uuidString.lowercased()]
    ))
    let wrongLocationSession = PickingSession(cache: wrongLocationCache)
    _ = try await wrongLocationSession.restore()
    #expect(await wrongLocationSession.currentWorkflowStage() == .location)
    #expect(try await wrongLocationCache.loadProgress() == nil)

    let wrongCountCache = MemoryCache()
    try await wrongCountCache.saveQueue(queue)
    let product = try BarcodeObservation(
        value: "012345678905", source: .iPhoneCamera, capturedAt: now
    )
    let mismatchedCountProduct = try BarcodeObservation(
        value: "wrong-product", source: .iPhoneCamera, capturedAt: now
    )
    let wrongCount = try PickTaskCountEvidence(
        task: queue.orders[0].tasks[0],
        enteredQuantity: 2,
        product: mismatchedCountProduct,
        countedAt: now.addingTimeInterval(1),
        countSource: .iPhone
    )
    try await wrongCountCache.saveProgress(PickSessionProgress(
        organizationId: queue.organizationId,
        workerEmail: queue.workerEmail,
        order: queue.orders[0],
        scannedTaskIDs: ["gpk0000001"],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: ["gpk0000001": product],
        countEvidence: ["gpk0000001": wrongCount],
        stageContextTokens: [:]
    ))
    let wrongCountSession = PickingSession(cache: wrongCountCache)
    _ = try await wrongCountSession.restore()
    #expect(await wrongCountSession.currentTask()?.pickTaskGlobalId == "gpk0000001")
    #expect(try await wrongCountCache.loadProgress() == nil)

    let strayTokenCache = MemoryCache()
    try await strayTokenCache.saveQueue(unitQueue)
    try await strayTokenCache.saveProgress(PickSessionProgress(
        organizationId: unitQueue.organizationId,
        workerEmail: unitQueue.workerEmail,
        order: unitQueue.orders[0],
        scannedTaskIDs: [],
        locationVerifiedTaskIDs: [],
        productStartPendingTaskIDs: [],
        locationObservations: [:],
        productObservations: [:],
        countEvidence: [:],
        stageContextTokens: [unitTask.pickTaskGlobalId: UUID().uuidString.lowercased()]
    ))
    let strayTokenSession = PickingSession(cache: strayTokenCache)
    _ = try await strayTokenSession.restore()
    #expect(await strayTokenSession.currentTask()?.pickTaskGlobalId == unitTask.pickTaskGlobalId)
    #expect(try await strayTokenCache.loadProgress() == nil)
}

@Test("count evidence timestamp must be strictly after its product scan")
func strictCountTimestamp() throws {
    let task = try fixtureQueue().orders[0].tasks[0]
    let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)
    let product = try BarcodeObservation(
        value: "012345678905", source: .iPhoneCamera, capturedAt: capturedAt
    )
    #expect(throws: PickingContractError.invalidCount) {
        _ = try PickTaskCountEvidence(
            task: task,
            enteredQuantity: 2,
            product: product,
            countedAt: capturedAt,
            countSource: .iPhone
        )
    }
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
    let firstCount = try #require(await session.currentStageContext())
    _ = try await session.verifyCount(
        enteredCount: 2,
        source: .watch,
        contextToken: firstCount.token,
        countedAt: now.addingTimeInterval(1)
    )
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
    #expect(first.countEvidenceIdempotencyKey?.hasPrefix("wearable-count:") == true)
    #expect(first.countEvidence?.first?.enteredQuantity == 2)
    #expect(first.countEvidence?.first?.countSource == .watch)
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
    #expect(await session.currentScanStage() == nil)
    #expect(await session.currentWorkflowStage() == .productReady)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com"
    )?.current?.locationScanRequired == false)

    let transition = try #require(await session.currentStageContext())
    try await session.beginProductScan(contextToken: transition.token)
    #expect(await session.currentScanStage() == .product)

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
    #expect(await session.currentWorkflowStage() == .count)
    let count = try #require(await session.currentStageContext())
    _ = try await session.verifyCount(
        enteredCount: 3,
        source: .iPhone,
        contextToken: count.token,
        countedAt: now.addingTimeInterval(1)
    )
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
    #expect(command.countEvidence?.first?.requiredQuantity == 3)
    #expect(command.countEvidence?.first?.enteredQuantity == 3)
    #expect(command.countEvidence?.first?.countSource == .iPhone)
}

@Test("refresh preserves exact current-order scan progress")
func exactQueueRefreshPreservesScanProgress() async throws {
    let session = PickingSession(cache: MemoryCache())
    let firstGeneratedAt = Date(timeIntervalSince1970: 1_700_000_000)
    try await session.replaceQueue(locationFirstQueue(generatedAt: firstGeneratedAt))

    _ = try await session.accept(BarcodeObservation(
        value: "CP1L-GWL0000003",
        source: .iPhoneCamera,
        capturedAt: firstGeneratedAt
    ), now: firstGeneratedAt)
    #expect(await session.currentWorkflowStage() == .productReady)

    try await session.replaceQueue(locationFirstQueue(
        generatedAt: firstGeneratedAt.addingTimeInterval(60)
    ))

    #expect(await session.currentTask()?.pickTaskGlobalId == "gpk0000003")
    #expect(await session.currentWorkflowStage() == .productReady)
    #expect(await session.makeWatchSnapshot(
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com"
    )?.current?.locationScanRequired == false)
}

@Test("refresh resets scan progress on any current-order authority drift")
func changedQueueRefreshResetsScanProgress() async throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)

    let rowVersionSession = PickingSession(cache: MemoryCache())
    try await rowVersionSession.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await rowVersionSession.accept(BarcodeObservation(
        value: "CP1L-GWL0000003", source: .iPhoneCamera, capturedAt: now
    ), now: now)
    try await rowVersionSession.replaceQueue(locationFirstQueue(
        generatedAt: now.addingTimeInterval(60),
        orderRowVersion: 4
    ))
    #expect(await rowVersionSession.currentScanStage() == .location)

    let policySession = PickingSession(cache: MemoryCache())
    try await policySession.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await policySession.accept(BarcodeObservation(
        value: "CP1L-GWL0000003", source: .iPhoneCamera, capturedAt: now
    ), now: now)
    try await policySession.replaceQueue(locationFirstQueue(
        generatedAt: now.addingTimeInterval(60),
        locationScanPolicyRowVersion: 3
    ))
    #expect(await policySession.currentScanStage() == .location)

    let barcodeSession = PickingSession(cache: MemoryCache())
    try await barcodeSession.replaceQueue(locationFirstQueue(generatedAt: now))
    _ = try await barcodeSession.accept(BarcodeObservation(
        value: "CP1L-GWL0000003", source: .iPhoneCamera, capturedAt: now
    ), now: now)
    try await barcodeSession.replaceQueue(locationFirstQueue(
        generatedAt: now.addingTimeInterval(60),
        productBarcode: "4006381333932"
    ))
    #expect(await barcodeSession.currentScanStage() == .location)
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
        authorizedOrganizationId: "11111111-1111-4111-8111-111111111111",
        authorizedWorkerEmail: "picker@example.com",
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

@Test("Watch instruction audio stays local unless reachable iPhone playback is requested")
func watchInstructionPlaybackRouting() {
    #expect(WatchInstructionPlaybackTarget.resolve(
        prefersPairedIPhone: false,
        pairedIPhoneIsReachable: true
    ) == .appleWatch)
    #expect(WatchInstructionPlaybackTarget.resolve(
        prefersPairedIPhone: true,
        pairedIPhoneIsReachable: false
    ) == .appleWatch)
    #expect(WatchInstructionPlaybackTarget.resolve(
        prefersPairedIPhone: true,
        pairedIPhoneIsReachable: true
    ) == .pairedIPhone)
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

@Test("Watch mutation commands require only their exact stage-bound fields")
func stageBoundWatchCommands() throws {
    let token = UUID().uuidString.lowercased()
    let begin = WatchPickCommand(
        id: "watch-begin-1",
        action: .beginProductScan,
        stageContextToken: token
    )
    #expect(begin.isValid)
    _ = try JSONEncoder().encode(begin)

    let count = WatchPickCommand(
        id: "watch-count-1",
        action: .submitCount,
        enteredCount: 4,
        stageContextToken: token
    )
    #expect(count.isValid)
    _ = try JSONEncoder().encode(count)

    let invalidCount = WatchPickCommand(
        id: "watch-count-invalid",
        action: .submitCount,
        enteredCount: 0,
        stageContextToken: token
    )
    #expect(!invalidCount.isValid)
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try JSONEncoder().encode(invalidCount)
    }

    let smuggledField = WatchPickCommand(
        id: "watch-refresh-invalid",
        action: .refreshQueue,
        enteredCount: 4,
        stageContextToken: token
    )
    #expect(!smuggledField.isValid)
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try JSONEncoder().encode(smuggledField)
    }
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
