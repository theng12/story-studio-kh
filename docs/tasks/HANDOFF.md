# HANDOFF — Story Studio KH

**Written:** 2026-09-23 · **against:** v1.4.219 · branch `codex/stabilization-takeover` @ `734ccd70` (record-only commits after this pin leave the app unchanged) · `main` @ `eced221b`

**Read this first.** This file is the cold-start briefing for a session that knows nothing about the last one.
If it disagrees with the code, the code wins — and then fix this file. The authoritative record of *what happened
and why* is [`Story Studio Project Status.md`](../../Story Studio Project Status.md) (queue, candidate rows, review
log) plus [`docs/handoffs/deepseek-reports/`](../handoffs/deepseek-reports/) (one report per packet). Keep both
out of scope unless a task needs them.

## WHERE THINGS STAND

| Thing | State |
|---|---|
| Current release | **1.4.223** — landed in `main` (`a79d3e98`), DMG `dist/Story Studio KH 1.4.223-arm64.dmg` (242,023,146 B, sha256 `e66641d63c7184f79197166b9b38abc47dfc448b5391f491c3881db95ad3a268`), **installed** at `/Applications/Story Studio KH.app`. Replaced bundles (1.4.219–1.4.222) are in `_trash/app/`. |
| Pending release | **1.4.220** (working tree, not committed or released as of 2026-09-26): prose requests send **no** `response_format` — a Studio Hub lane refuses `{"type":"text"}` with a 422, which killed every chapter expansion on the local model — and a language answer whose reported usage equals the ceiling the request asked for is **incomplete** even when the provider says `finish_reason: "stop"` (a local 9B wrote a chapter that ends mid-sentence and still reported `stop`). Both found by the STORY-2 acceptance run against gateway-kh; receipts in `_handoffs/2026-09-26_story-response-story-2-acceptance-run.md`. |
| Version decision | Application/desktop change → bump `package.json` **and** `package-lock.json` in the same change set + add a newest-first `## vX.Y.Z` entry to `CHANGELOG.md` + `npm run check:changelog`. Content-Pack-only change → its own `.sspack`, **no** bump (floor: [`content-packs/release-floor.json`](../../content-packs/release-floor.json)). Mixed → app path only for the runtime part. |
| Branch convention | Work on `codex/stabilization-takeover`. Ship by cherry-picking onto `land/<version>-into-main` from `origin/main`, then fast-forward `main` and push. **Never merge the working branch wholesale**: it also carries another effort's commits that are deliberately not in `main`. |
| Endpoint | Story Studio talks to **exactly one** endpoint — the owner's **gateway-kh** app (`http://127.0.0.1:8787` default), which fronts the provider. Not a GenStudio account. |
| Distribution media | `dist/Story Studio KH 1.4.219-arm64.dmg` (242,034,101 B, sha256 `5bace95337641c91ef033d8e3459f12bc1130024b90d9e8a4143a36f0ee144ba`); the DMG's own `READ ME FIRST.txt` carries the Gatekeeper step. Verified copies were written to the four owner SSDs (`KH-STUDIO-ATLAS/UGREEN/ORICO/NOVA`) on 2026-09-22; **the owner has since handed the SSD kit to Studio Hub KH**, the drives are unmounted, and their current contents are not verifiable from this machine. No Developer ID/notarization — the owner's decision. |
| Installed app | 1.4.223, launched by LaunchServices, serving the owner's real Library. **Update it automatically** — never wait for the owner to ask. |

## THE WORKING LOOP

Run in this order. Anything marked ⚠ has burned us before.

