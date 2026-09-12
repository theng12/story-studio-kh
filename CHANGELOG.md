# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.4.154 — 2026-09-13

- All Jobs includes durable jobs from every existing project, even while the Library list is incomplete. Loading and read failures no longer appear as an empty queue, and updates arriving during the first snapshot are retained.
- Jobs adds individual selection, Select needs attention, Select all matching, and Abandon and clear selected. One confirmation names the scope; progress and per-job failures remain visible. Files and billing records stay intact, and accepted provider work can still finish.
- Automatic image replacement can retry one confirmed fully refunded generic image failure when the saved policy and current switch allow it. Submission uncertainty, refusals, cancelled work, charged generic failures and repeat replacements remain excluded; switching automatic replacement off prevents the next submission.
- Settings → Free up space lists episodes with verified ready YouTube uploads, previews selected media and exact files, then archives verified copies or explicitly removes local files. Progress, Stop and file outcomes survive page navigation. Active work, shared storage, changed files and unverified exports are excluded. Upload Center links directly to this workflow.
- Episode lists, Pipeline and Production Board distinguish local media cleanup from real asset readiness. Cleanup retains upload records, scripts, prompts, subtitles and billing evidence; ordinary Pipeline runs do not regenerate deliberately cleaned media. Force re-run remains explicit and still checks normal prerequisites and costs.

## v1.4.153 — 2026-09-12

- Jobs: historical subtitle gap links now read timeline metadata without repeatedly hashing chapter audio. Account polling shares pending requests and respects the existing refresh window; the credit header requests only the account overview it displays.
- Shared settings reuse parsed data while the file is unchanged, detect external updates, and keep callers’ editable values independent. Channel identity appears as soon as it loads; loading or unavailable identity no longer shows a false missing Series Formula warning.
- Content Store: purchases acknowledge their completed receipt before refreshing the catalog. Installs show downloaded bytes and verification/install phases in the shared background queue. Product details reflect queued, installed and failed states immediately, and repeated clicks reuse an active install.
- Pipeline: confirmation opens immediately while selected episodes are checked. Cancel and project changes discard stale checks. Batch preflight reuses project facts within the request while preserving readiness and spending checks.
- Archive uploaded videos: folder browsing shows busy/error feedback, and upload-proof scans run in the background with progress and Stop. Unreadable sources fail clearly. Moves remain limited to the reviewed folder and uploaded files, with verified copies before removing originals; same-disk moves are described as organization rather than reclaimed space.

## v1.4.152 — 2026-09-12

- Scene Review: thumbnails, clips and audio now carry their own version, so a background refresh only reloads media that actually changed. The render poll waits for the previous read before asking again. A 288-scene episode’s review read runs its file checks in parallel instead of one after another.
- Upload Center: the review dialog opens immediately and can be closed while the exact payload is still being built. The rendered video’s identity is remembered while the file is unchanged, so Review then Upload no longer reads the whole file twice, and hashing reads in larger chunks (a busy Mac took 25 s per review; measured under equal load: 61 s → 2.5 s first time, 0.5 s after). Upload acknowledges the queued job at once and reloads the list in the background; a second Upload is withheld until the list confirms the job.
- Upload Center: Close and the primary action stay pinned in both review dialogs. Bulk review can be closed while it queues; queueing continues, a strip on the page shows progress with Stop and Show, and queued uploads remain in Jobs. The publishable list resolves the export folder once per request instead of once per episode.
- Content Store: installs run in one app-wide queue that survives leaving the page, with a strip on every page and each card naming its state (Queued to install, Installing…, Installed, Install failed). Each queued install skips the server’s overview rebuild and the queue re-reads the overview once at the end. Discover has Select all purchasable. A batch purchase can be hidden while it buys and reports its result on the page. The overview asks GenStudio for account, catalog and receipts together, stats installed pack files per directory instead of one at a time, and uses the native CRC-32.

## v1.4.151 — 2026-09-12

- Audio Assembly keeps merge, preview, and output choices in a persistent action bar. Replace the active merge by default; creating another version remains an explicit choice.
- Detect replaced chapter audio in Subtitles, mark only affected transcripts outdated, and update those chapters while retaining unchanged subtitles. Show the last stitch date and local time, including seconds, separately from freshness warnings.
- Ordinary Audio Retry reconnects to the saved request when provider submission is uncertain instead of starting another paid request.
- Replace confirmed failed audio sections or writing requests directly from Jobs. Preserve successful output and reconnect to accepted replacement requests after interruption.
- Add separate, off-by-default automatic Audio and Writing replacement settings with additional-credit limits and one automatic replacement per failed item. Automatic replacement requires GenStudio's advertised spending-limit support and confirmed settled failure; uncertain submissions remain recoverable without duplicate generation.

## v1.4.150

- Jobs: Retry all shows live progress and separates queued retries, already-complete episodes, and blocked checks, with episode-specific reasons.
- Episode recovery checks run independently without holding the whole project behind a slow episode. Queued and running recovery jobs reuse their saved identity without repeating the full prerequisite scan.
- Existing outputs, provider receipts, and safeguards against duplicate generation remain intact.

## v1.4.149 — 2026-09-11

- Explain subtitle gaps with separate chapter-audio positions, full-episode positions, and the number of seconds without subtitles. Clarify the audio player’s clock and that a subtitle gap alone does not prove the audio is wrong.

## v1.4.148 — 2026-09-11

- Start Video Assembly on the first Generate click when the caption check requires no review. Show “Checking captions…” and disable repeat clicks while checking; real caption previews still require confirmation.

## v1.4.147 — 2026-09-11

- Choose Scene Plan or Image Pool per episode from Pipeline and Scene Plan. Mixed batches skip inapplicable visual steps, and the Board and completion filters follow each episode’s source.
- Set Visual timing & motion in Scene Plan: keep uniform scene timing or use successive pacing periods, with motion off, opening only, selected scenes, or all scenes. Existing plans and approved clips stay unchanged until deliberately edited or rebuilt.
- Keep queued visual requests attached to their accepted source and scene selection. Missing-only prompt work uses the saved plan, and out-of-scope scenes do not trigger new motion generations.
- Treat provider-confirmed no-record requests as terminal, uncharged missing work even when an older queue hint said they were running.
- Preserve saved Image Pool picks from old B-Roll selection actions. Prevent old recycling exclusions from dropping Scene Plan scenes, and retain the narration-tail duration correction during encoding.
- Keep writing pages, visual reviews, publishing profiles, thumbnail templates, settings and shared episode indicators attached to the current project. Show failed loads and saves, and prevent overlapping saves from losing choices.
- Clarify missing audio/subtitle prerequisites, hide unpublished model batch limits, and retain an episode’s motion intensity when an older preset has no saved intensity.

## v1.4.146 — 2026-09-11

- Pipeline now stays open after Run Batch or Repair. A result dialog shows the accepted job count, existing work and skipped or blocked episodes, with Stay on Pipeline and View Jobs choices instead of an automatic redirect.

## v1.4.145 — 2026-09-10

- Failed and cancelled jobs now offer a small, named link to their work tab, opening the job’s own project and episode directly from Project Jobs or All Jobs. Repair and Retry continue to work in place.

## v1.4.144

- Choose Image Pool slideshow as an episode's visual source in Video Assembly. Reuse the saved still-image selection in order at its chosen interval through the full narration; Scene Plan keeps its existing timing mode.
- Keep Assets Library files, scans, tags, edits and unregister confirmations attached to the selected pool when requests overlap. Loading failures show a retry action.
- Offer video normalization only for video pools; image and sound pools retain their original media.
- Keep Subtitles usable while transcription model language capabilities are unavailable, with disabled actions and an explanation instead of a rendering error.

## v1.4.143

- Subtitle gap warnings now offer chapter audio playback and a direct Audio Generator link with that episode and chapter selected. Playback seeks near the gap and follows the active audio parts without generating or replacing anything.
- Chapter rows separate Listen, Audio Generator and Generate/Regenerate subtitles actions, and retain the server's audio-quality findings.
- Audio previews preserve active version selection and numeric multipart order. Playback errors offer Retry, and switching episodes stops the old player.

## v1.4.142

- Hide completed or recovered Jobs without deleting their files, receipts, or unfinished settlement tracking. Restore hidden cards, undo a hide, and surface new failures automatically.
- Keep subtitle previews, stitching, Audio Assembly scans and music choices, and Video Assembly scenes, title images and caption checks attached to the selected episode when requests finish out of order.
- Reuse accepted submissions when retrying an uncertain Ideas campaign, outline, chapter expansion or YouTube Finalizer request. A new intentional action still starts a new generation.
- Keep writing previews, thumbnail generation, Character Sheet, Image Pool and Scene Review uploads scoped to their original episode. Direct old scene-prompt links to Scene Plan.
- Prevent overlapping preset and visual-style saves from losing edits, and keep Remote Control data attached to the selected project.
- Keep Contextual Cues and Sound Design edits attached to their original project and episode during navigation and saving. Show Music Library loading failures with a retry action.

## v1.4.141

- Retry failed Jobs through the queue using their saved settings and generation intent. Keep the original history when retry is refused; metadata and thumbnail retries no longer depend on incomplete generator forms.
- Order overlapping queue Pause and Resume actions, and keep a paused job out of execution if saving its Resume fails.
- Keep Jobs updates attached to the current subscription when switching projects or reconnecting. Show a refresh notice when repeated requests fail, and preserve other jobs’ completion notifications.
- Match All Jobs counts to the selected project, count paused work in type tabs, expose missing job types, and keep history on a valid page after clearing rows.

## v1.4.140

- Keep subtitle transcription attached to the audio files selected by Audio Assembly, including alternate versions and multipart chapters. Honor replacement audio selections during assembly; repair old mixed base-and-part mappings when saved generation fingerprints prove the replacement.
- Resume a fresh transcription attempt without accepting older subtitle files as its result. Keep its original request identity, report unresolved chapters accurately, and advance recovery after the replacement artifacts are verified.
- Label the audio selection action Generate, Regenerate, or Generate / regenerate according to the selected chapters’ existing audio. Mixed selections keep the full bulk action.

## v1.4.139

- Recover an episode’s saved audio and images directly from Jobs, with exact episode scope and progress on its job card. Recovery stays separate from paid Retry and never opens Production Board.
- Keep Recover all, Repair all, Retry all, queue controls, Clear finished and Clear failed in a permanent Jobs toolbar. Ineligible actions remain visible and disabled; bulk scope follows the selected project.
- Separate finished and recovered history from failed history while preserving files, billing records and unfinished provider-work protections. Keep bulk retries moving when one episode cannot continue.

## v1.4.138

- Keep Jobs cards compact when many prompts or images need attention. Show the verified count and a concise cause; expand affected items or the full error only when needed.
- Explain uncertain Scene Plan requests accurately instead of claiming automatic repair was exhausted. Preserve completed prompts and the exact request and scene scope for recovery before replacement work.

## v1.4.137

- Resume all paused work consistently with individual Resume, including jobs paused during an app restart. Cancellation and duplicate-click protections remain in place.
- Reconcile completed subtitle requests without retaining duplicate pending receipts, so recovered history can be cleared once GenStudio confirms the work has finished.
- Run eligible Pipeline episodes even when other selected episodes lack prerequisites. Keep blocked episodes selected with their reasons and a link to the queued work.
- Choose 10, 25, 50 or 100 episodes per Pipeline page. The default remains 10, and selection is preserved across pages.

## v1.4.136

- Disable Introduction generation until the selected episode has a usable script, with a clear explanation and a link to Script Generator. Readiness updates when chapters finish, and remains disabled while checking or when the check fails.
- Check the same chapter prerequisite before queuing a new Introduction, so missing scripts do not create predictably failed jobs. Existing accepted requests retain their replay behavior.

## v1.4.135

- Keep Jobs recovery summaries compact. Per-chapter subtitle recovery messages now appear inside Technical details instead of filling completed and active job cards. Readiness and recovery actions remain visible.

## v1.4.134

- Resume chapter expansion requests confirmed as never created when you choose Retry, using the verified original request identity instead of repeatedly looking for a missing result.
- Preserve completed chapters and continue remaining chapter batches after recovery. Accepted or uncertain requests retain their existing recovery protections.

## v1.4.133

- Finish missing images directly from Jobs. The same failed or cancelled run returns to the queue, keeps completed images and its provider/credit history, and shows its updated status immediately.
- Include missing Scene Review images in Retry all, with duplicate-click and same-episode protections. Scene Review remains available for inspection without being a required detour.
- Resume image requests that were prepared locally but never accepted by GenStudio using their original verified request key. Accepted or uncertain work remains recoverable, while deliberate fresh regeneration keeps its separate identity.

## v1.4.132

- Replenish scene-image admission requests independently of occupied standard execution lanes, with account pacing, bounded queues and cancellation preserved.
- Show GenStudio’s published provider queue position and estimated wait in Jobs, and clear them as work advances.
- Choose language products for each Pipeline run without changing presets. Use one product, distribute episodes across selected products, or set an ordered primary and backups for the seven writing stages.
- Save the chosen backup and request identity for each logical writing request. Retry reconnects to accepted work; another product is used only after a proven safe refusal or fully released failure.
- Check the selected product’s published workflow capabilities before submission and keep model controls usable on narrow screens.

## v1.4.131

- Restore Upload Center’s Upload plans editor: create, edit and activate channel-specific weekly or monthly schedules, with timezone and date bounds.
- Link Settings and upload review directly to the plan editor. Saving a plan stays separate from assigning episode dates and scheduling on YouTube.
- Validate plan inputs before saving and preserve existing plan defaults and channel identity.
- Keep a manual provider-status recheck effective when a startup check is still finishing.

## v1.4.130 — 2026-09-08

- **Recovered subtitles stop looking unfinished.** Jobs distinguishes the original failed attempt from verified later recovery, keeps its credit history, and removes obsolete missing-section retry prompts.
- **Subtitle history checks the accepted request.** Read-only reconciliation uses the transcription confirmation key and rechecks old absence records affected by the earlier key mismatch. It does not submit another paid request.

- **Review several uploads together.** Ready-to-upload now requires a connected channel. Select eligible episodes, review their files, thumbnails and publication times, then queue the reviewed uploads with separate results for each episode.
- **The reviewed video is the one uploaded.** Upload confirmation and recovery compare the file’s actual bytes. A changed render asks for another review instead of silently uploading it.
- **Cleanup verifies before deleting.** Clearing local finals requires a matching file receipt and a fresh YouTube check confirming processing completed on the current channel. Unverified and older receipts keep their local files.
- **Re-upload after a deliberate YouTube deletion.** Explicitly remove the old upload association after deleting the video on YouTube. Story preserves its history and lets you review a new upload; it never deletes the remote video itself.
- **Uploads use the date you review.** Upload Center defaults to an episode’s future planned date, offers a custom date or private upload, and carries that exact choice into the queued request.
- **Schedule private videos without uploading them again.** Choose a future publication time inside Upload Center. Story Studio checks the current channel and YouTube visibility before applying it.
- **Give unscheduled videos a local plan.** Preview available dates from the channel’s upload plan and save missing assignments without changing existing dates or publishing videos.
- **Upload progress stays visible.** Follow transferred bytes, percentage, speed and estimated time remaining beside each active upload, with a direct link to Jobs. The page also shows its assigned YouTube channel and fixes scrolling into empty space below the list.

## v1.4.129 — 2026-09-08

- **Large requests to non-Store features are no longer refused with a Content Store error.** The Content Store's 16 KiB request limit was applied to every feature registered after it — B-roll and Image Pool, research, scene plan, scene review, continuity, music pool, library and changelog — so a legitimate large request could fail with a message about a limit that did not apply to it. The limit now applies to Content Store requests only.

## v1.4.128 — 2026-09-08

- **Motion duration follows the selected model.** Choose resolution separately and adjust duration with a snapping slider or number field using the model’s published image-to-video options.
- **Follow narration is an explicit choice.** Each missing scene rounds up to a supported clip duration. Review the requested duration, listed cost and any trim or final-frame hold before generating. Saved manual settings and accepted requests keep their behavior.
- **Generated clips are checked before completion.** Story Studio validates playable video and the requested duration, preserving invalid output for review without silently buying another generation. New Follow narration clips hold their last frame when shorter than the narration; existing clips keep their previous playback behavior.

## v1.4.127 — 2026-09-08

- **Choose the upload thumbnail inside the review dialog.** Preview the available episode thumbnails, see the selected filename, and choose another image without leaving Upload Center. Missing or unreadable thumbnails are shown explicitly.
- **The upload carries your thumbnail choice.** Manual upload passes the selected episode thumbnail through to the queued job instead of silently falling back to automatic selection.

## v1.4.126 — 2026-09-08

- **Upload Center now separates local video, upload progress, and YouTube publication.** Find episodes by status, search titles or codes, and sort by episode, status, or schedule. Locally planned dates are distinguished from confirmed YouTube schedules, with timezones shown.
- **Preview actions open where you can see them.** Play the local video in a player, or review the exact upload details in a focused dialog. Missing videos link directly to the episode in Video Assembly.
- **Local inventory remains useful when YouTube records cannot be read.** Unknown status is shown explicitly, while upload safeguards remain in place. Refresh the local list without querying YouTube, and keep responses and confirmations scoped to the selected project.

## v1.4.125 — 2026-09-08

- **Narration quality checks are now an explicit project choice.** Keep them Off, flag current evidence for review, or opt into Check and repair. Uncertain, legacy, stale, or script-changed evidence stays reviewable; it never starts a replacement or blocks ordinary chapter generation.
- **A confirmed repair keeps the current narration safe while it verifies a candidate.** Story Studio retains the original audio, uses the selected candidate only after raw alternate-ASR verification, and refreshes Audio Assembly and subtitles through the existing workflow. Candidate bytes, source map, script, quote ceiling, and action identity remain fenced across restart; a later ordinary Regenerate intentionally takes back its selected chapter.
- **You can independently double-check active narration with an alternate ASR model.** The action quotes the exact staged active audio, preserves its quote and credit ceiling through replay or restart, and leaves active audio and subtitles unchanged whether it finds no issue, needs review, is cancelled, or needs a higher approval ceiling.
- **Settings can display the last verified GenStudio catalogue during a short outage.** The cached display is account- and base-URL-scoped, marked stale with Retry, and is never used to authorize a paid request.

## v1.4.124 — 2026-09-07

- **Explicit Regenerate actions now create fresh work once and recover reliably.** A deliberate click carries one durable action identity through a lost response, Jobs Retry, and restart; a later click receives a new identity. Normal Generate and missing-output recovery keep their existing behavior.
- **Regeneration keeps its exact scope.** Audio, subtitles, scripts, openings, prompts, research, images, music, and Pipeline force runs preserve the selected model and item scope; a replay with changed details is refused instead of silently changing the active request.
- **Pipeline Force reaches each selected stage.** Forced batch work no longer drops its regenerate intent between chained stages, while Repair Missing remains its separate bounded recovery action.

## v1.4.123

- Audio Generator now uses direct chapter actions and a persistent selection bar: generate missing audio, regenerate selected chapters, or create a separate version without conflicting mode switches.
- Model, voice, chapter scope and quotes stay visible; detailed delivery controls are expandable. Episode changes discard outdated selections and quotes.
- Regenerated chapter audio now marks its older subtitles as needing an update. New transcripts record source audio fingerprints, and downstream timing checks reject known stale captions.
- Alternate audio versions stay separate from the active chapter during transcription and Audio Assembly.

## v1.4.122 — 2026-09-07

- **Pipeline Repair can restore selected subtitle gaps without redoing completed chapters.** The optional action keeps good outputs, reconnects to saved transcription tasks first, and allows one scoped fresh request per affected chapter at the live price when a recovered source remains unusable or known terminal/expired evidence cannot recover. Its action identity remains stable across restart; active or unconfirmed ownership stays protected from replacement.
- **Internal subtitle gaps now target their affected chapters and rebuild the stitched timeline.** Repair checks actual chapter sources, maps internal gaps to their affected chapters, and verifies the refreshed timeline before selected downstream work continues.
- **The same repair action can finish missing Scene Review images without replacing valid or imported images.** It recovers saved work first, keeps review approval explicit, and permits at most one fresh image request per missing item and action.

## v1.4.121 — 2026-09-07

- **With automatic image replacement enabled, a fully released image can recover after GenStudio exhausts its site failover.** Story Studio verifies the authoritative failed task and zero settlement, then makes one bounded fresh attempt in the same run for Continuity, Image Pool, or thumbnails. Active, uncertain, cancelled, incomplete, and charged outcomes remain protected from automatic resubmission.

## v1.4.120 — 2026-09-07

- **Image permit requests refill in parallel as GenStudio capacity becomes available.** A request waiting to retry no longer holds up other eligible requests; cancellation and existing billing checks stay intact.
- **Settings, account recovery, and the Content Store now make the next action clear.** Searchable, scoped settings keep unrelated changes separate; recovery and setup routes return you to the account, store, or configuration that needs attention. Project utilities and empty workspaces are also easier to find from the dashboard.
- **Workflow navigation keeps the episode you selected.** Previous and Next preserve the selected episode, including completed imported work; changing or clearing the picker updates the route without carrying an episode into another project. A saved handwritten Introduction remains visible and editable even when this channel is set not to generate new openings.

## v1.4.119 — 2026-09-07

- **Formula and Topic Pack choices now open in one searchable library.** Channel Identity and Ideas keep the current selection compact, then let you review and explicitly apply exact Formula and Topic Pack IDs in the shared picker.
- **Same-name built-in and installed choices now explain their source.** The library labels entries as Installed, Included, Built in, or Custom and shows the listed Library version for signed packs; an existing legacy choice remains visible until you choose and apply a different one.

## v1.4.118 — 2026-09-06

- **Formula-only Idea Campaigns now choose fresh subjects instead of cycling through the Formula's examples.** When no Topic Pack is active or explicitly selected, campaigns use the existing freeform Ideas generator with Formula guidance and saved Formula-wide history; Topic Pack campaigns retain their structured assignment flow.
- **Campaign retries keep the same freshness checks and requested output.** Resume fills only the remaining count, and when duplicate checks are enabled it carries the newest saved ideas into the bounded prompt and checks every saved Formula idea locally for repetition; it also preserves the selected model, emoji option, and durable campaign identity.
- **Finished image jobs no longer return to “Checking provider status” because of a duplicate pre-submit receipt.** Story Studio removes that receipt only when the current recovery checkpoint proves its exact image task and idempotency key; unmatched or contradictory provider evidence remains protected.
- **Missing-image status now explains both the failed item and its queued owner.** Jobs shows failed items separately from the number left in the current run, while Scene Review identifies the exact scenes queued for repair, distinguishes other blocked scenes, and links back to Jobs without starting another request.

## v1.4.117 — 2026-09-06

- **A Scene image batch no longer stays Paused after every image is verified.** A late automatic stall hold yields to the completed output audit, while manual and queue pauses still remain paused.
- **Existing affected rows repair themselves without generating again.** On project load, Story Studio finalizes a stall-paused batch only when its saved task ownership, current Scene Plan, and exact image files all pass a fresh audit.

## v1.4.116 — 2026-09-06

- **Character Sheet now offers four slower scene rhythms through 45–60 seconds.** Each choice applies to the selected episode through the existing pacing control, while new episodes keep the 1–3 second default.
- **Subtitle coverage stays strict when visuals move slowly.** Scene Plan, episode readiness, and Video preflight use the same fixed 30-second cue-gap guard, so a long missing stretch of narration cannot be hidden by a longer image hold.
- **Image Pool is reachable from every project sidebar.** The new link opens the existing Image Pool workflow beside Assets Library.

## v1.4.115 — 2026-09-06

- **Scene Review can now finish only the images still missing.** One explicit action checks saved GenStudio results first, preserves every complete image, and uses the current validated model settings for genuinely fresh work when no result exists or the earlier job is known to have failed.
- **Uncertain earlier requests stay fail-closed.** Story Studio identifies accepted work that is still generating and makes no duplicate request; when the outcome cannot be confirmed, a separate **Replace anyway** confirmation explains that another image and charge are possible, retains the old request evidence, and prevents a late old result from replacing the chosen output.
- **Failed Scene image batches return to the same safe workflow.** Jobs links the episode back to Scene Review instead of retrying with a historical selector, and repeated Finish or Replace requests reuse their durable action identity.

## v1.4.114 — 2026-09-06

- **Generated introductions now begin with the words the narrator should speak.** Story Studio asks the model for narration without a heading, preface, or divider and removes a recognized introduction preface only when it is immediately followed by the model's divider; similar spoken prose without that divider stays unchanged.
- **The Introduction preview can now be edited in place.** Edit, Save, and Cancel preserve the episode's chapters, keep manual narration exactly as written, retain unsaved text after a failed save, and block saving while Introduction generation is already active.

## v1.4.113 — 2026-09-06

- **Image Pool generation now keeps the selected output resolution.** The published resolution chosen beside the aspect ratio reaches the queued generation job, while omitted or non-string resolution values remain absent.

## v1.4.112 — 2026-09-06

- **Interrupted Video Assembly jobs now resume from validated scene clips.** Story Studio reuses only clips owned by the same durable job whose complete render inputs still match, rebuilds missing or damaged clips and every later composition stage, and never promotes an interrupted partial final.
- **Restart cleanup now preserves only trustworthy active assembly work.** Exact project, episode, job, status, and canonical temporary-folder ownership must validate before a checkpoint can rejoin its original job or protect files from expiry; pause and cancellation intent still take precedence.

## v1.4.111 — 2026-09-06

- **Subtitle readiness now distinguishes complete chapter files from a usable planning timeline.** Subtitles and Scene Plan identify pacing-blocking cue gaps with their exact chapter and times, keep the chapter count as a separate fact, and explain that re-stitching alone cannot create missing cues.
- **Jobs now names the exact missing or invalid scene images and prompts.** Each issue links back to its owning Scene Review or Scene Plan workspace, while a blocked automatic image replacement states why no replacement was submitted without exposing provider details.
- **Recovery links now reopen the exact work that needs attention.** Subtitle links focus the affected chapter, Scene Review links focus the stable scene row, and a selected deep-linked episode remains available while the picker shows Pending only.

## v1.4.110 — 2026-09-06

- **The YouTube Upload Center now opens for projects created before newer media folders were added.** Existing folder names remain unchanged, missing optional folder names use their established defaults, and unknown or unsafe folder paths remain blocked.

## v1.4.109 — 2026-09-06

- **The YouTube Upload Center now loads after YouTube setup.** Overview, Publish, Library, Reconcile, Comments, and Analytics open for the channel assigned to the project.
- **Project navigation remains visible throughout the Upload Center.** You can move between publishing and the rest of the channel workspace without leaving the project view.

## v1.4.108 — 2026-09-06

