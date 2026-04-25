# Session 03 — License & Anti-Tamper

> **RESOLVED 2026-04-24 — no longer applicable.** The product was pivoted from
> commercial distribution to personal-use-only. The license system (manager,
> routes, banner UI, boot-token CSRF wrapper, stub validation) has been
> removed. Findings L1–L11 in this document describe code that no longer
> exists in the source tree. Left in place as a historical record of the
> v1.0.7 attack surface; do not treat as an open work list. File-path and
> line-number references in this report are dead links.
>
> Carried forward separately: §5.6 of Session 01 (app-settings.json world-
> readable) → fixed independently by tightening the file mode to 0o600 in
> `electron/server/services/app-settings.ts`.

**Scope:** licensing model, activation flow, bundle integrity, update channel, revocation. Companion to Session 01 §1, §5.3.
**One-line verdict:** **Trivially pirateable.** The "license check" is a regex with an OR-clause that accepts any 16+ char string. There is no remote validation, no device binding, no signature on the key, no signature on the app bundle, and no update channel. A pirate does not need to patch the binary — they do not even need to open a text editor. They type `AAAA-BBBB-CCCC-DDDD` into the activation dialog and the app says "thank you."

Ship this as a paid product and the revenue model is donationware in a trench coat.

---

## 1. License format — the exact validation algorithm

Source of truth: [license-manager.ts:104-119](electron/server/services/license-manager.ts:104).

```ts
export async function validateKey(key: string): Promise<{ valid: boolean; plan: string }> {
  if (!key || typeof key !== 'string') return { valid: false, plan: 'free' }

  const pattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i
  if (pattern.test(key.trim())) {
    return { valid: true, plan: 'pro' }
  }

  // Also accept longer keys (for future platform-specific formats)
  if (key.trim().length >= 16) {
    return { valid: true, plan: 'pro' }
  }

  return { valid: false, plan: 'free' }
}
```

Translation: **"if the input is truthy, a string, and at least 16 characters long, you are a Pro customer."** The regex in the first branch is a UX cosmetic — the second branch subsumes it (any 4-4-4-4 key is 19 chars including hyphens). There is:

- **No checksum.** `ABCD-1234-EFGH-5678` and `ZZZZ-9999-AAAA-0000` are both valid.
- **No HMAC/signature.** Nothing is signed by a private key the attacker can't forge.
- **No entropy check.** `0000-0000-0000-0000` is valid. `aaaaaaaaaaaaaaaa` is valid. A SHA-256 of `""` pasted as a string is valid (64 hex chars ≥ 16).
- **No server call.** The entire "validation" is local [license-manager.ts:96-103](electron/server/services/license-manager.ts:96) — the comment admits this is a stub pending LemonSqueezy wiring.
- **No device binding.** The key is not hashed with `os.hostname()`, a machine UUID, the user's email, or anything else machine-specific. The same key activates every install on Earth.
- **No expiry.** `activated_at` is written but never read for an expiry check.

The developer wrote a test ([license-manager.test.ts:42-45](electron/server/__tests__/license-manager.test.ts:42)) that explicitly asserts `'lemonsqueezy-license-key-12345'` — a placeholder literal — is valid, under the comment *"accepts long keys (>=16 chars) as future platform formats"*. The placeholder is a valid license.

After activation, the record written to `app-settings.json` is:

```json
{
  "license_key": "<raw key as entered>",
  "license_plan": "pro",
  "license_activated_at": "2026-04-24T12:34:56.789Z"
}
```

On subsequent boots, `getLicenseStatus()` re-runs `validateKey()` against the saved key ([license-manager.ts:123-138](electron/server/services/license-manager.ts:123)). Since validation is a length check, a file containing `{"license_key":"xxxxxxxxxxxxxxxx"}` boots activated.

---

## 2. Bypass paths — every way to unlock the app, ranked by effort

### 2.1 Type garbage into the activation dialog *(effort: 3 seconds)* — **Critical**

