import Foundation
import Testing
@testable import ClawPilotPickingApple

private let checkoutOrganizationId = "11111111-1111-4111-8111-111111111111"
private let checkoutActorEmail = "owner@example.test"

private func checkoutSetupJSON(
    environment: String = "production",
    audience: String = "restricted_customers",
    rateSource: String = "sandbox",
    effectiveState: String = "empty",
    effectiveReason: String = "SHOPIFY_CHECKOUT_PRODUCTION_RATE_SOURCE_REQUIRED",
    canActivate: Bool = true,
    emergencyOverride: Bool = false
) -> String {
    #"{"ok":true,"setup":{"account":{"globalId":"gia0009801","provider":"shopify","environment":""#
        + environment
        + #"","displayName":"Pro Bakery Bites","status":"active"},"config":{"globalId":"gscf0009801","rowVersion":12,"policyRevision":9,"checkoutRateControl":{"version":"shopify-checkout-rate-control-v1","audience":""#
        + audience
        + #"","rateSource":""#
        + rateSource
        + #""}},"checkoutRateLastChange":{"configGlobalId":"gscf0009801","idempotencyKey":"shopify-rate-control:prior-command","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","actorEmail":"owner@example.test","requestedControl":{"version":"shopify-checkout-rate-control-v1","audience":""#
        + audience
        + #"","rateSource":""#
        + rateSource
        + #""},"resultingRowVersion":12,"resultingPolicyRevision":9,"reason":"Keep the reviewed checkout lane"},"checkoutRateOperatingProfile":{"desiredAudience":""#
        + audience
        + #"","desiredRateSource":""#
        + rateSource
        + #"","effectiveState":""#
        + effectiveState
        + #"","effectiveReason":""#
        + effectiveReason
        + #"","serving":"#
        + (effectiveState == "serving" ? "true" : "false")
        + #", "emergencyOverride":"#
        + (emergencyOverride ? "true" : "false")
        + #"},"canActivate":"#
        + (canActivate ? "true" : "false")
        + #", "canManage":true}}"#
}

