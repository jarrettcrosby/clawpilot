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
    private var videoListenerAttached = false
    private var photoRequested = false
    private var videoFallbackTask: Task<Void, Never>?
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
        videoListenerAttached = false
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
        videoFallbackTask?.cancel()
        videoFallbackTask = nil
        photoRetryTask?.cancel()
        photoRetryTask = nil
        camera?.stop()
        deviceSession?.stop()
        camera = nil
        deviceSession = nil
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
                resolution: .medium,
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
                    videoFallbackTask?.cancel()
                    videoFallbackTask = Task { [weak self] in
                        try? await Task.sleep(for: .milliseconds(700))
                        guard !Task.isCancelled else { return }
                        await self?.enableVideoFallback()
                    }
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
                } else {
                    enableVideoFallback()
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
            enableVideoFallback()
        } else {
            stop()
        }
    }

    private func enableVideoFallback() {
        guard active, !videoListenerAttached, let camera else { return }
        videoListenerAttached = true
        let processor = processor
        camera.stream.videoFramePublisher.listen { frame in
            processor.consume(frame)
        }.store(in: streamTokens)
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
        videoFallbackTask?.cancel()
        videoFallbackTask = nil
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

    init(continuation: AsyncStream<String>.Continuation) {
        self.continuation = continuation
    }

    func reset() {
        lock.lock()
        emitted = false
        decoding = false
        lock.unlock()
    }

    func consume(_ frame: VideoFrame) {
        guard beginDecoding() else { return }

        let request = barcodeRequest()
        try? VNImageRequestHandler(
            cmSampleBuffer: frame.sampleBuffer,
            orientation: .up
        ).perform([request])
        finishDecoding(request)
    }

    func consume(_ photo: PhotoData) {
        guard beginDecoding() else { return }

        let request = barcodeRequest()
        try? VNImageRequestHandler(
            data: photo.data,
            orientation: .up
        ).perform([request])
        finishDecoding(request)
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
        request.symbologies = [.dataMatrix, .qr, .code128, .ean8, .ean13, .upce]
        return request
    }

    private func finishDecoding(_ request: VNDetectBarcodesRequest) {
        let observations = (request.results ?? []).filter { $0.confidence >= 0.5 }
        let value = observations.count == 1 ? observations.first?.payloadStringValue : nil

        lock.lock()
        decoding = false
        if let value, !value.isEmpty, !emitted {
            emitted = true
            lock.unlock()
            continuation.yield(value)
        } else {
            lock.unlock()
        }
    }
}
