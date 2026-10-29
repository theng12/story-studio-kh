# HANDOFF — Story Studio KH

## 1.4.368 — nine branches in one release (2026-10-29, release/1.4.368 from main dabfff14)

Merged, each verified first with focused runs (PARTIAL, not the gate): store-and-style-fallback,
sketch-provenance, translate-timeline-rebase, channel-slug-import, narration-emotion,
phone-review-approval, hand-lettered-captions, quote-shorts-length-pacing, sketch-colour-in. Only the
CHANGELOG drafts conflicted; they are folded into `## v1.4.368`.

What to know:
- **Translation retimes onto the target narration** (`services/translation-timeline-rebase.ts`):
  scenes keep their chapter and proportional share; Khmer uses script timing, never ASR. Final
  Assembly refuses a translated plan whose timing is still stale and names the scenes
  (`video-assembly-translation-rebase.test.ts`). The owner wants ONE private Khmer listening pilot on
  this build before any other translation; Production runs it.
- **Narration delivery/emotion** (`delivery_instruction`) is offered only where the model's live
  `controls[]` publishes it; a non-empty instruction on a model without it is refused before any
  TTS request. Found while closing gaps: `audio-quality-store.ts` dropped the field from the
  activation record, so one provenance source lost it — fixed. Needs Hub 0.6.209 + Gateway 0.2.208
  end to end. The Breeze licence question is settled by the owner: leave as is.
- **Phone Review** (`/review`): optional per channel (`final_review.enabled`, off by default), reuses
  the existing session cookie and range route, marks stored beside the final with
  path/size/mtime/inode identity; a POST is refused when any of them changed since listing, and the
  hash is bracketed by two stats. Never a gate, never upload authorisation.
- **Hand-lettered Shorts captions** use the bundled Patrick Hand; Khmer falls back to Kantumruy Pro
  with per-line `\fsp0` — non-zero ASS spacing breaks libass Khmer shaping, which also fixed the
  shipped `explainer-accent` look.
- **Colour it in** (Sketch Draw helper 5): the final hold is the exact source picture; depth map is
  optional ordering only (no ISNet — owner), and changing it never stales a clip.
- **Quote Shorts sizing**: words per chapter = Formula minutes × wpm ÷ the episode's own chapter
  count. Open for the owner: the Quote Shorts Formula's fields say 1 min × 120 wpm while its prose
  says ~45 s / 40–90 words; Formula content was NOT changed. New Deep Time Documentary channels now
  seed that Formula's own pacing profile (Formula wins, §5).
- **Studio Library** answers partially with named unavailable sections; an unanswered account is
  `null` (unknown), never the previous snapshot.

## 1.4.367 — a text-to-image model is not refused for having no reference (2026-10-28, fix/t2i-reference-minimum-20261028 from main 7cadb79d)

**Private final render re-pairs itself across a Gateway move (added on the same branch, owner
2026-10-28: "you just do it. repair it automatically" and "make sure remote can go to 1301").**
The pairing (`<userData>/private-render/gateway-binding.json`) pins origin + owner_scope +
gateway_instance_id and had no way out; the identity lives in the Gateway's own sqlite, which a move
does not carry, so after the Gateway moved to its new Mac every remote final render was refused and
went local. Rule now: a **changed configured origin** is the owner deliberately pointing Story at
another Gateway, so `getFinalRenderCapabilities` re-pairs to the identity that answers there
(`repairGatewayBinding` in `services/private-render-identity.ts`, same cross-process lock as the pin;
old file moved to Story's Trash with an index entry, never deleted; `repaired_from` in
`GET /app-settings/private-final-render/binding` feeds the Settings → This Mac note). **An unchanged
origin with a different identity is still refused, never re-paired** — that is the
spoof/replacement case and its tests stay green. Nothing is re-paired while a remote final render is
still in flight (`findInFlightPrivateFinalRender` in `services/job-queue.ts`; `unknown` before boot
jobs load is its own answer and refuses), so the next capabilities call after it settles repairs.
Not done: the Settings note is read on page load only — a re-pair that happens while the page is open
shows on the next open, not live.

Follows 1.4.366, which the owner force-installed on the mini on 2026-10-28 (the mini runs 1.4.366).
Also carries main's two content-only commits (Mythologies Before Us Formula, Webtoon Martial Arts
style). Gate of record: serial, at the merge commit. Production's report: 6 `thumb_images` jobs 0/3 (Domnak DM14–17, Origin
EP17–18) — `qwen-image-2-1-turbo-mflux-q4 requires at least 1 reference image(s); 0 were supplied`.
The live 1301 row publishes `operations: ["text-to-image","image-to-image"]` with
`min_reference_images: 1`, which is the EDIT lane's minimum: the Gateway enforces it only on a request
that sends references (`_refuse_references_this_lane_cannot_take`). Story enforced it on every
request. Fix at the one boundary every reader goes through (`loadImageModelsFromGenStudio` in
`lib/genstudio-client.ts`): the minimum reads 0 when the row publishes `text-to-image`; an edit-only
row keeps it. Regression test in `genstudio-client-boundary.test.ts` (note: the image catalogue is
cached per API key, so each test needs its own key). Limit: a hypothetical text-to-image model whose
edit lane needs 2+ references would now be stopped by the Gateway rather than by Story's pre-check —
still loud, never charged.

## 1.4.366 — YouTube record contract, readable end to end (2026-10-28, fix/youtube-receipts-read-20261028 from main a55c5f12)

Production's ledger adapter found the 1.4.365 contract unreadable; three defects, all fixed:
1. `recordVideoAuditEntries` replaced each entry whole, so every re-read wiped `story_written_at` /
   `story_receipt_id`. A re-read now carries both over from the prior entry.
2. `publicOperation` never returned `metadata_updates[]`; `GET /projects/:slug/youtube/operations` now
   does (only for operations that have receipts).
3. `GET .../youtube/videos/snippets` built its answer from the fresh observations, not the stored
   ledger, so even with (1) fixed it dropped the markers. It now answers from what was stored.
Markers wiped under 1.4.365 are not rebuilt from the audit file; Production rebuilds them from each
operation's append-only `metadata_updates[]` (join on channel + video_id + receipt_id). Note: the
snippets read without `force` still calls YouTube for stale or missing entries — it is not
guaranteed quota-free.
Also: episode-media-cleanup, jobs-stream and job-queue-genstudio-resume joined `SERIAL_TEST_FILES`
(failed in the pooled sweep on a55c5f12, passed alone). Pooled ≠ serial is still unproven; the
gate of record stays `STORY_STUDIO_BACKEND_TEST_WORKERS=1`.

## 1.4.365 — the existing-video metadata update, corrected from Production (2026-10-28, fix/yt-metadata-verify-20261028 from release/1.4.365 ebeb4dd7)

Three defects 1.4.364 shipped, found by Production applying the AWBU/SS0066 repairs on the
installed mini. Evidence: `_orchestra/production-records/metadata-repairs-installed364-20261028/`
(`README.md`, `hash-proof-20261028.json`, `receipts/`, `raw/`, `final-verification-index.json`).

