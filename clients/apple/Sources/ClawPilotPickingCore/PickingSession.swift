import Foundation

public protocol PickCache: Sendable {
    func loadQueue() async throws -> PickQueue?
    func saveQueue(_ queue: PickQueue) async throws
    func clearQueue() async throws
    func saveOutbox(_ command: ConfirmPicksCommand) async throws
    func loadOutbox() async throws -> ConfirmPicksCommand?
    func clearOutbox() async throws
    func saveHandoffOutbox(_ command: PickHandoffCommand) async throws
    func loadHandoffOutbox() async throws -> PickHandoffCommand?
    func clearHandoffOutbox() async throws
    func loadProgress() async throws -> PickSessionProgress?
    func saveProgress(_ progress: PickSessionProgress) async throws
    func clearProgress() async throws
}

public extension PickCache {
    func loadProgress() async throws -> PickSessionProgress? { nil }
    func saveProgress(_ progress: PickSessionProgress) async throws {}
    func clearProgress() async throws {}
    func saveHandoffOutbox(_: PickHandoffCommand) async throws {
        throw PickingContractError.contextMismatch
    }
    func loadHandoffOutbox() async throws -> PickHandoffCommand? { nil }
    func clearHandoffOutbox() async throws {}
}

public struct PickSessionProgress: Codable, Equatable, Sendable {
    public let organizationId: String
    public let workerEmail: String
    public let order: PickOrder
    public let scannedTaskIDs: Set<String>
    public let locationVerifiedTaskIDs: Set<String>
    public let productStartPendingTaskIDs: Set<String>
    public let locationObservations: [String: BarcodeObservation]
    public let productObservations: [String: BarcodeObservation]
    public let countEvidence: [String: PickTaskCountEvidence]
    public let stageContextTokens: [String: String]
}

