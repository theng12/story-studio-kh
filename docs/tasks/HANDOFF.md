# HANDOFF — Story Studio KH

### Release 1.4.383 shutdown evidence — R5 preparation (2026-11-06)

- Independent process-command inspection found no packaged process from the release-383 worktree after R4; the retained smoke sandbox still exists and its running flag is absent. The host Node v26.8.2 consumed-fetch/idle-HTTP test completed ordinary `server.close()` in 0 ms with a 5,000 ms keep-alive timeout, so idle keep-alive is not an established cause. Do not apply a speculative idle-connection fix. The smoke failure now records its owned PID, TERM stage and observed exit state, plus only the last 20 shutdown-marker lines, excluding the raw output tail. Main-process markers surround quit/unload dialogs, server close, persistence drain and final quit. Independent focused verification passed 7/7 tests across two suites, actual exit 0, no skips/cancellations, including marker filtering/bounds, TERM-only stopping and sandbox retention; whitespace check exited 0. This is diagnostic work, not a proven shutdown correction. The 5,000 ms TERM-only contract and quit behavior remain unchanged. Preserve existing fixtures and sandboxes. Prepared R5 runs fresh lint, full types/frontend, normal prebuild and only then the complete exact-source gate; main integration and publication still require passing proof.

### Release 1.4.383 R4 — prebuild shutdown smoke failed; canonical gate not started (2026-11-06)

- R4 detached pipeline at clean `c8e6dcce4c2c156c3e7c7cdcfb04bbfbbea96ddc`, tree `f6e489955a8416db9e4c64980e8de8dccbf7640f`, exited 1 at prebuild after lint, full types and frontend preflight exited 0. Electron packaging and DMG creation completed, but artifact verification failed because the smoke-test packaged app did not exit after SIGTERM within 5,000 ms. The verifier reported it left the app running, sent no SIGKILL, and retained `/var/folders/p8/wwyv7rc96s51h1b1rrx6scmc0000gn/T/story-studio-smoke-KViTmZ`. Preserve that evidence; reconcile the owned smoke process and diagnose shutdown before another launch. Do not raise 5,000 ms or add SIGKILL/retries. No canonical R4 gate or gate result exists, and no passing artifact, main integration or publication is claimed. Evidence: `_orchestra/story-lead/release-383-20261106/prebuild-r4.log` lines 454–461 and actual pipeline/prebuild exit files. Existing fixtures remain untouched per Developer's confirmation that there is no exception to the owner's Trash rule. 384 will move retained harness fixtures outside Trash with bounded retention and one small test; do not change retention during this release.

### Release 1.4.383 gate R3 — measured cache-test flake; serial correction required (2026-11-06)

- Fresh preflight lint, full typecheck/frontend and normal prebuild exited 0. Canonical gate R3 at `c2670a960f0181442b1cb5e8864b2a063cb36913`, tree `8a9fac275c70d5ad27df8898a62a33766fc4e63d`, exited 1 at backend step 07: 984/984 files completed, 10,371 tests, 10,368 pass, 1 fail, 2 skip. Source stayed unchanged and seven log hashes were independently verified. Only `episode-status-cache.test.ts` failed at line 452, `persistence: flushProjectNow writes a file readable by a fresh cache`, asserting `served from hydrated entry`. Steps 08–10 did not run. The exact unchanged file then passed alone: 29/29 tests, 1/1 file, actual detached exit 0, no skips/cancellations, configured projects root byte-identical. Evidence: `_orchestra/story-lead/release-383-20261106/gate-r3/` and `story383-cache-isolated-r4-20261106.log/.exit`. Per the measured serial-list rule, the backend runner now includes this file in its serial tail with that evidence comment, preserving assertions/timeouts and adding no sleeps/retries. Fresh preflight, prebuild and the complete exact-source R4 gate are required. No 383 release proof, publication or installation is claimed.

### Release 1.4.383 gate R2 — content-pack ledger failure; release blocked (2026-11-06)

- R2 fresh lint/types/frontend preflight and normal prebuild exited 0. Canonical gate at `c4257630f69dd0c83091a67edb5ab0b48138c275`, tree `a5abf0ff3af7961137c8a01fbef2da9cc26e8ad4`, reached all ten steps with unchanged source and independently verified log hashes. Steps 01–09 exited 0: backend exact coverage 984/984 files (10,371 tests), frontend 377/377 (3,342 tests), release 9/9 (127 tests). Step 10 content packs exited 1: 411 tests, 408 pass, 1 fail, 2 skip; exact coverage rejected the failed file, so 0/44 is not a passing coverage result. The legacy migration ledger lists only the academic oil style as a future reservation, but the authoritative registry also reserves five classic metadata formula rows introduced with 383. The repair adds those exact five identities, reservation receipts and source paths to the non-authoritative ledger; the registry and exact-set test stay unchanged. Focused ledger validation passed 1/1 test, exit 0, no skips/cancellations. The full content-pack lane then passed: exact coverage 44/44 files, 411 tests, 409 pass, 2 skip, 0 fail/cancelled, actual exit 0. Both detached job and step exits were read independently (`pack-ledger-focused-r3`, `pack-lane-r3`). A fresh complete exact-source preflight, prebuild and gate R3 remain required; these successful repair checks do not turn R2 into passing release proof. No release proof, main integration, publication or installation of 383 is claimed. R2 receipts remain under `_orchestra/story-lead/release-383-20261106/gate-r2/`.

- Detached preflight lint, full typecheck, full frontend and normal prebuild exited 0. Canonical gate R1 at `96fc2cca6d60d17afba84e9c7a1d6ed175f5dc60`, tree `79d110a1b1273e1630aef132ff2e644c8b799595`, exited 1 at step 07 backend; source identity stayed unchanged and all seven recorded log hashes were independently verified. Backend completed 984/984 files: 10,371 tests, 10,364 pass, 5 fail, 2 skip. Failures are metadata disclosure, custom-lettering source assertion, two pipeline preset assertions and sketch status invalidation. Steps 08–10 did not run. Preserve R1 evidence under `_orchestra/story-lead/release-383-20261106/gate-r1/`; no passing release proof, publication or installation of 383 is claimed. Repairs need focused checks, fresh preflight/prebuild and a complete exact-source gate.
- R1 repairs are test-only: the disclosure registry fixture supplies explicit text (the empty default remains intentional), the lettering source assertion ends at the options object rather than an arbitrary character count, research is tested alone where writing now owns its optional run-time research, and the sketch route cache test isolates delayed native watcher events while restoring the real invalidator in `finally`. Focused R2 completed 4/4 files, 96 tests, 95 pass/1 fail, actual exit 1; disclosure, lettering and sketch passed. The Motion Review preset fixture also triggered a separate prerequisite check; switching that check off still could not add its missing predecessor, so isolated pipeline R3 remained 17/18, exit 1. The fixture now uses Thumbnail Prompts, whose only prerequisite is the writing step selected before it, with normal safety settings; isolated pipeline R4 passed 18/18 tests, 1/1 file, actual exit 0, no skips/cancellations. R2's other three files passed 11 lettering, 40 metadata and 27 sketch tests, no skips/cancellations; configured projects root stayed byte-identical in R2/R4. These are PARTIAL RUN checks, not release proof.
- 382 final-main DMG was verified, published to the mini's paired Gateway, placed on the signed feed and verified on all four mounted SSDs. Mini installation is now independently verified: HTTP 200, status ok, version 1.4.382, boot complete; updater installed/error null. Dispatch stayed paused with 0 running and 10 queued; Production owns resume. Original wrong-origin request/intents remain retained. Shared shipping tools commit `1201e2cf93d0bce1e78f57856cee2d49d3604de1` requires an explicit Gateway origin and known-host staged artifact hash verification; six focused tests passed. The one sanctioned graph refresh retry exited 128 at `git -C /build/Developer/kh-updater fetch -q origin main`: origin does not appear to be a git repository. Developer must resolve that refresh failure; no further retry.
- No built-in lettering or subtitle removal in 383. Every built-in and alias stays available; only 384 may remove items that measured usage proves unused.

### Release 1.4.383 preparation — portable packs and pure usage reads; removals deferred to 384 (2026-11-05)

- Prevention checkpoint is committed as `a132277ee993804abe7efd1eeaa54b93231a1837`; logo-only checkpoint is `870b85a3ff502f8d2da0979f7480db7d57c32ff1` (isolated staged tree independently passed 34/34 tests, 3/3 files, actual exit 0). Private author/committer email and required attribution verified for both. Developer's baseline comparison: exact 382 `dbbee43` passes full typecheck and light static preflight (both actual exit 0). 383 now has locked root/frontend dependencies installed with lifecycle scripts disabled, unchanged lockfiles; its Motion Review hint uses the shared 12px token (browser confirmed). Native 383 static preflight passes exit 0. Full typecheck first exposed fixture union/narrowing errors, then frontend non-strict Zod inference and the local fetch wrapper's nongeneric signature; those type-only repairs now pass the full native Electron + frontend typecheck, actual exit 0 (r3). Existing StillPost duplicate-import warnings remain. Rounded/circle logos now prepare the exact local `logo-shape.ts` mask at the same rendered width, then stage the resulting PNG through the existing remote recipe/compiler. A shape that cannot be prepared stays local with a loud reason; it never exports the unshaped original. Focused proof: export 11/11, helper 5/5 (independent combined run, 2/2 files, actual 0); transport 18/18 (1/1 file, actual 0), including rounded remote eligibility, staged PNG corner/center alpha, and broken-source fallback. No skips/cancellations; configured projects root byte-identical. Final full native typecheck and static preflight both actual exit 0 on stable tracked source diff, lint 0 errors/2,668 warnings. No live fleet render/pixel comparison or full gate is claimed. This is not a channel-setting migration: Production applies the approved channel choices only after shipment. Pure settings GET remains in the prevention checkpoint. No build/gate until Developer signals.

