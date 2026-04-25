# Session 02 — Secrets: keys, tokens, license

**Scope:** every API key, OAuth token, OAuth client credential, and license key
the app can read or write. At-rest storage, in-memory handling, log/error
leakage, network exfil, backup/sync spillage, multi-account isolation,
disposal, and provider-error echo.

Files dug: `electron/server/lib/atomic-store.ts`,
`electron/server/services/secrets-store.ts`,
`electron/server/services/secrets-accounts.ts`,
`electron/server/services/upload-store.ts`,
`electron/server/services/license-manager.ts`,
`electron/server/services/logger.ts`,
`electron/server/services/ffmpeg-manager.ts`,
`electron/server/services/project-manager.ts`,
`electron/server/lib/youtube-oauth.ts`,
`electron/server/lib/youtube-client.ts`,
`electron/server/lib/image-edit-client.ts`,
`electron/server/lib/kie-client.ts` (and siblings),
`electron/server/routes/{settings,upload,image-edit,health,projects}.ts`,
`electron/server/providers/{text,image,audio,video}/*.ts`,
`electron/server/providers/registry.ts`,
`electron/main.ts`.

---

## TL;DR

The per-project `secrets.json` v2 store gets the *shape* right: 0600 perms on
POSIX, atomic write via temp+rename, in-process lock, masked-only responses to
the renderer, v1→v2 migration that upgrades on read. The two single-account
summary booleans (`has_*_key`) never carry values. Account-centric queries
through `listAccounts` / `resolveApiKey` go through a consistent mask-on-
response path. OAuth refresh tokens never round-trip to the renderer — the
status endpoint deliberately strips them (`upload.ts:267`).

The **rot** is everywhere else the secrets touch. The *other* secrets file
(`app-settings.json`, holding the license key and the `ffmpeg_path` that
feeds `spawn()`) is written world-readable and non-atomically. The Google
AI Studio image-edit client pastes the raw API key into the URL query string
that then flows into an `Error.message` and back to the renderer. The
logger's redaction allowlist is out of sync with the providers list and
omits `google_api_key`, `access_token`, `refresh_token`, and `client_secret`.
Every provider client wraps non-2xx responses by slicing the body into the
thrown message, which we then JSON-stringify into the 500 response body
served to the frontend — an infrastructure that depends on the upstream
never echoing the key.

Nine Critical/High findings below, each with a spawned fix-task.

---

## Findings

### C1 — `app-settings.json` written world-readable and non-atomically
**Severity: CRITICAL**
**Files:** [license-manager.ts:72-75](electron/server/services/license-manager.ts:72)

```ts
async function writeSettings(settings: AppSettings): Promise<void> {
  await fs.mkdir(path.dirname(APP_SETTINGS_PATH), { recursive: true })
  await fs.writeFile(APP_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n')
}
```

Two problems in eight lines:

1. **No `mode` argument.** On macOS + Linux the file lands at `0644` — every
   local user (every background daemon, every non-privileged process) can
   `cat` it. The file contains `license_key` + `license_activated_at` +
   `ffmpeg_path` + `ffprobe_path`. Contrast `secrets.json` which goes
   through `writeJsonAtomic(..., { mode: 0o600 })` plus a defensive
   post-rename `chmod`.
2. **Not atomic.** `fs.writeFile` truncates, then streams bytes. A crash
   between truncate and flush leaves a zero-byte `app-settings.json`,
   `readSettings` (line 62-70) swallows the parse error and returns `{}`,
   and the user loses their license key silently. Same path also loses
   `ffmpeg_path`, so the next render silently falls back to system `ffmpeg`
   (or fails outright).

