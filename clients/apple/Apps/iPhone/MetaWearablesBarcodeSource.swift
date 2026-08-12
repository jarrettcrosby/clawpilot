import Foundation
import ImageIO
import MWDATCamera
import MWDATCore
import UIKit
import Vision
import ClawPilotPickingApple

@MainActor
enum MetaWearablesAppBridge {
    private(set) static var isConfigured = false

    static func configure() throws {
        try Wearables.configure()
        isConfigured = true
    }
    static var registrationState: RegistrationState {
        isConfigured ? Wearables.shared.registrationState : .unavailable
    }
    static var isRegistered: Bool { registrationState == .registered }
    static func startRegistration() async throws {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        try await Wearables.shared.startRegistration()
    }
    static func startUnregistration() async throws {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        try await Wearables.shared.startUnregistration()
    }
    static func openFirmwareUpdate() async throws {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        try await Wearables.shared.openFirmwareUpdate()
    }
    static func openMetaAppUpdate() async throws {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        try await Wearables.shared.openDATGlassesAppUpdate()
    }
    static func statusSnapshot() async -> MetaWearablesStatusSnapshot {
        guard isConfigured else {
            return MetaWearablesStatusSnapshot(
                registrationState: .unavailable,
                cameraPermissionGranted: nil,
                connectedDeviceCount: 0
            )
        }
        let state = registrationState
        let connectedDeviceCount = Wearables.shared.devices.reduce(into: 0) { count, identifier in
            guard let device = Wearables.shared.deviceForIdentifier(identifier) else { return }
            if device.linkState == .connected { count += 1 }
        }
        let cameraPermission: Bool?
        if state == .registered {
            let status = try? await Wearables.shared.checkPermissionStatus(.camera)
            cameraPermission = status.map { $0 == .granted }
        } else {
            cameraPermission = nil
        }
        return MetaWearablesStatusSnapshot(
            registrationState: state,
            cameraPermissionGranted: cameraPermission,
            connectedDeviceCount: connectedDeviceCount
        )
    }
    static func requestCameraPermission() async throws -> Bool {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        return try await Wearables.shared.requestPermission(.camera) == .granted
    }
    static func handleOpenURL(_ url: URL) async throws -> Bool {
        guard isConfigured else { throw MetaBridgeError.notConfigured }
        return try await Wearables.shared.handleUrl(url)
    }
}

enum MetaBridgeError: LocalizedError {
    case notConfigured

    var errorDescription: String? {
        "Meta Wearables is not configured in this build."
    }
}

struct MetaWearablesStatusSnapshot {
    let registrationState: RegistrationState
    let cameraPermissionGranted: Bool?
    let connectedDeviceCount: Int
}

enum MetaScanError: LocalizedError, Sendable, Equatable {
    case unavailable
    case registrationRequired
    case cameraPermissionRequired
    case exactlyOneDeviceRequired
    case glassesAppUpdateRequired
    case sessionFailed

    var errorDescription: String? {
        switch self {
        case .unavailable:
            "Meta Wearables is unavailable in this build."
        case .registrationRequired:
            "Register ClawPilot with Meta before starting a scan."
        case .cameraPermissionRequired:
            "Allow Meta camera access before starting a scan."
        case .exactlyOneDeviceRequired:
            "Connect exactly one compatible pair of Meta glasses."
        case .glassesAppUpdateRequired:
            "The Meta camera software on the glasses must be updated before scanning."
        case .sessionFailed:
            "The glasses camera session did not become ready. Reconnect the glasses and try again."
        }
    }
}

struct MetaBarcodeDecodeTarget: @unchecked Sendable {
    let expectedValue: String?
    let suppressedValue: String?
    fileprivate let stage: String
    fileprivate let symbologies: [VNBarcodeSymbology]

    init(
        expectedValue: String?,
        suppressedValue: String? = nil,
        stage: String = "unknown",
        symbologies: [VNBarcodeSymbology]
    ) {
        self.expectedValue = expectedValue
        self.suppressedValue = suppressedValue
        self.stage = stage
        self.symbologies = symbologies
    }

    static func location(expectedValue: String?) -> Self {
        Self(
            expectedValue: expectedValue,
            stage: "location",
            symbologies: [.code128, .qr]
        )
    }

    static func product(expectedValue: String?) -> Self {
        Self(
            expectedValue: expectedValue,
            stage: "product",
            symbologies: [
                .ean8, .ean13, .upce,
                .code128, .code39, .code93,
                .i2of5, .itf14,
                .gs1DataBar, .gs1DataBarExpanded, .gs1DataBarLimited,
                .dataMatrix, .qr, .pdf417, .aztec,
            ]
        )
    }
}

