import AppIntents
import Foundation

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
    private static let stageKey = "clawpilot_last_scan_stage"
    private static let dateKey = "clawpilot_last_scan_date"
    private static let historyKey = "clawpilot_scan_history"

    static func begin(_ stage: String) {
        UserDefaults.standard.removeObject(forKey: historyKey)
        record(stage)
    }

    static func record(_ stage: String) {
        let timestamp = Date().timeIntervalSince1970
        UserDefaults.standard.set(stage, forKey: stageKey)
        UserDefaults.standard.set(timestamp, forKey: dateKey)
        var history = UserDefaults.standard.stringArray(forKey: historyKey) ?? []
        history.append("\(timestamp):\(stage)")
        UserDefaults.standard.set(Array(history.suffix(30)), forKey: historyKey)
        print("[ClawPilotScan] \(stage)")
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
