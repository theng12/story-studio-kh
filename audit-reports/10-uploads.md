# Session 10 — Upload Integrations (YouTube, TikTok, Facebook)

**Scope:** the wrong-channel hazard from the Session 04 threat model — "a token minted on machine A somehow gets used on machine B and I upload to the wrong channel" — and everything that sits between it and a completed upload: OAuth client storage, OAuth handshake, token refresh, resumable upload retry, metadata sanitization, idempotency, quota accounting, revoke, error surfacing. Files audited: [electron/server/routes/upload.ts](electron/server/routes/upload.ts), [electron/server/services/upload-store.ts](electron/server/services/upload-store.ts), [electron/server/services/secrets-store.ts](electron/server/services/secrets-store.ts), [electron/server/lib/youtube-oauth.ts](electron/server/lib/youtube-oauth.ts), [electron/server/lib/youtube-client.ts](electron/server/lib/youtube-client.ts), [electron/server/lib/upload-metadata.ts](electron/server/lib/upload-metadata.ts), [electron/server/services/upload-quota.ts](electron/server/services/upload-quota.ts), [electron/server/generators/youtube-upload.ts](electron/server/generators/youtube-upload.ts), [frontend/pages/projects/[slug]/upload.vue](frontend/pages/projects/[slug]/upload.vue), [frontend/pages/index.vue](frontend/pages/index.vue) (wizard connect).

**One-line verdict:** **wrong-channel isolation is ruled out — tokens are structurally machine-local, encrypted, and provenance-stamped. The remaining findings sit in the ops-ergonomics layer: a sharp account-swap footgun, a silent quota miscount, no reactive 401 handling, and a PKCE gap on the OAuth flow.** TikTok and Facebook are stubs (`enabled: false` in the platform catalogue at [upload.ts:164-165](electron/server/routes/upload.ts:164)) and have no live code to audit. One High finding, four Medium, three Low / informational.

---

## Part A — The headline hazard: token isolation across machines

### Ruled out ✓ — tokens are machine-local by storage location

Per the brief, the #1 correctness hazard is "token from machine A used on machine B → upload to wrong channel." Three layers of defense, all in place:

1. **Storage location is userData, not output folder.** Tokens live at `<userData>/projects/<slug>/secrets.json` — resolved by [project-manager.ts:62-75](electron/server/services/project-manager.ts:62) via `app.getPath('userData')` (macOS: `~/Library/Application Support/Story Studio KH/projects/...`). The *output folder* that the user transfers between machines (`project.json::output_root`, typically under `~/Downloads/...`) is a *separate* tree and contains no secrets — verified by grepping `access_token|refresh_token` across `electron/server/` (only three hits, all in the three expected files, none touching `project.json` or `output_root`). A project folder copy between machines carries renders, not tokens.