- **Failed visual Scene Plan jobs can now repair only their missing or duplicated prompts from Jobs.** The explicit **Auto repair prompts · credits** action preserves every verified prompt and timeline boundary, derives the exact episode and model from the saved job, and sends each remaining scene as its own GenStudio request.
- **Paid prompt repair keeps going while the saved plan improves and stops at safe boundaries.** It can continue beyond two repair passes, but stops before another request when a provider submission is unresolved, authorization or local saving fails, or a full pass adds no verified prompt. **Pause** lets the accepted request settle and then starts no new one; ordinary **Retry** remains available for timeline, setup, and other failures.

## v1.4.107 — 2026-09-05

- **YouTube publishing now has one Upload Center with separate Overview, Publish, Library, Reconcile, Comments, and Analytics pages.** Preview names the exact assigned channel and payload before confirmation. Settings manages YouTube application credentials, channel connections, reconnects, and project assignment in one place, with secrets kept in encrypted storage.
- **Interrupted uploads now resume without creating a duplicate video.** Story Studio ties the accepted channel, metadata, upload mode, source identity, resumable session, and provider result to one durable operation; a later project edit cannot change or relabel work that was already approved.
- **Library actions preserve live YouTube fields and concurrent edits.** Metadata corrections fresh-read the exact video and use its ETag, while operation-bound thumbnail and playlist actions keep uncertain provider success visible instead of retrying blindly. Reconcile, processing status, comments, and analytics stay scoped to the assigned channel.
- **Upload cleanup and quota reporting now follow the evidence they actually have.** Ordinary archive or storage cleanup requires a usable remote copy of the exact local render, and every YouTube Data API page or retry is counted against the application and channel credential that made it.

## v1.4.106 — 2026-09-05

- **You can now generate or regenerate exactly one chapter's subtitles from the Subtitles page.** Every chapter has its own action, missing chapters stand out, and the page says that the selected chapter starts a new GenStudio request under the current quote. The other chapter files stay untouched.
- **An expired transcription quote can recover without turning into a generic interruption.** Story Studio recognises GenStudio's exact expiry reply at confirmation, checks the saved request before renewing it, and keeps every other 422 reply fail-closed. When a saved task cannot be found with the current connection or account, its evidence is retained and the app offers a clearly separate fresh chapter request instead of silently resubmitting it.

## v1.4.105 — 2026-09-05

- **Once verified, Content Store trust now survives ordinary API-key changes in its own OS-protected file.** Provider saves refuse malformed or unreadable secret state, preserve an undecryptable file before a deliberate replacement, and serialize updates across processes. A missing trust anchor performs one authenticated Restore-purchases verification before any generation job exists; signature, account, origin, key-history, and tamper failures remain blocked without generating or spending credits.
- **A GenStudio operator pause now stops Story submissions using the stable `GENERATION_PAUSED` response code.** Story Studio preserves accepted jobs and completed checkpoints, directs the operator to enable generation in GenStudio Admin, and no longer depends on obsolete exact-release charging text.

## v1.4.104 — 2026-09-05

- **Backend tests now refuse to write API keys or Content Store signing-key anchors outside their claimed temporary data directory.** Both secret-store mutation paths use Story Studio's shared test isolation guard, preventing an incorrectly invoked test from changing this Mac's saved credentials or trust anchors.

## v1.4.103 — 2026-09-05

- **Targeted Scene Plan and Scene Review runs now stop before creating a job when their saved prerequisites are incomplete.** Pipeline names the missing Subtitles or Scene Plan artifact immediately, while valid targeted regeneration and every other single-step workflow keep their existing behavior.

## v1.4.102 — 2026-09-05

- **Retry All now recovers each episode in prerequisite order.** Audio Assembly, exact missing subtitle sections, a verified fresh stitch, Scene Plan, required Contextual Cues, and Scene Review share one saved recovery plan. Failed downstream rows wait their turn; restart and repeated clicks retain each queued job's identity. Jobs shows free recovery/settlement progress and a bounded **Buy missing subtitles now** action when eligible.
- **Subtitle recovery now fails honestly when stitching cannot complete.** Complete chapter files alone no longer let a subtitle job report success: Story Studio requires a fresh, verified stitched timeline before Scene Plan or Scene Review can proceed, while keeping successful section files for a targeted retry.
- **Optional paid subtitle replacement has its own separate machine setting.** It starts Off and needs its own per-Story-job credit ceiling; enabling image replacement never authorizes subtitle spending. Jobs retry now keeps a subtitle job's exact missing-section allow-list.
- **Subtitle recovery reconnects before it buys.** Both whole-track and chapter transcription recover accepted tasks for free, distinguish fully refunded retries from paid replacements, and checkpoint one replacement per eligible missing section against a shared subtitle ceiling before confirmation. Restart and repeated requests reuse the saved provider identity; a dedicated manual purchase action accepts only the failed job's exact missing sections.

## v1.4.101 — 2026-09-05

- **Generation fan-out now follows each GenStudio API key's live capacity publication.** Image, Scene Review, and thumbnail Auto staging use the keyed burst advisory while exact image permits remain mandatory. TTS combines its model's provider hint with the keyed account burst, and subtitle/video staging uses their own keyed capacity instead of inheriting the image dial. Unknown capacity stays conservative and explicit, with the local CPU/IO and LLM lane limits unchanged.

## v1.4.100 — 2026-09-04

- **Unavailable LLM models now explain why they are paused.** Story Studio carries GenStudio's allowlisted daily-capacity or temporary-backpressure reason and published return time into the disabled picker row, formatted in the device's local date and time. Older catalogues keep the existing generic wording, and unavailable rows remain grey and unselectable.
- **Long narrative batches now recover cleanly from output truncation.** When GenStudio reports `finish_reason: length` or its durable `LANGUAGE_PROVIDER_INCOMPLETE` code, complete chapters remain untouched and only unfinished chapters receive one bounded, single-chapter repair request. The 8,192-token allowance applies to each repair batch, not the whole story; generic provider failures and ambiguous submissions still require explicit Retry. A malformed empty response remains a visible manual-retry outcome because its settlement is not safe to infer.

## v1.4.99 — 2026-09-03

- **Image work now enters GenStudio through its live admission permits.** Story Studio keeps the chosen episode-lane setting as local staging, waits locally when GenStudio has no confirmed capacity, and submits work only after GenStudio authorizes the exact account, model, and image operation.
- **A delayed image request stays safely recoverable.** Waiting, paused, and resumed work reuses the same request identity and permit evidence instead of treating elapsed time as permission to buy a second request. Capacity waits and tail overlap remain in local staging; every paid image still requires its exact GenStudio admission permit before submission.

---

## v1.4.98 — 2026-09-03

- **YouTube uploads no longer fail because Story Studio's private chapter and source markers leaked into the description.** The readable chapters, timestamps, citations, and links remain exactly where expected, while the internal boundary lines are removed at the final upload gate. Any other angle bracket that YouTube forbids is also removed before submission, so the API can no longer reject an otherwise valid description with `invalidDescription` for this reason.

## v1.4.97 — 2026-09-02

- **Durable queue evidence now coalesces safely during concurrent job updates.** A burst of pause, resume, cancellation, and recovery mutations is captured in the correct project snapshot instead of serialising into redundant writes or losing later intent after a failed write. Authoritative paid-work inspection now reads the persisted job record under the checkpoint lock, so a stale in-memory copy cannot authorize a replacement.

## v1.4.96 — 2026-09-02

- **Relaxed-queue voice models now appear on their own clearly labelled shelf.** Story Studio preserves GenStudio's queue classification and availability notice, keeps direct and relaxed Fish Audio products separately selectable, and shows the relaxed shelf after the direct catalogue with GenStudio's disclaimer once for the group.
- **Published TTS sale pricing is visible without changing how narration is charged.** The picker shows the current per-1,000-character rate beside GenStudio's undiscounted rate and carries GenStudio's sale details through unchanged; quotes and finished-job settlement remain authoritative.

## v1.4.95 — 2026-09-02

- **Chinese Ink-Wash Storytelling is now a standalone visual style.** Its original full-frame preview, calligraphic wet-and-dry brush language, rice-paper negative space, mist-built depth, searchable metadata, and text/seal/UI exclusions ship together as one independently purchasable Content Pack.
- **Distinct visual variants are welcome when their rendering contracts are genuinely different.** Similarity alone no longer redirects an author to an existing style; only indistinguishable duplicates and simple renames are rejected, while originality, composition-copy, identity, safety, and commercial checks remain unchanged.

## v1.4.94 — 2026-09-02

- **The Style Library now shows Content Packs only.** The 17 retired built-in cards and their duplicate frontend preview files are gone, so each installed signed style appears once and a new customer sees only styles they actually own or receive.
- **Existing projects keep their chosen legacy look.** Project-local `builtin-*` style copies remain renderable for compatibility, but they are no longer republished into the library. New style authoring is now locked to standalone, independently purchasable Content Packs.

## v1.4.93 — 2026-09-01

- **The legacy Content Pack migration is complete as standalone choices.** Seventeen remaining Formula and Topic products and four prepared Style and Thumbnail products now have finished independent sources, while the free History, Explained 1.0.2 compatibility successor stays a free built-in and is not counted as a paid product.
- **Old projects keep working without reviving Channel Kits.** Runtime compatibility IDs remain readable, Dark Psychology resolves through Human Behavior, Music Mix stays available only to existing projects through its dedicated music workflow, and historical Kits remain read-only. Five unused pre-sale reservations were safely withdrawn with their identities permanently retained, so they cannot be recycled or quietly return as products.

## v1.4.92 — 2026-09-01

- **Confirmed failed images can optionally be replaced, with a firm spending boundary.** This image-only setting is Off by default. When enabled, Story Studio waits a fixed 30 minutes and requires authoritative failed-task evidence before considering a replacement. It then refreshes the exact current published price for the same image request and allows at most one replacement per image, only within the additional-credit ceiling you must set for each Story job. Audio and video are unchanged.
- **Thumbnail status now reports what is actually on disk.** Episode list and status responses include the expected thumbnail count, the number still present, and whether the set is complete. If a thumbnail file is removed after generation, connected tools can see the missing asset instead of relying on the historical completion flag.

## v1.4.91 — 2026-08-31

- **Scene-image jobs now share their places fairly.** Continuity Render and Image Pool take turns when both are waiting, while work that is already recovering keeps its place ahead of new work of the same kind. The image-pool generator itself remains serial.
- **One verified Continuity final wave can overlap by one job when GenStudio has just confirmed headroom.** Your chosen scene-image concurrency remains the normal limit. Story Studio may start one next fairly selected image job only after it proves a running Continuity Render is in its under-filled final provider wave and rechecks fresh account capacity. This does not buy or replace work, and it does not promise a speed increase.

## v1.4.90 — 2026-08-31

- **Work held by a temporary connection or capacity problem can safely pick up again.** Story Studio now checks what has already finished before continuing, keeps completed output, and retries only genuinely missing work through its normal safeguards. A pause you made yourself remains paused until you choose to resume it; a temporary failure can still require another attempt if the service cannot complete it.
- **Paused work is easier to find and rejoin.** Filter the Jobs page to Paused and rejoin the visible scope in one action. The page gives immediate “Rejoining…” feedback, and the controls remain usable on compact screens.

## v1.4.89 — 2026-08-31

- **Job timing stays in one dependable place while work is running.** The last-progress reading now remains pinned to the card’s right edge whether Story Studio can estimate time remaining or is still gathering enough evidence to do so. Its quiet state is easier to scan with a subtle information treatment, and a stale reading now carries the same treatment with a clearer warning signal. The timing group also moves cleanly to its own right-aligned row on compact screens.

## v1.4.88 — 2026-08-31

- **Jobs now say what needs attention instead of exposing internal Error and Failed state names.** Cards, filters, batch summaries, action help, and completion notices use the next useful customer action. The underlying queue states, retry and repair safety, settlement evidence, and full diagnostics under Technical details are unchanged.

## v1.4.87 — 2026-08-31

- **Job cards now describe the work you asked for, not the provider attempts behind it.** A completed image is counted from the saved-output audit, so a route that had to be tried several times can no longer make the card claim that several images are missing. If output really is missing, the card says how many images are ready and how many need another try. Attempt IDs, codes, retry chains, and per-attempt records remain available under Technical details when they are useful for support.
- **Credit figures now distinguish a confirmed outcome from an outcome still being checked.** Story Studio only says “No credits charged” after GenStudio has published a complete, balanced settlement. Partial or missing information stays plainly pending, with any returned amount marked “so far”.
- **Automatic image retries are now fail-closed.** A child image request is retried automatically only after GenStudio proves it charged zero credits and released the entire reservation. Content refusals ask you to review the prompt instead of submitting the same prompt again.
- **Architecture documentation now reflects the live GenStudio boundary.** It no longer describes retired direct image and narration providers as active.

## v1.4.86 — 2026-08-30

- **The Story workflow now puts Script Generator immediately before the optional Introduction everywhere it is shown.** The shared order propagates through the sidebar, workflow ribbon, dashboard, Production Board, and episode status strip. Every flow keeps the same stages, routes, completion rules, presets, and pipeline execution; only the user-facing order changes so the episode is written before its optional opening is configured.

## v1.4.85 — 2026-08-30

- **Scene-image throughput now starts at the safer two-episode recommendation, and Custom works when you need something else.** A new install — or one with no saved value — now runs scene images for two episodes at once instead of three. A value you already chose is left alone. Choosing Custom always opens a numeric box, even when the current number is also one of the named choices; it accepts the established one-to-fifty range, and the save message reports the value Story Studio actually applied.
- **The Jobs page now puts the useful action and explanation first, without exposing internal job and request codes.** Each active card leads with its safest normal action and keeps cancellation or abandonment alternatives under More actions. Repeated capacity notices collapse into one count, Review failures takes you straight to the failed rows from the latest pipeline run, and full errors plus provider item state remain available in clear disclosures. Internal identifiers are still retained for reconciliation, settlement, recovery, and support evidence, but are no longer printed in cards, messages, notifications, previews, or related generation confirmations.
- **Account-capacity numbers are shown only when GenStudio has just confirmed them.** A fresh, well-formed account overview shows the live standard lanes, provider queue, and submission rate. Missing, stale, or malformed data instead says that capacity is unverified and schedules conservatively, so fallback numbers can no longer look like live account facts.

---

## v1.4.84 — 2026-08-30

- **Three scheduled videos went up titled "# SEO-Optimized Video Titles". That cannot happen again.** When Story Studio asks for five title ideas it asks for them one per line, with no commentary. Almost always that is what comes back. Occasionally the model writes its own heading above the list first — *"# 5 SEO-Optimized Video Titles — EP0061"* — and the step that tidied each line knew how to remove a dash, a number, a full stop and a pair of quotes, but had never been told anything about a `#`. So the heading survived as the first line, was picked as the episode's title, and went to YouTube as the name of the video. It also pushed the fifth genuine title off the end of the list to make room for itself. Story Studio now recognises a heading, a numbered preamble and the wording of its own instruction for what they are, and throws them away *before* it chooses — so the heading never becomes a title, and no real title is lost to it.
- **Episodes already sitting on YouTube with the wrong title can be repaired with one click.** The five titles the model actually wrote are saved beside every episode, and the broken ones were only ever the heading that got in front of them. Story Studio now notices when the saved title is a heading rather than a title and uses the first real one instead. Press "↻ Update metadata" on the affected row and the correct title replaces the heading on YouTube. Your privacy setting and your scheduled publish date are not touched.
- **Descriptions no longer show you the asterisks and hashes.** YouTube has no bold and no headings — it prints `**AI DISCLOSURE:**` to your viewers with the asterisks still in it, and `# The Harbour That Waited` with the hash still on the front. Story Studio now removes the marks and keeps the words on the way out, so the heading reads as a heading and the sentence reads as a sentence. It also drops the `EPISODE EP0057 —` label the document uses to name itself, which is scaffolding for you and noise for a viewer. Nothing is deleted: across every episode package on this machine, not one word of actual writing was removed — only the marks around it. The chapter list and the sources list the app builds itself are left exactly as it built them.
- **And a refusal, so this is caught rather than discovered.** Every upload and every metadata update now passes one last check immediately before it reaches YouTube. If the title is empty, is a heading, repeats the instruction we gave the model, or carries formatting marks — or if the description still has any of that in it — the upload stops and says so in plain words, quoting the exact text it is objecting to and pointing at the Metadata page. The check sits at the only two places anything in the app can reach YouTube at all, so no part of it can go around them. It was calibrated against every episode package on this machine before being switched on: it flags the three that were genuinely wrong and stays silent on the other eight hundred and fifty-four, including the ones whose titles legitimately end with an episode number.

---

## v1.4.83 — 2026-08-29

- **The app stays responsive while it is rendering video.** Opening Story Studio during a render used to show "Loading channels…" and sit there, sometimes for a very long time, looking like it had died. It had not — but four separate things it does on the way to answering *any* request were asking the disk a question and then refusing to do anything else at all until the disk answered, and a disk busy writing video does not answer quickly. Writing the request log did it, on every single request. Sweeping away old log files did it, on whichever unlucky request happened to land on the hour. Reading your channel list did it three times per channel, two of them outside the safety net written to catch exactly this. And working out where your Library is did it once more per channel on top. None of them wait like that any more, and the safety net now covers every part of reading a channel — so one folder on an unresponsive drive costs you one slow row instead of the whole app.
- **Your channel list appears immediately, and refreshes behind itself.** The home page no longer starts blank. It shows the channels from your last visit the moment it opens, quietly says "Refreshing…" while it checks, and reconciles when the answer arrives — whatever the app returns replaces what you were shown, so a channel deleted elsewhere still disappears. If the check fails, the list stays on screen and says plainly that it could not be confirmed, with the buttons to try again or to point Story Studio at a different Library folder. The very first run on a new machine still shows the spinner, because there is genuinely nothing to show yet.
- **A request that never comes back now says so instead of spinning forever.** The app had no time limit of any kind on its own internal requests, so anything that got stuck stayed stuck silently. There is a limit now — generous enough that nothing you legitimately wait for, such as a picture being generated, a pack being installed or a preview being rendered, comes anywhere near it — and all three limits are settings you can change.
- **Pickers no longer show you internal codes instead of names.** When the model or voice list could not be loaded, the model picker and the voice picker both fell back to displaying the raw internal identifier of whatever you had chosen — strings like `gemini-3.1-flash-lite-discount` — in the box, and again when you hovered over it. Story Studio now remembers the names of the models and voices you have used, so it shows the name and adds "(unverified — catalog unavailable)" so you know it could not check. Where it has never seen the name it says "Saved model" or "Saved voice" rather than showing you a code. What may actually be *run* is unchanged: an unconfirmed choice is still checked before anything is generated or charged.
- **Research documents name the model, not its internal code.** Every `research.md` carried the raw product identifier in its header line. It now carries the model's published name — and where that cannot be looked up it simply leaves the model out, rather than printing a code at you. The identifier is still kept in the machine-readable file beside it, where it belongs.
- **A hundred identical failure lines are now one line with a number on it.** When a busy period caused a batch of images to be declined all at once, the job card wrote out the same sentence — "an image didn't finish, the provider declined it, 9 credits were returned" — once for every single image. Over a hundred times, identically. It told you nothing the first line hadn't, buried everything else on the card underneath it, and left you counting rows to find out how many there were and how much came back. Repeats now collapse into one line that says how many and adds up the credits: "37 images didn't finish… 333 credits were returned in total." Genuinely different problems still get their own line each, because a different cause is something you need to read. Nothing is hidden — every individual item is still listed, one by one, under Technical details.
- **Two different times for the same deadline, one of them wrong.** A queued card could read "automatic escalation at 00:00" and, in the very next sentence, "GenStudio will step in Today 10:24 PM" — the same deadline, stated twice, hours apart. One of them was being read out of a sentence written by the service by looking for anything that resembled a clock, which sometimes found the wrong number and never adjusted for your time zone. The other was the real timestamp, which was sitting right there all along. The guesswork is gone; the deadline is now said once, from the real value, in your time zone.

---

## v1.4.82 — 2026-08-29

- **Scene lengths now land inside the pacing band you chose, instead of always overshooting it.** When Story Studio divides an episode into scenes it walks the subtitles and closes a scene once it has enough narration. It was adding the next subtitle line and *then* checking the length — so it closed at the end of the line that broke the limit, and every single scene came out at your target plus one whole extra line of speech. On a tight band that pushed scenes past the maximum you set, and the safety check meant to catch exactly that could never fire, because the target was always reached one line earlier. Scenes now close at the last subtitle boundary that actually fits, choosing whichever boundary sits closest to your target. The one case that can still run long is a scene spanning a silent gap between chapters — the silence is not narration, so it is no longer counted against your maximum, and nothing is chopped up to satisfy a limit it was never breaking. The same mistake in the fallback used when scene planning fails has been corrected too.
- **"Repair long scenes" now actually repairs them — and tells the truth when it cannot.** The repair re-divided the plan using the same faulty walk, so it frequently changed nothing and then reported "no scenes exceed the selected cap", sending you off to re-stitch subtitles that were already perfectly correct. With the division fixed the repair now converges. When a scene genuinely cannot be divided — it holds a single unbreakable subtitle line, or spans silence with no narration to cut on — it says so plainly and suggests the two things that would actually help.
- **Scene Review flags over-long scenes against your pacing setting rather than a fixed twenty seconds.** It was accusing scenes your own settings consider perfectly fine, and staying silent about ones they consider too long. It now reads the same number Scene Plan does, and re-reads it when you switch episodes.
- **Job cards are now progress trackers instead of walls of technical detail.** A running batch used to be a list of every scene, one line each, beside a code that means nothing to you and a pile of billing rows — you had to count the lines yourself to work out how much was left. A card now says how many pieces there are, how many are being made right now, how many are done and how many remain, roughly how much longer, and when something last actually happened. Money is three plain figures: charged, on hold, returned. Anything that went wrong gets its own sentence saying what failed, whether you were charged, and what happens next — and the link to inspect problems only appears when there are problems. Every log line, every per-scene state and every identifier is still there, folded into one "Technical details" panel.
- **The time remaining is measured, not guessed.** It comes from how fast this job is actually settling, and it is withheld until enough has finished to mean something. Failing that, it uses how long this kind of job has genuinely taken before. Failing both, it shows nothing rather than inventing a number. The same is true of "last progress: 40 seconds ago" and of deciding when a quiet job has been quiet too long — that is judged against how fast this kind of work normally moves, measured, not against a figure typed into the code.
- **Episode lists now always agree with the episode's own page.** Finishing a step could leave the selector, the pending filter and the Production Board still reporting the state from a minute earlier, while the page in front of you said the work was done — the "Steps 10 of 12" against "100% greenlit" split. Two causes, both closed. Saving a change asked the app to refresh in a way that never actually cleared the stored answer, and four of the scene-image actions never cleared it at all. And three different screens each kept their own private list of which steps count, which had quietly drifted apart — the dashboard's was missing two stages entirely. There is one list now, and one definition of a finished episode, which all three read. Optional steps still never hold an episode back.
- **"Pending only" now says why a finished episode is still on the list.** Keeping the episode you have open is deliberate — a step you just completed should not vanish from under you mid-edit — but the row looked exactly like a genuinely pending one. It now says so.
- **Progress messages no longer describe our machines.** A retry could read "every machine was busy"; a queued job could report which of our sites had not accepted it and when its placement window closed. That is our plumbing, not your business, and it is now written in terms of the thing you actually care about: high demand, waiting for capacity, and when it escalates. What matters is unchanged — whether you were charged, and that it is retrying by itself.

---

## v1.4.81 — 2026-08-29

- **If the app is closed while pictures are being made, it now picks the work back up instead of quietly starting something else.** Quitting mid-batch left those episodes in a strange half-state: still shown as running, but not actually running, and never marked as failed either. Because they no longer counted as using one of your generation slots, the app saw three free slots and started three *new* episodes — so three jobs became six, all competing, while the interrupted ones sat still. Meanwhile the service kept working on what it had already been given, and finished a few hundred images nobody was collecting. Interrupted picture jobs now restart themselves the moment the app opens. Anything the service already finished is pulled down using the receipt saved next to each picture, at no extra cost, and only genuinely missing pictures are ordered again. Because they rejoin the queue before anything new is admitted, they also get their slots back first — so the interrupted work finishes before fresh work begins, rather than after. This is the same recovery narration has had for months; pictures were simply never added to it. A job with nothing worth collecting is still left alone rather than restarted, so nothing is re-ordered on a hunch.
- **A large batch can now finish checking with the service instead of asking forever.** When the app wants to know how a big job ended, it asks about each picture in turn, with one time limit for the whole round of questions. It also asked again about every picture it had already had a final answer for — on a batch of a hundred and forty, that was ninety-six pointless questions, and the time ran out before it reached the ones that actually mattered. Five seconds later it started over from the beginning and did the same thing again, forever. It now skips anything already settled, so the questions that matter get asked. Answers it already has are still counted, so a failure buried among successes still decides the outcome and cannot be lost.
- **"Clear finished (6)" now clears six.** Six cancelled jobs, a button offering to remove them, and clicking it removing nothing — repeatedly, with no explanation. Nothing was broken on either side; there were simply two different definitions of "this is finished" written in two places, and they disagreed about one word. The button used one and the thing behind the button used the other, so it counted rows it would then refuse. There is one definition now, in one place, which both read. A cancelled job counts as finished and can be removed. Work genuinely still running at the service is still protected from being cleared away — and is no longer counted by the button either, so the number you see is the number that disappears. If a click ever does clear nothing, it now says so and points at the row that explains why, instead of reporting "cleared 0" and leaving you to guess. A narrower version of this was fixed in v1.4.77; the count was corrected then, but the second definition was left in place and brought it back.
- **A job interrupted by a restart no longer says it is dealing with a cancellation you never asked for.** Work picked up after a restart and work that was genuinely cancelled followed the same path, and both reported "reconciling the provider cancellation" — telling you an action had been taken that had not, on work you still wanted. Interrupted jobs now say what is actually happening: the app is checking what the service already finished.

---

## v1.4.80 — 2026-08-29

