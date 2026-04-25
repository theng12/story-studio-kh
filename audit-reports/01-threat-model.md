# Session 01 — Threat Model Baseline

**Product:** Story Studio KH v1.0.7 — Electron + Nuxt desktop app, sold as a paid public download.
**Status of this document:** Charter. Subsequent sessions (02–12) dig into each section. No fixes here, no enumerated CVEs — just the map.

---

## 1. Distribution & trust model

**Channels.** electron-builder produces three unsigned artifacts:

- macOS: `Story Studio KH ${version}-${arch}.dmg` (arm64 + x64, no `universal` target)
- Windows: `Story Studio KH Setup ${version}.exe` (NSIS)
- Linux: `Story Studio KH ${version}.AppImage`

**Code signing.** `electron-builder.json` has **no `mac.identity`, no `afterSign` notarization hook, no `win.certificateFile`, no `signingHashAlgorithms`**. Shipping today means:

- macOS DMG is unsigned and unnotarized → Gatekeeper will block it on first launch with "damaged / cannot be opened." Users will be trained to `xattr -d com.apple.quarantine` their way around Gatekeeper — a *terrible* habit for a paid app.
- Windows NSIS is unsigned → SmartScreen "Unknown publisher" prompt; AVs will flag it.
- Linux AppImage is unsigned and has no GPG manifest.

**Update channel.** None. No `electron-updater`, no `autoUpdater`, no `publish` block in electron-builder.json. Users on v1.0.7 will stay on v1.0.7 until they manually redownload. There is **no secure path to push a security patch**. Corollary: any RCE found post-ship is permanent for every user who doesn't check a website.

**Entitlement differences between paying and non-paying users.** Effectively none, enforced client-side.
- `license-manager.ts::validateKey()` accepts `/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i` **or any string ≥16 chars**. No server, no signature, no HMAC, no device binding.
- The only gate is `LicenseBanner.vue` which nags when `activated=false`. All backend routes (`/api/*`) serve every caller regardless of license state.
- A paying customer gets: the banner gone. That's it. "Share with friends" = "share the string `AAAA-BBBB-CCCC-DDDD`".

The developer's comment in `license-manager.ts:96-103` admits this is a stub pending LemonSqueezy/Gumroad wiring.

---

## 2. Assets at risk

All paths are on the user's local disk. The app has no server-side storage.

| Asset | Location | On-disk perms | Who can read |
|---|---|---|---|
| Provider API keys (Anthropic / OpenAI / kie.ai / FAL / GenAIPro / ElevenLabs / Google) | `<userData>/projects/<slug>/secrets.json` v2 shape | `0600` POSIX (N/A on Windows) | User + any process running as user |
| OAuth tokens (YouTube access+refresh; TikTok/FB not live) | Same `secrets.json`, keyed `upload.<platform>.<account_id>` | `0600` POSIX | Same |
| OAuth client credentials (`client_id` + `client_secret`, user-supplied per project) | Same `secrets.json`, key `upload_oauth_client.<platform>` | `0600` POSIX | Same |
| License key | `<userData>/app-settings.json` — written with plain `fs.writeFile`, **no mode set** → `0644` by default | World-readable | Any user on the box |
| Generated content (scripts, images, audio, video) | `<userData>/projects/<slug>/...` — hours of paid AI inference | Default perms | Same |
| Project metadata (config.json, manifest, idea DB) | Same | Default | Same |
| FFmpeg path override | `app-settings.json::ffmpeg_path` — **fed directly to `spawn()`** | Default | — |

