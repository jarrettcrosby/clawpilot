import XCTest
@testable import ClawPilotPickingApple

final class MetaBarcodeDecodeArbitrationTests: XCTestCase {
    private let arbitrator = MetaBarcodeDecodeArbitrator()

    func testExpectedValueWinsAmongMultipleCandidates() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1P-WRONG", confidence: 0.99),
                MetaBarcodeCandidate(payload: "CP1L-EXPECTED", confidence: 0.70),
            ],
            expectedValue: "CP1L-EXPECTED"
        )

        XCTAssertEqual(
            decision,
            .selected(MetaBarcodeCandidate(payload: "CP1L-EXPECTED", confidence: 0.70))
        )
    }

    func testExpectedUPCAWinsWhenVisionReportsLeadingZeroEAN13() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "999999999999", confidence: 0.99),
                MetaBarcodeCandidate(payload: "0850019783162", confidence: 0.80),
            ],
            expectedValue: "850019783162"
        )

        XCTAssertEqual(
            decision,
            .selected(MetaBarcodeCandidate(payload: "0850019783162", confidence: 0.80))
        )
    }

    func testExpectedEAN13WinsWhenVisionReportsUPCAWithoutLeadingZero() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "999999999999", confidence: 0.99),
                MetaBarcodeCandidate(payload: "850019783162", confidence: 0.80),
            ],
            expectedValue: "0850019783162"
        )

        XCTAssertEqual(
            decision,
            .selected(MetaBarcodeCandidate(payload: "850019783162", confidence: 0.80))
        )
    }

    func testSingleWrongPayloadUsesItsBestObservation() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1L-WRONG", confidence: 0.50),
                MetaBarcodeCandidate(payload: "CP1L-WRONG", confidence: 0.91),
            ],
            expectedValue: "CP1L-EXPECTED"
        )

        XCTAssertEqual(
            decision,
            .selected(MetaBarcodeCandidate(payload: "CP1L-WRONG", confidence: 0.91))
        )
    }

    func testMultipleWrongPayloadsRemainAmbiguous() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1L-WRONG-1", confidence: 0.95),
                MetaBarcodeCandidate(payload: "CP1L-WRONG-2", confidence: 0.90),
            ],
            expectedValue: "CP1L-EXPECTED"
        )

        XCTAssertEqual(decision, .ambiguous(candidateCount: 2))
    }

    func testCandidatesBelowConfidenceThresholdAreIgnored() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1L-EXPECTED", confidence: 0.24),
            ],
            expectedValue: "CP1L-EXPECTED"
        )

        XCTAssertEqual(decision, .zeroCandidates)
    }

    func testEmissionReducerAllowsOneValueUntilReset() {
        var reducer = MetaBarcodeEmissionReducer()
        let first = MetaBarcodeDecodeDecision.selected(
            MetaBarcodeCandidate(payload: "CP1L-FIRST", confidence: 0.90)
        )
        let second = MetaBarcodeDecodeDecision.selected(
            MetaBarcodeCandidate(payload: "CP1P-SECOND", confidence: 0.90)
        )

        XCTAssertEqual(reducer.accept(first), "CP1L-FIRST")
        XCTAssertNil(reducer.accept(second))

        reducer.reset()
        XCTAssertEqual(reducer.accept(second), "CP1P-SECOND")
    }
}