private func checkoutRequestBody(_ request: URLRequest) -> Data? {
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

private final class CheckoutSetupURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = checkoutSetupJSON()
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

private final class CheckoutExactRetryURLProtocol: URLProtocol, @unchecked Sendable {
    enum FirstOutcome {
        case transport
        case rateLimited
        case serverFailure
        case malformedSuccess
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var outcome = FirstOutcome.transport
    nonisolated(unsafe) private static var requests: [(String?, Data?)] = []

    static func reset(_ firstOutcome: FirstOutcome) {
        lock.lock()
        outcome = firstOutcome
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
            checkoutRequestBody(request)
        ))
        let attempt = Self.requests.count
        let outcome = Self.outcome
        Self.lock.unlock()

        if attempt == 1, outcome == .transport {
            client?.urlProtocol(
                self,
                didFailWithError: URLError(.networkConnectionLost)
            )
            return
        }

        let status: Int
        let headers: [String: String]
        let body: String
        if attempt == 1 {
            switch outcome {
            case .transport:
                preconditionFailure("transport handled above")
            case .rateLimited:
                status = 429
                headers = [
                    "Content-Type": "application/json",
                    "Retry-After": "7",
                ]
                body = #"{"ok":false,"code":"RATE_LIMITED","error":"Retry later"}"#
            case .serverFailure:
                status = 503
                headers = ["Content-Type": "application/json"]
                body = #"{"ok":false,"code":"DATABASE_UNAVAILABLE","error":"Result unavailable"}"#
            case .malformedSuccess:
                status = 200
                headers = ["Content-Type": "application/json"]
                body = #"{"ok":true,"result":{"providerWrites":0}}"#
            }
        } else {
            status = 200
            headers = ["Content-Type": "application/json"]
            body = #"{"ok":true,"result":{"version":"shopify-checkout-rate-control-command-result-v1","accountGlobalId":"gia0009801","configGlobalId":"gscf0009801","idempotencyKey":"shopify-rate-control:fixed-command","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkoutRateControl":{"version":"shopify-checkout-rate-control-v1","audience":"all_eligible","rateSource":"production"},"rowVersion":13,"policyRevision":10,"providerWrites":0}}"#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class CheckoutCapabilityURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var postCount = 0

    static func reset() {
        lock.lock()
        postCount = 0
        lock.unlock()
    }

    static func capturedPostCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return postCount
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        if request.httpMethod == "POST" { Self.postCount += 1 }
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 503,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"ok":false,"code":"DATABASE_UNAVAILABLE"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class CheckoutStatusURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var statusCode = 400

    static func respond(with statusCode: Int) {
        lock.lock()
        Self.statusCode = statusCode
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let statusCode = Self.statusCode
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        let body = statusCode == 409
            ? #"{"ok":false,"code":"SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT","error":"Refresh the control"}"#
            : #"{"ok":false,"code":"SHOPIFY_CHECKOUT_RATE_CONTROL_INVALID","error":"Invalid control"}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private struct CheckoutAvailabilityRequest: Equatable, Sendable {
    let method: String
    let path: String
}

private final class CheckoutAvailabilityURLProtocol: URLProtocol, @unchecked Sendable {
    enum OperationsOutcome {
        case serverFailure
        case malformedSuccess
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var operationsOutcome =
        OperationsOutcome.serverFailure
    nonisolated(unsafe) private static var requests: [CheckoutAvailabilityRequest] = []

    static func reset(operationsOutcome: OperationsOutcome) {
        lock.lock()
        Self.operationsOutcome = operationsOutcome
        requests = []
        lock.unlock()
    }

    static func captured() -> [CheckoutAvailabilityRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        Self.lock.lock()
        Self.requests.append(.init(method: method, path: path))
        let operationsOutcome = Self.operationsOutcome
        Self.lock.unlock()

        let status: Int
        let body: String
        switch (method, path) {
        case ("GET", "/api/operations"):
            switch operationsOutcome {
            case .serverFailure:
                status = 500
                body = #"{"ok":false,"code":"OPERATIONS_UNAVAILABLE"}"#
            case .malformedSuccess:
                status = 200
                body = #"{"ok":true,"operations":{"orders":[]}}"#
            }
        case ("GET", "/api/integrations/commerce/accounts"):
            status = 200
            body = #"{"ok":true,"organizationId":""#
                + checkoutOrganizationId
                + #"","accounts":[{"accountGlobalId":"gia0009801","provider":"shopify","environment":"production","displayName":"Pro Bakery Bites","status":"active"},{"accountGlobalId":"gia0009802","provider":"faire","environment":"production","displayName":"Faire wholesale","status":"active"}]}"#
        case ("GET", "/api/integrations/commerce/shopify/carrier-service"):
            status = 200
            body = checkoutSetupJSON()
        case ("POST", "/api/integrations/commerce/shopify/carrier-service"):
            status = 200
            body = #"{"ok":true,"result":{"version":"shopify-checkout-rate-control-command-result-v1","accountGlobalId":"gia0009801","configGlobalId":"gscf0009801","idempotencyKey":"shopify-rate-control:availability-command","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkoutRateControl":{"version":"shopify-checkout-rate-control-v1","audience":"all_eligible","rateSource":"production"},"rowVersion":13,"policyRevision":10,"providerWrites":0}}"#
        default:
            status = 500
            body = #"{"ok":false,"code":"UNEXPECTED_TEST_REQUEST"}"#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class CheckoutMismatchedOrganizationURLProtocol:
    URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        let body = #"{"ok":true,"organizationId":"22222222-2222-4222-8222-222222222222","accounts":[{"accountGlobalId":"gia0009801","provider":"shopify","environment":"production","displayName":"Pro Bakery Bites","status":"active"}]}"#
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func checkoutClient(
    protocolClass: URLProtocol.Type
) throws -> PickingAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [protocolClass]
    return try PickingAPIClient(
        origin: URL(string: "https://clawpilot.example")!,
        session: URLSession(configuration: configuration)
    )
}

private func decodedCheckoutCommandResult(
    accountGlobalId: String = "gia0009801",
    configGlobalId: String = "gscf0009801",
    idempotencyKey: String = "shopify-rate-control:fixed-command",
    audience: String = "all_eligible",
    rateSource: String = "production",
    rowVersion: Int = 13,
    policyRevision: Int = 10,
    providerWrites: Int = 0
) throws -> ManagerShopifyCheckoutRateCommandResult {
    let object: [String: Any] = [
        "version": "shopify-checkout-rate-control-command-result-v1",
        "accountGlobalId": accountGlobalId,
        "configGlobalId": configGlobalId,
        "idempotencyKey": idempotencyKey,
        "requestHash": String(repeating: "a", count: 64),
        "checkoutRateControl": [
            "version": "shopify-checkout-rate-control-v1",
            "audience": audience,
            "rateSource": rateSource,
        ],
        "rowVersion": rowVersion,
        "policyRevision": policyRevision,
        "providerWrites": providerWrites,
    ]
    return try JSONDecoder().decode(
        ManagerShopifyCheckoutRateCommandResult.self,
        from: JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    )
}

private func editableCheckoutControl(
    environment: String = "production",
    audience: ManagerShopifyCheckoutAudience = .restrictedCustomers,
    rateSource: ManagerShopifyCheckoutRateSource = .test,
    effectiveReason: ManagerShopifyCheckoutEffectiveReason = .productionSourceRequired,
    emergencyOverride: Bool = false,
    canActivate: Bool = true,
    canManage: Bool = true
) -> ManagerShopifyCheckoutRateControl {
    ManagerShopifyCheckoutRateControl(
        accountGlobalId: "gia0009801",
        provider: "shopify",
        environment: environment,
        displayName: "Pro Bakery Bites",
        accountStatus: "active",
        configGlobalId: "gscf0009801",
        rowVersion: 12,
        policyRevision: 9,
        desiredAudience: audience,
        desiredRateSource: rateSource,
        effectiveState: effectiveReason.expectedState,
        effectiveReason: effectiveReason,
        serving: effectiveReason == .serving,
        emergencyOverride: emergencyOverride,
        canActivate: canActivate,
        canManage: canManage,
        lastChange: ManagerShopifyCheckoutRateLastChange(
            configGlobalId: "gscf0009801",
            idempotencyKey: "shopify-rate-control:prior-command",
            requestHash: String(repeating: "a", count: 64),
            actorEmail: checkoutActorEmail,
            requestedControl: .init(
                version: "shopify-checkout-rate-control-v1",
                audience: audience,
                rateSource: rateSource
            ),
            resultingRowVersion: 12,
            resultingPolicyRevision: 9,
            reason: "Keep the reviewed checkout lane"
        )
    )
}

@Test("native checkout rates decode production TEST as saved desired but effectively empty")
func nativeCheckoutRatesDecodeDesiredAndEffectiveSeparately() async throws {
    let client = try checkoutClient(protocolClass: CheckoutSetupURLProtocol.self)
    let control = try await client.fetchManagerShopifyCheckoutRateControl(
        accountGlobalId: "gia0009801"
    )
    #expect(control.desiredAudience == .restrictedCustomers)
    #expect(control.desiredRateSource == .test)
    #expect(control.effectiveState == .empty)
    #expect(control.effectiveReason == .productionSourceRequired)
    #expect(control.lastChange?.reason == "Keep the reviewed checkout lane")
    #expect(control.policyRevision == 9)
    #expect(control.canEdit)
}

@Test("native checkout availability survives failed or malformed Operations independently")
func nativeCheckoutAvailabilityDoesNotDependOnOperationsOverview() async throws {
    for outcome in [
        CheckoutAvailabilityURLProtocol.OperationsOutcome.serverFailure,
        .malformedSuccess,
    ] {
        CheckoutAvailabilityURLProtocol.reset(operationsOutcome: outcome)
        let client = try checkoutClient(
            protocolClass: CheckoutAvailabilityURLProtocol.self
        )
        await #expect(throws: Error.self) {
            _ = try await client.fetchManagerOperations()
        }

        let accounts = try await client.fetchManagerCommerceAccounts(
            organizationId: checkoutOrganizationId
        )
        let shopify = try #require(
            accounts.first(where: { $0.provider == "shopify" })
        )
        let control = try await client.fetchManagerShopifyCheckoutRateControl(
            accountGlobalId: shopify.accountGlobalId
        )
        let command = try ManagerShopifyCheckoutRateCommand(
            control: control,
            authenticationGeneration: 4,
            organizationId: checkoutOrganizationId,
            actorEmail: checkoutActorEmail,
            desiredAudience: .allEligible,
            desiredRateSource: .live,
            reason: "Keep checkout available without Operations overview",
            idempotencyKey: "shopify-rate-control:availability-command"
        )
        let result = try await client.updateManagerShopifyCheckoutRateControl(
            command
        )
        #expect(result.providerWrites == 0)

        let requests = CheckoutAvailabilityURLProtocol.captured()
        #expect(requests == [
            .init(method: "GET", path: "/api/operations"),
            .init(method: "GET", path: "/api/integrations/commerce/accounts"),
            .init(
                method: "GET",
                path: "/api/integrations/commerce/shopify/carrier-service"
            ),
            .init(
                method: "POST",
                path: "/api/integrations/commerce/shopify/carrier-service"
            ),
        ])
    }
}

@Test("native checkout account discovery and presentation fences reject workspace drift")
func nativeCheckoutAvailabilityRejectsWorkspaceDrift() async throws {
    let otherOrganizationId = "22222222-2222-4222-8222-222222222222"
    let client = try checkoutClient(
        protocolClass: CheckoutMismatchedOrganizationURLProtocol.self
    )
    await #expect(throws: PickingAPIError.invalidResponse) {
        _ = try await client.fetchManagerCommerceAccounts(
            organizationId: checkoutOrganizationId
        )
    }
    let fence = ManagerStoreSyncSubmissionFence(
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId
    )
    #expect(fence.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        isAuthenticated: true
    ))
    #expect(!fence.permitsStateMutation(
        currentAuthenticationGeneration: 5,
        currentOrganizationId: checkoutOrganizationId,
        isAuthenticated: true
    ))
    #expect(!fence.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: otherOrganizationId,
        isAuthenticated: true
    ))
    #expect(!fence.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        isAuthenticated: false
    ))
}

