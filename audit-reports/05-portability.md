# Session 05 — Portability & Fresh-Machine Setup

**Scope:** two deployment scenarios must work flawlessly on the personal-multi-machine model:

- **(A) Fresh-machine setup** — install DMG, finish wizard, create first episode within 30 minutes.
- **(B) Project transfer** — tar/zip a project folder on machine A, open it on machine B, resume. OAuth tokens must NOT carry over.

Session 04 set the threat context. This session verifies whether the code matches the promise.

**One-line verdict:** **the transfer story is aspirational.** The wizard sets `portable: false` by default, no `.story-studio-project.json` manifest gets written, both on-disk projects store absolute `/build/Downloads/...` paths in `project.json`, and the import flow (`importProjectFromFolder`) is only ever reached for projects that already had a manifest — which, for fresh projects, is never. The fresh-machine story is better but has at least one blocker: FFmpeg isn't detected or validated in the wizard, so a clean-install user can finish setup and then hit an opaque "ffmpeg failed to start" at minute 15 with no remediation breadcrumb. Two Critical and six High findings below.

---

## Part A — Portability

### 1. Hardcoded absolute paths in committed files

Grepped TS / JS / JSON / Vue / mjs for `/Users/`, `/home/`, `C:\`, `/tmp/`, and the literal username `vengtheng`. Excluded `node_modules/`, `frontend/.nuxt/`, `frontend/.output/`, `electron/dist/`, `bundled/`.

**Clean.** Zero hits in committed source. All user-home paths are constructed dynamically via `process.env.HOME` / `USERPROFILE`, `process.env.APPDATA`, `process.env.XDG_CONFIG_HOME`, or `app.getPath('userData')`. The only hardcoded-looking string is a comment example in [fetch-ffmpeg.mjs:9](scripts/fetch-ffmpeg.mjs:9) — comment-only, not a landmine.

### 2. Paths saved inside project files — **Critical finding**

Grounded on the two real projects in `~/Library/Application Support/Story Studio KH/projects/`:

**[project.json sample — dozing-knight]**

```json
"portable": false,
"output_root": "/build/Downloads/Story Studio/Dozing Knight Studio/Dozing Knight"
```

`output_root` is **absolute**. On a different machine (different username, different home layout, no `Downloads/Story Studio` folder), opening the project goes one of two ways:

- The folder resolves to a valid disk path on machine B (only if the user recreated the same structure → unlikely) — nothing breaks.
- The folder doesn't resolve → all episode assets are considered missing; the app shows an empty project and offers no breadcrumb.

The code path that should tolerate this is `path-resolver.ts::toPortablePath` ([electron/server/lib/path-resolver.ts:82-107](electron/server/lib/path-resolver.ts:82)), which collapses absolute paths to `${PROJECT}/...` or `${NAMED_ROOT}/...`. But **it only runs when `portable: true` and only on preset fields** (via `manifest.ts::portabilizeDeep`), never on `output_root` itself. `output_root` is stored raw.

**Compounding finding:** `portable: false` is the default for new projects. Both on-disk real projects have `portable: false`. This means `writeManifest` either doesn't fire at all for these projects, or writes a manifest that won't be portable. I verified on disk: **no `.story-studio-project.json` file exists at the `output_root` of either project.** Which means:

- The entire portable-transfer code path (`importProjectFromFolder`) is not exercised for projects created through the current wizard.
- To transfer a project, the user must (a) flip `portable: true` somewhere, (b) trigger a manifest regeneration, (c) do this before sharing.

Nothing in the wizard teaches this. Nothing in the UI makes it obvious.

→ **Fix task spawned: "Fix: portable=true by default + portabilize output_root"**

> **Update 2026-04-25:** resolved by re-scoping rather than fixing the original design. The portable manifest is now schema v2 — a slim ~8-field structural file (project_id, name, episode prefix/digits, season size/prefix, folder_template, subfolder_names, last_edited). Presets, production standards, YouTube templates, voice presets, and `required_named_roots` no longer travel between machines; the operator re-does that ~5-minute setup on each Mac. Import is now folder-first: `inspectProjectFolder` runs `inferProjectMetadata` (at [electron/server/services/project-inference.ts](electron/server/services/project-inference.ts)) when no manifest is present, detecting prefix/digits/season layout/subfolder templates from folder contents. Manifest-v1 files on disk are still read but their preset bag is discarded silently and rewritten as v2 on next save.

### 3. Machine-local identifiers

- `project_id` is a plain `randomUUID()` ([manifest.ts:146](electron/server/services/manifest.ts:146), backfilled at [project-manager.ts:202-211,333](electron/server/services/project-manager.ts:202)) — machine-independent, stable across transfer. ✓
- `account_id` is a plain UUID ([upload-store.ts:34,96](electron/server/services/upload-store.ts:34)) — reused on import. ✓
- `idea` IDs use `idea-${Date.now()}-${i}` ([idea-manager.ts:115](electron/server/services/idea-manager.ts:115)) — timestamp-based; unique per machine but could theoretically collide if the user hand-merges idea DBs. Low.
- **Machine label leak:** [manifest.ts:194](electron/server/services/manifest.ts:194) writes `os.hostname() || 'unknown'` into `last_edited.machine_label` of the portable manifest. Informational, but it travels with the manifest to the other machine and can end up in committed backups. Medium privacy hygiene; not a correctness hazard.
- No `os.userInfo()` / `networkInterfaces()` / machine-UUID writes persisted anywhere. ✓

### 4. Bundled FFmpeg resolution — **High finding**

**[fetch-ffmpeg.mjs:126-130](scripts/fetch-ffmpeg.mjs:126)** explicitly `throw`s unless `process.platform === 'darwin'`. The build-time script only produces the macOS universal2 binary. Consequently:

- `electron-builder.json::extraResources` ships `bundled/ffmpeg/` → `ffmpeg/` in the .app. That path contains **only the macOS universal2 binaries**.
- Windows NSIS builds and Linux AppImage builds ship with no bundled FFmpeg at all.
- [ffmpeg-manager.ts::DOWNLOAD_URLS](electron/server/services/ffmpeg-manager.ts:278) has entries only for `darwin.arm64` + `darwin.x64`. A Windows or Linux install that falls through the resolution chain hits [line 371-378](electron/server/services/ffmpeg-manager.ts:371): *"Automatic FFmpeg download is not yet supported on {platform}/{arch}"*.

If the multi-machine fleet is ever anything other than all-Mac, this is a blocker. Even if the user is all-Mac today, this is a latent "bring a Windows laptop on a trip" failure.

**Secondary runtime flaw at [ffmpeg-manager.ts:238](electron/server/services/ffmpeg-manager.ts:238):**

```ts
result.source = ffmpegBin.startsWith(localDir) ? 'bundled' : 'system'
```

`localDir` is `{userData}/ffmpeg/`, NOT `Contents/Resources/ffmpeg/`. The actual bundled binary at `process.resourcesPath/ffmpeg/ffmpeg` gets labelled `'system'` in the status response. Mislabels the UI badge. Purely cosmetic but confusing.

**Homebrew-broken footgun:** resolution order is bundled (step 2) → app-downloaded (step 3) → common install locations (step 4, includes `/opt/homebrew/bin/ffmpeg`) → PATH (step 5). If (a) bundled is missing (deleted, wrong target), (b) app-downloaded is absent, and (c) `/opt/homebrew/bin/ffmpeg` exists but is broken (interrupted brew upgrade, missing dylib, wrong arch), the broken binary wins and fails on first spawn with no pre-flight check. [ffmpeg-manager.ts:141-145](electron/server/services/ffmpeg-manager.ts:141).

→ **Fix task spawned: "Fix: Windows/Linux FFmpeg bundling + pre-flight executability test"**

### 5. Font / asset bundling

- `electron-builder.json::files` includes `electron/templates/**/*`; `extraResources` re-includes same. Redundant, harmless. ✓
- **Fonts drift:** Session 03 flagged that Nuxt config comments claim Inter WOFF2 ships locally at `/fonts/inter/` but the built `index.html` loads Google Fonts CDN. This still matches today's build output (re-verified). Breaks offline. Medium.
- No other asset bundling landmines.

### 6. `process.platform` checks

Agent-surveyed 10+ call sites. All have three-branch (darwin / win32 / linux) coverage with safe fallbacks. Notable:

- [named-roots.ts:34-40](electron/server/services/named-roots.ts:34), [project-manager.ts:52-57](electron/server/services/project-manager.ts:52), [voices-cache.ts:40-42](electron/server/services/voices-cache.ts:40), [app-settings.ts:34-58](electron/server/services/app-settings.ts:34) — identical three-branch userData path patterns. Consistent.
- [ffmpeg-manager.ts:58,96,655](electron/server/services/ffmpeg-manager.ts:58) — `.exe` suffix, `which`/`where`, bin-dir lookup. Proper Windows/Linux handling.
- [main.ts:275-276](electron/main.ts:275) — "quit on non-darwin when window closes" is standard macOS dock convention.

No landmines.

### 7. Path separators

No manual `/`-concat landmines. All filesystem paths flow through `path.join()` / `path.normalize()`. The only `split('/')` hits are URL / frame-rate parsing, not filesystem paths ([ffmpeg-manager.ts:547](electron/server/services/ffmpeg-manager.ts:547), [ffmpeg-validation.ts:81](electron/server/lib/ffmpeg-validation.ts:81)). ✓

### 8. Line endings

All concat-list writers explicitly use `'\n'` (LF), not `os.EOL`: [audio-merge.ts:395,505](electron/server/routes/audio-merge.ts:395), [generators/video.ts:1155,1215,1559](electron/server/generators/video.ts:1155). FFmpeg's concat demuxer accepts LF on Windows — safe. No `.sh`/`.bat`/`.ps1` scripts generated at runtime. ✓

### 9. Case sensitivity — **High finding**

macOS is case-insensitive-by-default; Linux is case-sensitive; transferring a project between the two breaks when filename case is assumed.

- [image-reconciler.ts:98](electron/server/services/image-reconciler.ts:98): builds expected filenames from `episodeCode.toUpperCase() + '_' + ...`. If disk files were created under a legacy lowercase/mixed-case convention (e.g. `ep001_*.png`), the uppercase query misses them. macOS masks this (case-insensitive lookup "finds" them anyway); Linux won't.
- [video-reconciler.ts:230,242](electron/server/services/video-reconciler.ts:230): same pattern — uppercase code + `e.name.toUpperCase().startsWith(code)`.
- [audio-reconciler.ts:73,77](electron/server/services/audio-reconciler.ts:73): same pattern for audio chunks.

If the personal fleet stays all-Mac, impact is **low**. If an Intel Mac's filesystem was ever reformatted to case-sensitive (`diskutil apfs updatePreboot` path), or if any transfer ever lands on a case-sensitive target, reconcilers silently report "no_manifest" or empty recovery results. No error, no remediation hint.

→ **Fix task spawned: "Fix: case-insensitive disk lookup in reconcilers"**

### 10. User-data directory resolution

Every module prioritises `STORY_STUDIO_DATA_DIR` override (used by tests) → Electron `app.getPath('userData')` → manual platform branching. Consistent on the happy path.

**Dev-fallback inconsistency:** when `STORY_STUDIO_DATA_DIR` isn't set and Electron isn't available:

- [ffmpeg-manager.ts:40](electron/server/services/ffmpeg-manager.ts:40), [app-settings.ts](electron/server/services/app-settings.ts), [voices-cache.ts](electron/server/services/voices-cache.ts) → fall back to `ROOT` (repo root).
- [logger.ts:30](electron/server/services/logger.ts:30), [preview-cache.ts:34](electron/server/services/preview-cache.ts:34), [migration.ts:31](electron/server/services/migration.ts:31) → fall back to `process.cwd()`.

Live evidence of the pollution risk: the dev user's own `app-settings.json` at the repo root contains:

```json
{
  "ffmpeg_path": "/build/Developer/Story Studio KH/ffmpeg/ffmpeg",
  "ffprobe_path": "/build/Developer/Story Studio KH/ffmpeg/ffprobe"
}
```

The `ffmpeg/` directory was auto-created inside the repo tree at some point — a dev-mode fallback wrote there instead of into `userData`. Harmless in prod (`app.isPackaged` is true), but pollutes the git working directory for the maintainer. Medium.

`STORY_STUDIO_DATA_DIR` isn't documented anywhere user-facing — it's a test-only knob.

---

## Part B — Project transfer

### 11. Self-contained project folder

**No — caches live at userData, not per-project:**

- [voices-cache.ts:38-50](electron/server/services/voices-cache.ts:38): `{userData}/elevenlabs-voices.json` — ElevenLabs voice catalogue per-machine. Transfer loses it; next load re-fetches. ✓ self-healing.
- [app-settings.ts](electron/server/services/app-settings.ts): `ffmpeg_path` per-machine — re-resolved at render time from scratch. ✓.
- [preview-cache.ts:23-38](electron/server/services/preview-cache.ts:23): `{userData}/preview-cache/` thumbnails — lost on transfer; regenerated lazily.

Generators write into `{output_root}/{episode}/{subfolder_name}` — all within the project folder. ✓.

Remaining risk is **preset paths pointing outside the project** (e.g., a music file on the machine A desktop). If the user forgot to put it under `${PROJECT}` or a named root, `toPortablePath` passes it through absolute ([path-resolver.ts:106](electron/server/lib/path-resolver.ts:106)) and it breaks silently on machine B at render time.

### 12. Secrets in transferred folder — **High finding**

`importProjectFromFolder` writes an empty `secrets.json` on import ([import-project.ts:260-264](electron/server/services/import-project.ts:260)). Good — keys + OAuth shed as designed.

**BUT that only fires if the user uses the Import flow.** If they copy the folder manually (rsync, drag, cp -r), `secrets.json` travels intact. Then:

- [secrets-store.ts::readSecretsV2](electron/server/services/secrets-store.ts:190-210) attempts safeStorage decryption. On a different machine with a different Keychain-derived key, decryption fails and the file is treated as empty (no crash — audit §5.7 mitigation working as intended).
- **Catch:** if the user's two machines share the same iCloud Keychain (common for the same Apple ID), decryption *might* succeed (depending on whether safeStorage-encrypted blobs sync — they don't by default, but the user could misconfigure). Very unlikely but worth documenting.
- **The real failure:** if safeStorage is unavailable (old macOS, test environment) the store falls back to plaintext; a manual copy then carries live API keys + OAuth tokens over. **OAuth tokens → wrong channel upload on machine B.** This is the #1 correctness hazard in the audit brief.

No UX guard rails: nothing in the app refuses to open a project whose `secrets.json` was written by another machine. The app doesn't know.

→ **Fix task spawned: "Fix: refuse-or-warn on cross-machine secrets.json"**

### 13. OAuth tokens per-project vs per-app

Per-project, at `secrets.json.upload.{platform}.{account_id}` ([upload-store.ts:56-103](electron/server/services/upload-store.ts:56)). Session 04 already flagged the risk surface — today's verification confirms it remains. Mitigated by the Import flow (empty secrets.json), not mitigated by manual folder copy.

### 14. Manifest → assets sync after transfer

[manifest.ts::getManifestStatus](electron/server/services/manifest.ts:219-250) compares mtimes only. It does **not** audit asset presence on disk. If machine A's manifest lists 60 scene images but only 59 survived the transfer, the UI reports `in_sync: true` and the missing image only surfaces when the video-assembly step tries to render it — a generator-level error, not a project-open warning.

Reconcilers (`image-reconciler.ts` / `audio-reconciler.ts` / `video-reconciler.ts`) exist but are user-triggered "Repair" actions, not automatic on project open.

→ **Fix task spawned: "Fix: on-open asset audit for imported projects"**

### 15. Project open on machine B

No re-init runs:

- FFmpeg path isn't in the project (app-settings.json only). ✓
- Named roots aren't checked until first render. [path-resolver.ts:64](electron/server/lib/path-resolver.ts:64) throws an error like *"Named root ${NAME} is not defined on this machine. Define it in Settings → Named Roots."* — but only when a generator tries to resolve the path. User doesn't know until minute 15 of render.
- No automatic schema migration.

Improvement path: on open, check every `${NAME}` referenced by the manifest against the named-roots registry and surface a single banner "Define these named roots before rendering: X, Y."

### 16. Schema version mismatches

Current portable-manifest schema is v1, strictly validated ([manifest.ts:182](electron/server/services/manifest.ts:182) rejects anything ≠ 1). Secrets migrate v1→v2 automatically on read ([secrets-store.ts:110-128](electron/server/services/secrets-store.ts:110)). `.task-manifest.json` is v1 only, no migration.

Risk is one-directional: **older app opens newer project** → manifest read returns null, project appears unmounted. Acceptable given the personal model (self-upgrade is under the user's control). Low priority.

---

## Part C — Fresh-machine setup

### 17. First-run detection

[frontend/pages/index.vue:12-30](frontend/pages/index.vue:12) fires the onboarding card whenever `projects.length === 0 && !loading`. No half-state tracking. If the user enters name + location + keys in the wizard but quits before clicking Create Project on Step 4, all state is lost; relaunch restarts from Step 0. Clean enough. Minor.

### 18. FFmpeg step in wizard — **Critical**

The 4-step wizard (Basics / Save Location / API Keys / Review) has **no FFmpeg step at all** ([frontend/pages/index.vue:123-277](frontend/pages/index.vue:123)). A separate `FfmpegSetupDialog` component exists but only triggers when the user navigates to video-assembly or audio-merge and the backend reports `installed: false`. By then the user is 15+ minutes in.

Fresh-machine failure mode: wizard completes → user generates a script → generates audio → generates images → tries to assemble video → `FfmpegSetupDialog` fires → user either downloads FFmpeg (~5 minutes + error surface if that download path has no Windows/Linux URL per §4) OR runs `brew install ffmpeg` in a separate terminal (3-10 minutes) and restarts the app.

30-minute goal is at serious risk.

→ **Fix task spawned: "Fix: add FFmpeg detection + install step to wizard"**

### 19. API key verification in wizard — **High**

[frontend/pages/index.vue:214-241](frontend/pages/index.vue:214) accepts keys via `<ApiKeyInput>` (masked) but **does not verify** — no per-provider ping. Keys are stored verbatim via `PUT /projects/{slug}/settings/api-keys` at line 522. Bad key discovered at first generation, 5-15 min later, with an opaque 401 in the job error.

The backend **does** have a working verifier: [utils.ts::testApiKey](electron/server/services/utils.ts:340-382) exposed via `POST /projects/{slug}/test-key/{provider}` ([health.ts:312-333](electron/server/routes/health.ts:312)). The Settings → API Keys page calls it on a "Test" button ([ProviderAccounts.vue:194-216](frontend/components/ProviderAccounts.vue:194)). It's just not wired into the wizard.

Low-effort, high-payoff fix: add a "Test all" button to wizard Step 3 that calls `testApiKey` per provided key and blocks Next on failure.

→ **Fix task spawned: "Fix: validate API keys in wizard Step 3 before proceeding"**

### 20. OAuth step — **High**

Not in the wizard. OAuth is discovered only when the user navigates to `/projects/{slug}/upload` ([frontend/pages/projects/[slug]/upload.vue:78-115](frontend/pages/projects/[slug]/upload.vue:78)), fills Google Cloud client_id + client_secret, and runs consent. A fresh-machine user with "personal multi-machine, different channel each" as the core use case should be gently pushed toward OAuth *during setup*, since the whole point is to pin this machine to this channel.

**Correctness-hazard angle:** without an OAuth step in the wizard, nothing enforces "machine = channel" at creation time. The user discovers the binding later, which is the exact moment a wrong-channel upload becomes possible (see §12).

→ **Fix task spawned: "Fix: add OAuth connect step to wizard (skippable per-platform)"**

### 21. Storage location picker

No default path. User must click "Choose Folder…", OS picker opens at last-used location ([system.ts:75-77](electron/server/routes/system.ts:75)). No iCloud/Dropbox/OneDrive warning when a synced folder is picked — despite the brief calling sync-folder interactions out as in-scope. Minor UX gap; real risk documented in [sync-safe.ts:46-58](electron/server/lib/sync-safe.ts:46) which already handles placeholder detection at render time, so the damage is bounded.

### 22. Connectivity precheck — **High**

No startup ping. If the user is behind a corporate firewall, captive portal, or DNS-broken LAN:

- The API-key Test path times out after 5 s and says *"Invalid key or network error"* ([utils.ts:352,358,364,375,380](electron/server/services/utils.ts:352)) — same error for bad key and no network.
- The user doesn't get a "check your network" nudge; they burn 10 minutes double-checking keys that are fine.

Needed: a simple 3-way ping at wizard-start to `api.openai.com`, `api.anthropic.com`, and one of (kie / fal / ElevenLabs) with 2 s timeout, surface a yellow banner "can't reach providers — check network/firewall" before the user enters keys.

→ **Fix task spawned: "Fix: connectivity precheck at wizard start"**

### 23. Idempotency

Clean. The project is only committed to disk on Step-4 Create Project click. A quit-and-relaunch resets the wizard to Step 0. No half-written files. The only edge: Create Project succeeds (`POST /projects`) but the subsequent `PUT /api-keys` fails → project exists without keys, no recovery dialog. Medium; manifests as "why doesn't my project have keys?" and the user goes to Settings → API Keys manually.

### 24. Re-run setup later

**Not possible.** The wizard only fires when `projects.length === 0`. Once one project exists, there is no menu item to re-launch the wizard to, e.g., add OAuth to a new platform, swap storage location, or re-validate keys for a new provider. Those live in per-project Settings panels. Functional but disjointed. Medium.

### 25. Error messages during setup

- Step 1 empty name → Next button disabled, no text. Acceptable.
- Step 2 picker failure → toast via `showError` ([index.vue:464](frontend/pages/index.vue:464)). Acceptable.
- Step 3 bad key → not detected; silent pass-through. See §19.
- Step 4 `POST /projects` fail → toast. `PUT /api-keys` fail → silent (the project exists without keys). See §23.
- Post-wizard FFmpeg error → `FfmpegSetupDialog` offers download + "I've installed it — check again". Acceptable if the user is lucky. Not actionable if download 404s or the broken-brew path from §4 triggers.

Overall: acceptable for the common case, weak for every interesting failure mode.

---

## Part D — Localhost on personal machine

### 26. Browser tab drive-by to `http://localhost:8000/` — **Medium footgun**