| Step | Command (copy it) | Notes / ⚠ footguns |
|---|---|---|
| 1. Dev loop | `npm run dev` | ⚠ The dev Electron app runs **compiled** `electron/dist`. Backend edits need `npm run build:electron` **and a restart**; only the frontend hot-reloads. ⚠ Unset `ELECTRON_RUN_AS_NODE` or Electron exits silently (`env -u ELECTRON_RUN_AS_NODE …`). |
| 1b. Isolated app (real rendering) | `cd frontend && npx nuxt dev --port 3000` then `env -u ELECTRON_RUN_AS_NODE PATH="$PWD/bundled/ffmpeg:$PATH" STORY_STUDIO_DATA_DIR=/tmp/<qa> npx electron . --user-data-dir=/tmp/<qa> --remote-debugging-port=9334` | ⚠ Without `bundled/ffmpeg` on `PATH` the audio step fails `spawn ffmpeg ENOENT` and assembly is blocked. A disposable Library keeps the owner's data out of it — but see DO NOT TOUCH: exports still default to his real Library root. |
| 2. Iterate | `node scripts/testing/run-backend-tests.mjs --only <substring>` · `npm run typecheck:electron` · `npm run lint` | ⚠ An `--only` run prints `PARTIAL RUN` and **is not a gate**; never quote it as one. One suite at a time across all work. ⚠ No wallclock sleeps in tests — use `waitFor` in `electron/server/__tests__/_timing.ts`. |
| 3. Full gates | `npm run test:backend` (release gate, every backend file) · `npm run test:frontend` · `npm run test:release` · `npm run test:content-packs` · `npm run typecheck` | Report the real exit status, completion line and counts. `test:backend` is the gate; do not narrow it to verify a release. |
| 4. Build | `npm run build` | Runs changelog, typography, security, model-drift and release checks, then builds frontend + electron, then re-checks security/release against the built output. |
| 5. Release artefact | `npm run dist:smoke` | Runs `fetch:ffmpeg` → `npm run build` → `check:release --built --package-input` → electron-builder → `verify-desktop-artifact`. Writes `dist/Story Studio KH <version>-arm64.dmg`. ⚠ Do **not** package from a git worktree whose `node_modules` is a symlink — electron-builder does not follow it and ships an app with no runtime deps (the v1.4.68 defect). ⚠ After any build, `git status` must be clean: a build has rewritten the root manifest before, and both build scripts now restore it (`NEW-11`). |
| 6. Install (only when asked) | `osascript -e 'quit app "Story Studio KH"'` → move the old bundle to `_trash/app/` → `ditto "dist/mac-arm64/Story Studio KH.app" "/Applications/Story Studio KH.app"` → `xattr -dr com.apple.quarantine "/Applications/Story Studio KH.app"` → `env -u ELECTRON_RUN_AS_NODE open -a "/Applications/Story Studio KH.app"` | Never `rm` the old bundle; it goes to `_trash/`. Verify afterwards with the app's own `/api/health` + its server log, not by assuming. |
| 7. Land | cherry-pick the release commits onto `land/<version>-into-main` (from `origin/main`) → run the gates on that tree → `git checkout main && git merge --ff-only land/<version>-into-main` → `git push origin main` → cherry-pick the record/dossier commits back to the working branch | `origin` = `https://github.com/theng12/story-studio-kh.git`. Never rewrite published history. |
| 8. Acceptance harness (optional) | `npx tsx scripts/developer/serve-mock-genstudio.ts --port 8799` (long-lived fake gateway: queue a scenario, clear queued answers, publish an alternate language catalogue, read accounting) and `ACCEPT_APP_URL=… ACCEPT_SLUG=… ACCEPT_MOCK_URL=http://127.0.0.1:8799 npx tsx scripts/developer/accept-01-driver.ts --leg script\|audio\|subtitles\|scene-plan\|images\|assemble\|metadata` | The driver hosts or attaches to the mock, points the app at it, and drives the app's own routes. Zero spend. `_timing.ts`, not sleeps. |

## PATHS

| Path | What it is |
|---|---|
| repo root | `/build/Developer/story-studio-kh` |
| `electron/server/` | Express backend; job queue, generators, content-store client |
| `frontend/` | Nuxt 4 / Vue frontend |
| `bundled/ffmpeg/` | `ffmpeg` 8.1 + `ffprobe`; prepend to `PATH` for dev runs |
| `dist/` | DMG + blockmap output (git-ignored); the handoff folder for the owner |
| `Story Studio Project Status.md` | **source of truth**: queue, candidate rows, review log, release state |
| `docs/handoffs/deepseek-reports/` | one report per packet (`ACCEPT-01.md`, `DS-*.md`, `WIRE-*.md`) |
| `_handoffs/` | letters to/from gateway-kh (read-only thread) |
| `docs/tasks/HANDOFF.md` | this file |
| `_trash/` | the owner's recoverable-delete folder (see DO NOT TOUCH) |
| `scripts/developer/` | `serve-mock-genstudio.ts`, `accept-01-driver.ts`, `probe-video-assembly-status.ts`, `measure-job-persistence-cost.ts` |
| `STORY_STUDIO_DATA_DIR` | dev/QA Library (projects, cache, app settings). A disposable QA Library does **not** survive a reboot — `/tmp` copies are gone as of this writing. |
| `--user-data-dir` | Electron profile; the app's `app-settings.json` and secret store live here |
| Default Library root | `~/Documents/Story Studio KH` — `_Project Assets/` and `Exports/` (final videos land here **outside** the project tree) |
| Installed app | 1.4.223, launched by LaunchServices, serving the owner's real Library. **Update it automatically** — never wait for the owner to ask. |