@Test("native checkout rates allow every desired state while overrides stay effective only")
func nativeCheckoutRatesAllowDormantDesiredStates() throws {
    let productionTest = editableCheckoutControl()
    _ = try ManagerShopifyCheckoutRateCommand(
        control: productionTest,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .test,
        reason: "Keep TEST desired on production for later review"
    )

    let restrictedLive = editableCheckoutControl(
        environment: "sandbox",
        audience: .restrictedCustomers,
        rateSource: .live,
        effectiveReason: .restrictedLiveEnforcementRequired
    )
    _ = try ManagerShopifyCheckoutRateCommand(
        control: restrictedLive,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .restrictedCustomers,
        desiredRateSource: .live,
        reason: "Save Restricted LIVE pending provider enforcement"
    )

    let frozen = editableCheckoutControl(
        effectiveReason: .emergencyFrozen,
        emergencyOverride: true
    )
    _ = try ManagerShopifyCheckoutRateCommand(
        control: frozen,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .off,
        desiredRateSource: .live,
        reason: "Change desired state while Frozen remains effective"
    )

    let disabled = editableCheckoutControl(
        effectiveReason: .emergencyDisabled,
        emergencyOverride: true
    )
    _ = try ManagerShopifyCheckoutRateCommand(
        control: disabled,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .test,
        reason: "Change desired state while Disabled remains effective"
    )
}

