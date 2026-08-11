import AVFoundation
import ImageIO
import SwiftUI
import UIKit
import Vision
import VisionKit
import ClawPilotPickingCore

struct PhoneCameraScanContext: Equatable, Sendable {
    let taskGlobalID: String
    let stage: PickScanStage
    let expectedBarcode: String?
    let headline: String
    let detail: String

    var identity: String {
        "\(taskGlobalID):\(stage.rawValue):\(expectedBarcode ?? "missing")"
    }

    var stageLabel: String {
        stage == .location ? "LOCATION 1 OF 2" : "PRODUCT 2 OF 2"
    }

    var initialFeedback: String {
        guard expectedBarcode != nil else {
            return "This assignment has no barcode to match. Close the camera and ask a manager to assign one."
        }
        return stage == .location
            ? "Center the location label. If it is not matched within two seconds, tap Scan current frame."
            : "Center the product barcode. If it is not matched within two seconds, tap Scan current frame."
    }

    func matches(_ observed: String) -> Bool {
        guard let expectedBarcode else { return false }
        if stage == .location { return observed == expectedBarcode }
        return BarcodeMatcher.matches(observed: observed, expected: expectedBarcode)
    }

    func preferredPayload(in payloads: [String]) -> String? {
        payloads.first(where: matches)
    }
}

enum PhoneCameraFeedbackTone: Sendable {
    case neutral
    case success
    case warning
    case error
}

struct PhoneCameraScanOutcome: Sendable {
    let shouldClose: Bool
    let context: PhoneCameraScanContext?
    let feedback: String
    let tone: PhoneCameraFeedbackTone

    static func continueScanning(
        context: PhoneCameraScanContext,
        feedback: String,
        tone: PhoneCameraFeedbackTone
    ) -> Self {
        Self(shouldClose: false, context: context, feedback: feedback, tone: tone)
    }

    static func close(
        feedback: String,
        tone: PhoneCameraFeedbackTone = .success
    ) -> Self {
        Self(shouldClose: true, context: nil, feedback: feedback, tone: tone)
    }
}