Path: Banner → *Activate* → type `AAAA-BBBB-CCCC-DDDD` → click *Activate*. Success toast. Banner gone. That's it. No skill, no tools, no understanding of Electron required. This is the baseline bypass — everything below is strictly more work for the same result, so a pirate never bothers with them.

### 2.2 Hand-edit `app-settings.json` *(effort: 10 seconds)* — **Critical**

File is written with `fs.writeFile(path, JSON, 'utf-8')` at [license-manager.ts:72-75](electron/server/services/license-manager.ts:72) — no `mode` option, so it lands at **0644 (world-readable, user-writable)** on POSIX. No integrity hash, no HMAC, not encrypted.

- macOS: `~/Library/Application Support/Story Studio KH/app-settings.json`
- Windows: `%APPDATA%\Story Studio KH\app-settings.json`
- Linux: `~/.config/Story Studio KH/app-settings.json`

```bash
echo '{"license_key":"xxxxxxxxxxxxxxxx","license_plan":"pro","license_activated_at":"2026-04-24T00:00:00Z"}' \
  > "~/Library/Application Support/Story Studio KH/app-settings.json"
```

Next launch: activated. This path doesn't even require opening the app once. Session 01 §5.6 already called the world-readable mode out as a separate finding; it compounds here because `license_key` and `ffmpeg_path` share this file, and any process running as the user can flip both.

### 2.3 Patch the JS bundle *(effort: 5 minutes)* — **High**

The app.asar in the DMG is unencrypted. `npx @electron/asar extract app.asar out/` dumps plaintext TS-compiled JS. Two candidate edits:

```js
// electron/dist/server/services/license-manager.js — one line
export async function validateKey() { return { valid: true, plan: 'pro' } }
```

or patch the banner component to never show. Repack with `npx @electron/asar pack out/ app.asar`.

**ElectronAsarIntegrity does exist** — Info.plist contains a SHA-256 of the asar ([dist/mac-arm64/Story Studio KH.app/Contents/Info.plist:33-45](dist/mac-arm64/Story%20Studio%20KH.app/Contents/Info.plist:33)). But it only enforces when the app is **validly code-signed by a Developer ID identity**. `codesign -dv` on the shipped build reports:

```
Signature=adhoc
TeamIdentifier=not set
CodeDirectory ... flags=0x10002(adhoc,runtime)
```

Ad-hoc signing is effectively no signing. An attacker patches the asar, recomputes the SHA-256, overwrites the `hash` string in Info.plist, re-runs `codesign --force --sign - …` to re-adhoc-sign, and distributes. No certificate revocation is possible because no certificate exists. On Windows and Linux, there is not even this theatre — no `win.certificateFile`, no AppImage GPG manifest (Session 01 §1, §5.1).

### 2.4 Block the network *(effort: 0 seconds)* — **N/A, because there is no network check to block**

There is no `fetch(...)` in `license-manager.ts`. There is no telemetry endpoint, no heartbeat, no phone-home. Blocking network traffic changes nothing about activation. (For a paid download, this absence is itself the finding — see §3.)

### 2.5 Replay another user's key *(effort: 0 seconds — the "key" is shared not replayed)* — **Critical**

Because there is no per-install device binding and no server ledger, the concept of "replay" doesn't apply — every install accepts the same string. Post a screenshot of `AAAA-BBBB-CCCC-DDDD` on Discord. Every recipient of the app can paste it. Since there is no server, there is no revocation, so that post stays valid for the life of the product (§8).

### 2.6 Time-jump the system clock *(effort: N/A)* — **No-op**

There is no time-based logic. `license_activated_at` is written, never read. No trial-expiry check, no "license expires YYYY-MM-DD" check. Clock manipulation is irrelevant because time is irrelevant.

### 2.7 Remotely activate via exposed API *(effort: 30 seconds, cross-site)* — **High**

This is not in the pirate's bypass path, but it's a novel license-surface finding: the license endpoints have **no authentication** and live on the same Express app that Session 01 §5.4 called out as CORS-open in production (`origin: true, credentials: true`). Route list from [settings.ts:17-43](electron/server/routes/settings.ts:17):

