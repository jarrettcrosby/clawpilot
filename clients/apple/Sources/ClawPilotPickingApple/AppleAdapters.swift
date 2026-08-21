import Foundation
import ClawPilotPickingCore

public struct WorkspaceTransition: Codable, Equatable, Sendable {
    public enum PickerCachePolicy: String, Codable, Equatable, Sendable {
        case clearScopedData = "clear_scoped_data"
        case preserveProtectedCommand = "preserve_protected_command"
    }

    public enum Resolution: Equatable, Sendable {
        case sourceWorkspace
        case targetWorkspaceClearScopedData
        case targetWorkspacePreserveProtectedCommand
        case blockedIdentity
    }

    public let schemaVersion: Int
    public let sourceOrganizationId: String
    public let targetOrganizationId: String
    public let workerEmail: String
    public let pickerCachePolicy: PickerCachePolicy
    public let startedAt: Date
    public let startedAtEpochMilliseconds: Int64

    public init(
        sourceOrganizationId: String,
        targetOrganizationId: String,
        workerEmail: String,
        pickerCachePolicy: PickerCachePolicy,
        startedAt: Date = Date()
    ) throws {
        let source = sourceOrganizationId.lowercased()
        let target = targetOrganizationId.lowercased()
        let worker = workerEmail.lowercased()
        guard UUID(uuidString: source) != nil,
              UUID(uuidString: target) != nil,
              source != target,
              worker.contains("@"),
              worker.utf8.count <= 254,
              startedAt.timeIntervalSince1970.isFinite else {
            throw PickingContractError.contextMismatch
        }
        let startedAtMilliseconds = floor(
            startedAt.timeIntervalSince1970 * 1_000
        )
        guard startedAtMilliseconds >= 0,
              startedAtMilliseconds <= 253_402_300_799_999 else {
            throw PickingContractError.contextMismatch
        }
        schemaVersion = 1
        self.sourceOrganizationId = source
        self.targetOrganizationId = target
        self.workerEmail = worker
        self.pickerCachePolicy = pickerCachePolicy
        // The durable encoder writes ISO-8601 milliseconds. Normalize before
        // first persistence so an in-memory journal remains exactly equal to
        // its decoded form for conflict detection and exact retirement.
        let startedAtEpochMilliseconds = Int64(startedAtMilliseconds)
        self.startedAtEpochMilliseconds = startedAtEpochMilliseconds
        self.startedAt = Date(
            timeIntervalSince1970: Double(startedAtEpochMilliseconds) / 1_000
        )
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, sourceOrganizationId, targetOrganizationId
        case workerEmail, pickerCachePolicy, startedAt, startedAtEpochMilliseconds
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        let source = try values.decode(String.self, forKey: .sourceOrganizationId)
        let target = try values.decode(String.self, forKey: .targetOrganizationId)
        let worker = try values.decode(String.self, forKey: .workerEmail)
        let policy = try values.decode(PickerCachePolicy.self, forKey: .pickerCachePolicy)
        let legacyStartedAt = try values.decode(Date.self, forKey: .startedAt)
        let exactStartedAt = try values.decodeIfPresent(
            Int64.self,
            forKey: .startedAtEpochMilliseconds
        )
        guard schemaVersion == 1 else {
            throw PickingContractError.contextMismatch
        }
        if let exactStartedAt {
            guard exactStartedAt >= 0,
                  exactStartedAt <= 253_402_300_799_999,
                  abs(
                      legacyStartedAt.timeIntervalSince1970 * 1_000
                          - Double(exactStartedAt)
                  ) <= 1.1 else {
                throw PickingContractError.contextMismatch
            }
        }
        try self.init(
            sourceOrganizationId: source,
            targetOrganizationId: target,
            workerEmail: worker,
            pickerCachePolicy: policy,
            startedAt: exactStartedAt.map {
                Date(timeIntervalSince1970: Double($0) / 1_000)
            } ?? legacyStartedAt
        )
        if let exactStartedAt,
           startedAtEpochMilliseconds != exactStartedAt {
            throw PickingContractError.contextMismatch
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(schemaVersion, forKey: .schemaVersion)
        try values.encode(sourceOrganizationId, forKey: .sourceOrganizationId)
        try values.encode(targetOrganizationId, forKey: .targetOrganizationId)
        try values.encode(workerEmail, forKey: .workerEmail)
        try values.encode(pickerCachePolicy, forKey: .pickerCachePolicy)
        // Keep the date field for compatibility with installed builds while
        // making the integer epoch authoritative for exact journal identity.
        try values.encode(startedAt, forKey: .startedAt)
        try values.encode(
            startedAtEpochMilliseconds,
            forKey: .startedAtEpochMilliseconds
        )
    }

    public func resolution(
        activeOrganizationId: String,
        effectiveWorkerEmail: String
    ) -> Resolution {
        guard effectiveWorkerEmail.lowercased() == workerEmail else {
            return .blockedIdentity
        }
        switch activeOrganizationId.lowercased() {
        case sourceOrganizationId:
            return .sourceWorkspace
        case targetOrganizationId:
            return pickerCachePolicy == .clearScopedData
                ? .targetWorkspaceClearScopedData
                : .targetWorkspacePreserveProtectedCommand
        default:
            return .blockedIdentity
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.schemaVersion == rhs.schemaVersion
            && lhs.sourceOrganizationId == rhs.sourceOrganizationId
            && lhs.targetOrganizationId == rhs.targetOrganizationId
            && lhs.workerEmail == rhs.workerEmail
            && lhs.pickerCachePolicy == rhs.pickerCachePolicy
            && lhs.startedAtEpochMilliseconds == rhs.startedAtEpochMilliseconds
    }
}

public actor DurablePickCache: PickCache {
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL) throws {
        self.directory = directory
        encoder.dateEncodingStrategy = .clawPilotFractionalISO8601
        decoder.dateDecodingStrategy = .iso8601
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
    }

    public func loadQueue() async throws -> PickQueue? {
        try read(PickQueue.self, name: "pick-queue.json")
    }

    public func saveQueue(_ queue: PickQueue) async throws {
        try write(queue, name: "pick-queue.json")
    }

    public func clearQueue() async throws {
        let url = directory.appendingPathComponent("pick-queue.json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    public func saveOutbox(_ command: ConfirmPicksCommand) async throws {
        if let existing = try await loadOutbox(), existing != command {
            throw PickingContractError.contextMismatch
        }
        try write(command, name: "pick-outbox.json")
    }

    public func loadOutbox() async throws -> ConfirmPicksCommand? {
        try read(ConfirmPicksCommand.self, name: "pick-outbox.json")
    }

    public func clearOutbox() async throws {
        let url = directory.appendingPathComponent("pick-outbox.json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    public func saveHandoffOutbox(_ command: PickHandoffCommand) async throws {
        if let existing = try await loadHandoffOutbox(), existing != command {
            throw PickingContractError.contextMismatch
        }
        try write(command, name: "pick-handoff-outbox.json")
    }

    public func loadHandoffOutbox() async throws -> PickHandoffCommand? {
        try read(PickHandoffCommand.self, name: "pick-handoff-outbox.json")
    }

    public func clearHandoffOutbox() async throws {
        let url = directory.appendingPathComponent("pick-handoff-outbox.json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    public func saveManagerOrderReplanningOutbox(
        _ command: ManagerOrderReplanningCommand
    ) async throws {
        if let existing = try await loadManagerOrderReplanningOutbox(),
           existing != command {
            throw ManagerOrderReplanningClientError.differentCorrectionPending
        }
        try await requireNoPickerCommand(for: command.orderGlobalId)
        try write(command, name: "manager-order-replanning-outbox.json")
    }

    public func loadManagerOrderReplanningOutbox() async throws
        -> ManagerOrderReplanningCommand? {
        try read(
            ManagerOrderReplanningCommand.self,
            name: "manager-order-replanning-outbox.json"
        )
    }

    public func requireManagerOrderReplanningReplayIsUnblocked(
        _ command: ManagerOrderReplanningCommand
    ) async throws {
        guard try await loadManagerOrderReplanningOutbox() == command else {
            throw PickingContractError.contextMismatch
        }
        try await requireNoPickerCommand(for: command.orderGlobalId)
    }

    public func clearManagerOrderReplanningOutbox(
        _ command: ManagerOrderReplanningCommand
    ) async throws {
        guard try await loadManagerOrderReplanningOutbox() == command else {
            throw PickingContractError.contextMismatch
        }
        let url = directory.appendingPathComponent(
            "manager-order-replanning-outbox.json"
        )
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw PickingContractError.contextMismatch
        }
        try FileManager.default.removeItem(at: url)
    }

    @discardableResult
    public func quarantineManagerOrderReplanningOutbox(
        _ command: ManagerOrderReplanningCommand,
        code: String,
        message: String,
        quarantinedAt: Date = Date()
    ) async throws -> ManagerOrderReplanningQuarantine {
        guard try await loadManagerOrderReplanningOutbox() == command else {
            throw PickingContractError.contextMismatch
        }
        let quarantine = try ManagerOrderReplanningQuarantine(
            command: command,
            code: code,
            message: message,
            quarantinedAt: quarantinedAt
        )
        let token = UUID().uuidString.lowercased()
        let detailName = "manager-order-replanning-quarantine-\(token).json"
        let retainedCommandName =
            "manager-order-replanning-quarantined-command-\(token).json"
        var detailWasWritten = false
        do {
            try write(quarantine, name: detailName)
            detailWasWritten = true
        } catch {
            // Continue to the rename. Moving the active file out of the replay
            // path is the fail-safe operation when storage cannot accept a new
            // detail file; the exact command is still retained for support.
        }
        let activeURL = directory.appendingPathComponent(
            "manager-order-replanning-outbox.json"
        )
        let retainedURL = directory.appendingPathComponent(retainedCommandName)
        do {
            try FileManager.default.moveItem(at: activeURL, to: retainedURL)
        } catch {
            if detailWasWritten {
                // The detailed quarantine contains the complete command, so an
                // exact active duplicate must not survive and replay silently.
                try FileManager.default.removeItem(at: activeURL)
            } else {
                throw error
            }
        }
        return quarantine
    }

    public func loadManagerOrderReplanningQuarantines() async throws
        -> [ManagerOrderReplanningQuarantine] {
        try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )
        .filter {
            $0.lastPathComponent.hasPrefix("manager-order-replanning-quarantine-")
                && $0.pathExtension == "json"
        }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
        .map {
            try decoder.decode(
                ManagerOrderReplanningQuarantine.self,
                from: Data(contentsOf: $0)
            )
        }
    }

    private func requireNoPickerCommand(for orderGlobalId: String) async throws {
        let confirmation = try await loadOutbox()
        let handoff = try await loadHandoffOutbox()
        if confirmation?.orderGlobalId == orderGlobalId
            || handoff?.orderGlobalId == orderGlobalId {
            throw ManagerOrderReplanningClientError.pickerCommandPending
        }
        if let progress = try await loadProgress(),
           progress.order.orderGlobalId == orderGlobalId,
           !progress.scannedTaskIDs.isEmpty
            || !progress.locationVerifiedTaskIDs.isEmpty
            || !progress.productStartPendingTaskIDs.isEmpty
            || !progress.locationObservations.isEmpty
            || !progress.productObservations.isEmpty
            || !progress.countEvidence.isEmpty
            || !progress.stageContextTokens.isEmpty {
            throw ManagerOrderReplanningClientError.pickerCommandPending
        }
    }

    public func loadProgress() async throws -> PickSessionProgress? {
        try read(PickSessionProgress.self, name: "pick-progress.json")
    }

    public func saveProgress(_ progress: PickSessionProgress) async throws {
        try write(progress, name: "pick-progress.json")
    }

    public func clearProgress() async throws {
        let url = directory.appendingPathComponent("pick-progress.json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    public func saveWorkspaceTransition(_ transition: WorkspaceTransition) async throws {
        if let existing = try await loadWorkspaceTransition() {
            guard existing == transition else {
                throw PickingContractError.contextMismatch
            }
            return
        }
        let confirmation = try await loadOutbox()
        let handoff = try await loadHandoffOutbox()
        let managerReplanning = try await loadManagerOrderReplanningOutbox()
        switch transition.pickerCachePolicy {
        case .clearScopedData:
            guard confirmation == nil,
                  handoff == nil,
                  managerReplanning == nil else {
                throw PickingContractError.contextMismatch
            }
        case .preserveProtectedCommand:
            guard confirmation != nil
                    || handoff != nil
                    || managerReplanning != nil else {
                throw PickingContractError.contextMismatch
            }
            if confirmation != nil || handoff != nil {
                guard let queue = try await loadQueue(),
                      queue.organizationId == transition.targetOrganizationId,
                      queue.workerEmail == transition.workerEmail,
                      confirmation.map({ command in
                          queue.orders.contains(where: {
                              $0.orderGlobalId == command.orderGlobalId
                                  && $0.rowVersion == command.expectedRowVersion
                          })
                      }) != false,
                      handoff.map({ command in
                          command.organizationId == transition.targetOrganizationId
                              && command.workerEmail == transition.workerEmail
                              && queue.orders.contains(where: { order in
                                  order.orderGlobalId == command.orderGlobalId
                                      && order.rowVersion == command.expectedRowVersion
                                      && order.tasks.count == command.expectedAssignedTaskCount
                              })
                              && command.blockedConfirmationIdempotencyKey
                                  == confirmation?.idempotencyKey
                      }) != false else {
                    throw PickingContractError.contextMismatch
                }
            }
            if let managerReplanning {
                guard managerReplanning.organizationId
                        == transition.targetOrganizationId,
                      managerReplanning.workerEmail == transition.workerEmail else {
                    throw PickingContractError.contextMismatch
                }
            }
        }
        try write(transition, name: "workspace-transition.json")
    }

    public func loadWorkspaceTransition() async throws -> WorkspaceTransition? {
        try read(WorkspaceTransition.self, name: "workspace-transition.json")
    }

    public func clearWorkspaceTransition(_ transition: WorkspaceTransition) async throws {
        guard try await loadWorkspaceTransition() == transition else {
            throw PickingContractError.contextMismatch
        }
        let url = directory.appendingPathComponent("workspace-transition.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw PickingContractError.contextMismatch
        }
        try FileManager.default.removeItem(at: url)
    }

    private func read<T: Decodable>(_ type: T.Type, name: String) throws -> T? {
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(type, from: Data(contentsOf: url))
    }

    private func write<T: Encodable>(_ value: T, name: String) throws {
        let data = try encoder.encode(value)
#if os(iOS) || os(watchOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
#else
        // Complete file protection is an iOS/watchOS data-protection class.
        // The macOS package test runner can reject the atomic temporary file
        // when that option is applied inside its protected temporary folder.
        let options: Data.WritingOptions = [.atomic]
#endif
        try data.write(
            to: directory.appendingPathComponent(name),
            options: options
        )
    }
}

public enum PickingAPIError: Error, Equatable, Sendable {
    case invalidOrigin
    case unauthorized
    case sessionSuperseded
    case rateLimited(retryAfterSeconds: Int)
    case conflict(code: String, message: String)
    case rejected(code: String, message: String)
    case invalidResponse
}

extension PickingAPIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidOrigin: "The ClawPilot server address is invalid."
        case .unauthorized: "Sign in to continue."
        case .sessionSuperseded: "This signed-in operation was cancelled because the session changed."
        case .rateLimited(let seconds): "Too many code requests. Try again in \(seconds) seconds."
        case .conflict(_, let message): message
        case .rejected(_, let message): message
        case .invalidResponse: "ClawPilot returned an unexpected response."
        }
    }
}

