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

    func testExpectedCandidateRetainsVisionSymbology() {
        let expected = MetaBarcodeCandidate(
            payload: "CP1L-EXPECTED",
            confidence: 0.90,
            symbology: "VNBarcodeSymbologyQR"
        )
        let decision = arbitrator.decide(
            candidates: [expected],
            expectedValue: "CP1L-EXPECTED"
        )

        XCTAssertEqual(decision, .selected(expected))
    }

    func testSuppressedLocationCannotBecomeWrongProductCandidate() {
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1L-LOCATION", confidence: 0.99),
            ],
            expectedValue: "CP1P-PRODUCT",
            suppressedValue: "CP1L-LOCATION"
        )

        XCTAssertEqual(decision, .zeroCandidates)
    }

    func testExpectedValueStillWinsIfItAlsoMatchesSuppressedValue() {
        let expected = MetaBarcodeCandidate(
            payload: "850019783162",
            confidence: 0.80
        )
        let decision = arbitrator.decide(
            candidates: [expected],
            expectedValue: "0850019783162",
            suppressedValue: "850019783162"
        )

        XCTAssertEqual(decision, .selected(expected))
    }

    func testSuppressionDoesNotHideASeparateWrongProductCandidate() {
        let wrongProduct = MetaBarcodeCandidate(
            payload: "CP1P-WRONG",
            confidence: 0.91
        )
        let decision = arbitrator.decide(
            candidates: [
                MetaBarcodeCandidate(payload: "CP1L-LOCATION", confidence: 0.99),
                wrongProduct,
            ],
            expectedValue: "CP1P-EXPECTED",
            suppressedValue: "CP1L-LOCATION"
        )

        XCTAssertEqual(decision, .selected(wrongProduct))
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

    func testPhotoOrientationPlanUsesMetadataFirstAndDeduplicatesCardinals() {
        XCTAssertEqual(
            MetaBarcodeOrientationPlan.photo(metadataRawValue: 6),
            [6, 1, 8, 3]
        )
        XCTAssertEqual(
            MetaBarcodeOrientationPlan.photo(metadataRawValue: 5),
            [5, 1, 6, 8, 3]
        )
        XCTAssertEqual(
            MetaBarcodeOrientationPlan.photo(metadataRawValue: nil),
            [1, 6, 8, 3]
        )
        XCTAssertEqual(
            MetaBarcodeOrientationPlan.photo(metadataRawValue: 99),
            [1, 6, 8, 3]
        )
    }

    func testFirstPhotoUsesOnlyPrimaryEXIFPass() {
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.photoDecodePlan(
                ordinal: 1,
                metadataRawValue: 6
            ),
            MetaBarcodePhotoDecodePlan(
                primaryOrientations: [6],
                fallbackOrientations: [],
                allowsAccurateOCR: false
            )
        )
    }

    func testLaterPhotoEnablesBoundedOrientationAndOCRFallback() {
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.photoDecodePlan(
                ordinal: 2,
                metadataRawValue: 6
            ),
            MetaBarcodePhotoDecodePlan(
                primaryOrientations: [6],
                fallbackOrientations: [1, 8, 3],
                allowsAccurateOCR: true
            )
        )
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.maximumPendingPhotos,
            1
        )
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.liveFrameCadenceNanoseconds,
            100_000_000
        )
    }

    func testLiveFrameCadenceRetainsLatestFrameUntilBoundary() {
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.liveFrameDelayNanoseconds(
                lastStartedAt: 1_000_000_000,
                now: 1_066_000_000
            ),
            34_000_000
        )
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.liveFrameDelayNanoseconds(
                lastStartedAt: 1_000_000_000,
                now: 1_100_000_000
            ),
            0
        )
        XCTAssertEqual(
            MetaBarcodeCapturePolicy.liveFrameDelayNanoseconds(
                lastStartedAt: 0,
                now: 5
            ),
            0
        )
    }

    func testOrientationSearchStopsAtFirstCandidate() {
        var evaluated: [UInt32] = []
        let search = MetaBarcodeOrientationPlan.firstResult(
            orientations: [6, 1, 8, 3]
        ) { orientation -> String? in
            evaluated.append(orientation)
            return orientation == 8 ? "candidate" : nil
        }

        XCTAssertEqual(evaluated, [6, 1, 8])
        XCTAssertEqual(search.attemptedOrientations, [6, 1, 8])
        XCTAssertEqual(search.winningOrientation, 8)
        XCTAssertEqual(search.result, "candidate")
    }

    func testOrientationSearchReportsAllAttemptsWhenNoCandidateExists() {
        let search = MetaBarcodeOrientationPlan.firstResult(
            orientations: [1, 6, 8, 3]
        ) { _ -> String? in nil }

        XCTAssertEqual(search.attemptedOrientations, [1, 6, 8, 3])
        XCTAssertNil(search.winningOrientation)
        XCTAssertNil(search.result)
    }

    func testOrientationSearchStopsOnAmbiguousBarcodeDecision() {
        let search = MetaBarcodeOrientationPlan.firstResult(
            orientations: [1, 6, 8, 3]
        ) { orientation -> MetaBarcodeDecodeDecision? in
            orientation == 6 ? .ambiguous(candidateCount: 2) : nil
        }

        XCTAssertEqual(search.attemptedOrientations, [1, 6])
        XCTAssertEqual(search.winningOrientation, 6)
        XCTAssertEqual(search.result, .ambiguous(candidateCount: 2))
    }

    func testExpectedOCRTextAllowsOnlyCaseAndWhitespaceDifferences() {
        XCTAssertTrue(
            MetaExpectedBarcodeTextMatcher.matches(
                observed: " cp1l  -  gwl9449010\n",
                expectedValue: "CP1L-GWL9449010"
            )
        )
        XCTAssertFalse(
            MetaExpectedBarcodeTextMatcher.matches(
                observed: "CP1L-GWL9449011",
                expectedValue: "CP1L-GWL9449010"
            )
        )
        XCTAssertFalse(
            MetaExpectedBarcodeTextMatcher.matches(
                observed: "CP1LGWL9449010",
                expectedValue: "CP1L-GWL9449010"
            )
        )
    }

    func testExpectedOCRTextIsDisabledWithoutExpectedValue() {
        XCTAssertFalse(
            MetaExpectedBarcodeTextMatcher.matches(
                observed: "CP1L-GWL9449010",
                expectedValue: nil
            )
        )
        XCTAssertFalse(
            MetaExpectedBarcodeTextMatcher.matches(
                observed: "",
                expectedValue: ""
            )
        )
    }

    func testDiagnosticJournalRetainsMetaWhenIPhoneSessionBegins() {
        var journal = ClawPilotScanDiagnosticJournal()
        journal.begin(
            source: .meta,
            build: "1(11)",
            stage: "location",
            timestamp: 1,
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        )
        journal.record(
            source: .meta,
            build: "1(11)",
            event: "vision-decode",
            stage: nil,
            timestamp: 2,
            timingsMilliseconds: ["decode": 18],
            symbologies: ["VNBarcodeSymbologyQR"],
            expectedMatch: true
        )

        journal.begin(
            source: .iphone,
            build: "1(11)",
            stage: "product",
            timestamp: 3,
            id: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
        )

        XCTAssertEqual(journal.sessions(for: .meta).count, 1)
        XCTAssertEqual(journal.sessions(for: .meta)[0].events.count, 1)
        XCTAssertEqual(journal.sessions(for: .iphone).count, 1)
        XCTAssertEqual(
            journal.sessions(for: .meta)[0].events[0].symbologies,
            ["VNBarcodeSymbologyQR"]
        )
    }

    func testDiagnosticJournalRetainsIPhoneWhenMetaSessionBegins() {
        var journal = ClawPilotScanDiagnosticJournal()
        journal.begin(
            source: .iphone,
            build: "1(11)",
            stage: "location",
            timestamp: 1
        )
        journal.record(
            source: .iphone,
            build: "1(11)",
            event: "live-detected",
            stage: nil,
            timestamp: 2,
            timingsMilliseconds: ["elapsed": 14],
            symbologies: ["VNBarcodeSymbologyCode128"],
            expectedMatch: false
        )
        journal.begin(
            source: .meta,
            build: "1(11)",
            stage: "product",
            timestamp: 3
        )

        XCTAssertEqual(journal.sessions(for: .iphone).count, 1)
        XCTAssertEqual(journal.sessions(for: .iphone)[0].events.count, 1)
        XCTAssertEqual(journal.sessions(for: .meta).count, 1)
    }

    func testDiagnosticJournalBoundsSessionsAndEventsPerSource() {
        var journal = ClawPilotScanDiagnosticJournal(
            maximumSessionsPerSource: 2,
            maximumEventsPerSession: 2
        )
        for index in 0..<3 {
            journal.begin(
                source: .meta,
                build: "1(11)",
                stage: "location",
                timestamp: TimeInterval(index)
            )
            for eventIndex in 0..<3 {
                journal.record(
                    source: .meta,
                    build: "1(11)",
                    event: "event-\(eventIndex)",
                    stage: nil,
                    timestamp: TimeInterval(index * 10 + eventIndex)
                )
            }
        }

        XCTAssertEqual(journal.sessions(for: .meta).count, 2)
        XCTAssertEqual(
            journal.sessions(for: .meta).map(\.events.count),
            [2, 2]
        )
        XCTAssertEqual(
            journal.sessions(for: .meta).last?.events.map(\.name),
            ["event-1", "event-2"]
        )
    }
}