```
GET    /api/license       → reads masked key + plan
PUT    /api/license       → ACTIVATES with a string of your choice
DELETE /api/license       → deactivates
```

Any origin the user visits while the app is running can, after a 1–2 second loopback port scan, `fetch('http://127.0.0.1:<port>/api/license', {method:'PUT', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key:'xxxxxxxxxxxxxxxx'})})` and silently activate a forged license on the user's install. The user had already paid, but now they also have an attacker-chosen key in their settings and no indication of the swap. More destructively, the same origin can `DELETE /api/license` — a paid user's activation gets wiped by a drive-by. DNS-rebinding makes this exploitable even if we tighten `origin`. Session 04's follow-up should bring a CSRF token / same-origin check to the license routes specifically.

---

## 3. Remote validation

**There is none.** No `fetch(...)`, no `https.request(...)`, no socket work anywhere in `license-manager.ts` or its callers. The stub comment at [license-manager.ts:96-103](electron/server/services/license-manager.ts:96) names LemonSqueezy but no wiring exists.

For a paid public download, absence of a remote check is itself the top finding:

- **No activation ledger** → unlimited installs per key.
- **No revocation** (see §8) → a leaked key is leaked forever.
- **No device binding** → one key per family / office / torrent.
- **No usage telemetry** → no ability to detect abuse patterns.

The questions the brief asks only become meaningful once a remote call exists:

- HTTPS? — N/A, no request made.
- Cert pinning? — N/A.
- What happens offline? — App works. (Also what happens online. They are the same state.)
- Replay protection? — N/A: there is no nonce, no timestamp, no signed challenge.
- Rate limiting? — N/A; also, Session 01 §5.9 notes the local Express server has no rate limiting on any endpoint, so even a future `PUT /api/license` would be brute-forceable locally without adding middleware.

---

## 4. Trial / demo behavior

There is no explicit free-trial counter to reset — because the product already is its own trial. With no license, the banner is visible and *nothing else is restricted* (Session 01 §1: "A paying customer gets: the banner gone. That's it"). All `/api/*` routes serve every caller regardless of `activated`. Grep for `activated`, `license_plan`, or `pro` anywhere in the route handlers turns up nothing — there is no gate.

Corollary finding: **the "free mode" is indistinguishable from "paid mode" except for a 40-pixel banner**. Deleting `app-settings.json` resets nothing important because there is nothing to reset. Hiding the banner DOM node (`document.querySelector('.license-banner').remove()`) in DevTools produces the same effect as paying. DevTools is not even disabled — it's commented out at [main.ts:74](electron/main.ts:74) but the comment reads `// mainWindow.webContents.openDevTools()`, meaning shipping builds have `Cmd+Opt+I` working.

---

## 5. License entry UX

Source: [LicenseBanner.vue:27-33](frontend/components/LicenseBanner.vue:27).

- **Plaintext input.** `<input v-model="keyInput" class="input" placeholder="XXXX-XXXX-XXXX-XXXX">` — no `type="password"`, no visual masking. A screen-share, a shoulder-surfer, or OS-level screen-capture grabs the key as typed. For a product that claims to be gated by this string, this is low effort to fix (`type="password"` + a reveal eye icon).
- **Not logged on entry.** The request logger at [app.ts:40-50](electron/server/app.ts:40) records `method`, `path`, `status`, `durationMs` only — not the body. Good. The key is however written verbatim to `app-settings.json` on activation ([license-manager.ts:144-148](electron/server/services/license-manager.ts:144)) without any at-rest encryption; see §2.2.
- **No clipboard auto-fill.** Paste requires an explicit user action — no `navigator.clipboard.readText()` on mount. Good.
- **Displayed masked after activation.** `getLicenseStatus()` returns `maskKey(key)` = `XXXX-****-****-YYYY` ([license-manager.ts:169-172](electron/server/services/license-manager.ts:169)). But the raw value still sits in `app-settings.json` one directory away, world-readable.
- **`console.error` on network failure.** [LicenseBanner.vue:100-102](frontend/components/LicenseBanner.vue:100) swallows the error into `error.value`; the request payload is not dumped. OK.