- Developer's latest boundary: add a pure preset-state GET plus bulk episode lettering/subtitle selection GETs, with tests proving they write nothing. The settings/config GET's retired-LLM migration has now moved to explicit PUT after the requested save; its regression records baseline bytes/mtime, saves, then checks pure readback. The focused migration/config file passed 5/5 tests, 1/1 file, actual exit 0; PARTIAL RUN. New reads must preserve missing/corrupt/unreadable distinctions and expose no credentials.
- Production bug follow-ups (same existing defects, no duplicate tickets): Story owns the frozen blank-description fix for 383. Affected uploads: HMH0016 `bad54f4d`, Night Atlas EP0017 `4f810416`, The Curious Why EP0006 `275b151a`; validate the selected approved/resumed payload before provider/session work, fail loudly and require review again, never substitute mutable live metadata. Source review and syntax checks pass; regressions cover blank frozen/live-complete refusal with zero provider calls/operations and valid frozen/live-blank preservation. Focused checks pass: metadata package 11/11, upload preflight 16/16; follow-up upload generator 28/28 and existing-video metadata update 22/22 all actual exits 0, each 1/1 file completed, no skips/cancellations, configured projects root byte-identical. The direct blank-resumed-payload test now proves zero provider calls and unchanged durable operation revision. Its first run failed because the test's initial job omitted the required approval receipt; the corrected fixture passed. Explicit blank descriptions on metadata updates are also refused before any provider call; omitted descriptions preserve partial-update semantics. These are PARTIAL RUN checks, not release proof.
- Add Refinanced EP0020 `82ada15c` to the legacy-opening defect already affecting EP0018/19: narration 1080.3s versus expected 1074.3s. The 381 closing-remix repair is historical evidence, not proof that this new video_assembly report is fixed. 383 now handles partial opening objects through the existing recorded/measured timing helper instead of keeping the current preset's lead-in. Null timing is no longer coerced to zero in planned/recovered guard baselines. Regressions cover empty, intro-only, null, nonnumeric, lead-only and complete openings at original 0s/8s against a current 6s preset. The completion/adoption guard also checks raw duration/tail/lead fields before arithmetic, so missing/null/empty timing cannot pass through NaN or become a recorded zero. Follow-up closing-tail-remix passes 34/34 tests across 12 suites, 1/1 file completed, actual exit 0, no skips/cancellations and configured projects root byte-identical. Tests cover missing narration length and missing/null/empty successor lead-in against an original zero lead-in, plus existing rollback/recovery/concurrency. PARTIAL RUN, not release proof. The actual EP0020 completion record has not been inspected, so its root cause remains unconfirmed. Duration tolerances and the refusal for unmeasurable timing remain unchanged; never ask the owner to accept drift.
- MineePod EP0018 `2d918ee2` joins the existing encoder-duration defect: exit 0 with video 2268.100s versus expected 2268.380s, three automatic attempts exhausted. Track the follow-up in 383 alongside the existing encoder-duration work; 382 is frozen. The short-output cause is not yet measured, so no tolerance relaxation or encoder fix is claimed. No Production queue changes or retries are authorized for these investigations.
- Owner-requested prevention hunt covers outbound-value validation, stage duration drift, partial legacy records/migration, and silent fallbacks. The validated internal two-week ledger has 40 rows: 36 confirmed, 2 partial, 1 unconfirmed and 1 reported without a root cause; it has explicit history/Production/test coverage gaps, so it is not exhaustive. Current focused proofs total 226 tests across fourteen selected files: the earlier nine backend files total 135, plus final-duration-guard 3, reveal-xfade-tail 1, final-render-import 71, scene-plan-lead-in-shift 9, and seven direct frontend readiness source assertions. All actual exits 0 with no skips/cancellations; backend selected-file coverage complete and configured projects root byte-identical. These checks span incremental source changes and are not one exact-source release proof. Scoring read failures now record an honest optional not-scored reason rather than no-artwork; the job still blocks nothing. The shared picture-length guard keeps the existing 0.25s allowance across intermediate/output/import/completion; unmeasurable pictures cannot pass completion. New remote imports probe picture length before promotion/ACK. Historical v3 receipts remain readable, with independently measured picture fields required on newly generated observations and validated when present. Unknown scene coverage now has null gaps, measured/reason fields, a false completion state, loud render refusal, and explicit recovery copy. Real scan tests distinguish unknown/zero/nonzero gaps. The actual SceneTimingPanel compiled from 383 passed isolated desktop/mobile proof for unknown/zero/gap/inconsistent-ready states, with no overflow/console warnings/failed requests; screenshot proof is under `~/Desktop/All YouTube Stuff/Channels List/Story 1.4.383/Coverage guard 20261105/`. Full page interaction and typechecks remain pending; positive-plan-duration fallback without measured audio remains a known gap. Scoped seven-backend-file lint exited 0 with 155 warnings and no errors. These filtered checks are not the release gate. No change to the explicitly preserved title emoji behavior or owner-tunable A/V settings.
- Production r2 usage export covers 28 projects, but cannot prove any builtin unused: current stage pointers/saved preset bodies and bulk lettering/subtitle selections remain unavailable; 1,520 accepted ideas lack stored formula/topic fields. Authoritative snapshot: `_orchestra/production-records/settings/builtin-usage-20261105-r2.json`, SHA-256 `6dda22c58f581dcadc95891dd650ea07a0ae4adaa8436fd2cb043d47a6624e7f`. Historical pointers stay dated evidence only.
- 383 migrates exact matches and ships portable lettering/subtitle packs while retaining EVERY builtin and alias. Lettering review is six reused packs and 29 exact conversions after rejecting colour injection in two font-axis reuse phrases; external drafts preserve exact phrases and swatch bytes. The 24 subtitle conversions reuse the existing subtitle-style kind and ASS engine. Registry/build/install/pixel proofs remain required; drafts are not shipped packs.
- After 383 is installed on the mini, Production exports through the new routes. Only 384 may remove builtins/aliases, and only items proved unused by that evidence. Preserve queued provenance, accepted finals and episode timing. Light checks only while Hub holds the heavy slot; no 383 full gate, publication or installation is claimed.

### Release 1.4.382 — R5 verified and main integrated; final main rebuild pending (2026-11-05)

- 381 is installed and independently verified by Production; its preparation notes below are historical. 382 R5 completed all ten gate steps with actual exits 0 at `dbbee43a6f0af6ab07de123c5a34baaa70c22afe`, tree `569494f62fe1d606639c6c37138f1bfbf009b0a0`, empty tracked diff. Backend 972/972 files (10,269 pass, 2 skip); frontend 376/376 (3,335 pass); release 9/9 (129 pass); content packs 44/44 (409 pass, 2 skip). Log hashes and canonical offline proof independently verified; main and origin/main match exact HEAD. R5 processes ended and heavy slot returned. Developer explicitly reserves the final main rebuild after Hub R7 + Qwen measurement and Gateway gate. Final main 382 receipt/artifact, publication/feed and installation are NOT done. Publish only the final main artifact, never the worktree DMG. The older preflight/preparation bullets below are historical attempts superseded by R5.
- Research is optional before writing, with a channel switch and formula-based read-time defaults. Unknown provider outcomes retain their original identity. Pipeline completes pending automatic claims without replacing completed human triage, including ignore-all. Focused research proof: 28 tests across four files, exit 0; PARTIAL RUN.
- Thumbnail metadata and generation are committed through `3d78321`: per-option recipe/style/font/text/placement, hash-bound prompt approval, deliberate episode auto-approval, durable duplication, saved-option regeneration and Khmer text-free behavior. Existing sidecar-free episodes retain compatibility; default remains three prompts/images, with the arbitrary six-option ceiling removed. Focused integration proof: 66 tests across four files, exit 0; lint/backend types 0; PARTIAL RUN.
- Scoring safeguards committed as `920a17f`: a human pin wins, an incomplete run keeps a still-valid prior scored choice, missing files are unmeasured, and all-bad requires every candidate to be explicitly rejected by image rules. Zero scores, missing data and provider errors cannot imply all-bad. Focused proof: 35 tests across two files, exit 0; lint/backend types 0; PARTIAL RUN.
- Thumbnail controls committed as `8a051ab`: independent saved settings, prompt approval, deliberate automatic approval, duplicate retry identity, responsive comparison and one explicit generation followed by one rescore. A repeated rejection requires another deliberate action. Corrected focused frontend run r2 passed 19 tests across two files and frontend typecheck, exit 0; r1 failed on a missing component test stub and remains recorded. Isolated browser fixtures proved independent saving, duplication without inherited approval, pinning, desktop/mobile layout and exactly one recovery render plus one rescore. Fixture bootstrap errors remain; no clean-console or real-provider claim.
- Audio fixes reviewed: preset settings match ambient IDs first, reserve later explicit matches before positional fallback, preserve live paths/order, and safely render empty added layers. Estimates count selected music lead-in and selected-intro gap; intro clip length and next-merge closing tail remain explicitly uncounted. No stored data rewrite or new duration route.
- Revision-4 capabilities read validates closed shape, identities, freshness, exact UTF-8 digest and profile; malformed/unsupported responses never enable Best. Settings remains unavailable with a reason and rereads after private-render saves. Positive Best selection/binding/receipt/import is not implemented or qualified: authoritative Hub quality/policy evidence is missing. Existing v1 dispatch is unchanged. Lyrics remain deferred; Audio redesign belongs to 383 with its design/test plan first.
- Focused final backend r2: 61/61 tests, aggregate 6/6 files completed, actual detached exit 0; scoped lint/backend types also 0. Covers negotiation plus existing image modes, chat request limits and upload checklist. r1 failed an incomplete synthetic profile test fixture, corrected before r2. Frontend final r1: 36/36 tests, 8 suites, actual exit 0 plus frontend typecheck 0; existing duplicated StillPost import warnings remain. These are PARTIAL RUN checks, never release proof.
- Isolated browser at 3044 verifies Audio totals 1:58 with 8s music lead-in and 2s intro gap, 1:50 with lead-in off, 1:56 with intro off, and explicit uncounted components. Settings saves on/off through the existing endpoint and refreshes Best reasons both ways; fixture records exactly two writes, final off. Desktop and narrow-screen note captured; unrelated incomplete Settings fixture responses cause console errors, so no clean-console/full-settings claim. No generation, real files, production setting or Gateway request used.
- Preflight r1 at a8a8544: lint 0, typecheck 0, full frontend 1 (3,335 tests: 3,333 pass, two failed, no skips/cancellations). The two failures were obsolete source assertions: research selected the first shared card class (now the channel switch); thumbnail POST assertion omitted its new TypeScript generic. Scope the former inside Run controls and match the typed POST inside queueGeneration while retaining order checks. Coverage rejected the failing file and is not passing evidence. The guarded chain exited 1 before prebuild or gate; no build/gate proof. Focused repair r1 passed 54/54 tests across 8 suites, actual exit 0, no skips/cancellations; source assertions still pin both control placement and refusal-before-submit. Fresh preflight r2 and exact-source release checks are required. Developer and Hub explicitly cleared and reserved the heavy window; no local Hub heavy work/probes/generation.
- Next for 382: await Developer's reserved heavy-slot clearance, run the prepared exact-main rebuild, validate its final receipt, then publish/feed that artifact under standing release authority. Installation follows the standing rule: Production pauses the queue, the running render finishes, paused/zero-running is confirmed, normal install and health/version verification complete, then Production resumes. Never interrupt a render. The current bug hunt authorizes no queue changes, retries, SSH or publishing-schedule GET.

### Release 1.4.381 preparation — closing remix timing, App Settings, Coffee Jazz and remote encode routing (2026-11-05)

- Developer prioritized the production-blocking legacy closing remix fix ahead of the remaining channel-flow moves, research switch and thumbnail refactor. Production reports EP0018 and EP0019 both fail with a new6-second lead-in inherited from the current preset when old merge evidence has no opening fields; the strict duration guard rolls back and original audio remains. Implement the smallest timing-preserving fix plus a focused regression, keep the guard strict, and ship the prepared381 batch as one install. Production owns episode recovery/retries; no episode or global preset edits. Heavy checks await actual Hub quiet-window clearance. App Settings consolidation is committed as `ee6cfbe`; gated380 `ceb89bd7` is merged into381, including its measured serial test correction.

- Preflight r1: lint0/types0, frontend stalled after Upload Center Publish assertions with active timers; verified process group17545 terminated, frontend/wrapper actual1, no completed coverage. Two real failures corrected: classify channelTargetMinutes as saved in channel settings (preset coverage47/47, actualNode0); Publish fixture now destroys every mounted app after each test, including failed assertions without TestContext. Queued/running/unknown upload review copy no longer makes an already-published scheduling claim; duplicate upload remains withheld. Publish focused103/103tests across4suites,0fail/skip/cancel,actualNode/wrapper0,5970ms (`/private/tmp/uploadCenterPublish-focused.log`, script/exit under `/tmp`). Browser read of the actual381Vue page with isolated debug fixture state verifies review notice present, no already-published scheduling claim and Close-only action; existing fixture route404s remain, no clean-console claim. No production mutation. Old orphan group78744(manualGenerationRedoPreference) stopped and independently verified gone; instant-data-375already absent/unregistered with no branch ref, historical merged/clean status unproved.
- Closing remix fix independently reviewed: missing legacy opening evidence uses the shared original-duration/sidecar measurement, refuses unmeasurable timing, disables the current preset's unrecorded intro, and carries measured lead-in into both merge params and the existing strict lead-in guard. Duration tolerances are unchanged. Regression covers original0s and8s lead-ins against current6s preset, successful tail remix, and byte-identical original audio. Focused follow-up:29tests/11suites passed,0failed/skipped/cancelled,1/1file completed,189245ms; detached command exit0 (`.test-work/closing-tail-remix-followup.log` and `.exit`). This is PARTIAL RUN, not release proof. No production episode or preset mutation. Legacy intro identity cannot be recovered from duration alone, so unknown opening timing is preserved as music lead-in without claiming its original content.
- Final Coffee Jazz r3 focused checks: backend7/7tests across2/2files, actual backendexit0; electron/frontendtypes, scopedlint, changelog, whitespace and detachedwrapper each exit0. No skips/cancellations. r1 failed on a new test syntax typo; corrected r2 passed before the final safe-config readback assertion was added, and r3 rechecked it. These are PARTIAL RUN checks, not release proof. Coffee Jazz changes are prepared for381; no gate/publication/install of381.
- Coffee Jazz source correction: the legacy resolver now accepts the existing validated `user:<uuid>` identity without accepting traversal. Episode Builder exposes a channel target (1–360 minutes) stored as `music_episode_target_length_s`; saved episode settings still win. Safe config readback includes the new key. No slug-based duration rule or existing-mix rewrite. New regression covers real legacy formula resolution to music, invalid IDs, persisted/editable future targets and byte-identical saved mix/settings/songs.
- Owner-approved production content repair: normal Gateway archive installation returned HTTP201 on 2026-11-04 at16:05:31Z, activating `com.storystudio.pack.formula.coffee-jazz-ambient`1.0.0, SHA256 `2458609a66e523568a1ccdaba7644d18cc0fae83ee2389c7a0773353d302c002`. Quiet Coffee Jazz activity was checked twice; no SSH. Fresh reads resolve the exact/effective formula with musicFormat, `music_channel:true`, and CJ0001 still resolves15/15saved songs/pool with its3900-second target. The ID was correct; the pack had not been available to the mini resolver.
- Owner's future9000-second target was submitted through normal config PUT (HTTP200); initial readback timed out, later safe config omitted the key because installed377 does not expose it. No repeat write. 381 reads/exposes that key; verify the stored9000 target after381 installs. Until then, installed377 keeps its65-minute defaults. Evidence `_orchestra/story-lead/coffee-jazz-fix-381-20261104/` outside checkout. Desktop/mobile isolated browser proof verifies save, reload persistence, future150minutes versus saved65minutes, and no horizontal overflow. Fixture job-history responses produced console errors; no clean-console claim. No381 release is claimed.