public actor PickingSession {
    private static let locationToProductMaximumInterval: TimeInterval = 30 * 60
    private static let productToCountMaximumInterval: TimeInterval = 30 * 60
    private static let evidenceMaximumAge: TimeInterval = 24 * 60 * 60

    private struct WorkflowProgressState: Sendable {
        var scannedTaskIDs: Set<String>
        var locationVerifiedTaskIDs: Set<String>
        var locationObservations: [String: BarcodeObservation]
        var productObservations: [String: BarcodeObservation]
        var productStartPendingTaskIDs: Set<String>
        var countEvidence: [String: PickTaskCountEvidence]
        var stageContextTokens: [String: String]
    }

    private let cache: any PickCache
    private var queue: PickQueue?
    private var orderIndex = 0
    private var scannedTaskIDs: Set<String> = []
    private var locationVerifiedTaskIDs: Set<String> = []
    private var locationObservations: [String: BarcodeObservation] = [:]
    private var productObservations: [String: BarcodeObservation] = [:]
    private var productStartPendingTaskIDs: Set<String> = []
    private var countEvidence: [String: PickTaskCountEvidence] = [:]
    private var stageContextTokens: [String: String] = [:]
    private var workflowPersistenceInFlight = false

    public init(cache: any PickCache) {
        self.cache = cache
    }

    public func restore(now: Date = Date()) async throws -> PickQueue? {
        try requireNoWorkflowPersistence()
        let restored = try await cache.loadQueue()
        queue = restored
        resetProgress()
        if let restored,
           let progress = try await cache.loadProgress(),
           progress.organizationId == restored.organizationId,
           progress.workerEmail == restored.workerEmail,
           let restoredIndex = restored.orders.firstIndex(of: progress.order),
           progressStateIsValid(progress, now: now) {
            orderIndex = restoredIndex
            scannedTaskIDs = progress.scannedTaskIDs
            locationVerifiedTaskIDs = progress.locationVerifiedTaskIDs
            productStartPendingTaskIDs = progress.productStartPendingTaskIDs
            locationObservations = progress.locationObservations
            productObservations = progress.productObservations
            countEvidence = progress.countEvidence
            stageContextTokens = progress.stageContextTokens
        } else {
            try await cache.clearProgress()
        }
        return restored
    }

    public func replaceQueue(_ queue: PickQueue) async throws {
        try requireNoWorkflowPersistence()
        try await cache.saveQueue(queue)
        let previousQueue = self.queue
        let previousOrder = currentOrder()
        self.queue = queue

        // A refresh or Picker navigation must not erase an already-verified
        // location or product when the server returned the exact same work.
        // Preserve progress only across the narrow, fail-closed identity fence:
        // same organization, worker, and complete current order contract. Any
        // row version, task, policy, location, or barcode drift resets progress.
        if let previousQueue,
           let previousOrder,
           previousQueue.organizationId == queue.organizationId,
           previousQueue.workerEmail == queue.workerEmail,
           let refreshedIndex = queue.orders.firstIndex(of: previousOrder) {
            orderIndex = refreshedIndex
            try await persistProgress()
            return
        }

        resetProgress()
        try await cache.clearProgress()
    }

    public func clearQueue() async throws {
        try requireNoWorkflowPersistence()
        queue = nil
        resetProgress()
        try await cache.clearQueue()
        try await cache.clearProgress()
    }

    public func currentTask() -> PickTask? {
        guard let order = currentOrder() else { return nil }
        return order.tasks.first { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
    }

    public func currentOrder() -> PickOrder? {
        guard let queue, queue.orders.indices.contains(orderIndex) else { return nil }
        return queue.orders[orderIndex]
    }

    public func queueIdentityMatches(
        organizationId: String,
        workerEmail: String
    ) -> Bool {
        guard let queue else { return false }
        return queue.organizationId == organizationId.lowercased()
            && queue.workerEmail == workerEmail.lowercased()
    }

    public func currentScanStage() -> PickScanStage? {
        guard let task = currentTask() else { return nil }
        if task.locationScanRequired == true,
           !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId) {
            return .location
        }
        if productStartPendingTaskIDs.contains(task.pickTaskGlobalId)
            || productObservations[task.pickTaskGlobalId] != nil {
            return nil
        }
        return .product
    }

    public func currentWorkflowStage() -> PickWorkflowStage? {
        guard let task = currentTask() else { return nil }
        if task.locationScanRequired == true,
           !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId) {
            return .location
        }
        if productStartPendingTaskIDs.contains(task.pickTaskGlobalId) {
            return .productReady
        }
        if productObservations[task.pickTaskGlobalId] != nil {
            return .count
        }
        return .product
    }

    public func currentStageContext() -> PickStageContext? {
        guard let task = currentTask(),
              let stage = currentWorkflowStage(),
              stage == .productReady || stage == .count,
              let token = stageContextTokens[task.pickTaskGlobalId] else { return nil }
        return try? PickStageContext(
            pickTaskGlobalId: task.pickTaskGlobalId,
            stage: stage,
            token: token,
            requiredQuantity: Int(task.quantity)
        )
    }

    public func beginProductScan(
        contextToken: String,
        now: Date = Date()
    ) async throws {
        try requireNoWorkflowPersistence()
        guard let task = currentTask(),
              currentWorkflowStage() == .productReady,
              stageContextTokens[task.pickTaskGlobalId] == contextToken.lowercased() else {
            throw PickingContractError.contextMismatch
        }
        guard let location = locationObservations[task.pickTaskGlobalId],
              now.timeIntervalSince(location.capturedAt) >= 0,
              now.timeIntervalSince(location.capturedAt) <= Self.locationToProductMaximumInterval else {
            try await resetCurrentTaskProgress()
            throw PickingContractError.staleProgress
        }
        var candidate = workflowProgressState()
        candidate.productStartPendingTaskIDs.remove(task.pickTaskGlobalId)
        candidate.stageContextTokens.removeValue(forKey: task.pickTaskGlobalId)
        try await commitWorkflowProgress(candidate)
    }

    public func accept(
        _ observation: BarcodeObservation,
        now: Date = Date()
    ) async throws -> PickScanAcceptance {
        try requireNoWorkflowPersistence()
        guard now.timeIntervalSince(observation.capturedAt) <= 30 else {
            throw PickingContractError.staleQueue
        }
        guard let task = currentTask() else { throw PickingContractError.incompleteOrder }
        if task.locationScanRequired == true,
           !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId) {
            guard let expected = task.locationBarcode else {
                throw PickingContractError.missingLocationBarcode
            }
            guard observation.value == expected else {
                throw PickingContractError.locationBarcodeMismatch
            }
            var candidate = workflowProgressState()
            candidate.locationVerifiedTaskIDs.insert(task.pickTaskGlobalId)
            candidate.locationObservations[task.pickTaskGlobalId] = observation
            candidate.productStartPendingTaskIDs.insert(task.pickTaskGlobalId)
            candidate.stageContextTokens[task.pickTaskGlobalId] = UUID().uuidString.lowercased()
            try await commitWorkflowProgress(candidate)
            return PickScanAcceptance(task: task, stage: .location)
        }
        guard !productStartPendingTaskIDs.contains(task.pickTaskGlobalId),
              productObservations[task.pickTaskGlobalId] == nil else {
            throw PickingContractError.contextMismatch
        }
        guard let expected = task.barcode else { throw PickingContractError.missingBarcode }
        if task.locationScanRequired == true {
            guard let location = locationObservations[task.pickTaskGlobalId],
                  observation.capturedAt.timeIntervalSince(location.capturedAt) >= 0,
                  observation.capturedAt.timeIntervalSince(location.capturedAt)
                    <= Self.locationToProductMaximumInterval else {
                try await resetCurrentTaskProgress()
                throw PickingContractError.staleProgress
            }
        }
        guard BarcodeMatcher.matches(observed: observation.value, expected: expected) else {
            throw PickingContractError.productBarcodeMismatch
        }
        var candidate = workflowProgressState()
        candidate.productObservations[task.pickTaskGlobalId] = observation
        if task.quantity > 1 {
            candidate.stageContextTokens[task.pickTaskGlobalId] = UUID().uuidString.lowercased()
        } else {
            candidate.scannedTaskIDs.insert(task.pickTaskGlobalId)
        }
        try await commitWorkflowProgress(candidate)
        return PickScanAcceptance(task: task, stage: .product)
    }

    public func verifyCount(
        enteredCount: Int,
        source: PickCountSource,
        contextToken: String,
        countedAt: Date = Date()
    ) async throws -> PickTaskCountEvidence {
        try requireNoWorkflowPersistence()
        guard let task = currentTask(),
              currentWorkflowStage() == .count,
              stageContextTokens[task.pickTaskGlobalId] == contextToken.lowercased(),
              let product = productObservations[task.pickTaskGlobalId] else {
            throw PickingContractError.contextMismatch
        }
        guard countedAt.timeIntervalSince(product.capturedAt) > 0,
              countedAt.timeIntervalSince(product.capturedAt)
                <= Self.productToCountMaximumInterval else {
            try await resetCurrentTaskProgress()
            throw PickingContractError.staleProgress
        }
        let required = Int(task.quantity)
        guard enteredCount > 0 else { throw PickingContractError.invalidCount }
        guard enteredCount == required else {
            throw PickingContractError.countMismatch(required: required, entered: enteredCount)
        }
        let effectiveCountedAt = countedAt > product.capturedAt
            ? countedAt
            : product.capturedAt.addingTimeInterval(0.001)
        let evidence = try PickTaskCountEvidence(
            task: task,
            enteredQuantity: enteredCount,
            product: product,
            countedAt: effectiveCountedAt,
            countSource: source
        )
        var candidate = workflowProgressState()
        candidate.countEvidence[task.pickTaskGlobalId] = evidence
        candidate.scannedTaskIDs.insert(task.pickTaskGlobalId)
        candidate.stageContextTokens.removeValue(forKey: task.pickTaskGlobalId)
        try await commitWorkflowProgress(candidate)
        return evidence
    }

    public func makeWatchSnapshot(
        authorizedOrganizationId: String,
        authorizedWorkerEmail: String,
        now: Date = Date(),
        instructionLanguageCode: String = "en",
        readInstructionOnPhone: Bool = false
    ) -> WatchPickSnapshot? {
        guard queueIdentityMatches(
            organizationId: authorizedOrganizationId,
            workerEmail: authorizedWorkerEmail
        ) else { return nil }
        guard let order = currentOrder() else { return nil }
        let remaining = order.tasks.filter { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
        func card(_ task: PickTask) -> WatchPickCard {
            let locationPending = task.locationScanRequired == true
                && !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId)
            let workflowStage: PickWorkflowStage
            if locationPending {
                workflowStage = .location
            } else if productStartPendingTaskIDs.contains(task.pickTaskGlobalId) {
                workflowStage = .productReady
            } else if productObservations[task.pickTaskGlobalId] != nil {
                workflowStage = .count
            } else {
                workflowStage = .product
            }
            return WatchPickCard(
                productName: task.productName,
                channelSku: task.channelSku,
                productImageURL: task.productImageURL,
                locationCode: task.locationCode,
                locationBarcode: task.locationBarcode,
                locationScanRequired: locationPending,
                quantity: task.quantity,
                progress: "\(scannedTaskIDs.count + 1) of \(order.tasks.count)",
                workflowStage: workflowStage,
                stageContextToken: stageContextTokens[task.pickTaskGlobalId]
            )
        }
        return WatchPickSnapshot(
            schemaVersion: 1,
            orderNumber: order.orderNumber,
            current: remaining.first.map(card),
            upcoming: remaining.dropFirst().prefix(2).map(card),
            generatedAt: now,
            instructionLanguageCode: instructionLanguageCode,
            readInstructionOnPhone: readInstructionOnPhone
        )
    }

    public func persistConfirmation(now: Date = Date()) async throws -> ConfirmPicksCommand {
        try requireNoWorkflowPersistence()
        guard let order = currentOrder(),
              scannedTaskIDs.count == order.tasks.count else {
            throw PickingContractError.incompleteOrder
        }
        if let existing = try await cache.loadOutbox() {
            guard existing.orderGlobalId == order.orderGlobalId,
                  existing.expectedRowVersion == order.rowVersion else {
                throw PickingContractError.contextMismatch
            }
            return existing
        }
        let observations = order.tasks.compactMap { productObservations[$0.pickTaskGlobalId] }
            + order.tasks.compactMap { locationObservations[$0.pickTaskGlobalId] }
        guard observations.allSatisfy({
            now.timeIntervalSince($0.capturedAt) >= 0
                && now.timeIntervalSince($0.capturedAt) <= Self.evidenceMaximumAge
        }), order.tasks.allSatisfy({ task in
            let id = task.pickTaskGlobalId
            if task.locationScanRequired == true {
                guard let location = locationObservations[id],
                      let product = productObservations[id],
                      product.capturedAt.timeIntervalSince(location.capturedAt) >= 0,
                      product.capturedAt.timeIntervalSince(location.capturedAt)
                        <= Self.locationToProductMaximumInterval else { return false }
            }
            if task.quantity > 1 {
                guard let product = productObservations[id],
                      let count = countEvidence[id],
                      count.countedAt.timeIntervalSince(product.capturedAt) > 0,
                      count.countedAt.timeIntervalSince(product.capturedAt)
                        <= Self.productToCountMaximumInterval else { return false }
            }
            return true
        }) else {
            try await resetAllWorkflowProgress()
            throw PickingContractError.staleProgress
        }
        let scanEvidence: [PickTaskScanEvidence] = try order.tasks.compactMap { task in
            guard task.locationScanRequired == true else { return nil }
            guard let location = locationObservations[task.pickTaskGlobalId],
                  let product = productObservations[task.pickTaskGlobalId] else {
                throw PickingContractError.incompleteOrder
            }
            return try PickTaskScanEvidence(
                task: task,
                location: location,
                product: product
            )
        }
        let multiQuantityEvidence: [PickTaskCountEvidence] = try order.tasks.compactMap { task in
            guard task.quantity > 1 else { return nil }
            guard let evidence = countEvidence[task.pickTaskGlobalId] else {
                throw PickingContractError.incompleteOrder
            }
            return evidence
        }
        let command = ConfirmPicksCommand(
            order: order,
            scanEvidence: scanEvidence,
            countEvidence: multiQuantityEvidence
        )
        try await cache.saveOutbox(command)
        return command
    }

    public func finishConfirmedOrder(_ command: ConfirmPicksCommand) async throws {
        try requireNoWorkflowPersistence()
        workflowPersistenceInFlight = true
        defer { workflowPersistenceInFlight = false }
        guard let currentQueue = queue,
              try await cache.loadOutbox() == command else {
            throw PickingContractError.contextMismatch
        }
        let matchingOrders = currentQueue.orders.filter {
            $0.orderGlobalId == command.orderGlobalId
        }
        guard matchingOrders.count <= 1 else {
            throw PickingContractError.contextMismatch
        }
        let exactOrderIsPresent = matchingOrders.first?.rowVersion
            == command.expectedRowVersion
        let exactCurrentOrderIndex = currentQueue.orders.firstIndex(where: {
            $0.orderGlobalId == command.orderGlobalId
                && $0.rowVersion == command.expectedRowVersion
        })
        let durableQueue = try await cache.loadQueue()
        let durableProgress = try await cache.loadProgress()
        if let durableProgress {
            guard durableProgress.order.orderGlobalId == command.orderGlobalId,
                  durableProgress.order.rowVersion == command.expectedRowVersion else {
                throw PickingContractError.contextMismatch
            }
        }
        let recoveringInterruptedRetirement = matchingOrders.isEmpty
            && durableQueue == currentQueue
            && durableProgress == nil
        guard (exactOrderIsPresent
                && exactCurrentOrderIndex == orderIndex)
                || recoveringInterruptedRetirement else {
            throw PickingContractError.contextMismatch
        }
        let remainingOrders = exactCurrentOrderIndex.map {
            Array(currentQueue.orders.dropFirst($0 + 1))
        } ?? currentQueue.orders
        let replacementQueue = try PickQueue(
            schemaVersion: currentQueue.schemaVersion,
            organizationId: currentQueue.organizationId,
            workerEmail: currentQueue.workerEmail,
            generatedAt: currentQueue.generatedAt,
            orders: remainingOrders
        )

        // The successful exact idempotent server response is the authority.
        // Retire by order identity, persist the replacement queue, and clear
        // the exact outbox last. A replay after any interrupted write can only
        // finish this same command and can never advance a second order.
        try await cache.clearProgress()
        try await cache.saveQueue(replacementQueue)
        try await cache.clearOutbox()
        queue = replacementQueue
        resetProgress()
    }

    public func pendingConfirmationContext(
        for command: ConfirmPicksCommand
    ) async throws -> PendingConfirmationContext {
        let durableCommand = try await cache.loadOutbox()
        guard let queue,
              let durableCommand,
              durableCommand == command else {
            throw PickingContractError.contextMismatch
        }
        let matchingOrders = queue.orders.filter {
            $0.orderGlobalId == command.orderGlobalId
        }
        guard matchingOrders.count <= 1,
              matchingOrders.first.map({
                  $0.rowVersion == command.expectedRowVersion
              }) != false else {
            throw PickingContractError.contextMismatch
        }
        let durableQueue = try await cache.loadQueue()
        let durableProgress = try await cache.loadProgress()
        let interruptedExactRetirement = matchingOrders.isEmpty
            && durableQueue == queue
            && durableProgress == nil
        return PendingConfirmationContext(
            organizationId: queue.organizationId,
            workerEmail: queue.workerEmail,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            containsExactOrder: matchingOrders.count == 1,
            allowsExactReplay: matchingOrders.count == 1
                || interruptedExactRetirement
        )
    }

    public func retireExternallyReconciledConfirmation(
        _ command: ConfirmPicksCommand,
        evidence: ExternallyReconciledConfirmationEvidence,
        replacementQueue: PickQueue
    ) async throws {
        try requireNoWorkflowPersistence()
        guard let currentQueue = queue,
              let durableCommand = try await cache.loadOutbox(),
              durableCommand == command,
              evidence.orderGlobalId == command.orderGlobalId,
              evidence.expectedRowVersion == command.expectedRowVersion,
              currentQueue.organizationId == replacementQueue.organizationId,
              currentQueue.workerEmail == replacementQueue.workerEmail,
              !replacementQueue.orders.contains(where: {
                  $0.orderGlobalId == command.orderGlobalId
              }) else {
            throw PickingContractError.contextMismatch
        }

        let currentOrderMatches = currentOrder().map {
            $0.orderGlobalId == command.orderGlobalId
                && $0.rowVersion == command.expectedRowVersion
        } == true
        let durableProgress = try await cache.loadProgress()
        let durableQueue = try await cache.loadQueue()
        let recoveringBeforeReplacementQueue = durableProgress == nil
            && durableQueue == currentQueue
            && currentQueue.orders.contains(where: {
                $0.orderGlobalId == command.orderGlobalId
                    && $0.rowVersion == command.expectedRowVersion
            })
        let recoveringInterruptedRetirement: Bool
        if let durableQueue,
           durableProgress == nil,
           durableQueue == currentQueue,
           !durableQueue.orders.contains(where: {
               $0.orderGlobalId == command.orderGlobalId
           }) {
            recoveringInterruptedRetirement = true
        } else {
            recoveringInterruptedRetirement = false
        }
        guard currentOrderMatches
                || recoveringBeforeReplacementQueue
                || recoveringInterruptedRetirement else {
            throw PickingContractError.contextMismatch
        }

        // Clear progress first, then install the authoritative replacement
        // queue, and retire the exact outbox last. Failures before the queue
        // write leave the old order plus its self-contained outbox recoverable.
        // A crash after the queue write leaves a detectable partial state:
        // replacement queue, no progress, and the exact outbox. The same
        // immutable server evidence can safely finish only that retirement on
        // restart. A missing queue row alone is never authority.
        try await cache.clearProgress()
        try await cache.saveQueue(replacementQueue)
        try await cache.clearOutbox()
        queue = replacementQueue
        resetProgress()
    }

    public func canRequestActivePickHandoff() -> Bool {
        !workflowPersistenceInFlight
            && currentOrder() != nil
            && localPickingProgressIsEmpty()
    }

    public func persistPickHandoff(
        reason: String,
        blockedConfirmation: ConfirmPicksCommand? = nil
    ) async throws -> PickHandoffCommand {
        try requireNoWorkflowPersistence()
        workflowPersistenceInFlight = true
        defer { workflowPersistenceInFlight = false }
        guard let queue,
              let order = currentOrder() else {
            throw PickingContractError.contextMismatch
        }
        if let existing = try await cache.loadHandoffOutbox() {
            guard existing.organizationId == queue.organizationId,
                  existing.workerEmail == queue.workerEmail,
                  existing.orderGlobalId == order.orderGlobalId,
                  existing.expectedRowVersion == order.rowVersion,
                  existing.expectedAssignedTaskCount == order.tasks.count,
                  existing.blockedConfirmationIdempotencyKey
                    == blockedConfirmation?.idempotencyKey else {
                throw PickingContractError.contextMismatch
            }
            return existing
        }

        let durableConfirmation = try await cache.loadOutbox()
        if let blockedConfirmation {
            guard durableConfirmation == blockedConfirmation,
                  blockedConfirmation.orderGlobalId == order.orderGlobalId,
                  blockedConfirmation.expectedRowVersion == order.rowVersion else {
                throw PickingContractError.contextMismatch
            }
        } else {
            guard durableConfirmation == nil,
                  localPickingProgressIsEmpty(),
                  try await cache.loadProgress() == nil else {
                throw PickingContractError.contextMismatch
            }
        }

        let command = try PickHandoffCommand(
            queue: queue,
            order: order,
            reason: reason,
            blockedConfirmationIdempotencyKey: blockedConfirmation?.idempotencyKey
        )
        try await cache.saveHandoffOutbox(command)
        return command
    }

    public func pendingPickHandoffContext(
        for command: PickHandoffCommand
    ) async throws -> PendingConfirmationContext {
        guard let queue,
              try await cache.loadHandoffOutbox() == command,
              queue.organizationId == command.organizationId,
              queue.workerEmail == command.workerEmail else {
            throw PickingContractError.contextMismatch
        }
        let matchingOrders = queue.orders.filter {
            $0.orderGlobalId == command.orderGlobalId
        }
        guard matchingOrders.count <= 1 else {
            throw PickingContractError.contextMismatch
        }
        let containsExactOrder = matchingOrders.first.map {
            $0.rowVersion == command.expectedRowVersion
                && $0.tasks.count == command.expectedAssignedTaskCount
        } == true
        return PendingConfirmationContext(
            organizationId: command.organizationId,
            workerEmail: command.workerEmail,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            containsExactOrder: containsExactOrder,
            allowsExactReplay: containsExactOrder
        )
    }

    public func retireHandedOffOrder(
        _ command: PickHandoffCommand,
        evidence: PickHandoffEvidence,
        replacementQueue: PickQueue
    ) async throws {
        try requireNoWorkflowPersistence()
        guard let currentQueue = queue,
              try await cache.loadHandoffOutbox() == command,
              evidence.orderGlobalId == command.orderGlobalId,
              evidence.previousRowVersion == command.expectedRowVersion,
              currentQueue.organizationId == command.organizationId,
              currentQueue.workerEmail == command.workerEmail,
              replacementQueue.organizationId == command.organizationId,
              replacementQueue.workerEmail == command.workerEmail else {
            throw PickingContractError.contextMismatch
        }
        let replacementMatches = replacementQueue.orders.filter {
            $0.orderGlobalId == command.orderGlobalId
        }
        guard replacementMatches.count <= 1,
              replacementMatches.first.map({
                  $0.rowVersion > evidence.rowVersion
              }) != false else {
            throw PickingContractError.contextMismatch
        }

        let durableQueue = try await cache.loadQueue()
        let durableProgress = try await cache.loadProgress()
        let exactOrderIsPresent = currentQueue.orders.contains(where: {
            $0.orderGlobalId == command.orderGlobalId
                && $0.rowVersion == command.expectedRowVersion
                && $0.tasks.count == command.expectedAssignedTaskCount
        })
        let recoveringInterruptedRetirement = durableProgress == nil
            && durableQueue == currentQueue
            && currentQueue.orders.filter({
                $0.orderGlobalId == command.orderGlobalId
            }).count <= 1
            && currentQueue.orders.first(where: {
                $0.orderGlobalId == command.orderGlobalId
            }).map({ $0.rowVersion > evidence.rowVersion }) != false
        guard exactOrderIsPresent || recoveringInterruptedRetirement else {
            throw PickingContractError.contextMismatch
        }

        let durableConfirmation = try await cache.loadOutbox()
        if let blockedKey = command.blockedConfirmationIdempotencyKey {
            guard durableConfirmation?.idempotencyKey == blockedKey
                    || (recoveringInterruptedRetirement && durableConfirmation == nil) else {
                throw PickingContractError.contextMismatch
            }
        } else {
            guard durableConfirmation == nil,
                  recoveringInterruptedRetirement || localPickingProgressIsEmpty() else {
                throw PickingContractError.contextMismatch
            }
        }

        // The handoff receipt is the authority; queue omission alone is never
        // sufficient. Install the exact replacement queue before clearing either
        // outbox. The handoff outbox is last so a crash can replay the same POST
        // and complete any interrupted local retirement without a new command.
        try await cache.clearProgress()
        try await cache.saveQueue(replacementQueue)
        if durableConfirmation != nil {
            try await cache.clearOutbox()
        }
        try await cache.clearHandoffOutbox()
        queue = replacementQueue
        resetProgress()
    }

    public func retireRejectedActivePickHandoff(
        _ command: PickHandoffCommand,
        replacementQueue: PickQueue
    ) async throws {
        try requireNoWorkflowPersistence()
        guard command.blockedConfirmationIdempotencyKey == nil,
              try await cache.loadHandoffOutbox() == command,
              try await cache.loadOutbox() == nil,
              let currentQueue = queue,
              currentQueue.organizationId == command.organizationId,
              currentQueue.workerEmail == command.workerEmail,
              replacementQueue.organizationId == command.organizationId,
              replacementQueue.workerEmail == command.workerEmail,
              localPickingProgressIsEmpty(),
              try await cache.loadProgress() == nil else {
            throw PickingContractError.contextMismatch
        }

        // A structured server rejection proves this command did not commit.
        // Refresh the signed worker's authoritative queue, then retire only
        // this active-handoff outbox last. No confirmation record is touched.
        try await cache.saveQueue(replacementQueue)
        try await cache.clearHandoffOutbox()
        queue = replacementQueue
        resetProgress()
    }

    public func retireBlockedHandoffAfterExternalReconciliation(
        _ handoff: PickHandoffCommand,
        confirmation: ConfirmPicksCommand?,
        evidence: ExternallyReconciledConfirmationEvidence,
        replacementQueue: PickQueue
    ) async throws {
        try requireNoWorkflowPersistence()
        guard let blockedConfirmationKey = handoff.blockedConfirmationIdempotencyKey,
              confirmation.map({
                  $0.idempotencyKey == blockedConfirmationKey
                    && $0.orderGlobalId == handoff.orderGlobalId
                    && $0.expectedRowVersion == handoff.expectedRowVersion
              }) != false,
              try await cache.loadHandoffOutbox() == handoff,
              evidence.orderGlobalId == handoff.orderGlobalId,
              evidence.expectedRowVersion == handoff.expectedRowVersion,
              let currentQueue = queue,
              currentQueue.organizationId == handoff.organizationId,
              currentQueue.workerEmail == handoff.workerEmail,
              replacementQueue.organizationId == handoff.organizationId,
              replacementQueue.workerEmail == handoff.workerEmail else {
            throw PickingContractError.contextMismatch
        }
        let replacementMatches = replacementQueue.orders.filter {
            $0.orderGlobalId == handoff.orderGlobalId
        }
        // A reconciliation receipt says the blocked order was externally
        // completed/cancelled. The independently fetched queue must therefore
        // exclude that exact order; accepting a stale mixed-snapshot queue
        // would reinstall work that the receipt proves is no longer pickable.
        guard replacementMatches.isEmpty else {
            throw PickingContractError.contextMismatch
        }

        let durableQueue = try await cache.loadQueue()
        let durableProgress = try await cache.loadProgress()
        let durableConfirmation = try await cache.loadOutbox()
        let exactOrderIsPresent = currentQueue.orders.contains(where: {
            $0.orderGlobalId == handoff.orderGlobalId
                && $0.rowVersion == handoff.expectedRowVersion
                && $0.tasks.count == handoff.expectedAssignedTaskCount
        })
        let recoveringInterruptedRetirement = durableProgress == nil
            && durableQueue == currentQueue
            && !currentQueue.orders.contains(where: {
                $0.orderGlobalId == handoff.orderGlobalId
            })
        guard exactOrderIsPresent || recoveringInterruptedRetirement else {
            throw PickingContractError.contextMismatch
        }
        if let durableConfirmation {
            guard durableConfirmation.idempotencyKey == blockedConfirmationKey,
                  durableConfirmation.orderGlobalId == handoff.orderGlobalId,
                  durableConfirmation.expectedRowVersion == handoff.expectedRowVersion,
                  confirmation == durableConfirmation else {
                throw PickingContractError.contextMismatch
            }
        } else {
            guard recoveringInterruptedRetirement, confirmation == nil else {
                throw PickingContractError.contextMismatch
            }
        }

        // The external reconciliation proof, not queue omission, is authority.
        // Keep the handoff outbox until the queue and matching confirmation have
        // both retired so a crash always resumes this higher-priority command.
        try await cache.clearProgress()
        try await cache.saveQueue(replacementQueue)
        if durableConfirmation != nil {
            try await cache.clearOutbox()
        }
        try await cache.clearHandoffOutbox()
        queue = replacementQueue
        resetProgress()
    }

    public func retireRejectedBlockedPickHandoff(
        _ handoff: PickHandoffCommand,
        confirmation: ConfirmPicksCommand
    ) async throws {
        try requireNoWorkflowPersistence()
        guard handoff.blockedConfirmationIdempotencyKey == confirmation.idempotencyKey,
              handoff.orderGlobalId == confirmation.orderGlobalId,
              handoff.expectedRowVersion == confirmation.expectedRowVersion,
              try await cache.loadHandoffOutbox() == handoff,
              try await cache.loadOutbox() == confirmation,
              let currentQueue = queue,
              currentQueue.organizationId == handoff.organizationId,
              currentQueue.workerEmail == handoff.workerEmail,
              currentQueue.orders.contains(where: {
                  $0.orderGlobalId == handoff.orderGlobalId
                    && $0.rowVersion == handoff.expectedRowVersion
              }) else {
            throw PickingContractError.contextMismatch
        }
        // A deterministic handoff rejection did not mutate server state. Retire
        // only the exact handoff request; the original terminal confirmation is
        // still authoritative and remains protected for manager reconciliation.
        try await cache.clearHandoffOutbox()
    }

    private func resetProgress() {
        orderIndex = 0
        scannedTaskIDs = []
        locationVerifiedTaskIDs = []
        locationObservations = [:]
        productObservations = [:]
        productStartPendingTaskIDs = []
        countEvidence = [:]
        stageContextTokens = [:]
    }

    private func localPickingProgressIsEmpty() -> Bool {
        scannedTaskIDs.isEmpty
            && locationVerifiedTaskIDs.isEmpty
            && locationObservations.isEmpty
            && productObservations.isEmpty
            && productStartPendingTaskIDs.isEmpty
            && countEvidence.isEmpty
            && stageContextTokens.isEmpty
    }

    private func progressStateIsValid(
        _ progress: PickSessionProgress,
        now: Date
    ) -> Bool {
        let tasks = progress.order.tasks
        let taskIDs = Set(tasks.map(\.pickTaskGlobalId))
        let allStateIDs = progress.scannedTaskIDs
            .union(progress.locationVerifiedTaskIDs)
            .union(progress.productStartPendingTaskIDs)
            .union(progress.locationObservations.keys)
            .union(progress.productObservations.keys)
            .union(progress.countEvidence.keys)
            .union(progress.stageContextTokens.keys)
        guard allStateIDs.isSubset(of: taskIDs) else { return false }

        let scannedPrefix = Array(tasks.prefix { task in
            progress.scannedTaskIDs.contains(task.pickTaskGlobalId)
        })
        guard Set(scannedPrefix.map(\.pickTaskGlobalId)) == progress.scannedTaskIDs else {
            return false
        }

        for task in tasks {
            let id = task.pickTaskGlobalId
            let scanned = progress.scannedTaskIDs.contains(id)
            let locationVerified = progress.locationVerifiedTaskIDs.contains(id)
            let productReady = progress.productStartPendingTaskIDs.contains(id)
            let location = progress.locationObservations[id]
            let product = progress.productObservations[id]
            let count = progress.countEvidence[id]
            let token = progress.stageContextTokens[id]

            if task.locationScanRequired == true {
                guard locationVerified == (location != nil) else { return false }
                if let location {
                    guard location.value == task.locationBarcode else { return false }
                }
                if scanned || productReady || product != nil {
                    guard locationVerified else { return false }
                }
            } else if locationVerified || location != nil || productReady {
                return false
            }

            if let product {
                guard let barcode = task.barcode,
                      BarcodeMatcher.matches(observed: product.value, expected: barcode) else {
                    return false
                }
            }

            if productReady, let location {
                guard now.timeIntervalSince(location.capturedAt) >= 0,
                      now.timeIntervalSince(location.capturedAt)
                        <= Self.locationToProductMaximumInterval else { return false }
            }
            if !scanned, product != nil {
                guard let product,
                      now.timeIntervalSince(product.capturedAt) >= 0,
                      now.timeIntervalSince(product.capturedAt)
                        <= Self.productToCountMaximumInterval else { return false }
            }
            if scanned {
                if let location {
                    guard now.timeIntervalSince(location.capturedAt) >= 0,
                          now.timeIntervalSince(location.capturedAt) <= Self.evidenceMaximumAge else {
                        return false
                    }
                }
                if let product {
                    guard now.timeIntervalSince(product.capturedAt) >= 0,
                          now.timeIntervalSince(product.capturedAt) <= Self.evidenceMaximumAge else {
                        return false
                    }
                }
            }

            if scanned {
                guard product != nil, !productReady, token == nil else { return false }
                if let location, let product {
                    guard product.capturedAt.timeIntervalSince(location.capturedAt) >= 0,
                          product.capturedAt.timeIntervalSince(location.capturedAt)
                            <= Self.locationToProductMaximumInterval else { return false }
                }
                if task.quantity > 1 {
                    guard let count, let product,
                          count.pickTaskGlobalId == id,
                          count.requiredQuantity == Int(task.quantity),
                          count.enteredQuantity == Int(task.quantity),
                          count.product == PickScanObservationEvidence(product),
                          count.countedAt > product.capturedAt,
                          count.countedAt.timeIntervalSince(product.capturedAt)
                            <= Self.productToCountMaximumInterval else { return false }
                } else if count != nil {
                    return false
                }
                continue
            }

            guard count == nil else { return false }
            if productReady {
                guard product == nil,
                      token.flatMap(UUID.init(uuidString:)) != nil else { return false }
            } else if product != nil {
                guard task.quantity > 1,
                      token.flatMap(UUID.init(uuidString:)) != nil else { return false }
            } else if token != nil {
                return false
            }
        }

        let currentIndex = scannedPrefix.count
        for task in tasks.dropFirst(currentIndex + 1) {
            let id = task.pickTaskGlobalId
            guard !allStateIDs.contains(id) else { return false }
        }
        return true
    }

    private func workflowProgressState() -> WorkflowProgressState {
        WorkflowProgressState(
            scannedTaskIDs: scannedTaskIDs,
            locationVerifiedTaskIDs: locationVerifiedTaskIDs,
            locationObservations: locationObservations,
            productObservations: productObservations,
            productStartPendingTaskIDs: productStartPendingTaskIDs,
            countEvidence: countEvidence,
            stageContextTokens: stageContextTokens
        )
    }

    private func applyWorkflowProgress(_ state: WorkflowProgressState) {
        scannedTaskIDs = state.scannedTaskIDs
        locationVerifiedTaskIDs = state.locationVerifiedTaskIDs
        locationObservations = state.locationObservations
        productObservations = state.productObservations
        productStartPendingTaskIDs = state.productStartPendingTaskIDs
        countEvidence = state.countEvidence
        stageContextTokens = state.stageContextTokens
    }

    private func commitWorkflowProgress(_ candidate: WorkflowProgressState) async throws {
        // Keep observable actor state on the last durable snapshot until the
        // candidate has been written. A failed cache write therefore cannot
        // advance the phone/Watch projection or consume a stage token.
        try requireNoWorkflowPersistence()
        workflowPersistenceInFlight = true
        defer { workflowPersistenceInFlight = false }
        try await persistProgress(candidate)
        applyWorkflowProgress(candidate)
    }

    private func requireNoWorkflowPersistence() throws {
        guard !workflowPersistenceInFlight else {
            throw PickingContractError.persistenceInFlight
        }
    }

    private func resetCurrentTaskProgress() async throws {
        guard let task = currentTask() else { return }
        var candidate = workflowProgressState()
        let id = task.pickTaskGlobalId
        candidate.scannedTaskIDs.remove(id)
        candidate.locationVerifiedTaskIDs.remove(id)
        candidate.locationObservations.removeValue(forKey: id)
        candidate.productObservations.removeValue(forKey: id)
        candidate.productStartPendingTaskIDs.remove(id)
        candidate.countEvidence.removeValue(forKey: id)
        candidate.stageContextTokens.removeValue(forKey: id)
        try await commitWorkflowProgress(candidate)
    }

    private func resetAllWorkflowProgress() async throws {
        var candidate = workflowProgressState()
        candidate.scannedTaskIDs = []
        candidate.locationVerifiedTaskIDs = []
        candidate.locationObservations = [:]
        candidate.productObservations = [:]
        candidate.productStartPendingTaskIDs = []
        candidate.countEvidence = [:]
        candidate.stageContextTokens = [:]
        try await commitWorkflowProgress(candidate)
    }

    private func persistProgress(_ state: WorkflowProgressState? = nil) async throws {
        guard let queue, let order = currentOrder() else {
            try await cache.clearProgress()
            return
        }
        let state = state ?? workflowProgressState()
        try await cache.saveProgress(PickSessionProgress(
            organizationId: queue.organizationId,
            workerEmail: queue.workerEmail,
            order: order,
            scannedTaskIDs: state.scannedTaskIDs,
            locationVerifiedTaskIDs: state.locationVerifiedTaskIDs,
            productStartPendingTaskIDs: state.productStartPendingTaskIDs,
            locationObservations: state.locationObservations,
            productObservations: state.productObservations,
            countEvidence: state.countEvidence,
            stageContextTokens: state.stageContextTokens
        ))
    }
}

