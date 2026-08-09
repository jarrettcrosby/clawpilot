import SwiftUI
import WatchConnectivity
import ClawPilotPickingCore

@main
struct ClawPilotPickingWatchApp: App {
    @StateObject private var model = WatchPickModel()

    var body: some Scene {
        WindowGroup {
            WatchPickView(model: model)
        }
    }
}

private struct WatchPickView: View {
    @ObservedObject var model: WatchPickModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                brandHeader
                if let snapshot = model.snapshot {
                    if let current = snapshot.current {
                        currentPick(snapshot: snapshot, current: current)
                    } else {
                        confirmation(snapshot: snapshot)
                    }
                } else {
                    emptyState
                }
                if !model.actionStatus.isEmpty {
                    Text(model.actionStatus)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 4)
        }
        .containerBackground(.black.gradient, for: .navigation)
    }

    private var brandHeader: some View {
        HStack(spacing: 6) {
            Image("ClawPilotMark")
                .resizable()
                .scaledToFit()
                .frame(width: 22, height: 22)
            Text("ClawPilot")
                .font(.headline)
            Spacer()
            Circle()
                .fill(model.isReachable ? Color.green : Color.orange)
                .frame(width: 7, height: 7)
                .accessibilityLabel(model.isReachable ? "iPhone connected" : "Open ClawPilot on iPhone")
        }
    }

    private func currentPick(snapshot: WatchPickSnapshot, current: WatchPickCard) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text("ORDER \(snapshot.orderNumber)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(current.progress)
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .foregroundStyle(Color.blue)
            }

            productImage(current.productImageURL)

            Text(current.locationCode)
                .font(.system(size: 25, weight: .bold, design: .rounded))
                .foregroundStyle(Color.blue)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            Text(current.productName)
                .font(.headline)
                .lineLimit(3)

            HStack {
                if let sku = current.channelSku {
                    Text(sku)
                        .lineLimit(1)
                }
                Spacer()
                Text("QTY \(current.quantity.formatted())")
                    .fontWeight(.bold)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Button {
                model.send(.requestMetaScan)
            } label: {
                Label("Scan with glasses", systemImage: "eyeglasses")
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.blue)
            .disabled(!model.isReachable)

            HStack {
                Button {
                    model.send(.readInstruction)
                } label: {
                    Image(systemName: "speaker.wave.2.fill")
                }
                .accessibilityLabel("Read instruction")
                .disabled(!model.isReachable)

                Button {
                    model.send(.refreshQueue)
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh picks")
                .disabled(!model.isReachable)
            }

            if let next = snapshot.upcoming.first {
                Divider()
                Text("NEXT · \(next.locationCode)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(next.productName)
                    .font(.caption)
                    .lineLimit(2)
            }
        }
    }

    @ViewBuilder
    private func productImage(_ url: URL?) -> some View {
        if let url {
            AsyncImage(url: url, transaction: Transaction(animation: .easeInOut)) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .failure:
                    imagePlaceholder
                case .empty:
                    ProgressView()
                @unknown default:
                    imagePlaceholder
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 82)
            .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        } else {
            imagePlaceholder
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var imagePlaceholder: some View {
        Image(systemName: "shippingbox.fill")
            .font(.title2)
            .foregroundStyle(.secondary)
    }

    private func confirmation(snapshot: WatchPickSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Order \(snapshot.orderNumber)")
                .font(.caption)
                .foregroundStyle(.secondary)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 38))
                .foregroundStyle(.green)
            Text("Every item scanned")
                .font(.headline)
            Text("Confirm through the paired iPhone so ClawPilot records the audited pick state.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Confirm picks") {
                model.send(.confirmPick)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .disabled(!model.isReachable)
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "shippingbox")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No assigned pick")
                .font(.headline)
            Text(model.isReachable
                 ? "Refresh after a manager releases and assigns work."
                 : "Open ClawPilot on the paired iPhone to sync picks.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                model.send(.refreshQueue)
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(!model.isReachable)
        }
    }
}

@MainActor
final class WatchPickModel: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var snapshot: WatchPickSnapshot?
    @Published private(set) var isReachable = false
    @Published private(set) var actionStatus = ""
    private let key = "clawpilot.pick.snapshot.v1"
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: key) {
            snapshot = try? Self.decoder.decode(WatchPickSnapshot.self, from: data)
        }
        session?.delegate = self
        session?.activate()
        isReachable = session?.isReachable == true
    }

    func send(_ action: WatchPickAction) {
        guard let session, session.isReachable else {
            actionStatus = "Open ClawPilot on the paired iPhone, then try again."
            isReachable = false
            return
        }
        guard let data = try? JSONEncoder().encode(WatchPickCommand(action: action)) else {
            actionStatus = "The Watch command could not be prepared."
            return
        }
        session.sendMessageData(data, replyHandler: nil) { [weak self] _ in
            Task { @MainActor in
                self?.isReachable = false
                self?.actionStatus = "The iPhone did not receive the command. Open ClawPilot and try again."
            }
        }
        switch action {
        case .requestMetaScan: actionStatus = "Glasses scan requested."
        case .readInstruction: actionStatus = "Instruction requested."
        case .confirmPick: actionStatus = "Confirmation sent to ClawPilot on iPhone."
        case .refreshQueue: actionStatus = "Pick refresh requested."
        }
    }

    private func apply(_ data: Data) {
        guard !data.isEmpty else {
            UserDefaults.standard.removeObject(forKey: key)
            try? FileManager.default.removeItem(at: cacheURL())
            snapshot = nil
            return
        }
        guard let decoded = try? Self.decoder.decode(WatchPickSnapshot.self, from: data),
              decoded.schemaVersion == 1 else { return }
        try? data.write(to: cacheURL(), options: [.atomic, .completeFileProtection])
        UserDefaults.standard.set(data, forKey: key)
        snapshot = decoded
        actionStatus = "Pick synced from iPhone."
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
        let reachable = session.isReachable
        let data = session.receivedApplicationContext["pickSnapshot"] as? Data
        Task { @MainActor in
            self.isReachable = reachable
            if let data { self.apply(data) }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in self.isReachable = reachable }
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