@Test("native checkout rate effective projection exhaustively matches 0299 precedence")
func nativeCheckoutRateProjectionMatchesEvery0299Combination() {
    let allReasons: [ManagerShopifyCheckoutEffectiveReason] = [
        .emergencyDisabled,
        .emergencyFrozen,
        .configuredOff,
        .productionSourceRequired,
        .restrictedLiveEnforcementRequired,
        .runtimeNotReady,
        .serving,
    ]
    for environment in ["mock", "sandbox", "production"] {
        for audience in ManagerShopifyCheckoutAudience.allCases {
            for source in ManagerShopifyCheckoutRateSource.allCases {
                let allowedReasons: [ManagerShopifyCheckoutEffectiveReason]
                if audience == .off {
                    allowedReasons = [.configuredOff]
                } else if environment == "production" && source == .test {
                    allowedReasons = [.productionSourceRequired]
                } else if audience == .restrictedCustomers && source == .live {
                    allowedReasons = [.restrictedLiveEnforcementRequired]
                } else {
                    allowedReasons = [.runtimeNotReady, .serving]
                }
                for reason in allReasons {
                    let control = editableCheckoutControl(
                        environment: environment,
                        audience: audience,
                        rateSource: source,
                        effectiveReason: reason
                    )
                    #expect(
                        control.isContractValid == allowedReasons.contains(reason),
                        "\(environment)/\(audience.rawValue)/\(source.rawValue)/\(reason.rawValue)"
                    )
                }
                for emergencyReason in [
                    ManagerShopifyCheckoutEffectiveReason.emergencyDisabled,
                    .emergencyFrozen,
                ] {
                    let emergency = editableCheckoutControl(
                        environment: environment,
                        audience: audience,
                        rateSource: source,
                        effectiveReason: emergencyReason,
                        emergencyOverride: true
                    )
                    #expect(emergency.isContractValid)
                }
            }
        }
    }
}

