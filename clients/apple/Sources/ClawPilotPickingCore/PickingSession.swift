import Foundation

public protocol PickCache: Sendable {
    func loadQueue() async throws -> PickQueue?
    func saveQueue(_ queue: PickQueue) async throws
    func saveOutbox(_ command: ConfirmPicksCommand) async throws
    func loadOutbox() async throws -> ConfirmPicksCommand?
    func clearOutbox() async throws
}

public actor PickingSession {
    private let cache: any PickCache
    private var queue: PickQueue?
    private var orderIndex = 0
    private var scannedTaskIDs: Set<String> = []

    public init(cache: any PickCache) {
        self.cache = cache
    }

    public func restore() async throws -> PickQueue? {
        let restored = try await cache.loadQueue()
        queue = restored
        orderIndex = 0
        scannedTaskIDs = []
        return restored
    }

    public func replaceQueue(_ queue: PickQueue) async throws {
        try await cache.saveQueue(queue)
        self.queue = queue
        orderIndex = 0
        scannedTaskIDs = []
    }

    public func currentTask() -> PickTask? {
        guard let order = currentOrder() else { return nil }
        return order.tasks.first { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
    }

    public func currentOrder() -> PickOrder? {
        guard let queue, queue.orders.indices.contains(orderIndex) else { return nil }
        return queue.orders[orderIndex]
    }

    public func accept(_ observation: BarcodeObservation, now: Date = Date()) throws -> PickTask {
        guard now.timeIntervalSince(observation.capturedAt) <= 30 else {
            throw PickingContractError.staleQueue
        }
        guard let task = currentTask() else { throw PickingContractError.incompleteOrder }
        guard let expected = task.barcode else { throw PickingContractError.missingBarcode }
        guard BarcodeMatcher.matches(observed: observation.value, expected: expected) else {
            throw PickingContractError.barcodeMismatch
        }
        scannedTaskIDs.insert(task.pickTaskGlobalId)
        return task
    }

    public func makeWatchSnapshot(now: Date = Date()) -> WatchPickSnapshot? {
        guard let order = currentOrder() else { return nil }
        let remaining = order.tasks.filter { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
        func card(_ task: PickTask) -> WatchPickCard {
            WatchPickCard(
                productName: task.productName,
                locationCode: task.locationCode,
                quantity: task.quantity,
                progress: "\(scannedTaskIDs.count + 1) of \(order.tasks.count)"
            )
        }
        return WatchPickSnapshot(
            schemaVersion: 1,
            orderNumber: order.orderNumber,
            current: remaining.first.map(card),
            upcoming: remaining.dropFirst().prefix(2).map(card),
            generatedAt: now
        )
    }

    public func persistConfirmation() async throws -> ConfirmPicksCommand {
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
        let command = ConfirmPicksCommand(order: order)
        try await cache.saveOutbox(command)
        return command
    }

    public func finishConfirmedOrder() async throws {
        try await cache.clearOutbox()
        guard let queue else { return }
        orderIndex += 1
        scannedTaskIDs = []
        if orderIndex >= queue.orders.count {
            self.queue = nil
            orderIndex = 0
        }
    }
}

public enum PickVoice {
    public static func instruction(for task: PickTask) -> String {
        "Pick \(task.quantity.formatted()) of \(task.productName) from \(task.locationCode). Scan the product barcode."
    }

    public static func isConfirmation(_ transcript: String) -> Bool {
        let normalized = transcript
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ["confirm", "confirm pick", "complete order"].contains(normalized)
    }
}

