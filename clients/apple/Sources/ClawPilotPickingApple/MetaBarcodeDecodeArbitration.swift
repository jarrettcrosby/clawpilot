import Foundation
import ClawPilotPickingCore

public struct MetaBarcodeCandidate: Equatable, Sendable {
    public let payload: String
    public let confidence: Float

    public init(payload: String, confidence: Float) {
        self.payload = payload
        self.confidence = confidence
    }
}

public enum MetaBarcodeDecodeDecision: Equatable, Sendable {
    case selected(MetaBarcodeCandidate)
    case zeroCandidates
    case ambiguous(candidateCount: Int)
}

public struct MetaBarcodeDecodeArbitrator: Sendable {
    public let minimumConfidence: Float

    public init(minimumConfidence: Float = 0.25) {
        self.minimumConfidence = minimumConfidence
    }

    public func decide(
        candidates: [MetaBarcodeCandidate],
        expectedValue: String?
    ) -> MetaBarcodeDecodeDecision {
        var bestByPayload: [String: MetaBarcodeCandidate] = [:]
        for candidate in candidates
        where !candidate.payload.isEmpty && candidate.confidence >= minimumConfidence {
            if let current = bestByPayload[candidate.payload],
               current.confidence >= candidate.confidence {
                continue
            }
            bestByPayload[candidate.payload] = candidate
        }

        guard !bestByPayload.isEmpty else { return .zeroCandidates }

        if let expectedValue,
           let expected = bestByPayload.values
            .filter({ isExpected($0.payload, expectedValue: expectedValue) })
            .max(by: { $0.confidence < $1.confidence }) {
            return .selected(expected)
        }

        guard bestByPayload.count == 1,
              let onlyCandidate = bestByPayload.values.first
        else {
            return .ambiguous(candidateCount: bestByPayload.count)
        }
        return .selected(onlyCandidate)
    }

    public func isExpected(_ observedValue: String, expectedValue: String?) -> Bool {
        guard let expectedValue else { return true }
        return BarcodeMatcher.matches(
            observed: observedValue,
            expected: expectedValue
        )
    }
}

public struct MetaBarcodeEmissionReducer: Sendable {
    public private(set) var hasEmitted = false

    public init() {}

    public mutating func accept(_ decision: MetaBarcodeDecodeDecision) -> String? {
        guard !hasEmitted,
              case let .selected(candidate) = decision
        else { return nil }
        hasEmitted = true
        return candidate.payload
    }

    public mutating func reset() {
        hasEmitted = false
    }
}