`userData` by platform: macOS `~/Library/Application Support/Story Studio KH/`, Windows `%APPDATA%\Story Studio KH\`, Linux `~/.config/Story Studio KH/`.

The secrets store is explicitly *not* end-to-end encrypted — comment at `secrets-store.ts:26` concedes plaintext; keytar is named as a future swap. Disk encryption is the only thing between these keys and anyone who gets the machine, a backup, or a Time Machine snapshot.

---

## 3. Attacker profiles

### (A) Paying customer bypassing / sharing the license
Goals: one-license-many-installs; or feel clever. Nearest paths:
1. Paste any string ≥16 chars into the activation dialog — `validateKey` returns `{valid:true, plan:'pro'}`.
2. Edit `app-settings.json` directly: `{"license_key":"anything"}`. No integrity check.
3. Share the "working" key with a Discord — since there is no remote validation, no revocation is possible.

### (B) Non-paying attacker who got the binary
Goals: run without paying; repackage and resell. Nearest paths:
1. Same as A.1/A.2 — the "pirate" and "paying customer" paths are identical.
2. Patch `LicenseBanner.vue` in the unsigned .asar and redistribute (no signature to break).
3. Strip the banner entirely — asar is not encrypted, node_modules ship unminified, no anti-tamper.

### (C) Malicious website visited while app is running
Goals: exfiltrate API keys, drive paid inference, hijack YouTube upload. Nearest paths:
1. **CORS is wide open in production.** `app.ts:30-35` sets `origin: true, credentials: true` when *not* dev. In Electron this is production. Any origin the user visits can `fetch('http://127.0.0.1:<port>/api/...', {credentials:'include'})` and read every key-bearing endpoint. The attacker needs the port — port is random (`port: 0`) in prod, but it's enumerable (2–16k ports in < 1s on localhost).
2. **DNS rebinding to 127.0.0.1.** `server.listen(port, '127.0.0.1')` binds only loopback, but a page at attacker.com can rebind attacker.com → 127.0.0.1 after initial load; Host header will be `attacker.com`, which Express does not check. Combined with the port-scan, this reaches every `/api/projects/:slug/settings/*` route.
3. Deep-linking: no custom protocol is registered, so the `storystudio://` vector is not currently live — but nothing stops a future feature from adding one.

### (D) Malicious project file shared between users
Goals: code exec on victim's machine; key theft on import. Nearest paths:
1. Crafted `config.json` / `project.json` with a malicious `ffmpeg_path` — `app-settings.json::ffmpeg_path` is read and handed to `spawn()` at `ffmpeg-manager.ts:217`. If any import path writes `ffmpeg_path` from project data, it's arbitrary binary exec.
2. Path traversal in project slug / asset filenames → write outside `PROJECTS_ROOT`. All filesystem assembly uses `path.join(PROJECTS_ROOT, slug, ...)`; slug normalization in `project-manager.ts` needs its own audit.
3. Zip-slip on project import (`import-project.ts`) — unreviewed here, flagged for Session 04.

### (E) Compromised AI provider returning poisoned outputs
Goals: code exec via model output; data exfil via crafted links. Nearest paths:
1. Model returns HTML containing `<img src=x onerror=fetch(...)>` that's rendered unsanitized somewhere in the frontend. CSP status: not set in main.ts, not set in Nuxt config that I saw.
2. Model returns a `https://` URL in a script/idea field that the user clicks → `shell.openExternal(url)` fires. URL-scheme is gated to `^https?://` so no `file://`/`javascript:` — good. But the destination can still be a phishing page.
3. Model returns a crafted FFmpeg filter string that survives validation and becomes a shell-injection sink. `spawn()` with array args avoids shell; filter strings go as `-vf ...` argv. Risk is bounded but `ffmpeg-validation.ts` needs its own pass.

---

## 4. Trust boundaries

| Boundary | Direction | What crosses | Notes |
|---|---|---|---|
| Renderer ↔ Main process | both | **Nothing** — no preload, no `contextBridge`, no `ipcMain`/`ipcRenderer`. `webPreferences`: `nodeIntegration:false`, `contextIsolation:true`. | Good posture. Entire privileged surface is the Express API. |
| Renderer ↔ Localhost Express | HTTP | Every user action: JSON CRUD, file uploads, job queue, OAuth polling, secrets read/write, license activation | **This is the real privilege boundary.** CORS `origin:true,credentials:true` in prod is the single biggest structural issue (see §5). No auth tokens between renderer and server — it is trusted solely because "only loopback can talk to it," which is not actually true (see §3.C). |
| Localhost Express ↔ AI providers | HTTPS out | User's API keys in headers, prompts, generated content back | Providers seen: Anthropic, OpenAI, kie.ai, FAL, GenAIPro, ElevenLabs. TLS verification = Node defaults (on). No pinning. |
| App ↔ Disk | read/write | secrets.json, config.json, project.json, app-settings.json, logs, generated media | Atomic write via temp+rename in `atomic-store.ts`. Locks are **in-process only** — single-instance lock is what keeps them correct; if that lock ever fails, concurrent writers corrupt. app-settings.json is NOT written with `0600`. |
| App ↔ FFmpeg subprocess | spawn | argv is app-constructed; binary path read from app-settings.json | Array-form `spawn` → no shell. **But the binary path itself is configurable data read from JSON.** Anyone who can write `app-settings.json` gets arbitrary-binary exec on next video render. |
| App ↔ Upload platforms | OAuth + HTTPS | OAuth code exchange on random loopback port; then refresh/upload against `googleapis.com` | Loopback flow with state token (`youtube-oauth.ts`). Refresh tokens live in `secrets.json` indefinitely — no rotation, no expiry beyond Google's own. |
| App ↔ OS keychain | — | **Nothing.** No keytar. | All secrets are filesystem-only. |

---

## 5. Production blockers (ship-refusing, if true)

Ranked by "if this is true I veto the release."

1. **No code signing on any platform.** DMG/NSIS/AppImage unsigned → users will normalize disabling Gatekeeper/SmartScreen for this app. Compounds every other issue.
2. **No auto-update path.** When (not if) we ship an RCE, we cannot push a fix. Users will run the vulnerable build for the life of the product.
3. **License is a client-side string pattern.** `validateKey` accepts `"AAAA-BBBB-CCCC-DDDD"` or literally any 16+ char blob. Revenue model is theatre.
4. **Production CORS is `origin: true` with `credentials: true`.** Any site the user visits while the app is open can read and write `/api/projects/:slug/settings/api-keys` and exfiltrate every provider key. The port being random does not meaningfully mitigate — localhost port-scan is seconds.
5. **No Host header / DNS-rebinding check on the Express server.** Session 03 territory.
6. **`app-settings.json` written world-readable** (no mode arg), and contains `license_key` + `ffmpeg_path` — and `ffmpeg_path` feeds `spawn()`. Read + write by any process running as user. Low bar, high blast radius.
7. **Secrets on disk in plaintext.** `secrets.json` is 0600 on POSIX, with no Windows equivalent, and is backed up by Time Machine / iCloud / OneDrive by default. No keytar fallback.
8. **No CSP on the renderer.** If a provider output or imported project renders unsanitized HTML anywhere, it executes in an origin that can hit the full localhost API with `credentials:include`.
9. **No request-size limits** (`express.json()` / `express.text()` called with defaults → 100 KB text, but `express.json()` default is 100 KB — verify). No rate limiting on any endpoint. DoS / wallet-drain vectors open.
10. **FFmpeg binary is a universal2 lipo-fused artifact from two third-party websites** (`evermeet.cx`, `osxexperts.net`). Supply-chain trust of the ship-ready binary lives or dies by those two sites' integrity at build time. No checksum pinning visible in `fetch-ffmpeg.mjs` top (verify Session 08).

---

## 6. Open questions for the developer

- Is there a **remote license server planned** before GA, or is the LemonSqueezy/Gumroad hookup deferred indefinitely?
- Will updates be **served over HTTPS with signature verification** (electron-updater + GitHub Releases / S3 + code signing), or is the plan "users redownload"?
- Has **macOS notarization** been set up for the developer's Apple ID, or is it pending? Same for Windows EV cert.
- What is the intended **trust relationship with imported project zips** — is import for a user's own projects only, or is sharing projects across users a product feature?
- Is there a reason **`app-settings.json` is written without `mode: 0o600`** while `secrets.json` is? Oversight or intentional?
- Does `fetch-ffmpeg.mjs` **pin hashes** of the upstream binaries, or re-download-and-trust?
- Is **keytar / OS keychain** integration on the roadmap or explicitly out?
- Is the Express API assumed to be trusted because it's loopback? (If yes, we need to disabuse: see §3.C.)
- Are **TikTok and Facebook OAuth** going to land before GA? If so, they double the OAuth-client-secret attack surface.
- Does the frontend render any AI-provider output as HTML (`v-html`), or is it all text-bound? Affects §3.E.1 severity.

---

*End of Session 01. Next: Session 02 — deep-dive on distribution & update channel (blockers #1 and #2).*