## RULES THAT COST US TIME

Each is an instruction, not advice.

- **Never `rm`. Every removal moves to `_trash/`** — the owner's words, covering your own cleanup as much as his requests; keep the sub-structure and say where it went.
- **Never rewrite published history.** To delete a branch or ref, record its name and SHA in a note under `_trash/` first.
- **Treat `_trash/` as the owner's.** Never delete or tidy anything inside it, and never restore something he removed from it.
- **Strip `ELECTRON_RUN_AS_NODE`** when launching Electron (dev or packaged); with it set the app exits immediately with no output and looks broken.
- **Do not package from a symlinked-`node_modules` worktree** — the app ships with no runtime dependencies and dies at launch.
- **Put `bundled/ffmpeg` on `PATH`** before any run that generates or assembles audio; otherwise you get `spawn ffmpeg ENOENT` and assembly blocks with a precise missing-file list.
- **Rebuild and restart after backend edits** — the app runs compiled output, so a source edit alone changes nothing you can observe.
- **TTS parts are sized by the model's published character limit, and by nothing else.** Owner decision, 2026-09-26: no internal spoken-minutes cap, because the 900-second wall that killed a long part is being raised at its source. That number is **Studio Hub's** (`PEER_PROXY_TIMEOUT_S` in its `hub/standalone.py`), published per lane as `deadline_seconds`; the gateway deliberately reads the lane's figure (`gateway/adapters/studio_hub.py::lane_deadline_seconds`) so it follows the Hub automatically. Do not add a seconds-per-word bound of ours, and do not cap a part to fit a deadline the lane owns.
- **A window of scenes is ONE response, so the output ceiling sizes it too.** The auto window size used to read only the *input* budget, so a 262,144-in / 4,096-out lane was asked for 30 scenes it could not return (fixed in 1.4.221). Before adding any batch, ask what one response can carry.
- **A provider's `finish_reason` can lie; usage does not.** A Studio Hub lane reported `stop` on an answer that had used its entire 4,096-token ceiling and stopped mid-sentence (2026-09-26). Treat "usage ≥ the ceiling the request asked for" as truncation, whatever the reason says — and never hand a provider's word for "complete" to the customer unverified.
- **One suite at a time**, and never quote an `--only` run as a gate: it prints `PARTIAL RUN` precisely so this cannot be confused.
- **No wallclock sleeps in tests.** Use `waitFor`; a fixed sleep asserts the scheduler, not the product.
- **Gates cannot see geometry, CSS or dev wiring.** When the complaint is visual, screenshot the render; when a declaration seems not to apply, check the **built** CSS for specificity, not the source. `:deep()` on a teleported dialog never matches.
- **Episode state must not survive an episode change** — replace the field or blank it, never `if (newValue) field = newValue`, and announce the change.
- **Provider is display, never dispatch.** One endpoint only; never infer a provider from an id or name; never hardcode a limit the catalogue publishes (read it live on every selection change).
- **`pacing` deliberately IS in Character Sheet presets** and **scene rhythm stays per-episode** (no project default) — both are owner decisions; do not "fix" them back. Details in `AGENTS.md` §5.
- **A metadata Retry with no saved action must mint a fresh request identity** (`NEW-14`), or the provider replays the same short answer and the promise "Retry to generate the missing fields" is false.
- **Scene Plan's timeline step is model-free and is audited on its timeline** (`NEW-12`), not on the visual prompts it is not asked to write.
- **Episode status watches the project tree *and* the Library export root** (`NEW-13`); a cache schema change must bump `SCHEMA_VERSION` in `electron/server/services/episode-status-cache.ts` so old rows are recomputed.
- **After any packaging run, `git status` must be clean** — the build scripts restore a rewritten manifest and log it (`NEW-11`); if they log it, the culprit step is still unknown.
- **`npm run check:changelog` must pass** — runtime version, lockfile and the newest What's New entry have to agree.
- **Typography gate:** no source text below 12px. **Model-drift gate:** no hardcoded catalogue values outside annotated exceptions.
- **Content Packs:** one unrecognised kind discards the whole catalogue, on both sides. Local→wire kinds: `series-formula→series_formula`, `topic-pack→topic_pack`, `visual-style→visual_style`, `thumbnail-recipe→thumbnail_recipe`, **`lettering-style→font_pack`** (the only non-mechanical one), `metadata-formula→metadata_formula`. `niche_bundle` is retired by the publisher but kept only so old archives read — see OPEN.
- **No paid call, upload, publish, deploy or installed-app replacement without the owner's explicit go-ahead.** Commit/push of finished work is standing-authorized; releases were authorized per version (1.4.217–219).

