# Session 04 — Threat Model, Personal Multi-Machine

**Status of Session 01:** stale. That document modelled a paid public download defended against strangers, pirates, and drive-by web attackers. None of those threats apply anymore.

**Product reality, 2026-04-24:** one operator, N machines, one YouTube/TikTok/Facebook channel per machine, projects occasionally copied between machines, no public distribution, no license layer.

---

## 1. Deployment model

N independent macOS installs (arm64 today; Intel universal2 still bundled). Each machine owns:

- its own `~/Library/Application Support/Story Studio KH/` (userData — `app-settings.json`, logs, ffmpeg cache),
- its own `projects/` tree, chosen by the user at onboarding ([frontend/pages/index.vue:12-150](frontend/pages/index.vue:12)),
- its own OAuth tokens, stored **per-project** in `secrets.json` under `upload.<platform>.<account_id>` ([electron/server/services/upload-store.ts:56-103](electron/server/services/upload-store.ts:56)),
- its own `secrets.json` encryption key (now derived via `safeStorage` from the login keychain — [electron/server/lib/safe-storage.ts:34-42](electron/server/lib/safe-storage.ts:34)), so backups restored onto another machine are inert.

**Install = drag DMG, re-enter API keys, pick project location.** No shared DMG channel — upgrades are manual per machine today. Four-step wizard fires when `projects.length === 0`; API-keys step is optional.

**Transfer = move the output folder**, then open on the new machine. `importProjectFromFolder` ([electron/server/services/import-project.ts:87-274](electron/server/services/import-project.ts:87)) reads the portable manifest and **writes an empty `secrets.json`** (line 208-274) — API keys and OAuth tokens intentionally do not travel. This is load-bearing for channel isolation.

---

## 2. Assets at risk, ranked

| # | Asset | Irreplaceability | Why |
|---|---|---|---|
| 1 | **In-progress episode state** (scripts + images + audio + partial video) | Hours of paid AI inference per episode. Losing a manifest-sync corrupts *days* of work. | No cloud copy of the generation graph. |
| 2 | **Provider API keys** | Re-enterable but tedious — seven providers, some with rotation friction (YouTube OAuth client, GenAI Pro). | Backups now encrypted (safeStorage); still plaintext in a restore-on-same-machine scenario. |
| 3 | **OAuth tokens** | Revoke + re-consent is a real cost: YouTube refresh tokens have quota-counting side effects; re-consent also bumps the Google verification warning banner. | Per-project storage means isolation is tight when projects stay on one machine. |
| 4 | **Completed uploaded episodes** | Already live on the channel; irreplaceable only if the machine dies *before* upload and there's no other backup. | Not this app's responsibility; flag as "user SOP" not code. |

---

## 3. Failure modes in scope

| Mode | Likelihood | Cost | Notes |
|---|---|---|---|
| Fresh-machine setup fails halfway | Medium | High (blocks start of work) | Wizard doesn't validate FFmpeg (spawn-time fallback to bare `'ffmpeg'` at [ffmpeg-manager.ts:156](electron/server/services/ffmpeg-manager.ts:156)). API-key step is skippable; first generate fails opaquely. |
| Transferred project opens broken | Medium | Medium | Manifest portabilization via `${PROJECT}` tokens is solid. Failure mode: a preset path that doesn't resolve to any named root is serialized absolute at [path-resolver.ts:106](electron/server/lib/path-resolver.ts:106) — fails silently on machine B until render. |
| Wrong-channel upload (token A used on machine B) | Low | Catastrophic (brand risk) | Mitigated: import writes empty `secrets.json`. Defeat: user manually copies the folder instead of using import. No code-side defense. |
| Provider retry drains wallet overnight | Low | High | `http-retry.ts:13,64,73` caps at 8 consecutive failures with exponential backoff (60 s max). **No global spend cap** across alternating 200/429 patterns. |
| FFmpeg crash mid-encode, partial file kept | Medium | Medium | No partial-file cleanup on non-zero exit ([generators/video.ts:2161-2179](electron/server/generators/video.ts:2161)). No watchdog timeout — a hung encode blocks the job queue forever. |
| JSON manifest out of sync with disk | Low | Medium | Atomic temp+rename is correct. Reconcilers (`*-reconciler.ts`) detect drift but do not auto-heal. `folder-migration.ts` batches renames before writing `project.json` — crash in the middle leaves subfolder names stale. |
| Silent failure presented as success | **High** | **High** | Worst class for solo ops. Known instances: (a) YouTube `recordQuotaUsage` wrapped `.catch(() => {})` at [youtube-client.ts:154,402,434,481,514,552](electron/server/lib/youtube-client.ts:154) — upload returns 200 even if quota ledger never updates; (b) `task-manifest.ts:84-91` logs-and-continues on sidecar write fail. |

