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

A small connection-status banner sits in the bottom-right of every page showing the host, your username, a colored dot for round-trip latency, and a **Sign Out** button.

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
- **Rate limit on login**: 5 attempts / 60s per peer IP. Restart resets the counter.
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