Current CORS config at [app.ts:34-41](electron/server/app.ts:34):

```ts
const isDev = !process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_ENV === 'development'
app.use(cors({
  origin: isDev
    ? [`http://localhost:${FRONTEND_PORT}`, `http://127.0.0.1:${FRONTEND_PORT}`]
    : true,
  credentials: true,
}))
```

In packaged Electron `ELECTRON_RUN_AS_NODE` is unset → `isDev = true` → CORS allows only `:3000`. That's good for the preflight path — cross-origin XHR from `https://random-site.com` will have the browser refuse the *response*.

**Simple-request footgun:** POST with `Content-Type: text/plain` (or form-encoded) and no custom headers bypasses CORS preflight. The browser still sends the request and the server *acts on it*; only the response is blocked from the calling page. If any `/api/` endpoint performs a side-effect on such a POST — say, `/api/jobs` accepts a text/plain body that triggers an AI generation — a buggy or hostile tab the user happens to have open can spend money without ever reading the response.

`requireLocalHost` ([security.ts](electron/server/lib/security.ts)) blocks requests whose `Host:` header isn't a local hostname — which covers DNS-rebinding but **not** a browser tab at `http://localhost:8000/*` where the Host header *is* loopback. The per-boot CSRF token machinery exists but isn't gating any current routes (license routes that used it were removed).

