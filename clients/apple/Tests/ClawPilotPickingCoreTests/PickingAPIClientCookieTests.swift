import Foundation
import Testing
@testable import ClawPilotPickingApple
@testable import ClawPilotPickingCore

private final class CookieResponseURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "Set-Cookie": "__Host-clawpilot_session=test-token; Path=/; Secure; HttpOnly; SameSite=Lax",
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class GoogleLinkRequiredURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"code":"GOOGLE_SSO_LINK_REQUIRED","error":"Sign in with a magic code, then link this Google account in Security settings"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class MagicCodeUnavailableURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 503,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"error":"Unable to send a sign-in code."}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class WorkspaceRejectedURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"error":"Business access is not available"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private actor AsyncTestSignal {
    private var isSignaled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isSignaled else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func signal() {
        isSignaled = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

private final class WorkspaceLogoutRaceURLProtocol: URLProtocol, @unchecked Sendable {
    private static let workspaceRequestStarted = DispatchSemaphore(value: 0)
    private static let workspaceResponseGate = DispatchSemaphore(value: 0)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    static func releaseWorkspaceResponse() {
        workspaceResponseGate.signal()
    }

    static func waitUntilWorkspaceRequestStarts() -> Bool {
        workspaceRequestStarted.wait(timeout: .now() + 2) == .success
    }

    override func startLoading() {
        if request.url?.path == "/api/auth/workspace" {
            Self.workspaceRequestStarted.signal()
            DispatchQueue.global().async { [self] in
                Self.workspaceResponseGate.wait()
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": "application/json",
                        "Set-Cookie": "__Host-clawpilot_session=late-workspace-token; Path=/; Secure; HttpOnly; SameSite=Lax",
                    ]
                )!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
                client?.urlProtocolDidFinishLoading(self)
            }
            return
        }
        let logoutUsesRotatedCookie = request.url?.path == "/api/auth/logout"
            && request.value(forHTTPHeaderField: "Cookie")?.contains(
                "__Host-clawpilot_session=late-workspace-token"
            ) == true
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: logoutUsesRotatedCookie ? 200 : 401,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "Set-Cookie": "__Host-clawpilot_session=; Path=/; Secure; HttpOnly; Max-Age=0; SameSite=Lax",
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data((logoutUsesRotatedCookie
                ? #"{"ok":true}"#
                : #"{"ok":false}"#).utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        Self.workspaceResponseGate.signal()
    }
}

private final class AuthenticatedCookieEchoURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let sentCookie = request.value(forHTTPHeaderField: "Cookie")
        let authorized = sentCookie?.contains(
            "__Host-clawpilot_session=existing-auth-token"
        ) == true
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: authorized ? 200 : 401,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        let body = authorized
            ? #"{"user":"picker@example.com","effectiveUser":{"email":"picker@example.com","displayName":"Picker","role":"member","organizationName":"Test Org","organizationRole":"picker"},"mobileCapabilities":{"canUsePicker":true,"canUseManager":false},"activeWorkspace":{"organizationId":"11111111-1111-4111-8111-111111111111","referenceCode":"test","name":"Test Org","organizationType":"business","role":"picker","isDefault":true},"availableWorkspaces":[{"organizationId":"11111111-1111-4111-8111-111111111111","referenceCode":"test","name":"Test Org","organizationType":"business","role":"picker","isDefault":true}]}"#
            : #"{"ok":false}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class FractionalCountURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let bodyData: Data
        if let body = request.httpBody {
            bodyData = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var collected = Data()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
            defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: 4_096)
                if count <= 0 { break }
                collected.append(buffer, count: count)
            }
            bodyData = collected
        } else {
            bodyData = Data()
        }
        let body = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
        let evidence = (body?["countEvidence"] as? [[String: Any]])?.first
        let product = evidence?["product"] as? [String: Any]
        let capturedAt = product?["capturedAt"] as? String
        let countedAt = evidence?["countedAt"] as? String
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let capturedDate = capturedAt.flatMap(formatter.date(from:))
        let countedDate = countedAt.flatMap(formatter.date(from:))
        let interval = capturedDate.flatMap { captured in
            countedDate.map { $0.timeIntervalSince(captured) }
        }
        let valid = capturedAt?.contains(".") == true
            && countedAt?.contains(".") == true
            && capturedAt != countedAt
            && (interval ?? 0) > 0.3
            && (interval ?? 1) < 0.4
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: valid ? 200 : 422,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class StructuredConfirmationConflictURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 409,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"code":"OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED","error":"Manager reconciliation required"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class PendingConfirmationRecheckURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).map {
            ($0.name, $0.value ?? "")
        })
        let queryIsExact = query["pendingConfirmationOrderGlobalId"] == "gor0000008"
            && query["pendingConfirmationExpectedRowVersion"] == "4"
            && query["pendingConfirmationIdempotencyKey"]?.hasPrefix("wearable-pick:") == true
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: queryIsExact ? 200 : 400,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        let body = queryIsExact
            ? #"{"ok":true,"queue":{"schemaVersion":1,"organizationId":"11111111-1111-4111-8111-111111111111","workerEmail":"picker@example.com","generatedAt":"2026-08-12T14:00:00Z","orders":[]},"pendingConfirmation":{"orderGlobalId":"gor0000008","expectedRowVersion":4,"state":"reconciled_external_fulfillment","code":"OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILED","message":"Manager reconciliation verified","reconciliationGlobalId":"gsfr0000008","providerWrites":0}}"#
            : #"{"ok":false,"code":"BAD_QUERY","error":"Bad query"}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func requestBodyData(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var collected = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4_096)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
        let count = stream.read(buffer, maxLength: 4_096)
        if count <= 0 { break }
        collected.append(buffer, count: count)
    }
    return collected
}

