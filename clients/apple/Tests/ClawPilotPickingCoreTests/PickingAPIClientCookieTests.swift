import Foundation
import Testing
@testable import ClawPilotPickingApple

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
