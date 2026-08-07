import SwiftUI
import VisionKit

struct PhoneCameraScanner: UIViewControllerRepresentable {
    let onBarcode: @MainActor (String) -> Void
    let onClose: @MainActor () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode()],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: PhoneCameraScanner
        private var accepted = false

        init(parent: PhoneCameraScanner) { self.parent = parent }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard !accepted, allItems.count == 1,
                  case let .barcode(barcode) = addedItems.first,
                  let value = barcode.payloadStringValue else { return }
            accepted = true
            dataScanner.stopScanning()
            Task { @MainActor in
                parent.onBarcode(value)
                parent.onClose()
            }
        }
    }
}