- **When a writing request fails outright, the app no longer blames the model for something it was never sent.** A batch of scene prompts was refused by GenStudio before a single word came back — the reply had not proved it came from the model you paid for, so it was thrown away rather than handed to you. Story Studio then examined a response that did not exist and wrote, once for every scene in the batch, that the model had left that scene out of its answer. Fifty accusations about fifty seconds of silence. Worse, those invented complaints were passed straight into the automatic second attempt, so every paid retry opened by telling the model it had dropped scenes it had never been shown. A failure that produced no reply now produces no per-scene findings at all. The scenes are still reported as missing, the automatic repair still runs, and the repair now says plainly that the previous attempt returned nothing — which is what actually happened.
- **That refusal now says what it was.** GenStudio checks that a reply really came from the model a product sells, and refuses it when it does not. Story Studio did not recognise that particular refusal, so all you saw was the generic "language generation failed" with a code after it and no cause. It now reads as what it is: the reply did not identify itself as the model you bought, so it was refused rather than passed off as yours. A second, quieter version of the same gap is closed too — one of the reasons the app already knew how to explain could never be recognised when it arrived quoted inside the message rather than published as its own field. Reasons are now read from one list, so a new one is understood everywhere the moment it is added.
- **Abandoning a stuck job no longer tells you nothing was refunded when your credits are already back.** In this same incident, GenStudio had released every credit on its own side forty-three minutes before the job was abandoned — and the job's own log said so, three lines above the message insisting otherwise. Story Studio itself holds no balance and cannot refund anything; that is true and is still said. What it will no longer do is speak for GenStudio. If the job recorded credits coming back, the message now quotes them and adds them up. If it recorded none, it says where the real figure lives — your GenStudio account — instead of announcing a verdict it has no way to know.

---

## v1.4.79 — 2026-08-29

- **The word "Episode" is gone from the other place it was being drawn, too.** The previous release fixed this where thumbnails are made on the Image Prompts page. Generating a whole episode in one go writes its prompts by a separate, older route that never passed through that fix — and worse, it instructed the model outright that every thumbnail "MUST include" a sentence beginning *The episode title "…"*, which the model duly lettered into the picture. That instruction no longer contains the word, and the prompts this route produces are now cleaned before they are written to disk, so a model that says it anyway still cannot paint it. Found by checking whether anything else reached an image model the same way; it did.

---

## v1.4.78 — 2026-08-29

- **Thumbnails no longer have the word "Episode" painted into them.** Titles are drawn into your thumbnails on purpose — that is what the text controls are for — but the instruction sent to the image model called it "the episode title", and a model that draws text draws the label along with the words it labels. So "Episode" kept appearing above the real title, inside the artwork, where the only fix was to generate again. The label is now stripped from every prompt at the last point before it is sent, which is what matters, because the phrasing arrived from three separate places at once: the writing model that composes the prompt, the guidance inside published thumbnail packs whose contents are frozen and cannot be edited, and the built-in channel guidance. Only that final step sees all three. It is removed at the two sources that can be changed as well, so in most cases the phrase is never written in the first place. Your title still goes in exactly as before; only the word "Episode" stops coming with it.
- **A model that vanishes from your account is now visible instead of silent.** When a pinned model disappeared, the app quietly healed the selection and carried on without saying so, leaving you reading a menu that no longer described what would actually run. The substitution is now shown on the three screens that ask for it, and it travels with the result on the prompt-edit screen too, which had no job log to carry it.
- **How long a writing request may run is now yours to set.** It was a fixed number in the code. A long chapter on a slow provider hit that ceiling and failed for no reason you could see or change. It is a setting now.
- **Research can approve claims for you, if you ask it to.** A new "Approve claims automatically" toggle, off by default, so nothing changes unless you turn it on.
- **Saving an edited image prompt no longer depends on when the page was opened.** The save route was being registered while a request was already being handled, rather than once at startup — the kind of ordering that works until it doesn't. It is registered at load now, like every other route.
- **The Deep Time Field Record gains its third volume.** *Human Origins & Ancient Worlds* is written: a hundred named subjects with twenty distinct angles each, every one anchored to a named site and a named stretch of time — two thousand episode ideas, matching the first two packs in the collection exactly. The boundaries against the two already shipped were settled by a check written before the pack was, rather than argued about afterwards.
- **A retired formula is no longer referenced by a pack that ships today.** The Wars & Treaties Topic Pack still pointed at a formula that no longer exists. Its published versions are frozen and cannot be edited, so the correction ships as a new version alongside them, and the originals are left exactly as they were.
- **The built-in copy now says what the published packs say.** Fifteen pieces of wording across seven files had been waiting on a publication that has now happened, because the live copy is pinned field-for-field to published pack contents and those cannot change once sold. Every replacement was derived from the difference between each pack and the one before it rather than retyped, so the two agree exactly.
- **The pack shipper stopped refusing packs it should have accepted.** Its check for third-party trademarks read pack files as raw bytes, so it also inspected internal identifiers — lookup keys the app branches on and nobody ever sees. That refused nine of the thirteen approved packs, each on an identifier the plan had deliberately kept. It now reads those files as documents and checks exactly the text a customer can see, and a file it cannot read still falls back to the strict byte check rather than passing quietly.

---

## v1.4.77 — 2026-08-29

- **Scene Plan now writes as many scenes per request as the chosen model can actually take, instead of stopping at fifty.** The panel said it sized each batch from the selected model's published output limit, and it did — and then threw that number away against a fixed ceiling of fifty that nothing on screen mentioned. Typing 200 into the batch field got you fifty and no message, because a value above the ceiling was rejected and quietly replaced by the default. Measured across eighty-five thousand real scene prompts, one scene costs about 150 tokens typically and 330 at the 99th percentile — so fifty scenes were using three percent of a large model's allowance, and not one request on record had ever hit a provider's output limit. The ceiling was protecting nothing. Batch size now defaults to 250 and has no maximum anywhere in the code, and the two numbers behind it — how many tokens to allow per scene, and how much of the model's allowance to use — are settings you can edit under **Scene Plan → Advanced batch controls**. A value the model genuinely cannot take is now reported to you rather than swapped out behind your back, and a reduction the model forces is stated where you can see it. On a library the size of the one this was measured on, the same work falls from about 1,950 requests to about 590. Every successful request now also records how fast it ran, so the next decision about batch size is a lookup rather than an argument.
- **A job that can never be finished can now be let go.** A batch of narration transcriptions charged for the nine tasks it managed to send and then lost the connection before the other twenty-two were given an id. The job ended in Error, and every way out of it refused at once: retry declined because the provider evidence was unsettled, "Clear finished (1)" counted the row and cleared nothing, removing it from history did nothing, checking with the service again was offered but could never succeed — and the one action built for exactly this, abandoning the job, was not offered at all, because the app measured "you still have a way out" by whether any button was clickable, and the useless one was. Abandoning is now offered whenever there is no working way to clear the row. Two things behind it were wrong as well: the check that matches your job up with the provider's work only ever looked at the eight most recent items, so any batch larger than eight declared itself permanently impossible to reconcile; and a check that landed after you abandoned a job recorded "every task for this job has finished" against the one job we know least about. Abandoning is not evidence, and is no longer minuted as if it were. Nothing is deleted when you discard: the charge and all thirty-one task ids survive, no success is claimed, and the row stays there to inspect until you clear it. The "Clear finished" badge also now counts what the button will really clear, instead of promising one and delivering none.
- **When a provider refuses your image or your narration, you now see why.** A blocked thumbnail said only that image generation had failed, with a code after it. The actual reason existed the whole time — a refusal naming the objection — but it never left the service that received it, so the same prompt was retried three times at twenty credits a go, and the credits came back but the hour did not. The provider's own sentence is now shown on the failed job, and when the refusal was about the content, a short line suggests rewording. That suggestion is chosen from a stated category, never by reading the words of the message: when the service says plainly that it does not know why something failed, no advice is offered at all — inventing "try editing your prompt" is how somebody rewrites a prompt that was never the problem while the real cause goes unnoticed. Against a service that publishes neither field, the message you see is exactly what it was before.
- **Third-party trademarks are out of everything a customer reads, including the parts that can never be changed afterwards.** A style pack's display name had already been cleaned up; its identifier had not, on the assumption that an identifier is internal. It is not — it is printed on the permanent Installed tab, it becomes the filename you save, a folder in your own library, and a key inside your project file, and unlike prose it freezes for good the moment a pack is first sold. So the identifier is the harder surface, not the softer one, and it has been renamed. Thirteen already-published free starter packs could not be edited at all, because a published pack's contents are frozen by design; they are reissued as new versions with the wording changed, and the originals left byte-for-byte as they were. One built-in art-direction note that asked for a look by brand name now asks for it by description instead — it is text you can read and edit, and it never reaches an image model, so nothing you generate changes. The check that guards this now covers identifiers, family names and filenames as well as prose, so a mark cannot quietly come back.
- **The Deep Time Field Record gains its ocean volume.** *Ancient Oceans & Deep Sea* is written: a hundred named subjects, each with twenty distinct fully-authored angles, every one anchored to a named site and a named stretch of geological time — two thousand episode ideas with no padding, matching the first pack in the collection exactly. The pack was held back until the thing that made it risky was settled first: marine reptiles, ocean anoxia and reef extinctions can each be written honestly from either side of the line between "the organism and the extinction" and "the ocean as a system, and the record it left". That boundary is now held by a check built and deliberately broken before a single line of the pack was written, four borderline subjects were ruled on in writing, and two whole categories were left unwritten rather than argued over. The same check will measure the next pack in the collection on the day it lands.
- **The test system now has to prove every lane ran, not just the biggest one.** The last release closed a hole where a test file could die halfway through and have its results silently discarded, so a run finished green with whole files missing — but only one of the four lanes was given that floor. The other three still rested on their own summary, which is precisely the thing that had just been proved capable of lying. All four now report how many of the files they found actually finished, and a lane that discovers nothing fails instead of passing, which is otherwise the most convincing green light there is. Separately, four false failures in a single day all turned out to be tests asserting that the machine would schedule them promptly — an assumption that is simply untrue when several test runs share one computer; one forty-millisecond pause was measured taking two and a half seconds. Those now either control the clock outright or measure their patience in work done rather than time passed, and a ratchet keeps the remaining cases from multiplying. A failing lane is also named correctly in the verdict now, rather than every failure being reported as the backend one.

---

## v1.4.76 — 2026-08-28

- **Opening the episode list on a large project now takes seconds instead of minutes.** On a project with three hundred episodes the first open took just under eight minutes, and while it ran the rest of the app stopped answering — every other page you tried timed out waiting for it. The app was re-reading the entire project folder from scratch once for every single episode, to answer a question whose answer was identical for all of them: over one and a half million file lookups to draw one list. It now reads the folder once and reuses that answer for the whole request, which makes the first open roughly twenty times faster, and the app stays usable while it happens. The list itself is also 15% smaller, because every row had been carrying a file path that nothing anywhere ever read.
- **Video Assembly now says exactly what is missing, and a skipped opening can be covered in one click.** An episode could pass Scene Review completely green — every scene approved, nothing missing, nothing stale — and then be refused by Video Assembly with "Not ready", with neither page saying why. Both pages were right, about different things: the plan genuinely had nothing covering the first four minutes, because the opening chapter was skipped when the plan was made, and only one of the two was looking at that. Rendering it would have put four minutes of narration against a frozen frame and pushed all three hundred scenes off the audio they were timed against. Video Assembly now names the gap in seconds instead of blaming "timing, images and approvals" as one lump, the same gap is shown on the Scene Plan page where you can actually act on it, and a new **Cover the opening** action closes it by holding the first scene across it. It is opt-in, never assumed, and states what it will do before you choose it. "Repair coverage" is no longer offered for this gap — it declines gaps this size by design, so the one-click fix the old message pointed at could only ever have done nothing.
- **A narration chapter whose connection drops is now retried, instead of failing the batch.** A dropped connection is not a refusal — nobody said no, the answer just never arrived — but it was being treated as a dead end, so a momentary network blip ended a chapter on the first attempt and reported it as a raw connection error. Those chapters are now retried on a ladder measured in minutes rather than seconds, which is the scale a provider restart actually takes. Crucially the retry reuses the same job rather than starting a new one, so a chapter that was in fact received while the connection dropped is reconnected to instead of being bought a second time. You are never charged twice for one chapter.
- **The batch will no longer write a new opening over one you already have.** Episodes made before openings were split into their own file keep the opening inside the main narration, and the check for "does this episode have an opening" only ever looked at filenames — so it found nothing, and the batch happily generated a fresh opening straight over the real one. There is no versioning on that path and no backup, so the original was simply gone, and credits had been spent destroying it. On a three-hundred-episode project where every episode genuinely had an opening, none of them were detected. Those openings are now recognised, once, and remembered.
- **An episode you looked at before its files existed no longer reports itself empty forever.** Opening an episode a moment too early — before the folders it will use are on disk — recorded that emptiness as the answer and then never checked again, for as long as the app stayed open. The work could land and the episode would still show nothing done, with nothing you could do about it short of restarting. That result is no longer kept.
- **Topping a channel up by a single idea works again.** Asking for one more idea failed while asking for sixty succeeded, which made it look like the pack had run out when it had fifteen hundred combinations left untouched. The search was sized from the size of your request rather than from how much of the pack was already spent, so a small request stopped looking long before it reached anything new. It now looks past what has been used, not just past what was asked for.
- **The per-episode concurrency setting now says everything it controls.** It was labelled "Images per episode at once", and it has never governed only images — subtitle transcription, AI video and continuity renders all share the same dial. So turning it down to be gentle on image generation quietly slowed three other things, with nothing on screen to suggest it would. It is now called "Cloud requests per episode at once" and names all four outright. Only the wording changed: whatever you have it set to stays exactly as you set it.
- **The Symbolic Psychology kit now offers a thousand episode ideas, and is four pieces like every other kit.** It was sold on the same depth as the rest of the shelf but pinned to a starter-sized Topic Pack, so it planned ten ideas and stopped. It is now pinned to a Topic Pack measured at a thousand genuinely distinct ideas by the app's own planner. It also carried two extra art styles, making it a six-piece kit where a kit is four; both are established packs in their own right and are now sold separately rather than bundled.
- **The Deep Time Field Record collection begins.** Its first Topic Pack, *Prehistoric Life & Extinction*, is written: a hundred named subjects across twenty distinct evidence-anchored angles each, every one tied to a named site and a named stretch of geological time — two thousand episode ideas, none of them padding. It pairs with the Deep Time documentary Formula the app already ships.
- **The test system can no longer report a pass for work it never ran.** A test file that ended early — a crash that happened to look like a clean exit — simply stopped producing output, and nothing downstream noticed: the run finished green with a whole file missing. That is how three suites vanished from a passing run. Every run now records which files actually finished and checks that against the files it found, so an incomplete run fails loudly instead of quietly. Three real problems the old behaviour had been hiding were found and fixed the moment it was switched off — including one that had been quietly leaving stray background processes behind after a failed run.

---

## v1.4.75 — 2026-08-28

- **The Archival Ledger kit now plans two thousand ideas, where it planned a hundred.** It was sold on the same depth as every other paid kit and pinned to a starter-sized Topic Pack, so it produced a hundred ideas and then ran out — twenty times short of what the rest of the shelf delivers. It is now pinned to a Topic Pack that measures a hundred subjects across twenty distinct settings each, so the depth is counted from what is actually written rather than assumed from the label. The kit is checked against that number by the app's own planner, not by the number printed on the box.
- **Five paid Topic Packs were rewritten to full depth, and the question seeder reached a thousand without padding.** A pack can reach a large number two ways: by writing a thousand distinct things, or by taking a small set and multiplying it until the count looks right. The second way passes a count and fails the promise, and it is why a pack was rejected here before. Empires & Trade, Infrastructure & Commodities, States & Revolutions, Wars & Treaties and Money & Debt have each been authored out to full depth and measured on every axis independently — the subject, the object, the setting, the mechanism and the evidence — so a thousand ideas means a thousand genuinely different ones. The audience question seeder now reaches a thousand the same way.
- **Two new thumbnail recipes, and you can see them before you choose.** A recipe described in words is a guess until you have spent something to find out what it looks like. Object Hero + Question and Route Map + One Promise both ship with rendered previews, so you are picking from pictures rather than from a description.
- **Your description no longer has to come out the same shape every time.** Every channel's description was built in one fixed arrangement, and the only way to get another was to rewrite it yourself afterwards. There are now five description shapes built in — a calm story-first opening, chapters first, a curiosity gap, community first, and a minimal one — with a picker on the metadata page, and a per-episode override so a single episode can differ without changing the channel. A channel that picks nothing behaves exactly as it did before, so nothing you already have moves.
- **The internal section names stopped leaking into your YouTube descriptions.** A description is assembled from named sections, and those names are instructions to the writer, not text for the reader — but the model was printing them into the description as headings, so words only ever meant for the app ended up in what your audience reads. New descriptions are now written clean at both ends: the model is told not to print them, and any that slip through are removed before anything is saved. Descriptions already on your disk are cleaned as they are displayed rather than rewritten underneath you, so they read correctly straight away and it costs nothing — no regeneration, no credits.
- **"Install all missing" now shows you it is working.** Pressing it began a long run of installs and then looked like a button that had not been pressed: no count, no progress, no way to tell whether anything was happening or how much was left. It now reports what it is doing while it does it.
- **Introduction previews are found again for episodes made before v1.4.73.** Openings written before that release were saved without a title recorded alongside them, and the preview looked them up strictly by title — so it failed to find work sitting right there and showed nothing, on episodes whose openings had generated perfectly well. The lookup now recognises those earlier openings and displays them.

---

## v1.4.74 — 2026-08-27

- **The Introduction preview fills itself in, and says so when it fails.** Asking for an opening only ever put the job in the queue, but the preview panel went looking on disk the moment you pressed the button — before anything had been written — found nothing, and was never told to look again. So the panel sat empty until you navigated away and came back. It now follows the same live job feed the rest of the app already listens to, and fills in as soon as the opening exists. And a generation that fails now says it failed, instead of looking exactly like one still running.
- **The composition workspace is back.** The whole feature was still there underneath — the job, the controls it drives, the model picker, everything — but one missing line meant the setting was thrown away every time the page loaded or saved, so the feature could only ever be off. It has been reconnected end to end, and whether you use it is a switch you own again.
- **Music prices show their discounts.** A sale price on a music model was read correctly and then displayed nowhere, so a discount was invisible — you could not see that a model was on offer, and you could not see when it stopped being. Music now shows the full price with the discount marked, the same way images already did, and it prices the model you will actually be charged for.
- **Photos from your phone work as references everywhere.** A phone photo is roughly four thousand pixels along its long edge, and the models publish a ceiling well below that. Only one of the places you can attach a reference was fitting the picture to that ceiling; every other one — master, per-scene, character, thumbnail and art style — uploaded it happily and then failed the render with "resize it and retry", on a file you had no way to resize inside the app. Pictures are now fitted once when they arrive, against the strictest ceiling published, and your original is never altered.
- **Moving between episodes on a large project is roughly five hundred times faster.** Every time the app regained focus, the episode dropdown re-read the entire project from disk to find out what had changed — on a project with hundreds of episodes that is a long, visible stall, repeated every single time you switched back to the app from anywhere else. The app already watches the folder and already knows the moment anything changes, so the rescan was rebuilding an answer it was holding all along. It now trusts what it is watching, and only re-reads what genuinely moved.
- **Pack updates and restores no longer jam on ownership paperwork.** Updating or restoring a pack you already own could stop with "Install failed — try again", and trying again did exactly the same thing, because the receipt the app checks did not list everything the account permanently owns — so a pack you owned outright could fail the ownership check. Both routes now verify against the full list of what you own, and the message you get when something genuinely is wrong says what is wrong instead of telling you to repeat yourself.
- **The Installed count is correct.** The number on the Installed tab was counting the wrong set, so it could disagree with the list sitting directly underneath it.
- **Relaxed Queue models now have a shelf of their own.** Some models are sold at a lower price in exchange for waiting longer in the queue. They were mixed in with everything else with nothing to mark them, so the cheaper price looked like an unexplained inconsistency rather than an offer. They now appear in their own clearly labelled Relaxed section in all three places you pick a model, with the trade-off stated once, plainly — including that the lower price is permanent, not a promotion that will expire.

---

## v1.4.73 — 2026-08-27

- **Every channel now opens in its own voice, instead of every channel opening like a sleep channel.** The opening was the same seven beats for everyone: a breathing exercise in front of a business explainer, a subscribe push before a prayer. There was a mechanism meant to let a channel differ, and it could never actually run — the setting it read was never filled in for any channel, so the branch that would have used it was unreachable. The opening now comes from the channel's Series Formula, the same place its narrator, its closing and its chapter counts already come from, and all twenty-two built-in Formulas ship an opening written for the kind of channel they belong to. It comes free with the Formula, because a default you have to buy is not a default. A channel still carrying the old seven beats is handed its Formula's opening; a channel whose opening was edited keeps every word of it, and the page says which of the two it is looking at.
- **The list of things an opening can cover grew from seven to twenty-one, and each one now says what it does.** "Community question" and "story teaser" meant nothing unless you already knew, and they were the only names on offer. There are now twenty-one, including a cold-open hook, what the episode answers, where the evidence comes from, reading a passage, an invitation to pray, and how to listen — and each is described in a sentence next to it rather than hidden behind an arrow, so you can tell which suit your channel. The breathing exercise now says outright that it is for sleep channels.
- **You can choose which model writes the opening, and save an opening as a reusable recipe.** The opening was written by whichever model wrote the chapters, with no way to say otherwise. You can now leave it as the same model — still the default, and what every existing channel has — or pick one just for openings. And the whole recipe (the beats, the wording, the length, the host, the model) can be saved and applied to another channel. Whether the channel actually uses openings is deliberately not part of the recipe, so applying one can never quietly start spending money on a channel that had it switched off.
- **Scene renders can now use the episode's reference image, which the switch promised all along.** The Character Sheet's "Use episode anchor" switch has been writing its setting to disk with nothing reading it, so you could turn it on and watch nothing happen. Renders now actually send one reference image per scene — the generated layout template if there is one, otherwise the anchor you uploaded — on character scenes only, so a cutaway does not drag the anchored character back into a frame they should not be in. Where the app's own template is larger than a model will accept, the app fits a copy rather than failing the batch and telling you to go and resize a file you never made; your original is untouched. Models that accept no references still render, and say why out loud rather than quietly doing nothing.
- **Visual Recipe is gone.** It was half-removed already: its editor had been deleted, and because of that every Character Sheet save switched the feature off and there was no way to switch it back on. Rather than leave a feature that could only ever be off, it has been taken out properly — the job, its controls, the leftover per-scene fields and the buttons that drove it. Episodes already on your disk are deliberately left exactly as they are; nothing rewrites your own files to remove a setting nothing reads any more.
- **The six built-in art styles are now proper packs, like everything else you can own.** They were hardcoded into the app, which meant they behaved differently from styles you install — most visibly, the built-in route quietly dropped the "avoid this" half of a style before it reached the image model, so part of what the style described was never applied. All six are now signed packs travelling the same route as any other, with the whole style arriving intact.
- **Every starter Channel Kit now delivers the thousand ideas it is sold on.** Each kit was pinned to the first version of its Topic Pack, so a kit advertising 500–1,000 unique episode ideas actually produced between 10 and 40. Four had a fuller Topic Pack sitting there unused; the other six had none written at all, so six were authored — fifty subjects each, every combination written rather than assembled. All ten kits are now measured at 1,000 ideas by the app's own planner, rather than assumed.
- **One Topic Pack was reaching a thousand ideas by padding, and has been rewritten.** Habits & Momentum passed the count and failed the promise: every subject shared one identical setting, every mechanism ended in the same fixed clause, and the subject's own name was glued into the text to make repeated entries look distinct. It counted to a thousand by multiplying, not by writing. It has been fully rewritten with fifty new subjects and a thousand genuinely distinct entries on every axis. A new check measures the difference rather than trusting the total, and it is honest about two other packs that are not yet where they should be instead of quietly passing them.
- **A retiring model's countdown is shown correctly in the thumbnail reference menu.** The badge that warns a model is being withdrawn was working out "how far away" from the wrong moment, so on the day the date rolled over it could state a figure that was a day out.

---

## v1.4.72 — 2026-08-26

- **The Production Board and the Pipeline stop disagreeing about Research and B-Roll.** The Board could say research was done for twenty episodes while the Pipeline showed every one of those episodes as still needing it. Neither view was lying about what it knew — the Pipeline simply had no rule for Research or B-Roll at all, and its list of rules quietly answered "not done" for anything it did not recognise. Both stages now read exactly the field the app itself checks when it decides whether to skip work, so the pills, the counts, the "select everything still pending" button and the batch run finally agree with each other. The tick keeps meaning what it always meant — that the evidence exists — and whether the claims have actually been looked at is now said in words when you hover, rather than being folded into the tick where it would have hidden a different problem.
- **Research runs several at a time, like every other writing job.** It was never given a place in the shared writing budget, and anything without one falls back to running strictly on its own. So fifty queued research jobs went one after another no matter how high "Writing jobs at once" was set — the setting simply did not reach them. Research now draws on the same budget as outlines, chapters and metadata, which is the honest place for it: it is an ordinary writing job, and giving it a private allowance of its own would have made the real number of things running at once a number nobody chose.
- **Two jobs can no longer overwrite each other's scene plan.** Twenty-two different places in the app wrote to an episode's scene plan, and none of them took any precaution against another one writing at the same moment. When two did overlap, the second wrote back the copy it had read before the first one started, and the first one's work vanished silently — no error, nothing in the log, just a field that had been set and was suddenly empty again. Every one of those writers now waits its turn and re-reads the file once it has it, so it is always editing the current version rather than a stale one.
- **Deleting a scene plan no longer brings it back.** Deleting was the one writer left out of the change above, because removing a file looks like the single case that cannot collide with anything. It is actually the worst of them: a job that is midway through its own edit rewrites the file when it finishes, so a delete that slipped in underneath was undone a second later, and the plan reappeared carrying only what that job happened to know about. The delete now waits its turn like every other writer, so what you deleted is gone and stays gone.
- **Chapter regeneration is now proven to stay one-at-a-time, not merely assumed to be.** It has to: each chapter regen rebuilds the episode's whole narration document from scratch, so two at once would talk over each other. That has always been true and was always argued from reading the code rather than from watching it happen — twice. It is now demonstrated by an actual test that turns the budget up as high as the app allows, asks for three chapters of one episode at the same time, and fails if more than one ever starts.
- **The Introduction is a real part of your channel now, and it has stopped forgetting itself.** Nothing anywhere recorded whether a channel opens with a spoken introduction. It was a tick-box tucked inside the Script page's Outline tab; it started switched off every single time, and something on that page switched it back off again whenever the page reloaded what it knew about the channel. Worse, the control was only drawn at all for channels whose Series Formula happened to describe an opening — one Formula out of twenty-one does — so on seven of your ten channels there was no control, and nothing to tell you openings existed. It is now its own page in the sidebar, marked Optional the way Research and Music Library are, and it is there whether or not you use openings, because a setting you cannot see is a setting you cannot learn about. It holds everything the old tick-box held and considerably more room: who the host is, how long the opening runs, the exact first line if you want to fix one, and the ordered list of things it covers — each of which you can switch off, move, delete, add to, or give your own wording.
- **Once a channel says it opens with an introduction, everything that writes an episode writes one.** The unattended batch runner used to keep its own separate tick-box for this, sitting beside the Script box, needing to be ticked on every single run. Forgetting it is exactly how four finished episodes ended up with no opening at all. That box is gone. A run that writes chapters for a channel with openings switched on writes the opening too, and the Pipeline says so on screen before you press Run rather than afterwards. A run that is only re-rendering audio for finished episodes is left alone, because it is not producing episodes and should not quietly grow an extra bill.
- **Your existing channels were not made to guess.** Neither answer was safe to assume for a channel that predates this: assuming "no" makes channels that were using openings go silently quiet, and assuming "yes" spends money on channels that never wanted one. So each channel's setting was worked out from what that channel has actually made — if it has ever produced an opening, it is switched on. The page says outright when the setting was worked out rather than chosen, and asks you to confirm it; saving, whichever way you leave it, settles the matter.
- **You can finally see which episodes have an opening — and you are warned before you pay to voice one that has not.** The app has known this about every episode all along and showed it nowhere: no tick, no count, no filter. It is a column on the Production Board now, and because the stage is optional it never holds an episode back from counting as finished. Separately, if you go to narrate an episode that has no opening on a channel that opens with one, the Audio page says so first. That is the last cheap moment to notice — the opening is read as part of the same narration, so adding it afterwards means voicing the episode again.
- **Asking for an opening now takes an episode and nothing else.** There is no model to pick on the Introduction page, and there is not meant to be: the opening is written by the same language model as the chapters it introduces, and the page says so in plain words instead of leaving a hole where a control should be. If it cannot work out which model that is, it refuses and tells you where to set one. It will not choose one for you.
- **Episodes always live in the channel's own folder.** A channel used to be able to keep its episodes anywhere on your disk, and that setting is why one of your channels appeared completely empty for a while — it was pointed at a folder beside itself that did not exist. Every one of your channels already uses the ordinary location, so nothing moves and nothing is lost; the ability to point somewhere else is simply gone, along with all the code that had to work out where a channel really lived. The honest warning stays: if a channel's episodes folder is genuinely missing, the app still says so, names the folder it looked in, and does not invent a replacement.
- **Two long-standing bugs fell out of removing it.** Files you had picked were sometimes reported as missing when they were sitting exactly where you left them — several pages were measuring "somewhere inside this channel" from the wrong starting point, and now measure from the real one. And a channel you happened to name "Episodes" never had its episodes folder created at all, so it reported itself missing forever.