@Test("native checkout rate exact capabilities allow save while view-only produces zero POST")
func nativeCheckoutRateCapabilitiesGateEveryPost() async throws {
    CheckoutCapabilityURLProtocol.reset()
    let client = try checkoutClient(protocolClass: CheckoutCapabilityURLProtocol.self)
    let authorized = editableCheckoutControl(canActivate: true, canManage: true)
    let authorizedCommand = try ManagerShopifyCheckoutRateCommand(
        control: authorized,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "An owner or authorized administrator may save this control"
    )
    await #expect(throws: Error.self) {
        _ = try await client.updateManagerShopifyCheckoutRateControl(
            authorizedCommand
        )
    }
    #expect(CheckoutCapabilityURLProtocol.capturedPostCount() == 1)

    CheckoutCapabilityURLProtocol.reset()
    let viewOnly = editableCheckoutControl(canActivate: false)
    #expect(viewOnly.isContractValid)
    #expect(!viewOnly.canEdit)
    #expect(throws: ManagerShopifyCheckoutRateClientError.notAuthorized) {
        _ = try ManagerShopifyCheckoutRateCommand(
            control: viewOnly,
            authenticationGeneration: 4,
            organizationId: checkoutOrganizationId,
            actorEmail: checkoutActorEmail,
            desiredAudience: .allEligible,
            desiredRateSource: .live,
            reason: "A view-only user must never produce a command"
        )
    }
    #expect(CheckoutCapabilityURLProtocol.capturedPostCount() == 0)

    let cannotManage = editableCheckoutControl(
        canActivate: true,
        canManage: false
    )
    #expect(!cannotManage.canEdit)
    #expect(throws: ManagerShopifyCheckoutRateClientError.notAuthorized) {
        _ = try ManagerShopifyCheckoutRateCommand(
            control: cannotManage,
            authenticationGeneration: 4,
            organizationId: checkoutOrganizationId,
            actorEmail: checkoutActorEmail,
            desiredAudience: .allEligible,
            desiredRateSource: .live,
            reason: "Both exact capabilities are required"
        )
    }
    #expect(CheckoutCapabilityURLProtocol.capturedPostCount() == 0)
}

@Test("native checkout rate client classifies definitive 4xx and conflict separately")
func nativeCheckoutRateClientClassifiesDefinitiveFailures() async throws {
    let command = try ManagerShopifyCheckoutRateCommand(
        control: editableCheckoutControl(),
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "Classify definitive failures before retry"
    )
    let client = try checkoutClient(protocolClass: CheckoutStatusURLProtocol.self)

    CheckoutStatusURLProtocol.respond(with: 400)
    do {
        _ = try await client.updateManagerShopifyCheckoutRateControl(command)
        Issue.record("A definitive 400 must not be accepted")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "SHOPIFY_CHECKOUT_RATE_CONTROL_INVALID",
            message: "Invalid control"
        ))
    }

    CheckoutStatusURLProtocol.respond(with: 409)
    do {
        _ = try await client.updateManagerShopifyCheckoutRateControl(command)
        Issue.record("A revision conflict must not be accepted")
    } catch let error as PickingAPIError {
        #expect(error == .conflict(
            code: "SHOPIFY_CHECKOUT_CONFIG_VERSION_CONFLICT",
            message: "Refresh the control"
        ))
    }
}