private final class PickHandoffURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = try? JSONSerialization.jsonObject(
            with: requestBodyData(request)
        ) as? [String: Any]
        let valid = request.httpMethod == "POST"
            && request.url?.path == "/api/operations"
            && request.value(forHTTPHeaderField: "Idempotency-Key")
                == "picker-handoff:fixed-handoff"
            && body?["action"] as? String == "request-pick-handoff"
            && body?["orderGlobalId"] as? String == "gor0000008"
            && body?["expectedRowVersion"] as? Int == 4
            && body?["expectedAssignedTaskCount"] as? Int == 1
            && body?["reason"] as? String == "Manager help requested."
            && body?["blockedConfirmationIdempotencyKey"] as? String
                == "wearable-pick:blocked-fixed-key"
            && body?["organizationId"] == nil
            && body?["workerEmail"] == nil
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: valid ? 200 : 422,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        let responseBody = valid
            ? #"{"ok":true,"result":{"orderGlobalId":"gor0000008","orderStatus":"released","previousRowVersion":4,"rowVersion":5,"exceptionGlobalId":"gex0000008","assignedTaskCount":1,"blockedConfirmationIdempotencyKey":"wearable-pick:blocked-fixed-key","providerWrites":0,"replayed":false}}"#
            : #"{"ok":false,"code":"BAD_HANDOFF","error":"Bad handoff"}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class InvalidPickHandoffResultURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":true,"result":{"orderGlobalId":"gor0000008","orderStatus":"released","previousRowVersion":4,"rowVersion":5,"exceptionGlobalId":"gex0000008","assignedTaskCount":2,"blockedConfirmationIdempotencyKey":null,"providerWrites":0,"replayed":false}}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test("native authentication persists the secure session cookie")
func nativeAuthenticationPersistsSessionCookie() async throws {
    let origin = try #require(URL(string: "https://native-auth-cookie.test"))
    let storage = HTTPCookieStorage.shared
    storage.cookies(for: origin)?.forEach(storage.deleteCookie)
    defer { storage.cookies(for: origin)?.forEach(storage.deleteCookie) }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CookieResponseURLProtocol.self]
    configuration.httpCookieStorage = storage
    configuration.httpShouldSetCookies = false
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    try await client.verifyMagicCode(email: "picker@example.com", code: "123456")

    let cookie = try #require(storage.cookies(for: origin)?.first {
        $0.name == "__Host-clawpilot_session"
    })
    #expect(cookie.value == "test-token")
    #expect(cookie.isSecure)
}

@Test("native magic-code requests preserve a code-less service error")
func nativeMagicCodeRequestPreservesServiceError() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MagicCodeUnavailableURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-magic-code-unavailable.test")!,
        session: URLSession(configuration: configuration)
    )

    do {
        try await client.requestMagicCode(email: "picker@example.com")
        Issue.record("Expected the unavailable magic-code request to be rejected")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "AUTH_FAILED",
            message: "Unable to send a sign-in code."
        ))
    }
}

@Test("native workspace switching persists the rotated secure session cookie")
func nativeWorkspaceSwitchPersistsRotatedSessionCookie() async throws {
    let origin = try #require(URL(string: "https://native-workspace-cookie.test"))
    let storage = HTTPCookieStorage.shared
    storage.cookies(for: origin)?.forEach(storage.deleteCookie)
    defer { storage.cookies(for: origin)?.forEach(storage.deleteCookie) }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CookieResponseURLProtocol.self]
    configuration.httpCookieStorage = storage
    configuration.httpShouldSetCookies = false
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    try await client.switchWorkspace(to: "22222222-2222-4222-8222-222222222222")

    let cookie = try #require(storage.cookies(for: origin)?.first {
        $0.name == "__Host-clawpilot_session"
    })
    #expect(cookie.value == "test-token")
    #expect(cookie.isSecure)
}

