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
    public let warehouseCode: String?
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
        warehouseCode: String? = nil,
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
              warehouseCode.map({ !$0.isEmpty && $0.count <= 80 }) ?? true,
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
              quantity >= 1,
              quantity <= 9_007_199_254_740_991,
              quantity.rounded(.towardZero) == quantity else {
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
        self.warehouseCode = warehouseCode
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

public enum PickCountSource: String, Codable, Equatable, Sendable {
    case iPhone = "iphone"
    case watch = "watch"
}

public struct PickTaskCountEvidence: Codable, Equatable, Sendable {
    public let pickTaskGlobalId: String
    public let requiredQuantity: Int
    public let enteredQuantity: Int
    public let product: PickScanObservationEvidence
    public let countedAt: Date
    public let countSource: PickCountSource

    public init(
        task: PickTask,
        enteredQuantity: Int,
        product: BarcodeObservation,
        countedAt: Date,
        countSource: PickCountSource
    ) throws {
        let requiredQuantity = Int(task.quantity)
        guard requiredQuantity > 1,
              enteredQuantity == requiredQuantity,
              countedAt > product.capturedAt else {
            throw PickingContractError.invalidCount
        }
        pickTaskGlobalId = task.pickTaskGlobalId
        self.requiredQuantity = requiredQuantity
        self.enteredQuantity = enteredQuantity
        self.product = PickScanObservationEvidence(product)
        self.countedAt = countedAt
        self.countSource = countSource
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
    case invalidCount
    case countMismatch(required: Int, entered: Int)
    case staleQueue
    case persistenceInFlight
    case staleProgress
    case incompleteOrder
    case contextMismatch
}

public enum PickScanStage: String, Codable, Equatable, Sendable {
    case location
    case product
}

public enum PickWorkflowStage: String, Codable, Equatable, Sendable {
    case location
    case productReady = "product_ready"
    case product
    case count
}

public struct PickStageContext: Codable, Equatable, Identifiable, Sendable {
    public let pickTaskGlobalId: String
    public let stage: PickWorkflowStage
    public let token: String
    public let requiredQuantity: Int

    public var id: String { token }

    public init(
        pickTaskGlobalId: String,
        stage: PickWorkflowStage,
        token: String,
        requiredQuantity: Int
    ) throws {
        guard pickTaskGlobalId.range(
            of: #"^gpk(?:[0-9]{7}|[0-9a-v]{12})$"#,
            options: .regularExpression
        ) != nil,
        stage == .productReady || stage == .count,
        UUID(uuidString: token) != nil,
        requiredQuantity > 0 else {
            throw PickingContractError.contextMismatch
        }
        self.pickTaskGlobalId = pickTaskGlobalId
        self.stage = stage
        self.token = token.lowercased()
        self.requiredQuantity = requiredQuantity
    }
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
    public let workflowStage: PickWorkflowStage?
    public let stageContextToken: String?

    public init(
        productName: String,
        channelSku: String?,
        productImageURL: URL?,
        locationCode: String,
        locationBarcode: String? = nil,
        locationScanRequired: Bool? = nil,
        quantity: Double,
        progress: String,
        workflowStage: PickWorkflowStage? = nil,
        stageContextToken: String? = nil
    ) {
        self.productName = productName
        self.channelSku = channelSku
        self.productImageURL = productImageURL
        self.locationCode = locationCode
        self.locationBarcode = locationBarcode
        self.locationScanRequired = locationScanRequired
        self.quantity = quantity
        self.progress = progress
        self.workflowStage = workflowStage
        self.stageContextToken = stageContextToken
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

public enum WatchInstructionPlaybackTarget: Equatable, Sendable {
    case appleWatch
    case pairedIPhone

    public static func resolve(
        prefersPairedIPhone: Bool,
        pairedIPhoneIsReachable: Bool
    ) -> Self {
        prefersPairedIPhone && pairedIPhoneIsReachable
            ? .pairedIPhone
            : .appleWatch
    }
}

public enum WatchInstructionPhonePlaybackPolicy {
    public static func isEligible(
        metaConnectedDeviceCount: Int,
        enhancedVoiceReady: Bool
    ) -> Bool {
        metaConnectedDeviceCount == 1 && enhancedVoiceReady
    }
}

/// Keeps a Watch-local timeout from racing a late iPhone audio start.
///
/// A Watch request gives the iPhone forty seconds to establish playback, while
/// the Watch retains its existing forty-five-second command timeout. The phone
/// also refuses any audio start at or after that boundary, so the five-second
/// gap is reserved for returning failure and beginning local Watch speech. A missing
/// deadline remains valid for commands produced by an older Watch build, but
/// current Watch builds always include one.
public enum WatchInstructionPlaybackTiming {
    public static let watchFallbackDelay: TimeInterval = 45
    public static let latePlaybackSafetyMargin: TimeInterval = 5
    public static let phonePlaybackStartWindow =
        watchFallbackDelay - latePlaybackSafetyMargin

    public static func phonePlaybackStartDeadline(now: Date = Date()) -> Date {
        now.addingTimeInterval(phonePlaybackStartWindow)
    }

    public static func effectivePhonePlaybackStartDeadline(
        for command: WatchPickCommand,
        receivedAt: Date = Date()
    ) -> Date? {
        guard command.action == .readInstruction else { return nil }
        let localMaximum = phonePlaybackStartDeadline(now: receivedAt)
        guard let requested = command.phonePlaybackStartDeadline else {
            // Keep commands from an older Watch build bounded after decoding.
            return localMaximum
        }
        return min(requested, localMaximum)
    }

    public static func permitsPhonePlaybackStart(
        for command: WatchPickCommand,
        now: Date = Date()
    ) -> Bool {
        guard command.action == .readInstruction else { return true }
        let deadline = command.phonePlaybackStartDeadline
            ?? phonePlaybackStartDeadline(now: now)
        return now < deadline
    }

    public static func acceptsAcknowledgedPhonePlaybackStart(
        startedAt: Date?,
        deadline: Date
    ) -> Bool {
        guard let startedAt else { return false }
        return startedAt < deadline
    }
}

public enum WatchPickAction: String, Codable, Equatable, Sendable {
    case requestMetaScan = "request_meta_scan"
    case readInstruction = "read_instruction"
    case confirmPick = "confirm_pick"
    case refreshQueue = "refresh_queue"
    case beginProductScan = "begin_product_scan"
    case submitCount = "submit_count"
}

public struct WatchPickCommand: Codable, Equatable, Sendable {
    public let id: String
    public let action: WatchPickAction
    public let enteredCount: Int?
    public let stageContextToken: String?
    public let phonePlaybackStartDeadline: Date?

    public init(
        id: String = UUID().uuidString.lowercased(),
        action: WatchPickAction,
        enteredCount: Int? = nil,
        stageContextToken: String? = nil,
        phonePlaybackStartDeadline: Date? = nil
    ) {
        self.id = id
        self.action = action
        self.enteredCount = enteredCount
        self.stageContextToken = stageContextToken
        self.phonePlaybackStartDeadline = phonePlaybackStartDeadline
    }

    public var isValid: Bool {
        guard !id.isEmpty, id.utf8.count <= 128 else { return false }
        switch action {
        case .beginProductScan:
            return enteredCount == nil
                && stageContextToken.flatMap(UUID.init(uuidString:)) != nil
                && phonePlaybackStartDeadline == nil
        case .submitCount:
            return (enteredCount ?? 0) > 0
                && stageContextToken.flatMap(UUID.init(uuidString:)) != nil
                && phonePlaybackStartDeadline == nil
        case .readInstruction:
            return enteredCount == nil
                && stageContextToken == nil
                && (phonePlaybackStartDeadline?.timeIntervalSinceReferenceDate.isFinite ?? true)
        case .requestMetaScan, .confirmPick, .refreshQueue:
            return enteredCount == nil
                && stageContextToken == nil
                && phonePlaybackStartDeadline == nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, action, enteredCount, stageContextToken, phonePlaybackStartDeadline
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        action = try values.decode(WatchPickAction.self, forKey: .action)
        enteredCount = try values.decodeIfPresent(Int.self, forKey: .enteredCount)
        stageContextToken = try values.decodeIfPresent(String.self, forKey: .stageContextToken)
        phonePlaybackStartDeadline = try values.decodeIfPresent(
            Date.self,
            forKey: .phonePlaybackStartDeadline
        )
        guard isValid else { throw PickingContractError.contextMismatch }
    }

    public func encode(to encoder: Encoder) throws {
        guard isValid else { throw PickingContractError.contextMismatch }
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(action, forKey: .action)
        try values.encodeIfPresent(enteredCount, forKey: .enteredCount)
        try values.encodeIfPresent(stageContextToken, forKey: .stageContextToken)
        try values.encodeIfPresent(
            phonePlaybackStartDeadline,
            forKey: .phonePlaybackStartDeadline
        )
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

public struct ExternallyReconciledConfirmationEvidence: Equatable, Sendable {
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let reconciliationGlobalId: String
    public let providerWrites: Int

    public init(
        orderGlobalId: String,
        expectedRowVersion: Int,
        reconciliationGlobalId: String,
        providerWrites: Int
    ) throws {
        guard orderGlobalId.range(
            of: #"^gor(?:[0-9]{7}|[0-9a-v]{12})$"#,
            options: .regularExpression
        ) != nil,
        expectedRowVersion >= 0,
        reconciliationGlobalId.range(
            of: #"^gsfr(?:[0-9]{7}|[0-9a-v]{12})$"#,
            options: .regularExpression
        ) != nil,
        providerWrites == 0 else {
            throw PickingContractError.contextMismatch
        }
        self.orderGlobalId = orderGlobalId
        self.expectedRowVersion = expectedRowVersion
        self.reconciliationGlobalId = reconciliationGlobalId
        self.providerWrites = providerWrites
    }
}

public struct PendingConfirmationContext: Equatable, Sendable {
    public let organizationId: String
    public let workerEmail: String
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let containsExactOrder: Bool
    public let allowsExactReplay: Bool

    public init(
        organizationId: String,
        workerEmail: String,
        orderGlobalId: String,
        expectedRowVersion: Int,
        containsExactOrder: Bool,
        allowsExactReplay: Bool? = nil
    ) {
        self.organizationId = organizationId
        self.workerEmail = workerEmail.lowercased()
        self.orderGlobalId = orderGlobalId
        self.expectedRowVersion = expectedRowVersion
        self.containsExactOrder = containsExactOrder
        self.allowsExactReplay = allowsExactReplay ?? containsExactOrder
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
    public let countEvidenceIdempotencyKey: String?
    public let countEvidence: [PickTaskCountEvidence]?

    public init(
        order: PickOrder,
        scanEvidence: [PickTaskScanEvidence] = [],
        countEvidence: [PickTaskCountEvidence] = [],
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
        self.countEvidenceIdempotencyKey = countEvidence.isEmpty
            ? nil
            : "wearable-count:\(idempotencyKey)"
        self.countEvidence = countEvidence.isEmpty ? nil : countEvidence
    }

    private enum CodingKeys: String, CodingKey {
        case action, orderGlobalId, expectedRowVersion, reason, idempotencyKey
        case scanEvidenceIdempotencyKey, scanEvidence
        case countEvidenceIdempotencyKey, countEvidence
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
        countEvidenceIdempotencyKey = try values.decodeIfPresent(
            String.self,
            forKey: .countEvidenceIdempotencyKey
        )
        countEvidence = try values.decodeIfPresent(
            [PickTaskCountEvidence].self,
            forKey: .countEvidence
        )
        guard (scanEvidenceIdempotencyKey == nil) == (scanEvidence == nil) else {
            throw PickingContractError.contextMismatch
        }
        guard (countEvidenceIdempotencyKey == nil) == (countEvidence == nil) else {
            throw PickingContractError.contextMismatch
        }
    }
}

public struct PickHandoffCommand: Codable, Equatable, Sendable {
    public let action: String
    public let organizationId: String
    public let workerEmail: String
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let expectedAssignedTaskCount: Int
    public let reason: String
    public let blockedConfirmationIdempotencyKey: String?
    public let idempotencyKey: String

    public init(
        queue: PickQueue,
        order: PickOrder,
        reason: String,
        blockedConfirmationIdempotencyKey: String? = nil,
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) throws {
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard queue.orders.contains(order),
              !normalizedReason.isEmpty,
              normalizedReason.utf8.count <= 500,
              normalizedReason.unicodeScalars.allSatisfy({
                  $0.value >= 0x20 && $0.value != 0x7f
              }),
              blockedConfirmationIdempotencyKey.map({
                  $0.range(
                      of: #"^[A-Za-z0-9._:-]{8,200}$"#,
                      options: .regularExpression
                  ) != nil
              }) != false,
              idempotencyKey.range(
                  of: #"^[A-Za-z0-9._:-]{8,185}$"#,
                  options: .regularExpression
              ) != nil else {
            throw PickingContractError.contextMismatch
        }
        action = "request-pick-handoff"
        organizationId = queue.organizationId
        workerEmail = queue.workerEmail
        orderGlobalId = order.orderGlobalId
        expectedRowVersion = order.rowVersion
        expectedAssignedTaskCount = order.tasks.count
        self.reason = normalizedReason
        self.blockedConfirmationIdempotencyKey = blockedConfirmationIdempotencyKey
        self.idempotencyKey = "picker-handoff:\(idempotencyKey)"
    }

    private enum CodingKeys: String, CodingKey {
        case action, organizationId, workerEmail, orderGlobalId
        case expectedRowVersion, expectedAssignedTaskCount, reason
        case blockedConfirmationIdempotencyKey, idempotencyKey
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        action = try values.decode(String.self, forKey: .action)
        organizationId = try values.decode(String.self, forKey: .organizationId).lowercased()
        workerEmail = try values.decode(String.self, forKey: .workerEmail).lowercased()
        orderGlobalId = try values.decode(String.self, forKey: .orderGlobalId)
        expectedRowVersion = try values.decode(Int.self, forKey: .expectedRowVersion)
        expectedAssignedTaskCount = try values.decode(
            Int.self,
            forKey: .expectedAssignedTaskCount
        )
        reason = try values.decode(String.self, forKey: .reason)
        blockedConfirmationIdempotencyKey = try values.decodeIfPresent(
            String.self,
            forKey: .blockedConfirmationIdempotencyKey
        )
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        guard action == "request-pick-handoff",
              UUID(uuidString: organizationId) != nil,
              workerEmail.contains("@"),
              orderGlobalId.range(
                  of: #"^gor(?:[0-9]{7}|[0-9a-v]{12})$"#,
                  options: .regularExpression
              ) != nil,
              expectedRowVersion >= 0,
              expectedAssignedTaskCount > 0,
              !reason.isEmpty,
              reason == reason.trimmingCharacters(in: .whitespacesAndNewlines),
              reason.utf8.count <= 500,
              reason.unicodeScalars.allSatisfy({
                  $0.value >= 0x20 && $0.value != 0x7f
              }),
              blockedConfirmationIdempotencyKey.map({
                  $0.range(
                      of: #"^[A-Za-z0-9._:-]{8,200}$"#,
                      options: .regularExpression
                  ) != nil
              }) != false,
              idempotencyKey.range(
                  of: #"^picker-handoff:[A-Za-z0-9._:-]{8,185}$"#,
                  options: .regularExpression
              ) != nil else {
            throw PickingContractError.contextMismatch
        }
    }
}

public struct PickHandoffEvidence: Equatable, Sendable {
    public let orderGlobalId: String
    public let previousRowVersion: Int
    public let rowVersion: Int
    public let exceptionGlobalId: String
    public let assignedTaskCount: Int
    public let blockedConfirmationIdempotencyKey: String?
    public let providerWrites: Int

    public init(
        command: PickHandoffCommand,
        orderGlobalId: String,
        orderStatus: String,
        previousRowVersion: Int,
        rowVersion: Int,
        exceptionGlobalId: String,
        assignedTaskCount: Int,
        blockedConfirmationIdempotencyKey: String?,
        providerWrites: Int
    ) throws {
        guard orderGlobalId == command.orderGlobalId,
              orderStatus == "released",
              previousRowVersion == command.expectedRowVersion,
              rowVersion == command.expectedRowVersion + 1,
              exceptionGlobalId.range(
                  of: #"^gex(?:[0-9]{7}|[0-9a-v]{12})$"#,
                  options: .regularExpression
              ) != nil,
              assignedTaskCount == command.expectedAssignedTaskCount,
              blockedConfirmationIdempotencyKey
                == command.blockedConfirmationIdempotencyKey,
              providerWrites == 0 else {
            throw PickingContractError.contextMismatch
        }
        self.orderGlobalId = orderGlobalId
        self.previousRowVersion = previousRowVersion
        self.rowVersion = rowVersion
        self.exceptionGlobalId = exceptionGlobalId
        self.assignedTaskCount = assignedTaskCount
        self.blockedConfirmationIdempotencyKey = blockedConfirmationIdempotencyKey
        self.providerWrites = providerWrites
    }
}