**1. Tag order is not tag content — YouTube reorders, so the verifier must not compare order.**
`sameTags` (`electron/server/services/youtube-metadata-update.ts`) compared the tag arrays
element-wise. **YouTube stores tags codepoint-sorted, not in the order sent**, and Story's own
`cleanTags` preserves input order, so the PUT carried one order and the read-back another. Proof
from the three AWBU videos: the provider's `snippet_sha256` equalled SHA-256 of
`{title,description,tags}` computed over the **sorted** tag list for all three, and never matched
it over the sent order (`hash-proof-20261028.json`; independently re-derived from `intents/` and
`receipts/`). Every successful tag write therefore returned `502
YOUTUBE_METADATA_VERIFICATION_FAILED`, and the same defect made a retry in another order look like
a change worth writing again. `sameTags` is now a **multiset** comparison: same count, same
members, each **trimmed**, **case-exact and order-free**. Case stays significant because the
provider echoed the casing it was sent (the live read-back kept `A World Before Us` and `Yellow
River` capitalised) — a case difference is a difference in what is stored, not a round-trip
artefact. A missing, extra, changed, re-cased or duplicated tag still fails loudly. The no-op
check and the verify call the same helper, so a reordered retry is `changed: false` and sends
nothing.

**The same root cause reached the Library, and was fixed with it.**
`youtube-metadata-comparison.ts` `normalize` compares tags element-wise too, and its own test was
already named "tag order and whitespace are not treated as edits" while the code never sorted. Any
video uploaded with one tag order and read back in YouTube's therefore reported
`youtube_changed` on tags forever — a false statement about the owner's public video on the screen
they use to fix things. `comparableValue` now decides AGREEMENT as a multiset, while `local` /
`last_synced` / `live` keep the values exactly as observed, because the Library shows what is
actually there. Re-verified: a reordered first observation and a reordered steady state are both
`in_sync`; a removed, added or re-cased tag is still `youtube_changed`.

**2. `expected_baseline_hash` could not be computed from any read route.** The route hashes six
fields; the snippets read published a hash over three, and no read route exposed `categoryId`,
`defaultLanguage` or `defaultAudioLanguage` at all. Production had to omit the precondition. The
one hash now lives in `electron/server/lib/youtube-snippet-hash.ts` (`metadataSnippetHash` +
`METADATA_SNIPPET_HASH_ALGORITHM`) and both sides call it: `GET .../youtube/videos/snippets`
publishes it as `snippet_sha256`, names the rule in `snippet_sha256_algorithm`, and echoes the
hashed-but-invisible `category_id`, `default_language`, `default_audio_language`. Send the value
straight back. A ledger entry hashed by the older, 3-field rule (no algorithm label) no longer
counts as current, so the next audit re-reads exactly that video once instead of handing out a
value that could only produce a phantom 409. Nothing stored is rewritten: the ledger is a
rebuildable cache, so the repair is one re-read per affected video.

**3. Record contract for Production's ledger adapter** — documented in the route's code comment
above `POST /projects/:slug/youtube/videos/metadata`, and here:
`youtube/operations/<operation_id>.json` `metadata_updates[]` (append-only, never rewritten):
`receipt_id`, `video_id`, `applied_at`, `applied_fields`, `baseline_snippet_sha256`,
`after_snippet`, `baseline_status`, `after_status`, `verified`, `mismatches?`.
`youtube/video-audit.json` per (channel, video), replace-by-id: `checked_at`, `snippet_sha256`,
`snippet_sha256_algorithm`, `category_id`, `default_language`, `default_audio_language`,
`story_written_at` (**the Story-write marker**, set to `applied_at`), `story_receipt_id` (the
receipt that bumped it). The marker is bumped after YouTube answered and the receipt was durably
recorded, before the response — changed writes only; a `changed: false` retry bumps nothing.
No new store: the revision field Production needed was missing, and `story_receipt_id` is the
smallest addition that lets a marker be joined to its receipt.

No version bump, no gate, no DMG in this commit — focused backend runs only, on a Mac with a Hub
gate running.

## 1.4.365 — Sound & Labels + optional duplicate screening (2026-10-28, release/1.4.365 from release/1.4.364 bb88e785)

Merged two finished branches, in this order:

1. **feat/sound-and-labels-20261028** (7 commits, 97d9e90a..20339d0c, base 2f8600c1) — Contextual Cues and Sound Design become **one page**, `frontend/pages/projects/[slug]/sound-and-labels.vue`, backed by `electron/server/routes/sound-and-labels.ts`. The two old pages are bare redirects (`contextual-cues.vue`, `sound-design.vue` → `navigateTo(..., { redirectCode: 301 })`) and the old API paths answer 410 with the new address. **What did NOT change:** the two file names (`contextual_cues.json`, `sound_design.json`), the two project config keys, the two preset types, and the `contextual_cues` job type and Pipeline step id. Cues become **anchored** — a v2 cue carries `scene_id` + `anchor_word`, and `contracts/cue-anchor.ts` finds the phrase in this episode's own subtitle cues on READ, so no save path can certify a stale time; a v1 cue with no anchor keeps the seconds it was saved with (`unanchored` in `resolveAnchoredStart`). Nothing rewrites a stored v1 file. One auto-approve switch only — the project-level `contextual_cues.auto_approve_cues` is deleted and a stored channel still carrying it is read safely and ignored, never rewritten. Nothing optional blocks Video Assembly any more: an unreviewed/missing/off item is silence plus a stated note, and only a defect approving cannot fix still refuses (`resolveRenderable*` is the single answer). A page READ reports the resolver's refusal in `readiness.*.refuses` and still returns every row.

