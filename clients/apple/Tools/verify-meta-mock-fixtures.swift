import AVFoundation
import CryptoKit
import Foundation
import Vision

struct FixtureObservation: Equatable {
    let symbology: VNBarcodeSymbology
    let payload: String
    let isGS1: Bool
}

struct FixtureSpec {
    let filename: String
    let expectedSHA256: String
    let samples: [(time: TimeInterval, expected: [FixtureObservation])]
}

enum FixtureVerificationError: Error, CustomStringConvertible {
    case invalidArguments
    case missing(String)
    case digest(String)
    case observations(String, [FixtureObservation])

    var description: String {
        switch self {
        case .invalidArguments:
            return "Pass the Meta mock fixture directory as the only argument."
        case let .missing(filename):
            return "Missing fixture: \(filename)"
        case let .digest(filename):
            return "Fixture digest changed: \(filename)"
        case let .observations(filename, actual):
            let summary = actual.map {
                "\($0.symbology.rawValue):\(String(reflecting: $0.payload)):gs1=\($0.isGS1)"
            }.joined(separator: ", ")
            return "Fixture observations changed for \(filename): [\(summary)]"
        }
    }
}

func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func observations(
    at url: URL,
    time: TimeInterval
) async throws -> [FixtureObservation] {
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    let (image, _) = try await generator.image(
        at: CMTime(seconds: time, preferredTimescale: 600)
    )
    let request = VNDetectBarcodesRequest()
    request.symbologies = [
        .dataMatrix,
        .qr,
        .code128,
        .ean8,
        .ean13,
        .upce,
    ]
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { result in
        guard let payload = result.payloadStringValue else { return nil }
        return FixtureObservation(
            symbology: result.symbology,
            payload: payload,
            isGS1: result.isGS1DataCarrier
        )
    }.sorted {
        if $0.symbology.rawValue != $1.symbology.rawValue {
            return $0.symbology.rawValue < $1.symbology.rawValue
        }
        return $0.payload < $1.payload
    }
}

guard CommandLine.arguments.count == 2 else {
    throw FixtureVerificationError.invalidArguments
}

let fixtureDirectory = URL(
    fileURLWithPath: CommandLine.arguments[1],
    isDirectory: true
)

// During initial fixture generation, run with IOS_INSPECT_META_FIXTURES=1
// to print Vision's exact platform observations before sealing expectations.
if ProcessInfo.processInfo.environment["IOS_INSPECT_META_FIXTURES"] == "1" {
    for filename in [
        "meta_mock_gs1_datamatrix.mp4",
        "meta_mock_code128_leading_zero.mp4",
        "meta_mock_ambiguous.mp4",
        "meta_mock_delayed_code128.mp4",
    ] {
        let time = filename.contains("delayed") ? 4.0 : 1.0
        let result = try await observations(
            at: fixtureDirectory.appendingPathComponent(filename),
            time: time
        )
        print(filename)
        for item in result {
            print(
                "  \(item.symbology.rawValue) "
                    + "\(String(reflecting: item.payload)) "
                    + "gs1=\(item.isGS1)"
            )
        }
    }
    exit(EXIT_SUCCESS)
}

let gs1DataMatrix = FixtureObservation(
    symbology: .dataMatrix,
    payload: "01000123456789051727123110LOT42\u{1D}21SER0001",
    isGS1: true
)
let leadingZeroCode128 = FixtureObservation(
    symbology: .code128,
    payload: "000123456789",
    isGS1: false
)

let specs: [FixtureSpec] = [
    FixtureSpec(
        filename: "meta_mock_gs1_datamatrix.mp4",
        expectedSHA256:
            "6c5fcba55d51769527570e66100abcec7719fb22a883564ae105fd12b224e875",
        samples: [(1.0, [gs1DataMatrix])]
    ),
    FixtureSpec(
        filename: "meta_mock_code128_leading_zero.mp4",
        expectedSHA256:
            "26f511882b670f1980339e09b697c254a4e58e2c420fa33fe4eee9bb5f24e999",
        samples: [(1.0, [leadingZeroCode128])]
    ),
    FixtureSpec(
        filename: "meta_mock_ambiguous.mp4",
        expectedSHA256:
            "deb977ac1881f3686aa9a4f14960792c699f9480e1f53bd1668c107d0eba904f",
        samples: [(1.0, [leadingZeroCode128, gs1DataMatrix])]
    ),
    FixtureSpec(
        filename: "meta_mock_delayed_code128.mp4",
        expectedSHA256:
            "1ecd5b1ace25e316e8dea5b1f96a464836754a8df44197c4b40016f66cd14bec",
        samples: [
            (1.0, []),
            (4.0, [leadingZeroCode128]),
        ]
    ),
]

for spec in specs {
    let url = fixtureDirectory.appendingPathComponent(spec.filename)
    guard FileManager.default.fileExists(atPath: url.path) else {
        throw FixtureVerificationError.missing(spec.filename)
    }
    let data = try Data(contentsOf: url)
    guard sha256(data) == spec.expectedSHA256 else {
        throw FixtureVerificationError.digest(spec.filename)
    }
    for sample in spec.samples {
        let actual = try await observations(at: url, time: sample.time)
        guard actual == sample.expected else {
            throw FixtureVerificationError.observations(spec.filename, actual)
        }
    }
}

guard specs.count == 4 else {
    throw FixtureVerificationError.invalidArguments
}

print("Meta mock camera fixtures passed exact Apple Vision verification.")