---

## v1.4.71 — 2026-08-26

- **The app now warns you *before* a model disappears, not after.** GenStudio decides in advance when it will stop selling a model, records the date, and publishes it alongside every model in the list — it has been doing this the whole time. Story Studio read straight past it. The only thing the app could say about a retirement was said afterwards, at the moment a model you had chosen months ago stopped answering: "retired or unavailable, choose a replacement". A countdown that had been running quietly for weeks reached nobody. Models being retired are now flagged in the picker so you can spot them while browsing, and while one is chosen the app tells you underneath, in plain readable text, the date it stops being available **and how far away that is** — because a bare date just makes you do the sums. It says nothing about what to switch to: that is your choice, and the app has always promised not to make it for you. The same flag now appears in the other two places you pick a model as well — the thumbnail reference reader and the web-research list.
- **A channel you set up months ago gets the same warning.** The picker only helps someone who happens to open it, and there is no reason to reopen it before the date passes — which is exactly how this bites. Every model a channel has saved, wherever it was saved, is now checked against the same published dates, and anything being retired shows up under "Action needed" with its date and its countdown, soonest first. It clears itself as soon as you move that stage onto another model.
- **Six pieces of information the app was throwing away now arrive intact.** This was the third time in a row that GenStudio published something honest and Story Studio dropped it on the floor — after the credit balance, then the data notice. The full list of what else is being discarded has been written down, so the next one is found by looking rather than by a customer noticing.

---

## v1.4.70 — 2026-08-26

- **"GenStudio Unavailable" no longer appears while the app is working.** The little balance panel in the corner asked GenStudio for your credits once, waited eight seconds, and if that one request was slow or came back wrong it wiped the number and announced the whole service was unavailable — next to a narration job that was generating perfectly normally. Everything else in the app already knew better: the model catalogue and job submission both try again, and both fall back on the last good answer during a short interruption. That balance check was the only part that did not. It does now, and there are three honest answers instead of two: your current credits, your last known credits marked with how old they are, or — only after the retries have genuinely failed and there is nothing left worth showing — Unavailable.
- **GenStudio's data notice is now actually shown to you.** Some language models are offered at a reduced price on the understanding that what you send them may be kept and may be used for training. GenStudio publishes that notice on every model it applies to — and Story Studio was reading right past it. Since language models are only ever chosen inside this app, that meant nobody ever saw it: you could pick one of those models today without being told. Models carrying a notice are now flagged in the list so you can spot them while browsing, and the full wording appears underneath the picker, in ordinary readable text, for as long as such a model is the one you have chosen. It vanishes when you pick a model without one. There is no box to tick — the notice ends by saying not to use those models if you do not agree, so choosing one is the agreement, and there is nothing extra to click past.
- **Prices and limits say when they might be out of date.** The app keeps using catalogue figures for up to half an hour after a failed refresh, which is the right thing to do, but until now only the Settings page ever admitted it. The Audio Generator shows the rate per request, the minimum charge and the characters-per-request limit as plain fact, with nothing to say whether they were read a second ago or twenty minutes ago. A quiet "Last known · 12 minutes ago" now sits beside those figures whenever they came from a kept copy, and nothing at all appears when they are current. Settings, the balance panel and the generator all word it the same way.

---

## v1.4.69 — 2026-08-26

- **This is v1.4.68, rebuilt so that it starts.** The v1.4.68 download would not open at all. It was packaged from a folder where the app's supporting libraries were only a shortcut to somewhere else rather than the real thing, so the packager skipped them and the finished app had nothing to run on. Every fix listed under v1.4.68 below is in this build, unchanged — only the packaging was wrong.
- **A build that cannot start can no longer be released.** The release check confirmed the app was correctly signed, correctly named and correctly structured, but never that it actually runs, which is exactly how a dead build got through. It now opens the packaged app for real and waits for the app's own internal service to answer before the build is allowed to pass, and it separately confirms every library the app needs is genuinely inside the package.

## v1.4.68 — 2026-08-26

- **The app stopped writing its own name into your scripts.** Every narration file it built opened with a line naming the app and the episode number, and that line is the first thing a model reads when it works out what the episode *is*. That is why descriptions came back saying "In this episode of Story Studio" and carrying #StoryStudio — nothing you wrote put it there, the app did. The line is no longer written, and it is stripped out of files already sitting on your disk as they are read, so old episodes stop causing it too. What this does **not** do is go back and rewrite metadata you have already generated: descriptions and tags saved before today stay exactly as they were saved, deliberately, because they are yours to keep or change. Anything already uploaded has to be corrected in YouTube itself.
- **Audio is split up according to the voice you picked, not the one you used last time.** It had been reading the model from the episode's previous run, so changing voice and regenerating gave you sections sized for the old one. There was also a leftover 4,800-character limit and a table of chunk sizes for three voice engines that are no longer used at all. All of it is gone. The only boundary left is the published limit of the model actually in use.
- **The Introduction uses your script's model.** In a batch run it was quietly falling back to whichever model happened to be listed first, which is not the one you chose. It now uses the model set on your script, and if it cannot work out which one that is, it stops and asks you to pick rather than choosing for you.
- **Two lettering styles were describing the wrong thing.** "Script" and "Handwritten" live in the list that sets a finish — gold, ink, and so on — but their wording described letter shapes, so choosing either one quietly overrode the letterform you had already picked. They now describe only their finish, and read as Golden Shimmer and Inked Finish.
- **All 35 built-in lettering swatches ship inside the app.** Every one shows a real sample in the picker the moment you open it. The inked finish was redrawn as well: its texture used to flatten into a plain grey square once shrunk to picker size, so the one style whose whole point is visible grain was the one you could not see.
- **Errors no longer show internal file paths.** A pack that fails to verify or install now names the pack and what went wrong; where it lives on disk stays in the log, where it belongs.
- **Machine-specific and identifying details have been removed throughout.**

## v1.4.67 — 2026-08-25

- **The Story registry is reconciled.** Historical authored and reserved content-pack identities, exact receipt-bound dependencies, and the six lettering transitions now share one validated canonical ledger.
- **Ten thumbnail recipes are included locally.** All ten authored recipes have independent specification and visual-quality reviews, thirty deterministic 1672×941 previews, and repeatable keyless build evidence. They remain local authored source candidates; no purchase, activation, publication, or live stocking was performed.
- **Starter successors preserve their quoted history.** The two Formula 1.0.0 dependencies required by the immutable Kit receipt remain intact while the approved thumbnail successor references are verified.

## v1.4.66 — 2026-08-25

- **The Content Store works again.** It had a rule refusing any reply from GenStudio containing more than 4,096 separate pieces of data, and the list of what your account owns finally grew past it — eighteen packs bought today, each adding a receipt. Nothing was wrong with the store or your account; the app simply refused to read an answer that had become one item too long. The limit is now 65,536, about eleven times the largest thing you have, and still small enough to refuse a genuinely hostile reply. The check that proves you own what you bought is untouched, and a test now loads all 82 packs and verifies every signature to prove it.
- **When a reply is too large, the app says so.** This cost a full day to find because every failure looked identical: "The Content Store is unavailable", every count zero, no clue anywhere. It now names what was too big, which request it came from, and tells you that updating the app is the fix rather than refreshing.

---

## v1.4.65 — 2026-08-25

- **Installing a pack you own stopped asking GenStudio the same question 65 times.** Before every single install, the app fetched the entire release history of every pack you own — just to check whether any had been withdrawn. Installing a library meant thousands of requests. Nothing errored; it was simply slower than the app's own timeout, and it told you "the Content Store is unavailable" when the store was perfectly healthy. The server had already answered that question in one field the app was not reading. 65 requests became none.
- **Select all, then one click buys all.** The selection bar counted your packs and totalled their price, and then the quote showed one product and bought one product. It now prices the whole basket, shows a single total before you agree to anything, and settles each pack independently — so one failure does not undo the rest, and you are told exactly which failed and why. Packs you already own are skipped rather than charged, and a retry cannot buy the same pack twice.
- **A row of Content Store cards lines up.** The selection bar, the selection buttons and the install-progress strip had no styling written for them at all, which is why "2 selected" and the credit total ran together as one word. The cards used a layout that spread each card's spare height between everything inside it, so the picture, the price and the title landed at a different height on every card.
- **An information notice no longer looks like a warning.** Every heading in a notice box was coloured warning-amber, including purely informational ones — which is how you learn to ignore amber before a real warning arrives.
- **Internal notes stopped shipping inside packs customers download.** Four packs and two built-in channel types carried working notes naming this channel's own shows and four outside creators. They are gone from the bytes, not just the source.
- **The wildlife formula covers insects**, instead of excluding them and pointing at a pack that was never made. A thumbnail recipe that both required and forbade a subtitle banner now agrees with its own artwork, and three series that pointed at subject packs which do not exist now point at the ones that do.

---

## v1.4.64 — 2026-08-25

- **Your channel types no longer decide what your videos look like.** Nine of them carried art-direction written into the file itself, and if a channel had no style of its own the app quietly used that instead — with nothing on screen to say so. Four of your channels were being drawn in a look nobody had chosen. Each one has been pinned to the exact look it was already using, saved as a normal style you can see and change, so the pictures come out word for word the same as before.
- **A Formula can now only suggest.** Its recommended look appears on the Formula card in one of three plain states — already in use, installed with a button to apply it, or not installed with a link to where you can get it. Nothing is ever written into a project without you clicking.
- **The app will no longer save an art style that isn't there.** That is what had been silently happening to one of your channels: a style it could not find, no warning anywhere, and images generated without it for months. Saving one now fails with a clear message instead of succeeding quietly, and a project already in that state says so on screen.
- **A pack that fails to install no longer sits in a corner marked broken for ever.** Installing it successfully now clears the old failure, and failures leave a trace in the log instead of vanishing without one.
- One thing did change: **one channel's thumbnails** lose their separate charcoal-and-ink direction, which lived in a slot the new saved-style setting cannot reach. Its covers now follow its scene style. Picking a thumbnail recipe for that channel in Settings restores a deliberate look — the psychology one already installed is the closest match.

---

## v1.4.63 — 2026-08-25

- **The Content Store came back.** Adding font packs this morning broke it in two places at once, and this is the half that lives in the app. The app's screens were taught what a font pack is; the part that checks what the shop sends back was not. One unrecognised item does not get skipped — it collapses the whole list, so all 82 products disappeared, not just the six new ones. Your credits, your purchases and the 64 packs you own were never at risk; the store was simply frozen until both halves were fixed.
- The other half was on the server and needed no code: that process had been running since Sunday and had never heard of font packs either.

---

## v1.4.62 — 2026-08-25

- **Six font packs are on the shelf.** True Crime & Investigation, Horror & Dread, Documentary & Archive, Bold Explainer, Calm & Sleep, Retro & Arcade — six lettering styles each, three letterforms and three treatments per pack so any two can be combined. 300 credits a pack, 90% off until the end of the year. No font files are installed: each style carries the phrase the image model draws from, so the letters are part of the picture instead of a layer stuck on top.
- **Every style ships with its own swatch.** All thirty-six were rendered once, showing the same word, and travel inside the pack — so a pack style shows a picture the moment it is installed, with nothing to generate and nothing more to pay.
- **Three faults in the lettering work, each of which would have made those packs worthless.** A pack's swatches counted as unreferenced files, so no font pack could be built at all. The picker read only the built-in list, so an installed pack's styles never appeared in it. And when they did appear, the app ignored the swatch in the pack and asked an image model to draw a new one — charging you again for a picture you had already bought.
- Pack styles now show their real name in the picker instead of their internal id.

---

## v1.4.61 — 2026-08-25

- **"Reference-guided thumbnail" is collapsed by default.** It is an occasional tool and it sat wide open between the art style and the lettering, breaking the run you actually make every episode: style, then recipe, then what the words say and how they look. It is now a single line — "Use an existing thumbnail as a guide" — that opens when you want it.
- The closed line still says whether a reference is applied, so one set weeks ago cannot quietly shape every thumbnail with nothing on screen to show for it.

---

## v1.4.60 — 2026-08-25

- **"Thumbnail text" — the nine options for what the words actually say — was in a block you could not see.** Twice. It shipped in 1.4.56 near the top of the Thumbnail Prompts tab, in a group that does not render on the layout you use, so from your seat the feature did not exist. It now sits at the top of the Thumbnail lettering card, above the font, as the first of four decisions — because what the words say changes the picture more than how they look.
- If the options fail to load, the card says so instead of showing an empty box.

---

## v1.4.59 — 2026-08-25

- **Rendering a swatch failed with `400 Bad Request`, every time, and it was my mistake.** The Thumbnail Prompts page chooses a *language* model — it writes the prompts — and I passed that where an *image* model was needed. GenStudio quite rightly said DeepSeek is not in its image catalogue. A swatch is an app-level picture, not a per-project one, so the page no longer supplies a model at all: the server picks the **cheapest published image model** that can render 16:9, deterministically, so the choice is stable and never silently orphans swatches already rendered.
- **Each of the three lettering choices is now one line, with the grid in a popup**, like the Recipe Library and the Style Library. The chosen style shows as a small strip — its swatch, its name, the phrase it injects — and "Browse" opens the full grid. That holds at thirty-five styles and still holds at three hundred.
- "Let the model decide" is a swatch inside the grid rather than a radio button above it, so every option lives in one place.

---

## v1.4.58 — 2026-08-25

- **One card for the whole lettering decision, where you were already looking.** The swatches added in 1.4.55 went into a block higher up the Thumbnail Prompts tab, while the three dropdowns you actually use — Text style, Font, Title location — sat further down, unchanged. That was my mistake and it made the swatches invisible. Those three dropdowns are now a single "Thumbnail lettering" card, shaped like Channel art style: the font, the finish and the position together, with the swatches in place of the words.
- Each part says what it decides in plain terms — the font is "the shape of the letters", the text style is "the finish on the letters", the location is "where the words sit in the frame" — and each keeps a "Let the model decide" option. The duplicate randomise button below the card is gone; the card carries its own.

---

## v1.4.57 — 2026-08-25

- **A Content Pack can now ship thumbnail lettering styles, so a font pack is something you can sell.** Until now the font and treatment lists were hardcoded in the app, which meant a pack could not add a lettering style at all — there was nothing to put in a font pack whatever else was built around it. `lettering-style` joins the seven existing pack item kinds on exactly the principle the last three were added on: a look is a description the engine interprets, and the thumbnail prompt builder already turns a lettering phrase into an instruction for the image model.
- **A pack style must ship at least one rendered swatch.** A lettering style without a picture is a name, and a name is what a buyer cannot judge. The phrase itself is the product; everything else on the document exists to help somebody choose it.
- **A pack can never take an id a built-in already owns** — refused when the pack is built, and refused again when it is read, so a pack authored against an older build cannot shadow a style added since. Otherwise a buyer pays for a style that silently loses a lookup, or worse, changes what every existing thumbnail prompt means.
- No font files and no local typesetting: the image model draws the letters.

---

## v1.4.56 — 2026-08-25

- **You choose what the thumbnail says, in nine options instead of two.** Full episode title · two or three words · a curious question · one-line summary · this versus that · the cost or the warning · a number · a line from the episode · no text at all. Each says plainly what you get, and each carries an exact word budget — "curiosity hook" with no length was an invitation to write a sentence, which is how a whole title ended up in gold serif across a symbolic-split cover.
- **The recipe supplies a default; it no longer overrules you.** Before, the recipe decided and there was no way to say otherwise. Now an explicit choice wins, a recipe fills in when you have not chosen, and only when neither has said anything does the old behaviour apply — deliberately unchanged, because a recipe that never asked for a hook has not consented to one and every existing channel would otherwise have been silently rewritten. New work on the Thumbnail Prompts page starts on "two or three words".
- **Every invented headline comes back for review.** The words the model picked are returned in the title field, so you can read them before rendering rather than discovering them inside the picture. An invented headline may never fall back to the full episode title — that is the exact failure the mode exists to prevent, and it is stated in the instruction.

---

## v1.4.55 — 2026-08-25

- **You can now see what a font or a text style looks like, instead of reading its name.** "Neon", "blackletter gothic calligraphy", "retro 1970s chrome lettering" are only meaningful if you already know what they look like — which is the opposite of what a picker is for. Both the Text Style and Font Style choosers now show a grid of swatches: the same word, rendered once in every style, picked by eye.
- **One variable per swatch.** A font swatch changes the letterform and keeps the treatment plain; a text swatch changes the treatment and keeps the letterform plain. A swatch that changed both would show you a combination and teach you nothing about either. The word is the same in all of them for the same reason.
- **Rendered once, kept for ever.** Each swatch is one image, cached by content, and a style added later costs exactly one more — nothing already rendered is discarded or re-made. Every swatch uses the exact phrase the prompt builder really injects for that style, so it shows what will actually be asked for rather than a paraphrase.
- A "Show me" button renders whatever is still missing, one at a time, and if one fails the ones already rendered are kept. Styles that have no swatch yet say "not rendered yet" rather than showing an empty tile.
- Worth knowing: `script` and `handwritten` exist in **both** catalogues, so the two kinds are cached separately — otherwise the font swatch and the text swatch of the same name would share an entry and one would silently show the other.

---

## v1.4.54 — 2026-08-24

- **Thumbnail prompts were printing the episode code as the headline.** Every prompt for EP0344 came back reading `Large bold sans-serif text 'EP0344' is placed on the right` — five images with a filing code across them, and credits spent making them. One line was responsible: with no title on the request the generator fell back to the episode id, and the resolved title is exactly what gets drawn inside the image.
- **An episode's own title is now looked up when the request omits one**, from the same idea record that named its folder. If there is genuinely no title anywhere, the run refuses and says where to add one. Refusing is the cheap failure; five paid thumbnails reading "EP0344" is the expensive one.

---

## v1.4.53 — 2026-08-24

- **Idea campaigns were throwing away good ideas and then failing.** A thirteen-idea run on the Animals pack lost six of its first ten slots to "output drifted from assigned subject", kept refilling, and ended `12/13 required item(s) verified`. Nothing was wrong with the ideas. The check asked whether the subject's own words appeared in the title, and a Topic Pack subject is a category — "mammals", "big cats", "corvids" — while a good title names the animal. "Why the Naked Mole-Rat Never Gets Cancer" shares no word with "mammals", so it was discarded every time.
- **An idea now counts as on-brief if it matches either the subject or the specific thing it was told to be about.** Every assignment names an episode object — "a leopard hauling a kill up a tree" — and an idea that mentions the leopard has done exactly what was asked. Genuine drift is still caught: an idea sharing nothing but grammar with its assignment is still refused, because ordinary words are dropped before anything is compared.
- **Topic Packs now say where they came from and what they can actually do.** A pack bought from the Content Store and a built-in of the same name were two identical rows, so installing a fifty-subject Animals pack and then seeing "10 subjects" in Channel Identity was a mystery with no clue in it. Each pack is now badged Owned pack, Built-in or Custom, and the summary reads "50 subjects · 1,000 episode ideas" instead of "1 coverage axes", which told nobody anything.

---

## v1.4.52 — 2026-08-24

- **The Content Store had grown to sixty-five packs and read as one long pile.** Owned and Updates now group what you have by what it actually is — Series Formula, then Topic Pack, Visual Style, Thumbnail Recipe, and Channel Kits last. The order is fixed rather than alphabetical, so a section never moves about as your library grows, and a kind this build does not recognise still appears under "Other" rather than vanishing from a library you paid for.
- **"Install all missing" installs everything that is owned but not on this Mac**, in one click. A pack whose installed copy is an older version counts as missing, because the files on this Mac are not the release the account owns. Anything incompatible with this Story Studio is never queued — that would be queuing a guaranteed failure.
- **Installs are queued instead of refused.** Clicking Install used to disable every other Install button until that one returned; with sixty-five packs that is sixty-five deliberate waits. Clicks now go into a queue that works through them one at a time, each button saying whether it is Queued or Installing, and one failure no longer strands the rest of the batch. Installing still happens one at a time under the same coordination lock as before — what changed is that you no longer wait for it.
- **Filter by whether a pack is on this Mac** — All, Not installed, Installed — with a live count on each.
- **Buy several at once.** Tick the packs you want in Discover and the store walks you through their quotes in turn. GenStudio still quotes and charges one pack at a time and still asks you to confirm each one; what is gone is returning to the grid between every purchase. Anything that became owned between choosing and quoting is skipped rather than quoted twice.
- **A completed purchase no longer throws you onto another tab.** It used to jump to Owned every time, which made buying six packs six separate journeys.

---

## v1.4.51 — 2026-08-24

- **Opening a library was taking nine seconds, and it was about to get worse.** The Thumbnail Recipe Library showed a spinner for nine seconds to display twelve recipes — measured, three times, with no caching in between. The cost was never in the recipes. Every time the app listed anything from your content packs, it re-read and re-hashed all sixty-four installed pack versions — forty-four megabytes, the archive once and every unpacked file twice — and then did it again for the next list, and the next. At two hundred packs the same twelve recipes would have taken half a minute.
- **A pack version's contents cannot change without the app noticing, so it is now checked once and remembered.** The memory is keyed to the actual state of the files on disk — every path, its size, its timestamp and its permissions — so any edit, replacement or truncation misses the memory entirely and pays the full check, exactly as before. Nothing is written to disk and nothing survives a restart; startup still verifies everything from scratch. Since startup does that check anyway, the memory is already warm by the time you open anything.
- Three tests hold the line: the second check of untouched files does no work, a file edited after a successful check is still caught, and a file swapped for different content of exactly the same size is still caught.

---

## v1.4.50 — 2026-08-24

- **The four music packs you asked for are in: Sleep, Eastern Calm, Meditation and Calm Adventure.** Forty new worlds, ten to a pack, each with its own look, four scene variations so no two videos share a background, and the music styles it suits. Ninety worlds in total now.
- **Sleep** is the quiet end — a bedside lamp, a night train berth, embers in a snowbound cabin. **Eastern Calm** is mountain temples, ink-wash peaks, bamboo groves and tea houses, scored for guqin, guzheng and bamboo flute. **Meditation** is the spare one: salt flats, a raked sand garden, the centre of a frozen lake. **Calm Adventure** still moves — a coast road at sunrise, a ferry deck, a lighthouse path — without ever stopping being calm.
- The check that used to insist on exactly fifty worlds now checks the thing that actually matters: whole packs of ten, every register accounted for, and every world complete enough to shoot and to score. A count goes stale the first time you add a pack; the shape does not.

---

## v1.4.49 — 2026-08-24

- **Thumbnails no longer hold up your fleet.** Thumbnails and Scene Review shared one budget, so three thumbnail episodes — which run on a cloud model — consumed the whole allowance while your local machines sat waiting for a slot they were never going to take. They are separate lanes now: neither can starve the other.
- **Two numbers instead of one**, both in Settings. "Episodes making scene images at once" covers Scene Review and Image Pool — the work on your own machines. "Episodes making thumbnails at once" is its own dial, and raising it cannot slow your fleet down.
- The split is by the kind of job, not by which model you happened to pick, so the lane a job sits in is settled when it is queued and never changes underneath it.

---

## v1.4.48 — 2026-08-24

- **Opening a large channel re-read the same two files hundreds of times.** Listing a 302-episode channel went back to disk for `ideas.json` (275 KB) and `project.json` once *per episode*, several times over — roughly 68 MB of the same JSON parsed to answer one request, for two files that cannot change while that request is being answered. That is where the seven-second first load went.
- **They are now read once per request and shared.** Measured on a 302-episode project: the folder-resolving pass drops from **465 ms to 162 ms — 65% faster** — and that is only one of the several passes per episode that now share the same read. The saving on a genuinely cold load is larger.
- **Nothing about what the app concludes has changed.** Only the raw file contents are shared; every episode still finds its own title, its own folders, its own renamed-folder match. Tests prove a snapshot resolves byte-identical paths to a fresh read, that it never outlives the request that made it, that one made for a different project is ignored rather than believed, and that a failed read is retried instead of remembered.

---

## v1.4.47 — 2026-08-23

- **The "More" menu now closes when you click away from it**, and on Escape. It was built from the browser's own collapsible element, which by design only closes when you click the same button again — so it read as stuck. Both places that use it are fixed together, and a test keeps it that way.
- **The withdrawn iCloud sync is no longer described on screen.** "No script was found — if iCloud just delivered it" told you to wait for something that cannot happen: library linking and iCloud delivery were withdrawn, and one folder is chosen at first run. Six places said it; all now describe what actually happens, which is a file appearing on disk. The Settings page still mentions iCloud Drive where it means the folder you chose, which is true and useful.