public struct PendingConfirmationRecheck: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Equatable, Sendable {
        case managerActionRequired = "manager_action_required"
        case reconciledExternalFulfillment = "reconciled_external_fulfillment"
        case unresolved
    }

    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let state: State
    public let code: String
    public let message: String
    public let reconciliationGlobalId: String?
    public let providerWrites: Int?

    public func reconciliationEvidence()
        throws -> ExternallyReconciledConfirmationEvidence
    {
        guard state == .reconciledExternalFulfillment,
              code == "OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILED",
              let reconciliationGlobalId,
              let providerWrites else {
            throw PickingAPIError.invalidResponse
        }
        return try ExternallyReconciledConfirmationEvidence(
            orderGlobalId: orderGlobalId,
            expectedRowVersion: expectedRowVersion,
            reconciliationGlobalId: reconciliationGlobalId,
            providerWrites: providerWrites
        )
    }
}

public struct PendingConfirmationRecheckResult: Equatable, Sendable {
    public let queue: PickQueue
    public let pendingConfirmation: PendingConfirmationRecheck
}

public struct PickHandoffResult: Decodable, Equatable, Sendable {
    public let orderGlobalId: String
    public let orderStatus: String
    public let previousRowVersion: Int
    public let rowVersion: Int
    public let exceptionGlobalId: String
    public let assignedTaskCount: Int
    public let blockedConfirmationIdempotencyKey: String?
    public let providerWrites: Int
    public let replayed: Bool

    public func evidence(for command: PickHandoffCommand) throws -> PickHandoffEvidence {
        try PickHandoffEvidence(
            command: command,
            orderGlobalId: orderGlobalId,
            orderStatus: orderStatus,
            previousRowVersion: previousRowVersion,
            rowVersion: rowVersion,
            exceptionGlobalId: exceptionGlobalId,
            assignedTaskCount: assignedTaskCount,
            blockedConfirmationIdempotencyKey: blockedConfirmationIdempotencyKey,
            providerWrites: providerWrites
        )
    }
}

public struct ClawPilotSessionProfile: Decodable, Equatable, Sendable {
    public struct Workspace: Decodable, Equatable, Identifiable, Sendable {
        public var id: String { organizationId }
        public let organizationId: String
        public let referenceCode: String?
        public let name: String?
        public let organizationType: String?
        public let role: String?
        public let isDefault: Bool?

        public init(
            organizationId: String,
            referenceCode: String?,
            name: String?,
            organizationType: String? = nil,
            role: String?,
            isDefault: Bool? = nil
        ) {
            self.organizationId = organizationId
            self.referenceCode = referenceCode
            self.name = name
            self.organizationType = organizationType
            self.role = role
            self.isDefault = isDefault
        }
    }

    public struct EffectiveUser: Decodable, Equatable, Sendable {
        public let email: String
        public let displayName: String?
        public let role: String
        public let organizationName: String?
        public let organizationRole: String?

        public init(
            email: String,
            displayName: String?,
            role: String,
            organizationName: String?,
            organizationRole: String?
        ) {
            self.email = email
            self.displayName = displayName
            self.role = role
            self.organizationName = organizationName
            self.organizationRole = organizationRole
        }
    }

    public struct MobileCapabilities: Decodable, Equatable, Sendable {
        public let canUsePicker: Bool
        public let canUseManager: Bool

        public init(canUsePicker: Bool, canUseManager: Bool) {
            self.canUsePicker = canUsePicker
            self.canUseManager = canUseManager
        }
    }

    public let user: String
    public let effectiveUser: EffectiveUser
    public let mobileCapabilities: MobileCapabilities
    public let activeWorkspace: Workspace
    public let availableWorkspaces: [Workspace]

    public init(
        user: String,
        effectiveUser: EffectiveUser,
        mobileCapabilities: MobileCapabilities,
        activeWorkspace: Workspace,
        availableWorkspaces: [Workspace]
    ) {
        self.user = user
        self.effectiveUser = effectiveUser
        self.mobileCapabilities = mobileCapabilities
        self.activeWorkspace = activeWorkspace
        self.availableWorkspaces = availableWorkspaces
    }
}

public struct GoogleAuthState: Decodable, Equatable, Sendable {
    public struct Identity: Decodable, Equatable, Sendable {
        public let linked: Bool
        public let email: String
        public let linkedAt: String?
    }

    public let organizationId: String
    public let organizationName: String
    public let linkingAvailable: Bool?
    // Compatibility fields retained while older servers and clients migrate
    // from organization-scoped Google policy controls.
    public let enabled: Bool
    public let rowVersion: Int
    public let canManage: Bool
    public let platformConfigured: Bool
    public let webClientId: String?
    public let identity: Identity
    public let impersonating: Bool?

    public var canLinkCurrentUser: Bool {
        linkingAvailable ?? enabled
    }
}

public struct GoogleIdentityLinkState: Decodable, Equatable, Sendable {
    public let linked: Bool
    public let email: String
    public let linkedAt: String
    public let alreadyLinked: Bool
}

public struct ManagerOrderSummary: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let globalId: String
    public let orderNumber: String
    public let customerName: String
    public let status: String
    public let warehouseName: String?
    public let lineCount: Int

    public init(
        id: String,
        globalId: String,
        orderNumber: String,
        customerName: String,
        status: String,
        warehouseName: String?,
        lineCount: Int
    ) {
        self.id = id
        self.globalId = globalId
        self.orderNumber = orderNumber
        self.customerName = customerName
        self.status = status
        self.warehouseName = warehouseName
        self.lineCount = lineCount
    }
}

public struct ManagerOperationsCapabilities: Decodable, Equatable, Sendable {
    public let canActivate: Bool
}

public enum ManagerStoreSyncDesiredState: String, Codable, Equatable, Sendable {
    case running
    case paused
}

public enum ManagerStoreSyncEffectiveState: String, Decodable, Equatable, Sendable {
    case running
    case paused
}

public enum ManagerStoreSyncEffectiveReason: String, Decodable, Equatable, Sendable {
    case operationsDisabledOverride = "OPERATIONS_DISABLED_OVERRIDE"
    case operationsFrozenOverride = "OPERATIONS_FROZEN_OVERRIDE"
    case controlMissing = "STORE_SYNC_CONTROL_MISSING"
    case accountUnavailable = "STORE_SYNC_ACCOUNT_UNAVAILABLE"
    case explicitRunning = "STORE_SYNC_EXPLICIT_RUNNING"
    case explicitPausedDraining = "STORE_SYNC_EXPLICIT_PAUSED_DRAINING"
    case explicitPaused = "STORE_SYNC_EXPLICIT_PAUSED"
    case legacyShadowRunning = "STORE_SYNC_LEGACY_SHADOW_RUNNING"
    case legacyActiveRunning = "STORE_SYNC_LEGACY_ACTIVE_RUNNING"
    case legacyReadOnlyPaused = "STORE_SYNC_LEGACY_READ_ONLY_PAUSED"

    public var expectedState: ManagerStoreSyncEffectiveState {
        switch self {
        case .explicitRunning, .legacyShadowRunning, .legacyActiveRunning:
            .running
        default:
            .paused
        }
    }
}

public struct ManagerStoreSyncControl: Decodable, Equatable, Identifiable, Sendable {
    public let accountGlobalId: String
    public let provider: String
    public let environment: String
    public let displayName: String
    public let accountStatus: String
    public let desiredState: ManagerStoreSyncDesiredState
    public let effectiveState: ManagerStoreSyncEffectiveState
    public let effectiveReason: ManagerStoreSyncEffectiveReason
    public let effectiveReasonLabel: String
    public let explicitChoice: Bool
    public let revision: Int
    public let reason: String
    public let updatedAt: String

    public var id: String { accountGlobalId }

