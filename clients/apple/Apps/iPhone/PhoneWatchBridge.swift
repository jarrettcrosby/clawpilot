import Foundation
import ImageIO
import UIKit
import WatchConnectivity
import ClawPilotPickingCore

struct PhoneWatchCommandOutcome: Sendable {
    let succeeded: Bool
    let message: String
    let phonePlaybackStartedAt: Date?

    static func success(_ message: String) -> Self {
        Self(succeeded: true, message: message, phonePlaybackStartedAt: nil)
    }

    static func failure(_ message: String) -> Self {
        Self(succeeded: false, message: message, phonePlaybackStartedAt: nil)
    }

    static func phonePlaybackStarted(_ message: String, startedAt: Date) -> Self {
        Self(succeeded: true, message: message, phonePlaybackStartedAt: startedAt)
    }
}

private actor PhoneWatchOutcomeRace {
    private var outcome: PhoneWatchCommandOutcome?
    private var continuation: CheckedContinuation<PhoneWatchCommandOutcome, Never>?

    func wait() async -> PhoneWatchCommandOutcome {
        if let outcome { return outcome }
        return await withCheckedContinuation { continuation in
            if let outcome {
                continuation.resume(returning: outcome)
            } else {
                self.continuation = continuation
            }
        }
    }

    func resolve(_ outcome: PhoneWatchCommandOutcome) {
        guard self.outcome == nil else { return }
        self.outcome = outcome
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

@MainActor
final class PhoneWatchBridge: NSObject, WCSessionDelegate {
    private enum Key {
        static let pickSnapshot = "pickSnapshot"
        static let productImageData = "pickProductImageData"
        static let productImageSource = "pickProductImageSource"
        static let commandResult = "pickCommandResult"
    }

    private static let maximumSourceImageBytes = 12 * 1_024 * 1_024
    private static let maximumWatchImageBytes =
        WatchConnectivityPayloadBudget.maximumProductImageBytes
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    private var handledCommandIDs: [String] = []
    private var latestSnapshotData = Data()
    private var latestProductImageURL: URL?
    private var latestProductImageData: Data?
    private var latestCommandResultData: Data?
    private var imageTask: Task<Void, Never>?
    var onCommand: (@MainActor (WatchPickCommand) async -> PhoneWatchCommandOutcome)?

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }

    deinit {
        imageTask?.cancel()
    }

    func publish(_ snapshot: WatchPickSnapshot?) {
        latestSnapshotData = snapshot.flatMap { try? JSONEncoder.clawPilot.encode($0) } ?? Data()
        let productImageURL = snapshot?.current?.productImageURL

        if productImageURL != latestProductImageURL {
            imageTask?.cancel()
            imageTask = nil
            latestProductImageURL = productImageURL
            latestProductImageData = nil
            publishCurrentContext()
            prepareProductImage(productImageURL)
            return
        }

        publishCurrentContext()
        if latestProductImageData == nil {
            prepareProductImage(productImageURL)
        }
    }

    private func prepareProductImage(_ url: URL?) {
        guard let url, imageTask == nil else { return }
        imageTask = Task { [weak self] in
            defer {
                if self?.latestProductImageURL == url {
                    self?.imageTask = nil
                }
            }
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = 15
                request.setValue("image/*", forHTTPHeaderField: "Accept")
                let (sourceData, response) = try await URLSession.shared.data(for: request)
                guard !Task.isCancelled,
                      let response = response as? HTTPURLResponse,
                      (200..<300).contains(response.statusCode),
                      !sourceData.isEmpty,
                      sourceData.count <= Self.maximumSourceImageBytes,
                      let jpeg = Self.watchJPEGThumbnail(from: sourceData),
                      jpeg.count <= Self.maximumWatchImageBytes,
                      self?.latestProductImageURL == url else { return }
                self?.latestProductImageData = jpeg
                self?.publishCurrentContext()
            } catch {
                // The URL remains in the pick snapshot. A later refresh retries
                // preparation without making the Watch download a full-size asset.
            }
        }
    }

    private func publishCurrentContext() {
        guard let session, session.activationState == .activated else { return }
        var context: [String: Any] = [Key.pickSnapshot: latestSnapshotData]
        if let latestProductImageURL, let latestProductImageData {
            context[Key.productImageSource] = latestProductImageURL.absoluteString
            context[Key.productImageData] = latestProductImageData
        }
        if let latestCommandResultData {
            context[Key.commandResult] = latestCommandResultData
        }
        if Self.contextByteCount(context) > WatchConnectivityPayloadBudget.maximumApplicationContextBytes {
            context.removeValue(forKey: Key.productImageData)
            context.removeValue(forKey: Key.productImageSource)
        }
        assert(
            Self.contextByteCount(context)
                <= WatchConnectivityPayloadBudget.maximumApplicationContextBytes,
            "Watch current-state context exceeded the ClawPilot transfer budget."
        )
        try? session.updateApplicationContext(context)
        if session.isReachable {
            session.sendMessage(context, replyHandler: nil, errorHandler: nil)
        }
    }

    private static func watchJPEGThumbnail(from sourceData: Data) -> Data? {
        guard let imageSource = CGImageSourceCreateWithData(sourceData as CFData, nil),
              let sourceThumbnail = CGImageSourceCreateThumbnailAtIndex(
                imageSource,
                0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 280,
                    kCGImageSourceShouldCacheImmediately: true,
                ] as CFDictionary
              ) else { return nil }
        let sourceImage = UIImage(cgImage: sourceThumbnail)

        for maximumDimension in [280.0, 220.0, 160.0] {
            let ratio = min(
                1,
                maximumDimension / max(sourceImage.size.width, sourceImage.size.height)
            )
            let size = CGSize(
                width: max(1, (sourceImage.size.width * ratio).rounded()),
                height: max(1, (sourceImage.size.height * ratio).rounded())
            )
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                sourceImage.draw(in: CGRect(origin: .zero, size: size))
            }
            for quality in [0.78, 0.62, 0.46] {
                if let data = thumbnail.jpegData(compressionQuality: quality),
                   data.count <= maximumWatchImageBytes {
                    return data
                }
            }
        }
        return nil
    }

    private static func contextByteCount(_ context: [String: Any]) -> Int {
        (try? PropertyListSerialization.data(
            fromPropertyList: context,
            format: .binary,
            options: 0
        ).count) ?? .max
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated, error == nil else { return }
        Task { @MainActor in
            self.publishCurrentContext()
            if self.latestProductImageData == nil {
                self.prepareProductImage(self.latestProductImageURL)
            }
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let command = try? JSONDecoder().decode(WatchPickCommand.self, from: messageData)
        else { return }
        Task { @MainActor in self.receiveCommand(command) }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveMessageData messageData: Data,
        replyHandler: @escaping (Data) -> Void
    ) {
        guard let command = try? JSONDecoder().decode(WatchPickCommand.self, from: messageData) else {
            replyHandler(Data("The Watch command was invalid.".utf8))
            return
        }
        replyHandler(Data("Command accepted by iPhone.".utf8))
        Task { @MainActor in self.receiveCommand(command) }
    }

    private func receiveCommand(_ command: WatchPickCommand) {
        guard !handledCommandIDs.contains(command.id) else { return }
        handledCommandIDs.append(command.id)
        if handledCommandIDs.count > 32 { handledCommandIDs.removeFirst() }

        let receivedAt = Date()
        let effectivePlaybackDeadline =
            WatchInstructionPlaybackTiming.effectivePhonePlaybackStartDeadline(
                for: command,
                receivedAt: receivedAt
            )
        guard effectivePlaybackDeadline.map({ receivedAt < $0 }) != false else {
            publishCommandResult(WatchPickCommandResult(
                command: command,
                succeeded: false,
                message: "The iPhone audio window expired before the Watch fallback."
            ))
            return
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            let outcome = await self.performCommandWithinPlaybackWindow(
                command,
                effectivePlaybackDeadline: effectivePlaybackDeadline
            )
            self.publishCommandResult(WatchPickCommandResult(
                command: command,
                succeeded: outcome.succeeded,
                message: outcome.message
            ))
        }
    }

    private func performCommandWithinPlaybackWindow(
        _ command: WatchPickCommand,
        effectivePlaybackDeadline: Date?
    ) async -> PhoneWatchCommandOutcome {
        guard command.action == .readInstruction,
              let deadline = effectivePlaybackDeadline else {
            return await onCommand?(command)
                ?? .failure("The iPhone could not handle this Watch command.")
        }

        // The handler and strict audio layer receive the same deadline that
        // this bridge enforces. This bounds legacy commands with no deadline
        // and clamps a corrupt or clock-skewed distant caller deadline.
        let boundedCommand = WatchPickCommand(
            id: command.id,
            action: command.action,
            phonePlaybackStartDeadline: deadline
        )
        let handlerTask = Task { @MainActor [onCommand] in
            await onCommand?(boundedCommand)
                ?? .failure("The iPhone could not handle this Watch command.")
        }
        let race = PhoneWatchOutcomeRace()
        let handlerResultTask = Task {
            let handlerOutcome = await handlerTask.value
            await race.resolve(Self.validatedReadInstructionOutcome(
                handlerOutcome,
                deadline: deadline
            ))
        }
        let deadlineTask = Task {
            let remaining = deadline.timeIntervalSinceNow
            if remaining > 0 {
                try? await Task.sleep(for: .seconds(remaining))
            }
            guard !Task.isCancelled else { return }
            handlerTask.cancel()
            let handlerOutcome = await handlerTask.value
            await race.resolve(Self.validatedReadInstructionOutcome(
                handlerOutcome,
                deadline: deadline
            ))
        }
        let outcome = await race.wait()
        deadlineTask.cancel()
        handlerResultTask.cancel()
        if !outcome.succeeded { handlerTask.cancel() }
        return outcome
    }

    private static func validatedReadInstructionOutcome(
        _ outcome: PhoneWatchCommandOutcome,
        deadline: Date
    ) -> PhoneWatchCommandOutcome {
        guard outcome.succeeded else { return outcome }
        guard WatchInstructionPlaybackTiming.acceptsAcknowledgedPhonePlaybackStart(
            startedAt: outcome.phonePlaybackStartedAt,
            deadline: deadline
        ) else {
            return .failure("The iPhone audio window expired before the Watch fallback.")
        }
        return outcome
    }

    private func publishCommandResult(_ result: WatchPickCommandResult) {
        guard let session,
              session.activationState == .activated,
              let data = try? JSONEncoder.clawPilot.encode(result) else { return }
        latestCommandResultData = data
        publishCurrentContext()
    }
}

extension JSONEncoder {
    static var clawPilot: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