---

## v1.4.46 — 2026-08-23

- **The update still would not install, and this is the actual reason.** 1.4.45 taught the app to accept your account-wide proof of ownership, and it got further — then failed with a generic "Failed to install". Underneath, the pack file was being quarantined as invalid: the final check still read your proof in the *purchase* shape, looking for a product block, a release block and a purchase-time component list. Your account-wide proof has none of those; it lists the current version of everything you own. So it verified the signature, found the wrong shape, and threw the file away.
- **The check now reads whichever kind of proof it was given**, decided by the proof itself rather than a flag beside it. The bar is unchanged: same signing key, same account, and it must name this exact pack, version, contents hash and byte count. A kit's four components bind the same way — to the versions you are entitled to today, which is the whole point of a free upgrade.
- **This is the third attempt at one bug, and the first two were called fixed while it was still broken.** Both were checked by reading the source rather than by installing anything, and neither could see a quarantined file behind a generic error. There is now a test that publishes a new version, offers it as an update and installs it — and it fails if any part of that chain breaks.

---

## v1.4.45 — 2026-08-23

- **"Install update" did nothing on all five kits, and it never could have.** The app demanded a purchase receipt naming the exact new version — but a free upgrade is never purchased, so no such receipt exists or ever will. Your original receipt is frozen at the version you bought, deliberately, because a receipt has to keep saying what it said on the day. Every free upgrade the store has ever offered was refused for this reason.
- **It now accepts the account-wide receipt GenStudio mints fresh on every check**, which exists precisely to say "this account, these packs, these current versions, right now". It is signed by the same key and was already being verified before this point — for an upgrade it is the stronger evidence, because it is current rather than historical. Every identifying detail is still matched exactly: pack, version, contents hash and byte count.
- **A kit's four components now bind to the version you are entitled to today** rather than the one pinned on the day you bought the kit, which is the whole point of a free upgrade.
- **The test fixture was hiding this.** It rebuilt every purchase receipt from the pack's *current* version, so a receipt quietly rewrote itself whenever a new version appeared — the exact situation the code had to handle was impossible to reach in a test. It now freezes at purchase, like the real thing.

---

## v1.4.44 — 2026-08-23

- **Every Content Store pack you own has been switched off since you installed them.** All 55 of them, since 16 August. They downloaded, they verified, they show as installed — but each one was missing the single marker that tells the app which version to actually use, and without it every formula, style and thumbnail template inside them was skipped. You have been running on the built-in ones the whole time and nothing said otherwise.
- **That is also why today's new packs looked like nothing had happened.** With no version marked as in use, the store reads a pack sitting verified on your disk as "not installed" — so the nine packs that got a new release today had nothing to compare against, and the Updates tab stayed at zero while telling you everything was current.
- **Nothing was ever going to fix it on its own.** The startup repair that exists for exactly this kind of damage began by skipping any pack with no version in use — the one case it needed to catch.
- **On first launch, the app now adopts the newest version of each affected pack** and reports what it adopted. It only adopts a version that fully passes the same verification a rollback uses, and it never touches a pack you have deliberately pinned, recalled, or removed. If nothing verifies, the pack stays switched off rather than being forced on.

- **The test suite was passing while a test was failing.** It printed the failure in full and then reported success, and two releases went out on top of that. It is now judged on what the run actually reported — no summary means an unfinished run, and an unfinished run is a failure — rather than on a number produced while the runner is already shutting down. Turning it on immediately found two more real problems, both below.
- **A folder anywhere above the one you scan could lend its name to your videos.** Archive Sweep looked for an episode code across the whole path, so a disk, user folder or sync cache whose name happens to contain letters-then-digits could attach that code to an unrelated video. It only ever caused a confusing "skipped" message — the channel check still refused to move anything it could not place — but the code was invented from somewhere you never pointed at. It now reads only the folders inside the one you chose.
- Two settings checks were still looking for the old spelling of the Settings panel after last night's rewrite. The settings themselves were fine; the checks were reading a stale copy.

---

## v1.4.43 — 2026-08-23

- **Repair no longer turns one broken episode into a search of the whole channel.** Every screen that offers Repair already knew exactly which episodes were broken — the failed-batch banner, the missing-assets report — and every one of them threw that list away and started a scan of all 302 episodes instead. They now hand the codes over, so Repair checks only what actually failed.
- **The one button that really does sweep the whole project now says so.** It reads "Scan all for repair", not "Repair assets" sitting next to per-job Repair buttons that fix one thing. Choosing the sweep should be a choice.
- **"Recover this episode" has stopped appearing where it could never work.** It was offered on Scene Plan, which produces text — Repair only recovers audio and picture files, so there was never anything for it to fetch. It was offered on Scene Review too, whose images Repair cannot even see. Both were exactly the rows you were looking at, and both sent you to a full-library scan that could not have helped either one.
- **Retry on a Scene Review job was described as the expensive option. It is the cheap one.** It first pulls back every image the provider already made and charged you for, at no cost, using the record kept for each one, and only re-submits scenes with nothing to recover. The tooltip said the opposite — "re-runs the whole step, no repair path" — so the free fix looked like the costly one.
- The repair list also stopped offering two job types that were deleted with the retired scene-image generator.

---

## v1.4.42 — 2026-08-23

- **Saving the throughput settings told you nothing.** It also threw away the server's reply, so a number the server adjusted to fit a limit still showed as what you typed — you'd have walked away believing a value that wasn't real. It now reports what is actually in effect.
- **Every throughput setting is a dropdown with the reasoning in it**, instead of a box you had to guess at. "Auto" was a magic word you could only use if someone told you it existed.
- Each option says why: which number is recommended, which one overwhelmed the fleet last week, which one GenStudio itself accepts. Custom is still there on every field, and there's a "Use recommended" button to put everything back.

---

## v1.4.41 — 2026-08-23

- **Both throughput numbers are now yours, in Settings.** "Episodes making images at once" (3) and "Images per episode at once" (auto — follows what your account can actually run, and rises by itself as you add machines).
- **The first attempt at this missed Scene Review**, which is the only image generator you still use. It would have shipped, you'd have installed it, and your batch would still have run one episode at a time. Now every kind of fleet work is pipelined — images, video and narration each with their own allowance, so a big picture batch cannot block a voice job queued behind it.
- **The retired scene-image generator is gone, root and stem.** Four job types, one whole generator file, its executor registrations, queue lanes, cancellation auditors and retry-policy entries. The front door had returned "this is retired, use Scene Review" for a long time; the machinery behind it was still wired up and still looked alive.
- Your three image generators are untouched and confirmed working: Scene Review, the thumbnail generator, and image pool generation.

---

## v1.4.40 — 2026-08-23

- **The other half of the idle-fleet problem.** One episode of 108 images was running exactly 50 of them — because 50 was written into the code. Your account's published limit is 128, and GenStudio had **nothing** queued. Nothing was full, nothing was throttling, nothing was waiting. The app just never offered more work.
- **It now asks how much you can run instead of guessing.** GenStudio already publishes your real ceiling, so a 108-image episode now goes out as 108. This is safe because GenStudio decides what actually starts — the app can't flood it, only under-feed it, which is exactly what it was doing.
- **When your fleet grows, this grows with it.** Your ceiling rises as you add machines, and the app follows. Nothing to set and nothing to remember.
- If your account ever publishes no ceiling, it falls back to the old 50 — unknown stays cautious rather than unlimited.

---

## v1.4.39 — 2026-08-23

- **Your machines were mostly idle and nothing said so.** With 50 Scene Review jobs queued, 51 of your 74 online fleet workers had nothing to do — and a location connected that morning had one busy worker out of twenty.
- **Neither the fleet nor GenStudio was the limit.** Your account can run 128 jobs at once; 25 were running. Story Studio was doing the episodes **one at a time**, because image work only ever had a single slot. Fifty queued episodes were strictly serial, no matter how many machines you owned.
- **"Episodes making images at once" is now a setting, defaulting to 3.** Scene Review, Images, Thumbnails and Image Pool share it. One left your fleet idle; thirty is the flood that lost a third of a transcription run last week. Three is busy with headroom — and since your fleet grows most weeks, the number is yours to raise.
- This is the third lane with the same story, and the first found by measuring rather than by something breaking.

---

## v1.4.38 — 2026-08-23

- **Music channels.** A new "Music Mix" format and a Music Library page: buy songs once, then build as many long-form music videos from them as you like. Building a video never costs anything.
- **Your library is a shelf, not a shopping list.** One request to the music model returns two complete songs for one charge, and both are kept. About ten requests buys an hour of music, so a two-hundred-song library costs roughly six dollars once — and after that the fiftieth video costs exactly what the second did: nothing.
- **The page is organised around what spends money.** Exactly one section is marked "costs credits" and tells you how many songs you're ordering. Preview and Build are marked free, and Preview shows you the whole tracklist and runtime before you commit to anything.
- **It never quietly buys or quietly shortens.** If your library is too short for the length you asked for, it says by how much and stops — it will not top itself up mid-build.
- **Two songs from one request are kept apart in a mix.** They come from the same instruction, so they sound like cousins; back to back a listener hears one song looping.
- **Fifty worlds to choose from, and they're data.** Add one, edit a scene, change the music styles — no code change needed. A two-hour video loops one still image, so it takes minutes to make rather than hours.

---

## v1.4.37 — 2026-08-23

- **Scene Plan now refuses a model that cannot return structured data, before it spends anything.** Four batches failed today on a DeepSeek model that publishes no structured-output support. Your system can only *ask* such a model for JSON and reject what comes back — so it answered properly for two chunks of forty scenes and wrote prose for the third. Two episodes stopped at exactly 80 of 111 and 80 of 113. That was never a size limit; it was where the luck ran out.
- **The app genuinely could not see the problem.** Its catalogue reader had only two settings for "can this model return structured data", and "no" wasn't one of them — anything that wasn't the strictest setting was filed as "yes". So a model that cannot was recorded as one that can, and GenStudio's own correct diagnosis had nowhere to go.
- **The refusal names which model you picked** — there are two with nearly the same name and only one of them works — tells you what to switch to, and says plainly that nothing was charged.
- It refuses rather than warns on purpose. A model that works *some* of the time is worse than one that never does: you get half-finished episodes that look like a glitch instead of a wrong setting.

---

## v1.4.36 — 2026-08-23

- **An outline that comes back LONGER than asked for is now kept, not thrown away.** EP0056 asked for 10 chapters, the model wrote 11, and the whole thing was binned — after GenStudio had already done the work and charged for it, with no automatic retry. You paid for an outline that contained everything you wanted plus a bonus chapter, and got nothing.
- **A longer episode is more runtime, so extra chapters are the point, not a defect.** The extra chapters now flow all the way through: expansion, the completion checks, the outline editor and the cleanup sweep all follow what the outline actually produced instead of what was requested.
- **It can still never come back SHORT.** That rejection stays exactly as it was, and for a good reason: a short outline gets quietly padded with empty chapters that turn into waffle nobody notices. Long is an opportunity; short is a hole.
- **The limit is yours, in Settings.** "Extra chapters allowed" defaults to 2 — up to double the target. It exists only to stop a garbled answer turning into hundreds of paid chapters, not to police quality. Set it to 1 if you ever want the exact number.

---

## v1.4.35 — 2026-08-23

- **The Pause button now actually pauses.** It did not, in four places. On image batches it stopped nothing at all — the app carried on buying every remaining scene and thumbnail to the end of the run. On subtitles a Pause pressed during a wait was ignored for up to five minutes. Contextual Cues and Image Pool had the same gap.
- **And a paused job now says "paused", not "failed".** This is the part that mattered. Once the app genuinely stops early, the pictures you chose not to buy are missing from disk — and its own final check treats missing files as a failure. So a working Pause would have punished you for pressing it. It now settles as paused, keeps everything already bought, and Resume buys only what is genuinely still missing.
- **One refused clip no longer ends an episode's whole motion pass.** "Make every scene move" had no safety net around each scene, so a failure on scene 3 of 50 threw away the other 47 — never attempted, never reported. Each scene is now handled on its own and the run continues, naming what failed. Cancel, Pause, and running out of credits still stop everything, because carrying on would be wrong for each.
- **Motion batches stop discarding their own crash-recovery notes.** They were being overwritten at the end of every run. It never cost money — the retry identity is read from disk — but recovery after a crash was working from nothing.

---

## v1.4.34 — 2026-08-23

- **Image Pool now waits when your machines are busy. That is all eight generators — the whole set is protected.**
- **This last one was the easiest to lose work in without noticing.** A pool has no script and no scene list to check against, so asking for 40 images and quietly getting 31 has nothing to contradict it. It now waits 30 seconds, then 2 minutes, then 5, and says plainly that nothing was charged.
- **Nothing else about the run changed.** An image that runs out of waits fails exactly as before and the rest of the pool carries on. Running out of credits still stops everything immediately, with no waiting.
- Behind the scenes, the checklist that tracked which generators still had this fault is now closed. In its place is a stricter rule: any new generator that talks to your machines must handle this from the day it is written, or the tests fail.

---

## v1.4.33 — 2026-08-23

- **Contextual Cues now waits when your machines are busy** instead of throwing away the episode's whole batch of proposed labels. Seven of eight generators protected; one left.
- **This one already knew how to wait — for a different problem.** It had a 15-second retry for the provider being briefly overloaded. A busy fleet is not that: GenStudio has already spent fifteen minutes looking for a free machine before it gives up, so a 15-second retry just rejoins the same queue. The two now have separate waits and separate budgets, and the old one behaves exactly as it did before.
- Cancel and Pause are honoured within seconds during a wait, and every wait says plainly that nothing was charged.

---

## v1.4.32 — 2026-08-23

- **"Retry all" is here, next to "Repair all".** Two buttons you press yourself. It never repairs for you and it never retries what it cannot vouch for.
- **What it will and will not re-run.** Anything with no repair option (most job types, subtitles included) is retried straight away — a repair could never have helped it. Anything you repaired that still came up short is retried, because the shortfall is proven. Anything you never repaired, or whose repair failed, is **left alone and listed**, because your machines may already have finished it and you would pay a second time. That is the exact trap that got a combined button removed once before.
- **A number the app knew and never told you.** Repairing pictures reports how many are still missing, and the Jobs page had been dropping it — you saw a plain "repaired" tick whether four were missing or none. It now shows the real count, which is also what makes Retry all able to tell "proved missing" from "never checked".
- Everything goes through the normal queue, so a big Retry all is paced rather than fired all at once.

---

## v1.4.31 — 2026-08-23

- **Motion Review now waits when your machines are busy** instead of throwing the clip away. Six of eight generators protected.
- **This one was the worst of the set.** The "make every scene move" run had no safety net around each scene, so a single busy moment on scene 3 of 50 killed the whole episode's motion pass — not one clip, all of them. Now it waits 30 seconds, then 2 minutes, then 5, and says in plain words that nothing was charged.
- **Video is the most expensive thing the app buys**, so it still refuses to re-ask about anything except the one failure that provably cost nothing. Cancel and Pause are honoured within seconds during a wait, not at the end of it.

---

## v1.4.30 — 2026-08-23

- **Scene Images now waits when your machines are busy** instead of dropping the picture and asking you to run it again. Five of eight generators protected.
- **It also closed a fault that was harmless until today.** Two copies of the same internal record disagreed slightly — and nothing read the second one, so it never mattered. Adding a retry makes something read it, and the app would then have asked for the same picture under two different names. That is exactly how you end up paying twice for one image. It was found and fixed rather than built on top of.
- **Two things noted, not changed.** A waiting scene here does not show "waiting" the way Scene Review now does — it shows a log line and a percentage that stops moving, which could read as a hang. And pressing Pause mid-picture still does not take effect, only during the new waiting. Both change behaviour for every scene, so neither belongs in a retry fix.

---

## v1.4.29 — 2026-08-22

- **Your publishing cadence was saving but never loading. Fixed.** The panel wrote your days, time and the auto-schedule tick correctly — and then showed you an empty form every time you opened it, because the app was only allowed to hand back a fixed list of settings and these two were not on it. Worse than merely annoying: if you had pressed Save on that blank form for any reason, it would have wiped your real cadence and quietly switched automatic scheduling off. You can now see what is actually set.
- **Scene Review waits when your machines are busy** instead of throwing the picture away and asking you to run it again. Same as subtitles, voice and images. Three tries — 30 seconds, 2 minutes, 5 minutes — and the log says plainly that nothing was charged.
- **A safety feature would have cancelled that fix, and nearly did.** The app pauses a job when nothing finishes for ten minutes. A full render farm is exactly what causes nothing to finish — so it would have paused the job and killed the waiting. The pause is now held off only for as long as a scene is genuinely waiting, and never longer.
- **A waiting scene now says so.** While it waits you see "waiting, retry at…" rather than a spinner that looks like a hang.
- Four of eight generators protected — subtitles, voice, images and Scene Review. The remaining four are still named in the app's own tests.

---

## v1.4.28 — 2026-08-22

- **The two throughput numbers now have a screen. Until now they had none.** Settings → This Mac → *How much runs at once*. You asked where to change them and the honest answer was nowhere: both had been moved out of the program's code into a settings file the app reads when it starts, with no page and no way to reach them. That is half a fix — a number you cannot get to is barely better than one written into the code.
- **Two boxes.** *Episodes transcribing at once* (2) — each episode still transcribes all its chapters together, this is how many episodes start together. *Writing jobs at once* (8) — ideas, outlines, chapters, metadata, image prompts and scene plans share this one. Both show their standard value and accept 1 to 50.
- **Saving takes effect immediately, not at the next restart.** The queue is updated as well as the file. A setting that quietly does nothing until you restart is one you stop trusting.
- **They live on This Mac rather than on a channel** because they describe what this machine's fleet can absorb, not anything about a particular show.

---

## v1.4.27 — 2026-08-22

- **Writing jobs now run 8 at a time instead of 50.** Ideas, outlines, chapters, metadata, image prompts and scene plans all shared one queue that allowed fifty at once. When a lot were started together they waited a **median of 15 minutes**, and sometimes twenty. Eight is the number: your chat work has already run eight at once successfully, GenStudio itself only accepts twelve so anything above that just hides the queue rather than shortening it, and fifty is what produced the long waits.
- **It is a setting.** Raise it as you add machines.
- **This was the last unlimited queue.** Every other kind of job already ran one at a time; writing and subtitles were the only two that could stampede, and both are now bounded.
- **The thing you were worried about was never happening.** A slow generator does not block a fast one — each kind of work has its own queue. Over one week, image generation and transcription were running at the same moment **15,257 times**, image and voice 6,038, chat and image 5,301. Scene Review being slow only ever slows Scene Review. Nothing needed building; it is now locked in by a test so it cannot quietly stop being true.
- **One trade worth knowing.** Those six kinds of writing share a single queue. At fifty that never mattered; at eight, a burst of slow scene plans can delay quick metadata. If that ever bites, the answer is a separate limit for each kind — never a bigger shared number, which would only bring the long waits back. That instruction is written into the code.

---

## v1.4.26 — 2026-08-22

- **Image generation now waits when your machines are busy, instead of throwing the picture away.** This is the biggest one of the set: image generation is the busiest thing the app does — 7,419 jobs on your fleet in the last 30 days, five times more than the transcription that failed on you today. It had simply never met a burst. It would have.
- **It reuses the waiting that was already there.** Images already knew how to wait when no picture provider would take the work; it just didn't recognise "your own machines are full" as the same kind of problem. Two separate waiting schedules are kept apart on purpose, so changing one can never break the other.
- **A crash mid-wait cannot buy you a second picture.** Each retry is labelled from what already happened rather than made up fresh, so if the app dies while waiting, the next run asks for the same picture again instead of paying for another one.
- **Found and deliberately not fixed:** pausing does not really work anywhere in the image generator — it only ever checks for cancel. Pause now works inside the new waiting, but making it work across a whole image batch is a separate change with its own consequences, so it was left alone and written down rather than slipped in.
- Three of eight generators now protected — subtitles, voice and images. The remaining five are still named in the app's own tests so they cannot be quietly forgotten.

---

## v1.4.25 — 2026-08-22

- **You asked what else has this bug. Here is the honest answer: eight generators could lose work when your machines are busy, and until yesterday none of them handled it.** Subtitles was fixed yesterday because you happened to run thirty episodes at once and saw it. Audio is fixed today. Six remain, and they are now written down by name inside the app's own tests rather than left as something I might remember.
- **It had already happened to your voice generation and nobody noticed.** Five voice jobs were refused for a busy fleet on 13–15 August and their sections were silently dropped. That is the shape of this whole problem: the only symptom is a missing piece that a later retry quietly fills in, so it looks like ordinary flakiness and never gets looked at.
- **Voice generation now waits and asks again**, using the retry machinery it already had for a different kind of busy — a provider declining, which it has handled since 7 August. The gap was that a provider saying no and your own fleet being full are different things, and only the first was covered.
- **The remaining six are tracked, not forgotten.** Scene Review, Motion Review, Images, Scene Images, Contextual Cues and Image Pool. A test names them, and a new generator that handles these failures without either fixing or declaring the gap will fail the build. The question "what about the others?" can no longer go quietly stale.
- **Nothing here retries anything that might have cost you money.** Only the two codes that mean GenStudio never gave the job to a machine, where the whole reservation is returned. If a job ever reports that while still having taken credits, it stops rather than resubmits.

---

## v1.4.24 — 2026-08-22

- **A chapter turned away because every machine was busy now waits and asks again.** This is the other half of yesterday's flood: of 353 transcriptions, 122 were refused for want of a free machine and simply dropped, leaving you to chase each one by hand. They now wait and retry — three times, after 30 seconds, 2 minutes and 5 minutes.
- **It is free to retry, and that is the only reason it happens automatically.** GenStudio refuses these before any machine has touched the job, and gives the whole reservation back — its own words are *"the job never reached a worker, so there is nothing to settle."* So trying again is a fresh charge for work that never happened, never a second charge for the same work.
- **It checks the money, not just the reason.** If a job somehow came back saying "no machine free" while still having taken credits, it is not retried — because that would mean a provider had been paid and might have done the work. When something stops matching what it promised, the right move is to stop, not to try again.
- **Only a busy fleet is retried.** A genuine fault — unreadable audio, a provider refusing the request — is reported straight away as before. Retrying those would turn a clear error into ten minutes of silence followed by the same clear error.
- **Cancelling still means cancelling.** A chapter you cancel is never resubmitted.
- **The waits are minutes, not seconds, on purpose.** GenStudio already waits a full fifteen minutes for a free machine before giving up, so anything reaching this point means the fleet is genuinely full. Retrying two seconds later would just rejoin the same queue.

---

## v1.4.23 — 2026-08-22

- **Thirty episodes at once flooded your own fleet, and a third of the work was refused.** You started thirty transcriptions together and watched many fail. Checking GenStudio afterwards: **231 transcriptions succeeded and 122 were refused** because no machine was free, with 103 running at the peak. Every job started in the same second and the refusals landed in a three-minute window as the fleet filled up.
- **You were right about the fix and the cause was the other way round.** The chapters inside an episode were *already* running side by side, ten at a time — that is what makes a single episode fast, and it is exactly what you asked for. What was unlimited was **episodes**: the queue let fifty start at once, so thirty episodes of about eleven chapters each arrived as one wave of roughly 350 requests.
- **Episodes now queue; chapters still run side by side.** Two episodes at a time by default, each still transcribing all its chapters simultaneously. That is about twenty requests in flight instead of a hundred — and a single episode takes exactly as long as it did before, because the part that decides that has not changed.
- **The number is yours.** It sits in your app settings and can go from 1 to 50. If your fleet grows, raise it.
- **The switch existed all along and nothing could reach it.** The queue has had a setting for this since it was written, and no part of the app outside a test ever called it — so it sat at fifty, unreachable. It is now read when Story Studio starts.
- **Still to do, and it would have saved most of those 122:** when a chapter is refused because every machine is busy, it is given up on rather than waited for and retried. That is a separate change to the part that handles billing, so it is not in this release.

---

## v1.4.22 — 2026-08-22

- **The caption check was showing you an old answer, and that nearly cost you an hour.** You opened it on EP0051, saw captions that did not match the narration underneath them, and were about to re-transcribe. Your transcript was fine. What you were looking at was a check that had run before your last re-stitch — the subtitle files were rewritten at 14:23 and 14:32, after the run whose results were still on screen. Running it fresh gave captions matching the file exactly.
- **It now knows when the file has moved on.** Each check records which version of the subtitle file it looked at. Come back to the page after re-stitching and it greys the frames out, says plainly that they describe an older version, and offers to run again — instead of quietly looking authoritative.
- **A confirmation given on stale evidence is withdrawn.** If you had already ticked "these are right", that tick is undone when the file changes, so a render can never be waved through on a check that no longer applies.
- **The frames themselves were never wrong.** Nothing was miscounting or mistimed — the check simply had no way to know which version of your subtitles it had read, so it kept answering a question about a file that no longer existed in that form. That gap had been there since the caption check first shipped; adding the audio clips is what finally made it visible.

---

## v1.4.21 — 2026-08-22

- **Your upload scheduling now has tests. Nothing was wrong with it.** You said it plainly — *"i've schedules and upload for a while. no issues whatsoever"* — and that matches what I found. The code was correct; it simply had nothing protecting it. Every failure I hit while writing these tests was my own test setup, never your scheduling.
- **What is now locked down** is the part that decides where your next episode lands: a video that already went live never pushes new episodes further out, the newest booked date is the one that counts, an episode being rescheduled is not pushed past its own date, and a video that is already public on YouTube is never given a new publish time. That last one is your rule, and it is now impossible to lose quietly.
- **One awkward date format is pinned too.** YouTube sometimes returns times without fractions of a second, and an older version compared them as plain text and missed them — which could book two videos into the same slot. That is now checked.
- **The duplicate I warned you about is gone.** Last night's scheduling shared its calendar maths but kept its own copy of one small piece, because touching untested code that sets your real publish dates was the greater risk. With tests in place that risk is gone, so the three copies — preview, apply, and automatic scheduling — are now one.
- **The reminder I left myself worked.** I had added a test that would deliberately fail the moment anyone covered that route, telling whoever saw it to remove the duplicate rather than let a temporary shortcut become permanent. It fired today, named the file that changed the situation, and has been retired along with the duplication it was watching.

---

## v1.4.20 — 2026-08-22

