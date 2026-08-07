import Foundation
import ImageIO
import MWDATCamera
import MWDATCore
import UIKit
import Vision

enum MetaWearablesAppBridge {
    static func configure() throws { try Wearables.configure() }
    static var registrationState: RegistrationState { Wearables.shared.registrationState }
    static var isRegistered: Bool { registrationState == .registered }
    static func startRegistration() async throws { try await Wearables.shared.startRegistration() }
    static func statusSnapshot() async -> MetaWearablesStatusSnapshot {
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
        try await Wearables.shared.requestPermission(.camera) == .granted
    }
    static func handleOpenURL(_ url: URL) async throws -> Bool {
        try await Wearables.shared.handleUrl(url)
    }
}

struct MetaWearablesStatusSnapshot {
    let registrationState: RegistrationState
    let cameraPermissionGranted: Bool?
    let connectedDeviceCount: Int
}

enum MetaScanError: Error, Sendable {
    case unavailable
    case registrationRequired
    case cameraPermissionRequired
    case exactlyOneDeviceRequired
    case sessionFailed
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
        let devices = Wearables.shared.devices.filter { identifier in
            guard let device = Wearables.shared.deviceForIdentifier(identifier) else { return false }
#if DEBUG
            let compatible = device.compatibility() == .compatible || device.compatibility() == .undefined
#else
            let compatible = device.compatibility() == .compatible
#endif
            return device.linkState == .connected && compatible
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
            Task { await self?.handleSessionState(state) }
        }.store(in: sessionTokens)
        session.errorPublisher.listen { [weak self] _ in
            Task { await self?.stop() }
        }.store(in: sessionTokens)
        do { try session.start() } catch {
            stop()
            throw MetaScanError.sessionFailed
        }
    }

    func stop() {
        guard active else { return }
        active = false
        streamTokens.clear()
        sessionTokens.clear()
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
            camera.stream.videoFramePublisher.listen { frame in
                processor.consume(frame)
            }.store(in: streamTokens)
            camera.stream.errorPublisher.listen { [weak self] _ in
                Task { await self?.stop() }
            }.store(in: streamTokens)
            camera.stream.start()
        } catch {
            stop()
        }
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
        lock.lock()
        guard !decoding, !emitted else { lock.unlock(); return }
        decoding = true
        lock.unlock()

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.dataMatrix, .qr, .code128, .ean8, .ean13, .upce]
        try? VNImageRequestHandler(
            cmSampleBuffer: frame.sampleBuffer,
            orientation: .up
        ).perform([request])
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
