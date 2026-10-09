import AppKit
import CoreGraphics

// LaunchServices opens the archive's actual app bundle with no application
// arguments. No DevTools, shell execution, accessibility automation, or system
// security changes are involved. Only the new instance is terminated below.
let appURL = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().standardizedFileURL
let profile = CommandLine.arguments[2]
let reportURL = URL(fileURLWithPath: CommandLine.arguments[3])
let started = Date()
var instance: NSRunningApplication?
var launchError: String?
var completed = false
let configuration = NSWorkspace.OpenConfiguration()
configuration.arguments = []
configuration.environment = ["TABBY_CONFIG_DIRECTORY": profile, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
configuration.createsNewApplicationInstance = true
configuration.activates = true
NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { application, error in
    instance = application
    launchError = error?.localizedDescription
    completed = true
}

func tick() {
    _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.2))
}
func visibleWindows(_ pid: pid_t) -> Int {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return windows.filter { window in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber else { return false }
        return width.doubleValue >= 400 && height.doubleValue >= 250
    }.count
}

while !completed && Date().timeIntervalSince(started) < 50 { tick() }
var windowCount = 0
var stableSince: Date?
var passed = false
if let application = instance {
    if application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL != appURL {
        launchError = "LaunchServices returned a different app bundle"
    } else {
        while !application.isTerminated && Date().timeIntervalSince(started) < 65 {
            windowCount = visibleWindows(application.processIdentifier)
            if windowCount > 0 {
                if stableSince == nil { stableSince = Date() }
                if Date().timeIntervalSince(stableSince!) >= 10 { passed = true; break }
            } else { stableSince = nil }
            tick()
        }
        if !passed { launchError = "App exited or failed to keep a visible window for ten seconds" }
    }
} else if launchError == nil { launchError = "LaunchServices did not return an instance within fifty seconds" }

let report: [String: Any] = [
    "passed": passed, "method": "NSWorkspace.openApplication / LaunchServices",
    "applicationArguments": [String](), "debuggingEnabled": false,
    "appURL": appURL.path, "pid": instance?.processIdentifier ?? -1,
    "visibleWindows": windowCount, "stableWindowSeconds": passed ? 10 : 0,
    "durationMs": Int(Date().timeIntervalSince(started) * 1000),
    "error": launchError as Any? ?? NSNull(),
    "downloadedManualApprovalVerified": false, "SSHGUIAcceptance": false,
]
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL)
if let application = instance, !application.isTerminated {
    _ = application.terminate()
    let deadline = Date(timeIntervalSinceNow: 5)
    while !application.isTerminated && Date() < deadline { tick() }
    if !application.isTerminated { _ = application.forceTerminate() }
}
exit(passed ? 0 : 1)
