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

    private struct ConfirmBody: Encodable {
        let action: String
        let orderGlobalId: String
        let expectedRowVersion: Int
        let reason: String
    }

    private let origin: URL
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
        self.origin = origin
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

    private func endpoint(_ path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              url.host == origin.host,
              url.scheme == origin.scheme else {
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