@Test("native workspace switching preserves the server authorization reason")
func nativeWorkspaceSwitchPreservesAuthorizationReason() async throws {
    let origin = try #require(URL(string: "https://native-workspace-rejection.test"))
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [WorkspaceRejectedURLProtocol.self]
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    do {
        try await client.switchWorkspace(to: "22222222-2222-4222-8222-222222222222")
        Issue.record("Expected a workspace authorization rejection")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "WORKSPACE_SWITCH_FAILED",
            message: "Business access is not available"
        ))
    }
}

@Test("logout waits for workspace rotation and revokes the rotated session")
func logoutSerializesBehindWorkspaceRotation() async throws {
    let origin = try #require(URL(string: "https://native-workspace-logout-race.test"))
    let storage = HTTPCookieStorage.shared
    storage.cookies(for: origin)?.forEach(storage.deleteCookie)
    defer { storage.cookies(for: origin)?.forEach(storage.deleteCookie) }
    let original = try #require(HTTPCookie(properties: [
        .domain: origin.host!,
        .path: "/",
        .name: "__Host-clawpilot_session",
        .value: "original-session-token",
        .secure: "TRUE",
    ]))
    storage.setCookie(original)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [WorkspaceLogoutRaceURLProtocol.self]
    configuration.httpCookieStorage = storage
    configuration.httpShouldSetCookies = true
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    let switching = Task {
        try await client.switchWorkspace(
            to: "22222222-2222-4222-8222-222222222222"
        )
    }
    #expect(WorkspaceLogoutRaceURLProtocol.waitUntilWorkspaceRequestStarts())
    let logoutAttempted = AsyncTestSignal()
    let loggingOut = Task {
        await logoutAttempted.signal()
        try await client.logout()
    }
    await logoutAttempted.wait()
    WorkspaceLogoutRaceURLProtocol.releaseWorkspaceResponse()
    try await switching.value
    try await loggingOut.value
    // The protocol returns 401 unless logout carries the rotated cookie, so
    // successful completion is the server-revocation assertion. A custom
    // URLProtocol does not reliably apply a deletion Set-Cookie to shared
    // storage; the phone logout flow clears that storage explicitly.
    #expect(storage.cookies(for: origin)?.contains(where: {
        $0.name == "__Host-clawpilot_session"
            && $0.value == "late-workspace-token"
    }) == true)
}

@Test("ordinary authenticated requests still send the stored session cookie")
func authenticatedProfileRequestSendsStoredCookie() async throws {
    let origin = try #require(URL(string: "https://native-authenticated-cookie.test"))
    let storage = HTTPCookieStorage.shared
    storage.cookies(for: origin)?.forEach(storage.deleteCookie)
    defer { storage.cookies(for: origin)?.forEach(storage.deleteCookie) }
    let cookie = try #require(HTTPCookie(properties: [
        .domain: origin.host!,
        .path: "/",
        .name: "__Host-clawpilot_session",
        .value: "existing-auth-token",
        .secure: "TRUE",
    ]))
    storage.setCookie(cookie)

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AuthenticatedCookieEchoURLProtocol.self]
    configuration.httpCookieStorage = storage
    configuration.httpShouldSetCookies = true
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    let profile = try await client.fetchSessionProfile()
    #expect(profile.effectiveUser.email == "picker@example.com")
    #expect(profile.activeWorkspace.organizationId
        == "11111111-1111-4111-8111-111111111111")
}

@Test("native Google authentication preserves a structured link-required response")
func nativeGoogleAuthenticationReportsLinkRequired() async throws {
    let origin = try #require(URL(string: "https://native-google-error.test"))
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [GoogleLinkRequiredURLProtocol.self]
    let client = try PickingAPIClient(
        origin: origin,
        session: URLSession(configuration: configuration)
    )

    do {
        try await client.verifyGoogleIdentityToken("signed-google-id-token")
        Issue.record("Expected an unlinked Google identity to be rejected")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "GOOGLE_SSO_LINK_REQUIRED",
            message: "Sign in with a magic code, then link this Google account in Security settings"
        ))
    }
}