- **A finished episode can now take its own publish slot.** Turn on *Give each episode a publish time as soon as it finishes rendering* in Channel Identity and every render lands in your schedule by itself — no picking it out of the upload list, no pressing apply. **Nothing is sent to YouTube.** The episode gets its date and waits; you still press upload, which is what you asked for.
- **Your publishing rhythm now belongs to the channel, not to Upload Center.** Set the days, the time and the interval in Channel Identity, and it tells you how many episodes a month that works out to. An upload plan can only exist once a YouTube account is connected — one of your channels existed for months before its account did — so the rhythm lives on the channel and becomes the plan the moment you connect.
- **Your existing channels are untouched.** All eleven already have plans, and a plan always wins: the cadence screen says so plainly and points you to Upload Center. Re-authorising an expired token will never reset a schedule you have tuned.
- **Nothing that is already live gets moved.** An episode that is public on YouTube, or that already has a publish time, is left exactly as it is. That was your condition, and it was already the rule the manual apply followed since v1.0.46.
- **One thing I checked and did not change:** your schedule never needed its start date bumped. It already walks past the last slot you claimed, so each new episode lands after the previous one automatically.
- **On the duplicated logic.** The scheduling code shares all the calendar maths with the manual apply, but copies one small piece — the scan that finds the last claimed slot. That is deliberate: the apply route you rely on has no tests at all, so refactoring it would risk your real upload dates with nothing to catch a mistake. Instead there is a test that fails, naming the difference, if the two copies ever stop agreeing — and another that fails the day somebody adds tests to that route, so the shortcut gets revisited instead of outliving its reason.

---

## v1.4.19 — 2026-08-22

- **One-click renders were quietly dropping three of your settings.** You remembered this and you were right. A render started from the Pipeline used a hand-written copy of what the Video Assembly page sends, and three things had never been added to that copy — so the same episode rendered two different ways depending on which button you pressed, with nothing said either way.
- **Scene effects were being lost entirely.** Every per-scene effect you picked was saved in your preset and thrown away by a one-click render. This has been true since scene effects shipped.
- **Aspect ratio was ignored, so a one-click Short was impossible.** Batch renders were always widescreen no matter what the channel asked for — the vertical support added a few days ago never reached the Pipeline at all.
- **"Hide captions during the intro" was ignored**, so a one-click render burned captions over your branded opening even when you had turned that off.
- **One thing I checked and left alone:** the scene-pool setting also isn't copied across, but the renderer sets it itself, so it changes nothing. Not padding the list with it.
- **The real fix is that this cannot happen again quietly.** There is now a test that reads the page's own code, works out every setting it can send, and fails if the Pipeline can't send the same one — naming the missing setting. This is the fourth time a setting has gone missing this way; it is the first time anything would have noticed.

---

## v1.4.18 — 2026-08-22

- **You can now change a channel's episode shape yourself.** Project Settings → Channel Identity → Project formula has an **Episode shape** panel: usual length and the shortest and longest allowed, usual chapter count and its range, reading pace, whether chapters stand alone, and the title voice. You set these numbers on 21 formulas yesterday and had no way to change them afterwards without editing files. Your words: *"series formula editing ui. do it please then, i thought you already did it."* Fair — I said 1.4.16 would wire it and it did not.
- **It shows you what the numbers mean before you save.** Change the length or the pace and it tells you roughly how many words that is per episode and per chapter, so a "45-minute episode at 155 words a minute" is a real amount of writing rather than two abstract numbers.
- **A built-in formula is never overwritten.** The first change makes that channel its own copy, and every other channel using the same formula is untouched. The panel says so before you save, and the confirmation says which happened.
- **Numbers that contradict each other are refused, with a reason.** A usual length of 90 minutes inside a 40–50 range is rejected rather than quietly clamped — that exact shape, a default sitting outside its own range, is what made a two-hour sleep story impossible to request before yesterday.
- **This was the part that could have gone badly.** The existing "save formula" path checks documents against a description that has never included chapters, length, pace, narrator voices, title rules or the chapter-by-chapter plan. Saving a real formula through it would have thrown all of those away — editing Sleep Stories would have deleted its ten narrator voices. The new editor changes only the fields you touched and carries everything else across untouched, and there is now a test that edits the Hidden Mechanics formula and checks its nine named chapters and ten voices are still there afterwards.

---

## v1.4.17 — 2026-08-22

- **The caption check now lets you hear the narration, not just read it.** Each of the three frames has a player under it holding exactly the words on that frame, cut from the narration the render will use. You said it plainly: *"this subtitle render is a good idea but there's nothing for me to hear so I can compare it at all."* You were right, and it undercut the whole point — reading a caption proves the words exist, it cannot prove they are the words being spoken there. The fault this check was built to catch was one episode's captions burned onto another, and both episodes' captions read perfectly well on their own.
- **The clip covers the caption, start to finish**, with three-quarters of a second either side so it does not sound chopped. A very short caption still gets two seconds so you can recognise it; a very long one is capped at twenty so a check never becomes a download.
- **A clip that cannot be cut says so instead of pretending.** ffmpeg does not fail when asked for audio past the end of a file — it writes an empty one and reports success. A valid clip is about 67 kB; that empty one is 358 bytes. Anything that small is thrown away and the frame says "no narration to play", because a silent player looks like missing narration rather than a clip that was never made.
- Frames written automatically beside a finished video are unchanged and still silent — those are a record of what was rendered, not something to listen to, and cutting clips for them would add time to every render for nobody.

---

## v1.4.16 — 2026-08-21

- **Every one of your 21 channels now has its own runtime, chapter count and speaking pace.** Until today only two of them did. The other nineteen fell through to one shared setting — five chapters, eight minutes, 160 words a minute — and, more importantly, to a shared **maximum of twenty minutes**. A sleep story is now 135 minutes by default and may run to 150; a prayer is 18; Hidden Mechanics is 45; the nature channels and the explainers sit around 25. The numbers are yours: you gave them on 2026-08-21 and they are written in each channel's own file, not in the program.
- **Speaking pace now follows delivery instead of one number for everybody.** 160 words a minute is a news-reading pace and suited almost none of your channels. Sleep and mindfulness now sit at 115, prayer at 120, preaching and philosophy at 145, the history and nature channels at 150–155, business at 160, the listicle voice at 165 and hustle at 170. Slower channels get more words on the page for the same runtime, faster ones fewer, so a "25-minute episode" is actually 25 minutes on each of them.
- **Thirteen channels were being told to write sleep-story titles.** Prayer, preaching, psychology, philosophy, devotional, mindfulness, motivation, history narration, the POV channel and all four nature channels had no title voice of their own, so the program fell back to a line written into the code: *"Hook-y, curiosity-driven, calm/dreamlike tone."* A fix in v1.0.69 was meant to prevent exactly this, but it only worked for channels that stated their own voice, and these thirteen did not. All 21 now do, in their own words.
- **That tone is no longer written into the program.** It is a setting on the channel and on the format, so you can change it without anybody touching code. What remains in the program is a deliberately plain last-resort line for a channel you add later and have not given a voice yet.
- **Hidden Mechanics keeps its nine parts.** Its runtime moved from 36 to 45 minutes as you asked, but the nine chapters are a named sequence — from "The familiar story" to "The changed world" — so the extra time became longer chapters rather than more of them.
- **Deep Time was left exactly as it was**, at 150 minutes and 120 words a minute. It already had considered settings, and cutting it would have halved your longest format on the strength of a bad reading on my part.
- **Your eleven sellable content packs carry the same numbers.** They are copies of these same channels, and they had no runtime at all before today, so anybody who bought one got the twenty-minute cap. Say the word if you would rather a pack differ from your own channel.

---

## v1.4.15 — 2026-08-21

- **You can now choose the shape of a video, not just its size.** Video Assembly has a new Aspect Ratio box beside Resolution, offering widescreen 16:9, vertical 9:16 for Shorts and Reels, square 1:1, 4:5 for Instagram and 21:9 ultrawide. Until today every video Story Studio assembled on this Mac was widescreen and there was no way to make a vertical one, even though the picture side has offered vertical for a long time — so a channel could generate tall pictures and then get them squeezed into a wide frame with black bars down both sides, with nothing said about it.
- **Each channel proposes its own shape.** A channel's format already states which shape its pictures should be, and the render now starts from that answer rather than assuming widescreen. You can still change it for any single render, and a saved export preset still wins, exactly as with every other setting on that page. If the format asks for something the box does not list, that shape is added to the box for you.
- **Nothing about the shape is fixed in the program.** The renderer works out the frame from the shape and the resolution rather than looking up a list of allowed sizes, so a shape nobody has asked for yet already works. "1080p" now means the narrow side of the picture is 1080 pixels — 1920×1080 lying down, 1080×1920 standing up — and every widescreen video comes out at exactly the size it always did.
- **Everything drawn on top follows the frame.** Title cards, chapter titles and the small on-screen labels used to be sized against the height of the picture, which is the same thing as the width on a wide video and quite wrong on a tall one — a title would have come out nearly twice too big and run off both sides. They are now sized against the narrow side instead, which changes nothing for widescreen and makes vertical correct.
- **A gap in the title card that was already wrong is fixed too.** The space between a title and its subtitle was a fixed 40 pixels, decided when everything was 1080p. On a 4K video the lettering tripled in size and the gap did not, so the two lines nearly touched. The gap now grows with the lettering.
- **Story Studio tells you before it renders if your pictures are the wrong shape.** Run the caption check and it now says, in plain words, that your scene images are (for example) 16:9 while the render is 9:16, and that they will end up inside large black bars. The same warning appears in the render's own log. It warns rather than refusing, because sometimes bars are exactly what you want — but you find out first rather than by watching the finished video.
- **The caption check now draws its three frames at the real shape**, and fits the picture into them the way the render actually does. It used to fill the frame by cropping, which happened to look identical while everything was widescreen and would have hidden the black bars completely on a vertical render — the one thing worth previewing.
- **The effect, motion, transition and caption-style previews follow the shape too.** A corner logo, a lower third or a caption previewed in a wide box tells you nothing about where it lands in a tall video.
- **Cinematic bars step aside on a tall video and say so.** The 2.35:1 letterbox effect is a widescreen idea; applied to a vertical frame the arithmetic still works and covers three-quarters of the picture in black. It is now skipped, with a line in the log explaining why, instead of quietly ruining the render.
- Also fixed two things found on the way: burned-in captions in the fallback path were told the video was always 1920×1080, which would have skewed them on any other shape; and two different requests inside Story Studio shared one name, so the program had been quietly treating them as a single thing for some time. They are two names now.

---

## v1.4.14 — 2026-08-21

- **Chased down a test failure that turned out not to be Story Studio's fault at all.** One test failed roughly once in every two hundred runs, and the way it failed looked alarming: it read as if the episode list had briefly forgotten an episode that had just been created. On this app that would be the channel list dropping one of your episodes, so it was worth being sure. It was not that. The test's temporary web server was leaving one door unlocked, and now and then another program on the same Mac — Tailscale — quietly took over the same door number and answered the test's questions in Story Studio's place, always with "not allowed". Nothing reached Story Studio, and nothing in the episode list was ever wrong.
- **The door is now locked to the exact address the test knocks on**, so no other program can take it over — proved by watching a stand-in try and be refused. This covers every backend test, and a new test raises the alarm if the protection is ever dropped.
- **The two tests that failed this way now say what actually went wrong.** They used to fall over three lines later on an unrelated-looking symptom, which is what made a five-minute question into a long one.
- Nothing in the app itself changed.

---

## v1.4.13 — 2026-08-20

- **Six messages sent you to tabs that no longer exist.** Four told you to fix an API key in "Settings → API Keys", a tab that was folded into "This Mac" some time ago; they now say This Mac. The wizard that builds a format from a sample said to switch projects to it from "Project Settings → Format", which folded into Channel Identity. And the Image Pool page called the next step the "🎞 Scenes" tab in four places, while the app's own navigation calls it Video Assembly — the icon was right and the word was wrong, which reads as precise and is not.
- **Three more credit figures now say "credits".** The Jobs page tooltip said "Balance after: 4,250", the Credits page's own jobs table had columns headed just Reserved, Settled and Returned, and the motion clip picker read "45 credits (minimum 30, price v3)" — where "v3" is a price-list version sitting immediately after the word "price", in a picker you use while spending money. It now reads "minimum 30 credits, price list v3".
- **A failed load no longer strands you on a form you cannot finish.** If the Series Formula, Production Path or Topic Pack list failed to load — a momentary blip is enough — you got an error and nothing else, and the only way forward was to leave the page and come back. Each now has a "Try again" button that reloads just that list where you are.
- **A long Library path no longer pushes the welcome screen sideways.** A path with no spaces in it could not wrap, so in a narrow window the whole first screen scrolled left and right — on the one screen you have to complete on a new Mac. Fixed there and on the Audio Assembly page's source-folder line, which has the same shape.
- Also removed a leftover key-entry component that nothing had used since the API Keys tab was retired.

---

## v1.4.12 — 2026-08-20

- **Story Studio no longer puts emoji into the text it writes for you.** Titles, descriptions, tags, the episode ideas it generates, playlist descriptions and the labels burned onto the screen all come out as plain text now. A title that used to arrive as "🔥 The Forgotten Helots of Sparta — What the Temple Dig Really Found 🏛️" arrives as "The Forgotten Helots of Sparta — What the Temple Dig Really Found".
- **Emoji you typed yourself are never touched.** This is the important half. If your script, your title, your channel's own instructions or your notes contain an emoji, that is your decision and everything written for that episode is left exactly as it came. The prayer channel is the clearest case: its own rules deliberately ask for exactly one 🙏 in the description, and that 🙏 still arrives, because the instruction asking for it is part of what you wrote.
- **A description you have already edited is never rewritten.** Cleaning happens the moment the text arrives from the model, before it is merged with anything of yours. Once your paragraphs and the automatic chapter and source blocks are in one description, the two cannot be told apart, so nothing touches it there.
- **The models are asked first, not just corrected afterwards.** Every prompt that writes text you publish now says plainly not to use emoji. Cleaning the result is only the net underneath — a net alone would fight the model on every single generation and teach it nothing.
- **Removal is whole-character, which is the point.** One emoji is often several pieces joined together — a family, a skin tone, a flag, a keycap — and removing a piece leaves broken text. That is exactly the bug that made DeepSeek look unreliable last week. Emoji are removed as whole characters or not at all, and where a character sits alone it is dropped rather than half-kept. Ordinary symbols like ™ and © are left alone; they are punctuation, not decoration.
- **You can turn it back on.** Settings → This Mac → "Emoji in generated text" has a single switch. It starts off, which is what you asked for, and turning it on stops both the instruction and the cleaning at once so the app never says one thing and does another.
- **Story Studio's own buttons and menus keep their emoji.** The bin on "Hidden channels", the box on "Move this project", the tick on a finished folder — that is the app talking to you, not something going out under your name.
- **One prompt was arguing with itself and has been settled.** The playlist description generator carried its own rule — "no excessive emoji (one max, only if it fits the channel voice)" — which is the opposite of what you asked for. It now follows the same rule as everything else. Comment replies keep their existing behaviour of matching the viewer: if a viewer wrote with emoji, a reply may too.
- **Image prompts are told never to contain an emoji**, because an image model treats one as a thing to depict and draws it into the picture.
- Nothing you have already generated is changed, and subtitles and the alerts Story Studio sends you are unaffected — neither is written by a model.

---

## v1.4.11 — 2026-08-20

- **Story Studio no longer tells every channel it is a history documentary.** Before writing any image prompt, the app attached a paragraph of guidance that opened with "This is a history and documentary channel", and told the model to render the hardest subjects as engravings, woodcuts, frescoes and manuscript plates. Every channel got it, every time — fungi, plants, insects, motivation, prayer, preaching and business economics included. All of them were being told what they were and what they should look like by a helper whose job is neither.
- **The useful half is kept.** That paragraph exists because image providers refuse ordinary subject matter: aftermath instead of the act, suffering shown through posture and surroundings rather than injury, no explicit ages on figures, medicine shown as the room and the instruments. That is craft, it works, and it stays — reworded so it applies to any subject rather than only to history. What is gone is the claim about what kind of channel this is, and the woodcut steer. It now ends by saying, in as many words, to follow the channel's own visual style for how the image should look.
- **If a channel does want the period-illustration look**, put it in that channel's visual style, where you can edit it and where it applies to that channel alone.
- **Negative prompts are gone.** You said you never use them, so nothing sends one now. Two separate things were removed. The first was a "Negative:" line shown in each channel's niche details in Settings — you could read it, it was written into six of the built-in niches, and no part of image generation had ever used it. A setting you can see that does nothing is worse than no setting.
- **The second banned people from your own scenes.** Continuity videos classify each scene as character, event, environment, map or artifact. Every scene that was not a character scene had a hidden list attached — `person, people, child, boy, kid, human figure, character, portrait` — meaning a battle, a market or a coronation was asked for with every human being banned from the frame. Its 2026 intent was narrower: keep the anchored guide character from wandering into a cutaway. The part that actually does that — dropping the guide's description and reference images from those scenes — is untouched and still works.
- **What you will notice from this: nothing, and that is worth knowing.** In tracing it we found the negative prompt was never reaching the image generator at all. It was assembled, logged, handed over, and then dropped before the request was built, because the image service takes only the fields it names and that is not one of them. It has been dead for some time. Your images will render exactly as before.
- **The job log no longer claims otherwise.** It used to print "Prompt layer: … + negative prompt", telling you something had been applied when nothing had been sent. It now names only the layers that are really in the prompt.
- Your saved settings are untouched — a negative prompt already stored against a channel stays on disk, it is simply not used. Visual styles are unchanged.

---

## v1.4.10 — 2026-08-20

- **Archive uploaded videos could have moved a video you never uploaded into another channel's folder and deleted the original.** Nothing had happened yet — the button had not been run, and there is no damage to undo. But had it run as shipped, it would have taken finished masters you never published, filed them under the wrong channel, and removed them from where they belonged. That is fixed, and Archive is safe to use.
- **What was wrong.** Archive only moves a video it can prove you uploaded, and it checked that proof by episode number alone — it looked for `EP0042` and asked "is EP0042 uploaded?". But an episode number is only unique inside one channel. Seven of your eleven channels number their episodes `EP`, 302 episode numbers exist on more than one channel, and `EP0001` through `EP0006` exist on seven each. So one channel's `EP0042`, which you have not published, was proven "uploaded" by a second channel's `EP0042`, which you have. The first channel's master would have been copied into the second channel's archive folder, checked byte-for-byte against itself, found perfect, and then deleted from the first.
- **The careful part was working the whole time, which is what made it dangerous.** Archive copies first, verifies the copy at its destination by size and checksum, and only then removes the original — so a half-finished copy is never mistaken for a good one. All of that was correct. It was simply guarding the wrong file: the video was verified into the wrong place, perfectly.
- **Every video is now tied to the channel folder it actually sits in.** A file under a channel's folder is checked against that channel's uploads and nothing else. If a video's channel cannot be worked out from where it sits — no channel folder anywhere in its path, or a folder that two channels could claim — it is left alone and listed with the reason. There is no falling back to matching by number: a video whose channel is unclear is exactly the one that must not be moved.
- **The list you approve is now the list that runs.** Pressing "Move them" used to re-scan the folder and act on whatever it found the second time, so anything arriving between reading the bill and agreeing to it joined the move unannounced. Only the videos you were shown are moved now, and anything that turned up since is reported instead.
- **The confirmation box now says what is actually true.** It used to describe every skipped file as "not confirmed uploaded", including the dozen-odd files in your TerenceGaming folder that have no episode number at all and were never candidates. It now breaks the skipped pile down by the real reason.
- **Archiving can no longer invent an episode folder.** When Archive notes where a video went, it writes that note into the episode's existing folder — and it used to create the folder when it was missing, which alongside the bug above meant conjuring an episode on the wrong channel as a side effect. It now refuses, finishes the move, and tells you the folder is missing.
- **Why this shipped: the tests could not have caught it.** Every test for this feature used a single channel, so "two channels sharing an episode number" was not merely untested — it could not be written down. The tests now cover several channels, and the new one was run against the old code first to confirm it fails there.

---

## v1.4.9 — 2026-08-20

- **The "flaky DeepSeek" failures were never DeepSeek.** Metadata and other generations have been dying intermittently for days with a message about a character that "can't be encoded" — and because retrying with a different model usually worked, it looked like one provider being unreliable. It was not. The bug was in Story Studio, it could hit any model, and switching models only changed the odds. Nothing was wrong with DeepSeek V4 Flash; there is no reason to keep avoiding it.
- **What was actually happening.** Before sending your story to a model, Story Studio trims it to fit — the first 1,500 characters of the narration, the first 500 of the description, and so on. Emoji are stored internally as two joined pieces, and the trim was counting pieces rather than characters. Whenever the cut-off point landed in the middle of an emoji, it kept half of one — and half an emoji is not valid text, so GenStudio refused the request before generating anything. That refusal was correct. The broken text was ours.
- **That is also why it came and went.** Every regeneration produces slightly different wording, so the emoji lands in a different spot and the cut misses it. Same episode, same model, works on the third try — which is exactly what made it look like a provider having a bad day.
- **Trimming now stops before an emoji instead of through it.** If a cut would land inside one, the whole emoji is dropped and the text stays valid. This was fixed everywhere text is trimmed on its way out, not only in metadata: story context for scene plans and image prompts, your Series Formula instructions, continuity directives and style bibles, on-screen cue labels, subtitle previews, and YouTube titles, descriptions and tags.
- **And a second guard behind it.** Models occasionally produce a broken half-character on their own, which no trimming rule can prevent. Every request Story Studio sends to GenStudio is now checked and repaired on the way out, so an invalid character can no longer reach it. The same check runs on what gets sent to YouTube.
- Nothing you have already generated is affected, and no request that previously worked behaves differently. The only change is at the trim point, and only when an emoji sits on it.

---

## v1.4.8 — 2026-08-19

- **"Got it" on the two upgrade notes now means forever.** The notes about custom folder labels and about finished videos moving into your Library came straight back every time the app started, no matter how often you closed them. Dismissing one wrote nothing down: at every launch the app rebuilt both notes by re-checking the same things that were true when it first wrote them, and those things are still true — so the notes reappeared seconds after you got rid of them. Story Studio now remembers that you have read a note, and a note you have closed is never shown again. Not after a restart, not after a hundred, and not if you go back to an older version and come forward again.
- **Nothing of yours was deleted to achieve that.** The obvious shortcut — throw away the old folder settings so the notes have nothing left to report — would have taken your `named-roots.json` and your existing exports folder setting with it, and both are still read for good reasons. Closing a message says something about the message, not about your files, so only the message is forgotten.
- **If closing a note ever fails, it now says so.** Before, the note disappeared from the screen whether or not the app managed to record it, then quietly returned later — which is a large part of what made this baffling. The note now stays put until it has actually been saved, and tells you if it could not be.

---

## v1.4.7 — 2026-08-19

- **Credit figures on the Jobs page now say "credits".** The GenStudio batch line read `50 items · 450 on hold`, where the 450 is credits and the 50 is items — so it looked like 450 items were on hold. Every credit figure on that page now carries its unit.
- **And they all say it the same way.** The same page was spelling one fact three different ways: the batch summary printed `450 charged` with no unit, the per-job line printed `charged 450` with no unit, and the held figure alone printed `on hold 450 credits` with one. All twelve places now read `450 credits charged`, `450 credits on hold`, `450 credits returned`.
- The numbers themselves were correct — nothing was misreported, only under-explained. The capacity figures beside them (lanes, queued, submissions per minute, waiting locally) already name what they count and are unchanged.

---

## v1.4.6 — 2026-08-19

- **Copying your channels onto a new Mac and pointing Story Studio at them works — checked properly this time.** Put your channel folders wherever you like, launch the app, choose that folder on the welcome screen, and every channel appears straight away. Folders with spaces, apostrophes and Khmer names all come through; anything in there that is not a channel is ignored and left alone.
- **A Library that goes missing is no longer quietly recreated as an empty folder.** This was the serious one. If your Library sat on a drive that was not plugged in, the next page load created the folder again — empty — so the clear "your Library is not available, here is where I looked" turned into a silent "you have no channels". On an external drive it was worse: it could leave a folder standing where the drive should mount, and stop the real drive appearing there. It now refuses, and says so.
- **If your Library goes missing you can get back.** Before, you could not: with no Library there are no channels, and the only place to change the location lived inside a channel's settings. The error screen now offers **Choose a different folder…**, and the welcome screen lets you re-point at the new location without copying anything.
- **Setting a Library in a development build actually works now.** It was being written to one file and read from another, so it saved and did nothing. Only affected running from source, never the installed app.
- **The release-notes window no longer covers the welcome screen on a brand-new Mac.** It was appearing before you had chosen anything, on top of the one screen you have to complete. It waits until you are set up.
- **Choosing your Downloads or Desktop folder itself now says it will be untidy** — three Story Studio folders loose among everything else in there — while still letting you do it. A folder inside is usually neater, but it is your Mac.
- **The welcome screen can be completed without a mouse**, and pressing Return in the folder box now confirms your choice.

---

## v1.4.5 — 2026-08-19

- **Removed a second, unsafe way to move finished videos.** Settings had a **Migrate finals here →** button that moved finished videos without checking the copy first — it copied the file, then deleted the original, with no size check, no checksum, and no check that the video had ever been uploaded. On an external drive, which is exactly where finished videos get moved to, a copy that quietly truncates would have taken the original with it. It is gone. **Archive uploaded videos** does the same job and checks every file twice before removing anything.
- Only one finished video was still sitting in a project folder anywhere in your library, so nothing of value was lost by removing it — and if one ever turns up again, the Archive panel will move it safely.
- **The "External final-video root" panel is honest again.** Its Save, Clear and Browse buttons had been talking to a route that was removed in 1.4.3, so they would have failed silently. Finished videos go to the `Exports` folder inside your Library — that is now simply stated, not offered as a setting you can change from there.
- **The Archive panel has been checked on screen, not just in tests.** The preview, the per-channel breakdown, the reason beside every skipped file, the progress while it runs, and the refusal when a file of the same name is already in the destination were all exercised in a real window, including at phone width where a table of figures would normally overflow. A finished video was moved, verified, and its breadcrumb written, end to end.

---

## v1.4.4 — 2026-08-19

- **Archive uploaded videos — one button that clears finished films out of the way.** In Settings → Storage, point it at the folder your finished videos are in, pick where they should go, and Story Studio moves every video it can prove was uploaded to YouTube. What is left is a folder containing only finished films — something you can back up, park on a slow drive, or delete with ordinary tools. Story Studio does none of those for you, which is the point.
- **It can see the videos you already have.** Your finished videos are in `~/Downloads/YouTube Exports`, not in your Library, so the sweep lets you point it anywhere rather than only looking where the app would put things today. On your library right now it would move **166 videos and reclaim 197 GB**, across eight channels.
- **It only touches videos it can prove are uploaded.** The proof is the same one Story Studio has always required before deleting a finished video: a YouTube video id recorded for that episode. There is deliberately **no override**. Anything unproven stays exactly where it is and is listed with the reason — on your library that is 40 videos, 23 GB, mostly episodes that were never uploaded.
- **Nothing is deleted until its copy has been checked.** Each video is copied to the new folder, then checked there by both size and a full checksum, and only then removed from the original place. If a copy cannot be verified, the original is left alone and you end up with two copies rather than none. Losing a finished video is the one outcome this feature must never produce.
- **You see the bill before it runs.** How many videos, how much space you get back, which channels, and every skipped file with its reason. Then you press the button.
- **You can stop it.** A long sweep reports progress and can be stopped; it finishes the file it is on and stops before the next, so every video is always either wholly moved or wholly untouched — never half.
- **An archived episode says "archived", not "missing".** Each episode records where its video went. Without that, the missing-folder warning added in 1.4.2 would have started accusing archived episodes of being broken — the app would have been manufacturing the exact false alarm it just learned to catch.