---

## 4. Boundaries that still matter

- **App ↔ Disk.** Atomicity, mode 0600, iCloud placeholder detection ([sync-safe.ts:46-58](electron/server/lib/sync-safe.ts:46)) all ✓. Debt: manifest/disk drift detection doesn't self-heal.
- **App ↔ FFmpeg.** Args array ⇒ no shell injection (✓). Missing: watchdog timeout, partial-output cleanup, post-encode integrity check.
- **App ↔ AI providers.** Bounded retries (✓), no spend cap (✗). Error-body echo leaks upstream content to the renderer (02-secrets H4).
- **App ↔ Upload platforms.** Per-project tokens (✓); no code-side assertion that a project belongs to the machine/channel it was created on.
- **Machine ↔ Machine (transfer).** Manifest portabilization (✓). Empty `secrets.json` on import (✓). Presets-with-absolute-paths escape hatch (✗).

---

## 5. Explicitly out of scope (SKIP)

Do **not** spend cycles on these anymore:

- Reverse-engineering / asar-patching / code obfuscation. No pirate exists.
- License bypass / revocation / device binding. No license.
- CORS lockdown, DNS-rebinding, CSRF on loopback. Already closed; a fresh attacker-site attack is no worse than a local-process attack, and defenses landed (Host-header check, per-boot CSRF tokens were in place).
- Legal accessibility (a11y) compliance. Single operator; any UX issue is self-reported.
- App Store / Microsoft Store policy compliance. Not distributing there.
- Gatekeeper / SmartScreen friction. `xattr -d com.apple.quarantine` once per machine is acceptable SOP.
- Public CSP strictness (nonce rewriting). The app is loopback-only.

---

## 6. Production-readiness blockers for a fresh machine

Ordered by "I would refuse to put this on a new machine today until fixed."

1. **FFmpeg watchdog + partial-output cleanup.** Hung encode blocks the queue; partial file passed as success. (Session 05.)
2. **Silent quota/bookkeeping failures.** Any `.catch(() => {})` on a user-visible write. Upload shows 200 while quota ledger never ticked. (Session 06.)
3. **No global provider spend cap.** Alternating 200/429 patterns or a malformed input that bounces every render defeats the consecutive-failure cap. (Session 06.)
4. **Wizard doesn't verify FFmpeg / API keys before completing.** First real error surfaces at render time with no breadcrumb. (Session 07.)
5. **Logger redaction drift** (02-secrets H3) and **provider error echo** (H4). Not a public-attack problem anymore, but logs end up in support bundles you share with yourself across machines. (Session 08.)
6. **Manifest self-heal on drift.** Reconcilers detect but don't fix. (Session 09.)
7. **Project transfer: presets-with-absolute-paths escape hatch.** A preset that doesn't resolve to any named root silently serializes an absolute path. (Session 10.)
8. **Crash-log redaction** (02-secrets H8, partial). Dialog is now safe; `logCrash` still writes raw `Error.stack` unredacted. (Session 11.)

---

## 7. Open questions

- **Project transfer semantics:** when transferring, is the expectation that generated assets (images/audio/video) move with the manifest, or only the manifest + regen plan? Current flow moves both; no way to transfer "recipe only."
- **Channel binding:** should projects record the *intended* channel/machine, and refuse upload if the currently-authorized account differs? Today this is convention only.
- **Manual folder copy vs. import:** should the app *refuse* to open a project whose `secrets.json` contains OAuth tokens from another machine, or is trusting the user to use Import the right policy?
- **Upgrade flow:** manual per-machine reinstall today. Want a "copy .app across machines" flow, or accept manual?
- **Spend cap:** per-render, per-hour, or per-day? Where does "hard stop the queue" live?

---

## PART B — Triage of audit-reports/02-secrets.md

Verified against current source 2026-04-24. Cancel rows name the spawned task exactly as it appears in 02-secrets.md so they can be dismissed from Cowork chips.