---

## 6. Bundle integrity

- **`electron-builder.json` has no signing configuration.** No `mac.identity`, no `mac.notarize`, no `afterSign` hook, no `win.certificateFile`, no `win.signtoolOptions`, no AppImage signing. Session 01 §5.1 already files this as blocker #1. Restating here because it is the structural reason §2.3 is cheap: without a real Developer ID signature, ElectronAsarIntegrity is a speed bump, not a wall.
- **Shipped mac build is ad-hoc signed.** `codesign -dv` output (§2.3) shows `Signature=adhoc`, `TeamIdentifier=not set`. An attacker re-runs `codesign --force --sign - App.app` after patching and the signature is as valid as the original.
- **`asarUnpack` expands the tamper surface.** [electron-builder.json:15-19](electron-builder.json:15) unpacks `sharp`, `@img`, and every `.node`. These sit on disk as plain files outside the asar (so not covered by `ElectronAsarIntegrity` at all). Any native addon replacement in those paths is an arbitrary-code-exec foothold; combined with the world-writable userData dir, this is *already* game over from a non-license attacker's perspective.
- **No macOS notarization.** Beyond the signing issue, users will `xattr -d com.apple.quarantine` on first launch (Session 01 §1). That habit pipes directly into "yeah, cracked version from r/piracy, just `xattr` it" — the paid and cracked install ritual look identical to the user.

---

## 7. Update channel

**There is no autoUpdater.** `grep -i 'autoUpdater\|electron-updater' electron/main.ts` → no matches. No `publish` block in `electron-builder.json`. Nothing in `package.json` dependencies pulls `electron-updater`.

Consequences specific to licensing:

- **No server-initiated re-validation.** Even if we wanted to roll a future patch that adds a remote check, we can't push it — users on 1.0.7 stay on 1.0.7 (Session 01 §5.2).
- **No signed update feed to compromise, but also no signed update feed to use.** There is nothing for a DNS attacker to hijack because nothing fetches updates. This is simultaneously safer (no MITM vector) and worse (no fix path if a license bypass needs patching). Once an RCE or a "cracked v1.0.7" torrent is out, the legitimate product cannot migrate customers away from it.
- **If auto-update is added later**: must be over HTTPS with certificate pinning, staged via `electron-updater` against signed artifacts, and the signature must chain to the same Developer ID we sign the app with. Anything less loses the update feed to a DNS attacker who pushes a malicious "v1.0.8".

---

## 8. License revocation

**Not possible.** Revocation requires either (a) a server that is consulted on each boot/activation and can refuse a blacklisted key, or (b) a signed revocation list shipped via an auto-updater. The app has neither. Once `AAAA-BBBB-CCCC-DDDD` is known, every existing install that has it stays activated, and every new install that types it becomes activated. There is no lever to pull.

**This is load-bearing for the revenue model.** The first customer who posts their key online (malicious, careless, or compromised machine) permanently disables the gate for every future pirate. Since the gate is "any 16-char string," even that posting is not required — but the scenario illustrates the asymmetry: we can't undo a leak even in principle.

---

## 9. Summary of findings

| # | Finding | Severity | Effort to exploit | Bypass class |
|---|---|---|---|---|
| L1 | `validateKey()` accepts any string ≥16 chars; regex branch is cosmetic | **Critical** | 3 seconds | 2.1 |
| L2 | No remote validation, activation ledger, or device binding for a paid product | **Critical** | — (structural) | 2.5 |
| L3 | `app-settings.json` stores raw key at 0644, no integrity hash, direct-edit activates | **Critical** | 10 seconds | 2.2 |
| L4 | `PUT/DELETE /api/license` has no auth; exploitable via CORS/DNS-rebind from any web origin | **High** | 30 seconds cross-site | 2.7 |
| L5 | No code signing (mac adhoc-only, win/linux unsigned) → asar integrity is defeatable | **High** | 5 minutes | 2.3 |
| L6 | No revocation mechanism; once a key is public it stays valid forever | **High** | — (structural) | §8 |
| L7 | No auto-update channel → cannot push a license-fix patch post-ship | **High** | — (structural) | §7 |
| L8 | Activation input is `type="text"`, not masked; raw key visible during entry | Medium | — | §5 |
| L9 | Free/paid entitlements identical except for a 40px banner; no API-side gating | Medium | 0 seconds (DOM remove) | §4 |
| L10 | Raw license key written to disk in plaintext JSON; no OS-keychain option | Medium | — | §5 |
| L11 | Test suite asserts placeholder literal `'lemonsqueezy-license-key-12345'` is valid | Low (symptom of L1) | — | §1 |

