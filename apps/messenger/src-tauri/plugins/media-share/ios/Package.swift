// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-media-share",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-media-share",
      type: .static,
      targets: ["tauri-plugin-media-share"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-media-share",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
