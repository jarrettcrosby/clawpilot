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
