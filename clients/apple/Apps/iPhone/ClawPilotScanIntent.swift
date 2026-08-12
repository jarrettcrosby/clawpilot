import AppIntents
import Foundation
import ClawPilotPickingApple

enum PendingMobileAction {
    private static let scanKey = "clawpilot_pending_meta_scan"

    static func requestMetaScan() {
        UserDefaults.standard.set(true, forKey: scanKey)
    }

    static var hasMetaScanRequest: Bool {
        UserDefaults.standard.bool(forKey: scanKey)
    }

    static func clearMetaScanRequest() {
        UserDefaults.standard.removeObject(forKey: scanKey)
    }
}

enum ClawPilotScanDiagnostic {
    typealias Source = ClawPilotScanDiagnosticSource

    private static let stageKey = "clawpilot_last_scan_stage"
    private static let dateKey = "clawpilot_last_scan_date"
    private static let historyKey = "clawpilot_scan_history"
    private static let journalKey = "clawpilot_scan_journal_v2"
    private static let lock = NSLock()

    static func begin(_ stage: String) {
        let source = inferredSource(from: stage)
        begin(source: source, stage: inferredStage(from: stage))
        recordCompatibility(sanitized(stage, fallback: "event"))
    }

    static func record(_ stage: String) {
        let parsed = parsedFields(from: stage)
        record(
            source: inferredSource(from: stage),
            event: stage,
            stage: explicitStage(in: stage),
            timingsMilliseconds: parsed.timingsMilliseconds,
            symbologies: parsed.symbologies,
            expectedMatch: parsed.expectedMatch
        )
    }

    static func begin(source: Source, stage: String) {
        let timestamp = Date().timeIntervalSince1970
        let safeStage = sanitized(stage, fallback: "unknown")
        lock.lock()
        var journal = loadJournalLocked()
        journal.begin(
            source: source,
            build: currentBuild,
            stage: safeStage,
            timestamp: timestamp
        )
        saveJournalLocked(journal)
        lock.unlock()
        print(
            "[ClawPilotScan] source=\(source.rawValue) build=\(currentBuild) stage=\(safeStage) event=session-began"
        )
    }

    static func transition(source: Source, stage: String) {
        record(
            source: source,
            event: "stage-transition",
            stage: stage
        )
    }

    static func end(source: Source, event: String = "session-ended") {
        let timestamp = Date().timeIntervalSince1970
        record(source: source, event: event)
        lock.lock()
        var journal = loadJournalLocked()
        journal.end(source: source, timestamp: timestamp)
        saveJournalLocked(journal)
        lock.unlock()
    }

    static func record(
        source: Source,
        event: String,
        stage: String? = nil,
        timingsMilliseconds: [String: UInt64] = [:],
        symbologies: [String] = [],
        expectedMatch: Bool? = nil
    ) {
        let timestamp = Date().timeIntervalSince1970
        let safeEvent = sanitized(event, fallback: "event")
        let safeStage = stage.map { sanitized($0, fallback: "unknown") }
        let safeTimings = Dictionary(uniqueKeysWithValues: timingsMilliseconds.map {
            (sanitizedFieldName($0.key), $0.value)
        })
        let safeSymbologies = Array(Set(symbologies.map {
            sanitized($0, fallback: "unknown")
        })).sorted()

        lock.lock()
        var journal = loadJournalLocked()
        let currentStage = journal.record(
            source: source,
            build: currentBuild,
            event: safeEvent,
            stage: safeStage,
            timestamp: timestamp,
            timingsMilliseconds: safeTimings,
            symbologies: safeSymbologies,
            expectedMatch: expectedMatch
        )
        saveJournalLocked(journal)
        lock.unlock()

        let timingText = safeTimings.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
        let symbologyText = safeSymbologies.isEmpty
            ? "none"
            : safeSymbologies.joined(separator: ",")
        let expectedText = expectedMatch.map(String.init) ?? "unknown"
        print(
            "[ClawPilotScan] source=\(source.rawValue) build=\(currentBuild) stage=\(currentStage) event=\(safeEvent) timings_ms=\(timingText) symbology=\(symbologyText) expected_match=\(expectedText)"
        )
        recordCompatibility(safeEvent)
    }

    private static var currentBuild: String {
        let version = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "unknown"
        let build = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "unknown"
        return sanitized("\(version)(\(build))", fallback: "unknown")
    }

    private static func loadJournalLocked() -> ClawPilotScanDiagnosticJournal {
        guard let data = UserDefaults.standard.data(forKey: journalKey),
              let journal = try? JSONDecoder().decode(
                ClawPilotScanDiagnosticJournal.self,
                from: data
              )
        else { return ClawPilotScanDiagnosticJournal() }
        return journal
    }

