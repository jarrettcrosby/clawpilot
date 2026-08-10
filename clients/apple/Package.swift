// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClawPilotPicking",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
        .macOS(.v14),
    ],
    products: [
        .library(name: "ClawPilotPickingCore", targets: ["ClawPilotPickingCore"]),
        .library(name: "ClawPilotPickingApple", targets: ["ClawPilotPickingApple"]),
    ],
    targets: [
        .target(name: "ClawPilotPickingCore"),
        .target(
            name: "ClawPilotPickingApple",
            dependencies: ["ClawPilotPickingCore"]
        ),
        .testTarget(
            name: "ClawPilotPickingCoreTests",
            dependencies: ["ClawPilotPickingCore", "ClawPilotPickingApple"]
        ),
    ]
)