public enum PickVoice {
    public enum Action: Equatable, Sendable {
        case startMetaScan
        case stopMetaScan
        case readInstruction
        case confirmPick
    }

    public static func instruction(for task: PickTask, languageCode: String = "en") -> String {
        instruction(
            productName: task.productName,
            locationCode: task.locationCode,
            quantity: task.quantity,
            locationScanRequired: false,
            languageCode: languageCode
        )
    }

    public static func instruction(
        for task: PickTask,
        locationScanRequired: Bool,
        languageCode: String = "en"
    ) -> String {
        instruction(
            productName: task.productName,
            locationCode: task.locationCode,
            quantity: task.quantity,
            locationScanRequired: locationScanRequired,
            languageCode: languageCode
        )
    }

    public static func instruction(
        productName: String,
        locationCode: String,
        quantity: Double,
        locationScanRequired: Bool = false,
        languageCode: String = "en"
    ) -> String {
        let location = spokenLocationCode(locationCode, languageCode: languageCode)
        let product = spokenProductName(productName, languageCode: languageCode)
        if locationScanRequired {
            if languageCode == "es" {
                return "Ve a la ubicación \(location). Escanea la etiqueta de ubicación antes del producto."
            }
            return "Go to location \(location). Scan the location label before the product."
        }
        if languageCode == "es" {
            return "Recoge \(quantity.formatted()) de \(product) en la ubicación \(location). Escanea el código de barras del producto."
        }
        return "Pick \(quantity.formatted()) of \(product) from location \(location). Scan the product barcode."
    }

