// swift-tools-version:5.9
/*--------------------------------------------------------------------------------------
 *  Copyright 2025 V3Code / Glass Devtools. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import PackageDescription

// The macOS floor is 12.0. ScreenCaptureKit only shipped in 12.3, and the screenshot entry point
// the helper uses (SCScreenshotManager) is 14.0+, so the framework is *weak* linked: on an older
// system the load succeeds with the symbols unbound and Capture falls back to CGWindowList.
//
// `-disable-autolink-framework` suppresses the strong autolink record that `import ScreenCaptureKit`
// would otherwise emit, and `-weak_framework` supplies the weak one in its place. Without the first
// flag the strong record wins and the binary refuses to launch on 12.0-12.2.
let package = Package(
	name: "v3code-computer-use",
	platforms: [.macOS(.v12)],
	products: [
		.executable(name: "v3code-computer-use", targets: ["v3code-computer-use"]),
	],
	targets: [
		.executableTarget(
			name: "v3code-computer-use",
			path: "Sources/v3code-computer-use",
			swiftSettings: [
				.unsafeFlags(["-Xfrontend", "-disable-autolink-framework", "-Xfrontend", "ScreenCaptureKit"]),
			],
			linkerSettings: [
				.linkedFramework("AppKit"),
				.linkedFramework("CoreGraphics"),
				.linkedFramework("ApplicationServices"),
				.linkedFramework("ImageIO"),
				.unsafeFlags(["-Xlinker", "-weak_framework", "-Xlinker", "ScreenCaptureKit"]),
			]
		),
	]
)