Everything Critical collapses to the same root cause: there is no cryptographic validation anywhere on the license path.

---

## 10. The cheapest improvement that meaningfully raises the bar

We cannot reach "uncrackable" without code-signing + obfuscation + remote activation + a server, and shipping all four in one session is not realistic. The *cheapest* delta that moves the needle from "trivial" to "requires actual work" is:

**Wire `validateKey()` to a remote activation endpoint, with an offline grace period and a server-side instance ledger.** Concretely:

1. **Pick a vendor.** LemonSqueezy and Gumroad both have `POST /v1/licenses/activate` endpoints that return `{valid, instance_id}` and enforce per-license instance limits server-side. Zero infra on our side.
2. **First-boot activation** calls the vendor API with the key + a stable machine fingerprint (e.g., `crypto.createHash('sha256').update(os.hostname() + os.userInfo().username + <saltedMachineUUID>).digest('hex')`). Server refuses if the key is revoked, over the instance cap, or unknown. On success we cache `{signed_receipt, expires_at}` in `app-settings.json`.
3. **The cached receipt is an HMAC** — server signs `fingerprint + expires_at + plan` with a key only the vendor holds. Client verifies with the vendor's public key bundled in the asar. Now editing `app-settings.json` by hand no longer works: forged receipts fail signature check.
4. **Re-check every N days** (7–14 is typical). On failure, fall back to the cached receipt until `expires_at`. After `expires_at` the app goes read-only with a reactivate prompt. This preserves offline-friendliness (Session 01 ethos + OFFLINE.md) while giving the server a chance to kill revoked keys.
5. **Gate one actually-paid surface server-side in the client.** Right now the banner is the entire gate. Pick one expensive operation (e.g., video render, or unlimited-length generation) and require the signed receipt to unlock. This makes "strip the banner" a non-bypass because the feature that costs money is what checks the signature.
6. **Sign the bundle.** Apple Developer ID ($99/yr) + EV cert for Windows. Without this, §2.3 stays cheap no matter what §1–§5 look like — a patched adhoc-signed build re-packs in 5 minutes. This is Session 02 territory but license integrity is a dependency of it.
7. **Mask the license input** (`type="password"` + reveal icon). Zero-cost UX hygiene.
8. **Write `app-settings.json` with `mode: 0o600`** to match `secrets.json`. One-line change; see Session 01 §5.6.

Order of implementation by cost-per-bit-of-security-added:
- **Hours of work:** (7) input mask, (8) 0o600 mode.
- **A day of work:** (4) license-route CSRF / same-origin check.
- **A week of work:** (1)–(5) LemonSqueezy activation + HMAC receipts + at least one server-side-verified paid feature.
- **Dollars + a week:** (6) real code signing on both platforms.

None of this makes the app uncrackable. It makes casual piracy *inconvenient* and meaningful piracy *require reverse engineering*, which is the realistic ceiling for an Electron app that ships JavaScript to the user.

---

## 11. Recommendation to the developer

**Do not ship this as a paid product in its current state.** At minimum:
- Either land (1)–(3) above before GA, or
- Reposition the product as "pay what you want / donation-supported" and drop the license dialog entirely.

Shipping `validateKey(key.length >= 16)` as a $$$-priced download invites the first buyer who notices to post a 16-character string on Reddit. That is a brand-risk event, not just a revenue-loss event — the post becomes the product's top Google result.

---

*End of Session 03. Fix-tasks for L1–L3, L4, L5–L7 spawned as separate cowork sessions.*