@Test("native confirmation preserves a structured non-2xx Operations response")
func nativeConfirmationPreservesStructuredConflict() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StructuredConfirmationConflictURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-confirmation-conflict.test")!,
        session: URLSession(configuration: configuration)
    )
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000008", sequence: 1,
        productGlobalId: "gp0000008", productName: "Eight pack",
        channelSku: "EIGHT", barcode: "888", locationCode: "A-8", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000008", orderNumber: "1008", rowVersion: 4, tasks: [task]
    )

    do {
        try await client.confirm(ConfirmPicksCommand(order: order))
        Issue.record("Expected a structured reconciliation conflict")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED",
            message: "Manager reconciliation required"
        ))
    }
}

@Test("native pending confirmation recheck binds exact order and row version")
func nativePendingConfirmationRecheckIsExactAndReadOnly() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PendingConfirmationRecheckURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-confirmation-recheck.test")!,
        session: URLSession(configuration: configuration)
    )
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000008", sequence: 1,
        productGlobalId: "gp0000008", productName: "Eight pack",
        channelSku: "EIGHT", barcode: "888", locationCode: "A-8", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000008", orderNumber: "1008", rowVersion: 4, tasks: [task]
    )
    let result = try await client.recheckPendingConfirmation(
        ConfirmPicksCommand(order: order)
    )

    #expect(result.queue.orders.isEmpty)
    #expect(result.pendingConfirmation.state == .reconciledExternalFulfillment)
    let evidence = try result.pendingConfirmation.reconciliationEvidence()
    #expect(evidence.orderGlobalId == order.orderGlobalId)
    #expect(evidence.expectedRowVersion == order.rowVersion)
    #expect(evidence.providerWrites == 0)
}

@Test("native picker handoff sends exact durable command and validates exact result")
func nativePickHandoffIsExact() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PickHandoffURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-pick-handoff.test")!,
        session: URLSession(configuration: configuration)
    )
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000008", sequence: 1,
        productGlobalId: "gp0000008", productName: "Eight pack",
        channelSku: "EIGHT", barcode: "888", locationCode: "A-8", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000008", orderNumber: "1008", rowVersion: 4, tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [order]
    )
    let confirmation = ConfirmPicksCommand(
        order: order,
        idempotencyKey: "blocked-fixed-key"
    )
    let command = try PickHandoffCommand(
        queue: queue,
        order: order,
        reason: "Manager help requested.",
        blockedConfirmationIdempotencyKey: confirmation.idempotencyKey,
        idempotencyKey: "fixed-handoff"
    )

    let result = try await client.requestPickHandoff(command)
    let evidence = try result.evidence(for: command)
    #expect(evidence.orderGlobalId == command.orderGlobalId)
    #expect(evidence.rowVersion == 5)
    #expect(evidence.assignedTaskCount == 1)
    #expect(evidence.providerWrites == 0)
}

@Test("native picker handoff rejects a non-exact success envelope")
func nativePickHandoffRejectsMismatchedSuccess() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [InvalidPickHandoffResultURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-pick-handoff-invalid.test")!,
        session: URLSession(configuration: configuration)
    )
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000008", sequence: 1,
        productGlobalId: "gp0000008", productName: "Eight pack",
        channelSku: "EIGHT", barcode: "888", locationCode: "A-8", quantity: 1
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000008", orderNumber: "1008", rowVersion: 4, tasks: [task]
    )
    let queue = try PickQueue(
        schemaVersion: 1,
        organizationId: "11111111-1111-4111-8111-111111111111",
        workerEmail: "picker@example.com",
        generatedAt: Date(),
        orders: [order]
    )
    let command = try PickHandoffCommand(
        queue: queue,
        order: order,
        reason: "Manager help requested.",
        idempotencyKey: "fixed-handoff"
    )

    await #expect(throws: PickingContractError.contextMismatch) {
        _ = try await client.requestPickHandoff(command)
    }
}

@Test("native count evidence keeps fractional ordering on the wire")
func nativeCountEvidencePreservesFractionalOrdering() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FractionalCountURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-count-evidence.test")!,
        session: URLSession(configuration: configuration)
    )
    let task = try PickTask(
        pickTaskGlobalId: "gpk0000008", sequence: 1,
        productGlobalId: "gp0000008", productName: "Eight pack",
        channelSku: "EIGHT", barcode: "888", locationCode: "A-8", quantity: 8
    )
    let order = try PickOrder(
        orderGlobalId: "gor0000008", orderNumber: "1008", rowVersion: 4, tasks: [task]
    )
    let product = try BarcodeObservation(
        value: "888",
        source: .iPhoneCamera,
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000.123)
    )
    let count = try PickTaskCountEvidence(
        task: task,
        enteredQuantity: 8,
        product: product,
        countedAt: Date(timeIntervalSince1970: 1_700_000_000.456),
        countSource: .iPhone
    )
    try await client.confirm(ConfirmPicksCommand(order: order, countEvidence: [count]))
}