2. **Import flow writes an empty secrets.json.** [import-project.ts:346-389](electron/server/services/import-project.ts:346) seeds a fresh `<userData>/projects/<slug>/secrets.json` from scratch, so API keys *and* OAuth tokens "intentionally do not travel" (per the file's own docstring at :20-22).

3. **Machine-provenance stamp on every write.** [secrets-store.ts:56-62](electron/server/services/secrets-store.ts:56) hashes `${username}|${userData}` into every secrets file. [classifyProvenance at :215-220](electron/server/services/secrets-store.ts:215) refuses to load a file whose stamp doesn't match, returning an empty store and surfacing a "foreign provenance" banner via `getSecretsProvenanceStatus`. So even if a user *manually* `cp -r`s `<userData>/projects/<slug>/` between machines (bypassing Import), the transferred OAuth tokens are inert on the target machine — the foreign stamp causes `readSecretsFile` to short-circuit at :233-239 and the app behaves as if the tokens don't exist.

Plus: the file is encrypted via Electron `safeStorage` ([secrets-store.ts:260-278](electron/server/services/secrets-store.ts:260)) using the login keychain — a Time Machine restore onto a different Apple ID can't decrypt it either. Keychain-decryption failure is treated as "empty store" at :250-257, not a crash.

**On-disk verification** (macOS, 2026-04-25): both real projects show `secrets.json` at `-rw-------` (0o600), and the first 400 bytes are the expected `__encrypted: true` envelope. Provenance stamp, encryption, and mode all landed.

**Net:** the brief's most-feared scenario cannot occur without both (a) the user manually copying a project's userData folder (not the output folder), *and* (b) the two machines sharing a Keychain-derived key — which requires an unusual shared iCloud Keychain setup. Under the default personal-multi-machine deployment described in Session 04, tokens are structurally machine-bound.

The Session 04 label "per-project" is technically accurate (tokens are keyed under `upload.<platform>.<account_id>` inside `secrets.json`) but misleading for this audit — the **file itself** lives in userData, which makes it machine-local, and the provenance stamp + empty-on-import seal that.

### Not ruled out ⚠ — the account-swap footgun inside a single project

See finding H1 below.

---

## Part B — OAuth flow correctness

### 1. Loopback flow shape is correct

[youtube-oauth.ts:100-177](electron/server/lib/youtube-oauth.ts:100):
- Loopback server on a random port via `server.listen(0, '127.0.0.1')` → correct for Google's installed-app guidance (preferred over OOB or custom schemes).
- `state` token (32 hex chars, `randomBytes(16)`) validated at [:212-217](electron/server/lib/youtube-oauth.ts:212) — CSRF-protected.
- `access_type=offline` + `prompt=consent` — ensures a refresh_token is always returned (Google suppresses it on silent re-consent otherwise, and the exchange code at [:282-284](electron/server/lib/youtube-oauth.ts:282) hard-errors with actionable copy if missing).
- User-cancel path (Google redirects with `?error=...`): caught at [:203-211](electron/server/lib/youtube-oauth.ts:203), shows a safe HTML page, rejects the pending promise.
- Network failure mid-exchange: `exchangeCodeForTokens` throws → caught by the outer handler at :247-256 → finishFlow writes an error page + rejects.
- 5-minute server-side timeout at :146-151 — enough for phone-based 2FA, bounded so a dangling process gets GC'd.
- Finished-state TTL is 5 min (`FINISHED_TTL_MS` at :86) so the frontend has time to poll the terminal state.

### 2. No PKCE — **Medium finding (M1)**

Google's installed-app guidance *recommends* PKCE (RFC 7636) as of 2022 but does not require it — plain loopback with `client_secret` is still accepted. The auth URL built at [youtube-oauth.ts:125-137](electron/server/lib/youtube-oauth.ts:125) omits `code_challenge` / `code_challenge_method`; the exchange at :265-271 passes `client_secret` only. Under this deployment (one operator, no redistributed client secret), the concrete attack — intercepting the authorization *code* before it's exchanged — requires someone local to the machine with enough privilege to sniff loopback traffic, at which point they've already got the refresh token on disk anyway. Severity is Medium on Google-security-hygiene grounds (future Google enforcement), not on a realistic threat.

→ **No fix-task spawned** — low leverage for a personal deployment. Flag if Google deprecates loopback-without-PKCE.

### 3. Channel-identity confirmation — surfaced but soft

The brief asks: does the app display "Connected to <Channel Name>" so the user confirms it's the right channel? Three surfaces:

- **Browser callback page** ([youtube-oauth.ts:241-244](electron/server/lib/youtube-oauth.ts:241)) renders `Connected to <strong>{channel_title}</strong>. You can close this window...` — the user sees the name once, right after consent.
- **In-app account card** ([upload.vue:146-164](frontend/pages/projects/[slug]/upload.vue:146)) shows thumbnail + `remote_title` + `remote_id` + `custom_url` + connected-at timestamp.
- **Wizard** ([index.vue:1192](frontend/pages/index.vue:1192)) shows `success(`Connected ${y.channelTitle || 'YouTube channel'}`)` in a toast, then the wizard card echoes thumbnail + title.

**Gap** (Low): the per-project Connect flow's success toast at [upload.vue:1799](frontend/pages/projects/[slug]/upload.vue:1799) is the generic string `'YouTube connected — account added below.'` — no channel title echoed in the toast itself. The user has to look at the card below. For a user with multiple Google accounts signed in who glanced past the browser page, the toast is a wasted confirmation opportunity.

→ See L1 below.

---

## Part C — Upload lifecycle & correctness

### 4. Account-swap reuses id and silently invalidates sidecars — **High finding (H1)**

[upload-store.ts:178-204](electron/server/services/upload-store.ts:178) implements single-account-per-platform. When the user reconnects with a *different* Google account (different `remote_id`), the code:

```ts
const matchByRemote = existing.find(a => a.remote_id === partial.remote_id)
let id: string
if (matchByRemote) {
  id = matchByRemote.id
} else if (existing[0]) {
  // Re-use the existing account's id so sidecars/playlists keep working.
  id = existing[0].id
  try { await deleteTokens(slug, platform, id) } catch {}
} else {
  id = `acc_${randomUUID()}`
}
```

The intent (comment at :183-187) is "keep sidecars wired to SOMEthing." The effect is the opposite: every historical upload-sidecar for this project records `account_id` + `channel_id` — and the `channel_id` field encodes the channel the video was uploaded to. Post-swap, the `account_id` string now resolves to the *new* channel's tokens. If the user later clicks **Update metadata** on an old episode (say `TN0001`, originally uploaded to channel A), the upload executor at [youtube-upload.ts:118-127](electron/server/generators/youtube-upload.ts:118) reads `account_id` from params (or from the sidecar chain), calls `updateVideoMetadata` against the *new* channel B's tokens, and sends a PATCH to a `videoId` that doesn't exist on channel B.

**Outcome today:** YouTube returns a 404-ish error ("Video not found" or similar) and the user sees an opaque `Metadata update failed (404): ...`. Damage contained — no cross-channel write — but the user has no breadcrumb linking "I reconnected last week to a different Google account" to "today's update is failing." Worse: the `channel_id` mismatch between sidecar and current account isn't surfaced anywhere, even though it's the exact fingerprint that would tell the UI "your sidecars belong to a channel you're no longer connected to, use **Reset** first."

**Why High and not Critical:** YouTube's 404 stops real damage before any write lands on the wrong channel. If YouTube ever returned a *friendlier* 200 for an unknown-but-authenticated videoId (they won't, but), it would be Critical.