- Developer approved remote-render parity in three separately gated phases. This candidate covers Phase 1 only: the exact six-field encode tuple in request-scoped discovery and packet export, with strict response matching and legacy Gateway compatibility. Hub owns actual per-node hardware/bitrate support; Gateway owns matching discovery and destination selection. No owner settings changes; scene effects/subtitles/full containers remain Phase 2 and upstream rendering remains Phase 3.
- Contract: `_orchestra/remote-render-parity-20261104/phase-1-contract.md` outside this checkout. Preparation starts from frozen 380 `d1810b5a940e06470f3e81a2d363c58791587b26` in its own worktree. Do not alter 380 or the existing 378/379 delivery guards. 380 ships first; its gate has now exited. The focused 381 checks below passed; no 381 prebuild, full gate, publication or installation is claimed.
- Boundary review removed the duplicated encode quality/cap rules: discovery now calls the packet's shared validator, including runtime codec validation. Scoped responses claiming a supported tuple with zero eligible nodes are refused; eligible-but-busy remains valid. Regression fixtures cover both. Cheap checks: whitespace exit 0, syntax transpilation of seven changed TypeScript files exit 0, and 16 assertions against the production validator/discovery helper exit 0 using 380's TypeScript. After Hub219 released the heavy window, the focused remote encode check passed 36/36 tests across 3/3 files, actual suite and detached wrapper exits 0, no skips or cancellations (`thumbnail-replacement-381-20261104/remote-encode-focused-suite.log`). This filtered run is not release proof; final electron/frontend typechecks subsequently passed with the thumbnail batch, but the full gate remains pending. Independent root/frontend dependency directories are now APFS clones of 380; locked package graphs match (root version excluded), with no borrowed symlinks. The stalled correction worker was stopped before these lead edits.
- 380 r3 passed its prebuild and all ten exact-source gate steps at `ceb89bd7547001003f2baf5138086adb016b1801`, independently reverified. Owner through Developer authorized direct380 because both378/379 are ancestors. Both old delivery guards were unloaded (bootout0, post-print113), with receipts retained. Main fast-forwarded through `refs/heads/land/1.4.380-into-main` and pushed; normal main380 build exited0, package proof/wrapper0, version/What's New/DMG integrity verified. Published380 is262450158bytes, SHA256 `7ce1aa80fb881fc2543b9dd4e122b94064fd5ab407f306283d1c0303b9e26361`. INSTALLED VERIFIED: mini health HTTP200/status ok/version1.4.380/boot_complete true; updater phase installed/error null and exact published hash/size matched. The one-time exception script found380 already installed and sent no install POST; exception authority is closed. Production reports resumption with Refinanced EP0019 rendering. Independent post-resume read confirms paused:false/running1/queued31/done24/error12; error count was11 before install, so Production was asked to identify the new failed job without attributing it to the update. Delivery evidence is `_orchestra/story-lead/forced-380-20261105/` and `follow-on-379-380-20261104/1.4.380/main-build-proof/`. Before381 integration, include380's measured serial-runner correction without rewriting its gated identity.
- STANDING INSTALL RULE (owner via Developer,2026-11-05): package ready → ask Production to pause → wait for Production's paused:true AND0running confirmation → normal install-now → read version/health → tell Production to resume. Never interrupt a render; queued jobs need not drain. Owner separately authorized one exception for380 only; it is now closed after verified installation, with no duplicate POST sent. Production resumed during mainbuild by Developer's direction, paused for installation clearance, then resumed after verification. The normal install wrapper requires Production's clear receipt plus fresh paused/0running readback and uses immediately:false. The publication wrapper's force path is removed; older guard admission checks follow the standing rule and remain unloaded.14offline admission checks passed; no new Story suite. Hub220's heavy-check hold is now released: Hub lead reports no local heavy test/build/package running or planned, and explicitly cleared381prebuild/fullgate. Receipt: `release-381-20261105/heavy-window-clear.json`.
- Existing-video thumbnail review now offers Use on YouTube for every local candidate, including newly generated candidates, through the existing confirmed operation endpoint. Public and private-scheduled videos use the same thumbnails.set-only path; title, visibility, schedule and other metadata are not written. Confirmation explicitly warns about a friend's titled Khmer image. The current remote image is retained separately from local candidates before mutation and can be restored through the same endpoint. Reads and saved images remain authorized to the original operation/channel; image downloads accept only HTTPS i.ytimg.com, refuse redirects and enforce byte/pixel/time bounds. Accepted-but-unverified updates retain a pinned uncertain action and block resubmission. Forbidden-thumbnail Retry remains unchanged.
- Final thumbnail check r7: backend 15/15 tests, aggregate 4/4 files completed, frontend component 1/1; both actual exits 0, no skips/cancellations. Electron types, frontend types, lint, changelog and whitespace each exited 0; detached wrapper exit 0. Evidence: `_orchestra/story-lead/thumbnail-replacement-381-20261104/` outside this checkout. Earlier r1/r2 backend failures, r3 frontend harness failure, r5 missing-project type error and r6 unnecessary-await lint error are preserved, corrected and superseded by r7. Focused checks are PARTIAL RUN, never release proof. Progress is tied to the submitted job; superseded readbacks cannot replace newer state.
- Isolated browser proof: four candidates, Cancel sends no POST, confirmation includes titled-Khmer warning, replacement progress 75%, completed fresh readback, previous image shown and Restore confirmed/restored it. The only two mutation payloads were confirm plus filename. Desktop and 375px mobile had no horizontal overflow; both images loaded. Proof images: `~/Desktop/All YouTube Stuff/Channels List/Story 1.4.381/`. No live YouTube request or production mutation. Fixture-only missing job-history routes and an intentional cross-origin debug request produced console errors; no clean-console claim. Developer explicitly ordered preview ports3029 and3035 left alone; no further stop attempts or workaround. Other owned completed previews were stopped.
- Settings-placement App Settings batch (2026-11-05) is implemented: shared page/modal body now owns connections, default models, notifications, library/exports/archive, all-channel cleanup, compression, FFmpeg, backup and app updates. Channel Settings removes the machine tabs and moved code; its own storage breakdown stays in Project files and its search entry now follows that home. Existing keys/defaults/endpoints are preserved, YouTube's connection-only view no longer requests a channel assignment, and old app hashes redirect to App Settings. Coffee Jazz is committed as `4ea51a769e16b4b58b89895833e0372f8ccdb118`. A worker committed AppFilesSettings plus four regression files despite its no-commit brief; lead verified the private email and amended only the unpushed message to add attribution: `c6e46b3c23778db5641e4927fcf4d1c4c7ced935`. Remaining App Settings changes are uncommitted; no push.
- App Settings focused r4 passed109/109 across11frontend files (9suites,31897ms), actual tests/frontend-types/changelog/whitespace/wrapper exits0, no skips/cancellations. Independent review then corrected the retained channel storage search destination and restored a folder-picker assertion; focused r5 passed21/21 across3files, actual tests/whitespace/wrapper exits0, no skips/cancellations. Earlier r2 failed the new navigation test's ambiguous Telegram query; preserved and corrected. These focused runs are not release proof. Evidence: `_orchestra/story-lead/settings-placement-20261104/` outside checkout.
- Isolated browser verification confirmed notification toggle/save/GET/readback/reload through the existing endpoint, exactly one notification panel, Files/Default models/Backup rendering and no horizontal overflow at1280px/375px. Screenshots are in `~/Desktop/All YouTube Stuff/Channels List/Story 1.4.381/`. The Updates fixture omitted `settings.auto_install`, causing a recorded console error; the fixture response is corrected on disk, but restart of preview3037 was denied by automatic approval review because the creation receipt was not visible after compaction. Preview3037 remains running; no workaround or clean-console claim. Developer-held3029/3035 remain untouched. 380 is installed; closing remix timing now takes priority for381 shipment. Later: approved channel flow moves (continuity→Character Sheet, social platforms→Upload Center, episode shape→Scripts using config.episode_length, remaining audit rows), then research switch, thumbnail refactor/guard. The historical audit's holds are superseded by Developer's owner relays.
- Before gating:380's measured runner correction is integrated. Gateway lead confirms Phase1 deployed on1301 as0.2.231/build295f576-202611041436; lead read both `render-phase1-20261104/1301-receipts/{hardware,legacy}-real-permission.json` receipts: scoped exact six-field echo/encode entry and legacy14-key response preserved. Descriptor/digest/tools/compiler remain unchanged; historical eligible/idle counts are not current availability and no end-to-end remote render was submitted. ThisMac's Gateway remains230; compatibility path still matters. Finish closing remix focused checks, then release preflight, normal prebuild and the complete ten-step exact-source gate. Keep local fallback loud and reconcile original-key outcomes before any replacement render.

### Release 1.4.380 candidate — writing recovery and cancellation (2026-11-04)

- Normal prebuild r2 exited 0. Full gate r2 exited 1 at backend step 7: all 965/965 files completed, 10,231 tests, one failure and two skips; source stayed unchanged at `d1810b5a`. The only failing assertion was `storage-space-summary-timeout` expecting measured Trash totals within its 30 ms fixture deadline under pooled load. The unchanged file passed alone (6/6 tests, 1/1 file, actual exit 0). Per the measured serial-list rule, register it in the serial tail without changing assertions or product timeouts. Fresh preflight, prebuild and the complete ten-step gate are required; no passing release proof or publication is claimed. Evidence: `_orchestra/story-lead/reliability-380-20261104/gate-r2/` and `story380-storage-timeout-isolated-r2.log/.exit`.

- Developer authorized this batch while 378's quiet-point guard and 379 delivery wait remain untouched. Separate `release/1.4.380` worktree starts at gated 379 `ae1088bb`; 379's canonical r4 gate actually exited 0 with all ten steps, clean unchanged source and independent proof verification (10 log hashes, complete file coverage, no partial run). No 379 publication/install is claimed.
- 380 supplies chapter workload deadline hints independently of the output ceiling, wires scene-plan cancellation through the existing provider AbortSignal, and reconciles original uncertain writing before any replacement. Unknown results retain identities; Gateway owns model fallback. Completed chapters and existing bounded repair splitting remain preserved.
- Job snapshots explain when a terminal row still has a live local worker. The existing Check again control reads that state without releasing its executor fence or generating work. A final worker-release update restores normal controls. Isolated browser proof confirms the message on the existing Jobs card at desktop and 375px widths, without overflow; releasing the held worker restores Retry through the existing stream. Final combined focused proof passed 205/205 tests across 13/13 files, actual suite and detached wrapper exits 0, no skips/cancellations (`focused-r6`). Both direct/policy cancellation tests hold an accepted provider fetch, use the safe cancellation control, prove signal abort and no next pack/save, and preserve completed prompts. Earlier r2/r4 runs exited 1 while obsolete resend fixtures and cancellation-test lifecycle were corrected; r3 stopped at a test typing error (2); corrected files passed 21/21 (r5, exit 0) before r6. Lint, changelog, model-drift and final typecheck exited 0. These filtered checks are not release proof; normal prebuild and all ten exact-source gate steps remain pending. Nothing shipped.

### Release 1.4.379 candidate — YouTube schedule refresh and published image modes (2026-11-04)