@Test("native checkout rate retries transport 429 5xx and malformed responses byte identically")
func nativeCheckoutRateRetriesEveryAmbiguousOutcomeExactly() async throws {
    for outcome in [
        CheckoutExactRetryURLProtocol.FirstOutcome.transport,
        .rateLimited,
        .serverFailure,
        .malformedSuccess,
    ] {
        CheckoutExactRetryURLProtocol.reset(outcome)
        let command = try ManagerShopifyCheckoutRateCommand(
            control: editableCheckoutControl(),
            authenticationGeneration: 4,
            organizationId: checkoutOrganizationId,
            actorEmail: checkoutActorEmail,
            desiredAudience: .allEligible,
            desiredRateSource: .live,
            reason: "Serve all eligible customers from LIVE",
            idempotencyKey: "shopify-rate-control:fixed-command"
        )
        let client = try checkoutClient(
            protocolClass: CheckoutExactRetryURLProtocol.self
        )
        await #expect(throws: Error.self) {
            _ = try await client.updateManagerShopifyCheckoutRateControl(command)
        }
        let result = try await client.updateManagerShopifyCheckoutRateControl(
            command
        )
        #expect(result.providerWrites == 0)
        let captured = CheckoutExactRetryURLProtocol.captured()
        #expect(captured.count == 2)
        #expect(captured[0].0 == captured[1].0)
        #expect(captured[0].1 == captured[1].1)
        let body = try #require(captured[0].1)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        #expect(Set(decoded.keys) == Set([
            "accountGlobalId",
            "action",
            "checkoutRateControl",
            "expectedConfigGlobalId",
            "expectedPolicyRevision",
            "expectedRowVersion",
            "reason",
        ]))
        #expect(decoded["action"] as? String == "save-checkout-rate-control")
        #expect(decoded["expectedConfigGlobalId"] as? String == "gscf0009801")
        #expect(decoded["expectedRowVersion"] as? Int == 12)
        #expect(decoded["expectedPolicyRevision"] as? Int == 9)
    }
}

@Test("native checkout rate response and late-session fences bind every reviewed identity")
func nativeCheckoutRateFencesExactIdentityAndLateState() throws {
    let control = editableCheckoutControl()
    let command = try ManagerShopifyCheckoutRateCommand(
        control: control,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "Serve all eligible customers from LIVE",
        idempotencyKey: "shopify-rate-control:fixed-command"
    )
    #expect(command.isCurrentReview(control))
    #expect(!command.isCurrentReview(
        editableCheckoutControl(canActivate: false)
    ))
    #expect(!command.isCurrentReview(
        editableCheckoutControl(canManage: false)
    ))
    #expect(command.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: "gia0009801",
        isAuthenticated: true
    ))
    #expect(!command.permitsStateMutation(
        currentAuthenticationGeneration: 5,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: "gia0009801",
        isAuthenticated: false
    ))
    #expect(!command.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: "22222222-2222-4222-8222-222222222222",
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: "gia0009801",
        isAuthenticated: true
    ))
    #expect(!command.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: "replacement@example.test",
        currentAccountGlobalId: "gia0009801",
        isAuthenticated: true
    ))
    #expect(!command.permitsStateMutation(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: "gia0009802",
        isAuthenticated: true
    ))

    let changedConfig = ManagerShopifyCheckoutRateControl(
        accountGlobalId: control.accountGlobalId,
        provider: control.provider,
        environment: control.environment,
        displayName: control.displayName,
        accountStatus: control.accountStatus,
        configGlobalId: "gscf0009802",
        rowVersion: control.rowVersion,
        policyRevision: control.policyRevision,
        desiredAudience: control.desiredAudience,
        desiredRateSource: control.desiredRateSource,
        effectiveState: control.effectiveState,
        effectiveReason: control.effectiveReason,
        serving: control.serving,
        emergencyOverride: control.emergencyOverride,
        canActivate: true,
        canManage: true,
        lastChange: nil
    )
    #expect(!command.isCurrentReview(changedConfig))
}

@Test("native checkout rate success response binds account config command desired state and revisions")
func nativeCheckoutRateResponseBindsEveryCommandField() throws {
    let command = try ManagerShopifyCheckoutRateCommand(
        control: editableCheckoutControl(),
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "Serve all eligible customers from LIVE",
        idempotencyKey: "shopify-rate-control:fixed-command"
    )
    _ = try decodedCheckoutCommandResult().validated(for: command)
    for mismatched in [
        try decodedCheckoutCommandResult(accountGlobalId: "gia0009802"),
        try decodedCheckoutCommandResult(configGlobalId: "gscf0009802"),
        try decodedCheckoutCommandResult(
            idempotencyKey: "shopify-rate-control:different-command"
        ),
        try decodedCheckoutCommandResult(audience: "off"),
        try decodedCheckoutCommandResult(rateSource: "sandbox"),
        try decodedCheckoutCommandResult(rowVersion: 14),
        try decodedCheckoutCommandResult(policyRevision: 11),
        try decodedCheckoutCommandResult(providerWrites: 1),
    ] {
        #expect(throws: ManagerShopifyCheckoutRateClientError.mismatchedResponse) {
            _ = try mismatched.validated(for: command)
        }
    }
}

