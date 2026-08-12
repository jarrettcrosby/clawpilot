import XCTest
@testable import ClawPilotPickingApple

final class PhoneCameraScanLifecycleTests: XCTestCase {
    func testIdleDismissalClosesImmediatelyAndInvalidatesFallbackWork() throws {
        var lifecycle = PhoneCameraScanLifecycle()
        let fallbackToken = try XCTUnwrap(lifecycle.operationToken())

        XCTAssertTrue(lifecycle.dismiss())
        XCTAssertEqual(lifecycle.phase, .dismissed)
        XCTAssertFalse(lifecycle.isPresented)
        XCTAssertFalse(lifecycle.permitsCompletion(of: fallbackToken))
        XCTAssertNil(lifecycle.operationToken())
        XCTAssertNil(lifecycle.beginSubmission())
    }

    func testDismissalDuringSubmissionSuppressesItsCompletion() throws {
        var lifecycle = PhoneCameraScanLifecycle()
        let submissionToken = try XCTUnwrap(lifecycle.beginSubmission())

        XCTAssertEqual(lifecycle.phase, .submitting)
        XCTAssertTrue(lifecycle.dismiss())
        XCTAssertFalse(lifecycle.completeSubmission(submissionToken))
        XCTAssertEqual(lifecycle.phase, .dismissed)
    }

    func testSubmissionCanContinueOnlyWhenCameraRemainsPresented() throws {
        var lifecycle = PhoneCameraScanLifecycle()
        let submissionToken = try XCTUnwrap(lifecycle.beginSubmission())

        XCTAssertTrue(lifecycle.completeSubmission(submissionToken))
        XCTAssertEqual(lifecycle.phase, .active)
        XCTAssertTrue(lifecycle.canBeginSubmission)
    }

    func testDismissalIsIdempotent() {
        var lifecycle = PhoneCameraScanLifecycle()

        XCTAssertTrue(lifecycle.dismiss())
        XCTAssertFalse(lifecycle.dismiss())
        XCTAssertEqual(lifecycle.phase, .dismissed)
    }
}