struct PhoneCameraScanner: UIViewControllerRepresentable {
    let scanContext: PhoneCameraScanContext
    let onBarcode: @MainActor (String) async -> PhoneCameraScanOutcome
    let onClose: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> PhoneCameraScannerContainerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.code128, .ean8, .ean13, .upce])],
            qualityLevel: .fast,
            recognizesMultipleItems: true,
            isHighFrameRateTrackingEnabled: true,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        context.coordinator.install(on: scanner)
        let container = PhoneCameraScannerContainerViewController(scanner: scanner)
        container.onViewDidAppear = { [weak coordinator = context.coordinator] scanner in
            coordinator?.startWhenAuthorized(scanner)
        }
        return container
    }

    func updateUIViewController(
        _ controller: PhoneCameraScannerContainerViewController,
        context: Context
    ) {
        context.coordinator.update(parent: self, scanner: controller.scanner)
    }

    static func dismantleUIViewController(
        _ controller: PhoneCameraScannerContainerViewController,
        coordinator: Coordinator
    ) {
        coordinator.shutdown(controller.scanner)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private var parent: PhoneCameraScanner
        private weak var scanner: DataScannerViewController?
        private var activeContext: PhoneCameraScanContext
        private var isSubmitting = false
        private var isCapturingPhoto = false
        private var latestPayloads: [String] = []
        private var lastSubmission: (contextID: String, payload: String, at: Date)?
        private let openedAt = Date()
        private var recordedLiveCandidateContexts: Set<String> = []
        private var recordedCameraLive = false
        private var authorizationTask: Task<Void, Never>?
        private var recognizedItemsTask: Task<Void, Never>?
        private var photoTask: Task<Void, Never>?

        private let stageLabel = UILabel()
        private let headlineLabel = UILabel()
        private let detailLabel = UILabel()
        private let feedbackLabel = UILabel()
        private let captureButton = UIButton(type: .system)
        private let closeButton = UIButton(type: .system)

        init(parent: PhoneCameraScanner) {
            self.parent = parent
            activeContext = parent.scanContext
        }

        func install(on scanner: DataScannerViewController) {
            self.scanner = scanner
            ClawPilotScanDiagnostic.begin("iphone:open:stage=\(activeContext.stage.rawValue)")
            installOverlay(on: scanner)
            applyContext(activeContext, feedback: activeContext.initialFeedback, tone: .neutral)
        }

        func update(parent: PhoneCameraScanner, scanner: DataScannerViewController) {
            self.parent = parent
            self.scanner = scanner
            guard parent.scanContext.identity != activeContext.identity else { return }
            activeContext = parent.scanContext
            lastSubmission = nil
            applyContext(activeContext, feedback: activeContext.initialFeedback, tone: .neutral)
            evaluateLatestPayloads(origin: .live)
        }

        func startWhenAuthorized(_ scanner: DataScannerViewController) {
            guard authorizationTask == nil else { return }
            authorizationTask = Task { @MainActor [weak self, weak scanner] in
                guard let self, let scanner else { return }
                defer { self.authorizationTask = nil }

                guard DataScannerViewController.isSupported else {
                    self.showUnavailable("This iPhone does not support live barcode scanning.")
                    return
                }

                let authorization = AVCaptureDevice.authorizationStatus(for: .video)
                let granted: Bool
                switch authorization {
                case .authorized:
                    granted = true
                case .notDetermined:
                    granted = await AVCaptureDevice.requestAccess(for: .video)
                default:
                    granted = false
                }
                guard granted else {
                    self.showUnavailable("Camera access is off. Enable it in iPhone Settings, then tap Retry camera.")
                    return
                }
                guard DataScannerViewController.isAvailable else {
                    self.showUnavailable("The camera is temporarily unavailable. Close other camera apps, then tap Retry camera.")
                    return
                }

                do {
                    if !scanner.isScanning { try scanner.startScanning() }
                    self.startRecognizedItemsMonitor(scanner)
                    if !self.recordedCameraLive {
                        self.recordedCameraLive = true
                        self.recordDiagnostic("camera-live:stage=\(self.activeContext.stage.rawValue)")
                    }
                    self.captureButton.isEnabled = self.activeContext.expectedBarcode != nil
                    self.captureButton.setTitle("Scan current frame", for: .normal)
                    if self.latestPayloads.isEmpty {
                        self.setFeedback(self.activeContext.initialFeedback, tone: .neutral)
                    }
                } catch {
                    self.showUnavailable("The camera could not start. Tap Retry camera to try again.")
                }
            }
        }

        func shutdown(_ scanner: DataScannerViewController) {
            authorizationTask?.cancel()
            recognizedItemsTask?.cancel()
            photoTask?.cancel()
            authorizationTask = nil
            recognizedItemsTask = nil
            photoTask = nil
            if scanner.isScanning { scanner.stopScanning() }
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            observe(allItems.isEmpty ? addedItems : allItems, origin: .live)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didUpdate updatedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            observe(allItems.isEmpty ? updatedItems : allItems, origin: .live)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didRemove removedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            observe(allItems, origin: .live)
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
        ) {
            recognizedItemsTask?.cancel()
            recognizedItemsTask = nil
            showUnavailable("Live scanning stopped because the camera became unavailable. Tap Retry camera.")
        }

        private func startRecognizedItemsMonitor(_ scanner: DataScannerViewController) {
            guard recognizedItemsTask == nil else { return }
            recognizedItemsTask = Task { @MainActor [weak self, weak scanner] in
                guard let self, let scanner else { return }
                for await items in scanner.recognizedItems {
                    if Task.isCancelled { break }
                    self.observe(items, origin: .live)
                }
            }
        }

        private enum ObservationOrigin: Equatable {
            case live
            case capturedPhoto

            var diagnosticName: String {
                switch self {
                case .live: "live"
                case .capturedPhoto: "fallback"
                }
            }
        }

        private func observe(_ items: [RecognizedItem], origin: ObservationOrigin) {
            let payloads = uniquePayloads(in: items)
            observe(payloads, origin: origin)
        }

        private func observe(_ payloads: [String], origin: ObservationOrigin) {
            latestPayloads = payloads
            if origin == .live,
               !payloads.isEmpty,
               recordedLiveCandidateContexts.insert(activeContext.identity).inserted {
                recordDiagnostic(
                    "live-candidate:stage=\(activeContext.stage.rawValue):count=\(payloads.count)"
                )
            }
            if let lastSubmission, !payloads.contains(lastSubmission.payload) {
                self.lastSubmission = nil
            }
            evaluateLatestPayloads(origin: origin)
        }

        private func evaluateLatestPayloads(origin: ObservationOrigin) {
            guard !isSubmitting, !latestPayloads.isEmpty else { return }
            guard let payload = activeContext.preferredPayload(in: latestPayloads) else {
                let message = activeContext.expectedBarcode == nil
                    ? "This assignment has no expected barcode to match."
                    : latestPayloads.count == 1
                        ? "A different barcode is visible. \(activeContext.initialFeedback)"
                        : "Multiple barcodes are visible. Keep the expected label centered."
                setFeedback(message, tone: .warning)
                return
            }

            if let lastSubmission,
               lastSubmission.contextID == activeContext.identity,
               lastSubmission.payload == payload,
               Date().timeIntervalSince(lastSubmission.at) < 1.5 {
                return
            }
            submit(payload, origin: origin)
        }

        private func submit(_ payload: String, origin: ObservationOrigin) {
            guard !isSubmitting else { return }
            isSubmitting = true
            closeButton.isEnabled = false
            let submittedStage = activeContext.stage
            let submittedOrigin = origin
            lastSubmission = (activeContext.identity, payload, Date())
            setFeedback(
                origin == .capturedPhoto ? "Checking the captured frame…" : "Barcode found. Checking this assignment…",
                tone: .neutral
            )

            Task { @MainActor [weak self] in
                guard let self else { return }
                let outcome = await self.parent.onBarcode(payload)
                self.isSubmitting = false
                self.closeButton.isEnabled = true
                if case .success = outcome.tone {
                    self.recordDiagnostic(
                        "accepted:stage=\(submittedStage.rawValue):source=\(submittedOrigin.diagnosticName)"
                    )
                }
                if outcome.shouldClose {
                    self.setFeedback(outcome.feedback, tone: outcome.tone)
                    self.parent.onClose()
                    return
                }
                if let context = outcome.context {
                    self.activeContext = context
                    self.lastSubmission = nil
                    self.applyContext(context, feedback: outcome.feedback, tone: outcome.tone)
                } else {
                    self.setFeedback(outcome.feedback, tone: outcome.tone)
                }
                self.evaluateLatestPayloads(origin: .live)
            }
        }

        @objc private func captureCurrentFrame() {
            guard let scanner else { return }
            guard scanner.isScanning else {
                startWhenAuthorized(scanner)
                return
            }
            guard !isCapturingPhoto, !isSubmitting else { return }
            guard activeContext.expectedBarcode != nil else {
                setFeedback("This assignment has no expected barcode to match.", tone: .error)
                return
            }

            isCapturingPhoto = true
            recordDiagnostic("fallback-start:stage=\(activeContext.stage.rawValue)")
            captureButton.isEnabled = false
            captureButton.setTitle("Scanning frame…", for: .normal)
            setFeedback("Capturing one high-resolution frame in memory…", tone: .neutral)
            photoTask = Task { @MainActor [weak self, weak scanner] in
                guard let self, let scanner else { return }
                defer {
                    self.isCapturingPhoto = false
                    self.photoTask = nil
                    self.captureButton.isEnabled = self.activeContext.expectedBarcode != nil
                    self.captureButton.setTitle("Scan current frame", for: .normal)
                }
                do {
                    let image = try await scanner.capturePhoto()
                    try Task.checkCancellation()
                    guard let cgImage = image.cgImage else {
                        self.setFeedback("The camera frame could not be read. Hold steady and try again.", tone: .error)
                        return
                    }
                    let orientation = CGImagePropertyOrientation(image.imageOrientation)
                    let payloads = try await Task.detached(priority: .userInitiated) {
                        try Self.decodeBarcodes(in: cgImage, orientation: orientation)
                    }.value
                    try Task.checkCancellation()
                    guard !payloads.isEmpty else {
                        self.recordDiagnostic("fallback-result:none")
                        self.setFeedback("No barcode was found in that frame. Fill the guide with the label and try again.", tone: .warning)
                        return
                    }
                    self.recordDiagnostic("fallback-result:candidates=\(payloads.count)")
                    self.observe(payloads, origin: .capturedPhoto)
                } catch is CancellationError {
                    return
                } catch {
                    self.recordDiagnostic("fallback-result:error")
                    self.setFeedback("The high-resolution frame could not be scanned. Live scanning is still active.", tone: .error)
                }
            }
        }

        nonisolated private static func decodeBarcodes(
            in image: CGImage,
            orientation: CGImagePropertyOrientation
        ) throws -> [String] {
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.code128, .ean8, .ean13, .upce]
            let handler = VNImageRequestHandler(cgImage: image, orientation: orientation)
            try handler.perform([request])
            var seen: Set<String> = []
            return (request.results ?? []).compactMap(\.payloadStringValue).filter { seen.insert($0).inserted }
        }

        @objc private func closeScanner() {
            parent.onClose()
        }

        private func uniquePayloads(in items: [RecognizedItem]) -> [String] {
            var seen: Set<String> = []
            return items.compactMap { item in
                guard case let .barcode(barcode) = item,
                      let payload = barcode.payloadStringValue,
                      seen.insert(payload).inserted else { return nil }
                return payload
            }
        }

        private func showUnavailable(_ message: String) {
            recordDiagnostic("unavailable:stage=\(activeContext.stage.rawValue)")
            setFeedback(message, tone: .error)
            captureButton.isEnabled = true
            captureButton.setTitle("Retry camera", for: .normal)
        }

        private func applyContext(
            _ context: PhoneCameraScanContext,
            feedback: String,
            tone: PhoneCameraFeedbackTone
        ) {
            stageLabel.text = context.stageLabel
            headlineLabel.text = context.headline
            detailLabel.text = context.detail
            captureButton.isEnabled = context.expectedBarcode != nil
            setFeedback(feedback, tone: tone)
        }

        private func setFeedback(_ text: String, tone: PhoneCameraFeedbackTone) {
            feedbackLabel.text = text
            feedbackLabel.textColor = switch tone {
            case .neutral: .white
            case .success: UIColor(red: 0.43, green: 0.91, blue: 0.70, alpha: 1)
            case .warning: UIColor(red: 1, green: 0.73, blue: 0.30, alpha: 1)
            case .error: UIColor(red: 1, green: 0.48, blue: 0.48, alpha: 1)
            }
        }

        private func recordDiagnostic(_ event: String) {
            let elapsedMilliseconds = max(0, Int(Date().timeIntervalSince(openedAt) * 1_000))
            ClawPilotScanDiagnostic.record("iphone:\(event):elapsed_ms=\(elapsedMilliseconds)")
        }

        private func installOverlay(on scanner: DataScannerViewController) {
            let overlay = scanner.overlayContainerView

            closeButton.configuration = .filled()
            closeButton.configuration?.image = UIImage(systemName: "xmark")
            closeButton.configuration?.cornerStyle = .capsule
            closeButton.configuration?.baseBackgroundColor = UIColor.black.withAlphaComponent(0.72)
            closeButton.configuration?.baseForegroundColor = .white
            closeButton.accessibilityLabel = "Close barcode scanner"
            closeButton.addTarget(self, action: #selector(closeScanner), for: .touchUpInside)
            closeButton.translatesAutoresizingMaskIntoConstraints = false

            stageLabel.font = .preferredFont(forTextStyle: .caption1)
            stageLabel.adjustsFontForContentSizeCategory = true
            stageLabel.textColor = UIColor(red: 0.43, green: 0.91, blue: 0.70, alpha: 1)

            headlineLabel.font = .preferredFont(forTextStyle: .title2)
            headlineLabel.adjustsFontForContentSizeCategory = true
            headlineLabel.textColor = .white
            headlineLabel.numberOfLines = 2

            detailLabel.font = .preferredFont(forTextStyle: .subheadline)
            detailLabel.adjustsFontForContentSizeCategory = true
            detailLabel.textColor = UIColor.white.withAlphaComponent(0.82)
            detailLabel.numberOfLines = 2

            feedbackLabel.font = .preferredFont(forTextStyle: .footnote)
            feedbackLabel.adjustsFontForContentSizeCategory = true
            feedbackLabel.numberOfLines = 3

            captureButton.configuration = .filled()
            captureButton.configuration?.title = "Scan current frame"
            captureButton.configuration?.image = UIImage(systemName: "camera.viewfinder")
            captureButton.configuration?.imagePadding = 8
            captureButton.configuration?.cornerStyle = .large
            captureButton.configuration?.baseBackgroundColor = UIColor(red: 0.43, green: 0.65, blue: 0.96, alpha: 1)
            captureButton.configuration?.baseForegroundColor = .black
            captureButton.addTarget(self, action: #selector(captureCurrentFrame), for: .touchUpInside)

            let privacyLabel = UILabel()
            privacyLabel.text = "High-resolution fallback checks one frame in memory. Nothing is saved."
            privacyLabel.font = .preferredFont(forTextStyle: .caption2)
            privacyLabel.adjustsFontForContentSizeCategory = true
            privacyLabel.textColor = UIColor.white.withAlphaComponent(0.7)
            privacyLabel.numberOfLines = 2

            let stack = UIStackView(arrangedSubviews: [
                stageLabel,
                headlineLabel,
                detailLabel,
                feedbackLabel,
                captureButton,
                privacyLabel,
            ])
            stack.axis = .vertical
            stack.spacing = 8
            stack.translatesAutoresizingMaskIntoConstraints = false

            let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterialDark))
            blur.layer.cornerRadius = 20
            blur.layer.masksToBounds = true
            blur.translatesAutoresizingMaskIntoConstraints = false
            blur.contentView.addSubview(stack)

            overlay.addSubview(closeButton)
            overlay.addSubview(blur)
            NSLayoutConstraint.activate([
                closeButton.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor, constant: 12),
                closeButton.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -16),
                closeButton.widthAnchor.constraint(equalToConstant: 44),
                closeButton.heightAnchor.constraint(equalToConstant: 44),

                blur.leadingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.leadingAnchor, constant: 14),
                blur.trailingAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.trailingAnchor, constant: -14),
                blur.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor, constant: -14),

                stack.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 16),
                stack.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 16),
                stack.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -16),
                stack.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -16),
                captureButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            ])
        }
    }
}

@MainActor
final class PhoneCameraScannerContainerViewController: UIViewController {
    let scanner: DataScannerViewController
    var onViewDidAppear: ((DataScannerViewController) -> Void)?

    init(scanner: DataScannerViewController) {
        self.scanner = scanner
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(scanner)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scanner.view)
        NSLayoutConstraint.activate([
            scanner.view.topAnchor.constraint(equalTo: view.topAnchor),
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onViewDidAppear?(scanner)
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        self = switch orientation {
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
}
