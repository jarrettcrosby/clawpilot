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
    public let warehouseGlobalId: String?
    public let locationGlobalId: String?
    public let locationBarcode: String?
    public let locationScanRequired: Bool?
    public let locationScanPolicyRowVersion: Int?
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
        warehouseGlobalId: String? = nil,
        locationGlobalId: String? = nil,
        locationBarcode: String? = nil,
        locationScanRequired: Bool? = nil,
        locationScanPolicyRowVersion: Int? = nil,
        quantity: Double
    ) throws {
        guard pickTaskGlobalId.range(of: #"^gpk(?:[0-9]{7}|[0-9a-v]{12})$"#, options: .regularExpression) != nil,
              sequence > 0,
              productGlobalId.range(of: #"^gp(?:[0-9]{7}|[0-9a-v]{12})$"#, options: .regularExpression) != nil,
              !productName.isEmpty,
              !channelSku.isEmpty,
              !locationCode.isEmpty,
              locationScanRequired != true || (
                warehouseGlobalId?.range(
                    of: #"^gwh(?:[0-9]{7}|[0-9a-v]{12})$"#,
                    options: .regularExpression
                ) != nil
                && locationGlobalId?.range(
                    of: #"^gwl(?:[0-9]{7}|[0-9a-v]{12})$"#,
                    options: .regularExpression
                ) != nil
                && locationBarcode?.range(
                    of: #"^CP1L-GWL(?:[0-9]{7}|[0-9A-V]{12})$"#,
                    options: .regularExpression
                ) != nil
                && (locationScanPolicyRowVersion ?? 0) > 0
              ),
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
        self.warehouseGlobalId = warehouseGlobalId
        self.locationGlobalId = locationGlobalId
        self.locationBarcode = locationBarcode
        self.locationScanRequired = locationScanRequired
        self.locationScanPolicyRowVersion = locationScanPolicyRowVersion
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
    case metaGlasses = "meta"
    case iPhoneCamera = "iphone_camera"
}

public struct BarcodeObservation: Codable, Equatable, Sendable {
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

public struct PickScanObservationEvidence: Codable, Equatable, Sendable {
    public let barcode: String
    public let capturedAt: Date
    public let source: BarcodeSource

    public init(_ observation: BarcodeObservation) {
        barcode = observation.value
        capturedAt = observation.capturedAt
        source = observation.source
    }
}

public struct PickTaskScanEvidence: Codable, Equatable, Sendable {
    public let pickTaskGlobalId: String
    public let policyRowVersion: Int
    public let location: PickScanObservationEvidence
    public let product: PickScanObservationEvidence

    public init(
        task: PickTask,
        location: BarcodeObservation,
        product: BarcodeObservation
    ) throws {
        guard task.locationScanRequired == true,
              let policyRowVersion = task.locationScanPolicyRowVersion,
              policyRowVersion > 0 else {
            throw PickingContractError.contextMismatch
        }
        pickTaskGlobalId = task.pickTaskGlobalId
        self.policyRowVersion = policyRowVersion
        self.location = PickScanObservationEvidence(location)
        self.product = PickScanObservationEvidence(product)
    }
}

public enum PickingContractError: Error, Equatable, Sendable {
    case invalidTask
    case invalidOrder
    case invalidQueue
    case invalidBarcode
    case missingBarcode
    case barcodeMismatch
    case missingLocationBarcode
    case locationBarcodeMismatch
    case productBarcodeMismatch
    case staleQueue
    case incompleteOrder
    case contextMismatch
}

public enum PickScanStage: String, Codable, Equatable, Sendable {
    case location
    case product
}

public struct PickScanAcceptance: Equatable, Sendable {
    public let task: PickTask
    public let stage: PickScanStage

    public init(task: PickTask, stage: PickScanStage) {
        self.task = task
        self.stage = stage
    }
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
    public let locationBarcode: String?
    public let locationScanRequired: Bool?
    public let quantity: Double
    public let progress: String

    public init(
        productName: String,
        channelSku: String?,
        productImageURL: URL?,
        locationCode: String,
        locationBarcode: String? = nil,
        locationScanRequired: Bool? = nil,
        quantity: Double,
        progress: String
    ) {
        self.productName = productName
        self.channelSku = channelSku
        self.productImageURL = productImageURL
        self.locationCode = locationCode
        self.locationBarcode = locationBarcode
        self.locationScanRequired = locationScanRequired
        self.quantity = quantity
        self.progress = progress
    }
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

public struct WatchPickCommandResult: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let commandId: String
    public let action: WatchPickAction
    public let succeeded: Bool
    public let message: String
    public let completedAt: Date

    public init(
        command: WatchPickCommand,
        succeeded: Bool,
        message: String,
        completedAt: Date = Date()
    ) {
        schemaVersion = 1
        commandId = command.id
        action = command.action
        self.succeeded = succeeded
        self.message = String(message.prefix(240))
        self.completedAt = completedAt
    }
}

public enum WatchConnectivityPayloadBudget {
    // Keep current-state transfers below a conservative 60 KiB ceiling so
    // the snapshot, command result, keys, and a thumbnail all fit together.
    public static let maximumApplicationContextBytes = 60 * 1_024
    public static let maximumProductImageBytes = 40 * 1_024
    public static let reservedNonImageBytes = 16 * 1_024

    public static func fits(productImageBytes: Int, nonImageBytes: Int) -> Bool {
        productImageBytes >= 0
            && nonImageBytes >= 0
            && productImageBytes + nonImageBytes <= maximumApplicationContextBytes
    }
}

public struct ConfirmPicksCommand: Codable, Equatable, Sendable {
    public let action: String
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let reason: String
    public let idempotencyKey: String
    public let scanEvidenceIdempotencyKey: String?
    public let scanEvidence: [PickTaskScanEvidence]?

    public init(
        order: PickOrder,
        scanEvidence: [PickTaskScanEvidence] = [],
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) {
        action = "confirm-picks"
        orderGlobalId = order.orderGlobalId
        expectedRowVersion = order.rowVersion
        reason = "Voice-assisted wearable pick confirmation"
        self.idempotencyKey = "wearable-pick:\(idempotencyKey)"
        self.scanEvidenceIdempotencyKey = scanEvidence.isEmpty
            ? nil
            : "wearable-scan:\(idempotencyKey)"
        self.scanEvidence = scanEvidence.isEmpty ? nil : scanEvidence
    }

    private enum CodingKeys: String, CodingKey {
        case action, orderGlobalId, expectedRowVersion, reason, idempotencyKey
        case scanEvidenceIdempotencyKey, scanEvidence
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
        scanEvidenceIdempotencyKey = try values.decodeIfPresent(
            String.self,
            forKey: .scanEvidenceIdempotencyKey
        )
        scanEvidence = try values.decodeIfPresent(
            [PickTaskScanEvidence].self,
            forKey: .scanEvidence
        )
        guard (scanEvidenceIdempotencyKey == nil) == (scanEvidence == nil) else {
            throw PickingContractError.contextMismatch
        }
    }
}
