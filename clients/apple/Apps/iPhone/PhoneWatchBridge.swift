import Foundation
import WatchConnectivity
import ClawPilotPickingCore

@MainActor
final class PhoneWatchBridge: NSObject, WCSessionDelegate {
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        session?.delegate = self
        session?.activate()
    }

    func publish(_ snapshot: WatchPickSnapshot) {
        guard let session, let data = try? JSONEncoder.clawPilot.encode(snapshot) else { return }
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
}

extension JSONEncoder {
    static var clawPilot: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

