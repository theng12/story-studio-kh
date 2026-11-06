# Server Mode — running Story Studio KH on a headless Mac mini

This guide walks through turning a spare Mac mini into a Story Studio KH render box you can drive from any other machine's web browser. Comparable in spirit to qBittorrent's WebUI: same app, same features, accessed over HTTP.

> **Personal-use only.** This mode binds the API on a network-accessible interface and gates it with a single shared username + password. It assumes you're behind Tailscale (or similar VPN). **Do not** expose the port to the public internet without putting TLS in front (Caddy / nginx).

---

## Architecture (1-minute version)

- **Default mode** (every install you've used until now): Express binds `127.0.0.1:<random>`, only the bundled Electron renderer can reach it.
- **Server mode**: Express binds `0.0.0.0:8765` (configurable), every request to `/api/*` requires a session cookie minted by `/api/auth/login`. The static frontend is served from the same port — open `http://mac-mini:8765/` from anywhere on your tailnet, sign in, use the app normally.

The local Electron window on the mini still works (loopback bypasses auth), so you can walk up to the mini and use it without logging in.

---

## One-time setup on the Mac mini

### 1. Install the app

Copy the latest `.dmg` over (AirDrop, USB stick, or download via browser on the mini), drag-install to `/Applications`, and launch once. macOS Gatekeeper will block ad-hoc-signed builds — strip the quarantine attribute:

```bash
xattr -cr "/Applications/Story Studio KH.app"
```

Right-click → Open → Open should also work.

### 2. Set credentials and enable server mode

Launch the app on the Mac mini directly (with display attached, just for setup). Open **Settings → App Settings** (the gear icon in the sidebar) → expand **Server Mode (advanced — headless web UI)**.

Configure:
- **Enable on next launch** — leave OFF for now; we'll enable after credentials are set.
- **Port** — `8765` is the default; pick something else if it collides.
- **Bind interface** — `0.0.0.0` (all interfaces). Use `127.0.0.1` to disable remote access while keeping the toggle on.
- **Username + Password** — set a username and a password ≥8 chars, click **Set Password**. The app generates a session secret automatically.

Now flip **Enable on next launch** to ON. Quit the app.

> **Alternative bootstrap (for power users)**: instead of the GUI, you can edit `~/Library/Application Support/Story Studio KH/app-settings.json` directly. The `server_mode` block schema is documented in `electron/server/services/app-settings.ts`. Or, set `STORY_STUDIO_INITIAL_USERNAME` + `STORY_STUDIO_INITIAL_PASSWORD` env vars; the first launch with those vars set will persist the credentials and ignore the env vars on subsequent boots.

### 3. Configure the Mac mini for headless operation

```bash
# Never sleep when plugged in
sudo pmset -c sleep 0

# Wake on network access (for Tailscale-triggered traffic)
sudo pmset -a womp 1
```

Then in **System Settings → Users & Groups → Login Options**, set the mini to auto-login as your user account. (No display attached = no login screen to type into.)

After this you can disconnect the display, mouse, and keyboard. The mini boots, auto-logs-in, and is ready.

### 4. Run the app under launchd (so it starts at boot and respawns on crash)

Create `~/Library/LaunchAgents/com.storystudio.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.storystudio.server</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Story Studio KH.app/Contents/MacOS/Story Studio KH</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>STORY_STUDIO_SERVER_MODE</key>
        <string>1</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>/tmp/story-studio-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/story-studio-server.err</string>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.storystudio.server.plist
```

The app should now be running. Verify:

```bash
curl http://127.0.0.1:8765/api/health
# → {"status":"ok","version":"0.1.0","boot_complete":true}
```

### 5. Note the Tailscale hostname

```bash
tailscale status
```

Find the line for the Mac mini and note its hostname (typically something like `mac-mini.your-tailnet.ts.net`). MagicDNS makes this resolvable from any other tailnet member.

---

## Daily use from another machine

From your iMac (or any tailnet member), open in a browser:

```
http://mac-mini.your-tailnet.ts.net:8765/
```

You'll see the login page. Enter the credentials you set above. The full Story Studio UI loads. Use it as you would normally — generate scripts, render audio, assemble video, etc.

Bookmark the URL.

On channel pages, the left sidebar groups the Gateway connection status, the host and your username, and a small **Sign Out** button. The connection block stays in the sidebar so it cannot cover page actions.

### Mirror your folder layout on both Macs (recommended)

The folder picker inside the web UI walks the **server's** filesystem (the Mac mini), not your laptop's. If the mini has projects at `/Users/macmini/Projects/StoryStudio/Foo` but your laptop has them at `/Users/laptop/Projects/StoryStudio/Foo`, the picker on the laptop will show the mini's paths — which won't match anything if you later open the same project on the laptop in desktop mode.

The simple workaround: **keep an identical folder layout on both Macs.** For most users that means:

- `~/Projects/StoryStudio/` as the root on both machines
- Either iCloud Drive sync or `rsync`/`Syncthing`/`Dropbox` between the two
- The Mac mini's launchd-managed app writes to its local copy; your laptop sees the same files seconds later

Story Studio uses a portable-path layer (`${PROJECT}/00 Assets/foo.png`) for asset references INSIDE a project — those work cross-machine without configuration. The mirror-folder advice is only for the initial **project root**.

If you absolutely can't mirror layouts (different usernames on the two Macs, separate drive structures, etc.), the picker on the laptop will still show the mini's paths and you'll need to remember to navigate to "where the mini keeps its files" rather than "where my laptop would keep them." Workable but slightly awkward.

### Diagnostic from anywhere

Open **Settings → Server Mode** on the connected browser. The **Server Status** card shows what bind+port the mini is listening on, current uptime, whether credentials are configured, the session TTL, and the platform / Node version. Useful for confirming the daemon is alive and answering before troubleshooting connectivity issues elsewhere.

### Automation keys (an AI agent on another Mac)

An agent drives the server with its own key instead of your password.

1. **Create the key.** **Settings → Server Mode → Automation keys**, type a label (e.g. `Claude on Mac Studio`), click **Create Key**. The key (`ssk_…`) is shown **once**; copy it before closing the box. Up to 5 keys.
2. **Put it on the agent's Mac yourself** — never paste it into a chat with the agent:

   ```bash
   mkdir -p ~/Library/Application\ Support/story-studio-kh-agent
   pbpaste > ~/Library/Application\ Support/story-studio-kh-agent/key
   chmod 600 ~/Library/Application\ Support/story-studio-kh-agent/key
   ```

3. **The agent reads the file per call:**

   ```bash
   KEY_FILE="$HOME/Library/Application Support/story-studio-kh-agent/key"
   curl -H "Authorization: Bearer $(cat "$KEY_FILE")" http://mac-mini:8765/api/auth/me
   # → {"username":"…","mode":"server","via":"automation_key","key_label":"Claude on Mac Studio"}
   curl -H "Authorization: Bearer $(cat "$KEY_FILE")" http://mac-mini:8765/api/projects
   ```

   `X-Story-Key: <key>` works too. `/api/health` needs no key; `/api/auth/me` is the one to check that the key works.

How it behaves:
- A key can do what your signed-in browser does with your projects, but it **can't change sign-in settings**: password, Server Mode on/off, port and bind, the sign-in limit, **Sign Out Everywhere**, and creating or revoking keys all answer 403. Only your password session manages keys.
- **Revoke** in the same list takes effect on the next request. **Sign Out Everywhere** and **Change Password** do not revoke keys. `npm run reset-server-auth` (the emergency reset) removes every key and writes a `reset` line to the audit file.
- A wrong, malformed or revoked key gets 401 and counts toward the same per-computer limit as password sign-ins; over the limit the answer is 429 for a minute, even for a valid key.
- Keys work only in server mode. In desktop mode the header is ignored.
- Only a SHA-256 of the key is stored (`server_mode.automation_keys` in `app-settings.json`); a 256-bit random key needs no slow hash. Logs show the label and the last four characters only.
- **Last used** updates at most every 10 minutes. `server-mode-key-audit.jsonl` beside `app-settings.json` gets one line per create/revoke and, per key in use, at most one line per 10 minutes with the number of calls since the previous line.

---

## Walking up to the mini directly

If you ever plug a display + keyboard back into the mini, the local Electron window auto-launches (via launchd) and you can use it without signing in — the loopback bypass kicks in. **The launchd-managed process is still running**, so opening the .app from /Applications by double-click will silently no-op (single-instance lock). Use the existing window.

To stop the daemon for maintenance:

```bash
launchctl unload ~/Library/LaunchAgents/com.storystudio.server.plist
```

To start it again:

```bash
launchctl load ~/Library/LaunchAgents/com.storystudio.server.plist
```

---

## Troubleshooting

**The browser shows "Connection refused".**
- Is the daemon running? `ps aux | grep "Story Studio"`. If not, check `/tmp/story-studio-server.err`.
- Is Tailscale up on the mini? `tailscale status`. The mini needs to be online for MagicDNS to resolve.
- Is the firewall blocking? Test from the mini itself first: `curl http://127.0.0.1:8765/api/health`.

**Login keeps rejecting the password.**
- Sit at the mini, open the local app, **Settings → Server Mode**, click **Change Password**. The session secret rotates automatically — every existing browser session is invalidated; sign in fresh.

**"Reveal in Finder" buttons don't work over the web.**
- Expected. They'd open Finder on the Mac mini, which you can't see from the iMac. The toast message confirms this. Use Finder via Screen Sharing if you need to actually see folders on the mini.

**Asset import / folder pickers look different.**
- In server mode, native macOS dialogs are replaced with an in-app file browser modal. You're browsing the Mac mini's filesystem from your browser — the picker shows what the mini sees, not what your iMac sees.

**The Mac mini went to sleep.**
- Re-run the `pmset` commands from setup step 3.
- After macOS updates, login items / launch agents sometimes get reset. Re-run `launchctl load …` and verify the auto-login setting.

**I want to disable server mode.**

Three ways, in order of convenience:

1. **From the web UI (easiest)** — open **App Settings → Server Mode (advanced)**, click **Disable Server Mode & Switch to Desktop**. The app persists `enabled: false` and restarts. Even if launchd respawns it with `STORY_STUDIO_SERVER_MODE=1` set, the app sees the explicit JSON disable and runs as a normal desktop window. You'll lose remote access on restart — that's the point. To re-enable, sit at the mini.
2. **From the local app on the mini** — same panel, same toggle, but no auth gate.
3. **From a shell on the mini** — `launchctl unload ~/Library/LaunchAgents/com.storystudio.server.plist` to stop the daemon, then optionally remove the plist. The next manual launch from /Applications runs as desktop (provided JSON `enabled` is false too).

**Precedence note**: JSON `server_mode.enabled: false` always wins over `STORY_STUDIO_SERVER_MODE=1`. Env var only forces ON when JSON is silent on the question. So toggling off from the web UI is enough — you don't have to touch launchd unless you want to stop the daemon entirely.

---

## Security notes

- **No HTTPS.** Tailscale carries WireGuard-encrypted bytes, so traffic between machines is private. The HTTP layer at the app is plain text. **Never expose port 8765 to the public internet without putting TLS in front.**
- **Single shared credential.** This is a personal-use design — one username + password. There's no multi-user support.
- **Cookie is HttpOnly + SameSite=Lax**, but **not** marked `Secure` (would refuse to set over plain HTTP). XSS on the SPA can't read the cookie via `document.cookie`; the SPA itself is the same trust boundary as the user.
- **Rate limit on login**: 30 attempts / 60s per peer IP by default (Settings → Server Mode → sign-in tries per minute). Failed automation-key attempts count toward the same limit. Restart resets the counter.
- **Automation keys** can use everything except sign-in settings (see above). Treat the key file like a password; revoke a key you no longer use.
- **Session TTL**: 7 days by default. Click **Sign Out Everywhere** in Settings to rotate the session secret and invalidate every active browser session immediately.

---

## What works in server mode vs default mode

| Feature | Default (Electron) | Server mode (web UI) |
|---|---|---|
| Generate scripts / images / audio / video | ✓ | ✓ |
| Edit project settings | ✓ | ✓ |
| Folder / file pickers | Native macOS dialog | In-app modal browsing the mini's filesystem |
| Asset import (bulk add files) | Native multi-select | In-app modal multi-select on the mini |
| "Reveal in Finder" buttons | Opens Finder | Toast: "not available over web" |
| iCloud-synced project folders | ✓ | ✓ (mini needs iCloud signed in) |
| Notifications | macOS notification on the mini | Telegram works; desktop notifications fire on the mini (no one sees them) |
| Updating the app | Drag-replace in /Applications | Same — update on the mini |

---

## File reference

- `electron/server/lib/server-mode.ts` — toggle + config reader
- `electron/server/lib/auth-session.ts` — scrypt + signed cookie + `requireSession`
- `electron/server/routes/auth.ts` — login / logout / me
- `electron/server/services/app-settings.ts` — credential setters, env-var bootstrap
- `electron/main.ts` — bind interface branching, meta-tag injection
- `electron/server/app.ts` — middleware mount order
- `frontend/pages/login.vue` — login form
- `frontend/composables/useServerMode.ts` — frontend state
- `frontend/composables/usePathPicker.ts` — native-vs-modal picker dispatch
- `frontend/components/FileBrowserModal.vue` — server-side file browser
- `frontend/components/ServerModeBanner.vue` — connection banner + sign-out
- `frontend/components/ServerModeSettingsPanel.vue` — Settings UI panel
