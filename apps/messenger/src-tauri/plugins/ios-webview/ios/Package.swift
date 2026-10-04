// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-ios-webview",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-ios-webview",
      type: .static,
      targets: ["tauri-plugin-ios-webview"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ios-webview",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