## DO NOT TOUCH

| Area | Why |
|---|---|
| `_trash/` — including anything you think belongs back in the repo | The owner's; he may empty it at any time. It is not durable: as of this writing it holds only `README.md`. Never restore what is no longer there. |
| `main`'s history, `land/*` branches, anything already pushed | Published history is never rewritten. |
| Other repositories and worktrees (Studio Hub KH, gateway-kh, any `codex/*` branch from another effort) | Not ours; `codex/content-pack-delivery`'s commit is deliberately absent from `main`. |
| `~/Documents/Story Studio KH` | The owner's real Library, `_Project Assets/` and final-video `Exports/`. Normal app use only; never reorganise or clear. |
| The four SSDs (`KH-STUDIO-*`) | The owner handed the SSD/installer kit to Studio Hub KH. |
| `/Applications/Story Studio KH.app` | Replace only on the owner's instruction, and keep the old bundle in `_trash/`. |
| `_handoffs/` letters | A thread with another party — read them, never rewrite someone else's letter. |
| `content-packs/authoring-registry.json` at baseline revision 289 | The authoring record was retired by the owner's decision; do not re-add `8051fc28`'s sources. |

## OPEN / IN FLIGHT

| Item | Honest state |
|---|---|
| `NEW-11` | Mitigated, **not** root-caused: packaging rewrote the checkout's `package.json` once; both build scripts now snapshot and restore both manifests, but the step that does it is unidentified. Reason not recorded — a clean `electron-builder --dir`, including its `@electron/rebuild` phase, left both manifests byte-identical, and `fetch:ffmpeg` takes its present-binaries fast path. |
| `niche_bundle` deferred cleanup | Owner: *"leave as is. but add a note to remove it in the future once i start generation on a new work machine."* Notes are in both kind lists and in the status file's **Deferred cleanups**. |
| Paid generation / upload / signed distribution | **Owner-attested, not machine-verified by us.** He reports real paid generation and a real upload already work with an earlier build; he says a Developer ID is not needed. No paid call was made from this repo. |
| Independent review | An **independent audit exists and is unresolved**: [`docs/audit/2026-09-23-independent-audit.md`](../audit/2026-09-23-independent-audit.md) — dated 2026-09-23, scoped to this branch at `734ccd70` / v1.4.219, no code changed, claiming ~90 findings (~26 high/medium) against AGENTS §8, §6 and §4 and challenging the gate evidence. **Treat it as leads, not facts** (the audit says the same of itself): its line numbers are those of `734ccd70`, and this handoff's author spot-checked four concrete claims — the hardcoded `~$0.005` price in `PreviewPromptRow.vue:38` **confirmed**; `'grok-imagine'` **exists but in `generators/images.ts:318`**, not the `routes/images.ts` path cited; `'deepseek-v4-flash'` at `audio.ts:710` **not found** (that id appears only in test fixtures); the frontend statistic is in the right range (168 of 213 frontend test files reference `readFile`/`readFileSync`). Every packet in `docs/handoffs/deepseek-reports/` is otherwise `self-accepted` by its author. |
| Platform coverage | Proven on this **one Mac** (arm64, current macOS, ffmpeg 8.1) only. No Intel, Windows or Linux run. |
| ACCEPT-01 walkthrough | Ran against the repo's **mock** gateway, not a real provider: real cost accounting, real speech timing, a real upload and long-form quality are unproven there. |
| `_trash/` | Now holds only `README.md`; the 1.4.217/218 bundles, the earlier DMGs and the evidence copies are no longer on disk. **Who removed them, and when, is not recorded** — do not infer an agent or the owner did it. The retired commit `8051fc28` itself is still recoverable from Git. |
| SSD copies | Verified on 2026-09-22, before the drives were unmounted. Current contents unverified. |

## SECRETS

**None are in this repo, this file, or any build script.** Do not search for them and do not print them.

| What | Where it actually lives |
|---|---|
| Gateway / provider API key | The app's own secret store — **Settings → This Mac → API keys**; written to `app-secrets.json` under the app's `--user-data-dir` on the owner's machine. Ask the owner; he holds it. |
| YouTube credentials | The owner (connected through the app's own connection flow, never by hand here). |
| Acceptance harness key | The mock gateway publishes its own fixture key (`MOCK_GENSTUDIO_FULL_KEY` in the test fixture). It is a test constant, not a secret. |
