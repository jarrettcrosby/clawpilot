import Foundation
import ImageIO
import MWDATCamera
import MWDATCore
import UIKit
import Vision

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

actor MetaWearablesBarcodeSource {
    nonisolated let barcodes: AsyncStream<String>
    private nonisolated let continuation: AsyncStream<String>.Continuation
    private nonisolated let processor: MetaVisionFrameProcessor
    private let sessionTokens = ListenerTokenBag()
    private let streamTokens = ListenerTokenBag()
    private var deviceSession: DeviceSession?
    private var camera: MWDATCamera.Camera?
    private var active = false
    private var startContinuation: CheckedContinuation<Void, any Error>?
    private var photoRequested = false
    private var photoRetryTask: Task<Void, Never>?

    init() {
        var continuation: AsyncStream<String>.Continuation!
        barcodes = AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation = $0 }
        self.continuation = continuation
        processor = MetaVisionFrameProcessor(continuation: continuation)
    }

    func start() async throws {
        guard !active else { return }
        guard Wearables.shared.registrationState == .registered else {
            throw MetaScanError.registrationRequired
        }
        guard try await Wearables.shared.checkPermissionStatus(.camera) == .granted else {
            throw MetaScanError.cameraPermissionRequired
        }
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
        photoRequested = false
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
                failStart()
            }
        }
    }

    func stop() {
        continuation.finish()
        failStart()
        guard active else { return }
        active = false
        streamTokens.clear()
        sessionTokens.clear()
        photoRetryTask?.cancel()
        photoRetryTask = nil
        camera?.stop()
        deviceSession?.stop()
        camera = nil
        deviceSession = nil
    }

    func prepareForNextBarcode() {
        guard active else { return }
        processor.reset()
        captureFollowupPhoto()
    }

    private func handleSessionState(_ state: DeviceSessionState) {
        guard active else { return }
        switch state {
        case .started: attachCamera()
        case .stopped: stop()
        case .idle, .starting, .paused, .stopping: break
        }
    }

    private func handleSessionError(_ error: DeviceSessionError) {
        if error == .datAppOnTheGlassesUpdateRequired {
            failStart(MetaScanError.glassesAppUpdateRequired)
        } else {
            failStart(MetaScanError.sessionFailed)
        }
    }

    private func attachCamera() {
        guard active, camera == nil, let deviceSession else { return }
        do {
            let configuration = StreamConfiguration(
                videoCodec: .raw,
                resolution: .high,
                frameRate: 15
            )
            guard let camera = try deviceSession.addCamera(config: configuration) else {
                stop()
                return
            }
            self.camera = camera
            let processor = processor
            camera.stream.photoDataPublisher.listen { photo in
                processor.consume(photo)
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
            failStart()
        }
    }

    private func handleStreamState(_ state: StreamState) {
        guard active, let camera else { return }
        switch state {
        case .streaming:
            if !photoRequested {
                photoRequested = true
                let accepted = camera.stream.capturePhoto(format: .jpeg)
                if accepted {
                    photoRetryTask?.cancel()
                    photoRetryTask = Task { [weak self] in
                        // The first photo can occur before the worker has the
                        // barcode centered. Retry high-resolution capture while
                        // live frames continue as a lower-latency fallback.
                        for _ in 0..<6 {
                            try? await Task.sleep(for: .seconds(2))
                            guard !Task.isCancelled else { return }
                            await self?.captureFollowupPhoto()
                        }
                    }
                }
            }
            startContinuation?.resume()
            startContinuation = nil
        case .stopped:
            stop()
        case .stopping, .waitingForDevice, .starting, .paused:
            break
        }
    }

    private func handleStreamError(_ error: StreamError) {
        if error == .photoCaptureFailed {
            captureFollowupPhoto()
        } else {
            stop()
        }
    }

    private func captureFollowupPhoto() {
        guard active, let camera else { return }
        _ = camera.stream.capturePhoto(format: .jpeg)
    }

    private func failStart(_ error: any Error = MetaScanError.sessionFailed) {
        if let startContinuation {
            self.startContinuation = nil
            startContinuation.resume(throwing: error)
        }
        guard active else { return }
        active = false
        streamTokens.clear()
        sessionTokens.clear()
        photoRetryTask?.cancel()
        photoRetryTask = nil
        camera?.stop()
        deviceSession?.stop()
        camera = nil
        deviceSession = nil
        continuation.finish()
    }
}

