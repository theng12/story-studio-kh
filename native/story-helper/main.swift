// Story Studio KH Helper — the detached update swap helper.
//
// The app starts this helper (from Story Studio KH Helper.app) with the SU_* variables and quits;
// the helper waits for that pid, swaps the installed .app with the staged one, relaunches it, and
// puts the previous app back if the new version never reports healthy.
//
// The process must be the bundle executable, never a shell script: its visible name on every
// surface is exactly "Story Studio KH Helper" (owner naming rule, 2026-11-11).

import Foundation
import Darwin

if CommandLine.arguments.count >= 2 && CommandLine.arguments[1] == "--version" {
    print("Story Studio KH Helper 1")
    exit(0)
}

let environment = ProcessInfo.processInfo.environment
func env(_ key: String) -> String { environment[key] ?? "" }

let target = env("SU_TARGET")
let staged = env("SU_STAGED")
let keepRoot = env("SU_KEEP")
let stateFile = env("SU_STATE")
let resultFile = env("SU_RESULT")
let logFile = env("SU_LOG")
let newVersion = env("SU_VERSION")
let oldVersion = env("SU_OLD_VERSION")
let label = env("SU_LABEL")
let parentPid = pid_t(env("SU_PID")) ?? -1
let quitWaitSeconds = Int(env("SU_QUIT_WAIT")) ?? 300
let healthSeconds = Int(env("SU_HEALTH_SECONDS")) ?? 300
/// The shell helper used `$HOME`; keep that contract (tests set their own HOME).
let home = env("HOME").isEmpty ? NSHomeDirectory() : env("HOME")
/// `launchctl` is swappable so the tests never touch a real launchd job.
let launchctl = env("SU_LAUNCHCTL").isEmpty ? "/bin/launchctl" : env("SU_LAUNCHCTL")

let fileManager = FileManager.default

func log(_ message: String) {
    guard !logFile.isEmpty else { return }
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    guard let data = "\(formatter.string(from: Date())) \(message)\n".data(using: .utf8) else { return }
    if let handle = FileHandle(forWritingAtPath: logFile) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: URL(fileURLWithPath: logFile))
    }
}

func writeResult(_ outcome: String, _ detail: String) {
    let payload: [String: Any] = [
        "outcome": outcome,
        "detail": detail,
        "at": Int(Date().timeIntervalSince1970),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
        try? data.write(to: URL(fileURLWithPath: resultFile), options: .atomic)
    }
    log("\(outcome): \(detail)")
}

func alive(_ pid: pid_t) -> Bool {
    if pid <= 0 { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

func isDirectory(_ path: String) -> Bool {
    var directory: ObjCBool = false
    return fileManager.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
}

func volumeNumber(_ path: String) -> Int? {
    guard let attributes = try? fileManager.attributesOfFileSystem(forPath: path),
          let number = attributes[.systemNumber] as? NSNumber else { return nil }
    return number.intValue
}

@discardableResult
func run(_ executable: String, _ arguments: [String], environment extra: [String: String]? = nil) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let extra { process.environment = extra }
    do { try process.run() } catch { return -1 }
    process.waitUntilExit()
    return process.terminationStatus
}

func timestamp() -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMddHHmmss"
    return formatter.string(from: Date())
}

func relaunch() {
    let command = env("SU_RELAUNCH")
    if !command.isEmpty {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-c", command, "_", target]
        // Process puts the child in its own process group, so the relaunch cannot find this helper
        // by its group id; it gets the pid instead (the tests key their relaunch marker on it).
        var extra = environment
        extra["SU_HELPER_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = extra
        if let handle = FileHandle(forWritingAtPath: logFile) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }
        try? process.run()
        return
    }
    let plist = "\(home)/Library/LaunchAgents/\(label).plist"
    if fileManager.fileExists(atPath: plist) {
        let uid = getuid()
        _ = run(launchctl, ["bootstrap", "gui/\(uid)", plist])
        if run(launchctl, ["kickstart", "gui/\(uid)/\(label)"]) == 0 {
            log("relaunched by the login agent")
            return
        }
    }
    var clean = environment
    clean.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    if run("/usr/bin/open", [target], environment: clean) == 0 {
        log("relaunched with open")
    }
}

func healthy() -> Bool {
    guard let data = fileManager.contents(atPath: stateFile),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["phase"] as? String == "installed",
          let release = object["release"] as? [String: Any],
          release["version"] as? String == newVersion else { return false }
    return true
}

