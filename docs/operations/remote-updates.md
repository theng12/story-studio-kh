# Remote updates (Story Studio from the Gateway)

From the first build that carries the updater, Story Studio updates itself from the Gateway the
way Studio Hub does. The owner publishes a DMG on the Gateway; every Story Mac picks it up within
about 30 minutes, verifies it, waits for its queue to drain, installs, restarts, and resumes.
No walk to the Mac mini, no `xattr`.

Code: `electron/server/services/app-update.ts` (updater, swap helper, login agent),
`electron/server/routes/app-update.ts` (Settings routes and wiring), Gateway
`gateway/story_releases.py` and Fleet → **Story Studio**.

## How one update runs

1. **Publish** (Gateway → Fleet → Story Studio → *Publish a Story Studio Release…*): choose
   `dist/Story Studio KH <version>-arm64.dmg` (or a .zip of the .app). The Gateway reads the
   version from the app's own Info.plist, copies the file into its data folder and signs a
   descriptor (version, build, file name, size, sha256) with the **same App Update Key as Studio Hub
   releases**. The replaced artifact goes to the Gateway's Trash Folder.
2. **Check-in** (at startup, every 30 minutes, and *Check Now* in Settings → About → Updates): Story posts
   its version, machine name, channel count, queue and update phase to `/v1/apps/story/checkin`
   with the Gateway API Key it already uses, and gets the signed release back.
3. **Verify**: the App Update Key is pinned the first time this Mac sees one; after that a different
   key is refused until the owner presses *Trust the New App Update Key*. The signature, then the
   download's size and sha256, must match.
4. **Stage**: the .app is copied out of the DMG (read-only mount) into
   `~/Library/Application Support/Story Studio KH/app-update/staging/<version>/app/`.
   `com.apple.quarantine` is stripped defensively (a file Story writes itself is not quarantined;
   the dry run confirmed the downloaded DMG carried none), the bundle must report the signed
   version, and `codesign --verify --deep --strict` must pass — or, for today's unsealed builds
   (`identity: null`), the main program must still carry its ad-hoc signature.
5. **Drain** (same policy as `scripts/release/install-local.sh`): the queue is paused (a
   queue-origin pause; jobs paused by hand stay paused, and a queue the owner had already paused
   is left alone and never resumed by the updater). Running jobs finish or stop at their safe
   point, up to 30 minutes, then the install goes ahead. Pressing **Resume** during the drain
   cancels it: the update then waits for *Install Now*.
   - *When to install → Only when no jobs are running* waits for an idle queue instead.
   - *Install updates automatically* off: the banner says the update is ready and waits for
     *Install Now*.
6. **Swap**: Story quits normally; a detached helper (`app-update/swap-app.sh`) moves the installed
   app to `…/Story Studio KH/_trash/app/Story Studio KH.app-<old version>` (never deleted), moves
   the new one into `/Applications`, and relaunches (through the login agent when it is installed).
7. **Health**: the new version answers its own `/api/health` and writes `installed`; it then
   resumes the queue it paused. If it has not done so within 5 minutes, the helper moves it to
   `_trash/app/…-failed-<time>`, puts the previous app back, relaunches it, and that release
   (by its signature) is not installed again automatically (*Install Now* or *Update Now* still
   can; a re-publish has a new signature and is tried).

**Failures are remembered by release signature, never by build** (the Hub's by-build memory never
retried until relaunch). A download that is not fully available yet (404, a short or mismatched
file, a dropped connection or a stalled transfer — the Gateway serves the file whole, without Range) records nothing:
the next check downloads again from zero. Download headers and body have a 30-second inactivity
ceiling and a 15-minute total ceiling; aborted partials move into runtime `_trash/app-update/`
when the next attempt stages its folder. Any other install failure is tried again automatically
after about two checks (an hour); a re-publish is tried at once.

Server Mode is unchanged by any of this: it is a saved setting, so a relaunched Story comes back
as a server exactly as before.

## Open at Login, and restart after a crash

Settings → About → Updates → *Open at Login, and restart after a crash* writes
`~/Library/LaunchAgents/local.storystudio.kh.plist`: `RunAtLoad` starts Story at login and
`KeepAlive { Crashed: true }` relaunches it only after a crash signal. A Quit (exit 0), a Force
Quit or a macOS memory kill (SIGKILL) never brings it back. Turning it off moves the file to
`_trash/launch-agent/`. The agent supervises the copy it started (at login, or after an update);
a copy opened by hand from Finder is not supervised until the next login.

## The last walk to the mini (one time)

1. Quit Story Studio on the mini (let running jobs finish, or accept its question).
2. Install the first build that contains the updater, the old way, one last time: open the DMG,
   drag *Story Studio KH* to Applications (replace), then
   `xattr -dr com.apple.quarantine "/Applications/Story Studio KH.app"`.
3. Open it. Confirm the Gateway still shows *Gateway connected* (same address and key as before).
4. Settings → About → **Updates**:
   - turn on **Open at Login, and restart after a crash**;
   - leave **Install updates automatically** on and pick **When to install**;
   - press **Check Now**. It should say *Up to date* and show a *App Update Key*. Its first
     16 characters should match the fingerprint in Gateway → Settings → App Update Key (`/admin/api/release/identity`). If they differ, stop and tell the coordinator.
5. macOS, once: System Settings → Privacy & Security → **App Management** → add/allow
   *Story Studio KH*. Recent macOS can stop one app replacing an app bundle in /Applications; if it
   does, the first update fails cleanly with "Could not move the installed app aside… App
   Management", nothing is replaced, and the app relaunches.
6. Optional, for power cuts: System Settings → Users & Groups → automatic login for the mini's
   user, so the login agent starts Story after a reboot.

From then on: publish on the Gateway, and the Fleet → Story Studio tab shows each Mac go
*Update available → Updating… → Up to date*. *Update Now* on a row makes that Mac start on its next
check-in, whatever its install window. New Gateways include an optional `update_request_id`; Story
reports `update.request_id` as null until a verified attempt starts, then remembers the ID across
failure, rollback and restart. The ID is saved together with `downloading` (or bound to an already
verified staged attempt), so a stale failure report cannot consume a fresh manual command. Older
Gateways remain compatible.

## Where to look on a Story Mac

`~/Library/Application Support/Story Studio KH/`:
- `app-update/state.json` — phase, release, error, whether the updater paused the queue
- `app-update/helper.log`, `app-update/helper-result.json` — what the swap helper did
- `_trash/app/` — every replaced app, by version; `_trash/app-update/` — old downloads.
  Nothing here is ever deleted by Story; empty it by hand when the disk needs the room
  (each version is roughly one DMG plus one app).

Manual rollback: quit Story, move `/Applications/Story Studio KH.app` aside, move the wanted
version from `_trash/app/` back to `/Applications/Story Studio KH.app`, open it.
