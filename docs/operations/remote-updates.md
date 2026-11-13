# Updates (Studio Launcher KH only)

Story Studio has **no updater** (owner rule, 2026-11-13, extended the same day). It does not check a
feed, does not contact the Gateway for releases, downloads nothing, verifies nothing, mounts and
unpacks nothing, and cannot replace its own bundle. **Studio Launcher KH is the only app that installs
a Story Studio update.**

What the app shows: Settings → About shows a version pill `Story Studio KH <version>` and one sentence
— *Updates are installed by Studio Launcher KH.* There is no Check Now, no install button, no
`auto_install` switch, no App Update Key or trust flow, and no update banner.

## What does remain

- **Quit drains Story's own work** (saved job state, tracked child processes) so a restart is safe.
- **Open at Login, and restart after a crash** (Settings → Performance & recovery) writes
  `~/Library/LaunchAgents/local.storystudio.kh.plist`: `RunAtLoad` starts Story at login and
  `KeepAlive { Crashed: true }` relaunches it only after a crash signal. A Quit (exit 0), a Force
  Quit or a macOS memory kill (SIGKILL) never brings it back. Turning it off moves the file to
  `_trash/launch-agent/`.
- **Leftovers from older builds** stay where they are: `app-update/state.json`,
  `previous-apps/`, `_trash/app/` and `_trash/app-update/` are listed by Storage and can be emptied
  by the owner. Nothing creates them again.

## How an update is installed

Publish the release where Studio Launcher KH reads its feed, then install/update Story from the
Launcher. The Launcher verifies and installs the artifact, quits Story if it is running, and relaunches
it; Story resumes its saved work on the next launch.