@Test("native checkout rate stale completion cannot clear a replacement-auth submission")
func nativeCheckoutRateSubmissionFenceRejectsStaleDeferOverlap() throws {
    let oldCommand = try ManagerShopifyCheckoutRateCommand(
        control: editableCheckoutControl(),
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .restrictedCustomers,
        desiredRateSource: .test,
        reason: "Old in-flight save",
        idempotencyKey: "shopify-rate-control:old-command"
    )
    var activeFence: ManagerShopifyCheckoutRateSubmissionFence? =
        ManagerShopifyCheckoutRateSubmissionFence(command: oldCommand)
    #expect(activeFence?.ownsCompletion(of: oldCommand) == true)

    // Replacement authentication clears the old presentation state before a
    // new reviewed command starts on the same account.
    activeFence = nil
    let newCommand = try ManagerShopifyCheckoutRateCommand(
        control: editableCheckoutControl(),
        authenticationGeneration: 5,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "New replacement-session save",
        idempotencyKey: "shopify-rate-control:new-command"
    )
    activeFence = ManagerShopifyCheckoutRateSubmissionFence(
        command: newCommand
    )

    #expect(activeFence?.ownsCompletion(of: oldCommand) == false)
    #expect(activeFence?.permitsStateMutation(
        for: oldCommand,
        currentAuthenticationGeneration: 5,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        isAuthenticated: true
    ) == false)
    #expect(activeFence?.ownsCompletion(of: newCommand) == true)
    #expect(activeFence?.permitsStateMutation(
        for: newCommand,
        currentAuthenticationGeneration: 5,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        isAuthenticated: true
    ) == true)
}

@Test("native checkout rate model ignores logout workspace and account switches during an in-flight save")
func nativeCheckoutRateModelRejectsEveryLatePresentationContext() throws {
    let command = try ManagerShopifyCheckoutRateCommand(
        control: editableCheckoutControl(),
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "Serve all eligible customers from LIVE"
    )
    let pending = ManagerShopifyCheckoutRatePendingModel(command: command)
    #expect(pending.resolve(
        currentAuthenticationGeneration: 5,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: command.accountGlobalId,
        isAuthenticated: false,
        failure: .ambiguous,
        refreshedControl: nil
    ) == .ignoreSupersededContext)
    #expect(pending.resolve(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: "22222222-2222-4222-8222-222222222222",
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: command.accountGlobalId,
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: nil
    ) == .ignoreSupersededContext)
    #expect(pending.resolve(
        currentAuthenticationGeneration: 4,
        currentOrganizationId: checkoutOrganizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: "gia0009802",
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: nil
    ) == .ignoreSupersededContext)
}