Under the personal threat model this is a **footgun**, not an attack — but "accidentally trigger an expensive generation because you had stackoverflow.com open in another tab with a stale cached page that fetches `http://localhost:8000/`" is still an annoying way to burn $5.

Flagged as Medium (P10 in the table below); no fix-task auto-spawned per Session 05's charter of C/H only. Revisit in Session 06 alongside spend caps.

---

## Findings summary

| # | Finding | Severity | Affects |
|---|---|---|---|
| P1 | `portable: false` default; `output_root` stored absolute; no manifest written for normal projects | **Critical** | Transfer — 100% breakage |
| P2 | No FFmpeg step / pre-flight in wizard | **Critical** | Fresh-machine 30-min goal |
| P3 | Windows/Linux FFmpeg not bundled, no runtime download URL | **High** | Fresh-machine on non-Mac |
| P4 | No API-key verification in wizard | **High** | Fresh-machine |
| P5 | No OAuth connect step in wizard | **High** | Per-machine-channel pinning |
| P6 | Manual folder copy carries live secrets.json; no cross-machine guard | **High** | Wrong-channel upload |
| P7 | On-open asset audit missing after transfer | **High** | Silent missing-asset scenarios |
| P8 | No connectivity precheck | **High** | Corporate network false-negatives |
| P9 | Case-sensitivity in reconcilers (uppercase-only disk lookup) | **High** | Mac↔Linux or case-sensitive FS transfers |
| P10 | CORS simple-request footgun (no CSRF on `/api/*`) | Medium | Accidental spend from a buggy tab |
| P11 | `source` detection in `getFFmpegStatus` mislabels bundled as `system` | Medium | UX only |
| P12 | Machine hostname leaks into portable manifest | Medium | Privacy hygiene |
| P13 | Re-run wizard later not possible | Medium | UX continuity |
| P14 | Google Fonts still CDN-loaded despite local claim | Medium | Offline break |
| P15 | Dev-fallback inconsistency (ROOT vs process.cwd()) → `app-settings.json` pollution in repo | Medium | Dev environment only |
| P16 | Homebrew-broken ffmpeg wins when bundled is missing; no pre-flight | Medium | Rare but opaque |
| P17 | Step-4 partial failure (project created, keys not saved) is silent | Medium | Wizard UX |
| P18 | Storage-location picker has no sync-folder warning | Low | iCloud/Dropbox edge |
| P19 | `idea` IDs are `Date.now()`-based (not UUID) | Low | Rapid-fire collision edge |
| P20 | Schema mismatch: newer app can't downgrade to older project | Low | Self-managed upgrade |

---

## Open questions for the developer

1. **Multi-machine scope:** is the fleet all-Mac, or is a Windows/Linux machine ever in scope? Answers whether P3 is a blocker or backlog.
2. **Transfer workflow:** is the intended transfer (a) always via Import, (b) always via manual folder copy, or (c) either? Determines priority of P1 vs P6.
3. **What does `portable: true` actually unlock?** Confirm whether it only triggers manifest generation, or if it also changes preset-path handling at runtime.
4. **Named roots:** is the expectation that the user pre-configures named roots per-machine before first use, or that the app learns them by introspection?
5. **iCloud Keychain:** does the user's fleet share an Apple ID? Affects P6 — if yes, safeStorage might decrypt cross-machine (needs live test to confirm).
6. **Re-run wizard:** is a "Settings → Re-run setup" menu item desired, or is per-provider settings sufficient long-term?

---

*End of Session 05. Nine fix-tasks spawned (P1–P9: 2 Critical + 7 High). Mediums and Lows deferred to later sessions. Session 06 picks up with runtime integrity — FFmpeg watchdog, silent quota failures, spend caps — and will revisit P10 (CSRF) alongside cost bounds.*