**Fix shape:**
- When `remote_id` differs from the existing account's `remote_id`, mint a **fresh** `acc_` id. The old sidecars still point at the old id; re-upload via the old id would fail with the friendlier "No tokens for this account — reconnect YouTube" at [youtube-client.ts:73](electron/server/lib/youtube-client.ts:73), which is a much better signpost than YouTube's 404.
- In parallel: in [generateYoutubeUpload](electron/server/generators/youtube-upload.ts:50), assert that `existing.channel_id === account.remote_id` on the update path. If they disagree, throw `"Sidecar recorded channel X but account is now connected to channel Y — click Reset to clear the sidecar and upload fresh to the new channel."` That's the actionable breadcrumb.

→ **Fix-task spawned: "Fix: mint fresh account id on channel swap + assert sidecar channel matches"** (see below).

### 5. Silent quota ledger update — **Medium finding (M2)** (lifted from Session 04 §6)

[youtube-client.ts:154](electron/server/lib/youtube-client.ts:154), :402, :434, :481, :514, :552 — every successful YouTube call writes its quota cost with `.catch(() => {})`:

```ts
await recordQuotaUsage(args.slug, 'videos_insert').catch(() => {})
```

Swallowed failures include config.json write failures (disk full, concurrent lock contention, permissions drift). When that happens the local quota ledger never ticks, the UI banner keeps saying "0 / 10,000", and the user can blow past YouTube's server-side limit without any local warning. The user then gets a cryptic 403 from YouTube on the 7th upload with no local preview of *why*.

This is the exact class of bug Session 04 §6.2 flagged as "worst for solo ops." Not Critical here because YouTube's own 403 is authoritative (no cross-channel damage, just wasted time), but the local preview is the whole point of the quota ledger — silencing it defeats the feature.

**Fix shape:** surface a Log entry at WARN via `log.warn('[upload-quota] ledger write failed', e)`. Optionally write a `quota_ledger_stale: true` flag to the snapshot so the UI can show "⚠ Quota count may be stale — check Google Cloud Console."