    public var isContractValid: Bool {
        accountGlobalId.range(
            of: #"^gia(?:[0-9]{7}|[0-9a-v]{12})$"#,
            options: .regularExpression
        ) != nil
            && ["shopify", "faire"].contains(provider)
            && ["mock", "sandbox", "production"].contains(environment)
            && ["active", "disabled", "error"].contains(accountStatus)
            && effectiveState == effectiveReason.expectedState
            && revision >= 1
            && !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !effectiveReasonLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public struct ManagerOperationsOverview: Equatable, Sendable {
    public let orders: [ManagerOrderSummary]
    public let storeSync: [ManagerStoreSyncControl]
    public let capabilities: ManagerOperationsCapabilities
}

public enum ManagerShopifyCheckoutAudience: String, Codable, CaseIterable, Equatable, Sendable {
    case off
    case restrictedCustomers = "restricted_customers"
    case allEligible = "all_eligible"

    public var label: String {
        switch self {
        case .off: "Off"
        case .restrictedCustomers: "Restricted customers"
        case .allEligible: "All eligible"
        }
    }
}

public enum ManagerShopifyCheckoutRateSource: String, Codable, CaseIterable, Equatable, Sendable {
    case test = "sandbox"
    case live = "production"

    public var label: String {
        switch self {
        case .test: "TEST"
        case .live: "LIVE"
        }
    }
}

public enum ManagerShopifyCheckoutEffectiveState: String, Decodable, Equatable, Sendable {
    case notConfigured = "not_configured"
    case empty
    case serving
    case notReady = "not_ready"

    public var label: String {
        switch self {
        case .notConfigured: "Not configured"
        case .empty: "Empty"
        case .serving: "Available"
        case .notReady: "Not ready"
        }
    }
}

public enum ManagerShopifyCheckoutEffectiveReason: String, Decodable, Equatable, Sendable {
    case emergencyDisabled = "SHOPIFY_CHECKOUT_RATES_EMERGENCY_DISABLED"
    case emergencyFrozen = "SHOPIFY_CHECKOUT_RATES_EMERGENCY_FROZEN"
    case configuredOff = "SHOPIFY_SHADOW_GUARD_AUDIENCE_OFF"
    case productionSourceRequired = "SHOPIFY_CHECKOUT_PRODUCTION_RATE_SOURCE_REQUIRED"
    case restrictedLiveEnforcementRequired = "SHOPIFY_CHECKOUT_RESTRICTED_LIVE_ENFORCEMENT_REQUIRED"
    case runtimeNotReady = "SHOPIFY_CHECKOUT_RATING_RUNTIME_NOT_READY"
    case serving = "SHOPIFY_CHECKOUT_RATES_SERVING"

    public var expectedState: ManagerShopifyCheckoutEffectiveState {
        switch self {
        case .emergencyDisabled, .emergencyFrozen, .configuredOff,
             .productionSourceRequired, .restrictedLiveEnforcementRequired:
            .empty
        case .runtimeNotReady:
            .notReady
        case .serving:
            .serving
        }
    }

    public var label: String {
        switch self {
        case .emergencyDisabled:
            "Disabled is overriding checkout availability; the desired setting remains saved."
        case .emergencyFrozen:
            "Frozen is overriding checkout availability; the desired setting remains saved."
        case .configuredOff:
            "The saved checkout audience is Off."
        case .productionSourceRequired:
            "A production Shopify store cannot serve the saved TEST carrier source."
        case .restrictedLiveEnforcementRequired:
            "Restricted customers with LIVE rates remains empty until customer-specific provider enforcement is verified."
        case .runtimeNotReady:
            "Checkout rating is not ready to serve this saved setting."
        case .serving:
            "Checkout rating is available for the saved audience and carrier source."
        }
    }
}

public struct ManagerShopifyCheckoutRateLastChange: Decodable, Equatable, Sendable {
    public let configGlobalId: String
    public let resultingRowVersion: Int
    public let resultingPolicyRevision: Int
    public let reason: String
}

public struct ManagerShopifyCheckoutRateControl: Equatable, Identifiable, Sendable {
    public let accountGlobalId: String
    public let provider: String
    public let environment: String
    public let displayName: String
    public let accountStatus: String
    public let configGlobalId: String?
    public let rowVersion: Int?
    public let policyRevision: Int?
    public let desiredAudience: ManagerShopifyCheckoutAudience?
    public let desiredRateSource: ManagerShopifyCheckoutRateSource?
    public let effectiveState: ManagerShopifyCheckoutEffectiveState
    public let effectiveReason: ManagerShopifyCheckoutEffectiveReason
    public let serving: Bool
    public let emergencyOverride: Bool
    public let canActivate: Bool
    public let canManage: Bool
    public let lastChange: ManagerShopifyCheckoutRateLastChange?

    public var id: String { accountGlobalId }
    public var isConfigured: Bool { configGlobalId != nil }
    public var canEdit: Bool { isConfigured && canActivate && canManage }

    public init(
        accountGlobalId: String,
        provider: String,
        environment: String,
        displayName: String,
        accountStatus: String,
        configGlobalId: String?,
        rowVersion: Int?,
        policyRevision: Int?,
        desiredAudience: ManagerShopifyCheckoutAudience?,
        desiredRateSource: ManagerShopifyCheckoutRateSource?,
        effectiveState: ManagerShopifyCheckoutEffectiveState,
        effectiveReason: ManagerShopifyCheckoutEffectiveReason,
        serving: Bool,
        emergencyOverride: Bool,
        canActivate: Bool,
        canManage: Bool,
        lastChange: ManagerShopifyCheckoutRateLastChange?
    ) {
        self.accountGlobalId = accountGlobalId
        self.provider = provider
        self.environment = environment
        self.displayName = displayName
        self.accountStatus = accountStatus
        self.configGlobalId = configGlobalId
        self.rowVersion = rowVersion
        self.policyRevision = policyRevision
        self.desiredAudience = desiredAudience
        self.desiredRateSource = desiredRateSource
        self.effectiveState = effectiveState
        self.effectiveReason = effectiveReason
        self.serving = serving
        self.emergencyOverride = emergencyOverride
        self.canActivate = canActivate
        self.canManage = canManage
        self.lastChange = lastChange
    }

    public var isContractValid: Bool {
        let accountValid = accountGlobalId.range(
            of: #"^gia(?:[0-9]{7}|[0-9a-v]{12})$"#,
            options: .regularExpression
        ) != nil
            && provider == "shopify"
            && ["mock", "sandbox", "production"].contains(environment)
            && ["active", "disabled", "error"].contains(accountStatus)
            && !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard accountValid else { return false }

        if configGlobalId == nil {
            return rowVersion == nil
                && policyRevision == nil
                && desiredAudience == nil
                && desiredRateSource == nil
                && effectiveState == .notConfigured
                && effectiveReason == .runtimeNotReady
                && !serving
                && lastChange == nil
        }
        guard let configGlobalId,
              configGlobalId.range(
                of: #"^gscf(?:[0-9]{7}|[0-9a-v]{12})$"#,
                options: .regularExpression
              ) != nil,
              let rowVersion, rowVersion >= 0,
              let policyRevision, policyRevision >= 1,
              desiredAudience != nil,
              desiredRateSource != nil,
              effectiveState == effectiveReason.expectedState,
              serving == (effectiveState == .serving) else {
            return false
        }
        if emergencyOverride != [
            ManagerShopifyCheckoutEffectiveReason.emergencyDisabled,
            .emergencyFrozen,
        ].contains(effectiveReason) {
            return false
        }
        guard let lastChange else { return true }
        let reason = lastChange.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return lastChange.configGlobalId == configGlobalId
            && lastChange.resultingRowVersion >= 1
            && lastChange.resultingRowVersion <= rowVersion
            && lastChange.resultingPolicyRevision >= 1
            && lastChange.resultingPolicyRevision <= policyRevision
            && reason.count >= 3
            && reason.count <= 500
            && reason.unicodeScalars.allSatisfy {
                !CharacterSet.controlCharacters.contains($0)
            }
    }
}

public enum ManagerShopifyCheckoutRateClientError: Error, Equatable, Sendable {
    case invalidControl
    case notAuthorized
    case invalidOrganization
    case invalidReason
    case invalidIdempotencyKey
    case mismatchedResponse
}

extension ManagerShopifyCheckoutRateClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidControl:
            "Refresh the exact Shopify checkout-rate control before changing it."
        case .notAuthorized:
            "Only an organization owner or authorized administrator may change Shopify checkout rates."
        case .invalidOrganization:
            "The Shopify checkout-rate change is not bound to a valid organization."
        case .invalidReason:
            "Enter a readable checkout-rate reason between 3 and 500 characters."
        case .invalidIdempotencyKey:
            "The Shopify checkout-rate retry identity is invalid."
        case .mismatchedResponse:
            "ClawPilot returned checkout-rate evidence that did not match the reviewed change."
        }
    }
}

public struct ManagerShopifyCheckoutRateCommand: Equatable, Sendable {
    public let authenticationGeneration: UInt64
    public let organizationId: String
    public let accountGlobalId: String
    public let configGlobalId: String
    public let expectedRowVersion: Int
    public let expectedPolicyRevision: Int
    public let desiredAudience: ManagerShopifyCheckoutAudience
    public let desiredRateSource: ManagerShopifyCheckoutRateSource
    public let reason: String
    public let idempotencyKey: String

    public init(
        control: ManagerShopifyCheckoutRateControl,
        authenticationGeneration: UInt64,
        organizationId: String,
        desiredAudience: ManagerShopifyCheckoutAudience,
        desiredRateSource: ManagerShopifyCheckoutRateSource,
        reason: String,
        idempotencyKey: String = "shopify-rate-control:\(UUID().uuidString.lowercased())"
    ) throws {
        guard control.isContractValid,
              let configGlobalId = control.configGlobalId,
              let rowVersion = control.rowVersion,
              let policyRevision = control.policyRevision else {
            throw ManagerShopifyCheckoutRateClientError.invalidControl
        }
        guard control.canEdit else {
            throw ManagerShopifyCheckoutRateClientError.notAuthorized
        }
        let normalizedOrganizationId = organizationId.lowercased()
        guard UUID(uuidString: normalizedOrganizationId) != nil else {
            throw ManagerShopifyCheckoutRateClientError.invalidOrganization
        }
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedReason.count >= 3,
              normalizedReason.count <= 500,
              normalizedReason.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw ManagerShopifyCheckoutRateClientError.invalidReason
        }
        guard idempotencyKey.range(
            of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$"#,
            options: .regularExpression
        ) != nil else {
            throw ManagerShopifyCheckoutRateClientError.invalidIdempotencyKey
        }
        self.authenticationGeneration = authenticationGeneration
        self.organizationId = normalizedOrganizationId
        accountGlobalId = control.accountGlobalId
        self.configGlobalId = configGlobalId
        expectedRowVersion = rowVersion
        expectedPolicyRevision = policyRevision
        self.desiredAudience = desiredAudience
        self.desiredRateSource = desiredRateSource
        self.reason = normalizedReason
        self.idempotencyKey = idempotencyKey
    }

    public func isSameRequestedChange(
        accountGlobalId: String,
        desiredAudience: ManagerShopifyCheckoutAudience,
        desiredRateSource: ManagerShopifyCheckoutRateSource,
        reason: String
    ) -> Bool {
        self.accountGlobalId == accountGlobalId
            && self.desiredAudience == desiredAudience
            && self.desiredRateSource == desiredRateSource
            && self.reason == reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func isCurrentReview(
        _ control: ManagerShopifyCheckoutRateControl
    ) -> Bool {
        control.isContractValid
            && control.accountGlobalId == accountGlobalId
            && control.configGlobalId == configGlobalId
            && control.rowVersion == expectedRowVersion
            && control.policyRevision == expectedPolicyRevision
    }

    public func isConfirmedApplied(
        by control: ManagerShopifyCheckoutRateControl
    ) -> Bool {
        control.isContractValid
            && control.accountGlobalId == accountGlobalId
            && control.configGlobalId == configGlobalId
            && control.rowVersion == expectedRowVersion + 1
            && control.policyRevision == expectedPolicyRevision + 1
            && control.desiredAudience == desiredAudience
            && control.desiredRateSource == desiredRateSource
            && control.lastChange?.resultingRowVersion == expectedRowVersion + 1
            && control.lastChange?.resultingPolicyRevision == expectedPolicyRevision + 1
            && control.lastChange?.reason == reason
    }

    public func permitsStateMutation(
        currentAuthenticationGeneration: UInt64,
        currentOrganizationId: String?,
        currentAccountGlobalId: String?,
        isAuthenticated: Bool
    ) -> Bool {
        isAuthenticated
            && currentAuthenticationGeneration == authenticationGeneration
            && currentOrganizationId?.lowercased() == organizationId
            && currentAccountGlobalId == accountGlobalId
    }
}

public struct ManagerShopifyCheckoutRateSubmissionFence: Equatable, Sendable {
    public let command: ManagerShopifyCheckoutRateCommand

    public init(command: ManagerShopifyCheckoutRateCommand) {
        self.command = command
    }

    public func ownsCompletion(
        of finishingCommand: ManagerShopifyCheckoutRateCommand
    ) -> Bool {
        command == finishingCommand
    }

    public func permitsStateMutation(
        for responseCommand: ManagerShopifyCheckoutRateCommand,
        currentAuthenticationGeneration: UInt64,
        currentOrganizationId: String?,
        isAuthenticated: Bool
    ) -> Bool {
        command == responseCommand
            && command.permitsStateMutation(
                currentAuthenticationGeneration: currentAuthenticationGeneration,
                currentOrganizationId: currentOrganizationId,
                currentAccountGlobalId: responseCommand.accountGlobalId,
                isAuthenticated: isAuthenticated
            )
    }
}

public enum ManagerShopifyCheckoutRateModelFailure: Equatable, Sendable {
    case definitive
    case ambiguous
}

public enum ManagerShopifyCheckoutRateModelResolution: Equatable, Sendable {
    case ignoreSupersededContext
    case applied
    case quarantineAndRefresh
    case retainExactRetry
}

public struct ManagerShopifyCheckoutRatePendingModel: Equatable, Sendable {
    public let command: ManagerShopifyCheckoutRateCommand

    public init(command: ManagerShopifyCheckoutRateCommand) {
        self.command = command
    }