- Candidate `f526965d` passed full frontend preflight (3,314/3,314 tests, 373/373 files, exit 0), lint/types 0 and normal prebuild 0 after preserving dependency symlinks under `_trash/dependency-links-379-20261104/` and creating physical APFS clones. Canonical gate r3 exited 1 at backend step 7 after 5,144 seconds: 965/965 files completed, 10,228 tests, 10,225 passed, one failure and two skips; source identity stayed unchanged. Sole failure: `audio-subtitle-explicit-regeneration` ordinary subtitle recovery timed out in the pool. The exact file passed alone (1/1, exit 0, 15.9 seconds). Per the measured serial-list rule, run it in the serial tail; assertions and timeout stay unchanged. A new exact-source prebuild/full gate is required. Evidence: `gate-r3/`, `subtitle-recovery-alone-r1.log/.exit`. No publication or installation; 378 installed receipt remains absent.

- Picker implementation is committed as `ecad0411`, alongside schedule fix `64284d5a`. First detached release preflight: lint 0, typecheck 0, full frontend 1; prebuild and the ten-step gate did not start. The full lane exposed obsolete source assertions, missing published mode fixtures and missing imports in compiled component harnesses. Repairs preserve request admission, confirmation/cancellation and live-capability assertions. The final detached focused repair run passed 151/151 tests across eight files, actual exit 0, no skips/cancellations (`frontend-repair-focused-r4.exit`); earlier r2/r3 exits were 1 and remain recorded. Freeze the repaired candidate and rerun preflight/prebuild/full gate. Developer authorizes 379 delivery only after verified 378 installation and a green exact-source 379 gate; preserve the 378 guard unchanged. No critics.

- Thumbnail Generator and Scene Review now select Text to image or Reference to image from the selected model's live `image_modes` only. Gateway ids remain `txt2img`/`edit`; the latter is never used as the mode label. Missing contracts invent no modes; unavailable modes retain their reason. Reference counts/dimensions come from that mode's published references. Thumbnail reference mode refuses without a saved reference asset. Explicit scene text mode suppresses saved character/episode references without rewriting them, and automatic remake jobs preserve the mode; old jobs without the field keep their behavior.
- Final image backend check passed 58/58 tests, 3/3 files, actual exit 0 (`image-mode-catalogue`, `scene-reference-characters`, `continuity-reference-image`). Frontend focused check passed 22/22 tests, actual exit 0; the initial run failed three source pins for the former implicit reference behavior, updated to assert the explicit published mode/request wiring. Full electron/frontend typecheck exited 0. Browser proof on isolated fixtures verified both surfaces, dual-mode/text-only/unavailable-reference models, announced mode reconciliation, live limits, and no horizontal overflow at desktop/mobile sizes. Fixture-only missing auxiliary routes still generate warnings; no live generation or production writes. Evidence: `_orchestra/story-lead/release-379-20261104/`. These are focused checks, not the ten-step release gate. No 379 build, publication or installation yet.

- Explicit Check All refreshes the channel listing even inside its TTL, discovering new schedules made in YouTube Studio. Background refresh pacing stays unchanged. Listing failures keep the last good listing and the existing per-video checks/error reporting. Focused house-runner check passed 33/33 tests across `youtube-status-sync` and `youtube-publication-cache`, actual exit 0, 2/2 files completed, no skips or cancellations. This is a partial run, not release proof. Schedule fix is committed as `64284d5a`; version and What's New are 1.4.379. Image mode work and its separate focused proof are described above. No 379 gate, build, publication or installation yet.
- 378 main is `1f4f3c8e1cfccd37298abc2bc2eac94f21009003`; all ten exact-source gate steps and main artifact rebuild passed. Main DMG SHA256 `61d8b170c550f774609b19755dd7018c2e90a0404575ffa791b2646c49e34eb8`. Installation remains deferred while the mini assembles videos: persistent launchd label `com.vengtheng.story378-publish-guard` retries every ten minutes, with busy exit 75 and terminal receipt protection against repeated POSTs. Last measured attempt 10 exited 75; no installation success claimed. Evidence: `_orchestra/story-lead/release-378-20261103/`. Earlier 378 candidate notes below are superseded by this gate/build status.

### Release 1.4.378 candidate — live request sizing, content-store cleanup and existing guide corrections (2026-11-03)

- Based on delivered 1.4.377 `f1c317af`. The guide, catalogue, request-admission and request-side scene-pack/planner-window patches are reviewed; the final focused rerun and release checks remain pending. Guide checks passed 5/5, actual exit 0; the Channels guide opened without horizontal overflow at 1280×900. Developer explicitly waived waiting for the screenshot. No 378 publication or installation has occurred; normal prebuild and the full ten-step gate remain required.
- Store review removed the last discount projection in new quote rows. New rows omit money projections while old signed receipts and optional historical fields remain readable. A new regression found that a completed replay rewrote the journal unnecessarily; no-op mutations now preserve its bytes. The first focused backend run completed 8/8 files and 139 tests, actual exit 1: this replay assertion and two obsolete price-validation assertions in one test failed. The repaired backend rerun passed 139/139 tests across 8/8 files, actual backend exit 0, no skips or cancellations. The combined wrapper then exited 127 because the lead’s frontend preparation command pointed to the root dependency tree instead of the frontend tree; no frontend test ran in that attempt. The corrected frontend-only check passed 108/108 tests, actual exit 0, no skips or cancellations, using the repository’s happy-dom/API bootstrap. An intervening invocation omitted that bootstrap and was stopped after failing assertions; no completed suite exit is claimed for it. No failed or partial run is release proof.
- Request-limit parsing, shared request admission and chapter budgeting focused checks passed 47/47 tests across 3/3 files, actual exit 0, no skips or cancellations. The expanded sizing run passed 200/200 tests across 11/11 files, actual exit 0, no skips or cancellations. It covers actual-prompt fitting, split planner ranges/recaps/coverage, saved-key recovery and old checkpoints. Review then aligned Gateway deadline expectations with the same measured answer rates used for pack fitting; that final adjustment requires a fresh focused run before preflight. Automatic repair sizing includes its recovery findings and notes. Visual/motion writers use their actual English output language. Saved request shapes remain historical recovery inputs; each new client/policy submission still validates live Gateway limits. The two-pass planner already writes one scene per call; it retains client admission rather than window packing. No live generation was used to qualify the measured starting rates.
- Stable-check round 1 stopped the first gate attempt at `e917896d` mid-backend-lane (recorded honestly, no full-gate result; evidence in `_orchestra/story-lead/release-378-20261103/attempt-e917/`). Two confirmed backend defects are repaired uncommitted: pack/window fit now uses the chosen output allowance (`fitLimits`) instead of only the published ceiling, and all three fit paths count the JSON wrapper instruction the wire appends (`jsonWrapperInstructionForContract`, exported from genstudio-client). Runtime regressions: generator refuses before any provider submission under a smaller chosen allowance; planner wrapper text is proven wire-identical. Frontend now shows the published request ceiling figure (or an honest "no request ceiling is published") separate from the output limit, via `maxRequestTokens` in model-token-budget. Guide copy corrections and a plain-language CHANGELOG bullet are in. Round-2 focused checks: frontend typecheck actual exit 0, guide 10/10 actual exit 0; sizing r3 exposed one stale expectation that encoded the old truncation bug (20-scene packs under a chosen 8,192 allowance); corrected to the fitted 14+6+1 split, rerun pending. A fresh guarded chain (new manifest/labels over `e917` + these fixes) is required before prebuild and the full gate; attempt-1 receipts must not be reused as proof.
- Owner bug folded into 378 (`a9b4b5a8` + lead repairs): a job row the queue's memory no longer holds but the saved history still has could never be removed ("Job not found" forever; Hide is display-only). `DELETE` routes and `clearFinished` now remove such rows from the saved history under the same gates (terminal, final-render fence, unsettled evidence); the frontend also treats "Job not found" as removed and drops stale Hides. Files and billing records untouched. Lead fixed three defects the worker left: the bulk saved-history loop missing the final-render fence gate, a missing candidates argument, and unused route params. The history read's saved-file fallback also honors the persistence layer's `deletedIds`, so a just-removed row can never resurrect from a file whose rewrite is still in flight (the legacy in-memory removal path persists fire-and-forget); `job-remove-missing-row.test.ts` pins both the list and the durable file.
- Gateway's current Story writing pool publishes a context window but no request or output cap. Missing caps remain unknown; output allowance follows caller, published cap, then 128,000. Never substitute 4,096 or represent the fallback as a provider cap.
- Content-store credit and price cleanup must keep historical receipts readable and leave stored data untouched. Guide work corrects the existing entries only; no new tracker or visible freshness stamp.

### Release 1.4.377 — upload checklist, channel narration gap tolerance and publishing freshness (2026-11-03)

- Delivered main `f1c317af333a3b3926838dfbc3c9a9e014d5c6f0`: normal prebuild, all ten exact-source gate steps and final main rebuild exited 0. Backend completed 963/963 files and 10,194 tests; frontend 373/373 files and 3,310 tests; release 127 tests; content packs 411 tests, including two reported skips. Published DMG SHA256 `8882958ac2beaeba5e195baca647d406b28508555f45cd94de4d75dec0c41b77`. Mini installation was verified at 22:32:05 local on 2026-11-03: version 1.4.377, installed phase, no update error or pending request, direct health HTTP 200 and boot_complete true. Receipt: `_orchestra/story-lead/checklist-silence-377-20261103/delivery-377/mini377-installed-verified.json`. Earlier candidate notes below are historical; their pending statements are superseded by this delivery proof.

- Changed project saves invalidate the existing Publishing overview cache, so saved status labels and names appear on the next read. No-op saves keep cache reuse. The new regression warms the cache, changes the label and name, and reads them back without a TTL wait or manual refresh. Production labels were not rewritten. Original preflight passed lint, changelog, model-drift, types and all 3,310 frontend tests across 373/373 files (exit 0, no skips/cancellations); its queued commit/build was stopped before either started when this cache fix joined the batch. The expanded patch requires fresh verification, normal prebuild and full gate; original preflight is not release proof.

- Upload previews expose an advisory `checklist` in the existing JSON and show it in individual and bulk reviews. Present, Missing and Not checked describe field presence only; no new upload admission rule is added. Frozen historical metadata cannot verify its thumbnail, so that field stays Not checked. The existing title/description completion guard remains separate.
- Metadata warnings say Warnings rather than Ready. Final narration checks accept gaps up to 10 seconds by default, with a per-channel allowed-gap setting; only longer gaps are flagged. Planned section pauses and closing tails retain their existing exclusions.
- Package and lock versions are 1.4.377; the dated changelog supplies in-app What's New. Focused checks passed: metadata/preview backend 209 tests (2/2 files), Publish UI 103 tests, silence/recovery 139 tests (9/9 files), settings UI 1 test; each actual exit 0, no skips. The silence run's three initial failures were fixtures assuming that exactly ten seconds was a fault; the unknown-speech fixtures now use eleven seconds and planned-pause coverage sets an explicit five-second channel tolerance. Assertions remain. Browser proof used isolated data: eight checklist states, desktop and 375px layouts without horizontal overflow, and channel tolerance 10→15 with saved readback 15. Unrelated catalogue routes absent from the Settings fixture still show warnings. Screenshots are in `~/Desktop/All YouTube Stuff/Channels List/Story 1.4.377/`. Normal prebuild and the complete ten-step gate remain required. No 377 publication or mini update has occurred.

### Release 1.4.376 — held retries and normal macOS packaging (2026-11-03)