    public static func spokenProductName(
        _ name: String,
        languageCode: String = "en"
    ) -> String {
        let product = name.components(separatedBy: " · ").first ?? name
        let units = languageCode == "es"
            ? [(#"(?i)(\d+(?:\.\d+)?)\s*lb\b"#, "$1 libras"),
               (#"(?i)(\d+(?:\.\d+)?)\s*oz\b"#, "$1 onzas")]
            : [(#"(?i)(\d+(?:\.\d+)?)\s*lb\b"#, "$1 pounds"),
               (#"(?i)(\d+(?:\.\d+)?)\s*oz\b"#, "$1 ounces")]
        return units.reduce(product) { result, replacement in
            result.replacingOccurrences(
                of: replacement.0,
                with: replacement.1,
                options: .regularExpression
            )
        }
    }

    public static func spokenLocationCode(
        _ code: String,
        languageCode: String = "en"
    ) -> String {
        var runs: [(text: String, isNumber: Bool)] = []
        var current = ""
        var currentIsNumber: Bool?
        func flush() {
            guard !current.isEmpty, let isNumber = currentIsNumber else { return }
            runs.append((current, isNumber))
            current = ""
            currentIsNumber = nil
        }
        for character in code {
            guard character.isLetter || character.isNumber else {
                flush()
                continue
            }
            let isNumber = character.isNumber
            if let currentIsNumber, currentIsNumber != isNumber { flush() }
            current.append(character)
            currentIsNumber = isNumber
        }
        flush()

        let digitWords = languageCode == "es"
            ? ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"]
            : ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
        let spoken = runs.flatMap { run -> [String] in
            if run.isNumber {
                return run.text.compactMap { character in
                    character.wholeNumberValue.map { digitWords[$0] }
                }
            }
            return [run.text.count == 1 ? run.text.uppercased() : run.text.lowercased()]
        }
        return spoken.isEmpty ? code : spoken.joined(separator: " ")
    }

    public static func action(for transcript: String) -> Action? {
        let normalized = transcript
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        switch normalized {
        case "start glasses scan", "scan with glasses", "start meta scan", "scan barcode",
             "iniciar escaneo", "escanear con gafas", "escanear código", "escanear código de barras":
            return .startMetaScan
        case "stop glasses scan", "stop meta scan", "stop scan",
             "detener escaneo", "parar escaneo":
            return .stopMetaScan
        case "read instruction", "repeat instruction", "what is my pick",
             "leer instrucción", "repetir instrucción", "cuál es mi tarea":
            return .readInstruction
        case "confirm", "confirm pick", "confirmed pick", "confirm picks", "complete order",
             "confirmar", "confirmar selección", "confirmar pedido", "completar pedido":
            return .confirmPick
        default:
            return nil
        }
    }

    public static func isConfirmation(_ transcript: String) -> Bool {
        action(for: transcript) == .confirmPick
    }
}