    public func resolve(
        currentAuthenticationGeneration: UInt64,
        currentOrganizationId: String?,
        currentAccountGlobalId: String?,
        isAuthenticated: Bool,
        failure: ManagerShopifyCheckoutRateModelFailure,
        refreshedControl: ManagerShopifyCheckoutRateControl?
    ) -> ManagerShopifyCheckoutRateModelResolution {
        guard command.permitsStateMutation(
            currentAuthenticationGeneration: currentAuthenticationGeneration,
            currentOrganizationId: currentOrganizationId,
            currentAccountGlobalId: currentAccountGlobalId,
            isAuthenticated: isAuthenticated
        ) else {
            return .ignoreSupersededContext
        }
        if let refreshedControl,
           command.isConfirmedApplied(by: refreshedControl) {
            return .applied
        }
        if failure == .definitive {
            return .quarantineAndRefresh
        }
        if let refreshedControl,
           !command.isCurrentReview(refreshedControl) {
            return .quarantineAndRefresh
        }
        return .retainExactRetry
    }
}

public struct ManagerShopifyCheckoutRateCommandResult: Decodable, Equatable, Sendable {
    private struct SavedControl: Decodable, Equatable, Sendable {
        let version: String
        let audience: ManagerShopifyCheckoutAudience
        let rateSource: ManagerShopifyCheckoutRateSource
    }

    public let version: String
    public let accountGlobalId: String
    public let configGlobalId: String
    public let idempotencyKey: String
    public let requestHash: String
    private let checkoutRateControl: SavedControl
    public let rowVersion: Int
    public let policyRevision: Int
    public let providerWrites: Int

    public func validated(
        for command: ManagerShopifyCheckoutRateCommand
    ) throws -> ManagerShopifyCheckoutRateCommandResult {
        guard version == "shopify-checkout-rate-control-command-result-v1",
              accountGlobalId == command.accountGlobalId,
              configGlobalId == command.configGlobalId,
              idempotencyKey == command.idempotencyKey,
              requestHash.range(
                of: #"^[a-f0-9]{64}$"#,
                options: .regularExpression
              ) != nil,
              checkoutRateControl.version == "shopify-checkout-rate-control-v1",
              checkoutRateControl.audience == command.desiredAudience,
              checkoutRateControl.rateSource == command.desiredRateSource,
              rowVersion == command.expectedRowVersion + 1,
              policyRevision == command.expectedPolicyRevision + 1,
              providerWrites == 0 else {
            throw ManagerShopifyCheckoutRateClientError.mismatchedResponse
        }
        return self
    }
}

public struct ManagerStoreSyncSubmissionFence: Equatable, Sendable {
    public let authenticationGeneration: UInt64
    public let organizationId: String

    public init(authenticationGeneration: UInt64, organizationId: String) {
        self.authenticationGeneration = authenticationGeneration
        self.organizationId = organizationId
    }

    public func permitsStateMutation(
        currentAuthenticationGeneration: UInt64,
        currentOrganizationId: String?,
        isAuthenticated: Bool
    ) -> Bool {
        isAuthenticated
            && currentAuthenticationGeneration == authenticationGeneration
            && currentOrganizationId == organizationId
    }
}

public enum ManagerStoreSyncClientError: Error, Equatable, Sendable {
    case invalidControl
    case invalidReason
    case invalidIdempotencyKey
    case mismatchedResponse
}

extension ManagerStoreSyncClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidControl:
            "Refresh the exact Store sync control before changing it."
        case .invalidReason:
            "Enter a readable Store sync reason between 1 and 500 characters."
        case .invalidIdempotencyKey:
            "The Store sync retry identity is invalid."
        case .mismatchedResponse:
            "ClawPilot returned Store sync evidence that did not match the reviewed change."
        }
    }
}

public struct ManagerStoreSyncCommand: Encodable, Equatable, Sendable {
    public let action = "update-commerce-store-sync"
    public let accountGlobalId: String
    public let desiredState: ManagerStoreSyncDesiredState
    public let expectedDesiredState: ManagerStoreSyncDesiredState
    public let expectedRevision: Int
    public let reason: String
    public let idempotencyKey: String

    public init(
        control: ManagerStoreSyncControl,
        desiredState: ManagerStoreSyncDesiredState,
        reason: String,
        idempotencyKey: String = "store-sync:\(UUID().uuidString.lowercased())"
    ) throws {
        guard control.isContractValid else {
            throw ManagerStoreSyncClientError.invalidControl
        }
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedReason.isEmpty,
              normalizedReason.count <= 500,
              normalizedReason.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw ManagerStoreSyncClientError.invalidReason
        }
        guard idempotencyKey.range(
            of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$"#,
            options: .regularExpression
        ) != nil else {
            throw ManagerStoreSyncClientError.invalidIdempotencyKey
        }
        self.accountGlobalId = control.accountGlobalId
        self.desiredState = desiredState
        expectedDesiredState = control.desiredState
        expectedRevision = control.revision
        self.reason = normalizedReason
        self.idempotencyKey = idempotencyKey
    }
}

public struct ManagerStoreSyncUpdateResult: Decodable, Equatable, Sendable {
    public let control: ManagerStoreSyncControl

    public func validated(
        for command: ManagerStoreSyncCommand
    ) throws -> ManagerStoreSyncControl {
        guard control.isContractValid,
              control.accountGlobalId == command.accountGlobalId,
              control.desiredState == command.desiredState,
              control.explicitChoice,
              control.revision == command.expectedRevision + 1,
              control.reason == command.reason else {
            throw ManagerStoreSyncClientError.mismatchedResponse
        }
        return control
    }
}

public struct ManagerOrderActionAvailability: Decodable, Equatable, Sendable {
    public let action: String
    public let label: String
    public let enabled: Bool
    public let blockedReason: String?
    public let blockedCode: String?
    public let consequenceSummary: String?
    public let expectedPlanGlobalId: String?
    public let expectedPlanVersion: Int?
    public let expectedCorrectionFingerprint: String?

    public init(
        action: String,
        label: String,
        enabled: Bool,
        blockedReason: String?,
        blockedCode: String? = nil,
        consequenceSummary: String? = nil,
        expectedPlanGlobalId: String? = nil,
        expectedPlanVersion: Int? = nil,
        expectedCorrectionFingerprint: String? = nil
    ) {
        self.action = action
        self.label = label
        self.enabled = enabled
        self.blockedReason = blockedReason
        self.blockedCode = blockedCode
        self.consequenceSummary = consequenceSummary
        self.expectedPlanGlobalId = expectedPlanGlobalId
        self.expectedPlanVersion = expectedPlanVersion
        self.expectedCorrectionFingerprint = expectedCorrectionFingerprint
    }

    public var isExactReplanningCorrectionProjection: Bool {
        action == "reopen_for_replanning"
            && enabled
            && blockedReason == nil
            && !(consequenceSummary ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && expectedPlanGlobalId?.range(
                of: #"^gfp(?:[0-9]{7}|[0-9a-v]{12})$"#,
                options: .regularExpression
            ) != nil
            && (expectedPlanVersion ?? 0) >= 1
            && expectedCorrectionFingerprint?.range(
                of: #"^[a-f0-9]{64}$"#,
                options: .regularExpression
            ) != nil
    }
}

public struct ManagerOrderDetail: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { globalId }
    public let globalId: String
    public let orderNumber: String
    public let customerName: String
    public let status: String
    public let warehouseName: String?
    public let rowVersion: Int
    public let planStatus: String?
    public let waveStatus: String?
    public let pickTaskCount: Int
    public let readyPickTaskCount: Int
    public let pickedPickTaskCount: Int
    public let availableActions: [ManagerOrderActionAvailability]

    public var replanningCorrectionAvailability: ManagerOrderActionAvailability? {
        availableActions.first { $0.action == "reopen_for_replanning" }
    }

    public var replanningCorrectionAction: ManagerOrderActionAvailability? {
        replanningCorrectionAvailability.flatMap {
            $0.isExactReplanningCorrectionProjection ? $0 : nil
        }
    }

    public init(
        globalId: String,
        orderNumber: String,
        customerName: String,
        status: String,
        warehouseName: String?,
        rowVersion: Int,
        planStatus: String?,
        waveStatus: String?,
        pickTaskCount: Int,
        readyPickTaskCount: Int,
        pickedPickTaskCount: Int,
        availableActions: [ManagerOrderActionAvailability] = []
    ) {
        self.globalId = globalId
        self.orderNumber = orderNumber
        self.customerName = customerName
        self.status = status
        self.warehouseName = warehouseName
        self.rowVersion = rowVersion
        self.planStatus = planStatus
        self.waveStatus = waveStatus
        self.pickTaskCount = pickTaskCount
        self.readyPickTaskCount = readyPickTaskCount
        self.pickedPickTaskCount = pickedPickTaskCount
        self.availableActions = availableActions
    }

    private enum CodingKeys: String, CodingKey {
        case globalId, orderNumber, customerName, status, warehouseName
        case rowVersion, planStatus, waveStatus, pickTaskCount
        case readyPickTaskCount, pickedPickTaskCount, availableActions
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        globalId = try values.decode(String.self, forKey: .globalId)
        orderNumber = try values.decode(String.self, forKey: .orderNumber)
        customerName = try values.decode(String.self, forKey: .customerName)
        status = try values.decode(String.self, forKey: .status)
        warehouseName = try values.decodeIfPresent(String.self, forKey: .warehouseName)
        rowVersion = try values.decode(Int.self, forKey: .rowVersion)
        planStatus = try values.decodeIfPresent(String.self, forKey: .planStatus)
        waveStatus = try values.decodeIfPresent(String.self, forKey: .waveStatus)
        pickTaskCount = try values.decode(Int.self, forKey: .pickTaskCount)
        readyPickTaskCount = try values.decode(Int.self, forKey: .readyPickTaskCount)
        pickedPickTaskCount = try values.decode(Int.self, forKey: .pickedPickTaskCount)
        availableActions = try values.decodeIfPresent(
            [ManagerOrderActionAvailability].self,
            forKey: .availableActions
        ) ?? []
    }
}

public enum ManagerOrderReplanningClientError: Error, Equatable, Sendable {
    case invalidServerProjection
    case invalidCommand
    case pickerCommandPending
    case differentCorrectionPending
    case identityMismatch
}

public enum ManagerOrderReplanningConflictDisposition: Equatable, Sendable {
    case retrySameCommand
    case quarantineStaleProjection

    public static func forServerCode(_ code: String) -> Self {
        terminalProjectionCodes.contains(code)
            ? .quarantineStaleProjection : .retrySameCommand
    }

    private static let terminalProjectionCodes: Set<String> = [
        "OPERATIONS_ORDER_VERSION_CONFLICT",
        "OPERATIONS_REPLANNING_STATE_INVALID",
        "OPERATIONS_REPLANNING_PROVIDER_INVALID",
        "OPERATIONS_REPLANNING_ORDER_TYPE_INVALID",
        "OPERATIONS_REPLANNING_STATUS_INVALID",
        "OPERATIONS_REPLANNING_RELEASED_RECALL_REQUIRED",
        "OPERATIONS_REPLANNING_PLAN_STATE_INVALID",
        "OPERATIONS_REPLANNING_REVISION_STALE",
        "OPERATIONS_REPLANNING_PHYSICAL_WORK_EXISTS",
        "OPERATIONS_REPLANNING_COMMITMENTS_CHANGED",
        "OPERATIONS_REPLANNING_DOWNSTREAM_EVIDENCE_EXISTS",
        "OPERATIONS_REPLANNING_PLAN_CHANGED",
        "OPERATIONS_REPLANNING_FINGERPRINT_CONFLICT",
        "OPERATIONS_REPLANNING_FINGERPRINT_UNAVAILABLE",
        "OPERATIONS_REPLANNING_INVENTORY_CHANGED",
        "OPERATIONS_REPLANNING_RESERVATION_CHANGED",
        "OPERATIONS_REPLANNING_PROVIDER_COMMITMENT_CHANGED",
        "OPERATIONS_REPLANNING_PACKAGING_CHANGED",
    ]
}

extension ManagerOrderReplanningClientError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidServerProjection:
            "Refresh the order. ClawPilot did not project an exact replanning correction."
        case .invalidCommand:
            "The correction reason or exact server fences are invalid."
        case .pickerCommandPending:
            "Finish the saved pick confirmation or picker handoff for this order before reopening it."
        case .differentCorrectionPending:
            "Resolve the previously saved order correction before starting another one."
        case .identityMismatch:
            "Return to the manager and organization that created this saved correction."
        }
    }
}

