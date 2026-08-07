import Foundation
import ClawPilotPickingCore

public actor DurablePickCache: PickCache {
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL) throws {
        self.directory = directory
        encoder.dateEncodingStrategy = .iso8601
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

    private func read<T: Decodable>(_ type: T.Type, name: String) throws -> T? {
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(type, from: Data(contentsOf: url))
    }

    private func write<T: Encodable>(_ value: T, name: String) throws {
        let data = try encoder.encode(value)
        try data.write(
            to: directory.appendingPathComponent(name),
            options: [.atomic, .completeFileProtection]
        )
    }
}

public enum PickingAPIError: Error, Equatable, Sendable {
    case invalidOrigin
    case unauthorized
    case rateLimited(retryAfterSeconds: Int)
    case rejected(code: String, message: String)
    case invalidResponse
}

extension PickingAPIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidOrigin: "The ClawPilot server address is invalid."
        case .unauthorized: "Sign in to continue."
        case .rateLimited(let seconds): "Too many code requests. Try again in \(seconds) seconds."
        case .rejected(_, let message): message
        case .invalidResponse: "ClawPilot returned an unexpected response."
        }
    }
}

public struct ClawPilotSessionProfile: Decodable, Equatable, Sendable {
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

    public init(
        user: String,
        effectiveUser: EffectiveUser,
        mobileCapabilities: MobileCapabilities
    ) {
        self.user = user
        self.effectiveUser = effectiveUser
        self.mobileCapabilities = mobileCapabilities
    }
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
        pickedPickTaskCount: Int
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

public actor PickingAPIClient {
    private struct QueueEnvelope: Decodable {
        let ok: Bool
        let queue: PickQueue?
        let code: String?
        let error: String?
    }

    private struct BasicEnvelope: Decodable {
        let ok: Bool
        let code: String?
        let error: String?
    }

    private struct ManagerOperationsEnvelope: Decodable {
        struct Workspace: Decodable {
            let orders: [ManagerOrderSummary]
            let selectedOrder: ManagerOrderDetail?
        }

        let ok: Bool
        let operations: Workspace?
        let code: String?
        let error: String?
    }

    private struct PickerEnvelope: Decodable {
        let ok: Bool
        let pickers: [ManagerPicker]?
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

    private struct ConfirmBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let reason: String
    }

    public nonisolated let webOrigin: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(origin: URL, session: URLSession = .shared, allowDebugHTTP: Bool = false) throws {
        guard origin.path.isEmpty || origin.path == "/",
              origin.query == nil,
              origin.fragment == nil,
              origin.user == nil,
              origin.password == nil,
              (origin.scheme == "https" || (allowDebugHTTP && origin.scheme == "http")) else {
            throw PickingAPIError.invalidOrigin
        }
        self.webOrigin = origin
        self.session = session
        encoder.dateEncodingStrategy = .iso8601
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

    public func fetchSessionProfile() async throws -> ClawPilotSessionProfile {
        var request = URLRequest(url: try endpoint("/api/auth/session"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response)
        return try decoder.decode(ClawPilotSessionProfile.self, from: data)
    }

    public func logout() async throws {
        var request = URLRequest(url: try endpoint("/api/auth/logout"))
        request.httpMethod = "POST"
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "AUTH_LOGOUT_FAILED",
                message: envelope.error ?? "Sign out failed"
            )
        }
    }

    public func fetchQueue() async throws -> PickQueue {
        var request = URLRequest(url: try endpoint("/api/operations/picks"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
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

    public func fetchManagerOrders() async throws -> [ManagerOrderSummary] {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
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

    public func fetchManagerOrderDetail(_ orderGlobalId: String) async throws -> ManagerOrderDetail {
        var components = URLComponents(url: try endpoint("/api/operations"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "order", value: orderGlobalId)]
        guard let url = components.url else { throw PickingAPIError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
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
        let (data, response) = try await session.data(for: request)
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

    public func confirm(_ command: ConfirmPicksCommand) async throws {
        var request = URLRequest(url: try endpoint("/api/operations"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try encoder.encode(ConfirmBody(
            action: command.action,
            orderGlobalId: command.orderGlobalId,
            expectedRowVersion: command.expectedRowVersion,
            reason: command.reason
        ))
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "OPERATIONS_REQUEST_FAILED",
                message: envelope.error ?? "Pick confirmation failed"
            )
        }
    }

    private func postAuth(path: String, body: [String: String]) async throws {
        var request = URLRequest(url: try endpoint(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response)
        let envelope = try decoder.decode(BasicEnvelope.self, from: data)
        guard envelope.ok else {
            throw PickingAPIError.rejected(
                code: envelope.code ?? "AUTH_FAILED",
                message: envelope.error ?? "Authentication failed"
            )
        }
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
        let (data, response) = try await session.data(for: request)
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