---

## v1.4.3 — 2026-08-19

- **One folder holds everything now — your Library.** Story Studio used to have four different ideas about where your work lived: a default folder buried in the system, a custom override, a list of "linked" folders scattered anywhere on disk, and a separate map of labelled shortcuts. That is gone. There is one folder, with a folder for each channel inside it, a `_Project Assets` folder for anything you share between channels, and an `Exports` folder for finished videos.
- **Story Studio asks where to put it, and suggests somewhere you can actually find.** On a new Mac it opens on a single question with `~/Documents/Story Studio KH` filled in, which you can change to Desktop, Downloads, an external drive, or anywhere else you can write. **Nothing is created until you press the button**, so browsing around and changing your mind leaves nothing behind. You can move it later in Settings → Storage.
- **Connecting an existing folder is now just copying it in.** No linking, no registering, no import step. Any folder inside your Library that contains a `project.json` is a channel — copy one in and it appears, take it out and it is gone. That is the whole mechanism.
- **iCloud support is withdrawn.** You said it plainly: it is too unreliable. The code that tried to detect half-downloaded iCloud placeholder files is gone, along with the advice to "right-click and Download Now" that came with it. Saving files still writes safely — if the app is killed or the Mac loses power mid-save you get the old file or the new one, never a broken half — because that protection was never really about iCloud.
- **Finished videos go into your Library.** New renders land in the `Exports` folder there. **Your existing exports have not been moved** — the 220 GB already in your Downloads folder is exactly where it was, and Story Studio still finds those videos when working out what is done. They are yours to move, keep, or delete whenever you want to.
- **Nothing at all was moved by this upgrade.** Where an old setting pointed somewhere outside your new Library, Story Studio tells you once, names the folder, and leaves it completely alone. Five channels were registered from iCloud folders that no longer exist; those dead entries were dropped quietly, because a shortcut to a folder that is gone is not worth interrupting you for. The same five channels are healthy in your Documents folder and appear as normal.
- **Shared files use one label instead of a per-Mac map.** `${ASSET}` now always means the `_Project Assets` folder inside your Library, on every machine. The old custom labels pointed at a different folder on each Mac, which meant a project that worked on one did not work on another. If you had any, Story Studio lists them once so you can move those files across.
- **If your Library is missing, Story Studio says so.** Put it on an external drive and open the app without the drive plugged in, and you get a clear message naming the folder it looked for and a button to look again — never an empty list that looks like your work disappeared.

---

## v1.4.2 — 2026-08-19

- **A channel whose episodes folder has gone missing now says so.** If the folder a project points at is not there, the channel card shows **Folder missing** and names the exact path it looked for, and the project page says the same thing at the top. Until now that project looked completely normal and simply had no episodes in it — the app had already worked out the folder was missing and never mentioned it. Your files are not lost when this happens; the app just cannot see where they went.
- **Nothing guesses a replacement folder.** The path is named and you decide. Guessing is exactly the wrong move here: one real case had an empty `episodes` folder sitting right where you would expect it while the actual episodes were in a folder next door, so an automatic fix would have quietly pointed the project at nothing and called it done.
- **The app stopped telling you to press a button that no longer exists.** Four places — including the confirmation dialogs for *unlinking* and *hiding* a project — told you to recover it later with "Add existing project folder…", which was removed from the All Projects page some time ago. Following that advice left you with no way back at all. They now describe what actually works: put the folder in your projects folder and Story Studio finds it by itself. Settings → Storage shows where that folder is.
- **Hiding a channel has a way back again.** "Hide project (keep files)" is still there, but the panel that restored hidden channels had disappeared, which quietly turned hiding into a one-way door — the files stayed safe on disk and became unreachable from the app. The **🗑️ Hidden channels** panel is back on the All Projects page, with **Restore** on each one.
- **Imported projects are now recorded in a way that survives moving to another Mac.** Importing a folder used to write down its full path, including your username and drive — which stops working the moment either changes. When the folder lives in your projects folder it is now recorded relative to the project instead, so it keeps working after a move. A folder on an external drive is still recorded in full, because that is the honest answer for it.
- Checked while in there: **"Move this project to…" was never the cause of this** and cannot re-create it — it relocates the folder and never rewrites the episodes path.

---

## v1.4.1 — 2026-08-18

- **Your overlay effects can travel between episodes; their timing cannot.** You said overlays should belong to episodes but still live in presets so you can randomise the effects. Both are true now: a preset carries the overlay itself — which file, its opacity, size, position, blend and looping — and each episode keeps its own answer to *when* that overlay appears. A 12-second flourish placed over the closing line of a 16-minute episode was landing mid-sentence in a 9-minute one.
- **Applying a preset no longer re-times another episode's overlays.** This was the same fault that put one episode's captions on another episode's video, in a different place: something specific to one episode was riding along in a preset and surviving a switch. Changing episode now loads that episode's own overlay timings, or none — it never leaves the last episode's standing.
- **Timings you already set are kept, not thrown away.** Presets saved before this release still carry overlay timings. When you apply one, that timing is rescued and saved against the episode you are on — but never on top of a timing that episode already had — and the page tells you once that it happened.
- **Randomising overlay effects cannot scramble their timing.** Because the timing is no longer inside presets, anything that shuffles overlay looks between presets simply cannot reach it. That is a property of how the data is stored rather than a rule something has to remember.
- **Version numbers now only move on the last digit.** Story Studio stays at 1.4 and counts up from there — 1.4.1, 1.4.2, and onward past 1.4.100 without a break. Where a release matters more than usual, these notes will say so in words rather than in the number.
- Checked while making that change that nothing breaks once the last digit reaches two or three figures — the release checks, the changelog ordering and the What's New pop-up were all already fine at 1.4.100.
- Fixed while in there: content pack version lists were sorted as text rather than by number, so a pack's tenth update would have been listed as though it came before its second. This affected the order things were shown in, never which version was actually installed or rolled back to.

---

## v1.4.0 — 2026-08-18

- **You no longer choose which subtitle file to burn.** Story Studio picks it — this episode's corrected stitched transcript, or the best full transcript it has — and Step 5 simply tells you which one it is using. You asked for the choosing to go away, not for the file to be a mystery, so the name is always on screen.
- **The per-chapter files are gone from that list.** Each one covers a single chapter, so burning one would caption a fraction of the episode. They were never a sensible choice and are no longer offered. If any exist, the page says how many it is not showing, so their absence never looks like a missing-file bug.
- **You can still choose, behind a "Change" link.** You said you should not *need* to pick, not that picking should be impossible. Your choice is remembered per episode and cannot follow you to another one, and one click puts it back to automatic.
- **Your subtitles now stitch and re-stitch themselves.** You no longer have to remember. Before every render Story Studio checks whether the stitched transcript still matches the chapters it was built from, and rebuilds it if not — then says in the log what changed and why, so a rebuild is never something that just happens.
- **It compares the words, not the file dates.** Copying a project folder, restoring one from a backup or letting it sync rewrites file dates without a word changing, and can make an out-of-date transcript look newer than the chapters it came from. Story Studio compares the actual content instead, so it cannot be fooled by any of that.
- **This repairs the mid-July damage on its own.** Every stitched transcript you already have was made before this record existed, so the first time each episode is rendered it re-stitches once, correctly, and records what it used. **You do not need to re-stitch anything by hand.** You do still need to re-render the affected episodes — a video that has already been made is not changed by any of this.
- **If the captions cannot be timed, the render stops and says so.** When Story Studio cannot work out how much audio plays before your narration begins, it now refuses rather than assuming there is none. Assuming was exactly what put roughly sixteen seconds of drift into everything merged since mid-July, silently. It names the cause and tells you to re-run Audio Assembly for that episode.
- **The corrected transcript is what gets burned now.** Where Story Studio has fixed the spelling of names your narration uses — the pass that turns Whisper's "Mirion" back into your "Neorion" — those corrected words now go into the video. Until now your scene images were being generated from the corrected words while the video burned the uncorrected ones: one episode, two spellings, and the wrong one on screen.
- **Three frames of the real video before you render it.** Press Generate and Story Studio takes three pictures from different parts of the episode — around a sixth of the way in, the middle and near the end — with the captions burned in exactly as the final render will burn them. You look at them, and the render only starts when you say they are right. It takes about a second.
- **Every frame is guaranteed to have a caption on it.** The three sample points are pulled onto the nearest caption rather than taken at a fixed moment, because a frame of silence proves nothing. Each one is labelled with its timestamp and the line it is showing.
- **They are the real thing, not a mock-up.** The captions in those frames come from the same code that burns the final video, at the same size, from the same lines — so what you approve is what you get. The picture behind them is the right scene but skips motion, grading and overlays; the page says so.
- **Batch renders get the frames too, without stopping.** A Pipeline run has nobody watching it, so it saves the same three pictures next to each finished video instead of waiting for a click. They sit beside the video as `..._subtitle_preflight_1.png` and so on.
- **Story Studio now warns when your Scene Plan is following old caption timing.** Your scene plan is built *from* the stitched subtitles, so an automatic re-stitch that shifts the timeline leaves the pictures where they were. It now tells you, on both Scene Plan and Video Assembly, how far out things are — and points you at **Reconcile timings**, which re-times your existing scenes and keeps every image, prompt and approval. Nothing is repaired behind your back.
- Fixed while in there: the warning that appears when a plan is older than its subtitles used to send you to **Repair long scenes** or a full rebuild. Neither is right for this, and a full rebuild renumbers every scene and leaves the images you have already paid to generate unattached to anything. It names Reconcile timings now.

---

## v1.3.4 — 2026-08-18

- **A video can no longer be given another episode's subtitles.** You rendered EP0047 and the captions burned into it were EP0048's — Timbuktu's words across Rome's video. Video Assembly holds the subtitle file you pick as a path to one episode's file on disk, and nothing replaced it when you changed episode. Pick a file for one episode, switch to another, and Step 5 was still pointing at the first one. It moves with you now.
- **It re-picks rather than forgetting.** Changing episode finds the same kind of transcript in the new one — corrected stays corrected, stitched stays stitched — instead of emptying the box and making you choose again every single time. When the new episode has no equivalent the box clears and says so, rather than quietly keeping the old file.
- **And it always tells you.** Whenever the file changes because you changed episode, the page names the file it dropped and the one it put in its place. Swapping the words about to be baked into your video without a word is the same fault in a quieter form.
- **Story Studio now refuses to render a subtitle file that is not the episode's.** The page forgetting to reset was the bug; the renderer cheerfully burning any file it could find is what turned it into a finished video you were about to upload. It checks before a single frame is encoded, names the episode the file really belongs to, and stops. It does not silently substitute the right one — which transcript goes in is your call, not the app's.
- Fixed while in there, same shape and both reach the finished video: the **title screen picture** and the **episode title text** each stayed on the previous episode's value whenever the new episode had nothing to replace it with. Both clear now instead of borrowing.
- Fixed while in there: when the asset scan failed, the page went on showing the previous episode's scene count, cycle estimate and low-asset warning as though they described the episode on screen.
- Fixed while in there: the Step 6 summary reported scene shuffling and excluded scenes from a saved preset, while the render has both switched off regardless. It states only what actually happens now.
- **Batch renders get their captions.** Found while fixing the above: running Video Assembly across several episodes from the Pipeline left the subtitle file blank on every one of them, because a saved bundle deliberately does not carry one episode's file and nothing filled in each episode's own. Those videos came out with no captions at all and nothing said so — the render did not even count them as missing. Each episode now uses its own subtitle file (your pinned choice if you made one), and says which in the log. If an episode genuinely has none, the render says that plainly instead of quietly leaving them out.
- **Your subtitles are back in time with your intro.** Re-stitching EP0047 gave a timeline starting at zero even though its merged audio opens with your 15-second branded intro — so every caption ran sixteen seconds ahead of the picture. The cause was small and unlucky: since July, every audio merge writes a little bookkeeping file beside the track, named closely enough that the code measuring your intro picked *that* instead of the audio, failed to measure a text file, and reported "no intro". Everything merged since mid-July was affected and everything older was fine, which is why it looked random.
- **The answer was already written down.** The merge records exactly what it put in front of your narration — for EP0047, 16.066 seconds. Story Studio reads that record now instead of working the number out a second time, so what the Merged Audio row tells you before you render and what your captions are shifted by can never disagree.
- **Re-merged tracks are found too.** If you merged again and ended up with a second file beside the first, the intro measurement used to skip it entirely and report zero.
- **"No intro" and "I could not work out the intro" are different things now.** They used to be spelled the same way — a silent zero — so a timeline sixteen seconds early looked exactly like a correct one. Stitching states which happened every time: the offset it applied and where that came from, or that nothing precedes your narration, or that it could not tell, why, and what to do about it.
- **Your YouTube chapter timestamps were early by the same amount**, on the same episodes, for the same reason. The same change fixes them, and when the intro cannot be measured the package now warns that the chapter marks may be early instead of presenting them as exact.

---

## v1.3.3 — 2026-08-18

- **Contextual Cues saves itself.** You said you keep forgetting to click Save changes, so you no longer have to. Every edit — a title, a time, an approval, a dragged label — writes itself a moment after you stop. Leaving the page, switching episode or reloading the timeline writes first, so nothing is left behind by walking away.
- **Save changes is still there, and still does something.** Press it and it writes whatever is pending straight away. Press it when everything is already written and it tells you so, instead of sitting there greyed out looking broken.
- **The page says where it has got to** — "Unsaved changes — saving in a moment", "Saving…", "Saved at 21:14" — next to the buttons, so you never have to guess whether your last edit is safe.
- **If a save fails, nothing is lost.** Your edits stay exactly where they are, the row says plainly that it did not save, and Save changes tries again. It will not quietly retry on a timer, so a backend that is down does not get hammered while you read the message.
- Two saves can no longer overlap, and a reply that arrives late can no longer overwrite what you typed while it was travelling — so a cue title never reverts under the cursor.
- **Approve all saves like everything else.** Making a bulk approval wait for review was considered and rejected: approving fifteen cues one at a time would save, approving the same fifteen in one click would not, and that difference is invisible until it loses work. Nothing is committed by saving an approval — the cue only reaches the video when you render, and it stays one click from undone until then.
- **A preset now tells you when it changes Auto-approve safe proposals.** You applied your "Contextual Cues - DeepSeek" preset for its model and pacing and found automatic approval switched on without being told. The preset really does carry that setting, and it is staying — you asked for presets to keep everything they can — but it announces itself now, in both directions: switched on, switched off, and, when a preset has nothing saved for it, left alone with nothing said.
- Fixed while in there: applying a preset saved before that setting existed used to switch automatic approval **off**, because "this preset says nothing about it" and "this preset says no" were being read as the same thing. They are now different, and a preset with no opinion changes nothing.
- Fixed while in there: a save started just before you switched episode addressed whichever episode you had switched *to*. It now addresses the episode the cues actually came from.

---

## v1.3.2 — 2026-08-18

- **You can now open the assets in Video Assembly before you render.** Step 1 listed scene numbers, thumbnails and the merged audio track and let you open none of them. Click any scene number or thumbnail chip to see the picture full-screen, and browse the whole episode with the arrow keys. The merged track gets a player, so a quick listen no longer means leaving the page.
- **The merged audio now tells you whether your intro is in it.** You asked not to find that out after rendering the video. Newly merged tracks record what they prepended, and the row reads back the intro's filename, its length and the gap after it — "Intro included — Channel_Intro.mp3 (6.0s) + 2.0s gap. The narration starts at 8.0s."
- **For episodes merged before this release, Story Studio measures the file instead of guessing.** Every merged track already on your disk predates the record. Rather than reading your current Audio Assembly settings and describing an old file with them — those settings say what is set *now*, and the file may have been made with something else — Story Studio measures how much audio plays before the narration and says exactly that much and no more: "16.1s plays before the narration starts… it can't say whether that is your intro or a music lead-in — re-merging records it." When nothing precedes the narration, that *is* the complete answer, and it says so.
- The measurement is the same one your burned captions are already shifted by, so the two can never drift apart. If the chapter sidecar no longer matches the file, the row says it cannot tell rather than reporting a confident zero.
- **The exact subtitle preview opens in a window, and is worth looking at.** It rendered at 640×360 and sat at roughly 310 pixels wide — beside a rough CSS sketch drawn at twice that. The approximation outranked the accurate one, and enlarging the accurate one only blurred it. It now renders at 1280×720, opens in a large dialog the moment it finishes, and shares its width with the sketch. Click the clip to freeze a frame — useful for judging word-by-word highlighting.
- Sharpening the preview costs about half a second more per render, once, and the result is cached.
- Fixed while in there: the image preview counted across sections, so the third thumbnail of five announced itself as "Thumbnail 122 / 124". It now counts within its own section.

---

## v1.3.1 — 2026-08-18

- Scene Plan now reserves your real opening. When you build a timeline, Story Studio measures the clips that actually play before your first scene — the intro video, a title card, any clips you have parked at the head of the timeline — and starts scene one exactly there. The finished video puts every scene on the narration it was written for.
- This is the other half of the fix from two releases ago. That one moved contextual cues back onto their scenes and deliberately stopped short of moving the scenes themselves, because changing how a video is composed is your decision and not the app's. This is that decision, taken: **new plans are right by construction, and nothing you have already made is touched.**
- What was wrong: three different places each claimed to know how long your branded opening was. Your Scene Plan preset said "start at the first second" and, contradicting itself, "reserve 15 seconds". Your project settings said "branded opening, 10 seconds". The file on disk was 10.0 seconds. The preset won, so plans reserved nothing at all — and every scene appeared ten seconds after the narration it was planned against, with the last ten seconds of pictures cut off the end.
- Only one of those three was ever a fact. Story Studio now asks the file and ignores the other two. If you have no intro, nothing is reserved and nothing moves.
- **There is nothing left to type.** The "Opening visuals" box on Scene Plan no longer asks you for a mode and a number of seconds; it tells you what your clips measure and where scene one will start. Change the opening in Video Assembly and build the timeline again — the figure follows the clips.
- **Scene Plan presets no longer carry an opening length.** A preset should restore a reusable choice, not re-decide a measurable fact about your project's files. Presets you have already saved keep those two stale values on disk and are never rewritten; they are simply not read any more.
- The plan and the renderer now share one measurement rather than each doing their own sum. Two independent answers to "what comes before the scenes" is how this went wrong in the first place, and it would have gone wrong again the day you added a title card.
- **Your finished episodes are left exactly as they are**, as you asked. A plan built before this release still renders the way it always did, including the trick where an intro is stretched to fill a longer reserve. Only timelines built from now on use the measured opening.
- If an opening clip cannot be played on this Mac — a missing file, or one iCloud has not downloaded yet — Scene Plan says so by name instead of quietly reserving a shorter opening than the render will use.
- Fixed while in there: a batch render from Pipeline silently dropped every clip you had added to the timeline yourself, so a batch produced a different video from the one the Video Assembly page produced from the same settings.
- Fixed while in there: whether captions sit out the opening is now decided by whether there is an opening, rather than by a setting saved on another page months earlier. Your own tick-box in Video Assembly still wins whenever you have set it.
- Proved on real video, not on settings: an episode with an intro and one without were both rendered end to end and the actual pixels read back frame by frame, checking that the picture on screen at each moment is the scene planned for that moment.

## v1.3.0 — 2026-08-18

- Contextual cues can now be put where you want them. You can place a label in any of the four corners, or drag it to any spot on the frame — which is what you asked for after a cue landed on top of the channel logo on EP0047, too high and in a corner you could not move it out of.
- Bottom placement was never missing. It was written, it was checked, and the renderer had always drawn it correctly — but six separate places along the way each decided for themselves which corners you were allowed to pick, and half of them quietly answered "the top two". Anything you chose that was not top-left became top-right without saying so. Every one of those six now reads the same list.
- One of them would have caught you out even after the menus were fixed: a cue anywhere along the bottom was refused outright whenever burned-in subtitles were switched on. Since that is nearly every episode, unlocking the menu alone would only have moved the dead end to the moment you pressed Render. It is now a note beside the cue, not a refusal, and it is worked out from where the label actually sits rather than which corner it is nominally in — so a label placed in the middle of the frame is no longer accused of colliding with captions at the bottom of it.
- **Drag to place.** The little preview beside each cue is now the control: drag the label and it moves. It shows the frame, the protected edge, and the label exactly where the finished video will put it. There are Across and Down boxes beside the timings for keyboard use, and the same pad sits in the proposal settings so new cues start where you want them instead of being moved one at a time.
- **Set it once for a whole project.** The default position is saved with your cue preset, so "keep labels clear of my logo" is said once and stamped onto every cue a proposal creates. Any single cue can still be dragged somewhere else afterwards, and **Use everywhere** takes one cue's position and gives it to the rest of that episode.
- **Cues no longer disappear too fast.** A cue used to be refused unless it lasted between 2.25 and 4.5 seconds. Nobody chose those numbers — they arrived with the feature's first commit carrying no explanation — and 4.5 seconds is barely a third of what the longest label the same check allows can actually be read in. An 80-character title with a 100-character second line is 180 characters, which takes around 12 seconds at normal on-screen reading speed.
- So the ceiling is gone as a refusal and is now only a note, shown when a label holds for more than about 12 seconds. How long to leave a label up is a decision about the pace of your own film, and the app should not overrule you on it. Nothing downstream depended on cues being short: they still cannot overlap each other, and still cannot outlast the scene they belong to.
- The floor stayed, and stayed strict. A label that flashes past for half a second is not a style choice, it is text nobody can read — so a cue still has to be on screen for at least 2.25 seconds.
- Corners are still there as one-click presets, and nothing you have already made has moved. Existing cues keep the corner they were saved with and render pixel-for-pixel as before; the new positioning is something a cue gains only when you give it one. Chapter plates stay centred, as they always have been, unless you place one by hand.
- Fixed while in there: clearing a label's position would have pinned it to the very top-left instead of releasing it back to its corner, because an empty value counts as zero in JavaScript. Found by a test written for this release, before it ever reached you.
- Fixed while in there: a saved cue preset that stored a bottom corner lost it every time the preset was applied, and again every time the batch runner in Pipeline read it.
- All four corners and a hand-placed label are now checked by rendering real video and reading the actual pixels back, rather than by inspecting the instructions we send to the renderer. That is the only kind of check that could have caught this: every layer was individually correct the whole time.

## v1.2.9 — 2026-08-18

- Regenerating a thumbnail now changes the picture you are looking at. The small image on the row always updated, but opening the large preview kept showing the previous artwork — so a re-render looked like it had done nothing, and the only way to see the new picture was to restart the app.
- The artwork itself was never the problem. Every re-render wrote the new file correctly; it was the enlarged preview that kept showing an old copy it was holding on to, because a regenerated image keeps the same filename and the browser had no way of knowing anything had changed. It now knows, and swaps the picture the moment the render finishes.
- The same stale-picture fault was found and fixed in four more places before anyone hit them: the Browse Existing Images grid, the thumbnail board after a Repair, the thumbnail shown on the YouTube Upload page, and the scene frames shown in Video Assembly. All five had one cause and now behave the same way.
- Refresh buttons now refresh the pictures, not just the file list. "Refresh" on the image browser re-read what was on disk but kept re-drawing the old artwork, which is precisely what that button exists to disprove.
- Nothing changed on the server. It was already sending the right instructions and already reading each file fresh — the old preview was being shown without the app ever asking for it, so no amount of server-side care could have prevented it.
- The preview's own "couldn't load — retry" recovery is untouched and still works exactly as before.

## v1.2.8 — 2026-08-17

- Closing Story Studio in the middle of a batch no longer leaves a job stuck forever. When a request was still being sent at the moment the app closed, it never reached GenStudio at all — and on reopening, Story Studio would sit waiting for an answer about a request that does not exist. One batch waited twenty-two minutes with forty-eight further images queued behind it, and nothing in the app could clear it.
- Story Studio now understands the difference between "GenStudio says it does not have this" and "Story Studio could not reach GenStudio". The first is a final answer: the request was never created, so nothing was generated and nothing was charged. The batch stops waiting, says so in the log in exactly those words, and finishes.
- The second is still treated as a temporary problem and keeps waiting, because it is. Getting that backwards would mean re-sending — and paying twice for — work a provider had already accepted, so a network failure, a server error, a rejected key and a "gone" response all hold exactly as before. Story Studio never re-sends anything by itself on the back of this.
- Every job now has a way out. A job stuck waiting on something Story Studio cannot resolve used to have its Cancel disabled, its Delete refused, and only a greyed-out button reading "Checking provider status" left — no exit by any button or any route. There is now an **Abandon this job** control, always offered on an unfinished job.
- It says plainly what it does not do, in the confirmation itself: it does not cancel provider work GenStudio has already accepted, it does not refund credits already spent, and output may still arrive and stays recoverable. What it does is stop Story Studio waiting and let the queue move on. The ordinary Cancel is unchanged and still does the careful thing whenever the provider's state is genuinely knowable.
- After abandoning, **Retry** sits on the same row. Generating a replacement is one click from where you gave up, not a hunt on another page.
- New **Recover this episode** button on a failed job's own row. It does what Repair does — pull back output the provider finished but that never landed on disk, at no credit cost — for that one episode, without scanning the library. Repair itself is unchanged and still searches everything, which is what it is for when you do not yet know which episode is at fault.
- Fixed while in there: "Repair all" has always accepted a list of episodes to limit itself to, but audited every episode anyway and then discarded the rows it did not want. The limit was real in what it repaired and imaginary in how long it took.

## v1.2.7 — 2026-08-17