public struct ManagerOrderReplanningCommand: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let action: String
    public let organizationId: String
    public let workerEmail: String
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let expectedPlanGlobalId: String
    public let expectedPlanVersion: Int
    public let expectedCorrectionFingerprint: String
    public let reason: String
    public let idempotencyKey: String

    public init(
        order: ManagerOrderDetail,
        organizationId: String,
        workerEmail: String,
        reason: String,
        idempotencyKey: String = UUID().uuidString.lowercased()
    ) throws {
        guard let projection = order.replanningCorrectionAction else {
            throw ManagerOrderReplanningClientError.invalidServerProjection
        }
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedOrganizationId = organizationId.lowercased()
        let normalizedWorkerEmail = workerEmail.lowercased()
        let normalizedIdempotencyKey = idempotencyKey.lowercased()
        let fullIdempotencyKey = "manager-replanning:\(normalizedIdempotencyKey)"
        guard let planGlobalId = projection.expectedPlanGlobalId,
              let planVersion = projection.expectedPlanVersion,
              let fingerprint = projection.expectedCorrectionFingerprint,
              Self.isValid(
                organizationId: normalizedOrganizationId,
                workerEmail: normalizedWorkerEmail,
                orderGlobalId: order.globalId,
                expectedRowVersion: order.rowVersion,
                expectedPlanGlobalId: planGlobalId,
                expectedPlanVersion: planVersion,
                expectedCorrectionFingerprint: fingerprint,
                reason: normalizedReason,
                idempotencyKey: fullIdempotencyKey
              ) else {
            throw ManagerOrderReplanningClientError.invalidCommand
        }
        schemaVersion = 1
        action = "reopen-order-for-replanning"
        self.organizationId = normalizedOrganizationId
        self.workerEmail = normalizedWorkerEmail
        orderGlobalId = order.globalId
        expectedRowVersion = order.rowVersion
        expectedPlanGlobalId = planGlobalId
        expectedPlanVersion = planVersion
        expectedCorrectionFingerprint = fingerprint
        self.reason = normalizedReason
        self.idempotencyKey = fullIdempotencyKey
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, action, organizationId, workerEmail
        case orderGlobalId, expectedRowVersion, expectedPlanGlobalId
        case expectedPlanVersion, expectedCorrectionFingerprint
        case reason, idempotencyKey
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        let action = try values.decode(String.self, forKey: .action)
        let organizationId = try values.decode(String.self, forKey: .organizationId)
        let workerEmail = try values.decode(String.self, forKey: .workerEmail)
        let orderGlobalId = try values.decode(String.self, forKey: .orderGlobalId)
        let expectedRowVersion = try values.decode(Int.self, forKey: .expectedRowVersion)
        let expectedPlanGlobalId = try values.decode(
            String.self,
            forKey: .expectedPlanGlobalId
        )
        let expectedPlanVersion = try values.decode(
            Int.self,
            forKey: .expectedPlanVersion
        )
        let fingerprint = try values.decode(
            String.self,
            forKey: .expectedCorrectionFingerprint
        )
        let reason = try values.decode(String.self, forKey: .reason)
        let idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        guard schemaVersion == 1,
              action == "reopen-order-for-replanning",
              Self.isValid(
                organizationId: organizationId,
                workerEmail: workerEmail,
                orderGlobalId: orderGlobalId,
                expectedRowVersion: expectedRowVersion,
                expectedPlanGlobalId: expectedPlanGlobalId,
                expectedPlanVersion: expectedPlanVersion,
                expectedCorrectionFingerprint: fingerprint,
                reason: reason,
                idempotencyKey: idempotencyKey
              ) else {
            throw ManagerOrderReplanningClientError.invalidCommand
        }
        self.schemaVersion = schemaVersion
        self.action = action
        self.organizationId = organizationId
        self.workerEmail = workerEmail
        self.orderGlobalId = orderGlobalId
        self.expectedRowVersion = expectedRowVersion
        self.expectedPlanGlobalId = expectedPlanGlobalId
        self.expectedPlanVersion = expectedPlanVersion
        expectedCorrectionFingerprint = fingerprint
        self.reason = reason
        self.idempotencyKey = idempotencyKey
    }

    private static func isValid(
        organizationId: String,
        workerEmail: String,
        orderGlobalId: String,
        expectedRowVersion: Int,
        expectedPlanGlobalId: String,
        expectedPlanVersion: Int,
        expectedCorrectionFingerprint: String,
        reason: String,
        idempotencyKey: String
    ) -> Bool {
        UUID(uuidString: organizationId) != nil
            && workerEmail.contains("@")
            && workerEmail.utf8.count <= 254
            && orderGlobalId.range(
                of: #"^gor(?:[0-9]{7}|[0-9a-v]{12})$"#,
                options: .regularExpression
            ) != nil
            && expectedRowVersion >= 0
            && expectedPlanGlobalId.range(
                of: #"^gfp(?:[0-9]{7}|[0-9a-v]{12})$"#,
                options: .regularExpression
            ) != nil
            && expectedPlanVersion >= 1
            && expectedCorrectionFingerprint.range(
                of: #"^[a-f0-9]{64}$"#,
                options: .regularExpression
            ) != nil
            && reason.utf16.count >= 8
            && reason.utf16.count <= 500
            && reason.unicodeScalars.allSatisfy {
                $0.value >= 0x20 && $0.value != 0x7f
            }
            && idempotencyKey.range(
                of: #"^[A-Za-z0-9._:-]{8,200}$"#,
                options: .regularExpression
            ) != nil
    }
}

public struct ManagerOrderReplanningQuarantine: Codable, Equatable, Sendable {
    public let command: ManagerOrderReplanningCommand
    public let code: String
    public let message: String
    public let quarantinedAt: Date

    public init(
        command: ManagerOrderReplanningCommand,
        code: String,
        message: String,
        quarantinedAt: Date
    ) throws {
        let normalizedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCode.isEmpty,
              normalizedCode.utf8.count <= 160,
              !normalizedMessage.isEmpty,
              normalizedMessage.utf8.count <= 1_000,
              quarantinedAt.timeIntervalSince1970.isFinite else {
            throw ManagerOrderReplanningClientError.invalidCommand
        }
        self.command = command
        self.code = normalizedCode
        self.message = normalizedMessage
        self.quarantinedAt = quarantinedAt
    }
}

public struct ManagerOrderReplanningResult: Decodable, Equatable, Sendable {
    public let orderGlobalId: String
    public let orderStatus: String
    public let previousRowVersion: Int
    public let rowVersion: Int
    public let correctionGlobalId: String
    public let cancelledPlanGlobalId: String
    public let releasedLocalReservationCount: Int
    public let releasedProviderCommitmentCount: Int
    public let releasedPackagingClaimCount: Int
    public let providerReads: Int
    public let providerWrites: Int
    public let replayed: Bool

    public func validated(
        for command: ManagerOrderReplanningCommand
    ) throws -> ManagerOrderReplanningResult {
        guard orderGlobalId == command.orderGlobalId,
              orderStatus == "imported",
              previousRowVersion == command.expectedRowVersion,
              rowVersion == previousRowVersion + 1,
              correctionGlobalId.range(
                of: #"^gorc(?:[0-9]{7}|[0-9a-v]{12})$"#,
                options: .regularExpression
              ) != nil,
              cancelledPlanGlobalId == command.expectedPlanGlobalId,
              releasedLocalReservationCount >= 0,
              releasedProviderCommitmentCount >= 0,
              releasedPackagingClaimCount >= 0,
              providerReads == 0,
              providerWrites == 0 else {
            throw PickingContractError.contextMismatch
        }
        return self
    }
}

public struct ManagerPicker: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { email }
    public let email: String
    public let displayName: String?

    public init(email: String, displayName: String?) {
        self.email = email
        self.displayName = displayName
    }
}

public struct PickerPerformanceMetric: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { email }
    public let email: String
    public let displayName: String?
    public let unitsToday: Double
    public let unitsSevenDays: Double
    public let ordersSevenDays: Int
    public let uphToday: Double?
    public let uphSevenDays: Double?

    public init(
        email: String,
        displayName: String?,
        unitsToday: Double,
        unitsSevenDays: Double,
        ordersSevenDays: Int,
        uphToday: Double?,
        uphSevenDays: Double?
    ) {
        self.email = email
        self.displayName = displayName
        self.unitsToday = unitsToday
        self.unitsSevenDays = unitsSevenDays
        self.ordersSevenDays = ordersSevenDays
        self.uphToday = uphToday
        self.uphSevenDays = uphSevenDays
    }
}

public struct ManagerPickAssignmentPerson: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { email }
    public let email: String
    public let displayName: String?
    public let taskCount: Int

    public init(email: String, displayName: String?, taskCount: Int) {
        self.email = email
        self.displayName = displayName
        self.taskCount = taskCount
    }
}

public struct ManagerCurrentPickAssignment: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { orderGlobalId }
    public let orderGlobalId: String
    public let orderNumber: String
    public let rowVersion: Int
    public let orderStatus: String
    public let planGlobalId: String
    public let waveGlobalId: String
    public let warehouseName: String
    public let assignmentState: String
    public let assignedTo: String?
    public let assignedDisplayName: String?
    public let assignedPickers: [ManagerPickAssignmentPerson]
    public let unassignedTaskCount: Int
    public let assignmentFingerprint: String
    public let taskCount: Int
    public let readyTaskCount: Int
    public let pickedTaskCount: Int
    public let requiredUnits: Double
    public let pickedUnits: Double
    public let scanEvidenceTaskCount: Int
    public let countEvidenceTaskCount: Int
    public let assignedAt: String?
    public let latestActivityAt: String
    public let handoffExceptionGlobalId: String?
    public let interventionExceptionGlobalId: String?
    public let managementBlockedReason: String?

    public var pickerLabel: String {
        if assignmentState == "mixed" { return "Mixed assignment" }
        return assignedDisplayName ?? assignedTo ?? "Unassigned"
    }

    public var canManageAssignment: Bool {
        managementBlockedReason == nil
            && taskCount > 0
            && assignmentFingerprint.range(
                of: #"^[a-f0-9]{64}$"#,
                options: .regularExpression
            ) != nil
    }

    public init(
        orderGlobalId: String,
        orderNumber: String,
        rowVersion: Int,
        orderStatus: String,
        planGlobalId: String,
        waveGlobalId: String,
        warehouseName: String,
        assignmentState: String,
        assignedTo: String?,
        assignedDisplayName: String?,
        assignedPickers: [ManagerPickAssignmentPerson],
        unassignedTaskCount: Int,
        assignmentFingerprint: String,
        taskCount: Int,
        readyTaskCount: Int,
        pickedTaskCount: Int,
        requiredUnits: Double,
        pickedUnits: Double,
        scanEvidenceTaskCount: Int,
        countEvidenceTaskCount: Int,
        assignedAt: String?,
        latestActivityAt: String,
        handoffExceptionGlobalId: String?,
        interventionExceptionGlobalId: String?,
        managementBlockedReason: String?
    ) {
        self.orderGlobalId = orderGlobalId
        self.orderNumber = orderNumber
        self.rowVersion = rowVersion
        self.orderStatus = orderStatus
        self.planGlobalId = planGlobalId
        self.waveGlobalId = waveGlobalId
        self.warehouseName = warehouseName
        self.assignmentState = assignmentState
        self.assignedTo = assignedTo
        self.assignedDisplayName = assignedDisplayName
        self.assignedPickers = assignedPickers
        self.unassignedTaskCount = unassignedTaskCount
        self.assignmentFingerprint = assignmentFingerprint
        self.taskCount = taskCount
        self.readyTaskCount = readyTaskCount
        self.pickedTaskCount = pickedTaskCount
        self.requiredUnits = requiredUnits
        self.pickedUnits = pickedUnits
        self.scanEvidenceTaskCount = scanEvidenceTaskCount
        self.countEvidenceTaskCount = countEvidenceTaskCount
        self.assignedAt = assignedAt
        self.latestActivityAt = latestActivityAt
        self.handoffExceptionGlobalId = handoffExceptionGlobalId
        self.interventionExceptionGlobalId = interventionExceptionGlobalId
        self.managementBlockedReason = managementBlockedReason
    }
}

public struct ManagerCompletedPickHistory: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { "\(planGlobalId):\(waveGlobalId):\(pickerEmail)" }
    public let orderGlobalId: String
    public let orderNumber: String
    public let orderStatus: String
    public let planGlobalId: String
    public let waveGlobalId: String
    public let pickerEmail: String
    public let pickerDisplayName: String?
    public let taskCount: Int
    public let unitCount: Double
    public let assignedAt: String
    public let completedAt: String

    public init(
        orderGlobalId: String,
        orderNumber: String,
        orderStatus: String,
        planGlobalId: String,
        waveGlobalId: String,
        pickerEmail: String,
        pickerDisplayName: String?,
        taskCount: Int,
        unitCount: Double,
        assignedAt: String,
        completedAt: String
    ) {
        self.orderGlobalId = orderGlobalId
        self.orderNumber = orderNumber
        self.orderStatus = orderStatus
        self.planGlobalId = planGlobalId
        self.waveGlobalId = waveGlobalId
        self.pickerEmail = pickerEmail
        self.pickerDisplayName = pickerDisplayName
        self.taskCount = taskCount
        self.unitCount = unitCount
        self.assignedAt = assignedAt
        self.completedAt = completedAt
    }
}