actor MetaWearablesBarcodeSource {
    nonisolated let barcodes: AsyncStream<String>
    private nonisolated let continuation: AsyncStream<String>.Continuation
    private nonisolated let processor: MetaVisionFrameProcessor
    private let initialDiagnosticStage: String
    private let sessionTokens = ListenerTokenBag()
    private let streamTokens = ListenerTokenBag()
    private var deviceSession: DeviceSession?
    private var camera: MWDATCamera.Camera?
    private var active = false
    private var startContinuation: CheckedContinuation<Void, any Error>?
    private var photoCaptureSequence = 0
    private var photoCaptureAttempt = 0
    private var photoCaptureInFlight = false
    private var photoCaptureSequenceStartedAtNanoseconds: UInt64 = 0
    private var photoCaptureTask: Task<Void, Never>?
    private var teardownTask: Task<Void, Never>?
    private var stopRequested = false
    private var diagnosticSessionActive = false

    init(target: MetaBarcodeDecodeTarget) {
        var continuation: AsyncStream<String>.Continuation!
        barcodes = AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation = $0 }
        self.continuation = continuation
        initialDiagnosticStage = target.stage
        processor = MetaVisionFrameProcessor(
            continuation: continuation,
            target: target
        )
    }

    func start() async throws {
        guard !active else { return }
        guard !stopRequested, teardownTask == nil else {
            throw MetaScanError.sessionFailed
        }
        diagnosticSessionActive = true
        ClawPilotScanDiagnostic.begin(
            source: .meta,
            stage: initialDiagnosticStage
        )
        guard Wearables.shared.registrationState == .registered else {
            throw MetaScanError.registrationRequired
        }
        guard try await Wearables.shared.checkPermissionStatus(.camera) == .granted else {
            throw MetaScanError.cameraPermissionRequired
        }
        // Camera permission is an actor suspension point. A user stop issued
        // while it is in flight must prevent this one-shot source from later
        // creating a session whose AsyncStream has already been finished.
        guard !stopRequested else { throw MetaScanError.sessionFailed }
        let registeredDevices = Wearables.shared.devices
        ClawPilotScanDiagnostic.record("device-count:\(registeredDevices.count)")
        let devices = registeredDevices.filter { identifier in
            guard let device = Wearables.shared.deviceForIdentifier(identifier) else { return false }
            let compatibility = device.compatibility()
            let linkState = device.linkState
            ClawPilotScanDiagnostic.record(
                "device-candidate:link=\(String(describing: linkState)):compatibility=\(String(describing: compatibility))"
            )
#if DEBUG
            let compatible = compatibility == .compatible || compatibility == .undefined
#else
            let compatible = compatibility == .compatible
#endif
            return linkState == .connected && compatible
        }
        guard devices.count == 1, let identifier = devices.first else {
            throw MetaScanError.exactlyOneDeviceRequired
        }
        let selector = SpecificDeviceSelector(device: identifier)
        let session = try Wearables.shared.createSession(deviceSelector: selector)
        active = true
        deviceSession = session
        processor.reset()
        session.statePublisher.listen { [weak self] state in
            ClawPilotScanDiagnostic.record("session-state:\(String(describing: state))")
            Task { await self?.handleSessionState(state) }
        }.store(in: sessionTokens)
        session.errorPublisher.listen { [weak self] error in
            ClawPilotScanDiagnostic.record("session-error:\(String(describing: error))")
            Task { await self?.handleSessionError(error) }
        }.store(in: sessionTokens)
        try await withCheckedThrowingContinuation { continuation in
            startContinuation = continuation
            do {
                try session.start()
            } catch {
                _ = failStart()
            }
        }
    }

    func stop() async {
        if let task = failStart() {
            await task.value
        }
    }

    func prepareForNextBarcode(
        target: MetaBarcodeDecodeTarget,
        suppressedValue: String? = nil
    ) {
        guard active else { return }
        processor.reset(
            target: MetaBarcodeDecodeTarget(
                expectedValue: target.expectedValue,
                suppressedValue: suppressedValue ?? target.suppressedValue,
                stage: target.stage,
                symbologies: target.symbologies
            )
        )
        ClawPilotScanDiagnostic.transition(source: .meta, stage: target.stage)
        beginPhotoCaptureSequence()
    }

    private func handleSessionState(_ state: DeviceSessionState) {
        guard active else { return }
        switch state {
        case .started: attachCamera()
        case .stopped: _ = failStart()
        case .idle, .starting, .paused, .stopping: break
        }
    }

    private func handleSessionError(_ error: DeviceSessionError) {
        if error == .datAppOnTheGlassesUpdateRequired {
            _ = failStart(MetaScanError.glassesAppUpdateRequired)
        } else {
            _ = failStart(MetaScanError.sessionFailed)
        }
    }

    private func attachCamera() {
        guard active, camera == nil, let deviceSession else { return }
        do {
            let configuration = StreamConfiguration(
                videoCodec: .raw,
                // Retain the highest angular resolution and the lower supported
                // frame rate for distant 1D product codes and low-light quality.
                // The processor independently coalesces the latest frame onto a
                // 100 ms cadence, so decode throughput is not tied to 15 fps.
                resolution: .high,
                frameRate: 15
            )
            ClawPilotScanDiagnostic.record(
                "stream-config:resolution=high:fps=15:cadence_ms=100"
            )
            guard let camera = try deviceSession.addCamera(config: configuration) else {
                _ = failStart()
                return
            }
            self.camera = camera
            let processor = processor
            camera.stream.photoDataPublisher.listen { [weak self] photo in
                processor.consume(photo)
                Task { await self?.handlePhotoDelivered() }
            }.store(in: streamTokens)
            camera.stream.videoFramePublisher.listen { frame in
                processor.consume(frame)
            }.store(in: streamTokens)
            camera.stream.statePublisher.listen { [weak self] state in
                ClawPilotScanDiagnostic.record("stream-state:\(String(describing: state))")
                Task { await self?.handleStreamState(state) }
            }.store(in: streamTokens)
            camera.stream.errorPublisher.listen { [weak self] error in
                ClawPilotScanDiagnostic.record("stream-error:\(String(describing: error))")
                Task { await self?.handleStreamError(error) }
            }.store(in: streamTokens)
            camera.stream.start()
        } catch {
            _ = failStart()
        }
    }

    private func handleStreamState(_ state: StreamState) {
        guard active, camera != nil else { return }
        switch state {
        case .streaming:
            beginPhotoCaptureSequence()
            startContinuation?.resume()
            startContinuation = nil
        case .stopped:
            _ = failStart()
        case .stopping, .waitingForDevice, .starting, .paused:
            break
        }
    }

    private func handleStreamError(_ error: StreamError) {
        if error == .photoCaptureFailed {
            photoCaptureInFlight = false
            ClawPilotScanDiagnostic.record("photo-capture-result:outcome=error")
            scheduleNextPhotoCapture(
                sequence: photoCaptureSequence,
                delayMilliseconds: 750,
                trigger: "capture-error"
            )
        } else {
            _ = failStart()
        }
    }

    private func beginPhotoCaptureSequence() {
        guard active else { return }
        photoCaptureTask?.cancel()
        photoCaptureSequence += 1
        photoCaptureAttempt = 0
        photoCaptureInFlight = false

        photoCaptureSequenceStartedAtNanoseconds = DispatchTime.now().uptimeNanoseconds
        let sequence = photoCaptureSequence
        requestNextPhotoCapture(sequence: sequence, trigger: "initial")
    }

    private func handlePhotoDelivered() {
        guard active, photoCaptureAttempt > 0, photoCaptureInFlight else { return }
        photoCaptureInFlight = false
        let elapsedMilliseconds = photoCaptureElapsedMilliseconds()
        ClawPilotScanDiagnostic.record(
            "photo-capture-result:attempt=\(photoCaptureAttempt):outcome=delivered:elapsed_ms=\(elapsedMilliseconds)"
        )
        scheduleNextPhotoCapture(
            sequence: photoCaptureSequence,
            delayMilliseconds: 650,
            trigger: "photo-delivered"
        )
    }

    private func scheduleNextPhotoCapture(
        sequence: Int,
        delayMilliseconds: Int,
        trigger: String
    ) {
        guard active,
              sequence == photoCaptureSequence,
              photoCaptureAttempt < 3
        else { return }
        photoCaptureTask?.cancel()
        let scheduledAttempt = photoCaptureAttempt
        photoCaptureTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMilliseconds))
            guard !Task.isCancelled else { return }
            if trigger == "delivery-timeout" {
                await self?.handlePhotoCaptureTimeout(
                    sequence: sequence,
                    attempt: scheduledAttempt
                )
            } else {
                await self?.requestNextPhotoCapture(
                    sequence: sequence,
                    trigger: trigger
                )
            }
        }
    }

    private func handlePhotoCaptureTimeout(sequence: Int, attempt: Int) {
        guard active,
              sequence == photoCaptureSequence,
              attempt == photoCaptureAttempt,
              photoCaptureInFlight
        else { return }
        photoCaptureInFlight = false
        ClawPilotScanDiagnostic.record(
            "photo-capture-result:attempt=\(attempt):outcome=delivery-timeout:elapsed_ms=\(photoCaptureElapsedMilliseconds())"
        )
        requestNextPhotoCapture(
            sequence: sequence,
            trigger: "delivery-timeout"
        )
    }

    private func requestNextPhotoCapture(
        sequence: Int,
        trigger: String
    ) {
        guard active,
              sequence == photoCaptureSequence,
              photoCaptureAttempt < 3,
              !photoCaptureInFlight,
              let camera
        else { return }
        photoCaptureAttempt += 1
        let attempt = photoCaptureAttempt
        let accepted = camera.stream.capturePhoto(format: .jpeg)
        photoCaptureInFlight = accepted
        let outcome = accepted ? "accepted" : "rejected"
        ClawPilotScanDiagnostic.record(
            "photo-capture-request:attempt=\(attempt):trigger=\(trigger):outcome=\(outcome):elapsed_ms=\(photoCaptureElapsedMilliseconds())"
        )
        scheduleNextPhotoCapture(
            sequence: sequence,
            delayMilliseconds: accepted ? 4_000 : 750,
            trigger: accepted ? "delivery-timeout" : "request-rejected"
        )
    }

    private func photoCaptureElapsedMilliseconds() -> UInt64 {
        let now = DispatchTime.now().uptimeNanoseconds
        guard now >= photoCaptureSequenceStartedAtNanoseconds else { return 0 }
        return (now - photoCaptureSequenceStartedAtNanoseconds) / 1_000_000
    }

    @discardableResult
    private func failStart(
        _ error: any Error = MetaScanError.sessionFailed
    ) -> Task<Void, Never>? {
        stopRequested = true
        processor.cancel()
        continuation.finish()
        if let startContinuation {
            self.startContinuation = nil
            startContinuation.resume(throwing: error)
        }
        active = false
        photoCaptureTask?.cancel()
        photoCaptureTask = nil
        photoCaptureInFlight = false

        if diagnosticSessionActive {
            diagnosticSessionActive = false
            ClawPilotScanDiagnostic.end(source: .meta)
        }

        if let teardownTask { return teardownTask }

        streamTokens.clear()
        sessionTokens.clear()
        camera?.stop()

        guard let session = deviceSession else {
            camera = nil
            return nil
        }

        // Capture the terminal stream before requesting stop. DAT documents
        // that it delivers `.stopped` and then finishes, while a stream created
        // after an already-stopped session finishes immediately.
        let states = session.stateStream()
        session.stop()
        let task = Task { [weak self] in
            let reachedStopped = await Self.waitForStopped(
                session: session,
                states: states,
                timeout: .seconds(4)
            )
            await self?.completeTeardown(
                session: session,
                reachedStopped: reachedStopped
            )
        }
        teardownTask = task
        return task
    }

    private func completeTeardown(
        session: DeviceSession,
        reachedStopped: Bool
    ) {
        guard deviceSession === session else { return }
        if reachedStopped {
            ClawPilotScanDiagnostic.record("session-teardown:outcome=stopped")
        } else {
            ClawPilotScanDiagnostic.record(
                "session-teardown:outcome=timeout:state=\(String(describing: session.state))"
            )
        }
        camera = nil
        deviceSession = nil
        teardownTask = nil
    }

    private nonisolated static func waitForStopped(
        session: DeviceSession,
        states: AsyncStream<DeviceSessionState>,
        timeout: Duration
    ) async -> Bool {
        if session.state == .stopped { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await state in states {
                    if state == .stopped { return true }
                }
                return session.state == .stopped
            }
            group.addTask {
                do {
                    try await Task.sleep(for: timeout)
                    return false
                } catch {
                    return false
                }
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }
}