The license key's secrecy is weaker than an API key's (it identifies a
paying customer; revoking requires a remote license server we don't have),
but it's still PII-adjacent and goes straight into Time Machine / iCloud
backups. And the `ffmpeg_path` being in this file is actively dangerous —
it's fed to `spawn()` in ffmpeg-manager.ts:217-style sites. Any process
that can write `app-settings.json` (which on Windows is any process in the
user's session) gets arbitrary-binary exec the next time the user renders.

**Cross-check vs `secrets.json`:** `writeJsonAtomic` in
[atomic-store.ts:51-68](electron/server/lib/atomic-store.ts:51) already
solves both problems correctly. `license-manager.ts` should route through
it with `mode: 0o600` instead of re-implementing the naive write.

→ **Fix task spawned: "Fix: harden app-settings.json writes"**

---

### C2 — Google API key embedded in URL, leaked via error messages + logs + renderer
**Severity: CRITICAL**
**Files:** [image-edit-client.ts:72](electron/server/lib/image-edit-client.ts:72),
[image-edit.ts:106-107](electron/server/routes/image-edit.ts:106)

```ts
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(input.apiKey)}`
// …
const res = await fetch(url, { method: 'POST', … })
if (!res.ok) {
  const text = await res.text().catch(() => '')
  throw new Error(`Gemini image edit failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`)
}
```

Then the route handler:

```ts
} catch (e: any) {
  console.warn('[image-edit] failed:', e?.message || e)
  res.status(500).json({ detail: e?.message || 'Image edit failed' })
}
```

The raw Google API key lives in the URL every request. Every way that URL
can surface, the key goes with it:

- **node-fetch / undici error messages.** When `fetch(url, …)` fails at
  the transport layer (DNS error, TLS hiccup, ECONNRESET, AbortError from
  timeout), the resulting `Error` includes the URL in its message / cause
  chain (node-fetch formats as `FetchError: request to <URL> failed…`).
  That `Error.message` then:
  - hits `console.warn('[image-edit] failed:', …)` → captured by Electron
    stdout → written to `main-YYYY-MM-DD.log` unredacted (see C3),
  - is returned to the renderer as `res.status(500).json({ detail })` —
    the key is now in the renderer's DevTools network panel and stays in
    any heap snapshot the user ever takes.
- **Provider-side 4xx bodies.** Google's API can include the failing URL
  or query-string parameters in error bodies during debug. `text.slice(0,
  400)` preserves up to 400 chars of that body and puts it in the thrown
  message via the same leak path.
- **Referer on redirects.** If Google ever serves a 3xx from this
  endpoint, the default redirect follow sends `Referer: <full URL with
  key>` to the redirect target.

**Comparison:** OpenAI's gpt-image-1 path 7 lines below uses the SDK which
puts the key in an `Authorization` header — same risk class as every
other provider in the codebase. Only the Gemini call uses query-string
auth. Google's docs explicitly allow server-to-server header auth via
`x-goog-api-key`; the URL form is the consumer-web pattern.

**Blast radius of the renderer exposure:** CORS is `origin: true,
credentials: true` in production (Session 01, §5.4). Any malicious site
the user visits while the app is open can trigger the
`POST /projects/:slug/edit-image` endpoint with bogus inputs, force the
500 path, and read the response JSON with `credentials: include`. It
gets back a Google API key without ever touching the secrets file.

→ **Fix task spawned: "Fix: move Gemini image-edit key to header auth + scrub URL from errors"**

---

### H3 — Log redaction allowlist is out of sync with the providers list
**Severity: HIGH**
**Files:** [logger.ts:79-83](electron/server/services/logger.ts:79)

```ts
// Inline redaction — we intentionally avoid importing secrets-store here so the
// logger has no dependency on the projects layer …
// Keep this list in sync with SECRET_KEYS in services/secrets-store.ts.
const SECRET_KEY_NAMES = new Set([
  'kie_api_key', 'fal_api_key', 'openai_api_key',
  'anthropic_api_key', 'genaipro_api_key', 'elevenlabs_api_key',
  'apiKey', 'api_key', 'authorization', 'Authorization',
])
```

The comment promises sync with `SECRET_KEYS` in `secrets-store.ts:57`.
That list is actually seven providers long; the logger is missing:

- `google_api_key` — a live accepted provider
  ([secrets-store.ts:40-48](electron/server/services/secrets-store.ts:40)).
  Any log line that includes a config object projected via
  `project-manager.ts:getConfig` (which eagerly merges *all* secrets
  into the returned shape) under a meta key will write the raw Google
  API key to `server-YYYY-MM-DD.log`.
- `refresh_token` / `access_token` — OAuth bundles stored under
  `upload.{platform}.{account_id}` in `secrets.json`
  ([upload-store.ts:88-103](electron/server/services/upload-store.ts:88)).
  If a diagnostic log ever stringifies a token bundle, the redaction
  misses both fields.
- `client_secret` — OAuth client credentials stored under
  `upload_oauth_client.{platform}`. Ditto.
- `license_key` — low-sensitivity but still PII; not in the list.

Bonus: log meta values *containing* a key as a substring (e.g. an error
message containing `Bearer sk-…`) get NO redaction — the allowlist is
field-name-only. A value-level regex pass for
`(sk-|sk_)[A-Za-z0-9]{20,}`, `Bearer [A-Za-z0-9-_\.]+`, and similar
patterns would catch the contents of error strings that slip through.

The inline copy that justifies avoiding the secrets-store import *is* a
reasonable design choice — but the list is then wrong. Either import and
accept the bootstrap-order pain, or generate the list at build time from
a shared constant.

→ **Fix task spawned: "Fix: complete logger secret redaction"**

---

### H4 — Provider client error paths echo full upstream response body
**Severity: HIGH**
**Files:** [kie-client.ts:52-55](electron/server/lib/kie-client.ts:52),
[kie-client.ts:173-176](electron/server/lib/kie-client.ts:173),
[kie-client.ts:237](electron/server/lib/kie-client.ts:237),
[kie-video-client.ts:77](electron/server/lib/kie-video-client.ts:77),
[fal-client.ts:142](electron/server/lib/fal-client.ts:142),
[genaipro-client.ts](electron/server/lib/genaipro-client.ts),
[youtube-client.ts:149](electron/server/lib/youtube-client.ts:149),
[youtube-client.ts:264](electron/server/lib/youtube-client.ts:264),
[youtube-client.ts:400](electron/server/lib/youtube-client.ts:400),
[image-edit-client.ts:94](electron/server/lib/image-edit-client.ts:94),
providers/{text,image,audio,video}/*.ts

Every provider client follows the same pattern:

```ts
if (!resp.ok) {
  const text = await resp.text().catch(() => '')
  throw new Error(`… failed (${resp.status}): ${text}`)
}
```

Some slice (`.slice(0, 200)` or `0, 400`), some don't
([kie-client.ts:52-55](electron/server/lib/kie-client.ts:52) slices
nothing — full body goes into `Error.message`). Two layers above, the
route handler does:

```ts
} catch (e: any) {
  res.status(500).json({ detail: e.message || '…' })
}
```

Result: whatever the upstream chose to put in the response body is now
in the HTTP response to the renderer. This is the sink for C2 and also
for any provider that echoes the failing credential. In normal
operation:

- Anthropic/OpenAI SDKs do *not* typically echo the key in 4xx bodies.
- Google's token endpoint (`youtube-oauth.ts:278-280`) returns
  `error: "invalid_grant"` with no echo.
- kie.ai, fal.ai, GenAIPro, ElevenLabs — *untested*. If any one of
  these services ever 4xx-echoes (e.g. "Invalid Bearer token
  sk-abc…"), the key flows straight to the renderer via this shape.

The safe pattern is to log the full body with redaction *server-side*
and return a sanitized message to the renderer. The error-handler
middleware in [app.ts:65-73](electron/server/app.ts:65) uses
`err.expose` to gate that — but every provider throws a plain `Error`,
which is **not** `expose`-tagged. The route handlers bypass the middleware
by catching and sending `e.message` themselves. So the middleware's
safe default is never exercised.

Secondary: kie-client.ts:237 embeds `JSON.stringify(taskData).slice(0,
500)` of the full task payload in the "succeeded but no URL" error.
kie's task payload includes headers of the original request in some
paths; needs a 2-minute sniff with a live account.

→ **Fix task spawned: "Fix: sanitize provider errors before returning to renderer"**

---

### H5 — `config.json` GET path merges raw API keys into an object that's handed to many routes
**Severity: HIGH**
**Files:** [project-manager.ts:438-485](electron/server/services/project-manager.ts:438)

```ts
export async function getConfig(slug: string): Promise<ProjectConfig | null> {
  // …
  const secrets = await readSecrets(slug)
  raw.kie_api_key = secrets.kie_api_key ?? ''
  raw.fal_api_key = secrets.fal_api_key ?? ''
  raw.openai_api_key = secrets.openai_api_key ?? ''
  raw.anthropic_api_key = secrets.anthropic_api_key ?? ''
  raw.genaipro_api_key = secrets.genaipro_api_key ?? ''
  raw.elevenlabs_api_key = secrets.elevenlabs_api_key ?? ''
  raw.google_api_key = secrets.google_api_key ?? ''
  return raw
}
```

`getConfig` is called from ~50 call sites (grep: 53 hits). Only
`getSafeConfig` — called by the `GET /settings/config` route —
redacts before responding. Every other caller receives a full config
object with all seven API keys inlined, and it's up to each route to
not accidentally dump it into a response.

Currently *no route* does that — routes read `config.X_api_key` into a
local, pass it to a provider client, and return just the result. But
the surface area is large: every new generator route is a line of code
away from `res.json({ ..., config })` and a silent key exfil to the
renderer. A structural fix is to **never return API keys from
`getConfig`**. Callers that need a key should go through
`resolveApiKeyForProvider` (registry.ts) which already exists.

Lower-risk remediation: rename the return field to `_DO_NOT_RETURN_*`
so a typo can't accidentally make it into a response shape. Higher-
risk but cleaner: remove the merge entirely and make every generator
resolve keys via the registry.

A related mini-bug: [project-manager.ts:548-550](electron/server/services/project-manager.ts:548)
omits `google_api_key` from the `SENSITIVE` set — the same drift as
H3. The `safe` object construction above it explicitly sets
`has_google_key`, so the filter is only hit when passing through
other config fields; but again, a new `google_api_key_foo` field
would flow through unredacted.

→ **Fix task spawned: "Fix: stop leaking raw keys through getConfig()"**

---

### H6 — OAuth refresh token round-trips via URL query string on revoke
**Severity: HIGH**
**Files:** [youtube-oauth.ts:300-316](electron/server/lib/youtube-oauth.ts:300)

```ts
export async function revokeToken(token: string): Promise<void> {
  if (!token) return
  try {
    const resp = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { … })
```

RFC 7009 expects the token in the POST body of the revoke endpoint;
Google's implementation accepts both, but the query-string form puts
the refresh_token into:

- any proxy/TLS-terminator access log between us and Google (none in
  normal desktop flow, but corporate MitM proxies exist),
- node-fetch's error chain if the revoke fetch throws (same class as
  C2),
- any Node http instrumentation that logs request URIs.

Because revoke is fire-and-forget (`revokeToken(tokens.refresh_token).catch(() => {})`
in [upload-store.ts:232](electron/server/services/upload-store.ts:232)),
an error would be silently swallowed — but in-memory logging or a
Node APM hook would still capture the URL.

Fix: switch to body-parameter auth per RFC 7009:

```ts
await fetch(GOOGLE_REVOKE_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ token }).toString(),
})
```

→ **Fix task spawned: "Fix: move OAuth revoke token to POST body"**

---

### H7 — License key echoed verbatim to renderer when activation fails
**Severity: HIGH**
**Files:** [license-manager.ts:151-156](electron/server/services/license-manager.ts:151)

```ts
return {
  key: valid ? maskKey(key) : key,     // ← unmasked on invalid
  activated: valid,
  plan: valid ? plan : 'free',
  activated_at: valid ? new Date().toISOString() : undefined,
}
```

When the user pastes an invalid key, the server returns the **raw**
key string back to the renderer. That's a rotten shape because:

- `LicenseBanner.vue` (or any activation component) now stores the
  failed key in reactive state; it ends up in devtools, possibly in
  a Vue devtools snapshot.
- The route handler wraps this in `res.json(status)` — it hits any
  inspecting browser tooling including a browser-extension
  intercepting traffic.

The `validateKey()` stub currently accepts "any string ≥ 16 chars," so
the *invalid* branch mostly fires on short inputs — low value. But
when the LemonSqueezy wiring lands (comment in `license-manager.ts:96`),
legitimately-valid-looking-but-wrong keys will start hitting this
branch, and at that point echoing a paying-but-typo'd key back
unmasked is a minor leak.

Fix: always mask (or return empty string) on invalid.

→ **Fix task spawned: "Fix: stop echoing unmasked license key on invalid activation"**

---

### H8 — Main-process crash logger writes raw error stacks unredacted
**Severity: HIGH**
**Files:** [main.ts:190-204](electron/main.ts:190), [main.ts:206-216](electron/main.ts:206)

```ts
function logCrash(source: string, err: unknown) {
  const message = err instanceof Error ? (err.stack || err.message) : String(err)
  console.error(`[main:${source}]`, message)
  // …
  const line = JSON.stringify({ ts, level: 'error', source, message }) + '\n'
  fs.appendFileSync(path.join(logsDir, `main-YYYY-MM-DD.log`), line)
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
  if (electronApp.isReady()) {
    dialog.showErrorBox('…', 'An unexpected error occurred. …\n\n' + String(err?.message || err))
  }
})
```

Two leak sinks:

1. **Log file.** The `logCrash` path does *no* redaction — unlike the
   structured `logLine` in `logger.ts`. A provider-client throw that
   percolates up unhandled (e.g. C2's URL-with-key, H4's upstream body
   echo, H3's token-bearing error) writes its full `Error.stack` into
   `main-YYYY-MM-DD.log`.
2. **Dialog.** `dialog.showErrorBox(…, err.message)` literally displays
   the error message to the user. If an admin user is screen-sharing or
   a support engineer asks "what's the dialog say?", the key ends up in
   Zoom chat / screenshots / support tickets.

Fix: pipe `logCrash` through the same redaction as `logLine`, and in
the dialog show a generic "Something went wrong — see Help → Show Logs"
rather than echoing the stack.

→ **Fix task spawned: "Fix: redact crash logs and dialog messages"**

---

### H9 — `secrets.json` has no on-disk permission on Windows
**Severity: HIGH** (Windows-only)
**Files:** [atomic-store.ts:51-68](electron/server/lib/atomic-store.ts:51)

```ts
await fs.writeFile(tmp, body, opts.mode !== undefined ? { mode: opts.mode } : undefined)
// …
if (opts.mode !== undefined) {
  await fs.chmod(filePath, opts.mode).catch(() => {})
}
```

`fs.chmod` and the mode flag map to POSIX-only behaviour. On Windows
the file inherits the parent directory's ACL, which for
`%APPDATA%\Roaming\Story Studio KH\` is typically "this user + admins"
— so it's *not* world-readable in the POSIX sense, but **any process
running as this user can read it** (same as POSIX 0600). The leakage
difference vs macOS/Linux is that on Windows there's no easy mental
model for "this file is locked down" — backup utilities, cloud sync
(OneDrive, Dropbox running as user agents), and browser extensions
launched by the shell all get it.

Mitigation options:
- Use keytar / `DPAPI` (Windows Data Protection API) for Windows —
  encrypts the file blob using the current user's login token, so
  other sessions can't read it even if they file-steal.
- At minimum, call `SetFileSecurity` via `ffi-napi` or just document
  the exposure.

The same file on macOS is protected by `0600`; on Linux, same. This
is Windows-specific hardening debt.

→ **Fix task spawned: "Fix: encrypt secrets.json on Windows via DPAPI/keytar"**

---

### M10 — `deactivateLicense()` mutates object then rewrites non-atomically
**Severity: MEDIUM**
**Files:** [license-manager.ts:159-165](electron/server/services/license-manager.ts:159)

```ts
export async function deactivateLicense(): Promise<void> {
  const settings = await readSettings()
  delete settings.license_key
  delete settings.license_plan
  delete settings.license_activated_at
  await writeSettings(settings)
}
```

Covered by C1's atomic-write fix. Noting here because the call shape
— read, mutate, write, no lock — is identical to the projects-side
`updateConfig` pattern which correctly uses `withLock`. A second
browser tab hitting DELETE /license in parallel with a PUT /license
can lose the activation event.

### M11 — `secrets.json` old-default deletion on PUT leaves value in the atomic swap temp file
**Severity: MEDIUM**
**Files:** [atomic-store.ts:54-61](electron/server/lib/atomic-store.ts:54)

The atomic-write flow writes the full new JSON to `{filePath}.pid.ts.rand.tmp`,
then renames. When a key rotation happens, the temp file briefly contains
*the new* JSON (without the old key) but the rename is atomic. That's
correct. However, if `fs.rename` fails (mid-rename disk-full, filesystem
error), the `catch` block calls `fs.unlink(tmp).catch(() => {})` — on
success the temp file is gone. In the failure path, a leftover
`secrets.json.12345.1234567.abc.tmp` sits on disk, still 0600 — but its
name pattern is predictable and a forensic sweep would find both the
old and the new version. Low impact (user's own machine), noted for
completeness.

### M12 — Session upload handler prefers query string over body on default-account lookups
**Severity: MEDIUM**
**Files:** [upload.ts:43-46](electron/server/routes/upload.ts:43) and similar

```ts
const accountId = typeof req.query.account_id === 'string' && req.query.account_id
  ? req.query.account_id
  : await store.getDefaultAccountId(slug, 'youtube')