| Finding (short) | Old severity | Status under new model | Action |
|---|---|---|---|
| **C1** `app-settings.json` non-atomic + world-readable | Critical | Fixed ([app-settings.ts:19,69](electron/server/services/app-settings.ts:19)) | **Cancel fix-task**: *"Fix: harden app-settings.json writes"* |
| **C2** Google API key in URL query → logs + renderer | Critical | Still-live ([image-edit-client.ts:72](electron/server/lib/image-edit-client.ts:72)) | Keep fix-task: *"Fix: move Gemini image-edit key to header auth + scrub URL from errors"*. Severity unchanged — the key ends up in your own crash logs you share between machines. |
| **H3** Logger redaction allowlist drift | High | Still-live ([logger.ts:79-83](electron/server/services/logger.ts:79)) | Keep fix-task: *"Fix: complete logger secret redaction"*. Severity unchanged — logs travel with support bundles you email yourself. |
| **H4** Provider error body echoed to renderer | High | Still-live ([kie-client.ts:54,237](electron/server/lib/kie-client.ts:54) and siblings) | Keep fix-task: *"Fix: sanitize provider errors before returning to renderer"*. **Downgrade to Medium** — no cross-origin attacker, but still leaks API keys into logs when upstream echoes them. |
| **H5** `getConfig()` merges raw keys into returned object | High | Still-live ([project-manager.ts:477-483](electron/server/services/project-manager.ts:477)) | Keep fix-task: *"Fix: stop leaking raw keys through getConfig()"*. **Downgrade to Medium** — structural footgun rather than active exfil path under the new model. |
| **H6** OAuth revoke via URL query string | High | Fixed ([youtube-oauth.ts:303-305](electron/server/lib/youtube-oauth.ts:303) now POSTs with `URLSearchParams`) | **Cancel fix-task**: *"Fix: move OAuth revoke token to POST body"* |
| **H7** License key echoed unmasked on invalid activation | High | Obsolete (license system removed) | **Cancel fix-task**: *"Fix: stop echoing unmasked license key on invalid activation"* |
| **H8** Crash log + dialog unredacted | High | Partial — dialog fixed ([main.ts:245-248](electron/main.ts:245) shows "Check Help → Show Logs"); `logCrash` still writes raw stack | Keep fix-task (narrowed): *"Fix: redact crash logs and dialog messages"* → now just log-side. **Downgrade to Medium**. |
| **H9** `secrets.json` Windows perms / no DPAPI | High | Fixed cross-platform via `safeStorage` envelope ([secrets-store.ts:197-210](electron/server/services/secrets-store.ts:197)) | **Cancel fix-task**: *"Fix: encrypt secrets.json on Windows via DPAPI/keytar"* — replaced by safeStorage. |
| **M10** `deactivateLicense()` non-atomic mutate+write | Medium | Obsolete (license removed) | **Cancel** if a task exists; no explicit task name in original report. |
| **M11** Atomic-write temp file leftover on rename fail | Medium | Still-live ([atomic-store.ts:54-62](electron/server/lib/atomic-store.ts:54)) | Downgrade to Low — single-user, local FS. Keep informational. |
| **M12** `account_id` in query string rather than body | Medium | Still-live ([routes/upload.ts:43-45](electron/server/routes/upload.ts:43)) | Downgrade to Low — not a secret, no cross-origin attacker. |
| **L13** `kie-client` unencoded `taskId` | Low | Still-live ([kie-client.ts:165](electron/server/lib/kie-client.ts:165)) | Keep Low. |
| **L14** License key in Time Machine backups | Low | Obsolete (license removed; `safeStorage` mitigates the equivalent for `secrets.json`) | **Cancel** if a task exists; no explicit task name in original report. |
| **L15** `registry.ts` uses raw `console.log` for `[accounts]` | Low | Still-live ([registry.ts:152,165,170](electron/server/providers/registry.ts:152)) | Keep Low — account labels can contain typo'd secrets; bypasses redaction. |

**Net from triage:** 5 fix-tasks to cancel (C1, H6, H7, H9, plus M10/L14 if spawned), 1 narrowed (H8), 2 downgraded but kept (H4, H5), 4 still live at original severity (C2, H3, L13, L15). No new fix-tasks opened from this session — Sessions 05–11 own the blocker list in §6.