2. **feat/local-embeddings-20261027** (@2b5f20ca, base 35e9a24c) — optional in-Story duplicate screening with `google/embeddinggemma-2`, **off by default**, downloaded only on request. Runs in Story's own process on `onnxruntime-node` (WebGPU measured ~480 ms vs ~3,100 ms CPU vs ~7,800 ms WASM; CoreML refuses these graphs). Owner's binding decisions, recorded in AGENTS.md §7 as a named exception beside the Wikipedia one: the model runs **inside Story, not on the fleet and not through the Gateway**; it is **optional extra screening, never required**; off/absent/broken reads **"not checked", never "passed"**, and never blocks anything. Files are pinned to one Hugging Face revision and verified by size and SHA-256; partial downloads resume. Two warnings only — near-duplicate scenes in Scene Review and a repeated title when an idea is added. Removal goes through `trashRootFor` (Story's Trash), never `rm`. `electron-builder.json` asar-unpacks the worker so it can run off the main thread.

Conflict/intent notes: `routes/index.ts` mounts both new routers plus the redirected `contextualCues`/`soundDesign` ones; AGENTS.md carries both §7 additions (the local-model exception only — the Sound & Labels decisions live in `docs/architecture/agents-decisions.md`); the Production Board keeps **one column per status field**, so Labels and Sound share a single "Sound & Labels" cell.

Learned at integration:
- **`npm version` was not used, and must not be: the local-embeddings branch had already round-tripped `package.json` and un-escaped the description's `—`.** `source-manifest-integrity.test.ts` pins that escape as the finest-grained signal that the file was rewritten rather than edited; both version strings were edited directly and the escape restored in the same change.
- Re-checked the three shapes 1.4.364 taught us, against the merged code: **(a)** no top-level read of an import-stripped binding in any harness-mounted page (the sound-and-labels page is source-pinned only, and the duplicate-screening badge lives in a computed/function, not at top level); **(b)** no hand-built `_trash` path — `local-model-store.ts` resolves through `trashRootFor`; **(c)** model-drift, typography and security all clean.
- Route order is the trap this page already paid for once (`docs/architecture/agents-decisions.md`): `/sound-and-labels/config` is declared **above** `/:episodeId`, or "config" is read as an episode code.

Static checks on this source: `check:changelog`, `check:typography`, `check:model-drift`, `check:security`, typecheck and lint (0 errors), all exit 0. Once the 1.4.364 gate finished, the focused runs were done: **16/16 backend files (196 tests)** and **40/40 frontend files (319 tests)**, all passing. No ten-step gate and no DMG yet — a Story DMG build was running on main.

**Eight frontend failures surfaced on the first focused run, and none came from the merges** — the page and its test were byte-identical to the branch tips, so `feat/sound-and-labels-20261028` shipped with them already red. `contextualCuesAutoSave.test.ts` was last touched at the branch's first commit while the page kept moving, so it pinned names the page no longer uses (`storedAutoApprove`, `saveTimeline`, `cue-save-state`, `setStatus`, the inline 800 ms delay); `optionalStageHonesty` pinned `STEP_STATUS_FIELD[s.key]` where the Board now writes `[step.key]`. Each assertion's intent was kept and re-pinned. One was a real regression rather than a stale pin, and was fixed on the page: **Save with nothing to save did nothing visible** — it now confirms `Everything here is already saved.` and still surfaces a standing save error instead of a false success. `AUTO_SAVE_DELAY_MS` was restored as a named constant on the page rather than dropping the pin, so the delay figure is one place.

Focused files to run (both branches' new/changed tests, the repo-wide guards a merge can break, and the import-stripping harnesses that mount the pages it changed).

Backend: `cue-anchor`, `sound-and-labels-api`, `sound-labels-v1-compatibility`, `sound-resolver`, `contextual-cues`, `sound-design`, `contextual-cues-proposal-run`, `pipeline-bulk-preflight-cost`, `video-enabled-inputs`, `local-duplicate-screening`, `local-model-store`, `output-contract-declarations`, `executor-registration`, `job-queue-concurrency`, `universal-trash`, `source-manifest-integrity`.

Frontend, branch-owned: `soundAndLabelsPage`, `contextualCuePlacement`, `contextualCuesApproveAll`, `contextualCuesAutoSave`, `contextualCuesCheckpoint`, `audioAreaPlainWords`, `stockSfxGenStudioBoundary`, `workflowRaceGuards`, `presetFieldCoverage`, `deadUiRemoval`, `llmLineupRetired`, `unsavedGuard`, `uxCleanup`, `auditLeftoverRenderNits`, `featureHelpCenter`, `presetCoverageFixes`, `ideasCreativeFlow`, `scenePlanReviewAuditWiring`.

Frontend, harness-mounted pages the merge changed (these strip imports, so a top-level read of an imported binding fails them): `sceneReviewFinishMissing`, `sceneReviewInitialFocus`, `sceneReviewVisionCheck`, `sceneReviewAttention`, `settingsSectionNavigation`, `settingsWorkspace`, `responsivenessGuards`, `formatLoadState`, `pipelineVisualSource`, `presetAuthorityRuntime`, `audioQualityWorkflow`, `pipelineStageSelection`, `pipelinePreflightLeftOut`, `optionalStageHonesty`, `generationGuardVisibility`, `productionBoardJobStates`, `boardSelection`, `workspaceReadFailures`, `episodeDoneAgreement`, `episodeScopedStateReset`, `settingsStorageDecisions`, `trashPage`.

Open: the 1.4.364 gate must finish before any Story test lane or DMG runs on this worktree; the ten-step gate, the `land/1.4.365-into-main` flow, the DMG rebuild from `main` and the push are all still to do.

## 1.4.364 — batch release (2026-10-28, release/1.4.364 from main 0967f1ab)

Merged: episode cost · Quote Shorts phase 2 · thumbnail-test link + free image check (shadow to 2026-11-30, master switch) · translated versions (queued `translate_episode` job, chains the target channel's presets) · video plan (T2V lane approved in Motion Review; unsaved episode = motion OFF, share control starts at 25% opening hook; ai-video.ts and getVideoStatus deleted; clip import accepts any ffmpeg-decodable format, normalised on import) · Still Posts phase 1 (+ fresh drawing per size, default one drawing) · opt-in stronger vision image check (content parts to the Gateway chat lane; per-axis auto-remake locked until shadow end) · YouTube existing-video title/description/tags update (`POST /api/projects/:slug/youtube/videos/metadata`, snippet-only, verified read-back) + read-only snippet audit with a per-channel ledger; Pipeline titles from the preset, idempotent suffix, over-limit refused, empty description refused · background music 6% from one contract + "N music options, standard 10" warning.

Learned at integration:
- Page harnesses strip imports: a TOP-LEVEL use of an imported value (`const X = IMPORTED`) breaks every harness that mounts the page (17 Scene Review tests). Use imported values lazily (inside computed/functions/template), or stub them in each harness.
- The model-drift guard flags running sums of recorded charges and USD formatting; those carry `model-drift-allow` lines with reasons.
- Bundled fonts only worked where hand-installed: macOS draws through CoreText, so the app now copies missing bundled faces into ~/Library/Fonts/Story Studio at boot.
- Open: Production applies the AWBU/SS0066 metadata repairs only after the installed-release notice with the route contract.

## 1.4.363 — recovery leaves accepted finals alone (2026-10-27, release/1.4.363 from main 442a4900)

Merged fix/recovery-skips-accepted-finals-20261027 (22ee9de4): `recoverEpisode` skips an automatic pass when `hasAcceptedFinalVideo` (asset-status.ts, the same `findCanonicalFinal` paths A/E Production Board counts; YouTube-only evidence deliberately not counted) is true, unless the owner asked. Also: three measured load-flaky files joined SERIAL_TEST_FILES (job-cancellation-reconciliation, private-render-owner-admission, video-assembly-remote-wait) ahead of the pooled-vs-serial proof on this commit.

## 1.4.362 — Pipeline Sketch, recovery current-audio guard, remote 3-day keep, topic caps 4000 (2026-10-27, release/1.4.362 from main fe481bd7)

Merged: fix/topic-pack-caps-20261027 (topic arrays 2000→4000; Wars & Treaties 1.0.1 full union needs 1.4.362) · fix/pipeline-sketch-motion-20261027 (sketch_draw Motion Review presets admitted with no video model; scene selection shared via resolveSketchDrawEligibleScenes) · fix/remote-render-keep-20261027 (remote import keeps the replaced final via final-video-retention; Free up space skips _previous_finals/) · fix/recovery-current-audio-20261027 (inspectRecovery checks the merge is current first; level_unit 'linear' marker; unmarked node with music level >1 refused; generator refuses stated music level >1).

Learned: on the 1.4.361 boot the recovery scan re-queued audio merges for finished AWBU EP0001/2/3/5 + NA Science EP0012 (narration-refresh plans whose checks were complete); EP0001/2 carried percent levels (8/5) that would have become an 8× music bed. Those five jobs were PAUSED on the mini; cancel them only once 1.4.362 is installed. `npm version` strips package.json's \u2014 escape every time — restore it after any bump.

## 1.4.361 — integration of the 2026-10-26/27 batch (release/1.4.361 from main fdf821f9, 2026-10-27)

Merged: sleep tiered pacing · narration Reject + provenance + 6% music default · one-list model pickers
(legacy video readers removed) · Khmer narration plausibility · Default models · Sketch Draw reveal per
episode (+ pins) · Quote Shorts · social posting (opt-in, unused) · rules refresh + Sora/Runway scrub ·
Reference to Image (Story side; hidden until a live row publishes reference support) · gain unit +
keep replaced final 3 days · preset coverage audit · fast backend gate · content ship (registry re-chained
to revision 348 via the repo's tools).

Learned at integration:
- The DM0018/PR0039 loud beds came from Production's own direct-API trial driver forwarding preset
  percents, not from the app. Pipeline already divided once; 1.4.361 only centralises that conversion
  and stops a non-numeric level being forwarded raw. Direct API callers must send LINEAR gain.
- The model-drift guard caught `max_reference_images ?? 0` / `|| 0` (R2I) and the Formula aspect enum
  (Quote Shorts). An unpublished reference limit now refuses; the enum is annotated as canvas vocabulary.
- The worker-pool backend lane is merged but NOT yet proven: the gate of record runs
  `STORY_STUDIO_BACKEND_TEST_WORKERS=1` until a serial and a pooled run agree on one commit (AGENTS §10).
- Open: the remote-render import still hands a replaced final straight to Story's Trash (no 3-day
  window); `illustrated-history-for-sleep` 1.0.0's 1.4.250 floor cites a field its document never
  carried (likely over-pinned; left as authored); the dead `align_visuals_to_chapters` preset key is left
  (harmless, §5 forbids rewriting).

## 1.4.361 — the Sleep starting rhythm is four tiers, carried by the Sleep Formulas (2026-10-26)

Owner, 2026-10-26 (product answers, item 1): *"Sleep pacing, for ALL sleep channels from now on: 0–3 min a scene every 5–10 s; 3–5 min every 10–20 s; 5–10 min every 20–30 s; after 10 min every 50–60 s. Applies whether the motion is stills or Sketch Draw. Delivered as the Sleep Formula's starting rhythm, so every episode can still change it in Scene Plan. Never rewrite stored episode or project data."*

New optional series-formula field `starting_scene_pacing` — the existing `variable` periods shape (`contracts/pacing.ts`), validated by `StartingScenePacingSchema` in `content-packs/schemas.ts` (first period at 0, contiguous, only the last open, 1–60 s), mapped in `content-packs/legacy-adapters.ts` onto `Niche.startingScenePacing` (`models/types.ts`), and copied at creation by `services/formula-starting-defaults.ts` into a NEW channel's `config.json` `default_scene_pacing` through `parseScenePacing`. Tiers supersede `starting_scene_seconds` when a Formula declares both; the band stays valid everywhere else. The 2026-10-19 owner standard seed is untouched, the seeded "Owner standard pacing" preset is untouched, an episode's own `continuity.json` pacing still wins through `claim_pacing`, and no stored channel or episode is rewritten.

Tiers ship in `electron/server/niches/sleep.json` (the alias fallback) and in five successor pack sources — Sleep Story `sleep-story-v1.0.3`, Sleep History Compilation `sleep-history-compilation-v1.0.2`, Calm Science for Sleep `calm-science-for-sleep-v1.0.1`, Mythology for Sleep `mythology-for-sleep-v1.0.1`, Illustrated History for Sleep `illustrated-history-for-sleep-v1.0.1`. Each replaced `starting_scene_seconds` with `starting_scene_pacing` so it states one rhythm. Registry: reserved at revision 327, authored at 328–332; `legacy-migration-dispositions.json` `niche:sleep` follows 1.0.3; `docs/catalogue` regenerated (its 2026-10-24 drift came with it).

**Release classification: application, not content-only** — the currently released runtime does not support the new schema field. Consequences handled here: `package.json`/`package-lock.json` 1.4.361 and this CHANGELOG entry. The five successor packs carry an **explicit `min_app_version: "1.4.361"`** in `pack.json` and in their registry records (`min_app_version_status: "fixed"`, which `validate` requires to match the manifest), because the series-formula schema is `.strict()` and an older build rejects a document carrying `starting_scene_pacing` rather than ignoring it. **`content-packs/release-floor.json` stays at 1.0.843** — it is substituted into every other pack, so raising it would hide 50+ Formulas and the Custom Looks from 1.4.359/1.4.360 for no reason (coordinator, 2026-10-26). The previously published versions of these five stay installable on every build.

Tests: `formula-starting-defaults.test.ts` now pins the tiers on the niche and all five sources (and the precedence chain); new `sleep-tiered-starting-pacing.test.ts` pins each boundary (≤179.9 s 5–10, 180 s 10–20, ≤299.9 s 10–20, 300 s 20–30, ≤599.9 s 20–30, 600 s+ 50–60), contiguity, the open final tier and the never-faster-as-it-lengthens direction; `free-starter-inventory.test.mjs` pins the seven `-v1.0.3` roots (six were the 2026-10-25 modernization's, previously unpinned); `formula-chapter-pause` / `narration-paragraph-pause` read the current Sleep Story source. Content-pack lane files run individually here: registry 41/41, publisher-tools 24/24, inventory 3/3, dispositions 1/1, illustrated-history 6/6, sleep-history 5/5. Not run in this worktree: the full gate, the DMG, the land-to-main flow, and any store ship — a Story gate was running on this Mac. The five successor packs must not be shipped to the Library before 1.4.361 is out.

Open: the seeded "Owner standard pacing" preset still carries the 2026-10-19 tiers on a Sleep channel while its `default_scene_pacing` now carries the Sleep tiers — the preset is what the timing panel shows as "last used", so a Sleep channel's panel can display the standard tiers until the customer saves a rhythm. Not changed here because that preset is the owner's known artefact, not a Formula output.

## 1.4.361 (part) — Facebook, Instagram and TikTok posting, strictly opt-in (feat/social-posting-20261027, from main fdf821f9)

Owner decision 2026-10-27: build posting to Facebook (Page video), Instagram (Reels) and TikTok (Direct Post).
**Strictly opt-in.** A channel connects accounts and ticks which platforms it posts to; every upload shows those
ticked and posts to nothing unticked. The owner has no accounts yet, so the feature is built, tested against
recorded responses only, and deliberately unused.

**Shape.** `contracts/social-publishing.ts` (platforms, error codes, receipt types) ·
`services/social-connection-store.ts` (applications + accounts registry, mirroring the YouTube one) ·
`services/app-secrets-store.ts` `social` bucket (encrypted, redacted, strict parse; a plaintext bucket is
refused rather than rewritten) · `lib/social-oauth.ts` (loopback flow per provider) ·
`services/social-connect.ts` (connect + credential resolution, TikTok refresh with rotation persisted) ·
`lib/social-publish/{types,meta,tiktok}.ts` (one adapter per platform behind a single fetch seam) ·
`services/social-publish-sidecar.ts` (`social_publish.json`, one receipt per platform) ·
`generators/social-publish.ts` (the job) · `routes/social-publishing.ts` ·
`components/SocialPublishingSettings.vue` + the review dialog's tick box on `upload/publish.vue`.
Job type `social_publish`, one queue lane. Channel keys `social_accounts` and `social_platforms` live in
**config.json** (publishing settings, beside the YouTube category), not project.json.

**Completion contract (§8).** Done means every ticked platform has a receipt with the platform's own post id.
A partial run fails loudly, names the platforms, keeps the receipts that exist, and says Retry posts only the
missing ones. A platform answering without an id is a failure. Specs (aspect, duration, size) are checked
BEFORE any byte is sent, so a 16:9 render is refused in words rather than failing at the provider.
**Never double-posts:** the receipt names the exact source revision (`sha256:…`); a retry skips a platform
whose receipt matches the file. A re-rendered episode is a different file, so it posts again — that is a new
post the owner asked for, not a duplicate.

**Owner setup checklist (nothing works until this is done, and nothing posts until he ticks it):**
1. **Meta app** — developers.facebook.com → Create app → add **Facebook Login** and the **Instagram Graph API**.
   In Facebook Login → Settings add the Valid OAuth Redirect URI `http://127.0.0.1:41234/callback` (exact
   match; Meta requires HTTPS for most apps and may refuse this loopback URI — if so, register the HTTPS URI
   of a small relay and change the saved redirect URI here; the app does not assume loopback is accepted).
   Permissions to request: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`. Paste the client ID and secret into Settings → Connections →
   Facebook/Instagram.
2. **Instagram account type** — must be a **professional (Business or Creator)** account linked to a Facebook
   Page. A personal account cannot publish via the API.
3. **Meta App Review** — `pages_manage_posts` and `instagram_content_publish` need Advanced Access for accounts
   that are not the app's own testers. Until then only accounts with a role on the app can post.
4. **TikTok app** — developers.tiktok.com → Create app → add **Login Kit** and the **Content Posting API**, turn
   on **Direct Post**, and request the **`video.publish`** scope. Register the redirect URI
   `http://127.0.0.1:*/callback` (TikTok's desktop Login Kit allows a wildcard port on loopback). Paste the
   client key and secret into Settings → Connections → TikTok.
5. **TikTok audit** — until the client passes TikTok's audit, every post is restricted to **private viewing**
   (`SELF_ONLY`). The job says so in its log when the creator-info call offers only that level.
6. **Per channel** — Settings → Connections: connect the accounts. Settings → Publishing → *Where this channel
   posts*: tick the platforms. Then each upload's review dialog pre-ticks them and you can still untick.

**Rate limits the owner will meet (published by the providers, not invented here):** Facebook 30 API-published
Reels per Page per rolling 24 h; Instagram 100 API-published posts per 24 h; TikTok 30 status polls per minute
per token.

**Not done / open.** No real network call has ever been made to any of these platforms; every test uses
`__tests__/fixtures/fake-social.ts`, which FAILS on an unqueued request rather than falling through to `fetch`.
Nothing has been verified against a live account, so the first real connection is the first real test — expect
one round of provider-specific corrections. The `social_publish.json` sidecar is not yet in the backup
classifier's special cases (it is not media, so it lands in `records` — correct, but unasserted). Per-platform
caption editing is carried by the API (`captions` in the publish body) but the page does not yet expose fields
for it; the episode's YouTube title and description are the default. Facebook Pages also need the `CREATE_CONTENT`
task on the Page, which the account list does not verify.

## 1.4.360 — Sketch Draw v2, channel Formula/search/recency, refused-render restart and Cancel (2026-10-26, prepared on release/1.4.360 from main 16648a51)

Three merges, no squash: `feat/sketch-draw-v2-20261026` (b0c9f74d + 33b1e98a; owner approved it as-is — "perfect, i love it"; five reveal types, deterministic Mix, channel-wide setting with per-scene override, staleness compares the type this scene resolves to so older clips stay fresh), `feat/channel-search-formula-recent-20261026` (307d6ab8; `formula_name`/`formula_id` stamped on GET /projects from ONE catalogue lookup, search folds the name/ids Khmer-safe, `services/channel-recency.ts` walks episodes with a 10 s UNKNOWN bound and a 60 s cache), and `fix/refused-render-restart-20261026` (14dc367f; a refused render that finished locally is done across a restart). `feat/render-display-20261026` and `feat/ref-to-image-20261026` are deliberately NOT in this release.

Bug A — Cancel on a refused `video_assembly` row never cancelled. A refused receipt keeps `gateway_job_id: null`: the Gateway accepted nothing and the row is this Mac's own render. But `classifyProviderJobControl` treated EVERY marker row as a remote wait, so the control was `request-remote-cancel` with no targets; `requestJobCancellation` then skipped its final-render branch (`hasFinalRenderFence` is false for a refused row) and `queueRemoteCancellationTargets(job, [])` wrote the row `running` with no cancellation recorded. `listFinalRenderReconcileCandidates` reads every running marker row → `resumeRefusedFinalRenderLocally` → queued → pump → the episode rendered again. Fix, at the shared predicates: `isRefusedFinalRenderReceipt` lives in `lib/final-render-remote-wait.ts` and `isRefusedFinalRender` uses it; a refused row now takes the ordinary LOCAL controls (`stop-local` while it waits/runs, finished rules once it ends), `requestJobCancellation` refuses the receipt-writing remote path even under a transient hold, and `stopLocalJob` drops a queued refused row from the lane, clears its stale fence, SIGTERMs any child and announces the stop. Receipt, accepted final, its folder and the work folder are untouched; no render starts.

Bug B — a refused row a re-render ended in `error` with `FINAL_RENDER_ACCEPTED_FINAL_CONFLICT` ("Local fallback preserved the accepted final video; its new render remains in the work folder."; production: seven Wonder rows + MANU0001) now settles `done` when the row's own evidence says its earlier completion is the one true answer — the same rule 14dc367f uses: `result.complete === true` + `result.completion.complete === true`, no remote terminal digest, and the exact `<CODE>_final_video.<single ext>` present, regular, non-symlink and non-empty in `output_dir`. Applied both when the conflict is recorded (`runJob`'s failure branch) and in the boot scan; the row's log announces it, no file is moved. An incomplete result, a missing published final, an unreadable folder or a different failure stays `error` (never a guess). The conflict message is now one shared constant (`FINAL_RENDER_ACCEPTED_FINAL_CONFLICT`).

Open / notes: the Bug B settle marks the row done but, like 14dc367f's boot settle, does not advance a captured `pipeline_chain`; no production row in this class carries one. The mini's existing 7 Wonder rows + MANU0001 repair themselves on the first boot after this build is installed (they need the install, not another render). No full gate was run from this branch (the orchestrator runs it): focused only — `final-render-sealed-transport` 49/49 exit 0 (new tests proven failing-first: 47 pass / 2 fail against da1c0640), `job-control` + `video-assembly-remote-wait-state` 17/17, `job-cancel` 98/98, `final-render` 215/215, `job-queue` 156/156, `sketch-` 83/83, `channel-formula-recents` 13/13, frontend merged-feature tests 69/69, `npm run typecheck` exit 0. A fresh worktree needs `node_modules`, `frontend/node_modules` and `bundled/ffmpeg` symlinked from the main checkout (ffmpeg is untracked).
**Current state — 2026-10-26.** This file is the cold-start briefing. `AGENTS.md` is the rulebook
and `docs/architecture/agents-decisions.md` says why; if this file disagrees with the code, the
code wins and this file gets fixed.

| Thing | State |
|---|---|
| Current release | **1.4.359** — on `main` and installed on the mini. |
| In gate | **1.4.360** — release worktree `release-1.4.360`; ten-step gate C running, evidence `_orchestra/app-closeout-20261021/story-360-gate-c-20261026/gate`. Not released, not installed. |
| Next | Ship 1.4.360 through the whole cycle (prebuild → ten-step gate → land on `main` → rebuild from `main` → publish → the mini installs through its normal guarded updater on its next check-in; force-install retired by the owner 2026-10-26). |
| Gate | The ten-step `story-final-gate`; runner `_orchestra/app-closeout-20261021/story-final-gate-tools/run-gate.sh`. `ship-story` refuses to publish without its proof. See AGENTS §10. |
| History | Older entries (1.4.356 and back) and the pre-2026-10 working-loop notes are in [`HANDOFF-archive-2026-10.md`](HANDOFF-archive-2026-10.md), kept as a verbatim historical snapshot. |

**NEW-11, 2026-10-26 — the recurrence.** The main checkout's `package.json` was again found in
packaged shape (no `scripts`, no `devDependencies`) after a `dist` build, and was restored with
`git checkout`. The cause is known, not mysterious: `npx asar extract-file <app>.asar package.json`
writes the extracted file into the **current directory**, so run from the repo root it overwrites
the source manifest — see `scripts/release/release-utils.mjs` and
`electron/server/__tests__/source-manifest-integrity.test.ts`. **Suggested guard, not implemented
here:** after every build, fail loudly if `package.json` has lost `scripts` or `devDependencies`
(the existing snapshot/restore only logs, so a recurrence is still silent).

## Working rules that still hold

- **Never `rm`. Every removal moves to `_trash/`** — the owner's words, covering your own cleanup
  as much as his requests; keep the sub-structure and say where it went. `_trash/` itself is the
  owner's and may be emptied at any time.
- **Never rewrite published history.** To delete a branch or ref, record its name and SHA in a note
  under `_trash/` first.
- **Strip `ELECTRON_RUN_AS_NODE`** when launching Electron (dev or packaged); with it set the app
  exits immediately with no output and looks broken.
- **Do not package from a symlinked-`node_modules` worktree** — electron-builder does not follow it
  and the app ships with no runtime dependencies (the v1.4.68 defect).
- **Put `bundled/ffmpeg` on `PATH`** before any run that generates or assembles audio; otherwise
  you get `spawn ffmpeg ENOENT` and assembly blocks with a precise missing-file list.
- **Rebuild and restart after backend edits** — the app runs compiled output, so a source edit alone
  changes nothing you can observe.
- **No wallclock sleeps in tests.** Use `waitFor`; a fixed sleep asserts the scheduler, not the
  product.
- **TTS parts are sized by the model's published character limit, and by nothing else** (owner,
  2026-09-26); the lane's own `deadline_seconds` comes from Studio Hub, and Story adds no internal
  spoken-minutes cap.
- **A window of scenes is ONE response, so the output ceiling sizes it too.** Before adding any
  batch, ask what one response can carry.
- **A provider's `finish_reason` can lie; usage does not.** Treat "usage ≥ the ceiling the request
  asked for" as truncation, whatever the reason says.
- **Gates cannot see geometry, CSS or dev wiring** (AGENTS §3). Episode state must not survive an
  episode change (§4). Provider is display, never dispatch (§2). `pacing` and scene rhythm
  decisions are in §5 — do not "fix" them back.
- **After any packaging run, `git status` must be clean.**
- **`npm run check:changelog` must pass** — runtime version, lockfile and the newest What's New
  entry have to agree. **Typography gate:** no source text below 12px. **Model-drift gate:** no
  hardcoded catalogue values outside annotated exceptions.
- **Content Packs:** one unrecognised kind discards the whole catalogue, on both sides. Local→wire
  kinds: `series-formula→series_formula`, `topic-pack→topic_pack`, `visual-style→visual_style`,
  `thumbnail-recipe→thumbnail_recipe`, **`lettering-style→font_pack`**, `metadata-formula→metadata_formula`.
- **Story Studio talks to exactly one endpoint** — the owner's `gateway-kh` (`http://127.0.0.1:8787`
  default). Never a second address.

---

**Release history — the three latest entries, in full:**
## 1.4.361 (part) — faster backend gate: worker pool + measured slow-file waits (2026-10-26)

Owner decision, 2026-10-26: "do all 4 if possible so it's faster." The 1.4.359 gate took ~2.5 h
(backend 5,250 s of the 5,400 s watchdog, frontend ~510 s, content-packs ~600–900 s). This branch
(1) runs the backend lane across a bounded pool of worker processes and (2) shortens the waits in
the slowest files through seams the code already had — no assertion removed, no fixture shrunk.

**Where the backend time actually was.** Per-file durations recovered from the 1.4.359 gate log
(`_orchestra/app-closeout-20261021/story-359-main-gate-c-20261026/gate/07-test-backend.log`) by
segmenting the spec output at file boundaries and summing each file's top-level entries; the sums
add to 4,668 s + 854 × ~0.7 s of process boot = the 5,250 s the run reported, so the ranking is
sound. Top files: `youtube-upload-center-route` 649 s, `final-render-import` 210 s,
`episode-media-cleanup` 200 s, `paid-image-replacement-integration` 167 s, `closing-tail-remix`
155 s, `subtitle-recovery-engine` 148 s, `final-render-monitor` 123 s,
`final-render-sealed-transport` 117 s, `audio-dead-result-fresh-request` 97 s,
`genstudio-client-boundary` 68 s. Nothing was 100 % idle: the biggest single cause is REAL waits
inside jobs — the free-fleet auto-retry schedule (60 s then 300 s), the GenStudio poll ladder's
1 s floor, and the 15 s TTS/image route retry base — paid once per attempt by tests that only care
what the second attempt does.

New test-only seams (production defaults untouched):
`_setJobAutoRetryDelaysForTesting(ms)` in `services/job-retry-policy.ts` replaces each delay's
VALUE and keeps the list's LENGTH, so `max_attempts` and eligibility still prove the same thing, and
`_setGenStudioPollLadderForTesting(ladder)` in `lib/genstudio-client.ts` moves only the wait between
polls (cap, jitter, server-hint floor, cancellation and deadline clamp all still apply). The
existing `STORY_STUDIO_TTS_RETRY_BASE_MS` / `STORY_STUDIO_IMAGE_RETRY_BASE_MS` overrides stay as
they were. Files that ASSERT the schedule (`job-retry-policy.test.ts`,
`paid-image-replacement-integration.test.ts`'s "waits about a minute", `genstudio-poll-backoff.test.ts`)
are deliberately left on the real numbers.

Measured so far: `audio-dead-result-fresh-request.test.ts` 105.8 s → 25.6 s (5/5 passing, same
tests), from the retry schedule (105.8 → 48.9 s) and then the poll cadence (48.9 → 25.6 s).

**The pool.** `run-backend-tests.mjs` now plans one node invocation per worker
(`min(4, cores/2)`, `STORY_STUDIO_BACKEND_TEST_WORKERS`), deals files longest-first by a measured
hint table, gives each worker its own HOME/TMPDIR sandbox and coverage file, holds each worker's
summary lines back so they stay one contiguous block, and runs `SERIAL_TEST_FILES` alone
afterwards. Every invocation is still judged by `assertSummaryAgrees` and its own coverage floor;
a split run additionally prints `aggregate suite coverage: C/D file(s) completed; inputs=[...]`,
which `story_gate_proof.py` already accepts (it is the release lane's partitioned shape). One
worker is byte-compatible with the old serial runner.

Status: proof runs pending (serial 1× and parallel 3× on this Mac, no other suite running).

**Watchdog default raised to 180 minutes.** The old 90-minute
`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS` default sat BELOW the ordinary serial runtime — measured
5,268–6,189 s (88–103 min), the 1.4.359 accepted run's `duration_ms` 5,249,875, and one earlier
1.4.359 run at 7,534 s — so the 1.4.359 gate A run was killed at 850/854 files with zero failing
tests and no summary: a machine setting reading as a product defect. The default is now 180 min
with those figures in the comment. The kill is unchanged and a killed child still prints no
summary, which `assertSummaryAgrees` already treats as a failure. Each invocation of the pool gets
its own limit (expected ~30 min of work against it).

## 1.4.359 — extension requests take the model's published cap; chapters-per-request setting; expansion failures are loud (2026-10-26)

Production (Komsan, Khmer, 2026-10-25): expansion jobs 38ca3df6 / 862fed60 / b2bc6196 / ec973e7a / 71e2f3c3 and the single-chapter 0857b744 all ended `finish_reason: max_tokens`. Root cause 1: `batchOutputTokenEstimate` sized every expansion request from `words × 2.5 + 2,048`, floored at 8,192 — a 2-chapter Khmer batch asked for exactly 8,192 against a product publishing 128,000. Khmer is written without spaces, so a "word" is a clause and tokenises several times heavier than English; no words→tokens ratio can be safe, and AGENTS §1 forbids one. Root cause 2: `expandListicleParallel` swallowed every per-batch error as an output line and `generateExpandChapters` skipped the completion rule entirely for a `chapters_to_expand` run, so a provider failure ended `done` with 0/8 chapter files (AGENTS §8). Fix: `expansionOutputTokenCap` / `expansionRequestOutputBudget` ask for the product's WHOLE published `max_output_tokens` on every expansion request, **including the single-chapter repair**, bounded only by `min(max_output, context_window_tokens − prompt tokens)` from published figures (chars/4 prompt estimate; a prompt that cannot fit throws and says so). Owner, 2026-10-25: "if Haiku is able to churn out more output, why are we even limiting it?" Deleting the estimate also deleted `BUDGET_TOKENS_PER_WORD` / `BUDGET_OVERHEAD_TOKENS` / `BUDGET_FLOOR_TOKENS` / `BUDGET_ROUNDING_STEP` / `SINGLE_CHAPTER_REPAIR_OUTPUT_TOKENS` / `batchSizeForBudget` — grep shows no other callers. The request uses tier `maximum`, never `workload`, because `workload.minimumTokens` is what Studio Hub sizes a job deadline from (a 128k expectation would make every batch a four-hour job). Truncation now splits: finished chapters are kept (the unproven final block never reaches disk), the unfinished ones are halved and re-requested and the log says so; a single chapter that still truncates is named in a failure. The listicle path collects every unwritten chapter and throws through `carryOnWithoutChapters` (default `block`) naming them, with the count written and the "Retry writes only the missing" sentence. `generateExpandChapters` now hard-fails a FILTERED run that lost a chapter it was asked for (`missingRequestedChapters` + `requireJobCompletion`, so `result.complete = false` feeds the queue backstop) while still allowing the unfiltered whole-script rule to stay behind its safety check.

"Chapters per request" (owner, 2026-10-25: "maybe 3 chapters each time. Make that the default but adjustable"): two modes in `ExpansionBatchSetting` — `count` (default: this format's own value, 3 narrative / 8 listicle, i.e. unchanged) and `length` (a USER-SET word budget over the outline's own per-chapter targets; a chapter longer than the budget goes alone). `planExpansionGroups` groups; `policyChapterGroups` now takes planned groups instead of a batch size. UI on the Script Generator (`chapter_batch_mode`, `chapters_per_request` 0 = format default, `chapter_batch_words`, hint "Fewer chapters per request is safer for long or Khmer chapters."), snapshot into `script_presets` (reusable configuration, AGENTS §5), remembered per Mac via `useRememberedForm`, validated in `scripts.ts` (0..10 / 0..100000), sent by `OutlineReviewPanel`, and carried into both Pipeline `expand_chapters` links. The executor reads it from the REQUEST before the outline sidecar, deliberately opposite to every other script field, because it is live configuration rather than episode state. `computeParamsHash` does not include it, so changing it never rebuilds a cached outline.

Also 1.4.359, the gate itself: the backend watchdog (`STORY_STUDIO_BACKEND_TEST_TIMEOUT_MS`, default 90 min) is now marginal — 1.4.358 needed 5,352 s of 5,400 and the first 1.4.359 run was killed at 850/854 files; the accepted run (c488c165: 8817 tests, 8812 pass, 0 fail, 5 skipped, exit 0) took 7,534 s with the watchdog raised to 3 h. Raise the default or split the slow YouTube files before the next release. Final-composition tests need `bundled/ffmpeg` (untracked) — a fresh worktree must symlink it from the main checkout or those tests fail for the environment, not the code. Routes that `sendFile` from the app data dir pass `dotfiles: 'allow'` because the harness lives under `.test-work`; each path is server-resolved (no request-supplied path reaches them).

Also 1.4.359: a scoped chapter-only write now merges into `chapters_done`. KOM3 Chapter 7 was written in 1.4.357 with all eight files on disk while the sidecar stayed [1,2,3,4,5,6,8]; `recordVerifiedChapter` re-reads the sidecar and applies the same two proofs `validChapterNumbersForOutline` applies (file non-empty, written for THIS outline) before merging, and returns a reason instead of marking when either fails. Deleted prose: the `quote_language_reservation` / "GenStudio holds credits for the requested ceiling" note is gone from `chunked-narration.ts`; a read-only audit found zero call sites for that mechanism in story-studio-kh, gateway-kh or studio-hub-kh, and every chat row in the captured catalogue publishes 0 credits per million tokens. `output-token-budget.ts` carried the same claim in its CREDIT IMPLICATIONS block; it is removed too, replaced by a note recording what the audit found.

Also 1.4.359 (other merges): Series Formula mandatory at creation — `formula_choice: 'selected'|'generic'` on project.json, absent = never chose (the prompt is for it; never auto-assign). Legacy bare ids read through `LEGACY_FORMULA_ALIASES` in niche-loader (read-time only; nothing on disk rewritten; legacy file answers with a warning if the store pack is missing). Owner custom Formulas adopted as `com.storystudio.formula.wildlife-under-pressure` / `coffee-jazz-ambient` / `a-world-before-us`; their old ids alias. Studio Library replaces the Content Store page (`/library`; `/content-store` redirects; purchase/quote routes deleted, the journal is still read). Thumbnails default to 3 (one shared default; completion = each episode's recorded count). Channel labels/search/sort; channel style previews exactly three, keyed by style text, settled failures move the retry key deterministically (`base:retry:<n>`). TTS alias follows `legacy_ids`; narration staleness compares chapter text. Intro redesign + episode story context; ideas follow content language; continuity no longer caps style_bible/negative_prompt; render profile v2 accepted and pinned; test harness live work under `.test-work`.

Open: `docs` for the by-length mode's default (1,800 words) was chosen to equal today's approximate 3 × 600 grouping; the owner has not stated a preferred number. The frontend lane run for `scriptWorkspace` was still in progress at handoff.

## 1.4.358 — remote-render refusal goes local, Sketch Draw stall bound, starting rhythm, auto-approve default (2026-10-25; includes the unreleased 1.4.357 below)

Remote render root cause (WI0005/7/8/9/10/11/12 + MANU0001 parked): the Gateway profile `retained-classic-no-font-candidate-v1` publishes execution_bounds working_fps [24] / canvas 1920x1080 only; Story sent 30 fps packets without checking, the Gateway answered 409 RENDER_PROFILE_MISMATCH, Story filed it as send_unknown, the by-key lookup 404'd, and lookup_not_found could never leave. Fix: `privateFinalRenderBoundsViolation` preflight in `preparePrivateFinalRenderDescriptor` (live bounds, §1) keeps such videos local with a reason; `FinalRenderHttpError.code` + `isDefiniteFinalRenderRefusal` → new phase `refused` (events `post_refused`, `lookup_refused`), validator and job-queue mirror updated; lookup_not_found + http-class post_unknown + RENDER_NOT_FOUND ≥ `FINAL_RENDER_REFUSAL_LOOKUP_GAP_MS` after the first absence → refused; network-class stays held. The reconciler resumes refused rows locally on the same job id (`resumeRefusedFinalRenderLocally`); `publishLocalFinalVideo` publishes exclusively so a fallback never replaces an accepted final. `runningJobsThatWouldNotResume` no longer counts durable ID-null parked holds (they blocked the updater drain). Remote stays OFF on the mini (owner) until the profile is widened beyond 24 fps and a real 30 fps proof passes. Sketch Draw: helper checks AVAssetWriter status every wait (fail fast with its error), backstops 300 s/frame and 180 s finish (worst healthy wait measured 38.9 s under 8 concurrent VideoToolbox encodes), batch retries a timed-out scene once. Continuity: an episode's first save (whole-config without pacing, or motion-scope creating the file) writes `readProjectStartingPacing`. Auto-approve: `autoApproveOn(value) = value !== false` everywhere a generated scene image's approval is decided (owner: everything generated is approved).

Thumbnail text style `'none'` (Manu, 2026-10-25): `resolveTextStyle` maps any unknown treatment id to `TEXT_STYLES.gold`, so `thumb_text_style:'none'` produced "Render the exact title … golden glow". Now `thumbnailPromptClauseTexts` skips the title clause for a `'none'` text style, and `generateImagePrompts` maps it to headline `'none'` over a recipe default. The real no-text switch is still `thumb_headline_mode:'none'`. Auto-approve default-on also changed what tests must seed: a test that needs a scene left unapproved must save a Scene Review preset with `auto_approve_generated:false` (`liveSceneAutoApprove` reads the channel's live setting and now approves when none is saved).

## 1.4.357 — thumbnail text layer, scoped chapter edit, honest subtitle/render/music messages (2026-10-25)

Text layer (owner's Khmer thumbnail ask): contract `contracts/thumbnail-text.ts`; renderer `lib/thumbnail-text-render.ts` (sharp + fontconfig from `bundled/fonts`, `fonts.json` hashes verified; Battambang hash typo fixed, all 5 fonts byte-identical to upstream Google Fonts); routes `routes/thumbnail-text.ts` (fonts, builtin presets, preview = PNG + `X-Thumbnail-Text-Report`, apply, variants, suggestions); bare source filename inside this episode's own thumbnail folder (§4); variants carry a sidecar and go stale by source SHA-256, never mtime; `upload-metadata.ts` refuses a stale pinned variant; suggestions use the active Thumbnail Prompts preset's model and refuse plainly without one (§1); presets keys `thumbnail_text_presets`/`thumbnail_text_last_preset` are look-only (§5); `thumbnail_text_layer_enabled` per channel. Scoped chapter edit (production, MANU0002 Ch04/05): `PUT …/chapters/:n/content {text, expected_sha256}` (GET returns `sha256`), old files to `_trash` via `manualPromotion`, writes one chapter, rebuilds combined narration, writes `${code}_${slug}.text-edit.json`; ONLY a marked chapter makes its merged audio (`script-changed:`), subtitles and stitched timeline stale — no marker = exactly the pre-1.4.357 rule (an independent review caught that a plain mtime rule would have blocked finished episodes); resolved Script folder threaded through every caller. Subtitles: `subtitle_method_reason` on script-timed results; Khmer stays script-timed by default — whisper-large-v3-turbo publishes km but returned unusable Khmer on 2026-10-25 (cause open: model vs VoxCPM2 audio; owner to approve one known-good human clip test). `preparePrivateFinalRenderDescriptor` logs the switch-off case (§7). Scene Plan refuses a music episode first thing, non-retryable. Open: 8 remote assemblies parked on the mini because the Gateway refuses the create (cause logged from Gateway 0.2.199); Sketch Draw helper 600 s timeout in batches (hypothesis: VideoToolbox contention).
