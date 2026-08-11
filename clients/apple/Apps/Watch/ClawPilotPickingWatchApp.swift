@preconcurrency import AVFoundation
import ImageIO
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
                actionStatus
                if let snapshot = model.snapshot {
                    if let current = snapshot.current {
                        currentPick(snapshot: snapshot, current: current)
                    } else {
                        confirmation(snapshot: snapshot)
                    }
                } else {
                    emptyState
                }
            }
            .padding(.horizontal, 4)
        }
        .containerBackground(.black.gradient, for: .navigation)
        .onAppear { model.activate() }
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

    @ViewBuilder
    private var actionStatus: some View {
        HStack(spacing: 6) {
            if model.isCommandPending {
                ProgressView()
                    .controlSize(.mini)
            }
            Text(model.actionStatus.isEmpty ? "Ready" : model.actionStatus)
                .lineLimit(2)
        }
        .font(.caption2)
        .foregroundStyle(model.lastActionSucceeded == false ? Color.red : Color.secondary)
        .frame(maxWidth: .infinity, minHeight: 30, maxHeight: 38, alignment: .leading)
        .accessibilityElement(children: .combine)
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

            productImage(model.productImage, isExpected: current.productImageURL != nil)

            Text(current.locationCode)
                .font(.system(size: 25, weight: .bold, design: .rounded))
                .foregroundStyle(Color.blue)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            if current.locationScanRequired == true {
                Label {
                    Text(current.locationBarcode.map { "Scan location label \($0) first" }
                         ?? "Scan this location before the product")
                        .lineLimit(2)
                } icon: {
                    Image(systemName: "mappin.and.ellipse")
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.orange)
            }

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
            .disabled(!model.isReachable || model.isCommandPending)

            HStack {
                Button {
                    model.readInstruction()
                } label: {
                    Image(systemName: model.isSpeaking ? "speaker.slash.fill" : "speaker.wave.2.fill")
                }
                .accessibilityLabel(model.isSpeaking ? "Instruction is playing" : "Read instruction")
                .disabled(model.isSpeaking || model.isCommandPending)

                Button {
                    model.send(.refreshQueue)
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh picks")
                .disabled(!model.isReachable || model.isCommandPending)
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
    private func productImage(_ image: CGImage?, isExpected: Bool) -> some View {
        ZStack {
            Color.white.opacity(image == nil ? 0.07 : 0.96)
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFit()
                    .padding(4)
            } else if isExpected {
                VStack(spacing: 5) {
                    ProgressView()
                    Text("Syncing image")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else {
                imagePlaceholder
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: isExpected ? 82 : 54)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(image == nil ? "Product image unavailable" : "Product image")
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
            .disabled(!model.isReachable || model.isCommandPending)
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
            .disabled(!model.isReachable || model.isCommandPending)
        }
    }
}

@MainActor
final class WatchPickModel: NSObject, ObservableObject, WCSessionDelegate, AVSpeechSynthesizerDelegate {
    private enum Key {
        static let pickSnapshot = "pickSnapshot"
        static let productImageData = "pickProductImageData"
        static let productImageSource = "pickProductImageSource"
        static let commandResult = "pickCommandResult"
    }

    @Published private(set) var snapshot: WatchPickSnapshot?
    @Published private(set) var productImage: CGImage?
    @Published private(set) var isReachable = false
    @Published private(set) var isCommandPending = false
    @Published private(set) var isSpeaking = false
    @Published private(set) var actionStatus = ""
    @Published private(set) var lastActionSucceeded: Bool?

    private let snapshotDefaultsKey = "clawpilot.pick.snapshot.v1"
    private let imageSourceDefaultsKey = "clawpilot.pick.image.source.v1"
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    private let speech = AVSpeechSynthesizer()
    private var pendingCommandID: String?
    private var pendingAction: WatchPickAction?
    private var commandTimeoutTask: Task<Void, Never>?

    override init() {
        super.init()
        speech.delegate = self
        speech.usesApplicationAudioSession = false
        if let data = UserDefaults.standard.data(forKey: snapshotDefaultsKey) {
            snapshot = try? Self.decoder.decode(WatchPickSnapshot.self, from: data)
        }
        restoreProductImageIfCurrent()
        activate()
    }

    deinit {
        commandTimeoutTask?.cancel()
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        if session.activationState != .activated {
            session.activate()
        }
        isReachable = session.isReachable
        if session.activationState == .activated {
            applyContext(session.receivedApplicationContext)
        }
    }

    func send(_ action: WatchPickAction) {
        guard !isCommandPending else {
            actionStatus = "Wait for the current iPhone action to finish."
            return
        }
        guard let session,
              session.activationState == .activated,
              session.isReachable else {
            actionStatus = "Open ClawPilot on the paired iPhone, then try again."
            lastActionSucceeded = false
            isReachable = session?.isReachable == true
            return
        }
        let command = WatchPickCommand(action: action)
        guard let data = try? JSONEncoder().encode(command) else {
            actionStatus = "The Watch command could not be prepared."
            lastActionSucceeded = false
            return
        }

        pendingCommandID = command.id
        pendingAction = action
        isCommandPending = true
        lastActionSucceeded = nil
        actionStatus = Self.pendingMessage(for: action)
        startCommandTimeout(for: command)

        session.sendMessageData(data) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.pendingCommandID == command.id else { return }
                self.isReachable = true
                self.actionStatus = Self.acceptedMessage(for: action)
            }
        } errorHandler: { [weak self] _ in
            Task { @MainActor in
                guard let self, self.pendingCommandID == command.id else { return }
                self.finishPendingCommand(
                    succeeded: false,
                    message: "The iPhone did not receive the command. Open ClawPilot and try again."
                )
                self.isReachable = session.isReachable
            }
        }
    }

    func readInstruction() {
        guard let snapshot, let current = snapshot.current else {
            actionStatus = "No current pick instruction is available."
            lastActionSucceeded = false
            return
        }
        if snapshot.readInstructionOnPhone == true, session?.isReachable == true {
            send(.readInstruction)
            return
        }
        guard !speech.isSpeaking, !isSpeaking else {
            actionStatus = "The instruction is already playing."
            return
        }

        let languageCode = snapshot.instructionLanguageCode == "es" ? "es" : "en"
        let text = PickVoice.instruction(
            productName: current.productName,
            locationCode: current.locationCode,
            quantity: current.quantity,
            locationScanRequired: current.locationScanRequired == true,
            languageCode: languageCode
        )
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(
            language: languageCode == "es" ? "es-US" : "en-US"
        )
        utterance.rate = 0.48
        isSpeaking = true
        lastActionSucceeded = nil
        actionStatus = "Playing instruction on Apple Watch."
        speech.speak(utterance)
    }

    private func startCommandTimeout(for command: WatchPickCommand) {
        commandTimeoutTask?.cancel()
        commandTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: command.action == .requestMetaScan ? .seconds(35) : .seconds(15))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.pendingCommandID == command.id else { return }
                self.finishPendingCommand(
                    succeeded: false,
                    message: "The iPhone action is taking too long. Keep ClawPilot open and try again."
                )
            }
        }
    }

    private func finishPendingCommand(succeeded: Bool, message: String) {
        commandTimeoutTask?.cancel()
        commandTimeoutTask = nil
        pendingCommandID = nil
        pendingAction = nil
        isCommandPending = false
        lastActionSucceeded = succeeded
        actionStatus = message
    }

    private func applySnapshot(_ data: Data) {
        guard !data.isEmpty else {
            UserDefaults.standard.removeObject(forKey: snapshotDefaultsKey)
            try? FileManager.default.removeItem(at: snapshotCacheURL())
            snapshot = nil
            clearProductImage()
            return
        }
        guard let decoded = try? Self.decoder.decode(WatchPickSnapshot.self, from: data),
              decoded.schemaVersion == 1 else { return }
        try? data.write(to: snapshotCacheURL(), options: [.atomic, .completeFileProtection])
        UserDefaults.standard.set(data, forKey: snapshotDefaultsKey)
        snapshot = decoded
        restoreProductImageIfCurrent()

        if pendingAction == .refreshQueue {
            finishPendingCommand(
                succeeded: true,
                message: decoded.current == nil
                    ? "Picks refreshed. No item is currently assigned."
                    : "Picks refreshed. The current item is ready."
            )
        } else if actionStatus.isEmpty {
            actionStatus = "Pick synced from iPhone."
        }
    }

    private func applyProductImage(data: Data, source: String) {
        guard data.count <= WatchConnectivityPayloadBudget.maximumProductImageBytes,
              snapshot?.current?.productImageURL?.absoluteString == source,
              let decoded = Self.decodeProductImage(data) else { return }
        try? data.write(to: imageCacheURL(), options: [.atomic, .completeFileProtection])
        UserDefaults.standard.set(source, forKey: imageSourceDefaultsKey)
        productImage = decoded
    }

    private func applyCommandResult(_ data: Data) {
        guard let result = try? Self.decoder.decode(WatchPickCommandResult.self, from: data),
              result.schemaVersion == 1,
              result.commandId == pendingCommandID else { return }
        finishPendingCommand(succeeded: result.succeeded, message: result.message)
    }

    private func applyContext(_ context: [String: Any]) {
        applyPayload(
            snapshotData: context[Key.pickSnapshot] as? Data,
            productImageData: context[Key.productImageData] as? Data,
            productImageSource: context[Key.productImageSource] as? String,
            commandResultData: context[Key.commandResult] as? Data
        )
    }

    private func applyPayload(
        snapshotData: Data?,
        productImageData: Data?,
        productImageSource: String?,
        commandResultData: Data?
    ) {
        if let data = snapshotData {
            applySnapshot(data)
        }
        if let data = productImageData, let source = productImageSource {
            applyProductImage(data: data, source: source)
        }
        if let data = commandResultData {
            applyCommandResult(data)
        }
    }

    private func restoreProductImageIfCurrent() {
        guard let source = UserDefaults.standard.string(forKey: imageSourceDefaultsKey),
              source == snapshot?.current?.productImageURL?.absoluteString,
              let data = try? Data(contentsOf: imageCacheURL()),
              let decoded = Self.decodeProductImage(data) else {
            clearProductImage()
            return
        }
        productImage = decoded
    }

    private func clearProductImage() {
        productImage = nil
        UserDefaults.standard.removeObject(forKey: imageSourceDefaultsKey)
        try? FileManager.default.removeItem(at: imageCacheURL())
    }

    private static func decodeProductImage(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 320,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    private func snapshotCacheURL() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("clawpilot-watch-pick.json")
    }

    private func imageCacheURL() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("clawpilot-watch-product.jpg")
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static func pendingMessage(for action: WatchPickAction) -> String {
        switch action {
        case .requestMetaScan: "Starting the glasses scan…"
        case .readInstruction: "Starting instruction audio…"
        case .confirmPick: "Confirming picks…"
        case .refreshQueue: "Refreshing picks…"
        }
    }

    private static func acceptedMessage(for action: WatchPickAction) -> String {
        switch action {
        case .requestMetaScan: "iPhone is running the glasses scan…"
        case .readInstruction: "iPhone is starting instruction audio…"
        case .confirmPick: "iPhone is confirming picks…"
        case .refreshQueue: "iPhone is refreshing picks…"
        }
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        let reachable = activationState == .activated && session.isReachable
        let context = session.receivedApplicationContext
        let snapshotData = context["pickSnapshot"] as? Data
        let imageData = context["pickProductImageData"] as? Data
        let imageSource = context["pickProductImageSource"] as? String
        let commandResultData = context["pickCommandResult"] as? Data
        Task { @MainActor in
            self.isReachable = reachable
            if error == nil {
                self.applyPayload(
                    snapshotData: snapshotData,
                    productImageData: imageData,
                    productImageSource: imageSource,
                    commandResultData: commandResultData
                )
            }
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
        let snapshotData = applicationContext["pickSnapshot"] as? Data
        let imageData = applicationContext["pickProductImageData"] as? Data
        let imageSource = applicationContext["pickProductImageSource"] as? String
        let commandResultData = applicationContext["pickCommandResult"] as? Data
        Task { @MainActor in
            self.applyPayload(
                snapshotData: snapshotData,
                productImageData: imageData,
                productImageSource: imageSource,
                commandResultData: commandResultData
            )
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        let snapshotData = message["pickSnapshot"] as? Data
        let imageData = message["pickProductImageData"] as? Data
        let imageSource = message["pickProductImageSource"] as? String
        let commandResultData = message["pickCommandResult"] as? Data
        Task { @MainActor in
            self.applyPayload(
                snapshotData: snapshotData,
                productImageData: imageData,
                productImageSource: imageSource,
                commandResultData: commandResultData
            )
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        Task { @MainActor in
            if let result = try? Self.decoder.decode(WatchPickCommandResult.self, from: messageData),
               result.schemaVersion == 1 {
                self.applyCommandResult(messageData)
            } else {
                self.applySnapshot(messageData)
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let snapshotData = userInfo["pickSnapshot"] as? Data
        let imageData = userInfo["pickProductImageData"] as? Data
        let imageSource = userInfo["pickProductImageSource"] as? String
        let commandResultData = userInfo["pickCommandResult"] as? Data
        Task { @MainActor in
            self.applyPayload(
                snapshotData: snapshotData,
                productImageData: imageData,
                productImageSource: imageSource,
                commandResultData: commandResultData
            )
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            self.isSpeaking = false
            self.lastActionSucceeded = true
            self.actionStatus = "Instruction complete."
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in
            self.isSpeaking = false
            self.lastActionSucceeded = false
            self.actionStatus = "Instruction playback stopped."
        }
    }
}
