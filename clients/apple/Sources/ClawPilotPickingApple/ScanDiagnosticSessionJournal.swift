import Foundation

public enum ClawPilotScanDiagnosticSource: String, Codable, Sendable {
    case meta
    case iphone
}

public struct ClawPilotScanDiagnosticEvent: Codable, Equatable, Sendable {
    public let timestamp: TimeInterval
    public let name: String
    public let stage: String
    public let timingsMilliseconds: [String: UInt64]
    public let symbologies: [String]
    public let expectedMatch: Bool?

    public init(
        timestamp: TimeInterval,
        name: String,
        stage: String,
        timingsMilliseconds: [String: UInt64] = [:],
        symbologies: [String] = [],
        expectedMatch: Bool? = nil
    ) {
        self.timestamp = timestamp
        self.name = name
        self.stage = stage
        self.timingsMilliseconds = timingsMilliseconds
        self.symbologies = symbologies
        self.expectedMatch = expectedMatch
    }
}

public struct ClawPilotScanDiagnosticSession: Codable, Equatable, Sendable {
    public let id: UUID
    public let source: ClawPilotScanDiagnosticSource
    public let build: String
    public let startedAt: TimeInterval
    public var endedAt: TimeInterval?
    public var stage: String
    public var events: [ClawPilotScanDiagnosticEvent]

    public init(
        id: UUID,
        source: ClawPilotScanDiagnosticSource,
        build: String,
        startedAt: TimeInterval,
        endedAt: TimeInterval? = nil,
        stage: String,
        events: [ClawPilotScanDiagnosticEvent] = []
    ) {
        self.id = id
        self.source = source
        self.build = build
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.stage = stage
        self.events = events
    }
}

/// A value-type journal makes retention and source isolation independently
/// testable. Persistence remains an app concern; this type never sees barcode
/// payloads or image data.
public struct ClawPilotScanDiagnosticJournal: Codable, Equatable, Sendable {
    public let maximumSessionsPerSource: Int
    public let maximumEventsPerSession: Int
    private var metaSessions: [ClawPilotScanDiagnosticSession]
    private var iphoneSessions: [ClawPilotScanDiagnosticSession]

    public init(
        maximumSessionsPerSource: Int = 8,
        maximumEventsPerSession: Int = 80
    ) {
        self.maximumSessionsPerSource = max(1, maximumSessionsPerSource)
        self.maximumEventsPerSession = max(1, maximumEventsPerSession)
        metaSessions = []
        iphoneSessions = []
    }

    public func sessions(
        for source: ClawPilotScanDiagnosticSource
    ) -> [ClawPilotScanDiagnosticSession] {
        source == .meta ? metaSessions : iphoneSessions
    }

    public mutating func begin(
        source: ClawPilotScanDiagnosticSource,
        build: String,
        stage: String,
        timestamp: TimeInterval,
        id: UUID = UUID()
    ) {
        var sessions = self.sessions(for: source)
        if let lastIndex = sessions.indices.last,
           sessions[lastIndex].endedAt == nil {
            sessions[lastIndex].endedAt = timestamp
        }
        sessions.append(
            ClawPilotScanDiagnosticSession(
                id: id,
                source: source,
                build: build,
                startedAt: timestamp,
                stage: stage
            )
        )
        replace(
            source: source,
            with: Array(sessions.suffix(maximumSessionsPerSource))
        )
    }

    @discardableResult
    public mutating func record(
        source: ClawPilotScanDiagnosticSource,
        build: String,
        event: String,
        stage: String?,
        timestamp: TimeInterval,
        timingsMilliseconds: [String: UInt64] = [:],
        symbologies: [String] = [],
        expectedMatch: Bool? = nil
    ) -> String {
        var sessions = self.sessions(for: source)
        if sessions.last?.endedAt != nil || sessions.isEmpty {
            sessions.append(
                ClawPilotScanDiagnosticSession(
                    id: UUID(),
                    source: source,
                    build: build,
                    startedAt: timestamp,
                    stage: stage ?? "unknown"
                )
            )
        }
        let lastIndex = sessions.index(before: sessions.endIndex)
        if let stage { sessions[lastIndex].stage = stage }
        let currentStage = sessions[lastIndex].stage
        sessions[lastIndex].events.append(
            ClawPilotScanDiagnosticEvent(
                timestamp: timestamp,
                name: event,
                stage: currentStage,
                timingsMilliseconds: timingsMilliseconds,
                symbologies: symbologies,
                expectedMatch: expectedMatch
            )
        )
        sessions[lastIndex].events = Array(
            sessions[lastIndex].events.suffix(maximumEventsPerSession)
        )
        replace(
            source: source,
            with: Array(sessions.suffix(maximumSessionsPerSource))
        )
        return currentStage
    }

    public mutating func end(
        source: ClawPilotScanDiagnosticSource,
        timestamp: TimeInterval
    ) {
        var sessions = self.sessions(for: source)
        guard let lastIndex = sessions.indices.last else { return }
        sessions[lastIndex].endedAt = timestamp
        replace(source: source, with: sessions)
    }

    private mutating func replace(
        source: ClawPilotScanDiagnosticSource,
        with sessions: [ClawPilotScanDiagnosticSession]
    ) {
        if source == .meta {
            metaSessions = sessions
        } else {
            iphoneSessions = sessions
        }
    }
}