- Released main `ced4eca4`. Fresh repair-r2 preflight, normal prebuild, disposable launchd check and all ten gate steps exited 0 on unchanged source. Backend completed 963/963 files and 10,188 tests; frontend 372/372 files and 3,307 tests; release 127 tests; content packs 411 tests with two reported skips. Integrated main rebuilt normally and was pushed. The approved Gateway published the main DMG (SHA256 `f537e3a6542b3222f63b1a4b9cdb7d68e90529b95cb9e1985e86eb6418563fa6`). At 18:42 the mini reported installed 1.4.376, no update error or pending request, and direct health HTTP 200 with boot_complete true. Proof is in `_orchestra/story-lead/signing-376-20261103/mini376-installed-verified.json`. The candidate history below describes earlier attempts.
- The macOS mini crash report for 375 shows CODESIGNING code4 Launch Constraint Violation before app code. The published 375 artifact was hand-sealed with `codesign --force --deep --sign - --identifier com.storystudio.kh`; standard 374 was linker-signed and unsealed. Exact violated constraint is unknown. The earlier OS-update/slowness theory is superseded; the temporary slow-launch allowance and its tests were removed.
- Build normally: no post-build hand seal, no deep resign, no forced identifier. Release verification must accept only the normal unsealed form already accepted by updater `verifyCodeSignature`, while rejecting damaged sealed packages; the signed/public release path retains its stronger requirements.
- Before publishing, test the exact 376 app and published hand-sealed 375 control with the same disposable launchd agent, isolated profile/HOME/port and exact-version boot-complete health. Preserve both outcomes; 375 may pass on this Mac because its macOS build differs from the mini's. Direct launch and `open` alone do not prove login-agent compatibility.
- Package and lock versions are 1.4.376; the matching dated changelog supplies in-app What's New. Gate receipts and launchd evidence stay outside tracked source so source identity remains fixed.
- Developer's latest direction authorizes the normal 376 package and mini update only after a fresh full gate, integration and final rebuild from main. No mini SSH, forced install or production-hold change is authorized. Developer reordered the gate window: wait for Hub's new `hub216-capacity-release-r6-20261103.exit` (Hub R4), plus Updater artifacts exit 0. The old Hub r5 exit 1 is historical and no longer releases Story's barrier. Receipt presence proves completion, not success.
- The first exact-source gate at `240c8254` ended 143 after the continuity test worker stalled. Two guarded waits now reach cleanup on early render failure (`945a87b`); the retry fixture explicitly enables one saved retry and persists its authoritative job (`248597d`), focused 39/39 exit 0. Late refused queue-checkpoint isolation warnings remain visible. The prior normal build and launchd comparison apply to `240c8254` only; both 375 and 376 launched here, so the mini's OS-specific launch constraint did not reproduce locally.
- Gate repairs retain the S1/S2 retirement of credit settlement and paid/free retry gates. Confirmed terminal failures need fresh request keys; response loss, held outcomes and cancellation keep their identity protections. Contextual Cues backpressure must use the published failure and hold state, not the removed settlement fields. Distinct explicit image actions must not inherit an older action's automatic-replacement gate. New failures do not create legacy paid-wait records; recovery fixtures must seed old committed records explicitly. Audio verification no longer stops at a retired local credit ceiling. Controlled combined repair checks completed all 32 files: 505/506 tests passed, actual exit 1, unchanged inputs; the sole remaining missing-reference state assertion was then corrected. Final image integration rerun passed 46/46, 1/1 file, actual exit 0, no skips/cancellations, unchanged inputs. Audio lifecycle cases passed in the combined run. Lint, model-drift and typecheck passed before the final fixture-only correction. Hub R4/r6 and Updater artifacts both exited 0. Exact-source preflight on `a2e10f08` passed lint/model-drift/types and frontend 3307/3307 across 372/372 files. Normal prebuild and disposable launchd 375/376 comparison passed; both versions booted here, with no owned process left after cleanup. Full gate then exited 1 at backend, completing 963/963 files with unchanged source. The five remaining failing files are repaired: boundary/control fixtures now assert settlement omission and null compatibility fields; policy fixtures exercise read-only bounded retries and historical scope preservation rather than retired paid waits/commitments; queue fixtures use a genuinely failed live task and the current retry switch. One runtime defect was removed: authoritative never-created stall recovery still required synthetic credit zeros that reconciliation no longer supplies. Its identity/hold/cancellation guards remain. Focused checks passed boundary 91/91 (2/2 files), queue 85/85 (2/2), and policy 47/47 (1/1), each actual exit 0, unchanged inputs, no skips or cancellations. Those partial checks preceded the successful repair-r2 gate and delivery recorded above.
- Remaining server/frontend credit cleanup, prompt sizing and the two-option image screen remain queued in the lead briefs; none is claimed completed here. Image modes still await published capability readback.

### Release 1.4.375 candidate — scene import, instant page data and review improvements (2026-11-02)

- Candidate only, not installed. Integrated `feat/scene-import-375` through `c8dbaf2a` and `feat/instant-data-375` through `a67bf5dd` into `release/1.4.375`, keeping the 1.4.376 retry work separate.
- Package and lock versions are 1.4.375; the matching plain-language CHANGELOG entry feeds the existing in-app What's New.
- Includes external scene/image uploads, per-channel clip lengths, exact missing-clip fallback reason, shared page cache and refresh status, Publishing channel labels, Review finals layout, Library preview viewer, and Sketch Draw reveals already integrated on this release branch.
- In-app proof verified the visible 1.4.375 badge and matching What's New entry in an isolated app. Shared page caching must not replace authoritative permission, transport, history, episode-status or account-health reads; those refreshes must retain their error and scope guards.
- Prebuild and the full ten-step detached gate are required before acceptance. The first complete frontend preflight exposed cache-integration failures; a fresh full frontend lane must pass after their correction. Gate evidence is recorded outside this tracked file so the tested source stays unchanged.
- Developer gives the separate go for a mini install at a quiet point. No install or Production action is authorized by this candidate.
- 1.4.376 subtitle and writing/audio retry corrections stay on `feat/no-credits-376`; they must not hold up this release. Their runtime suites stay paused while this gate runs.

### Release 1.4.374 — Sketch Draw finish and weight, re-plan staleness, cancel, grouped sound mix (2026-11-01)

