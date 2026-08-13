import Foundation
import Testing
@testable import ClawPilotPickingApple
@testable import ClawPilotPickingCore

private func pickAssignment(
    fingerprint: String = String(repeating: "a", count: 64),
    blocked: String? = nil
) -> ManagerCurrentPickAssignment {
    ManagerCurrentPickAssignment(
        orderGlobalId: "gor0000008",
        orderNumber: "1008",
        rowVersion: 4,
        orderStatus: "released",
        planGlobalId: "gfp0000008",
        waveGlobalId: "gwv0000008",
        warehouseName: "Main warehouse",
        assignmentState: "assigned",
        assignedTo: "picker@example.com",
        assignedDisplayName: "Pat Picker",
        assignedPickers: [ManagerPickAssignmentPerson(
            email: "picker@example.com",
            displayName: "Pat Picker",
            taskCount: 2
        )],
        unassignedTaskCount: 0,
        assignmentFingerprint: fingerprint,
        taskCount: 2,
        readyTaskCount: 2,
        pickedTaskCount: 0,
        requiredUnits: 4,
        pickedUnits: 0,
        scanEvidenceTaskCount: 0,
        countEvidenceTaskCount: 0,
        assignedAt: "2026-08-12T12:00:00Z",
        latestActivityAt: "2026-08-12T12:01:00Z",
        handoffExceptionGlobalId: nil,
        interventionExceptionGlobalId: nil,
        managementBlockedReason: blocked
    )
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

private final class ManagerPickManagementURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body: String
        let status: Int
        if request.httpMethod == "GET",
           request.url?.path == "/api/operations/pick-management" {
            status = 200
            body = #"{"ok":true,"pickManagement":{"generatedAt":"2026-08-12T14:00:00Z","current":[{"orderGlobalId":"gor0000008","orderNumber":"1008","rowVersion":4,"orderStatus":"released","planGlobalId":"gfp0000008","waveGlobalId":"gwv0000008","warehouseName":"Main warehouse","assignmentState":"assigned","assignedTo":"picker@example.com","assignedDisplayName":"Pat Picker","assignedPickers":[{"email":"picker@example.com","displayName":"Pat Picker","taskCount":2}],"unassignedTaskCount":0,"assignmentFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","taskCount":2,"readyTaskCount":2,"pickedTaskCount":0,"requiredUnits":4,"pickedUnits":0,"scanEvidenceTaskCount":0,"countEvidenceTaskCount":0,"assignedAt":"2026-08-12T12:00:00Z","latestActivityAt":"2026-08-12T12:01:00Z","handoffExceptionGlobalId":null,"interventionExceptionGlobalId":null,"managementBlockedReason":null}],"history":[{"orderGlobalId":"gor0000007","orderNumber":"1007","orderStatus":"picking","planGlobalId":"gfp0000007","waveGlobalId":"gwv0000007","pickerEmail":"picker@example.com","pickerDisplayName":"Pat Picker","taskCount":1,"unitCount":3,"assignedAt":"2026-08-12T10:00:00Z","completedAt":"2026-08-12T10:10:00Z"}],"eligiblePickers":[{"email":"picker@example.com","displayName":"Pat Picker"}]}}"#
        } else {
            let json = try? JSONSerialization.jsonObject(
                with: requestBodyData(request)
            ) as? [String: Any]
            let valid = request.httpMethod == "POST"
                && request.url?.path == "/api/operations"
                && request.value(forHTTPHeaderField: "Idempotency-Key")
                    == "manager-pick-assignment:fixed-command"
                && json?["action"] as? String == "manage-pick-assignment"
                && json?["orderGlobalId"] as? String == "gor0000008"
                && json?["expectedRowVersion"] as? Int == 4
                && json?["expectedTaskCount"] as? Int == 2
                && json?["expectedAssignmentFingerprint"] as? String
                    == String(repeating: "a", count: 64)
                && json?["assignedTo"] == nil
                && json?["reason"] as? String == "Manager intervention required."
            status = valid ? 200 : 422
            body = valid
                ? #"{"ok":true,"result":{"orderGlobalId":"gor0000008","orderStatus":"released","previousRowVersion":4,"rowVersion":5,"taskCount":2,"previousAssignedTo":"picker@example.com","assignedTo":null,"interventionExceptionGlobalId":"gex0000008","providerWrites":0,"replayed":false}}"#
                : #"{"ok":false,"code":"BAD_MANAGER_PICK_COMMAND","error":"Bad command"}"#
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

private final class ManagerPickPaginationURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private func assignment(_ index: Int) -> [String: Any] {
        [
            "orderGlobalId": "gorpaged\(index)",
            "orderNumber": "P\(index)",
            "rowVersion": 1,
            "orderStatus": "released",
            "planGlobalId": "gfppaged\(index)",
            "waveGlobalId": "gwvpaged\(index)",
            "warehouseName": "Main warehouse",
            "assignmentState": "assigned",
            "assignedTo": "picker@example.com",
            "assignedDisplayName": "Pat Picker",
            "assignedPickers": [[
                "email": "picker@example.com",
                "displayName": "Pat Picker",
                "taskCount": 1,
            ]],
            "unassignedTaskCount": 0,
            "assignmentFingerprint": String(repeating: "a", count: 64),
            "taskCount": 1,
            "readyTaskCount": 1,
            "pickedTaskCount": 0,
            "requiredUnits": 1,
            "pickedUnits": 0,
            "scanEvidenceTaskCount": 0,
            "countEvidenceTaskCount": 0,
            "assignedAt": "2026-08-12T12:00:00Z",
            "latestActivityAt": "2026-08-12T12:00:00Z",
            "handoffExceptionGlobalId": NSNull(),
            "interventionExceptionGlobalId": NSNull(),
            "managementBlockedReason": NSNull(),
        ]
    }

    private func history(_ index: Int) -> [String: Any] {
        [
            "orderGlobalId": "gorhistorypaged\(index)",
            "orderNumber": "H\(index)",
            "orderStatus": "picking",
            "planGlobalId": "gfphistorypaged\(index)",
            "waveGlobalId": "gwvhistorypaged\(index)",
            "pickerEmail": "picker@example.com",
            "pickerDisplayName": "Pat Picker",
            "taskCount": 1,
            "unitCount": 1,
            "assignedAt": "2026-08-12T11:00:00Z",
            "completedAt": "2026-08-12T12:00:00Z",
        ]
    }

    override func startLoading() {
        let components = URLComponents(
            url: request.url!,
            resolvingAgainstBaseURL: false
        )
        let parameters = Dictionary(uniqueKeysWithValues:
            (components?.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
        let section = parameters["section"]
        let valid: Bool
        let current: [[String: Any]]
        let completed: [[String: Any]]
        let currentHasMore: Bool
        let historyHasMore: Bool
        if section == nil {
            valid = true
            current = (0..<100).map(assignment)
            completed = (0..<100).map(history)
            currentHasMore = true
            historyHasMore = true
        } else if section == "current",
                  parameters["currentCursor"] == "current-page-2" {
            valid = true
            current = [assignment(100)]
            completed = []
            currentHasMore = false
            historyHasMore = false
        } else if section == "history",
                  parameters["historyCursor"] == "history-page-2" {
            valid = true
            current = []
            completed = [history(100)]
            currentHasMore = false
            historyHasMore = false
        } else {
            valid = false
            current = []
            completed = []
            currentHasMore = false
            historyHasMore = false
        }
        let currentNextCursor: Any
        let historyNextCursor: Any
        if currentHasMore {
            currentNextCursor = "current-page-2"
        } else {
            currentNextCursor = NSNull()
        }
        if historyHasMore {
            historyNextCursor = "history-page-2"
        } else {
            historyNextCursor = NSNull()
        }
        let payload: [String: Any] = valid ? [
            "ok": true,
            "pickManagement": [
                "generatedAt": "2026-08-12T14:00:00Z",
                "current": current,
                "history": completed,
                "eligiblePickers": [[
                    "email": "picker@example.com",
                    "displayName": "Pat Picker",
                ]],
                "pagination": [
                    "current": [
                        "hasMore": currentHasMore,
                        "nextCursor": currentNextCursor,
                    ],
                    "history": [
                        "hasMore": historyHasMore,
                        "nextCursor": historyNextCursor,
                    ],
                ],
            ],
        ] : [
            "ok": false,
            "code": "INVALID_PAGE_REQUEST",
            "error": "Invalid page request",
        ]
        let status = valid ? 200 : 422
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: try! JSONSerialization.data(withJSONObject: payload)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class ManagerPickConflictURLProtocol: URLProtocol, @unchecked Sendable {
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
            didLoad: Data(#"{"ok":false,"code":"OPERATIONS_PICK_ASSIGNMENT_SCAN_EVIDENCE_EXISTS","error":"Current-version scan evidence exists. Use picker handoff or resolve the physical work before changing assignment."}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test("manager assignment command retains exact optimistic fences")
func managerPickAssignmentCommandIsExact() throws {
    let command = try ManagerPickAssignmentCommand(
        assignment: pickAssignment(),
        assignedTo: nil,
        reason: "  Manager intervention required.  ",
        idempotencyKey: "fixed-command"
    )
    #expect(command.orderGlobalId == "gor0000008")
    #expect(command.expectedRowVersion == 4)
    #expect(command.expectedTaskCount == 2)
    #expect(command.expectedAssignmentFingerprint == String(repeating: "a", count: 64))
    #expect(command.assignedTo == nil)
    #expect(command.reason == "Manager intervention required.")
    #expect(command.idempotencyKey == "manager-pick-assignment:fixed-command")
}

@Test("manager assignment command refuses blocked or malformed projections")
func managerPickAssignmentCommandFailsClosed() {
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try ManagerPickAssignmentCommand(
            assignment: pickAssignment(blocked: "Scan evidence exists."),
            assignedTo: "next@example.com",
            reason: "Reassign",
            idempotencyKey: "fixed-command"
        )
    }
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try ManagerPickAssignmentCommand(
            assignment: pickAssignment(fingerprint: "not-a-fingerprint"),
            assignedTo: nil,
            reason: "Unassign",
            idempotencyKey: "fixed-command"
        )
    }
}

@Test("native manager reads progress and sends exact unassign-and-flag command")
func nativeManagerPickManagementRoundTrip() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerPickManagementURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-picks.test")!,
        session: URLSession(configuration: configuration)
    )
    let workspace = try await client.fetchManagerPickManagement()
    let assignment = try #require(workspace.current.first)
    #expect(assignment.pickerLabel == "Pat Picker")
    #expect(assignment.scanEvidenceTaskCount == 0)
    #expect(workspace.history.first?.planGlobalId == "gfp0000007")
    let command = try ManagerPickAssignmentCommand(
        assignment: assignment,
        assignedTo: nil,
        reason: "Manager intervention required.",
        idempotencyKey: "fixed-command"
    )
    let result = try await client.managePickerAssignment(command)
    #expect(result.rowVersion == 5)
    #expect(result.interventionExceptionGlobalId == "gex0000008")
    #expect(result.providerWrites == 0)
}

@Test("native manager follows every assignment and history page")
func nativeManagerFollowsAllPickManagementPages() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerPickPaginationURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-pages.test")!,
        session: URLSession(configuration: configuration)
    )
    let workspace = try await client.fetchManagerPickManagement()
    #expect(workspace.current.count == 101)
    #expect(workspace.history.count == 101)
    #expect(Set(workspace.current.map(\.id)).count == 101)
    #expect(Set(workspace.history.map(\.id)).count == 101)
    #expect(workspace.current.last?.orderGlobalId == "gorpaged100")
    #expect(workspace.history.last?.orderGlobalId == "gorhistorypaged100")
    #expect(workspace.pagination?.current.hasMore == false)
    #expect(workspace.pagination?.history.hasMore == false)
}

@Test("native manager rejects non-exact unassign success without an exception")
func managerUnassignResultRequiresException() throws {
    let command = try ManagerPickAssignmentCommand(
        assignment: pickAssignment(),
        assignedTo: nil,
        reason: "Manager intervention required.",
        idempotencyKey: "fixed-command"
    )
    let result = ManagerPickAssignmentResult(
        orderGlobalId: command.orderGlobalId,
        orderStatus: "released",
        previousRowVersion: 4,
        rowVersion: 5,
        taskCount: 2,
        previousAssignedTo: "picker@example.com",
        assignedTo: nil,
        interventionExceptionGlobalId: nil,
        providerWrites: 0,
        replayed: false
    )
    #expect(throws: PickingContractError.contextMismatch) {
        _ = try result.validated(for: command)
    }
}

@Test("native manager preserves a structured assignment conflict")
func nativeManagerPreservesStructuredConflict() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagerPickConflictURLProtocol.self]
    let client = try PickingAPIClient(
        origin: URL(string: "https://native-manager-pick-conflict.test")!,
        session: URLSession(configuration: configuration)
    )
    let command = try ManagerPickAssignmentCommand(
        assignment: pickAssignment(),
        assignedTo: "next@example.com",
        reason: "Reassign exact work.",
        idempotencyKey: "fixed-command"
    )
    do {
        _ = try await client.managePickerAssignment(command)
        Issue.record("Expected exact scan-evidence conflict")
    } catch let error as PickingAPIError {
        #expect(error == .rejected(
            code: "OPERATIONS_PICK_ASSIGNMENT_SCAN_EVIDENCE_EXISTS",
            message: "Current-version scan evidence exists. Use picker handoff or resolve the physical work before changing assignment."
        ))
    }
}
