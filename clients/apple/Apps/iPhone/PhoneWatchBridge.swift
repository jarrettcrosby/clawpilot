import Foundation
import WatchConnectivity
import ClawPilotPickingCore

@MainActor
final class PhoneWatchBridge: NSObject, WCSessionDelegate {
    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    private var handledCommandIDs: [String] = []
    var onCommand: (@MainActor (WatchPickCommand) -> Void)?

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }

    func publish(_ snapshot: WatchPickSnapshot?) {
        guard let session else { return }
        let data = snapshot.flatMap { try? JSONEncoder.clawPilot.encode($0) } ?? Data()
        try? session.updateApplicationContext(["pickSnapshot": data])
        if session.isReachable {
            session.sendMessageData(data, replyHandler: nil, errorHandler: nil)
        }
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}

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
        replyHandler(Data("Command received by iPhone.".utf8))
        Task { @MainActor in self.receiveCommand(command) }
    }

    private func receiveCommand(_ command: WatchPickCommand) {
        guard !handledCommandIDs.contains(command.id) else { return }
        handledCommandIDs.append(command.id)
        if handledCommandIDs.count > 32 { handledCommandIDs.removeFirst() }
        onCommand?(command)
    }
}

extension JSONEncoder {
    static var clawPilot: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