@Test("native checkout rate model quarantines definitive rejection and retains only ambiguous exact retry")
func nativeCheckoutRateModelSeparatesDefinitiveAndAmbiguousFailures() throws {
    let original = editableCheckoutControl()
    let command = try ManagerShopifyCheckoutRateCommand(
        control: original,
        authenticationGeneration: 4,
        organizationId: checkoutOrganizationId,
        actorEmail: checkoutActorEmail,
        desiredAudience: .allEligible,
        desiredRateSource: .live,
        reason: "Serve all eligible customers from LIVE"
    )
    let pending = ManagerShopifyCheckoutRatePendingModel(command: command)
    let context = (
        generation: UInt64(4),
        organizationId: Optional(checkoutOrganizationId),
        accountGlobalId: Optional(command.accountGlobalId)
    )
    #expect(pending.resolve(
        currentAuthenticationGeneration: context.generation,
        currentOrganizationId: context.organizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: context.accountGlobalId,
        isAuthenticated: true,
        failure: .definitive,
        refreshedControl: original
    ) == .quarantineAndRefresh)
    #expect(pending.resolve(
        currentAuthenticationGeneration: context.generation,
        currentOrganizationId: context.organizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: context.accountGlobalId,
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: original
    ) == .retainExactRetry)

    let applied = ManagerShopifyCheckoutRateControl(
        accountGlobalId: command.accountGlobalId,
        provider: "shopify",
        environment: "production",
        displayName: "Pro Bakery Bites",
        accountStatus: "active",
        configGlobalId: command.configGlobalId,
        rowVersion: command.expectedRowVersion + 1,
        policyRevision: command.expectedPolicyRevision + 1,
        desiredAudience: command.desiredAudience,
        desiredRateSource: command.desiredRateSource,
        effectiveState: .serving,
        effectiveReason: .serving,
        serving: true,
        emergencyOverride: false,
        canActivate: true,
        canManage: true,
        lastChange: ManagerShopifyCheckoutRateLastChange(
            configGlobalId: command.configGlobalId,
            idempotencyKey: command.idempotencyKey,
            requestHash: String(repeating: "b", count: 64),
            actorEmail: command.actorEmail,
            requestedControl: .init(
                version: "shopify-checkout-rate-control-v1",
                audience: command.desiredAudience,
                rateSource: command.desiredRateSource
            ),
            resultingRowVersion: command.expectedRowVersion + 1,
            resultingPolicyRevision: command.expectedPolicyRevision + 1,
            reason: command.reason
        )
    )
    #expect(pending.resolve(
        currentAuthenticationGeneration: context.generation,
        currentOrganizationId: context.organizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: context.accountGlobalId,
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: applied
    ) == .applied)

    let identicalChangeFromAnotherReceipt = ManagerShopifyCheckoutRateControl(
        accountGlobalId: applied.accountGlobalId,
        provider: applied.provider,
        environment: applied.environment,
        displayName: applied.displayName,
        accountStatus: applied.accountStatus,
        configGlobalId: applied.configGlobalId,
        rowVersion: applied.rowVersion,
        policyRevision: applied.policyRevision,
        desiredAudience: applied.desiredAudience,
        desiredRateSource: applied.desiredRateSource,
        effectiveState: applied.effectiveState,
        effectiveReason: applied.effectiveReason,
        serving: applied.serving,
        emergencyOverride: applied.emergencyOverride,
        canActivate: applied.canActivate,
        canManage: applied.canManage,
        lastChange: ManagerShopifyCheckoutRateLastChange(
            configGlobalId: command.configGlobalId,
            idempotencyKey: "shopify-rate-control:different-command",
            requestHash: String(repeating: "d", count: 64),
            actorEmail: command.actorEmail,
            requestedControl: .init(
                version: "shopify-checkout-rate-control-v1",
                audience: command.desiredAudience,
                rateSource: command.desiredRateSource
            ),
            resultingRowVersion: command.expectedRowVersion + 1,
            resultingPolicyRevision: command.expectedPolicyRevision + 1,
            reason: command.reason
        )
    )
    #expect(pending.resolve(
        currentAuthenticationGeneration: context.generation,
        currentOrganizationId: context.organizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: context.accountGlobalId,
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: identicalChangeFromAnotherReceipt
    ) == .quarantineAndRefresh)

    let drifted = ManagerShopifyCheckoutRateControl(
        accountGlobalId: original.accountGlobalId,
        provider: original.provider,
        environment: original.environment,
        displayName: original.displayName,
        accountStatus: original.accountStatus,
        configGlobalId: original.configGlobalId,
        rowVersion: command.expectedRowVersion + 1,
        policyRevision: command.expectedPolicyRevision + 1,
        desiredAudience: .off,
        desiredRateSource: .test,
        effectiveState: .empty,
        effectiveReason: .configuredOff,
        serving: false,
        emergencyOverride: false,
        canActivate: true,
        canManage: true,
        lastChange: ManagerShopifyCheckoutRateLastChange(
            configGlobalId: command.configGlobalId,
            idempotencyKey: "shopify-rate-control:different-command",
            requestHash: String(repeating: "c", count: 64),
            actorEmail: command.actorEmail,
            requestedControl: .init(
                version: "shopify-checkout-rate-control-v1",
                audience: .off,
                rateSource: .test
            ),
            resultingRowVersion: command.expectedRowVersion + 1,
            resultingPolicyRevision: command.expectedPolicyRevision + 1,
            reason: "Another administrator changed this control"
        )
    )
    #expect(pending.resolve(
        currentAuthenticationGeneration: context.generation,
        currentOrganizationId: context.organizationId,
        currentActorEmail: checkoutActorEmail,
        currentAccountGlobalId: context.accountGlobalId,
        isAuthenticated: true,
        failure: .ambiguous,
        refreshedControl: drifted
    ) == .quarantineAndRefresh)
}