- **Shipped:** main `2756ed0a`, gate4 passed 10 of 10 (`_orchestra/app-closeout-20261021/story-374/gate4`). Published on 1301 (sha `a1ecc679`) and installed on the mini at 22:33; on all four SSD kits. Ship with `KH_GATEWAY_URL=http://127.0.0.1:8787` (`gw.py` defaults to this Mac's own Gateway).
- **Sketch:** helper 7, compatible [2-7], so old clips stay fresh. `line_weight` factors thin 0.62, normal 1.0, bold 1.45; absent means normal. GOLDEN_V6 was re-recorded from the new helper, so it guards change from here on, not the old look; `_orchestra/sketch-finish-374-samples` is the evidence for that. Frame-hash goldens flake at quality 0.7 with encoders side by side.
- **Re-plan:** `services/scene-plan-staleness.ts`, proved end to end by `scene-plan-replan-image-batch-e2e` against the mock Gateway. A picture with no `rendered_prompt` is not stale.
- **Sound mix:** `SPOT_MIX_GROUP_SIZE` 24, lossless stems. EP0002's FFmpeg code 221 on the mini is NOT explained and does not reproduce on the Mac Studio. `ffmpegExitErrorLine` keeps the real line for next time.
- **Handoff recovery:** runs at project load only. How the record reached queued-with-finished_at is not proved.
- **Screens:** checked with Playwright and API mocks, `_orchestra/story-374-release/screens/`. Persistent channel create and Jobs at 375 px not seen.
- **Next after install:** Production retries EP0002; set The Curious Why to thin; check EP0001 doesn't read stale; try a real label proposal (the too-close reason line is unproven live, and 520 output tokens per label is unmeasured).
- **Style packs:** the live shelf styles are mostly `-v2` ids with no repo source; the shelf refuses the old ids as historical. Patch those from their shelf archives. See `_orchestra/neutral-styles-20261101/`.

### Release 1.4.373 — the bugs found running The Curious Why (2026-10-31)

- **Labels:** preset `min_gap_sec` (default 10, 1-600). Pacing judges the times as they read back after anchoring. Render skips a crowded label and names it. A saved start time clears `anchor_word` and stores `anchor_offset_sec`.
- **Pipeline:** force never joins older same-step work; `recoverMissingPipelineModel` re-reads the preset only when the frozen model is empty; `contextual_cues` is in `PRESET_MODEL_READERS`. Pipeline scene plans send `prompt_char_cap_selection` `auto`. `plan_stale_vs_stitched` uses `inspectPlanTimelineDrift`.
- **Scene Review:** forced runs count only this run's images. A status check no longer moves an unclaimed cancellation from queued to reconciling. The tests reproduce that race; it is **not proven** to be the only cause of EP0002's stuck cancel.
- **Still open:** labels on remote Macs. Exporter refuses them (`final-render-export.ts:97`); the design needs a late cue stage with motion across Story, Hub and Gateway. First prove ordinary finals go remote: 13 of 39 Macs offered, one remote final on record (2026-10-27).

### Release 1.4.372 — automatic upload, final-check hold, weekly results, Shorts (2026-10-31)

- **Automatic upload:** channel key `auto_upload` (`off` default, `private`, `scheduled`), set through `PUT /projects/:slug/publishing-schedule` or `settings/config`. `admitYouTubeUpload(slug, body, { automatic })` in `routes/youtube-upload-center.ts` is the one admission for manual and automatic uploads. Automatic never clicks through: a foreign episode claim always stops it, and a current passed final check is required whatever the channel's safety modes say. It fires from `scheduleEpisodeWithActivePlan`, so a held episode released later also uploads. The owner chose `scheduled` for the-curious-why only; set it after install. An episode that got its date before install does not upload by itself.
- **Weekly results:** `components/WeeklyResults.vue` on the analytics page; the switch is global. No topics or episode codes yet. Whether YouTube's click-through figure is 5.2 or 0.052 is **unverified**: compare the first real week with YouTube Studio.
- **Shorts:** `shorts_per_episode` (0-3, default 0), `POST /projects/:slug/episodes/:code/shorts`, job `episode_shorts`, files in `<episode>/shorts/`. The narration offset comes from the source stamp's `narration_offset_sec`, recorded on every render path from this release; older finals are refused. No upload yet. Framing (whole frame over a blurred copy) needs the owner's eye; no real episode has been cut yet.
- **Sleep tiers are NOT in this release.** Sources and registry records stay on `content/sleep-tiers-v2-20261031`; the built 1.0.2 packs are in `_orchestra/sleep-tiers-20261031/builds/`. With the tiers restored, `sleep-story-v2` and `sleep-history-compilation-v2` have the same machinery as their v1 Formulas, which `formula-substance-not-rebilled` refuses in the repository. Publish the packs on their own; merging the sources needs that collision settled first.
- The serial and pooled backend runs agreed on `e623befb` (9,850 pass, 2 skipped, 0 fail), so from 1.4.372 the gate of record runs the backend lane's normal worker pool.

### Pipeline remembered steps — 1.4.372 (2026-10-31)

- An admitted Pipeline batch saves only its requested step IDs in the channel's `pipeline_last_steps`; the existing safe config GET exposes the list. The page restores applicable steps and names unavailable ones. Batch requests still require explicit steps. Focused checks only; release gate, build, integration and deployment remain outstanding.

### Release 1.4.371 — work still open (2026-10-30)

- **Lenient stand-in pictures (`stand_in_for_prompt`).** The stale-image check in `auditSceneImageCompletion` would have failed the episode on the picture the 1.4.296 lenient rule deliberately keeps (borrowed from a neighbour, or the scene's own earlier one, on a free-fleet last try). The run now records the prompt it stands in for; completion accepts it for that exact prompt only, Scene Review still flags the mismatch, and a real picture clears it. Do not "fix" the lenient test to expect failure.
- **Labels (2026-10-31).** Ten `catalogue.d/<theme>.json` files plus six base designs: 94 in all. Source art, keying and registration scripts are in `_orchestra/explainer-style-20261030/labels/art/` (`key_themes.py`, `register_themes.py`); they are not in the repo. Art that came out magenta inside was recoloured teal, so many panels are teal. `label-designs` is an electron-builder extra resource: before this it was not packaged at all, and no test could see that. Confirm it in the built app.
- **`renderLabelDesign` ignored `text_color` until now**, and passed the cue's words to sharp unescaped as Pango markup. Both fixed.
- **Pointing limits:** `sceneNames` is whole words with a plural -s dropped, so a synonym is refused. A wrong object of a plausible size is not caught by anything. No real Gateway call has been made through `resolveLabelTargets` yet.
- **Fontconfig cost:** the first render with a named font took about 88 s in a test run. Not investigated; watch the first real label render.
- **`job-queue isolation violation` in `sound-and-labels-api`** logs after that test's assertions and fails nothing. Not fixed.

- Scene image completion now rejects an image whose recorded `rendered_prompt` differs from `visual_prompt`, matching Scene Review. Legacy images without a recorded prompt remain unchecked. Retry targets the unresolved scenes and keeps completed images. Focused `scene-media-checkpoint`: PARTIAL RUN, exit 0, 19 tests passed, 1/1 file completed. This is not the release gate.
- **Khmer thumbnails are text-free — DONE in `b6e156cd`, verified here.** `resolveTextStyle('none')` returns `''` instead of falling through to gold; the directive emits no `TITLE DESIGN` line and no recipe headline guidance for a text-free run; the save-step clause builder refuses a title clause for `none`; the generator passes `none` on Khmer or an explicit `none`, drops the typed custom treatment, and appends one Khmer sentence to the prompt; the independent music-thumbnail path does the same. Pinned by `thumbnail-headline-modes` (`a text-free directive contains no title design or recipe lettering`, `a text style of "none" gets no title clause and no gold lettering`) and `custom-lettering-text`. Presets and existing thumbnails are not rewritten.
- **Still Posts batch verdict is scoped (`e44f8a3b`)**: a `post_ids` redraw is judged on its own posts, re-read from disk after the loop wrote them; whole-batch and whole-channel runs keep their rule. Test: a damaged sibling fails a whole-batch run and does not fail a scoped one.
- **A failed Still Posts redraw settles (`ce6598f3`)**: the freshness bound is now the job's START (creation if it never started) instead of its finish, so a row that failed after drawing its own post can settle; only artifacts for the post's current art mode and aspects count, so an old 1:1 final cannot block a post now framed 9:16 only. A post still missing a piece still keeps the row. `job-settle-later-work` covers both directions.
- **"Repair missing output before Retry" is true again (`a71d8dd1`)**: only `audio` and `thumb_images` — the two types the Jobs page offers Repair for — keep that sentence and `repair_required`; any other type (e.g. `research_run`) now says "This step has no Repair action, so Retry runs it again". Test runs the mixed-settle case for both.
- **Lint (the gate's exact command, `eslint electron/server electron/main.ts`) exits 0**, 0 errors. Nothing in `.superpowers/` is linted: those staging scripts are outside the linted folders. No rule changed, nothing moved.
- **Backlog (needs real diagnosis, one line each — not fixed here):**
  - *Provider-state reconciliation*: the "unresolved provider evidence" paths (`hasUnsettledProviderEvidence`, `reconcile*` in `job-queue.ts`) need a live-reproduction session against the Gateway's task records before any rule changes; guessing here risks double-charging (§1, §8).
  - *Audio concurrency 3 vs 2*: `audioEpisodeConcurrency` is a published per-Mac setting (`audio_episode_concurrency`, default in `IMAGE_EPISODE_CONCURRENCY_DEFAULT`) plus one tail slot (`narrationTailRunning`); the complaint names numbers nothing in code asserts, so it needs the owner's setting on the Mac that showed it before it can be called a defect.
  - *Cover preflight warning*: no preflight message about a cover exists in `routes/pipeline.ts` under that name; the report needs the exact wording the owner saw before a fix can be scoped.
- Still open from before: preserve replaced scene images in Story Trash; investigate pause on running audio, failed dispatch evidence, empty project job history. No release gate, install, publication or production contact was performed in this work.
- **Retry replaces the row for EVERY job type** (`retryTerminalJob` in `services/job-queue.ts` deletes the original and enqueues a fresh one, no type-specific branch), so a retried `still_post_render` row vanishing from history is not a Still Posts-specific promise broken. The "row and its log stay" promise in `services/stale-failures.ts` is about SETTLING, not Retry. Changing Retry to keep old rows is a cross-type design change (§10 decision for the owner), not a local fix.
- **Pickers everywhere (`fc0c3110`).** `FilePicker` shows the file's name (full path on hover) and "File not found"; `FolderField` shows the folder's name, says "Folder not found", and its typed fallback is off by default; the in-app browser dropped its typed-path box and gained "Upload from this Mac" (`POST /system/upload-file`, raw body, 512 MB bound, into `<app data>/uploads`, which the existing adopt step copies into the channel). Server-mode picks already rerouted through `useApi`'s shim. "Show in Finder" hides in a remote browser. Every raw path input in the pages is a picker now; `frontend/__tests__/filePickerRemote.test.ts` pins the reroute, the upload, and the name/missing states. **Known limit:** the upload writes a copy in the app data folder before adopt copies it into the channel — the app-data copy is left in place (nothing deleted).
- **One Sound & Labels step (`85430342`).** `useProjectFlow` has one step (`sound-and-labels`, optional) in every flow, mapping to the single `contextual_cues` board field; the Feature Guide merged to one entry, and the two old route keys still resolve to it. Job types, preset types, stored data and redirects unchanged.
- **Gateway sound clips (`6e75063c`).** `ensureSoundClipCached` fetches `GET /v1/sounds/library/{sha256}/audio` once per Mac into `<app data>/sound-library`, verifies the sha256, matches filenames on what they END with, moves a corrupt copy aside (never deletes), and throws a message naming the clip when it cannot fetch — the render path resolves every approved cue before mixing. The env folder (`STORY_STUDIO_GATEWAY_SOUND_LIBRARY`) is **gone**; it had no caller outside the resolver. `listKeptSounds` now returns `tags` and `SoundCandidate.description` reads them.
- **Sidebar (`dashboard.vue`).** One pinned row (All Channels) under the brand; Overview/Workflow/Publish/Studio/Manage sections, every row a `nav-item` with an icon; Jobs/All Jobs badges moved into the Studio section; the old footer utility grid is gone; the active row is scrolled into view. Workflow rows stay data-driven from `workflowPhases`.
- **One header + one frame.** `components/AppHeader.vue` (brand, evenly spread links with the current page marked, `GenStudioStandingStrip` inline, Page guide, version) is rendered by `layouts/default.vue`; `components/PageTitle.vue` + `.page-frame` (design-system.css) give every application page one width, gutter, title style and action slot. Applied to All Channels, Publishing, Review finals, Studio Library, Usage, Trash and Settings. **`0 credits` on a private Gateway: NOT resolved here** — the figure is the Gateway's published `credit_balance` (a real number the app does not compute); reading the mini's live value was out of scope for this work (no live contact), so whether it means anything there still needs the owner's answer. The jobs/room figures are real and unchanged.
- **Settings is a page (`/settings`).** Same `ThisMacSettings` component, `?section=` mirrors the old modal sections, Save/Revert unchanged; the page reserves bottom space so the sticky Save bar no longer rests over the last row. The modal stays for in-dialog openings (Gateway strip, `ModelSelector`) — those keep working. `Dashboard`'s Settings row and the header link now go to the page.
- **All Channels.** Compact title+count line with search, sort, Cards/List switch (remembered, cards default) and New Channel; uniform cards with fixed slots and actions inside; a list view with narrow-width column drops; the big "Production workspace / Your channels" block is gone. `formulaCardLabel` (server) now answers **"Custom Formula"** instead of a raw id when a Formula's name cannot be read (owner, 2026-10-30), pinned in `channel-formula-recents`.

## 1.4.371 — old Wars ids keep working while every channel moves to the v2 Formulas; a wrong-script chapter is never saved (2026-10-30, release/1.4.371 from release/1.4.370 673b6cd1)

**Commits on `release/1.4.371`: `96277a72` (Story + script-language), `1ef599b8` (withdraw Wars 1.0.2),
the output-budget rule, and the v2-successor / outline-preservation / title-prefix / sizing batch that
follows it (`5fc548ca` is the withdrawn content commit, kept in history on purpose). Focused backend and content-pack runs are now green (PARTIAL RUN, not the gate): 17/17 backend files, 190/190 tests, 0 failures; typecheck and lint exit 0.**

- **OWNER DECISION 2026-10-30, superseding the first plan: every channel moves to the v2 Formulas,
  and script changes are accepted — v1 Formulas are no longer first-class.** The Wars 1.0.2 pack
  authored for the v1 Formula ids was therefore **withdrawn before publication**: its registry
  record is `retired` (transition revision **365**, reason recorded), the source moved to
  `_trash/content-packs/rebuilt/topic/wars-treaties-world-order-v2-v1.0.2/`, the catalogue index is
  back to 1.0.1, and no `KNOWN_UNRESOLVED` line refers to it. **Do not re-author 1.0.2 under this
  identity** — the record is retired and burns that version.
- **What the move relies on:** episodes store old Wars ids (Boundful the free item id,
  hidden-mechanics-of-history the BARE legacy id), and a v2 Formula's allow-list must accept them.
  The allow-list check resolves the alias table on BOTH sides, so it does — whether the v2 Formula
  names the old Wars id (free item, archival item or bare) or the merged item itself.
- **Unverifiable here:** the published v2 Formula sources are not in this repository (the only `-v2`
  Formula ids appear as strings in packs and `KNOWN_UNRESOLVED`), so their live
  `compatible_topic_pack_ids` could not be read. The mechanism is pinned by tests with both
  spellings. If a live v2 Formula names NO Wars id at all, that is a content gap and its allow-list
  needs widening on the shelf — the code cannot admit a pack the Formula never allowed.
- **The defect that started this, for the record:** the archival-ledger v1 Formula's allow-list names
  only its own `com.…archival-ledger.*` ids — never the BARE legacy id — so
  `composeNicheWithTopicPacks` dropped those episodes' Wars topic at the ALLOW-LIST check, even with
  no merged pack installed. History's v1 Formula names its own free item id, so Boundful/History only
  broke once the merged 1.0.1 was installed. The both-sides fix covers both.
- **Safe state during the move:** with 1.0.1 installed (it names only the `-v2` ids), a channel that
  has not moved yet composes its OLD pack through `loadSupersededTopicPack` instead of losing the
  topic. That fallback stays until every channel has moved.

### Commit `96277a72` — Story code (Topic Packs and script language)

- **Allow-list compares aliases on both sides** (`composeNicheWithTopicPacksDetailed`): the
  Formula's `compatibleTopicPackIds` and the requested id both go through `resolveTopicPackAlias`.
  A Formula that allowed an old Wars id allows the merged item, and a pack it never allowed is still
  dropped (`not-allowed`).
- **THE COMPATIBILITY FALLBACK RULE** (`loadSupersededTopicPack` in `services/topic-pack-loader.ts`):
  when the alias target is installed but cannot serve this Formula, the pre-alias sources that read
  as the same item are tried in turn (the stored id itself and every id the alias table sends to the
  same target) and the first compatible one is used. The merged item always wins when compatible;
  this only runs after it has been refused; a pack that was never the selection's source is never
  tried. So a Mac still holding 1.0.1 composes the OLD pack (free 50-subject or archival
  100-subject) instead of losing the topic.
- **A dropped selection is never silent.** `composeNicheWithTopicPacksDetailed` returns
  `droppedTopicPacks` (`not-allowed` / `not-found` / `incompatible`), `resolveCampaignNiche` passes
  them on, and the idea campaign logs one plain line per drop **before any paid call**. When every
  selected topic was dropped, the campaign says so loudly and says what it does instead: it PROCEEDS
  from the Formula's own example topics (the planner falls back to `exampleTopics` when no pack is
  active), and if the run then ends short the failure message says the packs cannot be used with this
  Formula instead of blaming "used up" subjects (§6, §8). The channel's idea-supply panel reads the
  same list, so it cannot say "ignored: not used" about a pack that is actually serving the channel.
  A job with no topics chosen is untouched.
- **List offers one row per topic** (`listTopicPackCatalogEntries(options, scopeFormulaId?)`): an
  entry whose id is an alias key is hidden only while the item it reads as is also listed AND (for a
  scoped read) that item can serve the scoped Formula. `GET /topic-packs` passes `?niche_id=` in.
  Data-driven from the alias table; no Wars constant; no state, pin or file changes.
- **Removal veto now reads episodes** (`content-packs/removal.ts`): topic selection is really stored
  per episode (`episode_info.json` `topic_pack_ids` + `series_formula_id`), so every episode file
  under `<project>/episodes/**` is read, and each topic selection is resolved the way a generator
  resolves it (merged item first, superseded pack second). A bare legacy id therefore vetoes the
  merged pack; the OLD pack stays removable while the merged one is what is read; with no merged
  pack installed the old pack IS what is read, so removing it is vetoed. An unreadable episode file
  makes the channel "could not check", never "unused".
- **Other readers checked:** `PUT /projects/:slug/niche` and the ideas route now compare the
  RESOLVED Formula id and accept the superseded pack, exactly like the composer; the picker still
  reads `compatibleNicheIds`/`compatibleFormulaIds` from the listed item, and a saved old id still
  shows selected through `GET /topic-packs/:id` → `pack-selection.ts`. **Known limit:** the picker
  loads `/topic-packs?view=list` UNSCOPED, so while a channel is still on a v1 Formula its saved row
  shows but the old pack is not offered as a NEW choice (the merged row is listed and the old rows
  are hidden). It resolves itself as soon as the channel moves to its v2 Formula.

### The output-budget rule — the request is bounded by the model's own context window, everywhere

- **The defect (owner, 2026-10-30):** Story sent `max_output_tokens: 64,000` to
  `studio-hub::mlx-community/gemma-4-26B-A4B-it-qat-4bit`, whose published
  `context_window_tokens` is **32,768**. The published OUTPUT ceiling is larger than the whole window, so the
  "within its published output limit" guard passed. Chapters already bounded this
  (`expansionOutputTokenCap`); research, outline and metadata each size their own budget and only the
  submission boundary sees the live figures.
- **The one rule** (`boundOutputTokensToContext` in `services/output-token-budget.ts`):
  `min(published output ceiling, context_window_tokens − this prompt's tokens)`. The prompt's size is
  the app's one characters÷4 prompt estimate (`PROMPT_CHARS_PER_TOKEN_ESTIMATE`, the same number
  `CHAT_ALLOWANCE_CHARS_PER_TOKEN` now derives from) — an estimate of OUR input, never a
  words→tokens conversion of the answer. No product id and no fixed ratio to the answer.
- **Where it is applied:** `prepareChatSubmission` in `lib/genstudio-client.ts`, the single place
  every writing request passes through (research, outline/chapters via `callAi`/`callForJsonArray`,
  metadata, idea campaigns, scene packs). The clamp precedes the wire body AND the idempotency
  digest. A prompt that leaves no room throws before submission with both figures and
  "No request or credit charge was made."; `expansionOutputTokenCap` now calls the same function, so
  the chapter path and every other path cannot disagree. A product publishing no window (or `0`, the
  parser's "not published") is unchanged; a product publishing no output ceiling still sends none
  (owner decision #6). Recompute is free: the catalogue read already happens per submission, so a
  model switch is measured afresh.
- **Tests:** `electron/server/__tests__/chat-context-window-output-cap.test.ts` — the reported
  product's numbers on the wire (`32,768 − prompt`); the arithmetic (window vs ceiling, no ceiling,
  no window, overflow); refusal before any submit with both figures; no-ceiling product omits the
  field; no-window product unchanged; a model switch recomputes. `--only` substring:
  `chat-context-window-output-cap`.

### Topic Packs: v1 ids read their v2 item on a moved channel (2026-10-30)

- **The gap the v2 Formula comparison found.** Every v2 Formula's allow-list names `-v2` topic items and every
  v2 Topic Pack accepts only `-v2` Formulas, but EPISODES keep the v1 item id they were written with
  (`episode_info.json`, never rewritten — §5). Without a successor lookup every moved channel would
  lose its topics on the first read.
- **Data, not parsing** (`TOPIC_PACK_V2_SUCCESSORS` in `services/topic-pack-loader.ts`): a literal table of
  v1 item id → v2 item id, looked up exactly; no code appends `-v2` (AGENTS §4). The ids follow the
  naming the merged Wars wave used (the 2026-10-27 merge record names
  `…archival-ledger.wars-treaties-world-order-v2`). **An entry is inert unless a pack publishes that exact
  id** — a topic with no v2 pack never resolves, so a stale row can hide nothing and use nothing. The two
  Wars v1 ids are absent on purpose: `LEGACY_TOPIC_PACK_ALIASES` already sends them to the merged pack.
- **Covered**: every topic item id this repository publishes (43 rows) — the 4 other archival topics,
  ancient-humans-survival, deep-time-earth-systems, night-journeys, food-histories,
  drinks-and-spices-histories, everyday-object-histories, economics-businesses and the rest. **Not
  verifiable here**: the published v2 Topic Packs are not in this repository, so which topics have a v2
  pack at all could not be confirmed; the table must be extended (a data edit) if a v2 pack publishes
  under any other id.
- **Resolution rules**: the allow-list accepts either spelling (v1 id or its v2 successor); a stored id
  reads its v2 item when that pack is installed AND compatible with the channel's Formula; a channel
  still on a v1 Formula keeps its v1 pack (the v2 pack is not compatible, so the successor is never
  used); already-v2 ids pass through; a v2 pack that is not installed leaves today's behaviour and the
  drop is reported. The list hides a v1 row while its v2 row is listed and can serve the scoped Formula.
  The removal veto resolves the same way, so a moved channel vetoes removing the pack it actually reads
  and leaves the v1 pack removable.
- **Tests**: `topic-pack-v2-successors` (each spelling composes the v2 pack with its real subject text;
  v1 Formula keeps v1; v2 missing is reported; never-allowed stays dropped; one list row; no file
  written) and the v2 case in `content-pack-removal-episode-topics`.

### Outline copies, title prefixes, and the sizing a rebuild keeps (2026-10-30)

- **Nothing deleted for good** (`preserveOutlineSidecar` in `lib/chunked-narration.ts`). A `force` rebuild
  and `PUT /outline` used to overwrite the progress sidecar in place. Both now copy the outline they
  replace into Story's Trash under `script-versions/outline-<rebuild|edit>-<ms>/`, the same shape the
  chapter writes use (`copyToTrashSync`, never a move); a first build copies nothing and creates no
  folder, and progress writes (`chapters_done`) are untouched so a long episode does not fill Trash.
  Tests: `outline-preservation` (helper: copy exists, original untouched, two rebuilds keep two copies,
  first build adds nothing) and the PUT case in `outline-routes`.
- **Outline titles** (`stripOutlineTitlePrefix`): Haiku put "Chapter 1 " inside each title, producing
  "## Chapter 01: Chapter 1 …". The leading label + number is stripped at parse time only — the format's
  own section label, "Chapter", ជំពូក and ភាគ, with ASCII or Khmer numerals, and only when a separator or
  space and a real title follow. Khmer prose with no numeral, a title that merely contains the words,
  and a title that is only the label are left exactly as written. Test: `outline-title-prefix`.
- **THE DM0021 SIZING DEFECT.** Its outline was 20 chapters; a `force` rebuild carrying only `force`,
  `model`, `title` and `episode_id` produced 6 with no message. Cause: an outline BUILD reads the
  REQUEST (`setupChunkedJobContext`, source `'request'`), so the episode's own recorded plan (sidecar
  `total_chapters` + `generation_params`) was ignored and the count fell through to
  `format.script.defaultChapterCount` — the Formula's default as resolved that day, which is how the
  original 20 and the rebuild's 6 could differ with the same absent input. Fix: ONE resolution
  (`resolveScriptSizing`, `lib/script-sizing.ts`) used by every script path — the request, then this
  episode's existing outline, then the Formula — with words as chapters × words-per-chapter (per-chapter
  target, else total ÷ chapters, else the Formula's length × pace, else the neutral 550). The job log now
  prints the resolved count, chapter length and episode length WITH the source of each, so a default is
  never silent. A UI path can still omit `chapters` (the review panel forwards the form, which is empty
  until the Formula loads; a Script preset may name none) — the episode's own sizing now covers it.
  Tests: `script-sizing-resolution`.

### Commit `96277a72` (continued) — language: a chapter in the wrong script is not saved

- `lib/content-language.ts`: `measureAnswerScript` counts Khmer letters (U+1780–U+17FF, U+19E0–U+19FF)
  against Latin letters and ignores everything else. An answer is Khmer when it has ≥30 Khmer letters
  and Khmer letters are ≥20% of its letters — English names, numbers and borrowed terms inside Khmer
  prose pass; an English chapter or refusal has none. `answerMatchesLanguage` enforces the channel's
  own `content_language`; a channel with no stated language is never checked.
- Paths COVERED: chunked chapter batches (`parseAndWriteBatch` — wrong-script chapters are not
  written, not marked done, and logged with the reason, so Retry asks only for them); a one-chapter
  rewrite (`generateChapterOnly`); the introduction (`generateIntroductionOnly`); the chunked outline
  (`buildOutlineOnly` — wrong-script titles/hooks/synopses throw before the sidecar is written).
  Paths NOT covered, deliberately: a manual chapter edit (the owner typed it), episode import
  (third-party text), and title/metadata generation (out of the stated scope).
- The language instruction is now the LAST paragraph of the chapter, repair, outline and
  introduction prompts (`languageDirectiveTail`) — an injected "reply in English" line used to come
  after the system prompt's directive and win.
- **The completeness audit IS script-aware now (owner decision, 2026-10-30).** A chapter in the wrong
  writing system counts as MISSING wherever the channel states a language — one rule shared by the Board
  (`asset-status` → `inspectChunkedScriptCompletion`), the Pipeline preflight, Resume, the job-completion
  audits (`inspectExpandedScriptCompletion`) and `expandChapters` — so all of them agree (§8). Nothing on
  disk is rewritten, a channel with no stated language is never checked, and an unreadable file is never
  failed for its script alone. COST: a verdict is cached by (path, language, mtime, size) in
  `chunked-narration` (`chapterMatchesLanguage`, capped at 4,096 entries), so a Board load reads each
  chapter's text at most once per edit and the episode status itself is cached above this; an English or
  language-less channel reads no chapter text at all. `domnak-kmouch` and `pronom` had NO
  `content_language` set and were being set to `km` during the repair — **by design a channel with no
  language is unchecked, so this fix does nothing for either until that setting is saved.** Production's
  read found only DM0021, DM0022 and PR0040 in the wrong script (being repaired). Test:
  `script-completeness-audit` (complete, wrong-script + reason, mixed, no language, English names in
  Khmer, English channel).

### Tests (focused run green; full gate still to run)

- `electron/server/__tests__/topic-pack-wars-merge-compat.test.ts` — a v2 History Formula that
  allows the old free item id + that stored id → merged 1.0.1 (122 subjects pinned, non-empty text);
  a v2 Formula (History and archival-ledger) whose allow-list names the merged item accepts the BARE
  legacy id; a v2 archival Formula allowing its archival item accepts the bare id; v1 History +
  merged 1.0.1 + old free pack composes the OLD pack (50 subjects); v1 archival + bare id + no
  merged + old archival pack (100); never-allowed + not-installed are reported; list = one row with
  old+old+merged, old rows without it, old row kept for a v1 scope and hidden for a v2 scope;
  composing writes no file (byte-for-byte snapshot).
- `electron/server/__tests__/content-pack-removal-episode-topics.test.ts` — an episode's bare legacy
  id vetoes removing the merged pack; the old pack stays removable while the merged one is read; with
  no merged pack the old pack is vetoed.
- `electron/server/__tests__/script-language-script.test.ts` — wrong-script chapter not written and
  named; mixed batch keeps the good ones; Khmer with English names passes; English channel
  unaffected; no language = no check; refusal-shaped answer writes nothing and names the reason; the
  prompt tail is last and absent when unset.
- Also written: `topic-pack-v2-successors`, `script-completeness-audit`, `chat-context-window-output-cap`,
  `outline-preservation`, `outline-title-prefix`, `script-sizing-resolution`, and the PUT case added to
  `outline-routes`.
- Focused substrings for when the gate ends: `topic-pack-wars-merge-compat`, `topic-pack-v2-successors`,
  `content-pack-removal-episode-topics`, `script-language-script`, `script-completeness-audit`,
  `chat-context-window-output-cap`, `outline-preservation`, `outline-title-prefix`,
  `script-sizing-resolution`, `outline-routes`, plus the existing `topic-pack-legacy-alias-read-time`,
  `content-pack-removal`, `idea-supply`, `content-pack-user-forks`, `chunked-narration-smoke`,
  `source-manifest-integrity`, `output-token-budget`, `chat-expected-output-tokens`, and the content-pack
  lane's `compatible-formula-ids-resolve` / `content-pack-registry` guards.

### Verification on this source

`npm run typecheck` (electron + frontend) exit 0; `npm run lint` 0 errors; `npm run check:changelog` ok; `npm run content-pack:registry -- validate` revision 365; focused backend run 17/17 files, 190/190 tests passing (PARTIAL RUN). The prebuild, ten-step gate and DMG from `main` are still to run.

## 1.4.370 — Library works with a retired pack; honest failure reasons; bounded Pipeline ids (2026-10-30, release/1.4.370 from main 77f433f0)

**Not yet released.** Static checks and focused runs are green; the ten-step gate, prebuild and DMG
are still to run.

- **One bad row no longer blocks the Store** (`lib/genstudio-content-store.ts`,
  `parseContentStoreReceipts`). A retired family publishes `download_available: false` while its
  release archive stays on disk (Gateway 0.2.213, 2026-10-27 — `oil-painting-classical-v2`, folded
  into `academic-classical-oil-v2`). The parser demanded the two fields agree and refused the WHOLE
  `/v1/content/receipts` answer, so every install and every Restore failed. It now rejects only the
  impossible direction: `download_available: true` with no current-release archive. Both are
  statements about different things, and both are true for a retired family.
- **A retired row is not offered for install and not installable** (`services/content-store.ts`,
  `services/content-store-delivery.ts`). The public account derived `downloadAvailable` from
  `archive_available`, which re-offered a retired family; it now reads the signed receipts'
  own `download_available` per family (the account endpoint does not publish it). The archive
  fallback remains only for a load that had no receipts to read, and that answer is already
  `unverified`. Delivery refuses a needed download with `409 CONTENT_PACK_DOWNLOAD_WITHDRAWN` —
  placed AFTER the local-copy check, so an installed copy keeps working and a dependency that is
  already installed is not refused. Nothing on disk is rewritten.
- **Say the real reason** (`routes/content-store.ts`). `projectFailure` maps
  `GenStudioContentStoreResponseError` to `502 CONTENT_STORE_RESPONSE_INVALID` with
  `The Gateway answered, but not with a Studio Library response: …`, the same wording
  `contentStoreSectionFailure` already uses. The async route's `presentFailure` fallback (and
  `startOwnedContentStoreReleaseInstall`'s last resort) used `CONTENT_STORE_UPSTREAM_REFUSED` for an
  unclassified failure — a refusal that never happened. Both now report
  `CONTENT_STORE_INSTALL_FAILED` with the safe detail; the frontend maps both new codes.
- **Pipeline handoff ids are bounded** (`services/job-queue.ts`, `pipelineHandoffChildId`). A parent
  that is itself a handoff gets `pipeline-handoff-<24 hex of sha256(parent_id + step)>` instead of
  another 17-character prefix. Deterministic (same parent + step = same child, which is the
  idempotency key), 96-bit, 41 characters flat. A first-level child keeps
  `pipeline-handoff-<parent>`. Saved markers carry `child_job_id`, so existing markers and queued
  children keep working and nothing is rewritten.
- **The loop question: there is no loop.** Production evidence (EP0017, 2026-10-28
  `finish-november-20261028`): `research_run 1813dc57` (chain 9) → `pipeline-handoff-1813dc57`
  outline (chain 8) → `pipeline-handoff-pipeline-handoff-1813dc57` expansion (chain 7) →
  `pipeline-handoff-pipeline-handoff-pipeline-handoff-1813dc57` audio (chain 6). One segment per
  successfully completed step and the chain shrinks by exactly one, so the length is the Pipeline's
  own step count (max 17 links today, after `script-only` expands to outline + expansion). Retry does
  not compound it: a job with a saved handoff marker refuses Retry, and a fresh retry gets a random
  id. The real cost was that `generators/scene-clip.ts` embeds the child id in
  `.${scene_id}.${job_id}.candidate.mp4`; a long chain reached ~280 bytes and the 255-byte filesystem
  component limit. No reader parses the id (checked); it is only compared whole.
- **Tests.** New `pipeline-handoff-child-id.test.ts` (stability, distinctness, bounded length, the
  scene-clip filename bound). `pipeline-handoff-lifecycle.test.ts` also asserts the real chain's ids.
  `content-store-routes.test.ts` covers the live retired shape end to end (another pack installs,
  retired row not offered, install refused, installed copy kept) and the unreadable answer / unknown
  failure reasons; `genstudio-content-store-delivery.test.ts` pins the parse rule.
- **Not yet proven (owner).** The ten-step gate and the DMG from `main`. `package.json` gained
  `allowScripts` for esbuild/fsevents/electron-winstaller because npm 11 blocks those postinstalls on
  a clean `npm ci` (the electron binary was installed with `node node_modules/electron/install.js`).

## 1.4.369 — six branches in one release: font pool, Library removal, settling jobs, one copy per pack, Formula packs (2026-10-30, release/1.4.369 from release/1.4.368 052c04e1)

**Released.** 1.4.369 passed the ten-step gate and is live on the mini.

Merged with `--no-ff`: `feat/still-post-font-pool-20261029`, `fix/library-download-only-20261029`,
`fix/job-settle-and-admission-20261029`, `fix/one-copy-per-pack-20261029`,
`content/quote-shorts-still-posts-packs-20261029` (which already carried
`feat/quote-shorts-duration-range-20261029`). Only `CHANGELOG.md` conflicted, on four of the five
merges; both sides were kept, then folded into `## v1.4.369`. The authoring registry and the
catalogue index were **regenerated, never hand-merged** — see below.

What to know:
- **Still Posts lettering font pool** (`contracts/still-post-fonts.ts` is the one implementation, shared with the page through `@shared/still-post-fonts`): one pool per ISO 15924 script on the still-post preset (`font_pools`). Empty pool = the format's own face, byte for byte; one font = every post; several = **serial by default** (pool order, wrapping) or weighted (percentages, shown in the picker, largest-remainder to 100). Only weighted avoids a back-to-back repeat, and `allow_repeat` opts into true random. `rng` is injected for the tests.
- **Where the rotation stands** is channel runtime state, NOT preset content: `still-posts/font-pool-cursor.json`, `{script: {last_font_id, last_index}}`, written atomically under a lock, advanced **only after** the post record is written. A pool edit mid-run (add/remove/reorder) or a restart continues from the last id in the CURRENT order; a removed last-used id falls back to the stored index (the face that slid into its place).
- **A post keeps its face**: `StillPost.font_id` is recorded at creation and wins in `textStyleFor`; a post with none keeps the format face. Changing a post's language to another script BLANKS it and says so in the response (`font_note`).
- **Coverage is refused, never substituted**: a face whose manifest does not list the script is refused by name at preset save, batch preflight and the write job. The picker offers only manifest-covered faces (`StillPostsWorkspace.fonts`).
- **The handle** deliberately stays on the format's face (`brandingFor`), not the post's pool face — the mark must read the same on every post. Owner can change this if he disagrees.
- **Twenty-nine new OFL/Apache faces** in `bundled/fonts/` (+5.38 MiB on disk, 36 bundled in total): handwriting, brush, text and Khmer families, incl. twelve Khmer faces. Each was hash-checked against Production's manifest and verification file, licence-checked (27 SIL OFL 1.1, 2 Apache-2.0 with `LICENSE.txt`), family-name-checked, table-checksum-checked and cmap-checked with `lib/font-coverage.ts`. Every Khmer face draws the letters and is missing exactly the 24 Khmer codepoints Production expects (U+17DE/17DF, U+17EA–17FF) plus all six punctuation marks; every Latin-only face has no Khmer and no CJK.
- **Weights are never synthesised** (owner, 2026-10-29): `nearestWeight(wanted, face.weights)` names the nearest weight the face really has, so a one-weight face answers every request with its one real instance (measured: Moul returned byte-identical pixels for Regular/Medium/Bold before the change).
- **One punctuation fallback for Khmer** (`lib/thumbnail-text-render.ts`): Pango's comma-separated family list is used only for glyphs the first family lacks (measured: `Moul, Inter Regular 48` draws every one of the six pixel-identically to Inter alone, and adding the list changes nothing when the face has the glyph). The fallback face is chosen from the manifest — the first Latin-only `text` face that really carries all six (today Inter) — and the render report carries `fallback_family`, shown in the editor. **libass/caption burns are NOT covered** by this: ASS has no family list, so a Khmer caption with a curly quote still relies on CoreText's own fallback.
- **Studio Library is a download page** (`content-packs/removal.ts` is the one removal implementation): install, update, Remove from this Mac, and Gateway removals arrive here. No ownership, price or purchase wording; Recall notices stay. A removal is refused while a channel uses the pack (Formula, topic, style, presets, pins; an unreadable channel is "could not check", never "unused") and while another installed pack depends on it, naming what answered. Bytes move to Story's Trash with a ledger (`removals.json`), Restore moves them back, and `completeInterruptedContentPackRemoval` finishes an interrupted removal at startup. Routes live in `routes/content-packs.ts`.
- **Jobs settle on proof, never on a retry** (`services/stale-failures.ts`, `services/job-queue.ts`): a failed Still Post, scene-clip or Scene Plan row clears only when later work proves the output exists by the one freshness rule (`auditSceneClipCompletion`); anything it cannot prove stays visible (§6, §8). Job admission now asks the same resolver the generators use (`assertEpisodeCodeAdmitted` over `storedEpisodeNumber`), so an episode code from an older prefix such as AU0001 is admitted instead of failing after it starts. Every job type is classified as episode-scoped or not, and a test fails if a new type is missing.
- **One copy per pack** (owner, 2026-10-29 — "no custom, no built in, all from packs"): the Formula, Topic Pack and Style Library pickers list installed pack items only (`listNicheCatalogEntries`, `topic-pack-loader`, `visual-style-loader`). Built-ins, `user:` forks and user style packs are not listed, but every stored id still resolves — `LEGACY_FORMULA_ALIASES`, `LEGACY_TOPIC_PACK_ALIASES` (incl. the two superseded Wars ids → the merged v2) and `style-aliases` (incl. AWBU → Bold Illustrated History) — with the old file as a read-only fallback. A saved selection no pack publishes is shown as "(not in a pack)" via `frontend/composables/pack-selection.ts`; nothing on disk is rewritten. The Wars v2 pack is authored; the free 1.0.3 and archival-ledger 1.0.2 packs are marked `lifecycle: replaced`.
- **Formula packs and per-channel forks**: `com.storystudio.pack.formula.quote-shorts` and `…still-posts` (v1.0.0) plus `…music-mix` carry the built-ins' content under registry ids; `still_posts_format` joined the pack schema. `content-packs/user-forks.ts` now resolves **both** kinds through the loaders' alias tables — the Formula branch through `resolveFormulaAlias`, the Topic Pack branch through `resolveTopicPackAlias` (the 2026-10-30 follow-up, with tests in `content-pack-user-forks.test.ts`) — so editing a pack-pinned channel forks the pack instead of 404ing, and a Mac without the pack still forks the legacy file.
- **New packs and their floors**: quote-shorts and still-posts require **1.4.369** (fixed — `still_posts_format` is new); music-mix requires **1.4.359**, the app version whose pack schema first carried `music_format`. The two Wars supersession packs (free 1.0.3, archival-ledger 1.0.2) are `release-bound` and take the floor in `content-packs/release-floor.json` (today **1.0.843**) through `{{MIN_APP_VERSION}}`. Authoring registry: the two branches both minted 354–357 from expected_revision 353; one-copy's 354–357 were kept and the content branch's five mutations were re-applied with `authoring-registry.mjs reserve|transition` on top (revisions **358–362**), then `validate` passed at revision 362. The catalogue index was regenerated with `npm run content-pack:index` (236 items).
- **Built-in removal checklist for a later release** — do NOT do this now; the built-ins are the fallback for a Mac without the packs, and the alias-read-time tests enumerate them:
  1. `electron/server/niches/quote-shorts.json`, `still-posts.json`, `music-mix.json` once their packs are installed everywhere.
  2. The remaining `electron/server/niches/*.json` profiles that read through `LEGACY_FORMULA_ALIASES`.
  3. `electron/server/topic-packs/*.json`, behind `LEGACY_TOPIC_PACK_ALIASES`.
  4. Built-in visual styles / user style packs behind `style-aliases.ts`.
  Each step must keep `npm run content-pack:registry -- validate`, the alias read-time tests and `legacy-migration-dispositions.json` in step with the files removed; removing a source without updating its table fails those tests by design.
- **Shop pricing does not apply.** The new packs carry entitlement `sku`/`family` ids for Store identity only; Story Studio has no shop, so nothing here is priced, charged or refunded. Library removal is a download-page action, not a return.
- **Environment notes**: the 1.4.368 gate held this Mac throughout the merge, so nothing but static checks ran until it finished (gate-c: exit 0, 10/10). After it ended, every test file the six branches added or changed was run focused, plus directly related existing files: backend 20/20 changed files (225 tests + 45 suites) and 39 related-file files, content-pack 9 files / 85 tests, frontend changed files 214 tests and a second related batch 78 tests — all green. Each `--only` run prints its own PARTIAL RUN banner; none of these is the release gate, which is still to run, along with the DMG. `/tmp/regreq-369/` held the re-applied registry request files — disposable.

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
