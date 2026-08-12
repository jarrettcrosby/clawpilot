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

/// Builds and executes the bounded EXIF-orientation search used by the Meta
/// camera decoder. Raw values follow `CGImagePropertyOrientation`, but this
/// helper stays platform-neutral so its ordering and early-exit behavior can
/// be tested without Vision or captured image data.
public enum MetaBarcodeOrientationPlan {
    private static let cardinalOrientations: [UInt32] = [1, 6, 8, 3]

    public static func photo(metadataRawValue: UInt32?) -> [UInt32] {
        var orientations: [UInt32] = []
        if let metadataRawValue, (1...8).contains(metadataRawValue) {
            orientations.append(metadataRawValue)
        }
        for orientation in cardinalOrientations where !orientations.contains(orientation) {
            orientations.append(orientation)
        }
        return orientations
    }

    public static func firstResult<Result>(
        orientations: [UInt32],
        evaluate: (UInt32) throws -> Result?
    ) rethrows -> (
        attemptedOrientations: [UInt32],
        winningOrientation: UInt32?,
        result: Result?
    ) {
        var attemptedOrientations: [UInt32] = []
        for orientation in orientations {
            attemptedOrientations.append(orientation)
            if let result = try evaluate(orientation) {
                return (attemptedOrientations, orientation, result)
            }
        }
        return (attemptedOrientations, nil, nil)
    }
}

public enum MetaExpectedBarcodeTextMatcher {
    public static func matches(observed: String, expectedValue: String?) -> Bool {
        guard let expectedValue else { return false }
        let expected = canonical(expectedValue)
        guard !expected.isEmpty else { return false }
        return canonical(observed) == expected
    }

    private static func canonical(_ value: String) -> String {
        String(value.filter { !$0.isWhitespace }).uppercased()
    }
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