private final class MetaVisionFrameProcessor: @unchecked Sendable {
    private enum InputKind: String, Sendable {
        case photo
        case video
    }

    private enum InputContent: @unchecked Sendable {
        case photo(data: Data, orientations: [UInt32])
        case video(VideoFrame)
    }

    private struct OrientationDecodeResult {
        let decision: MetaBarcodeDecodeDecision
        let attemptedOrientations: [UInt32]
        let winningOrientation: UInt32?
        let diagnosticDetails: [String]
    }

    private enum ProcessingAbort: Error {
        case staleGeneration
    }

    private struct WorkItem: @unchecked Sendable {
        let kind: InputKind
        let content: InputContent
        let dimensions: String
        let photoOrdinal: Int?
        let queuedAtNanoseconds: UInt64
        let generation: UInt64
        let target: MetaBarcodeDecodeTarget
    }

    private static let maximumPendingPhotos =
        MetaBarcodeCapturePolicy.maximumPendingPhotos
    private static let wrongVideoDeferralNanoseconds: UInt64 = 1_200_000_000

    private let lock = NSLock()
    private let continuation: AsyncStream<String>.Continuation
    private let videoProcessingQueue = DispatchQueue(
        label: "com.clawpilot.meta-barcode-vision.video",
        qos: .userInteractive
    )
    private let photoProcessingQueue = DispatchQueue(
        label: "com.clawpilot.meta-barcode-vision.photo",
        qos: .userInitiated
    )
    private let arbitrator = MetaBarcodeDecodeArbitrator()
    private var reducer = MetaBarcodeEmissionReducer()
    private var target: MetaBarcodeDecodeTarget
    private var generation: UInt64 = 0
    private var terminal = false
    private var videoWorkerRunning = false
    private var photoWorkerRunning = false
    private var pendingPhotos: [WorkItem] = []
    private var pendingVideo: WorkItem?
    private var lastAcceptedVideoNanoseconds: UInt64 = 0
    private var receivedPhotoCount = 0
    private var wrongVideoDeferralUntilNanoseconds: UInt64 = 0
    private var droppedCounts: [String: Int] = [:]
    private var sampledResultCounts: [String: Int] = [:]