private final class MetaVisionFrameProcessor: @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncStream<String>.Continuation
    private var decoding = false
    private var emitted = false
    private var recordedVideoInput = false
    private var recordedPhotoInput = false
    private var recordedCandidate = false

    init(continuation: AsyncStream<String>.Continuation) {
        self.continuation = continuation
    }

    func reset() {
        lock.lock()
        emitted = false
        decoding = false
        recordedVideoInput = false
        recordedPhotoInput = false
        recordedCandidate = false
        lock.unlock()
    }

    func consume(_ frame: VideoFrame) {
        if markFirstInput(isPhoto: false) {
            var dimensions = "unknown"
            if let buffer = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
                dimensions = "\(CVPixelBufferGetWidth(buffer))x\(CVPixelBufferGetHeight(buffer))"
            }
            ClawPilotScanDiagnostic.record("video-received:\(dimensions)")
        }
        guard beginDecoding() else { return }

        let request = barcodeRequest()
        try? VNImageRequestHandler(
            cmSampleBuffer: frame.sampleBuffer,
            orientation: .up
        ).perform([request])
        finishDecoding(request)
    }

    func consume(_ photo: PhotoData) {
        if markFirstInput(isPhoto: true) {
            ClawPilotScanDiagnostic.record("photo-received:bytes=\(photo.data.count)")
        }
        guard beginDecoding() else { return }

        let request = barcodeRequest()
        try? VNImageRequestHandler(
            data: photo.data,
            orientation: imageOrientation(in: photo.data)
        ).perform([request])
        finishDecoding(request)
    }

    private func markFirstInput(isPhoto: Bool) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if isPhoto {
            guard !recordedPhotoInput else { return false }
            recordedPhotoInput = true
        } else {
            guard !recordedVideoInput else { return false }
            recordedVideoInput = true
        }
        return true
    }

    private func beginDecoding() -> Bool {
        lock.lock()
        guard !decoding, !emitted else {
            lock.unlock()
            return false
        }
        decoding = true
        lock.unlock()
        return true
    }

    private func barcodeRequest() -> VNDetectBarcodesRequest {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [
            .ean8, .ean13, .upce,
            .code128, .code39, .code93,
            .i2of5, .itf14,
            .gs1DataBar, .gs1DataBarExpanded, .gs1DataBarLimited,
            .dataMatrix, .qr, .pdf417, .aztec,
        ]
        return request
    }

    private func finishDecoding(_ request: VNDetectBarcodesRequest) {
        let observations = (request.results ?? []).filter { $0.confidence >= 0.25 }
        let values = Set(observations.compactMap(\.payloadStringValue).filter { !$0.isEmpty })
        let value = values.count == 1 ? values.first : nil
        let bestConfidence = observations.map(\.confidence).max()

        lock.lock()
        decoding = false
        let shouldRecordCandidate = !values.isEmpty && !recordedCandidate
        if shouldRecordCandidate { recordedCandidate = true }
        if let value, !value.isEmpty, !emitted {
            emitted = true
            lock.unlock()
            ClawPilotScanDiagnostic.record(
                "vision-decoded:\(value):confidence=\(bestConfidence ?? 0)"
            )
            continuation.yield(value)
        } else {
            lock.unlock()
            if shouldRecordCandidate {
                ClawPilotScanDiagnostic.record(
                    "vision-candidates:\(values.count):confidence=\(bestConfidence ?? 0)"
                )
            }
        }
    }

    private func imageOrientation(in data: Data) -> CGImagePropertyOrientation {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let rawValue = properties[kCGImagePropertyOrientation] as? UInt32,
              let orientation = CGImagePropertyOrientation(rawValue: rawValue)
        else { return .up }
        return orientation
    }
}