public struct ManagerPickManagementWorkspace: Decodable, Equatable, Sendable {
    public let generatedAt: String
    public let current: [ManagerCurrentPickAssignment]
    public let history: [ManagerCompletedPickHistory]
    public let eligiblePickers: [ManagerPicker]
    public let pagination: ManagerPickManagementPagination?

    public init(
        generatedAt: String,
        current: [ManagerCurrentPickAssignment],
        history: [ManagerCompletedPickHistory],
        eligiblePickers: [ManagerPicker],
        pagination: ManagerPickManagementPagination? = nil
    ) {
        self.generatedAt = generatedAt
        self.current = current
        self.history = history
        self.eligiblePickers = eligiblePickers
        self.pagination = pagination
    }
}

public struct ManagerPickManagementPageInfo: Decodable, Equatable, Sendable {
    public let hasMore: Bool
    public let nextCursor: String?

    public init(hasMore: Bool, nextCursor: String?) {
        self.hasMore = hasMore
        self.nextCursor = nextCursor
    }
}

public struct ManagerPickManagementPagination: Decodable, Equatable, Sendable {
    public let current: ManagerPickManagementPageInfo
    public let history: ManagerPickManagementPageInfo

    public init(
        current: ManagerPickManagementPageInfo,
        history: ManagerPickManagementPageInfo
    ) {
        self.current = current
        self.history = history
    }
}

public struct ManagerPickAssignmentCommand: Equatable, Sendable {
    public let orderGlobalId: String
    public let expectedRowVersion: Int
    public let expectedTaskCount: Int
    public let expectedAssignmentFingerprint: String
    public let expectedPreviousAssignedTo: String?
    public let assignedTo: String?
    public let reason: String
    public let idempotencyKey: String

    public init(
        assignment: ManagerCurrentPickAssignment,
        assignedTo: String?,
        reason: String,
        idempotencyKey: String = UUID().uuidString
    ) throws {
        let normalizedPicker = assignedTo?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedKey = idempotencyKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard assignment.canManageAssignment,
              assignment.rowVersion >= 0,
              assignment.taskCount <= 200,
              normalizedReason.isEmpty == false,
              normalizedReason.count <= 500,
              normalizedReason.rangeOfCharacter(from: .controlCharacters) == nil,
              normalizedKey.range(
                of: #"^[A-Za-z0-9._:-]{8,200}$"#,
                options: .regularExpression
              ) != nil else {
            throw PickingContractError.contextMismatch
        }
        self.orderGlobalId = assignment.orderGlobalId
        self.expectedRowVersion = assignment.rowVersion
        self.expectedTaskCount = assignment.taskCount
        self.expectedAssignmentFingerprint = assignment.assignmentFingerprint
        self.expectedPreviousAssignedTo = assignment.assignmentState == "mixed"
            ? "mixed"
            : assignment.assignedTo?.lowercased()
        self.assignedTo = normalizedPicker.flatMap { $0.isEmpty ? nil : $0 }
        self.reason = normalizedReason
        self.idempotencyKey = "manager-pick-assignment:\(normalizedKey)"
    }
}

public struct ManagerPickAssignmentResult: Decodable, Equatable, Sendable {
    public let orderGlobalId: String
    public let orderStatus: String
    public let previousRowVersion: Int
    public let rowVersion: Int
    public let taskCount: Int
    public let previousAssignedTo: String?
    public let assignedTo: String?
    public let interventionExceptionGlobalId: String?
    public let providerWrites: Int
    public let replayed: Bool

    public init(
        orderGlobalId: String,
        orderStatus: String,
        previousRowVersion: Int,
        rowVersion: Int,
        taskCount: Int,
        previousAssignedTo: String?,
        assignedTo: String?,
        interventionExceptionGlobalId: String?,
        providerWrites: Int,
        replayed: Bool
    ) {
        self.orderGlobalId = orderGlobalId
        self.orderStatus = orderStatus
        self.previousRowVersion = previousRowVersion
        self.rowVersion = rowVersion
        self.taskCount = taskCount
        self.previousAssignedTo = previousAssignedTo
        self.assignedTo = assignedTo
        self.interventionExceptionGlobalId = interventionExceptionGlobalId
        self.providerWrites = providerWrites
        self.replayed = replayed
    }

    public func validated(
        for command: ManagerPickAssignmentCommand
    ) throws -> ManagerPickAssignmentResult {
        guard orderGlobalId == command.orderGlobalId,
              orderStatus == "released",
              previousRowVersion == command.expectedRowVersion,
              rowVersion == previousRowVersion + 1,
              taskCount == command.expectedTaskCount,
              previousAssignedTo?.lowercased()
                == command.expectedPreviousAssignedTo?.lowercased(),
              assignedTo?.lowercased() == command.assignedTo?.lowercased(),
              providerWrites == 0,
              command.assignedTo != nil || interventionExceptionGlobalId != nil else {
            throw PickingContractError.contextMismatch
        }
        return self
    }
}