/// Stop the unresponsive new app through the job that started it — never by matching a process
/// pattern. Unloading Story's own login-agent job also stops KeepAlive from relaunching it, and
/// `relaunch()` bootstraps the restored app afterwards. The `open` path only asks the app to quit;
/// if it was started that way and does not respond, the rollback is reported, not forced.
/// Returns true when the agent job was stopped.
func stopNewApp() -> Bool {
    let plist = "\(home)/Library/LaunchAgents/\(label).plist"
    if fileManager.fileExists(atPath: plist) {
        _ = run(launchctl, ["bootout", "gui/\(getuid())/\(label)"])
        sleep(2)
        return true
    }
    if let plist = NSDictionary(contentsOfFile: target + "/Contents/Info.plist"),
       let bundleId = plist["CFBundleIdentifier"] as? String {
        _ = run("/usr/bin/osascript", ["-e", "tell application id \"\(bundleId)\" to quit"])
        sleep(5)
    }
    return false
}

// ── Refuse an incomplete hand-off (nothing has been touched yet) ────────────
guard target.hasSuffix(".app"), isDirectory(staged), !keepRoot.isEmpty, !newVersion.isEmpty else {
    exit(2)
}

log("update \(oldVersion) -> \(newVersion): waiting for pid \(parentPid) to quit")
var waited = 0
while waited < quitWaitSeconds {
    if !alive(parentPid) { break }
    sleep(1)
    waited += 1
}
if alive(parentPid) {
    writeResult("failed", "Story Studio did not quit, so nothing was replaced.")
    exit(1)
}

if !isDirectory(keepRoot) {
    do {
        try fileManager.createDirectory(atPath: keepRoot, withIntermediateDirectories: true)
    } catch {
        writeResult("failed", "Could not create \(keepRoot); nothing was replaced.")
        relaunch()
        exit(1)
    }
}

var keepPath = keepRoot + "/Story Studio KH.app-\(oldVersion)"
var failedPath = keepRoot + "/Story Studio KH.app-\(newVersion)-failed-\(timestamp())"
if let targetVolume = volumeNumber((target as NSString).deletingLastPathComponent),
   let keepVolume = volumeNumber(keepRoot),
   targetVolume != keepVolume {
    // A previous-apps folder on another volume would make every move here a multi-GB copy.
    let folder = (target as NSString).deletingLastPathComponent
    keepPath = folder + "/.Story Studio KH.app-\(oldVersion)-previous"
    failedPath = folder + "/.Story Studio KH.app-\(newVersion)-failed-\(timestamp())"
    log("previous-apps is on another volume; the previous app stays at \(keepPath)")
}
if fileManager.fileExists(atPath: keepPath) {
    keepPath += "-\(timestamp())"
}

do {
    try fileManager.moveItem(atPath: target, toPath: keepPath)
} catch {
    writeResult("failed", "Could not move the installed app aside (macOS may need App Management allowed for Story Studio KH); nothing was replaced.")
    relaunch()
    exit(1)
}
do {
    try fileManager.moveItem(atPath: staged, toPath: target)
} catch {
    try? fileManager.moveItem(atPath: keepPath, toPath: target)
    writeResult("failed", "Could not move the new app into place; the previous app is back.")
    relaunch()
    exit(1)
}
log("swapped; the previous app is kept at \(keepPath)")
relaunch()

waited = 0
while waited < healthSeconds {
    if healthy() {
        writeResult("installed", "\(newVersion) is running.")
        exit(0)
    }
    sleep(1)
    waited += 1
}

log("\(newVersion) never reported healthy; putting \(oldVersion) back")
let stoppedByAgent = stopNewApp()
var rolledBack = false
if stoppedByAgent {
    do {
        try fileManager.moveItem(atPath: target, toPath: failedPath)
        do {
            try fileManager.moveItem(atPath: keepPath, toPath: target)
            rolledBack = true
        } catch { /* the failed app is aside; report below */ }
    } catch { /* the failed app could not be moved; report below */ }
}

if rolledBack {
    writeResult("rolled_back", "\(newVersion) did not start within \(healthSeconds) seconds; \(oldVersion) is back.")
} else if !stoppedByAgent {
    writeResult("failed", "\(newVersion) did not start, and it was not started by the login agent, so it was left running; \(oldVersion) is at \(keepPath).")
} else {
    writeResult("failed", "\(newVersion) did not start and the previous app could not be put back; it is at \(keepPath).")
}
relaunch()
exit(0)