- Contextual cues now appear on the scene they were written for. On any episode with a branded opening they were landing early by exactly the length of that opening — ten seconds on one channel — because a cue is reviewed against Scene Plan time while the finished video starts with an intro the plan knows nothing about.
- Story Studio works the offset out for itself, from the real opening clips, at the moment it renders. There is no new setting, nothing to remember, and nothing to pick per episode. No intro means no offset, and an episode whose Scene Plan already reserves its opening is untouched.
- Because the offset is measured rather than configured, it covers the whole opening — clips placed before the intro, the intro, clips after it, and the title card — not the intro clip alone.
- The render log now says what it did: how long the opening measured, where Scene Plan starts its first scene, and how far each cue moved.
- Video Assembly no longer refuses to render an episode that has no contextual cues. Contextual Cues is optional, and an episode where none was ever proposed has nothing to approve — but the render was stopped anyway, asking for a review of cues that did not exist. It renders now, and says in the log that it is rendering without them, so their absence is never a surprise.
- The same block was coming from Pipeline: switching the project setting on made Scene Review unrunnable across the whole library, eighteen episodes at once, over cues that had never been proposed. Both gates now answer that question from the same rule, so they cannot drift apart.
- What the gate protects is unchanged. A cue that was proposed and left unreviewed still holds Scene Review and still stops the render, because that really is a decision waiting for you.
- Sound Design had the identical fault and is fixed alongside it — found by looking for the shape, not by waiting for it to be reported.
- Choosing Contextual Cues in a Pipeline run still runs it on an episode that has none. "Nothing to review" and "already generated" are different answers, and treating them as one would have quietly cancelled the very work you asked for.
- Fixed while in there: the Pipeline header read "0 blockers" while preflight listed eighteen problems beside it. Both numbers were right, about different things. It now reads "setup blockers", and says on hover that every episode is checked separately when you press Run Batch.
- Fixed while in there: "Exclude intro and title from effects" claimed it also held subtitles back. It never has — the caption filter cannot be time-gated at all — so the promise was empty, and it made "Hide captions during the intro", which does work, look redundant. The wording now says which does what.
- Captions were already right and are unchanged. They answer to the words, and the narration is not delayed by the opening; cues answer to the picture. That is why only one of the two moves.
- Video Assembly now warns when an intro is enabled but Scene Plan reserved no room for it, naming how far the scenes then sit from the narration they were planned against, and how to lock the two together. It renders either way — this was previously silent.

## v1.2.6 — 2026-08-17

- Scene Plan now tells you which art style an episode is using. The "Style from Character Sheet" block showed the style guidance and nothing else, so a wall of art direction gave no way to tell it was "Archival Documentary Reconstruction". The style's name and its category now sit above that text, matching what the Character Sheet shows.
- The channel default style is named the same way, so an episode falling back to it says what it is falling back to.
- Art direction you wrote yourself is labelled "Custom style" and says so plainly, rather than being left nameless. And if the style library cannot be loaded at that moment, Story Studio says the name is unavailable instead of calling a shipped look custom — it will not guess a style's identity from a library it failed to read.
- Finished jobs can be cleared from the job list once their provider work is actually done. A job that finished while one of its provider calls was still in flight kept a note saying that call was unfinished, and nothing ever went back to check — so the row said "Story Studio cannot remove this history while durable provider work is still settling" forever, about work that had finished long ago, with no credits held. Story Studio now re-asks GenStudio, updates what it knows, and offers Remove from history the moment GenStudio confirms everything finished.
- The three possible answers now read differently, because they mean different things. While the check runs, the row says it is asking GenStudio — and it genuinely is. If GenStudio cannot be reached, it says exactly that and offers a "Check GenStudio again" button, instead of making a claim about the provider that Story Studio has no basis for. Only when GenStudio itself reports work is unfinished does the row say the work is still settling, and the re-check button is still there.
- The protection itself is unchanged: history is still never discarded while provider work might genuinely still settle. What changed is that Story Studio asks before saying so, and no longer shows a disabled button labelled "Checking provider status" while checking nothing.
- Contextual Cues has an "Approve all" button. It names how many cues it will approve, and it only touches cues still awaiting review — a cue you deliberately excluded is left exactly as you set it. Like every other edit on that page it marks the timeline as changed and waits for Save changes; it never writes on its own.

## v1.2.5 — 2026-08-17

- Character Sheet presets remember the scene rhythm again. Save a preset with an episode set to "5–10 seconds — Slow & deliberate", apply it on another episode, and that episode now moves to 5–10 seconds along with the art style. Rhythm was deliberately taken out of presets in August, after a preset quietly changed it on 50 of 53 episodes; putting it back is a considered reversal of that decision, not the old bug returning.
- Presets you saved while rhythm was excluded do not contain one, and applying those leaves your episode's rhythm exactly where you set it. Nothing falls back to a built-in default, and nothing already saved on disk is rewritten to paper over the gap.
- Because a rhythm that correctly does not move looks identical to a feature that does not work, the Character Sheet now says which happened. Apply a preset and it either confirms the preset set the rhythm and to which band, or says that preset has no saved rhythm, that this episode is unchanged, and that saving over the preset captures the current rhythm for next time.
- "Use episode anchor" is unchanged and still stays out of presets. Applying a preset will not switch it on and point an episode at an anchor image it never had.
- Fixed while checking the above: the scene rhythm dropdown and the custom shortest/longest boxes had no names a screen reader could read out, so they were announced as blank controls. They now say what they are.

## v1.2.4 — 2026-08-17

- The Content Store now opens fully stocked the first time you visit it after launching the app. The shop front — every product, shelf, cover, description, tag and price — is saved on your Mac and drawn instantly, instead of an empty page while Story Studio talks to GenStudio.
- What you own, what is installed on this Mac and your credit balance are deliberately NOT saved. Those are facts about your account, not about the shop, and a saved one redrawn a week later looks exactly like a freshly checked one. They arrive a moment later, from GenStudio, every time.
- In that moment the app says so rather than guessing. Cards read "Checking…" instead of "Available", the Owned, Installed and Updates tabs show a dash instead of a zero, and the account strip says it is checking instead of showing a balance. Nothing is described as unowned before anyone has looked.
- Buying, installing and Restore purchases stay switched off for that moment, using the same switch that already turns them off whenever the catalog is not freshly verified. Nothing can be purchased against a saved page.
- Opening the Store with no internet at all now shows the saved shop front and says GenStudio could not be reached, instead of an empty "Content Store is unavailable" screen.
- A saved shop front is thrown away rather than trusted whenever anything is off: a different GenStudio account signs in, the catalog came from a different GenStudio address, the file is older than thirty days, its timestamp is in the future, or a future version of Story Studio wrote it in a shape this one does not recognise. Account identity is kept as a one-way fingerprint that cannot be read back or displayed, only compared.
- Added a test that fails if any new account-specific field ever starts being written to that saved file, so the boundary cannot erode quietly in six months' time.

## v1.2.3 — 2026-08-17

- The Content Store no longer reloads itself every time you open it. If it already has a catalog it verified recently, that catalog appears instantly and the check with GenStudio runs quietly behind it, replacing anything that changed. A loading screen now only appears when there is genuinely nothing to show yet.
- Kept being right about what you own ahead of being quick about it. Every visit still asks GenStudio; nothing is served from memory instead of being checked. Buying, installing and Restore purchases still force their own fresh read, and the Refresh store button always goes to the network. If a quiet check fails, the page says it is showing the last verified catalog and switches purchase and install off, rather than leaving old ownership looking current.
- Stopped being quiet about a catalog older than five minutes. The check is the same, but the page shows that it is happening, because figures from an unbounded time ago should not look like nobody is re-checking them.
- Fixed the Content Store blaming filters nobody set. When every published pack was already owned, Discover said "No published products match these filters" and offered to clear filters that were not there. It now says which of four different things is actually true: you own everything published, nothing is published yet, your filters really did exclude everything, or the packs exist but GenStudio has not shelved them.
- Moved the GenStudio credits and lanes strip into the top bar on project pages, so account standing sits in the same place on every screen instead of the sidebar on some views and the top bar on others.
- Put the running version and build date in the project sidebar, where the strip used to be. Project pages previously showed no version anywhere, so there was no way to tell which build you were on without leaving the channel.

## v1.2.2 — 2026-08-17

- Story Studio now checks transcripts for garbled text and says so before it reaches a customer. Speech-to-text sometimes invents characters from other writing systems in the middle of English narration, and it happens more often than anyone would guess: across 4,032 real subtitle files, 18.7% contained letters from a script nobody spoke and 4.4% contained undecodable characters.
- Five checks, each measured against those 4,032 real files before shipping: letters from another writing system (18.7% of files), undecodable characters (4.4%), a word repeated over and over (0.4%), invisible control characters (0.1%), and accent marks with nothing to attach to (0.05%).
- Deliberately does NOT flag ordinary accented text. Café, Škoda, Zoë, naïve, gelmiş, curly quotes, dashes, ellipses, music notes and emoji are all normal and stay silent, as does short deliberate repetition like "No, no, no, no, no!" A warning that cries wolf is worse than no warning, so the rule is other writing systems — not merely unusual characters.
- Shows the actual offending lines — cue number, timestamp and the text itself — so a line can be judged in a second instead of investigated.
- Warns in all three places the transcript matters: on Subtitles, where affected chapters are marked in the readiness list; on Scene Plan, because that text is fed to the model that writes your image prompts, so garbled lines buy wrong pictures; and in Video Assembly, beside the file about to be burned into the video.
- Never edits anyone's subtitles, and never blocks a render. A mangled word cannot be repaired without knowing what was really said, so the app reports and you decide.
- Added a one-click "Re-transcribe this chapter", which is the only real repair. It re-runs just that chapter instead of the whole episode.
- Fixed re-transcription not actually re-transcribing. Ticking "re-run" skipped the local "already done" check but then reconnected to the previous request and downloaded the very same result — so a chapter re-run precisely because its transcript was garbled came back identically garbled. An explicit re-run now asks for a genuinely fresh transcription, while an ordinary retry after a crash still reconnects rather than paying twice.

## v1.2.1 — 2026-08-17

- Caption looks and scene effects can now arrive from an installed Content Pack. A pack may add a caption style, a camera move or an overlay, and each one appears in the same gallery, previews the same way and renders through the same engine as the ones that ship with the app.
- Kept the free library free and complete. The sixteen caption looks, twenty-four scene animations, seven B-Roll motions and thirteen overlays still ship with Story Studio and still work with nothing installed — a pack can only add to that list, never replace or quietly stand in front of part of it.
- Said where every look came from. A style or effect from a pack is marked in the picker and names the pack, and the mark explains what will happen to it if that pack is uninstalled.
- Refused to render a video that quietly lost something. If a pack is removed while an episode still uses one of its camera moves or overlays, the render stops and names the effect and its publisher instead of publishing the video without it. A caption look is unaffected either way, because applying one copies the finished style into the episode rather than pointing at the pack.
- Refused a pack this build cannot honour, naming the field that was the problem: an unknown setting, a look authored for a newer caption or effect engine, a category that is not one of the app's own, a still camera move filed as a B-Roll move, and a corner-logo effect trying to name a file on the customer's machine.
- Held pack content to the same content rules as the rest of a pack. A web address, a provider routing instruction or a pasted API key inside a caption or an overlay is rejected by name, even though each is an ordinary piece of text as far as the look itself is concerned.
- Left a bad pack costing only itself. A pack whose files no longer match what was signed is dropped whole, and the free library is served untouched beside it.
- Fixed the scene-animation picker being able to drop an entry on the floor: its six category names were written out twice, once in the picker and once in the effect library, with nothing keeping the two in step.

## v1.2.0 — 2026-08-17

- Turned every camera move into data. All twenty-four scene animations and all seven B-Roll motions now come from one declarative library instead of hardcoded branches, so a new move is a description rather than a code change and an app release. Every one of them renders exactly as before — 1,163 filter strings captured from v1.1.0 are compared character for character on every build.
- Added a free built-in effect library that composites on top of the finished picture: soft and heavy vignettes, fine and heavy film grain, warm and cool light leaks, CinemaScope and widescreen bars, clean and bare lower thirds, a corner logo, and top and bottom gradient scrims. Each has named settings with documented ranges, and each can be previewed over the episode's own first scene before it is used.
- Said plainly, in the picker, where an effect cannot do exactly what its name promises — the light leaks, the gradient scrims, Blur → Focus, Dolly In and Parallax Drift each carry a sentence explaining what is really being drawn.
- Made the effect library the single source for the Video Assembly vignette, film grain and letterbox controls and for the corner-logo placement, so a control and a library effect of the same name can no longer drift apart.
- Fixed Rotate CW and Rotate CCW producing no preview at all: at a preview's frame height the rotation asked the encoder for an odd picture size, which it refused. Present since the rotations were added.
- Fixed the animation picker giving every tile a different randomly-generated backdrop, which made two animations impossible to compare side by side.
- Fixed the B-Roll motion list being a hand-maintained copy of the renderer's list whose descriptions had already drifted out of step. It is now served by the app.
- Corrected the scene-animation type, which claimed five animations existed while the app offered and rendered twenty-four.

## v1.1.0 — 2026-08-17

- Added word-by-word captions: highlight, pop, reveal, single-word and typewriter modes, each with its own colours, scale and timing, plus a highlighter block behind the spoken word.
- Added sixteen built-in caption looks — from Clean Broadcast and Sleep Soft to Karaoke Pop, Neon Glow, Yellow Highlighter and Minimal Lower Third — applied from a gallery that changes the look only and never touches an episode's subtitle file or settings.
- Rebuilt the caption properties panel around a versioned, purely declarative style schema, with every field exposed in collapsible Typography, Colour, Box, Placement, Animation and Word groups: weight, italics, capitals, letter and line spacing, per-colour opacity, box padding, shadow depth and offset, edge blur, and slide-down alongside the existing animations.
- Made the subtitle preview four seconds long over a full sentence, and render the exact caption document the final video burns, so preview and export now agree on size, stroke, position and timing at any resolution.
- Fixed captions ignoring the chosen line width and line count in final renders whenever no animation or precise position was set — both assemblers now burn through one renderer instead of a lossy shortcut.
- Started collecting per-word timings on every new transcription, at no extra cost, and fixed the request fingerprint that would otherwise have replayed the old word-less transcript while reporting success.
- Added a plain marker on the Subtitles page showing which transcripts carry word timings, so an older episode's estimated word timing is explained rather than mysterious.

## v1.0.844 — 2026-08-16

- Prevented delayed test-only Job Queue persistence from falling through to the configured customer projects folder after temporary test storage is released.
- Added a byte-for-byte regression using an isolated fake projects root, covering both unexpected `jobs.json` updates and unexpected project-directory creation.
- Made the official backend test command create and verify its own disposable per-machine home, settings, and projects boundary instead of reading the developer's live Story Studio configuration.

## v1.0.843 — 2026-08-16

- Added explicit deterministic build and validation support for GenStudio delivery-attested Content Pack archives without publisher key IDs or archive signatures.
- Kept the publisher-signed local import and recovery paths independent, rejecting any attempt to mix the two trust modes.

## v1.0.842 — 2026-08-16

- Added a complete Content Store experience with curated shelves, search and filters, release-proof details, separate Owned, Installed, and Updates libraries, accessible status announcements, and truthful offline and account-scoped states.
- Added support for staged publication of ten free Starter Channel Kits and the componentized Archival Ledger collection, with reusable Formula, Topic, Visual Style, and Thumbnail Recipe components, exact dependency closures, and no automatic mutation of legacy projects.
- Hardened Content Store claims, purchases, restores, and installs with byte-exact signed quotes, idempotent settlement, delivery attestations, OS-protected historical key anchors, account-isolated retained proof, exact bundle verification, and terminal recall enforcement.
- Made Motion Review use exact GenStudio-published image-to-video operations and per-variant pricing, and fixed Scene Review statuses that could remain stale across pause, restart, or overlapping render batches.

## v1.0.841

- Upgraded the desktop runtime from Electron 39 to Electron 43.4.0, removing the vulnerable legacy archive extractor from Story Studio's development and packaging dependency tree.
- Added a release regression that prevents the vulnerable `extract-zip` dependency from silently returning through a future Electron downgrade.
- Preserved Story Studio's packaged app identity, local data paths, offline startup, and unsigned arm64 DMG workflow across the runtime migration.

## v1.0.840

- Added same-account Content Store restore and explicit verified installation, including signed receipt, archive, identity, compatibility, and dependency-closure checks without automatic purchases or downloads.
- Added GenStudio account locks across every model catalog and generation boundary, keeping locked choices visible while preventing locked or Premium models from being selected as silent defaults.
- Added a persistent balance, tier, and lane-standing strip across both Story Studio shells, with truthful local ownership and installed-pack status even when remote downloads are unavailable.

## v1.0.839

- Fixed Content Store scope refusals being mistaken for expired Story Studio web sessions.
- Keeps the Content Store page open so a missing `content:read` scope shows its truthful Settings guidance instead of returning to Channels.
- Preserves the real remote-session login redirect while ignoring account-key scope responses in both desktop and server modes.

## v1.0.838

- Added GenStudio-published per-image pricing to every image-model row before selection.
- Shows the full published rate range when output sizes cost differently, instead of presenting the default 1K rate as if it covered every size.
- Keeps the exact selected output-size rate in the existing output picker and never invents a total charge.

## v1.0.837

- Added a dedicated published-rate line to model selection rows so LLM input/output token rates and TTS character rates are visible before choosing a model.
- Preserved GenStudio's exact LLM rate, minimum, and price-version fields through Story Studio without inventing an up-front total whose output usage is not yet known.
- Kept model descriptions and request limits visible alongside pricing instead of allowing one catalog fact to hide another.

## v1.0.836

- Fixed packaged Content Pack and Content Store pages failing to load because the installed app attempted to discover a development source directory before using its bundled recovery resources.

## v1.0.835

- Added the GenStudio Content Store commerce core: browse published packs, see the exact content-spendable balance, request a signed quote, and confirm a permanent account purchase with durable idempotency.
- Added restart-safe purchase evidence and an unverified receipt cache. Story Studio never repeats a purchase automatically and clearly separates GenStudio ownership from installation on this Mac.
- Added Content Store scope checks and honest empty, insufficient-credit, incompatible, unavailable, and uncertain-outcome guidance. Downloads, restore, and receipt verification remain disabled until GenStudio Phase 2 publishes their contracts.

## v1.0.834

- Adds the local signed Content Pack runtime for Series Formulas, Topic Packs, Visual Styles, and Thumbnail Recipes, with strict offline verification, a bundled recovery catalog, safe import, disable, rollback, and removal guards.
- Pins projects and queued generation work to exact verified pack versions and hashes, so updates never silently change existing creative inputs and missing content blocks only the workflows that directly need it.
- Preserves legacy custom content as explicit project-scoped user forks when edited, keeps original and signed sources immutable, and serves only verified declared preview assets through contained local endpoints.

## v1.0.833

- Adds Economy, Balanced, and Premium navigation to model pickers when GenStudio's live catalog publishes a complete cost classification.
- Applies the same published cost-tier treatment across Language, Image, Video, Music, TTS, and Transcription catalogs; Music keeps its classification in Settings until Story has a customer-facing Music generator.
- Keeps model choice intentional: new fully classified selectors may choose only an available Economy model, never silently escalating to Balanced or Premium, while saved explicit choices reopen their published tier.
- Preserves the existing flat picker and legacy selection behavior whenever any model in a picker is not yet classified, without guessing a tier from provider, price, name, or model ID.

## v1.0.832

- Adopts GenStudio 1.2.0's published retry timing, provider progress, stall recovery, status, and failure details across durable jobs and the Jobs/Remote displays.
- Honors GenStudio's absolute `retry_at` polling schedule instead of substituting a local retry guess.
- Treats each chat model's published structured-item maximum as a safety ceiling for Contextual Cues while preserving checkpointed batch identity and the proven 50-scene Story policy when the limit remains unmeasured.

## v1.0.831

- Makes unsigned and public desktop packaging use the exact Electron runtime already installed from the lockfile, avoiding a redundant network download that could fail after every source/build gate had passed.
- Retains the v1.0.830 neutral Blank-project production guidance so adopted Series Formulas no longer inherit unrelated sleep-story instructions.

## v1.0.830

- Makes new Blank projects start with neutral production guidance instead of inheriting sleep-story audience, welcome, and pacing instructions that could contradict an adopted Series Formula.
- Keeps existing customer-authored production standards untouched; the affected Hidden Mechanics of History soak project was explicitly reset to let its active history Formula own narration.

## v1.0.829

- Makes explicit Audio “Regenerate” work use a fresh deterministic Story-job identity instead of reclaiming a successful TTS task from an older run or retired API key.
- Keeps restart replay idempotent for that same regeneration job while allowing the replacement audio to overwrite only the selected chapter files.
- Re-qualifies forced overwrite and versioned generation against published audio fleet concurrency with no duplicate provider submission.

## v1.0.828

- Keeps “New version” audio outputs on their own `_vN` filenames even when regeneration is forced, preserving the previous audio instead of overwriting it.
- Gives each versioned audio file an independent durable recovery identity, so a replacement voice never reclaims an earlier account’s settled TTS job.
- Re-qualifies versioned regeneration against the selected model’s published fleet concurrency and submits only genuinely new replacement work.

## v1.0.827

- Writes ordinary narration numbers in natural spoken English, including conventional historical and modern years, dates, decades, ordinals, quantities, percentages, currency, decimals, and ranges.
- Applies the same deterministic, idempotent spoken-number safeguard to legacy or imported narration before TTS quoting, chunking, recovery, and submission, while preserving exact identifiers, URLs, citations, equations, model names, paths, addresses, and other ambiguous technical literals.
- Stores spoken forms in newly generated or edited chapter bodies without rewriting structural headings, episode metadata, or legacy scripts during compatibility migration.
- Re-qualifies audio generation against each selected TTS model's live published submit concurrency, so supported replacement audio fans out across the provider fleet while missing or invalid hints remain safely serial.

## v1.0.826

- Checkpoints every completed Contextual Cues batch, reuses saved batches after failure or restart, and paces new language submissions to the live account limit.
- Retries only a confirmed provider-backpressure batch, with a bounded cooldown and a fresh durable identity, when GenStudio proves zero settled credits and a full reservation release.
- Adds cooperative Scene Image pausing before every new provider request, persists the pause across restart, and resumes by verifying existing files before submitting only missing scenes.
- Reports whole-episode image progress as completed, settling, customer-cancelled, failed, and not submitted; customer cancellations no longer appear as provider failures.
- Adds a no-output stall hold that stops new image submissions without cancelling or retrying accepted provider work, while keeping provider reconciliation and duplicate locks intact.

## v1.0.825

- Stops every not-yet-submitted GenStudio request for the same API key after an insufficient-credit response, while already accepted work continues to settle normally.
- Preserves completed Scene Plan prompts and generated assets, prevents automatic repair or later batch items after the credit floor, and makes Retry resume only missing work after the balance increases.
- Records a refused request as failed before dispatch instead of invalid model output, and safely starts fresh work after a proven pre-dispatch credit refusal rather than looking up a provider job that never existed.
- Adds stage-aware Scene Plan restart auditing so recovered visual and motion prompt jobs are marked complete only when their required saved prompts verify on disk.

## v1.0.824

- Made six-modality GenStudio cancellation authoritative: only published pre-dispatch work can receive the single provider cancellation request, including Chat and Music, while dispatched Video work continues settling.
- Made restart recovery read only through the persisted idempotency key for every supported modality, retaining sibling locks until authoritative terminal evidence arrives and never creating replacement paid submissions.
- Preserved exact GenStudio dispatch and settlement facts in durable job evidence and Jobs displays, without inferring refunds, releases, charges, or provider outcomes.

## v1.0.823

- Made cancellation settlement displays truthful by using the provider-published direct release amount when account history is unavailable, while keeping account history authoritative when present.
- Added live GenStudio standard-lane, temporary boost, and service-tier context to Jobs without turning published display capacity into a dispatch promise.
- Made Research and disabled optional production stages truthful: Research never blocks completion, claim-review outcomes remain visible, and disabled stages report complete without invented sidecars.
- Made Motion Review select, persist, and submit an exact live published duration/resolution variant, preserving that pair through durable retries and rejecting stale selections before provider work starts.
- Retired obsolete format-contract vocabulary and remapping while keeping the active Continuity Engine contract and independent B-Roll and Image Pool workflows clear.

## v1.0.822

- Made job controls financially truthful: cancellation, local stopping, provider cancellation requests, reconciliation, and history removal are now distinct actions.
- Preserved provider cancellation outcomes and resumed pending reconciliation safely after restarts without duplicate generation.
- Added visible explanations for duplicate, prerequisite, reconciliation, post-dispatch, and missing-only generation guards.

## v1.0.821 — 2026-08-11

- **Music catalogue access is now verified before production starts** — Settings names the
  required `music:generate` scope, and the read-only key test checks the music catalogue directly
  so a missing scope is reported before Sound Design or another music workflow needs it.

## v1.0.820 — 2026-08-11

- **Interrupted language work now recovers without replacement charges** — outline, chapter,
  listicle, and narrative-repair retries use their recorded GenStudio idempotency keys to look up
  the original durable job. Missing or ambiguous history remains safely blocked, while confirmed
  terminal failures can start one deliberate replacement request.

- **Settings now reports the live GenStudio music catalogue** — the retired standalone voice
  diagnostic has been replaced by Music models, including published provider details and clear
  coming-soon status. The existing TTS model diagnostics remain unchanged.

## v1.0.819 — 2026-08-11

- **Interrupted chapter expansions can always be reconciled safely** — when several earlier
  attempts still contain unresolved GenStudio evidence, Story Studio replays those exact request
  identities first instead of deadlocking or starting replacement work. A newly selected model is
  used only after every older submission has settled.

## v1.0.818 — 2026-08-11

- **Approved episode direction now survives the complete script workflow** — outline edits keep
  their generation snapshot, chapter expansion and regeneration reuse the saved guidance, and
  affected v1.0.817 sidecars preserve any recoverable snapshot.

- **Manual chapter recovery is safe and usable** — fully settled failures can receive one fresh
  retry identity, while pending or mixed provider evidence reattaches with the original model and
  request identity. Partial chapter progress refreshes after every terminal outcome.

## v1.0.817 — 2026-08-11

- **Production release qualification is now deterministic** — the selected-model TTS fan-out check
  uses an in-process submission barrier instead of a timing window, while preserving the serialized
  pre-submit durability writes that protect recovery and prevent duplicate paid work. Production
  runtime behavior is unchanged.

## v1.0.816 — 2026-08-11

- **Web research evidence is now more transparent** — provider-reported source URLs stay with the run and appear as evidence without incorrectly claiming that a source-less result has no sources. Only safe HTTP(S) links are clickable.

- **GenStudio capacity and job states now fail safely and read clearly** — temporary or malformed capacity data limits submissions to five per minute, while real job states use clear labels.

- **TTS now follows each selected model's published submit concurrency** — missing or invalid values remain serial, while supported providers can process sections faster without inferring capability from the provider name.

## v1.0.815 — 2026-08-11

- **Image Generator episode loading now scales cleanly** — each episode exposes exact planned scene-image counts from the existing status scan, so all-image completion no longer depends on Scene Review approval and the extension no longer needs an episode-by-episode recount.