public actor PickingAPIClient {
    private struct QueueEnvelope: Decodable {
        let ok: Bool
        let queue: PickQueue?
        let pendingConfirmation: PendingConfirmationRecheck?
        let code: String?
        let error: String?
    }

    private struct BasicEnvelope: Decodable {
        let ok: Bool
        let code: String?
        let error: String?
    }

    private struct PickHandoffEnvelope: Decodable {
        let ok: Bool
        let result: PickHandoffResult?
        let code: String?
        let error: String?
    }

    private struct GooglePolicyEnvelope: Decodable {
        let ok: Bool
        let policy: GoogleAuthState?
        let code: String?
        let error: String?
    }

    private struct GoogleLinkEnvelope: Decodable {
        let ok: Bool
        let identity: GoogleIdentityLinkState?
        let code: String?
        let error: String?
    }

    private struct GoogleLinkBody: Encodable {
        let idToken: String
    }

    private struct WorkspaceSwitchBody: Encodable {
        let action: String
        let organizationId: String
    }

    private struct ManagerOperationsEnvelope: Decodable {
        struct Workspace: Decodable {
            let orders: [ManagerOrderSummary]
            let selectedOrder: ManagerOrderDetail?
            let storeSync: [ManagerStoreSyncControl]?
            let capabilities: ManagerOperationsCapabilities?
        }

        let ok: Bool
        let operations: Workspace?
        let code: String?
        let error: String?
    }

    private struct ManagerStoreSyncEnvelope: Decodable {
        let ok: Bool
        let result: ManagerStoreSyncUpdateResult?
        let code: String?
        let error: String?
    }

    private struct ManagerShopifyCheckoutRateSetupEnvelope: Decodable {
        struct Setup: Decodable {
            struct Account: Decodable {
                let globalId: String
                let provider: String
                let environment: String
                let displayName: String
                let status: String
            }

            struct SavedControl: Decodable {
                let version: String
                let audience: ManagerShopifyCheckoutAudience
                let rateSource: ManagerShopifyCheckoutRateSource
            }

            struct Config: Decodable {
                let globalId: String
                let rowVersion: Int
                let policyRevision: Int
                let checkoutRateControl: SavedControl
            }

            struct OperatingProfile: Decodable {
                let desiredAudience: ManagerShopifyCheckoutAudience?
                let desiredRateSource: ManagerShopifyCheckoutRateSource?
                let effectiveState: ManagerShopifyCheckoutEffectiveState
                let effectiveReason: ManagerShopifyCheckoutEffectiveReason
                let serving: Bool
                let emergencyOverride: Bool
            }

            let account: Account
            let config: Config?
            let checkoutRateLastChange: ManagerShopifyCheckoutRateLastChange?
            let checkoutRateOperatingProfile: OperatingProfile
            let canActivate: Bool
            let canManage: Bool

            func validatedControl() throws -> ManagerShopifyCheckoutRateControl {
                if let config {
                    guard config.checkoutRateControl.version
                            == "shopify-checkout-rate-control-v1",
                          checkoutRateOperatingProfile.desiredAudience
                            == config.checkoutRateControl.audience,
                          checkoutRateOperatingProfile.desiredRateSource
                            == config.checkoutRateControl.rateSource else {
                        throw PickingAPIError.invalidResponse
                    }
                }
                let control = ManagerShopifyCheckoutRateControl(
                    accountGlobalId: account.globalId,
                    provider: account.provider,
                    environment: account.environment,
                    displayName: account.displayName,
                    accountStatus: account.status,
                    configGlobalId: config?.globalId,
                    rowVersion: config?.rowVersion,
                    policyRevision: config?.policyRevision,
                    desiredAudience: checkoutRateOperatingProfile.desiredAudience,
                    desiredRateSource: checkoutRateOperatingProfile.desiredRateSource,
                    effectiveState: checkoutRateOperatingProfile.effectiveState,
                    effectiveReason: checkoutRateOperatingProfile.effectiveReason,
                    serving: checkoutRateOperatingProfile.serving,
                    emergencyOverride: checkoutRateOperatingProfile.emergencyOverride,
                    canActivate: canActivate,
                    canManage: canManage,
                    lastChange: checkoutRateLastChange
                )
                guard control.isContractValid else {
                    throw PickingAPIError.invalidResponse
                }
                return control
            }
        }

        let ok: Bool
        let setup: Setup?
        let code: String?
        let error: String?
    }

    private struct ManagerShopifyCheckoutRateCommandEnvelope: Decodable {
        let ok: Bool
        let result: ManagerShopifyCheckoutRateCommandResult?
        let code: String?
        let error: String?
    }

    private struct PickerEnvelope: Decodable {
        let ok: Bool
        let pickers: [ManagerPicker]?
        let code: String?
        let error: String?
    }

    private struct PickerPerformanceEnvelope: Decodable {
        let ok: Bool
        let metrics: [PickerPerformanceMetric]?
        let code: String?
        let error: String?
    }

    private struct PickManagementEnvelope: Decodable {
        let ok: Bool
        let pickManagement: ManagerPickManagementWorkspace?
        let code: String?
        let error: String?
    }

    private struct ManagerPickAssignmentEnvelope: Decodable {
        let ok: Bool
        let result: ManagerPickAssignmentResult?
        let code: String?
        let error: String?
    }

    private struct ManagerOrderReplanningEnvelope: Decodable {
        let ok: Bool
        let result: ManagerOrderReplanningResult?
        let code: String?
        let error: String?
    }

    private struct ManagerOrderCommandBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let assignedTo: String
        let reason: String
    }

    private struct ManagerPickAssignmentBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let expectedTaskCount: Int
        let expectedAssignmentFingerprint: String
        let assignedTo: String?
        let reason: String
    }

    private struct ManagerOrderReplanningBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let expectedPlanGlobalId: String
        let expectedPlanVersion: Int
        let expectedCorrectionFingerprint: String
        let reason: String
    }

    private struct ManagerStoreSyncBody: Encodable {
        let action: String
        let accountGlobalId: String
        let desiredState: ManagerStoreSyncDesiredState
        let expectedDesiredState: ManagerStoreSyncDesiredState
        let expectedRevision: Int
        let reason: String
    }

    private struct ManagerShopifyCheckoutRateBody: Encodable {
        struct SavedControl: Encodable {
            let version = "shopify-checkout-rate-control-v1"
            let audience: ManagerShopifyCheckoutAudience
            let rateSource: ManagerShopifyCheckoutRateSource
        }

        let action = "save-checkout-rate-control"
        let accountGlobalId: String
        let expectedRowVersion: Int
        let checkoutRateControl: SavedControl
        let reason: String

        init(command: ManagerShopifyCheckoutRateCommand) {
            accountGlobalId = command.accountGlobalId
            expectedRowVersion = command.expectedRowVersion
            checkoutRateControl = SavedControl(
                audience: command.desiredAudience,
                rateSource: command.desiredRateSource
            )
            reason = command.reason
        }
    }

    private struct ConfirmBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let reason: String
        let scanEvidenceIdempotencyKey: String?
        let countEvidenceIdempotencyKey: String?
        let countEvidence: [PickTaskCountEvidence]?
    }

    private struct ScanEvidenceBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let scanEvidence: [PickTaskScanEvidence]
    }

    private struct PickHandoffBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let expectedAssignedTaskCount: Int
        let reason: String
        let blockedConfirmationIdempotencyKey: String?
    }

    public nonisolated let webOrigin: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var authenticatedMutationInFlight = false
    private var authenticatedMutationWaiters: [CheckedContinuation<Void, Never>] = []

    public init(origin: URL, session: URLSession? = nil, allowDebugHTTP: Bool = false) throws {
        guard origin.path.isEmpty || origin.path == "/",
              origin.query == nil,
              origin.fragment == nil,
              origin.user == nil,
              origin.password == nil,
              (origin.scheme == "https" || (allowDebugHTTP && origin.scheme == "http")) else {
            throw PickingAPIError.invalidOrigin
        }
        self.webOrigin = origin
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.httpShouldSetCookies = true
            configuration.httpCookieStorage = .shared
            HTTPCookieStorage.shared.cookieAcceptPolicy = .always
            self.session = URLSession(configuration: configuration)
        }
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .clawPilotFractionalISO8601
        decoder.dateDecodingStrategy = .iso8601
    }

    public func requestMagicCode(email: String) async throws {
        try await postAuth(path: "/api/auth/magic/request", body: ["email": email])
    }

    public func verifyMagicCode(email: String, code: String) async throws {
        try await postAuth(
            path: "/api/auth/magic/verify",
            body: ["email": email, "code": code]
        )
    }

    public func verifyGoogleIdentityToken(_ idToken: String) async throws {
        try await postAuth(
            path: "/api/auth/google/native",
            body: ["idToken": idToken]
        )
    }

    public func fetchGoogleAuthState() async throws -> GoogleAuthState {
        var request = URLRequest(url: try endpoint("/api/auth/google/policy"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(GooglePolicyEnvelope.self, from: data)
        guard envelope.ok, let policy = envelope.policy else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "GOOGLE_SSO_POLICY_UNAVAILABLE",
                message: envelope.error ?? "Google sign-in settings are unavailable"
            )
        }
        return policy
    }

    public func linkGoogleIdentityToken(
        _ idToken: String,
        idempotencyKey: String
    ) async throws -> GoogleIdentityLinkState {
        var request = URLRequest(url: try endpoint("/api/auth/google/link"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(GoogleLinkBody(
            idToken: idToken
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
            throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
        }
        let envelope = try decoder.decode(GoogleLinkEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode), envelope.ok, let identity = envelope.identity else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "GOOGLE_SSO_LINK_UNAVAILABLE",
                message: envelope.error ?? "Google account linking is unavailable"
            )
        }
        return identity
    }

    public func fetchSessionProfile() async throws -> ClawPilotSessionProfile {
        var request = URLRequest(url: try endpoint("/api/auth/session"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        return try decoder.decode(ClawPilotSessionProfile.self, from: data)
    }

    public func switchWorkspace(to organizationId: String) async throws {
        await beginAuthenticatedMutation()
        defer { finishAuthenticatedMutation() }
        var request = URLRequest(url: try endpoint("/api/auth/workspace"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(WorkspaceSwitchBody(
            action: "switch",
            organizationId: organizationId
        ))
        attachStoredCookies(to: &request)
        // Only workspace rotation uses a non-cookie-handling transport. Normal
        // authenticated requests keep URLSession's automatic request Cookie
        // header behavior. This isolated request sends the current cookie
        // explicitly, then installs Set-Cookie only after the generation fence.
        let workspaceConfiguration = session.configuration
        workspaceConfiguration.httpShouldSetCookies = false
        let workspaceSession = URLSession(configuration: workspaceConfiguration)
        defer { workspaceSession.finishTasksAndInvalidate() }
        let (data, response) = try await workspaceSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        let envelope = try? decoder.decode(BasicEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode), let envelope else {
            throw PickingAPIError.rejected(
                code: envelope?.code ?? "WORKSPACE_SWITCH_FAILED",
                message: envelope?.error ?? "The organization could not be changed"
            )
        }
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "WORKSPACE_SWITCH_FAILED",
                message: envelope.error ?? "The organization could not be changed"
            )
        }
        // Workspace switching rotates the durable browser-session token. The
        // authenticated-mutation gate keeps logout behind this installation so
        // its POST revokes the newly rotated session rather than the obsolete
        // token that authorized this request.
        persistResponseCookies(response)
    }

    public func logout() async throws {
        await beginAuthenticatedMutation()
        defer { finishAuthenticatedMutation() }
        var request = URLRequest(url: try endpoint("/api/auth/logout"))
        request.httpMethod = "POST"
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "AUTH_LOGOUT_FAILED",
                message: envelope.error ?? "Sign out failed"
            )
        }
    }

    private func beginAuthenticatedMutation() async {
        guard authenticatedMutationInFlight else {
            authenticatedMutationInFlight = true
            return
        }
        await withCheckedContinuation { continuation in
            authenticatedMutationWaiters.append(continuation)
        }
    }

    private func finishAuthenticatedMutation() {
        guard !authenticatedMutationWaiters.isEmpty else {
            authenticatedMutationInFlight = false
            return
        }
        authenticatedMutationWaiters.removeFirst().resume()
    }

    public func fetchQueue() async throws -> PickQueue {
        var request = URLRequest(url: try endpoint("/api/operations/picks"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(QueueEnvelope.self, from: data)
        guard envelope.ok, let queue = envelope.queue else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_WEARABLE_PICKING_FAILED",
                message: envelope.error ?? "Pick queue unavailable"
            )
        }
        return queue
    }

    public func recheckPendingConfirmation(
        _ command: ConfirmPicksCommand
    ) async throws -> PendingConfirmationRecheckResult {
        try await recheckPendingConfirmation(
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            idempotencyKey: command.idempotencyKey
        )
    }

    public func recheckPendingConfirmation(
        for handoff: PickHandoffCommand
    ) async throws -> PendingConfirmationRecheckResult {
        guard let blockedConfirmationIdempotencyKey =
                handoff.blockedConfirmationIdempotencyKey else {
            throw PickingAPIError.invalidResponse
        }
        return try await recheckPendingConfirmation(
            orderGlobalId: handoff.orderGlobalId,
            expectedRowVersion: handoff.expectedRowVersion,
            idempotencyKey: blockedConfirmationIdempotencyKey
        )
    }

    private func recheckPendingConfirmation(
        orderGlobalId: String,
        expectedRowVersion: Int,
        idempotencyKey: String
    ) async throws -> PendingConfirmationRecheckResult {
        var components = URLComponents(
            url: try endpoint("/api/operations/picks"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(
                name: "pendingConfirmationOrderGlobalId",
                value: orderGlobalId
            ),
            URLQueryItem(
                name: "pendingConfirmationExpectedRowVersion",
                value: String(expectedRowVersion)
            ),
            URLQueryItem(
                name: "pendingConfirmationIdempotencyKey",
                value: idempotencyKey
            ),
        ]
        guard let url = components.url else { throw PickingAPIError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(QueueEnvelope.self, from: data)
        guard envelope.ok,
              let queue = envelope.queue,
              let pending = envelope.pendingConfirmation,
              pending.orderGlobalId == orderGlobalId,
              pending.expectedRowVersion == expectedRowVersion else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_PENDING_CONFIRMATION_RECHECK_FAILED",
                message: envelope.error ?? "Pending confirmation status is unavailable"
            )
        }
        return PendingConfirmationRecheckResult(
            queue: queue,
            pendingConfirmation: pending
        )
    }

    public func fetchManagerOrders() async throws -> [ManagerOrderSummary] {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(ManagerOperationsEnvelope.self, from: data)
        guard envelope.ok, let operations = envelope.operations else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_MANAGER_FAILED",
                message: envelope.error ?? "Manager orders are unavailable"
            )
        }
        return operations.orders
    }

    public func fetchManagerOperations() async throws -> ManagerOperationsOverview {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(ManagerOperationsEnvelope.self, from: data)
        guard envelope.ok,
              let operations = envelope.operations,
              let controls = operations.storeSync,
              let capabilities = operations.capabilities,
              controls.allSatisfy(\.isContractValid),
              Set(controls.map(\.accountGlobalId)).count == controls.count else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_MANAGER_FAILED",
                message: envelope.error ?? "Manager Operations controls are unavailable"
            )
        }
        return ManagerOperationsOverview(
            orders: operations.orders,
            storeSync: controls,
            capabilities: capabilities
        )
    }

    public func updateManagerStoreSync(
        _ command: ManagerStoreSyncCommand
    ) async throws -> ManagerStoreSyncControl {
        await beginAuthenticatedMutation()
        defer { finishAuthenticatedMutation() }
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ManagerStoreSyncBody(
            action: command.action,
            accountGlobalId: command.accountGlobalId,
            desiredState: command.desiredState,
            expectedDesiredState: command.expectedDesiredState,
            expectedRevision: command.expectedRevision,
            reason: command.reason
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        let envelope = try? decoder.decode(ManagerStoreSyncEnvelope.self, from: data)
        if http.statusCode == 409 {
            throw PickingAPIError.conflict(
                code: envelope?.code ?? "COMMERCE_STORE_SYNC_REVISION_CONFLICT",
                message: envelope?.error
                    ?? "Store sync changed after it was reviewed. Refresh and choose again."
            )
        }
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let result = envelope.result else {
            if http.statusCode == 401 { throw PickingAPIError.unauthorized }
            if http.statusCode == 429 {
                let seconds = Int(
                    http.value(forHTTPHeaderField: "Retry-After") ?? ""
                ) ?? 60
                throw PickingAPIError.rateLimited(
                    retryAfterSeconds: max(1, seconds)
                )
            }
            if (400..<500).contains(http.statusCode) {
                throw PickingAPIError.rejected(
                    code: envelope?.code ?? "COMMERCE_STORE_SYNC_UPDATE_REJECTED",
                    message: envelope?.error ?? "Store sync was not changed"
                )
            }
            throw PickingAPIError.invalidResponse
        }
        return try result.validated(for: command)
    }

    public func fetchManagerShopifyCheckoutRateControl(
        accountGlobalId: String
    ) async throws -> ManagerShopifyCheckoutRateControl {
        var components = URLComponents(
            url: try endpoint(
                "/api/integrations/commerce/shopify/carrier-service"
            ),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "accountGlobalId", value: accountGlobalId),
        ]
        guard let url = components.url else {
            throw PickingAPIError.invalidOrigin
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        let envelope = try? decoder.decode(
            ManagerShopifyCheckoutRateSetupEnvelope.self,
            from: data
        )
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(
                http.value(forHTTPHeaderField: "Retry-After") ?? ""
            ) ?? 60
            throw PickingAPIError.rateLimited(
                retryAfterSeconds: max(1, seconds)
            )
        }
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let setup = envelope.setup else {
            if (400..<500).contains(http.statusCode) {
                throw PickingAPIError.rejected(
                    code: envelope?.code
                        ?? "SHOPIFY_CHECKOUT_RATE_CONTROL_READ_REJECTED",
                    message: envelope?.error
                        ?? "Shopify checkout-rate controls are unavailable"
                )
            }
            throw PickingAPIError.invalidResponse
        }
        let control = try setup.validatedControl()
        guard control.accountGlobalId == accountGlobalId else {
            throw PickingAPIError.invalidResponse
        }
        return control
    }

    public func updateManagerShopifyCheckoutRateControl(
        _ command: ManagerShopifyCheckoutRateCommand
    ) async throws -> ManagerShopifyCheckoutRateCommandResult {
        await beginAuthenticatedMutation()
        defer { finishAuthenticatedMutation() }
        var request = URLRequest(url: try endpoint(
            "/api/integrations/commerce/shopify/carrier-service"
        ))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            command.idempotencyKey,
            forHTTPHeaderField: "Idempotency-Key"
        )
        request.httpBody = try encoder.encode(
            ManagerShopifyCheckoutRateBody(command: command)
        )
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        let envelope = try? decoder.decode(
            ManagerShopifyCheckoutRateCommandEnvelope.self,
            from: data
        )
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(
                http.value(forHTTPHeaderField: "Retry-After") ?? ""
            ) ?? 60
            throw PickingAPIError.rateLimited(
                retryAfterSeconds: max(1, seconds)
            )
        }
        if http.statusCode == 409 {
            throw PickingAPIError.conflict(
                code: envelope?.code
                    ?? "SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT",
                message: envelope?.error
                    ?? "Shopify checkout-rate settings changed after review. Refresh and choose again."
            )
        }
        if (400..<500).contains(http.statusCode),
           http.statusCode != 408,
           http.statusCode != 425 {
            throw PickingAPIError.rejected(
                code: envelope?.code
                    ?? "SHOPIFY_CHECKOUT_RATE_CONTROL_UPDATE_REJECTED",
                message: envelope?.error
                    ?? "Shopify checkout-rate settings were not changed"
            )
        }
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let result = envelope.result else {
            // 408, 425, 5xx, transport failures, and malformed success bodies
            // are intentionally ambiguous. The caller retains this exact
            // command and may re-POST the same key and sorted JSON bytes.
            throw PickingAPIError.invalidResponse
        }
        return try result.validated(for: command)
    }

    public func fetchManagerOrderDetail(_ orderGlobalId: String) async throws -> ManagerOrderDetail {
        var components = URLComponents(url: try endpoint("/api/operations"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "order", value: orderGlobalId)]
        guard let url = components.url else { throw PickingAPIError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(ManagerOperationsEnvelope.self, from: data)
        guard envelope.ok, let detail = envelope.operations?.selectedOrder else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_ORDER_FAILED",
                message: envelope.error ?? "Order details are unavailable"
            )
        }
        return detail
    }

    public func fetchManagerPickers() async throws -> [ManagerPicker] {
        var request = URLRequest(url: try endpoint("/api/operations/pickers"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(PickerEnvelope.self, from: data)
        guard envelope.ok, let pickers = envelope.pickers else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_PICKERS_FAILED",
                message: envelope.error ?? "Picker list is unavailable"
            )
        }
        return pickers
    }

    public func fetchPickerPerformance() async throws -> [PickerPerformanceMetric] {
        var request = URLRequest(url: try endpoint("/api/operations/picker-performance"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(PickerPerformanceEnvelope.self, from: data)
        guard envelope.ok, let metrics = envelope.metrics else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_PERFORMANCE_FAILED",
                message: envelope.error ?? "Picker performance is unavailable"
            )
        }
        return metrics
    }

    public func fetchManagerPickManagement() async throws -> ManagerPickManagementWorkspace {
        let first = try await fetchManagerPickManagementPage()
        if first.pagination == nil,
           first.current.count >= 100 || first.history.count >= 100 {
            // Older servers did not expose page metadata. Refuse an exactly
            // full legacy page rather than silently presenting a truncated
            // manager workspace as complete.
            throw PickingAPIError.invalidResponse
        }
        var current = first.current
        var currentIds = Set(current.map(\.id))
        var history = first.history
        var historyIds = Set(history.map(\.id))
        var currentCursor = try nextPickManagementCursor(
            first.pagination?.current
        )
        var historyCursor = try nextPickManagementCursor(
            first.pagination?.history
        )
        var seenCurrentCursors = Set<String>()
        var seenHistoryCursors = Set<String>()

        while let cursor = currentCursor {
            guard seenCurrentCursors.count < 10_000,
                  seenCurrentCursors.insert(cursor).inserted else {
                throw PickingAPIError.invalidResponse
            }
            let page = try await fetchManagerPickManagementPage(
                section: "current",
                cursor: cursor
            )
            for assignment in page.current where currentIds.insert(assignment.id).inserted {
                current.append(assignment)
            }
            currentCursor = try nextPickManagementCursor(
                page.pagination?.current
            )
        }

        while let cursor = historyCursor {
            guard seenHistoryCursors.count < 10_000,
                  seenHistoryCursors.insert(cursor).inserted else {
                throw PickingAPIError.invalidResponse
            }
            let page = try await fetchManagerPickManagementPage(
                section: "history",
                cursor: cursor
            )
            for item in page.history where historyIds.insert(item.id).inserted {
                history.append(item)
            }
            historyCursor = try nextPickManagementCursor(
                page.pagination?.history
            )
        }

        return ManagerPickManagementWorkspace(
            generatedAt: first.generatedAt,
            current: current,
            history: history,
            eligiblePickers: first.eligiblePickers,
            pagination: ManagerPickManagementPagination(
                current: ManagerPickManagementPageInfo(
                    hasMore: false,
                    nextCursor: nil
                ),
                history: ManagerPickManagementPageInfo(
                    hasMore: false,
                    nextCursor: nil
                )
            )
        )
    }

    private func fetchManagerPickManagementPage(
        section: String? = nil,
        cursor: String? = nil
    ) async throws -> ManagerPickManagementWorkspace {
        var components = URLComponents(
            url: try endpoint("/api/operations/pick-management"),
            resolvingAgainstBaseURL: false
        )
        if let section {
            let cursorName = section == "current"
                ? "currentCursor"
                : "historyCursor"
            components?.queryItems = [
                URLQueryItem(name: "section", value: section),
                URLQueryItem(name: cursorName, value: cursor),
            ]
        }
        guard let url = components?.url else {
            throw PickingAPIError.invalidOrigin
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(PickManagementEnvelope.self, from: data)
        guard envelope.ok, let workspace = envelope.pickManagement else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_PICK_MANAGEMENT_FAILED",
                message: envelope.error ?? "Picker assignments are unavailable"
            )
        }
        return workspace
    }

    private func nextPickManagementCursor(
        _ page: ManagerPickManagementPageInfo?
    ) throws -> String? {
        guard let page, page.hasMore else { return nil }
        guard let cursor = page.nextCursor,
              cursor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            throw PickingAPIError.invalidResponse
        }
        return cursor
    }

    public func managePickerAssignment(
        _ command: ManagerPickAssignmentCommand
    ) async throws -> ManagerPickAssignmentResult {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ManagerPickAssignmentBody(
            action: "manage-pick-assignment",
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            expectedTaskCount: command.expectedTaskCount,
            expectedAssignmentFingerprint: command.expectedAssignmentFingerprint,
            assignedTo: command.assignedTo,
            reason: command.reason
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        let envelope = try? decoder.decode(ManagerPickAssignmentEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let result = envelope.result else {
            if let envelope {
                throw PickingAPIError.rejected(
                    code: envelope.code ?? "OPERATIONS_PICK_MANAGEMENT_FAILED",
                    message: envelope.error ?? "Picker assignment could not be changed"
                )
            }
            if http.statusCode == 401 { throw PickingAPIError.unauthorized }
            if http.statusCode == 429 {
                let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
                throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
            }
            throw PickingAPIError.invalidResponse
        }
        return try result.validated(for: command)
    }

    public func releaseManagerOrder(
        _ order: ManagerOrderDetail,
        assignedTo: String,
        reason: String
    ) async throws {
        try await managerOrderCommand(
            action: "release-order",
            order: order,
            assignedTo: assignedTo,
            reason: reason
        )
    }

    public func assignManagerOrder(
        _ order: ManagerOrderDetail,
        assignedTo: String,
        reason: String
    ) async throws {
        try await managerOrderCommand(
            action: "assign-picks",
            order: order,
            assignedTo: assignedTo,
            reason: reason
        )
    }

    public func reopenManagerOrderForReplanning(
        _ command: ManagerOrderReplanningCommand
    ) async throws -> ManagerOrderReplanningResult {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ManagerOrderReplanningBody(
            action: command.action,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            expectedPlanGlobalId: command.expectedPlanGlobalId,
            expectedPlanVersion: command.expectedPlanVersion,
            expectedCorrectionFingerprint: command.expectedCorrectionFingerprint,
            reason: command.reason
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        let envelope = try? decoder.decode(
            ManagerOrderReplanningEnvelope.self,
            from: data
        )
        if http.statusCode == 409 {
            throw PickingAPIError.conflict(
                code: envelope?.code ?? "OPERATIONS_UNCLASSIFIED_CONFLICT",
                message: envelope?.error
                    ?? "The order changed after this correction was reviewed."
            )
        }
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let result = envelope.result else {
            if let envelope {
                throw PickingAPIError.rejected(
                    code: envelope.code ?? "OPERATIONS_REPLANNING_FAILED",
                    message: envelope.error ?? "The order could not be reopened."
                )
            }
            if http.statusCode == 401 { throw PickingAPIError.unauthorized }
            if http.statusCode == 429 {
                let seconds = Int(
                    http.value(forHTTPHeaderField: "Retry-After") ?? ""
                ) ?? 60
                throw PickingAPIError.rateLimited(
                    retryAfterSeconds: max(1, seconds)
                )
            }
            throw PickingAPIError.invalidResponse
        }
        return try result.validated(for: command)
    }

    public func confirm(_ command: ConfirmPicksCommand) async throws {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ConfirmBody(
            action: command.action,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            reason: command.reason,
            scanEvidenceIdempotencyKey: command.scanEvidenceIdempotencyKey,
            countEvidenceIdempotencyKey: command.countEvidenceIdempotencyKey,
            countEvidence: command.countEvidence
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
            throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
        }
        if !(200..<300).contains(http.statusCode) {
            if let envelope = try? decoder.decode(BasicEnvelope.self, from: data),
               let code = envelope.code,
               let message = envelope.error {
                throw PickingAPIError.rejected(code: code, message: message)
            }
            throw PickingAPIError.invalidResponse
        }
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_REQUEST_FAILED",
                message: envelope.error ?? "Pick confirmation failed"
            )
        }
    }

    public func requestPickHandoff(
        _ command: PickHandoffCommand
    ) async throws -> PickHandoffResult {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(PickHandoffBody(
            action: command.action,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            expectedAssignedTaskCount: command.expectedAssignedTaskCount,
            reason: command.reason,
            blockedConfirmationIdempotencyKey: command.blockedConfirmationIdempotencyKey
        ))
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
            throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
        }
        let envelope = try? decoder.decode(PickHandoffEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode),
              let envelope,
              envelope.ok,
              let result = envelope.result else {
            if let envelope {
                throw PickingAPIError.rejected(
                    code: envelope.code ?? "OPERATIONS_PICK_HANDOFF_FAILED",
                    message: envelope.error ?? "Picker handoff could not be requested"
                )
            }
            throw PickingAPIError.invalidResponse
        }
        _ = try result.evidence(for: command)
        return result
    }

    public func recordScanEvidence(_ command: ConfirmPicksCommand) async throws {
        guard let idempotencyKey = command.scanEvidenceIdempotencyKey,
              let scanEvidence = command.scanEvidence,
              !scanEvidence.isEmpty else { return }
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ScanEvidenceBody(
            action: "record-pick-scan-evidence",
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            scanEvidence: scanEvidence
        ))
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_WEARABLE_SCAN_EVIDENCE_FAILED",
                message: envelope.error ?? "Scan evidence could not be acknowledged"
            )
        }
    }

    private func postAuth(path: String, body: [String: String]) async throws {
        var request = URLRequest(url: try endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await authenticatedData(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 429 {
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
            throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
        }
        let envelope = try? decoder.decode(BasicEnvelope.self, from: data)
        guard (200..<300).contains(http.statusCode) else {
            if let envelope, let code = envelope.code {
                throw PickingAPIError.rejected(
                    code: code,
                    message: envelope.error ?? "Authentication failed"
                )
            }
            if http.statusCode == 401 { throw PickingAPIError.unauthorized }
            throw PickingAPIError.invalidResponse
        }
        guard let envelope else { throw PickingAPIError.invalidResponse }
        persistResponseCookies(response)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "AUTH_FAILED",
                message: envelope.error ?? "Authentication failed"
            )
        }
    }

    private func persistResponseCookies(_ response: URLResponse) {
        guard let http = response as? HTTPURLResponse,
              let responseURL = http.url,
              let storage = session.configuration.httpCookieStorage else { return }
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String else { return }
            result[key] = String(describing: entry.value)
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL)
        guard !cookies.isEmpty else { return }
        storage.cookieAcceptPolicy = .always
        storage.setCookies(cookies, for: responseURL, mainDocumentURL: webOrigin)
    }

    private func attachStoredCookies(to request: inout URLRequest) {
        guard let requestURL = request.url,
              let storage = session.configuration.httpCookieStorage,
              let cookies = storage.cookies(for: requestURL),
              !cookies.isEmpty else { return }
        for (field, value) in HTTPCookie.requestHeaderFields(with: cookies) {
            request.setValue(value, forHTTPHeaderField: field)
        }
    }

    private func authenticatedData(
        for originalRequest: URLRequest
    ) async throws -> (Data, URLResponse) {
        var request = originalRequest
        attachStoredCookies(to: &request)
        return try await session.data(for: request)
    }

    private func managerOrderCommand(
        action: String,
        order: ManagerOrderDetail,
        assignedTo: String,
        reason: String
    ) async throws {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ManagerOrderCommandBody(
            action: action,
            orderGlobalId: order.globalId,
            expectedRowVersion: order.rowVersion,
            assignedTo: assignedTo,
            reason: reason
        ))
        let (data, response) = try await authenticatedData(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_COMMAND_FAILED",
                message: envelope.error ?? "The Operations command failed"
            )
        }
    }

    private func endpoint(_ path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: webOrigin)?.absoluteURL,
              url.host == webOrigin.host,
              url.scheme == webOrigin.scheme else {
            throw PickingAPIError.invalidOrigin
        }
        return url
    }

    private func validateHTTP(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw PickingAPIError.invalidResponse
        }
        if http.statusCode == 401 { throw PickingAPIError.unauthorized }
        if http.statusCode == 429 {
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 60
            throw PickingAPIError.rateLimited(retryAfterSeconds: max(1, seconds))
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PickingAPIError.invalidResponse
        }
    }
}

private extension JSONEncoder.DateEncodingStrategy {
    static var clawPilotFractionalISO8601: Self {
        .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
    }
}
