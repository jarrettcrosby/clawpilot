import SwiftUI
import WatchConnectivity
import ClawPilotPickingCore

@main
struct ClawPilotPickingWatchApp: App {
    @StateObject private var model = WatchPickModel()

    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 6) {
                if let snapshot = model.snapshot, let current = snapshot.current {
                    Text("Order \(snapshot.orderNumber)").font(.caption)
                    Text(current.locationCode).font(.title2).bold()
                    Text(current.productName).lineLimit(2)
                    Text("Qty \(current.quantity.formatted()) · \(current.progress)")
                        .font(.caption)
                    if let next = snapshot.upcoming.first {
                        Divider()
                        Text("Next: \(next.locationCode) · \(next.productName)")
                            .font(.caption2).lineLimit(2)
                    }
                } else {
                    Text("No assigned pick").foregroundStyle(.secondary)
                }
            }
            .padding()
        }
    }
}

@MainActor
final class WatchPickModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var snapshot: WatchPickSnapshot?
    private let key = "clawpilot.pick.snapshot.v1"

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: key) {
            snapshot = try? Self.decoder.decode(WatchPickSnapshot.self, from: data)
        }
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    private func apply(_ data: Data) {
        guard let decoded = try? Self.decoder.decode(WatchPickSnapshot.self, from: data),
              decoded.schemaVersion == 1 else { return }
        try? data.write(to: cacheURL(), options: [.atomic, .completeFileProtection])
        UserDefaults.standard.set(data, forKey: key)
        snapshot = decoded
    }

    private func cacheURL() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("clawpilot-watch-pick.json")
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let data = session.receivedApplicationContext["pickSnapshot"] as? Data {
            Task { @MainActor in self.apply(data) }
        }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        guard let data = applicationContext["pickSnapshot"] as? Data else { return }
        Task { @MainActor in self.apply(data) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        Task { @MainActor in self.apply(messageData) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let data = userInfo["pickSnapshot"] as? Data else { return }
        Task { @MainActor in self.apply(data) }
    }
}