    init(
        continuation: AsyncStream<String>.Continuation,
        target: MetaBarcodeDecodeTarget
    ) {
        self.continuation = continuation
        self.target = target
        wrongVideoDeferralUntilNanoseconds =
            Self.nowNanoseconds() + Self.wrongVideoDeferralNanoseconds
    }

    func reset() {
        reset(target: nil)
    }

    func reset(target newTarget: MetaBarcodeDecodeTarget) {
        reset(target: Optional(newTarget))
    }

    private func reset(target newTarget: MetaBarcodeDecodeTarget?) {
        var diagnostics: [String] = []
        let now = Self.nowNanoseconds()
        lock.lock()
        terminal = false
        if let newTarget { target = newTarget }
        for item in pendingPhotos {
            if let diagnostic = droppedDiagnosticLocked(item, reason: "reset", now: now) {
                diagnostics.append(diagnostic)
            }
        }
        if let pendingVideo {
            if let diagnostic = droppedDiagnosticLocked(
                pendingVideo,
                reason: "reset",
                now: now
            ) {
                diagnostics.append(diagnostic)
            }
        }
        generation &+= 1
        reducer.reset()
        pendingPhotos.removeAll(keepingCapacity: true)
        pendingVideo = nil
        lastAcceptedVideoNanoseconds = 0
        receivedPhotoCount = 0
        wrongVideoDeferralUntilNanoseconds = now + Self.wrongVideoDeferralNanoseconds
        droppedCounts.removeAll(keepingCapacity: true)
        sampledResultCounts.removeAll(keepingCapacity: true)
        lock.unlock()
        diagnostics.forEach(ClawPilotScanDiagnostic.record)
    }

