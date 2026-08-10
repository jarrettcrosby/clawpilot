import Foundation

public struct PickTask: Codable, Equatable, Identifiable, Sendable {
    public let pickTaskGlobalId: String
    public let sequence: Int
    public let productGlobalId: String
    public let productName: String
    public let channelSku: String
    public let productImageURL: URL?
    public let barcode: String?
    public let locationCode: String
    public let quantity: Double

    public var id: String { pickTaskGlobalId }

    public init(
        pickTaskGlobalId: String,
        sequence: Int,
        productGlobalId: String,
        productName: String,
        channelSku: String,
        productImageURL: URL? = nil,
        barcode: String?,
        locationCode: String,
        quantity: Double
    ) throws {
        guard pickTaskGlobalId.range(of: #"^gpk(?:[0-9]{7}|[0-9a-v]{12})$"#, options: .regularExpression) != nil,
              sequence > 0,
              productGlobalId.range(of: #"^gp(?:[0-9]{7}|[0-9a-v]{12})$"#, options: .regularExpression) != nil,
              !productName.isEmpty,
              !channelSku.isEmpty,
              !locationCode.isEmpty,
              quantity > 0 else {
            throw PickingContractError.invalidTask
        }
        self.pickTaskGlobalId = pickTaskGlobalId
        self.sequence = sequence
        self.productGlobalId = productGlobalId
        self.productName = productName
        self.channelSku = channelSku
        self.productImageURL = productImageURL
        self.barcode = barcode
        self.locationCode = locationCode
        self.quantity = quantity
    }
}

public struct PickOrder: Codable, Equatable, Identifiable, Sendable {
    public let orderGlobalId: String
    public let orderNumber: String
    public let rowVersion: Int
    public let tasks: [PickTask]

    public var id: String { orderGlobalId }

    public init(
        orderGlobalId: String,
        orderNumber: String,
        rowVersion: Int,
        tasks: [PickTask]
    ) throws {
        guard orderGlobalId.range(of: #"^gor(?:[0-9]{7}|[0-9a-v]{12})$"#, options: .regularExpression) != nil,
              !orderNumber.isEmpty,
              rowVersion >= 0,
              !tasks.isEmpty,
              Set(tasks.map(\.pickTaskGlobalId)).count == tasks.count else {
            throw PickingContractError.invalidOrder
        }
        self.orderGlobalId = orderGlobalId
        self.orderNumber = orderNumber
        self.rowVersion = rowVersion
        self.tasks = tasks.sorted { ($0.sequence, $0.id) < ($1.sequence, $1.id) }
    }
}

public struct PickQueue: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let organizationId: String
    public let workerEmail: String
    public let generatedAt: Date
    public let orders: [PickOrder]

    public init(
        schemaVersion: Int,
        organizationId: String,
        workerEmail: String,
        generatedAt: Date,
        orders: [PickOrder]
    ) throws {
        guard schemaVersion == 1,
              UUID(uuidString: organizationId) != nil,
              workerEmail.contains("@"),
              Set(orders.map(\.orderGlobalId)).count == orders.count else {
            throw PickingContractError.invalidQueue
        }
        self.schemaVersion = schemaVersion
        self.organizationId = organizationId.lowercased()
        self.workerEmail = workerEmail.lowercased()
        self.generatedAt = generatedAt
        self.orders = orders
    }
}

public enum BarcodeSource: String, Codable, Equatable, Sendable {
    case metaGlasses = "meta_glasses"
    case iPhoneCamera = "iphone_camera"
}

public struct BarcodeObservation: Equatable, Sendable {
    public let value: String
    public let source: BarcodeSource
    public let capturedAt: Date

    public init(value: String, source: BarcodeSource, capturedAt: Date = Date()) throws {
        guard !value.isEmpty, value.utf8.count <= 512 else {
            throw PickingContractError.invalidBarcode
        }
        self.value = value
        self.source = source
        self.capturedAt = capturedAt
    }
}

public enum PickingContractError: Error, Equatable, Sendable {
    case invalidTask
    case invalidOrder
    case invalidQueue
    case invalidBarcode
    case missingBarcode
    case barcodeMismatch
    case staleQueue
    case incompleteOrder
    case contextMismatch
}

public enum BarcodeMatcher {
    public static func matches(observed: String, expected: String) -> Bool {
        if observed == expected { return true }
        // Apple Vision commonly reports UPC-A as EAN-13 with a leading zero.
        if observed.count == 13, observed.first == "0", String(observed.dropFirst()) == expected,
           observed.allSatisfy(\.isNumber), expected.allSatisfy(\.isNumber) {
            return true
        }
        if expected.count == 13, expected.first == "0", String(expected.dropFirst()) == observed,
           observed.allSatisfy(\.isNumber), expected.allSatisfy(\.isNumber) {
            return true
        }
        return false
    }
}

public struct WatchPickCard: Codable, Equatable, Sendable {
    public let productName: String
    public let channelSku: String?
    public let productImageURL: URL?
    public let locationCode: String
    public let quantity: Double
    public let progress: String
}

public struct WatchPickSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let orderNumber: String
    public let current: WatchPickCard?
    public let upcoming: [WatchPickCard]
    public let generatedAt: Date
    public let instructionLanguageCode: String?
    public let readInstructionOnPhone: Bool?
}

public enum WatchPickAction: String, Codable, Equatable, Sendable {
    case requestMetaScan = "request_meta_scan"
    case readInstruction = "read_instruction"
    case confirmPick = "confirm_pick"
    case refreshQueue = "refresh_queue"
}

public struct WatchPickCommand: Codable, Equatable, Sendable {
    public let id: String
    public let action: WatchPickAction

    public init(id: String = UUID().uuidString.lowercased(), action: WatchPickAction) {
        self.id = id
        self.action = action
    }
}

public struct ConfirmPicksCommand: Codable, Equatable, Sendable {
    public let action: String
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let reason: String
    public let idempotencyKey: String

    public init(order: PickOrder, idempotencyKey: String = UUID().uuidString.lowercased()) {
        action = "confirm-picks"
        orderGlobalId = order.orderGlobalId
        expectedRowVersion = order.rowVersion
        reason = "Voice-assisted wearable pick confirmation"
        self.idempotencyKey = "wearable-pick:\(idempotencyKey)"
    }

    private enum CodingKeys: String, CodingKey {
        case action, orderGlobalId, expectedRowVersion, reason, idempotencyKey
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let action = try values.decode(String.self, forKey: .action)
        guard action == "confirm-picks" else {
            throw PickingContractError.contextMismatch
        }
        self.action = action
        orderGlobalId = try values.decode(String.self, forKey: .orderGlobalId)
        expectedRowVersion = try values.decode(Int.self, forKey: .expectedRowVersion)
        reason = try values.decode(String.self, forKey: .reason)
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
    }
}
