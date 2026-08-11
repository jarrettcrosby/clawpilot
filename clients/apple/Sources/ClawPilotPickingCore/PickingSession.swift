import Foundation

public protocol PickCache: Sendable {
    func loadQueue() async throws -> PickQueue?
    func saveQueue(_ queue: PickQueue) async throws
    func clearQueue() async throws
    func saveOutbox(_ command: ConfirmPicksCommand) async throws
    func loadOutbox() async throws -> ConfirmPicksCommand?
    func clearOutbox() async throws
}

public actor PickingSession {
    private let cache: any PickCache
    private var queue: PickQueue?
    private var orderIndex = 0
    private var scannedTaskIDs: Set<String> = []
    private var locationVerifiedTaskIDs: Set<String> = []
    private var locationObservations: [String: BarcodeObservation] = [:]
    private var productObservations: [String: BarcodeObservation] = [:]

    public init(cache: any PickCache) {
        self.cache = cache
    }

    public func restore() async throws -> PickQueue? {
        let restored = try await cache.loadQueue()
        queue = restored
        orderIndex = 0
        scannedTaskIDs = []
        locationVerifiedTaskIDs = []
        locationObservations = [:]
        productObservations = [:]
        return restored
    }

    public func replaceQueue(_ queue: PickQueue) async throws {
        try await cache.saveQueue(queue)
        self.queue = queue
        orderIndex = 0
        scannedTaskIDs = []
        locationVerifiedTaskIDs = []
        locationObservations = [:]
        productObservations = [:]
    }

    public func clearQueue() async throws {
        queue = nil
        orderIndex = 0
        scannedTaskIDs = []
        locationVerifiedTaskIDs = []
        locationObservations = [:]
        productObservations = [:]
        try await cache.clearQueue()
    }

    public func currentTask() -> PickTask? {
        guard let order = currentOrder() else { return nil }
        return order.tasks.first { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
    }

    public func currentOrder() -> PickOrder? {
        guard let queue, queue.orders.indices.contains(orderIndex) else { return nil }
        return queue.orders[orderIndex]
    }

    public func currentScanStage() -> PickScanStage? {
        guard let task = currentTask() else { return nil }
        if task.locationScanRequired == true,
           !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId) {
            return .location
        }
        return .product
    }

    public func accept(
        _ observation: BarcodeObservation,
        now: Date = Date()
    ) throws -> PickScanAcceptance {
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
            locationVerifiedTaskIDs.insert(task.pickTaskGlobalId)
            locationObservations[task.pickTaskGlobalId] = observation
            return PickScanAcceptance(task: task, stage: .location)
        }
        guard let expected = task.barcode else { throw PickingContractError.missingBarcode }
        guard BarcodeMatcher.matches(observed: observation.value, expected: expected) else {
            throw PickingContractError.productBarcodeMismatch
        }
        scannedTaskIDs.insert(task.pickTaskGlobalId)
        productObservations[task.pickTaskGlobalId] = observation
        return PickScanAcceptance(task: task, stage: .product)
    }

    public func makeWatchSnapshot(
        now: Date = Date(),
        instructionLanguageCode: String = "en",
        readInstructionOnPhone: Bool = false
    ) -> WatchPickSnapshot? {
        guard let order = currentOrder() else { return nil }
        let remaining = order.tasks.filter { !scannedTaskIDs.contains($0.pickTaskGlobalId) }
        func card(_ task: PickTask) -> WatchPickCard {
            let locationPending = task.locationScanRequired == true
                && !locationVerifiedTaskIDs.contains(task.pickTaskGlobalId)
            return WatchPickCard(
                productName: task.productName,
                channelSku: task.channelSku,
                productImageURL: task.productImageURL,
                locationCode: task.locationCode,
                locationBarcode: task.locationBarcode,
                locationScanRequired: locationPending,
                quantity: task.quantity,
                progress: "\(scannedTaskIDs.count + 1) of \(order.tasks.count)"
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
        let command = ConfirmPicksCommand(order: order, scanEvidence: scanEvidence)
        try await cache.saveOutbox(command)
        return command
    }

    public func finishConfirmedOrder() async throws {
        try await cache.clearOutbox()
        guard let queue else { return }
        orderIndex += 1
        scannedTaskIDs = []
        locationVerifiedTaskIDs = []
        locationObservations = [:]
        productObservations = [:]
        if orderIndex >= queue.orders.count {
            self.queue = nil
            orderIndex = 0
        }
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