→ **Fix-task spawned: "Fix: surface quota-ledger write failures instead of swallowing"**.

### 6. No reactive 401 handling / single-retry on refresh — **Medium finding (M3)**

[getValidAccessToken at youtube-client.ts:71-92](electron/server/lib/youtube-client.ts:71) refreshes **proactively** (60 s before `expires_at`) and that's it. If Google's `expires_at` clock and our local clock disagree, or if the grant is invalidated mid-session (user revokes from myaccount.google.com while an upload is running), the next call returns 401 with no recovery — the error bubbles as "Metadata update failed (401): ..." or "Upload init failed (401): ..." and the user has to click Reconnect manually.

The resumable *chunked PUTs* don't carry Authorization (Google's protocol embeds auth in the session URL), so mid-stream token expiry doesn't affect them. But `uploadVideo`'s init step, `updateVideoMetadata`, `setThumbnail`, `listPlaylists`, `createPlaylist`, `addVideoToPlaylist`, and `listRecentUploads` all use `Bearer ${accessToken}` and none handle a 401 by refreshing once and retrying. Straightforward "retry once on 401" pattern would catch the clock-skew and mid-session-revoke cases.

**Fix shape:** wrap every `fetch` that uses `accessToken` in a helper that detects 401, re-calls `getValidAccessToken` forcing a refresh, and retries exactly once. Don't loop.

→ **Fix-task spawned: "Fix: retry once on 401 by forcing token refresh"**.

### 7. Resumable upload retry within a session is solid

[uploadChunkedWithRetry at youtube-client.ts:196-313](electron/server/lib/youtube-client.ts:196) implements the full Google resumable-upload protocol:

- 10 MB chunks (multiple of 256 KB, Google's requirement).
- Up to 5 retries per chunk on 5xx / 408 / 429 / network error with exponential backoff (500 ms → 8 s + jitter).
- After retries exhausted, queries the session with `Content-Range: bytes */{total}` to discover the server's true high-water mark, resumes from there — handles the "chunk landed partially before connection dropped" case.
- 308 Resume-Incomplete is honored via the server's `Range` header rather than our own byte count — trust the server.
- Cancellation via `AbortSignal` plumbed from the generator; onProgress polls `isCancelled` and aborts.

**Limitation** (Medium): the resumable-session URL lives only in `uploadChunkedWithRetry`'s local scope. If the app restarts mid-upload, the session URL is lost, and the next Upload click costs a fresh 1600 quota units + a fresh full-file upload. Google keeps resumable sessions valid for ~1 week, so in principle the session URL *could* be persisted to the sidecar and resumed on restart. Not catastrophic — personal use, infrequent app restarts — but on an hour-long 5 GB file, "fresh full-file re-upload" is ~30 minutes of redone work and 1600 wasted quota units (16% of the daily budget on the default).

→ See M4 below.

### 8. Resumable session URL not persisted across restarts — **Medium finding (M4)**

Described above. Fix shape: on successful init (line 155), write `{ resumable_session_url, expires_at: now + 6.5 days }` to a transient sidecar. On upload job start, check for an unexpired transient sidecar for this episode → if present, skip init + replay from wherever Google has us. On success, clear the transient sidecar.

→ **Fix-task spawned: "Fix: persist resumable upload session URL for restart-safe resume"**.

### 9. Metadata validation is thorough

[upload-metadata.ts:140-236](electron/server/lib/upload-metadata.ts:140) `snippetFromMeta` enforces every YouTube hard-limit:

- Title: strip control chars + `<` / `>` (YouTube silently drops angle brackets in titles), strip URLs (prompt-injection heuristic — an LLM-generated title with `http://evil/` loses the URL), cap 100 chars with ellipsis.
- Description: strip control chars (except `\t` and `\n`), cap 5000 chars.
- Tags: per-tag cap 30 chars, total-length budget 500 chars, max 15 tags, dedupe case-insensitively, `cleanTags` accounts for YouTube's ~2-4 char per-tag overhead.
- Category defaulted to `22` (People & Blogs) — safe default.
- `publishAt` + `privacyStatus` invariant enforced at [youtube-client.ts:119,371](electron/server/lib/youtube-client.ts:119) — YouTube rejects `publishAt` with any non-private privacy, so the code silently coerces to `private` rather than letting the caller 400. A user passing `{ privacyStatus: 'public', publishAt: ... }` gets the video uploaded successfully as scheduled-private.

**"Could the AI produce something the platform rejects after upload is complete?"** — no path I can see. Every user- and LLM-generated field funnels through `snippetFromMeta` before hitting the wire; the sanitizer is the last line of defense and it's exhaustive. An over-length title produces a truncated-with-ellipsis value that YouTube accepts, not a rejected payload.

### 10. Privacy default — correct for operator workflow

[upload.ts:461](electron/server/routes/upload.ts:461): `const privacy_status = typeof req.body?.privacy_status === 'string' ? req.body.privacy_status : 'private'`.
[upload.vue:1729](frontend/pages/projects/[slug]/upload.vue:1729): UI hardcodes `privacy_status: 'private'` on every Upload click.
[youtube-upload.ts:99](electron/server/generators/youtube-upload.ts:99): `const privacy: PrivacyStatus = params.privacy_status || 'private'` — default private even if caller omits.

Can't go live-by-accident. Good.

### 11. Idempotency — double-click protected at both layers

**Backend** ([upload.ts:449-451](electron/server/routes/upload.ts:449)): `jq.isDuplicate(slug, episode_id, 'youtube_upload')` pre-check → 409 if a job with same `(project, episode, type)` is queued or running. The enqueue call at [job-queue.ts:506-508](electron/server/services/job-queue.ts:506) re-checks atomically inside `enqueue` (its own comment at :502-505 is explicit: "Callers MUST NOT gate on isDuplicate() separately — two routes racing the check could both pass and both enqueue. This is the single serialisation point for queue insertion.").

**Frontend** ([upload.vue:373](frontend/pages/projects/[slug]/upload.vue:373)): `:disabled="uploadingRow === item.id || ..."` — the button disables for the row under upload. `uploadingRow` is set synchronously before the network call in `doUpload`.

Clicking twice rapidly: either the second click sees the disabled button, or the second request reaches the backend and gets a 409. No double-upload path.

### 12. Error surfacing is honest

[friendlyQuotaErrorMessage at upload-quota.ts:187-200](electron/server/services/upload-quota.ts:187) parses Google's 403 JSON and rewrites `reason: 'quotaExceeded' | 'dailyLimitExceeded'` into actionable copy with a link to Google Cloud Console. [youtube-client.ts:148-149,264,399-400,428-429,465-466,511-512,549-550](electron/server/lib/youtube-client.ts:148) threads this through every call: the raw 403 body gets truncated to 400 chars and echoed so the user sees the actual YouTube error reason, not a generic "upload failed."

For content ID claims / copyright strikes / processing-rejected-later: those don't show up as upload-time 4xx — YouTube accepts the video and the claim arrives via a separate channel (email, Studio inbox). Not this app's layer to surface; no finding.

### 13. Token revocation UX — correct

[upload-store.ts:224-233](electron/server/services/upload-store.ts:224): when the user disconnects, the refresh_token is captured *before* local wipe, then `revokeToken` POSTs to `GOOGLE_REVOKE_URL` [youtube-oauth.ts:300-316](electron/server/lib/youtube-oauth.ts:300) using `URLSearchParams` body (per Session 04 triage, the old query-string version was fixed). Fire-and-forget — failure only leaves Story Studio in the user's authorized-apps list on Google, local wipe still happens. `POST` without query string is correct — doesn't leak the token to any intervening log.

Server-side revocation actually hits Google, not just local wipe. Matches the brief's ask.

### 14. Quota handling on exhaustion — stops cleanly

[upload.ts:470-480](electron/server/routes/upload.ts:470) pre-checks quota *before* enqueueing. If `QuotaExceededError` fires, the route returns 429 with `{ detail, quota: snapshot }` and the UI [upload.vue:373-376](frontend/pages/projects/[slug]/upload.vue:373) disables Upload buttons when `quota.used >= quota.block_at`. Block threshold is 90% of ceiling [upload-quota.ts:62](electron/server/services/upload-quota.ts:62), so the last-few-uploads cushion prevents a tight race with the server-side quota.

On mid-batch exhaustion: each batched job still runs through its own `checkQuota` via `uploadVideo` at [youtube-client.ts:107](electron/server/lib/youtube-client.ts:107), so post-exhaustion jobs fail with the actionable message ("Resets at 2026-04-26T07:00:00Z (Pacific midnight). Request a quota increase at console.cloud.google.com...") rather than blasting wasted 1600-unit attempts against YouTube. A mid-batch block does *not* halt the queue, though — the remaining jobs each hit `QuotaExceededError` and are marked errored. Cheap in terms of wasted bytes (no resumable session is created), loud in terms of job list. Fine for the personal workflow.

### 15. TikTok + Facebook are stubs

[upload.ts:162-166](electron/server/routes/upload.ts:162) returns `enabled: false` for both with a `coming_soon` string. The OAuth start endpoint at [:231-233](electron/server/routes/upload.ts:231) hard-rejects `platform !== 'youtube'` with `"${platform} upload is not enabled yet."`. No live code paths — nothing to audit. Out of scope for this session.

---

## Summary of findings

| # | Severity | Finding | Fix-task |
|---|---|---|---|
| H1 | **High** | Account-swap reuses existing `account_id` when `remote_id` differs — stale sidecars now authenticate against the new channel. YouTube's 404 contains the damage, but there is no in-app breadcrumb from "you swapped channels" to "update failures on old episodes." | Spawned |
| M1 | Medium | No PKCE on the OAuth auth URL. Informational under personal deployment. | Not spawned |
| M2 | Medium | Quota-ledger writes wrapped in `.catch(() => {})` at six call sites — a failed write silently desyncs the UI counter from reality. (Lifted from Session 04 §6.) | Spawned |
| M3 | Medium | No reactive 401 handling — clock skew or mid-session grant invalidation surfaces as an opaque error instead of a refresh-and-retry. | Spawned |
| M4 | Medium | Resumable-session URL is not persisted; an app restart mid-upload costs a fresh 1600 quota units and a full re-upload. | Spawned |
| L1 | Low | Per-project Connect success toast doesn't echo the channel title; user relies on the browser callback page and the card below. | Not spawned |
| L2 | Low | Account-swap has no user-facing "this will invalidate previous uploads' sidecars" warning. Partially closed by H1 fix. | Not spawned |
| L3 | Low | 5-min OAuth timeout is hardcoded; no extension mechanism for slow 2FA. | Not spawned |

---

## What was verified and ruled out

- **Token per-app vs per-project** — tokens live in `<userData>/projects/<slug>/secrets.json` (machine-local by location). Not per-project in the sense of "travels with the project folder" — the file is in userData, not in the output_root that users transfer. ✓
- **iCloud sync risk** — `secrets.json` is in `~/Library/Application Support`, which is not synced by iCloud Drive. Not under a user-chosen path that could be inside `~/Documents` or similar. ✓
- **File mode** — 0600 on macOS, verified on both real projects. On Windows this is a no-op (per [atomic-store.ts:40](electron/server/lib/atomic-store.ts:40)), but Session 04's triage lifted `safeStorage` encryption to cover the Windows gap. ✓
- **Empty secrets.json on import** — [import-project.ts:389](electron/server/services/import-project.ts:389) writes an empty store. Plus provenance stamp would refuse a manually-copied foreign file anyway. ✓
- **Encryption at rest** — every write goes through `writeSecretsFile` → `safeStorage.encryptString`. Plaintext fallback only fires on the tsx-test path or a broken Keychain. ✓
- **State parameter on OAuth callback** — 32-hex random, validated on callback. ✓
- **Refresh-token always issued** — `prompt=consent` forces re-issuance; missing refresh_token becomes an actionable hard error. ✓
- **Private-by-default upload** — hardcoded in UI, defaulted in route + executor. ✓
- **Idempotent Upload click** — backend dedupe + frontend button disable. ✓
- **Revoke at platform side on Disconnect** — POSTs to Google's revoke endpoint; not just a local wipe. ✓