    private static func saveJournalLocked(_ journal: ClawPilotScanDiagnosticJournal) {
        guard let data = try? JSONEncoder().encode(journal) else { return }
        UserDefaults.standard.set(data, forKey: journalKey)
    }

    private static func inferredSource(from value: String) -> Source {
        value.lowercased().hasPrefix("iphone:") ? .iphone : .meta
    }

    private static func inferredStage(from value: String) -> String {
        explicitStage(in: value) ?? "unknown"
    }

    private static func explicitStage(in value: String) -> String? {
        guard let range = value.range(of: "stage=") else { return nil }
        let suffix = value[range.upperBound...]
        let stage = suffix.prefix { $0 != ":" && $0 != "," }
        return stage.isEmpty ? nil : String(stage)
    }

    private static func parsedFields(
        from value: String
    ) -> (
        timingsMilliseconds: [String: UInt64],
        symbologies: [String],
        expectedMatch: Bool?
    ) {
        let parts = value.split(separator: ":").map(String.init)
        var timings: [String: UInt64] = [:]
        var symbologies: [String] = []
        var expectedMatch: Bool?
        for part in parts.dropFirst() {
            guard let separator = part.firstIndex(of: "=") else { continue }
            let key = String(part[..<separator])
            let rawValue = String(part[part.index(after: separator)...])
            if key.hasSuffix("_ms"), let value = UInt64(rawValue) {
                timings[String(key.dropLast(3))] = value
            } else if key == "symbology", rawValue != "none" {
                symbologies = rawValue.split(separator: ",").map(String.init)
            } else if key == "expected_match" {
                if rawValue == "true" { expectedMatch = true }
                if rawValue == "false" { expectedMatch = false }
            }
        }
        return (timings, symbologies, expectedMatch)
    }

    private static func sanitized(_ value: String, fallback: String) -> String {
        let redacted = value
            .replacingOccurrences(
                of: #"(?i)(payload|image|barcode_value)=[^:,\s]+"#,
                with: "$1=<redacted>",
                options: .regularExpression
            )
        let scalarView = redacted.unicodeScalars.filter {
            !CharacterSet.controlCharacters.contains($0) || $0 == " "
        }
        let bounded = String(String.UnicodeScalarView(scalarView)).prefix(240)
        return bounded.isEmpty ? fallback : String(bounded)
    }

    private static func sanitizedFieldName(_ value: String) -> String {
        let safe = value.lowercased().filter {
            $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-"
        }
        return safe.isEmpty ? "timing" : String(safe.prefix(40))
    }

    private static func recordCompatibility(_ stage: String) {
        let timestamp = Date().timeIntervalSince1970
        UserDefaults.standard.set(stage, forKey: stageKey)
        UserDefaults.standard.set(timestamp, forKey: dateKey)
        var history = UserDefaults.standard.stringArray(forKey: historyKey) ?? []
        history.append("\(timestamp):\(stage)")
        UserDefaults.standard.set(Array(history.suffix(30)), forKey: historyKey)
    }
}

enum ClawPilotSystemActionLink {
    private static let actionName = "clawpilot_action"
    private static let scanAction = "scan"

    static func scanURL() -> URL {
        let configured = Bundle.main.object(
            forInfoDictionaryKey: "ClawPilotServerOrigin"
        ) as? String ?? "https://aiapp.eigenracing.com"
        var components = URLComponents(
            url: URL(string: configured)!.appending(path: "ios"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: actionName, value: scanAction)]
        return components.url!
    }

    static func requestsScan(_ url: URL) -> Bool {
        guard let expected = URLComponents(
            url: scanURL(),
            resolvingAgainstBaseURL: false
        ),
        let received = URLComponents(url: url, resolvingAgainstBaseURL: false),
        expected.scheme == received.scheme,
        expected.host == received.host,
        received.path == "/ios"
        else { return false }

        return received.queryItems?.contains {
            $0.name == actionName && $0.value == scanAction
        } == true
    }
}

@available(iOS 18.0, *)
struct StartClawPilotGlassesScanIntent: AppIntent {
    static let title: LocalizedStringResource = "Scan with ClawPilot"
    static let description = IntentDescription(
        "Opens the assigned ClawPilot pick and starts a Meta glasses barcode scan."
    )
    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
        PendingMobileAction.requestMetaScan()
        ClawPilotScanDiagnostic.begin("intent-requested")
        return .result(
            opensIntent: OpenURLIntent(ClawPilotSystemActionLink.scanURL()),
            dialog: "Opening ClawPilot to scan the assigned item."
        )
    }
}

@available(iOS 18.0, *)
struct ClawPilotAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartClawPilotGlassesScanIntent(),
            phrases: [
                "Scan with \(.applicationName)",
                "Start glasses scan with \(.applicationName)",
                "Scan my pick with \(.applicationName)",
            ],
            shortTitle: "Scan with glasses",
            systemImageName: "barcode.viewfinder"
        )
    }
}
