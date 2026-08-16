import Foundation
import Testing
@testable import ClawPilotPickingApple

private let storeSyncControlJSON = #"""
{
  "accountGlobalId":"gia0009801",
  "provider":"shopify",
  "environment":"sandbox",
  "displayName":"Warehouse Shopify",
  "accountStatus":"active",
  "desiredState":"running",
  "effectiveState":"running",
  "effectiveReason":"STORE_SYNC_EXPLICIT_RUNNING",
  "effectiveReasonLabel":"Running by an explicit Store sync choice.",
  "explicitChoice":true,
  "revision":7,
  "reason":"Keep automatic catalog mirroring on",
  "updatedAt":"2026-08-15T20:00:00.000Z"
}
"""#

private func storeSyncRequestBody(_ request: URLRequest) -> Data? {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 8_192)
    defer { buffer.deallocate() }
    var result = Data()
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 8_192)
        if count <= 0 { break }
        result.append(buffer, count: count)
    }
    return result
}

private final class ManagerStoreSyncURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let status: Int
        let responseBody: String
        if request.httpMethod == "GET" {
            status = 200
            responseBody = #"{"ok":true,"operations":{"orders":[],"selectedOrder":null,"capabilities":{"canView":true,"canManage":true,"canExecute":true,"canActivate":true},"storeSync":["#
                + storeSyncControlJSON
                + #"]}}"#
        } else {
            let body = storeSyncRequestBody(request)
                .flatMap { try? JSONSerialization.jsonObject(with: $0) }
                as? [String: Any]
            let valid = request.value(forHTTPHeaderField: "Idempotency-Key")
                    == "store-sync:fixed-command"
                && body?["action"] as? String == "update-commerce-store-sync"
                && body?["accountGlobalId"] as? String == "gia0009801"
                && body?["desiredState"] as? String == "paused"
                && body?["expectedDesiredState"] as? String == "running"
                && body?["expectedRevision"] as? Int == 7
                && body?["reason"] as? String == "Pause seasonal catalog mirroring"
            status = valid ? 200 : 422
            responseBody = valid
                ? #"{"ok":true,"result":{"control":{"accountGlobalId":"gia0009801","provider":"shopify","environment":"sandbox","displayName":"Warehouse Shopify","accountStatus":"active","desiredState":"paused","effectiveState":"paused","effectiveReason":"STORE_SYNC_EXPLICIT_PAUSED","effectiveReasonLabel":"Paused by an explicit Store sync choice.","explicitChoice":true,"revision":8,"reason":"Pause seasonal catalog mirroring","updatedAt":"2026-08-15T20:01:00.000Z"}}}"#
                : #"{"ok":false,"code":"BAD_STORE_SYNC_COMMAND","error":"Bad command"}"#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerStoreSyncLostResponseURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [(String?, Data?)] = []

    static func reset() {
        lock.lock()
        requests = []
        lock.unlock()
    }

    static func captured() -> [(String?, Data?)] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append((
            request.value(forHTTPHeaderField: "Idempotency-Key"),
            storeSyncRequestBody(request)
        ))
        let attempt = Self.requests.count
        Self.lock.unlock()
        if attempt == 1 {
            client?.urlProtocol(
                self,
                didFailWithError: URLError(.networkConnectionLost)
            )
            return
        }
        let body = #"{"ok":true,"result":{"control":{"accountGlobalId":"gia0009801","provider":"shopify","environment":"sandbox","displayName":"Warehouse Shopify","accountStatus":"active","desiredState":"paused","effectiveState":"paused","effectiveReason":"STORE_SYNC_EXPLICIT_PAUSED","effectiveReasonLabel":"Paused by an explicit Store sync choice.","explicitChoice":true,"revision":8,"reason":"Pause seasonal catalog mirroring","updatedAt":"2026-08-15T20:01:00.000Z"}}}"#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerStoreSyncRejectedURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = #"{"ok":false,"code":"COMMERCE_STORE_SYNC_MANAGE_REQUIRED","error":"Store sync administration is required"}"#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerStoreSyncServerFailureURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = #"{"ok":false,"code":"DATABASE_UNAVAILABLE","error":"The result is unavailable"}"#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 503,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func storeSyncClient(
    protocolClass: URLProtocol.Type
) throws -> PickingAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    return try PickingAPIClient(
        origin: URL(string: "https://clawpilot.example")!,
        session: URLSession(configuration: configuration)
    )
}

@Test("manager Store sync decodes desired and effective state separately")
func managerStoreSyncDecodesExactWorkspace() async throws {
    let client = try storeSyncClient(protocolClass: ManagerStoreSyncURLProtocol.self)
    let overview = try await client.fetchManagerOperations()
    #expect(overview.capabilities.canActivate)
    #expect(overview.storeSync.count == 1)
    let control = try #require(overview.storeSync.first)
    #expect(control.desiredState == .running)
    #expect(control.effectiveState == .running)
    #expect(control.effectiveReason == .explicitRunning)
    #expect(control.revision == 7)
}

@Test("manager Store sync sends the exact revision fenced command")
func managerStoreSyncSendsExactCommand() async throws {
    let client = try storeSyncClient(protocolClass: ManagerStoreSyncURLProtocol.self)
    let control = try #require(try await client.fetchManagerOperations().storeSync.first)
    let command = try ManagerStoreSyncCommand(
        control: control,
        desiredState: .paused,
        reason: "  Pause seasonal catalog mirroring  ",
        idempotencyKey: "store-sync:fixed-command"
    )
    let result = try await client.updateManagerStoreSync(command)
    #expect(command.reason == "Pause seasonal catalog mirroring")
    #expect(result.desiredState == .paused)
    #expect(result.effectiveState == .paused)
    #expect(result.revision == 8)
}

@Test("manager Store sync retries a lost response byte identically")
func managerStoreSyncRetriesLostResponseExactly() async throws {
    ManagerStoreSyncLostResponseURLProtocol.reset()
    let decoder = JSONDecoder()
    let control = try decoder.decode(
        ManagerStoreSyncControl.self,
        from: Data(storeSyncControlJSON.utf8)
    )
    let command = try ManagerStoreSyncCommand(
        control: control,
        desiredState: .paused,
        reason: "Pause seasonal catalog mirroring",
        idempotencyKey: "store-sync:lost-response"
    )
    let client = try storeSyncClient(
        protocolClass: ManagerStoreSyncLostResponseURLProtocol.self
    )
    await #expect(throws: Error.self) {
        _ = try await client.updateManagerStoreSync(command)
    }
    _ = try await client.updateManagerStoreSync(command)
    let captured = ManagerStoreSyncLostResponseURLProtocol.captured()
    #expect(captured.count == 2)
    #expect(captured[0].0 == captured[1].0)
    #expect(captured[0].1 == captured[1].1)
}

@Test("manager Store sync classifies a definitive rejection as not applied")
func managerStoreSyncClassifiesDefinitiveRejection() async throws {
    let control = try JSONDecoder().decode(
        ManagerStoreSyncControl.self,
        from: Data(storeSyncControlJSON.utf8)
    )
    let command = try ManagerStoreSyncCommand(
        control: control,
        desiredState: .paused,
        reason: "Pause seasonal catalog mirroring",
        idempotencyKey: "store-sync:definitive-rejection"
    )
    let client = try storeSyncClient(
        protocolClass: ManagerStoreSyncRejectedURLProtocol.self
    )
    do {
        _ = try await client.updateManagerStoreSync(command)
        Issue.record("A definitive 403 rejection was accepted")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "COMMERCE_STORE_SYNC_MANAGE_REQUIRED",
            message: "Store sync administration is required"
        ))
    }
}

@Test("manager Store sync keeps a server failure outcome ambiguous")
func managerStoreSyncKeepsServerFailureAmbiguous() async throws {
    let control = try JSONDecoder().decode(
        ManagerStoreSyncControl.self,
        from: Data(storeSyncControlJSON.utf8)
    )
    let command = try ManagerStoreSyncCommand(
        control: control,
        desiredState: .paused,
        reason: "Pause seasonal catalog mirroring",
        idempotencyKey: "store-sync:server-failure"
    )
    let client = try storeSyncClient(
        protocolClass: ManagerStoreSyncServerFailureURLProtocol.self
    )
    do {
        _ = try await client.updateManagerStoreSync(command)
        Issue.record("A 503 response was accepted")
    } catch let error as PickingAPIError {
        #expect(error == .invalidResponse)
    }
}

@Test("manager Store sync rejects late state after sign-out or workspace replacement")
func managerStoreSyncSubmissionFenceRejectsSupersededSession() {
    let fence = ManagerStoreSyncSubmissionFence(
        authenticationGeneration: 12,
        organizationId: "11111111-1111-4111-8111-111111111111"
    )
    #expect(fence.permitsStateMutation(
        currentAuthenticationGeneration: 12,
        currentOrganizationId: "11111111-1111-4111-8111-111111111111",
        isAuthenticated: true
    ))
    #expect(!fence.permitsStateMutation(
        currentAuthenticationGeneration: 13,
        currentOrganizationId: "11111111-1111-4111-8111-111111111111",
        isAuthenticated: false
    ))
    #expect(!fence.permitsStateMutation(
        currentAuthenticationGeneration: 12,
        currentOrganizationId: "22222222-2222-4222-8222-222222222222",
        isAuthenticated: true
    ))
}

@Test("every Store sync effective reason has one exact effective state")
func managerStoreSyncEffectiveReasonsAreFailClosed() {
    for reason in ManagerStoreSyncEffectiveReason.allCasesForTests {
        switch reason {
        case .explicitRunning, .legacyShadowRunning, .legacyActiveRunning:
            #expect(reason.expectedState == .running)
        default:
            #expect(reason.expectedState == .paused)
        }
    }
}

private extension ManagerStoreSyncEffectiveReason {
    static let allCasesForTests: [Self] = [
        .operationsDisabledOverride,
        .operationsFrozenOverride,
        .controlMissing,
        .accountUnavailable,
        .explicitRunning,
        .explicitPausedDraining,
        .explicitPaused,
        .legacyShadowRunning,
        .legacyActiveRunning,
        .legacyReadOnlyPaused,
    ]
}