    func cancel() {
        lock.lock()
        guard !terminal else {
            lock.unlock()
            return
        }
        terminal = true
        generation &+= 1
        reducer.reset()
        pendingPhotos.removeAll(keepingCapacity: false)
        pendingVideo = nil
        lastAcceptedVideoNanoseconds = 0
        receivedPhotoCount = 0
        wrongVideoDeferralUntilNanoseconds = 0
        lock.unlock()
    }

    func consume(_ frame: VideoFrame) {
        let now = Self.nowNanoseconds()
        var dimensions = "unknown"
        if let buffer = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
            dimensions = "\(CVPixelBufferGetWidth(buffer))x\(CVPixelBufferGetHeight(buffer))"
        }
        enqueueVideo(frame, dimensions: dimensions, now: now)
    }

    func consume(_ photo: PhotoData) {
        let properties = imageProperties(in: photo.data)
        enqueuePhoto(
            photo.data,
            dimensions: properties.dimensions,
            orientations: MetaBarcodeOrientationPlan.photo(
                metadataRawValue: properties.orientationRawValue
            ),
            now: Self.nowNanoseconds()
        )
    }

    private func enqueueVideo(
        _ frame: VideoFrame,
        dimensions: String,
        now: UInt64
    ) {
        var shouldStartWorker = false
        var diagnostics: [String] = []
        lock.lock()
        let item = WorkItem(
            kind: .video,
            content: .video(frame),
            dimensions: dimensions,
            photoOrdinal: nil,
            queuedAtNanoseconds: now,
            generation: generation,
            target: target
        )
        if terminal {
            // Publisher teardown can race one final callback. Do not retain or
            // diagnose input after the scan has been cancelled.
        } else if reducer.hasEmitted {
            if let diagnostic = droppedDiagnosticLocked(
                item,
                reason: "already-emitted",
                now: now
            ) {
                diagnostics.append(diagnostic)
            }
        } else {
            if let replaced = pendingVideo {
                if let diagnostic = droppedDiagnosticLocked(
                    replaced,
                    reason: "coalesced",
                    now: now
                ) {
                    diagnostics.append(diagnostic)
                }
            }
            pendingVideo = item
            if !videoWorkerRunning {
                videoWorkerRunning = true
                shouldStartWorker = true
            }
        }
        lock.unlock()
        diagnostics.forEach(ClawPilotScanDiagnostic.record)
        if shouldStartWorker { startVideoWorker() }
    }

    private func enqueuePhoto(
        _ data: Data,
        dimensions: String,
        orientations: [UInt32],
        now: UInt64
    ) {
        var shouldStartWorker = false
        var diagnostic: String?
        lock.lock()
        receivedPhotoCount += 1
        let item = WorkItem(
            kind: .photo,
            content: .photo(data: data, orientations: orientations),
            dimensions: dimensions,
            photoOrdinal: receivedPhotoCount,
            queuedAtNanoseconds: now,
            generation: generation,
            target: target
        )
        if terminal {
            // See the video callback race above.
        } else if reducer.hasEmitted {
            diagnostic = droppedDiagnosticLocked(
                item,
                reason: "already-emitted",
                now: now
            )
        } else if pendingPhotos.count >= Self.maximumPendingPhotos {
            diagnostic = droppedDiagnosticLocked(
                item,
                reason: "photo-queue-full",
                now: now
            )
        } else {
            pendingPhotos.append(item)
            if !photoWorkerRunning {
                photoWorkerRunning = true
                shouldStartWorker = true
            }
        }
        lock.unlock()
        if let diagnostic { ClawPilotScanDiagnostic.record(diagnostic) }
        if shouldStartWorker { startPhotoWorker() }
    }

    private func startVideoWorker() {
        videoProcessingQueue.async { [weak self] in
            self?.drainPendingVideo()
        }
    }

    private func startPhotoWorker() {
        photoProcessingQueue.async { [weak self] in
            self?.drainPendingPhotos()
        }
    }

    private func drainPendingVideo() {
        while let item = takeNextVideo() {
            process(item)
        }
    }

    private func drainPendingPhotos() {
        while let item = takeNextPhoto() {
            process(item)
        }
    }

    private func takeNextVideo() -> WorkItem? {
        lock.lock()
        if terminal || reducer.hasEmitted {
            pendingVideo = nil
            videoWorkerRunning = false
            lock.unlock()
            return nil
        }
        if let item = pendingVideo {
            let now = Self.nowNanoseconds()
            let delay = MetaBarcodeCapturePolicy.liveFrameDelayNanoseconds(
                lastStartedAt: lastAcceptedVideoNanoseconds,
                now: now
            )
            if delay > 0 {
                lock.unlock()
                videoProcessingQueue.asyncAfter(
                    deadline: .now() + .nanoseconds(Int(delay))
                ) { [weak self] in
                    self?.drainPendingVideo()
                }
                return nil
            }
            pendingVideo = nil
            lastAcceptedVideoNanoseconds = now
            lock.unlock()
            return item
        }
        videoWorkerRunning = false
        lock.unlock()
        return nil
    }

    private func takeNextPhoto() -> WorkItem? {
        lock.lock()
        if terminal || reducer.hasEmitted {
            pendingPhotos.removeAll(keepingCapacity: true)
            photoWorkerRunning = false
            lock.unlock()
            return nil
        }
        if !pendingPhotos.isEmpty {
            let item = pendingPhotos.removeFirst()
            lock.unlock()
            return item
        }
        photoWorkerRunning = false
        lock.unlock()
        return nil
    }

    private func process(_ item: WorkItem) {
        guard isCurrent(item) else { return }
        let startedAt = Self.nowNanoseconds()
        do {
            let result: OrientationDecodeResult
            switch item.content {
            case let .photo(data, orientations):
                result = try decodePhoto(
                    data,
                    orientations: orientations,
                    item: item
                )
            case let .video(frame):
                result = try decodeVideo(frame, item: item)
            }
            guard isCurrent(item) else { return }
            finish(
                item,
                decision: result.decision,
                startedAt: startedAt,
                diagnosticDetails: result.diagnosticDetails
            )
        } catch ProcessingAbort.staleGeneration {
            return
        } catch {
            guard isCurrent(item) else { return }
            recordResult(
                item,
                outcome: "error",
                startedAt: startedAt,
                details: "error_type=\(String(describing: type(of: error)))"
            )
            return
        }
    }

    private func decodePhoto(
        _ data: Data,
        orientations: [UInt32],
        item: WorkItem
    ) throws -> OrientationDecodeResult {
        let plan = MetaBarcodeCapturePolicy.photoDecodePlan(
            ordinal: item.photoOrdinal ?? 1,
            metadataRawValue: orientations.first
        )
        let primarySearch = try MetaBarcodeOrientationPlan.firstResult(
            orientations: plan.primaryOrientations
        ) { rawOrientation -> MetaBarcodeDecodeDecision? in
            guard isCurrent(item) else { throw ProcessingAbort.staleGeneration }
            guard let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) else {
                return nil
            }
            let decision = try decodeBarcodes(
                handler: VNImageRequestHandler(data: data, orientation: orientation),
                target: item.target
            )
            return Self.hasBarcodeCandidates(decision) ? decision : nil
        }
        var diagnosticDetails = Self.orientationDiagnosticDetails(
            prefix: "",
            attempted: primarySearch.attemptedOrientations,
            winner: primarySearch.winningOrientation
        )
        diagnosticDetails.append("photo_ordinal=\(item.photoOrdinal ?? 1)")
        if let decision = primarySearch.result {
            diagnosticDetails.append(
                contentsOf: decisionDiagnosticDetails(decision, target: item.target)
            )
            diagnosticDetails.append("ocr_outcome=not-needed")
            return OrientationDecodeResult(
                decision: decision,
                attemptedOrientations: primarySearch.attemptedOrientations,
                winningOrientation: primarySearch.winningOrientation,
                diagnosticDetails: diagnosticDetails
            )
        }

        let fallbackSearch = try MetaBarcodeOrientationPlan.firstResult(
            orientations: plan.fallbackOrientations
        ) { rawOrientation -> MetaBarcodeDecodeDecision? in
            guard isCurrent(item) else { throw ProcessingAbort.staleGeneration }
            guard let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) else {
                return nil
            }
            let decision = try decodeBarcodes(
                handler: VNImageRequestHandler(data: data, orientation: orientation),
                target: item.target
            )
            return Self.hasBarcodeCandidates(decision) ? decision : nil
        }
        diagnosticDetails.append(contentsOf: Self.orientationDiagnosticDetails(
            prefix: "fallback_",
            attempted: fallbackSearch.attemptedOrientations,
            winner: fallbackSearch.winningOrientation
        ))
        if let decision = fallbackSearch.result {
            diagnosticDetails.append(
                contentsOf: decisionDiagnosticDetails(decision, target: item.target)
            )
            diagnosticDetails.append("ocr_outcome=not-needed")
            return OrientationDecodeResult(
                decision: decision,
                attemptedOrientations:
                    primarySearch.attemptedOrientations + fallbackSearch.attemptedOrientations,
                winningOrientation: fallbackSearch.winningOrientation,
                diagnosticDetails: diagnosticDetails
            )
        }

        guard plan.allowsAccurateOCR,
              let expectedValue = item.target.expectedValue,
              !expectedValue.isEmpty
        else {
            diagnosticDetails.append(contentsOf: [
                "expected_match=false",
                "symbology=none",
                "ocr_outcome=disabled",
                "ocr_candidates=0",
                "ocr_ms=0",
            ])
            return OrientationDecodeResult(
                decision: .zeroCandidates,
                attemptedOrientations:
                    primarySearch.attemptedOrientations + fallbackSearch.attemptedOrientations,
                winningOrientation: nil,
                diagnosticDetails: diagnosticDetails
            )
        }

        let ocrStartedAt = Self.nowNanoseconds()
        var recognizedCandidateCount = 0
        let ocrSearch = try MetaBarcodeOrientationPlan.firstResult(
            orientations: plan.primaryOrientations + plan.fallbackOrientations
        ) { rawOrientation -> Float? in
            guard isCurrent(item) else { throw ProcessingAbort.staleGeneration }
            guard let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) else {
                return nil
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(
                data: data,
                orientation: orientation
            ).perform([request])
            let candidates = (request.results ?? []).flatMap { observation in
                observation.topCandidates(3)
            }
            recognizedCandidateCount += candidates.count
            return candidates.first(where: {
                MetaExpectedBarcodeTextMatcher.matches(
                    observed: $0.string,
                    expectedValue: expectedValue
                )
            })?.confidence
        }
        diagnosticDetails.append(contentsOf: Self.orientationDiagnosticDetails(
            prefix: "ocr_",
            attempted: ocrSearch.attemptedOrientations,
            winner: ocrSearch.winningOrientation
        ))
        diagnosticDetails.append(
            "ocr_outcome=\(ocrSearch.result == nil ? "no-exact-match" : "matched")"
        )
        diagnosticDetails.append("ocr_candidates=\(recognizedCandidateCount)")
        diagnosticDetails.append(
            "ocr_ms=\(Self.milliseconds(from: ocrStartedAt, to: Self.nowNanoseconds()))"
        )
        let decision = ocrSearch.result.map { confidence in
            MetaBarcodeDecodeDecision.selected(
                MetaBarcodeCandidate(
                    payload: expectedValue,
                    confidence: confidence,
                    symbology: "ocr"
                )
            )
        } ?? .zeroCandidates
        diagnosticDetails.append(
            contentsOf: decisionDiagnosticDetails(decision, target: item.target)
        )
        return OrientationDecodeResult(
            decision: decision,
            attemptedOrientations:
                primarySearch.attemptedOrientations + fallbackSearch.attemptedOrientations,
            winningOrientation: nil,
            diagnosticDetails: diagnosticDetails
        )
    }

    private func decodeVideo(
        _ frame: VideoFrame,
        item: WorkItem
    ) throws -> OrientationDecodeResult {
        guard isCurrent(item) else { throw ProcessingAbort.staleGeneration }
        let handler: VNImageRequestHandler
        let orientation: CGImagePropertyOrientation
        if let image = frame.makeUIImage(),
           let cgImage = image.cgImage {
            orientation = Self.cgImagePropertyOrientation(image.imageOrientation)
            handler = VNImageRequestHandler(
                cgImage: cgImage,
                orientation: orientation
            )
        } else {
            orientation = .up
            handler = VNImageRequestHandler(
                cmSampleBuffer: frame.sampleBuffer,
                orientation: orientation
            )
        }
        let decision = try decodeBarcodes(handler: handler, target: item.target)
        let winningOrientation = Self.hasBarcodeCandidates(decision)
            ? orientation.rawValue
            : nil
        return OrientationDecodeResult(
            decision: decision,
            attemptedOrientations: [orientation.rawValue],
            winningOrientation: winningOrientation,
            diagnosticDetails: Self.orientationDiagnosticDetails(
                prefix: "",
                attempted: [orientation.rawValue],
                winner: winningOrientation
            ) + decisionDiagnosticDetails(decision, target: item.target)
        )
    }

    private func decodeBarcodes(
        handler: VNImageRequestHandler,
        target: MetaBarcodeDecodeTarget
    ) throws -> MetaBarcodeDecodeDecision {
        let request = VNDetectBarcodesRequest()
        request.symbologies = target.symbologies
        try handler.perform([request])
        let candidates = (request.results ?? []).compactMap { observation -> MetaBarcodeCandidate? in
            guard let payload = observation.payloadStringValue,
                  !payload.isEmpty
            else { return nil }
            return MetaBarcodeCandidate(
                payload: payload,
                confidence: observation.confidence,
                symbology: observation.symbology.rawValue
            )
        }
        let decision = arbitrator.decide(
            candidates: candidates,
            expectedValue: target.expectedValue,
            suppressedValue: target.suppressedValue
        )
        return decision
    }

    private func decisionDiagnosticDetails(
        _ decision: MetaBarcodeDecodeDecision,
        target: MetaBarcodeDecodeTarget
    ) -> [String] {
        switch decision {
        case .zeroCandidates:
            return ["expected_match=false", "symbology=none"]
        case let .ambiguous(candidateCount):
            return [
                "expected_match=false",
                "symbology=ambiguous",
                "candidate_count=\(candidateCount)",
            ]
        case let .selected(candidate):
            return [
                "expected_match=\(arbitrator.isExpected(candidate.payload, expectedValue: target.expectedValue))",
                "symbology=\(candidate.symbology ?? "unknown")",
            ]
        }
    }

    private static func hasBarcodeCandidates(_ decision: MetaBarcodeDecodeDecision) -> Bool {
        switch decision {
        case .zeroCandidates: false
        case .selected, .ambiguous: true
        }
    }

    private static func orientationDiagnosticDetails(
        prefix: String,
        attempted: [UInt32],
        winner: UInt32?
    ) -> [String] {
        let attempts = attempted.isEmpty
            ? "none"
            : attempted.map(String.init).joined(separator: ",")
        return [
            "\(prefix)orientation_attempts=\(attempts)",
            "\(prefix)orientation_winner=\(winner.map(String.init) ?? "none")",
        ]
    }

    private static func cgImagePropertyOrientation(
        _ orientation: UIImage.Orientation
    ) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: .up
        case .upMirrored: .upMirrored
        case .down: .down
        case .downMirrored: .downMirrored
        case .left: .left
        case .leftMirrored: .leftMirrored
        case .right: .right
        case .rightMirrored: .rightMirrored
        @unknown default: .up
        }
    }

    private func finish(
        _ item: WorkItem,
        decision: MetaBarcodeDecodeDecision,
        startedAt: UInt64,
        diagnosticDetails: [String]
    ) {
        let now = Self.nowNanoseconds()
        var emittedValue: String?
        var outcome: String
        var detailParts = diagnosticDetails
        lock.lock()
        if terminal {
            lock.unlock()
            return
        } else if item.generation != generation {
            outcome = "dropped"
            detailParts.append("reason=stale-generation")
        } else {
            switch decision {
            case .zeroCandidates:
                outcome = "zero"
            case let .ambiguous(candidateCount):
                outcome = "processed"
                detailParts.append("selection=ambiguous:candidates=\(candidateCount)")
            case let .selected(candidate):
                let isExpected = arbitrator.isExpected(
                    candidate.payload,
                    expectedValue: item.target.expectedValue
                )
                if item.kind == .video,
                   !isExpected,
                   (photoWorkerRunning || now < wrongVideoDeferralUntilNanoseconds) {
                    // A live frame must never pre-empt an accepted high-resolution
                    // photo with a wrong candidate. Exact expected matches remain
                    // immediate so photo priority does not add scan latency.
                    outcome = "processed"
                    detailParts.append("selection=deferred-nonexpected-for-photo")
                } else {
                    emittedValue = reducer.accept(decision)
                    if emittedValue == nil {
                        outcome = "dropped"
                        detailParts.append("reason=already-emitted")
                    } else {
                        outcome = "processed"
                        detailParts.append("selection=emitted:confidence=\(candidate.confidence)")
                        pendingPhotos.removeAll(keepingCapacity: true)
                        pendingVideo = nil
                    }
                }
            }
        }
        lock.unlock()
        recordResult(
            item,
            outcome: outcome,
            startedAt: startedAt,
            details: detailParts.joined(separator: ":")
        )
        if let emittedValue { continuation.yield(emittedValue) }
    }

    private func recordResult(
        _ item: WorkItem,
        outcome: String,
        startedAt: UInt64,
        details: String
    ) {
        guard shouldRecordResult(item, outcome: outcome, details: details) else {
            return
        }
        let finishedAt = Self.nowNanoseconds()
        let queueMilliseconds = Self.milliseconds(
            from: item.queuedAtNanoseconds,
            to: startedAt
        )
        let decodeMilliseconds = Self.milliseconds(
            from: startedAt,
            to: finishedAt
        )
        let suffix = details.isEmpty ? "" : ":\(details)"
        ClawPilotScanDiagnostic.record(
            "vision-decode:kind=\(item.kind.rawValue):outcome=\(outcome):dimensions=\(item.dimensions):queue_ms=\(queueMilliseconds):decode_ms=\(decodeMilliseconds)\(suffix)"
        )
    }

    private func shouldRecordResult(
        _ item: WorkItem,
        outcome: String,
        details: String
    ) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !terminal, item.generation == generation else { return false }
        guard item.kind == .video,
              outcome == "zero" || details.contains("deferred-nonexpected-for-photo")
        else { return true }
        let key = outcome == "zero" ? "video-zero" : "video-deferred"
        let count = (sampledResultCounts[key] ?? 0) + 1
        sampledResultCounts[key] = count
        // Keep repetitive live-frame evidence useful without displacing every
        // high-resolution photo result from the bounded diagnostic history.
        return count == 1 || count.isMultiple(of: 16)
    }

    private func droppedDiagnosticLocked(
        _ item: WorkItem,
        reason: String,
        now: UInt64
    ) -> String? {
        let key = "\(item.kind.rawValue):\(reason)"
        let count = (droppedCounts[key] ?? 0) + 1
        droppedCounts[key] = count
        // A 15-fps stream would otherwise perform roughly eleven UserDefaults
        // writes per second and evict useful photo/result evidence. Preserve the
        // first example and a periodic aggregate for each drop reason.
        guard count == 1 || count.isMultiple(of: 25) else { return nil }
        return "vision-decode:kind=\(item.kind.rawValue):outcome=dropped:reason=\(reason):dimensions=\(item.dimensions):elapsed_ms=\(Self.milliseconds(from: item.queuedAtNanoseconds, to: now)):count=\(count)"
    }

    private func isCurrent(_ item: WorkItem) -> Bool {
        lock.lock()
        let current = !terminal && item.generation == generation && !reducer.hasEmitted
        lock.unlock()
        return current
    }

    private func imageProperties(
        in data: Data
    ) -> (dimensions: String, orientationRawValue: UInt32?) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any]
        else { return ("unknown", nil) }
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
        let dimensions: String
        if let width, let height {
            dimensions = "\(width)x\(height)"
        } else {
            dimensions = "unknown"
        }
        let rawOrientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value
        let orientationRawValue = rawOrientation
            .flatMap(CGImagePropertyOrientation.init(rawValue:))?
            .rawValue
        return (dimensions, orientationRawValue)
    }

    private static func nowNanoseconds() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds
    }

    private static func milliseconds(from start: UInt64, to end: UInt64) -> UInt64 {
        guard end >= start else { return 0 }
        return (end - start) / 1_000_000
    }
}