```

Not a secrets-leak per se, but: `account_id` travels in plaintext URL
query strings. On a machine with a shared HTTP proxy (rare for
desktop) or a browser extension that logs `performance.getEntries()`
for all fetches, the account_id is enumerable. Moving to body
parameters would harden this. Low impact since account_id is a UUID
with no secret payload.

### L13 — kie-client pollForImageUrls embeds taskId unencoded
**Severity: LOW**
**Files:** [kie-client.ts:165](electron/server/lib/kie-client.ts:165)

`?taskId=${taskId}` without `encodeURIComponent`. No secret in
`taskId` but inconsistent with the same file's
`fetchImageUrlsByTaskId` which does encode.

### L14 — License key survives in backup/sync regardless of file mode
**Severity: LOW** (blocker in Session 10 on backup/sync)

On macOS, `~/Library/Application Support/Story Studio KH/app-settings.json`
is included in Time Machine backups (Library/ is not excluded), and the
license key is plaintext. Any hypothetical user with multiple Macs who
ever restored a Time Machine backup to a new machine has their license
embedded in every full backup snapshot since. Not secrets-specific;
flagged here because C1's fix will make it 0600 but won't cover backups.

### L15 — `[accounts]` log line uses raw console.log
**Severity: LOW**
**Files:** [registry.ts:152-172](electron/server/providers/registry.ts:152)

```ts
console.log(`[accounts] resolved providerId=${providerId} accountId=${resolved.accountId} label=${resolved.label} …`)
```

No secret leaks (only account IDs + labels), but bypasses the
redaction path. If a user names an account "apikey sk-abc123" out of
laziness, that label is now logged as structured data that *skips*
H3's (even broken) redaction. Route through `logLine`.

---

## What works (credit where due)

- `writeJsonAtomic` + `withLock` + `mode: 0o600` is correctly applied
  to `secrets.json`. Rename is atomic on POSIX + NTFS same-volume.
  Post-rename `chmod` defensively re-applies the mode.
- v1→v2 migration runs on read, preserves the old key, writes the
  upgraded shape without blocking the caller on failure.
- `redactSecrets` handles nested `apiKey` fields + legacy flat keys +
  cycles (`WeakSet` guard).
- Masked-only account summaries; raw `apiKey` never leaves
  `secrets-accounts.ts`.
- OAuth success path explicitly strips tokens from the status
  response ([upload.ts:267-277](electron/server/routes/upload.ts:267)).
- Renderer exposure of `oauth-client` GET response is masked
  ([upload.ts:185](electron/server/routes/upload.ts:185)).
- No telemetry, no analytics, no crash reporter. Every outbound
  `fetch` targets a known provider host. (Verified via
  `grep 'fetch\(' electron/server/**/*.ts`.)
- FFmpeg subprocess never sees secrets — neither via argv nor env.
  Confirmed by greps across `ffmpeg-*.ts` and generators/video.ts.
- Manifest-sync (portable folder) deliberately omits secrets —
  confirmed by inspecting `PRESET_KEYS` in `manifest.ts` and by the
  fact that `writeManifest` uses `sync-safe.ts::writeAtomic` not
  `writeSecretsV2`.

---

## Open questions for the developer

- Is there any plan to migrate `app-settings.json` to use the same
  hardened-write path as `secrets.json`? (C1 would be a one-line fix.)
- Was the Gemini URL-key auth an oversight, or a workaround for
  something? (C2 is header-swap only.)
- Is a keytar / DPAPI roadmap slot concrete, or deferred indefinitely
  past GA? (H9.)
- Are production crash logs ever going to leave the user's machine
  (support bundle flow)? That changes H3 / H8 severity upward.
- `console.log` vs `logLine` — is there an established convention in
  this codebase for which to use, or is the current mix accidental?

---

*End of Session 02. Next: Session 03 — the Express loopback surface
(CORS + DNS-rebinding + Host validation + rate limiting). That session
inherits every key in this report as its attacker target.*
