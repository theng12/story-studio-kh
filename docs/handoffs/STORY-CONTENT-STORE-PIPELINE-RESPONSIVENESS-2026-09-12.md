# Content Store and Pipeline responsiveness follow-up

## Owner report

Content Store loading and purchasing are slow. Installation provides insufficient visible download/status feedback, and it is unclear how to leave it running in the background. Pipeline confirmation is also slow; the owner does not know whether Story Studio, GenStudio or both are responsible. Investigate and fix, preserving purchasing, installation and generation safeguards.

Owner requested efficient work with only 3% usage remaining and preferred a concrete handoff over incomplete implementation. This pass was read-only except for this handoff; no performance fix, measurement, live purchase or installation was performed.

## Avoid duplicating completed work

Read `docs/handoffs/STORY-SCENE-REVIEW-UPLOAD-PERFORMANCE-2026-09-12.md` first: Claude updated it after merging PR111/version1.4.152. It includes Content Store improvements as well as Scene Review/Upload Center. Its final record says the app was still running1.4.151 at that time; verify the actual running version now, rather than assuming it remains unchanged. Do not redo that batch.

Repository: `/build/Developer/story-studio-kh`. Re-read applicable AGENTS.md, Git state and current logs. Preserve unrelated untracked critique and existing handoff files.

## Preliminary evidence, not a confirmed performance diagnosis

- `frontend/composables/useContentInstallQueue.ts` now owns an app-wide queue at module scope. It is designed to continue across page navigation and refresh overview once at completion and periodically during long batches.
- `frontend/components/content-store/ContentInstallStrip.vue` renders from the default layout. It shows done/total, failed count and active pack title. It has a Dismiss control after completion. It does not expose byte-level download percentage. Module-scope persistence is not evidence of survival after app exit/restart; verify and describe that distinction accurately.
- The completed handoff notes an outstanding detail-page issue: `ContentProductDetail` lacks queue-status props, so Install can remain enabled until the next overview. Check whether this is still present.
- Prior profiling found repeated reads/parses of a571KB settings file and repeated pack verification in overview; per-version pack verification memoization was added. Live Content Store after-measurements were not obtained because isolated processes could not use the Electron Keychain-bound key. These are investigation leads, not permission for a broad cache rewrite.
- `frontend/pages/projects/[slug]/pipeline.vue`, `openConfirm()`, awaits POST `/projects/:slug/pipeline/preflight`; `submit()` separately awaits `/pipeline/run-batch`.
- `electron/server/routes/pipeline.ts`, `preflightBatch()`, reads config, accepted ideas, effective format, per-episode visual settings/status and available storage. Measure local work and any downstream GenStudio calls separately; do not blame GenStudio without evidence.

## Next complete batch

1. Verify running/build versions and reproduce with representative project and installed pack counts. Capture timings for catalog/overview, purchase acknowledgement, install/download/verification, Pipeline preflight and enqueue separately. Read current logs and use request correlation/timing to attribute delays to UI, Story local processing or GenStudio.
2. Verify1.4.152 background queue/strip in the actual UI before adding another mechanism. Make background behavior obvious and maintain status when navigating away. Update detail-page install eligibility from the existing queue where needed.
3. Show truthful installation phases: queued, downloading, verifying, installing, complete or failed. Use real bytes/total for percentages only when available; otherwise show indeterminate progress with phase. Do not fake percentage. Preserve archive/signature/entitlement checks and safe installation writes.
4. Trace purchase slowness separately from post-purchase install/overview refresh. Give prompt visible acknowledgement, prevent duplicate purchase on repeated clicks, preserve reconciliation for uncertain outcomes, and show recoverable errors. Do not issue live paid calls for tests.
5. Pipeline should show its confirmation/checking interface promptly, with the scope and progress/state visible while validation runs. Submission stays disabled until valid preflight. Prevent duplicate submissions and stale results after project, episode or stage changes. Optimize only measured duplicated/serial work; preserve readiness, partial eligibility, disk-space, model and billing checks. Keep queued-job receipt and deliberate navigation behavior.
6. Test large batches, slow/failing network, repeated clicks, project switches, leaving/reopening Store, partial install failure, stale entitlement/catalog state and Pipeline mixed eligible/blocked episodes. Measure before/after using identical conditions and inspect rendered desktop/narrow layouts.
7. Independently review, run required local verification, follow application version/changelog rules and standing authorized repository integration/DMG workflow. No hosted CI, live restarts, purchases, paid generation, publication or deployment without separate authority. Do not weaken safeguards to improve latency.

## Deliverable

A complete verified responsiveness/status batch, with measured attribution and before/after timings, clear explanation of what continues in background, remaining limitations and the verified installer path. If GenStudio changes are necessary, prepare a precise API/timing handoff for its existing task; do not modify both repositories speculatively.

## Owner escalation: app-wide lag (highest priority)

The owner subsequently reports slow/lagging behavior throughout the app, materially interrupting work. Broaden diagnosis to shared infrastructure before further page-specific patches. Keep the Content Store and Pipeline requirements above as acceptance scenarios.

Latest screenshots explicitly show version1.4.151. They cannot establish whether1.4.152 fixes work. Verify the actual current running version and coordinate a safe update/testing window without interrupting paid jobs; do not assume screenshot version is still current later.

Observed in screenshots (not reproduced or diagnosed):
- Sidebar remains `Loading channel…` while Jobs is displayed.
- A `This channel has no Series Formula` warning appears during that loading state. Check whether unknown/loading data is being treated as confirmed absence; never advise changing the channel configuration based on this state alone.
- Page route/label shows `brain-wise`, with TN-prefixed episode jobs. This may be valid imported naming, or a project-switch race; verify project ownership and response scope before concluding either.
- Jobs reports account capacity unverified while the global header shows40/50 lanes. Check freshness and differing sources, not merely their displayed numbers.
- Scene Plan jobs show long-running admission/reconciliation states; one screenshot shows129/229 prompts with100 still needing attention, a253-credit hold and provider status not settled. These are not proof of failed provider work or proof of the UI performance cause. Preserve exact request identities and receipts; do not force replacement or replay uncertain work.

Prioritized investigation:
1. Establish a live read-only baseline: renderer responsiveness/long tasks, Electron/backend event-loop delay, process CPU/memory, disk activity, API timing and request frequency. Compare idle versus active jobs and cold versus repeated navigation using the same project.
2. Trace shared project/config/settings loading and polling fan-out first. Prior handoff findings about repeated settings parsing and health polling are leads. Check synchronous work, overlapping pollers, duplicated reads and expensive full-library scans. Identify the largest measured contribution before changing it.
3. Separate local request queue wait/processing from outbound GenStudio latency. Slow basic local reads indicate a different bottleneck from long provider generation; do not attribute both to GenStudio without timings.
4. Fix the measured shared bottleneck using the existing architecture. If settings caching is justified, independently review caller mutation/aliasing, write invalidation, external edits and concurrency. No broad speculative cache or removal of completion/billing/security checks.
5. Preserve visible usable content during background refresh, scope requests to the selected project, and distinguish loading/unavailable from missing data. Verify sidebar, formula notice, capacity header and Jobs state after rapid navigation and slow responses.
6. Report median and worst observed latency for representative navigation, project switching, Jobs interaction, Content Store, Pipeline and upload review under equal load. Set concrete acceptance targets after baseline; do not invent improvement percentages or promise all slowness disappears.

Evidence attachments: `/var/folders/c7/84mt7mc151914_z_2m5jt3sc0000gn/T/codex-clipboard-431e44bb-32c1-4aad-ab17-cec824b6d96a.png` and `/var/folders/c7/84mt7mc151914_z_2m5jt3sc0000gn/T/codex-clipboard-2059c582-0281-47b6-844c-73f0634c0fac.png`. Temporary files may expire; the observations above preserve their relevant content.


## Execution update — responsiveness/storage batch

The owner reset the usage limit and authorized implementation with delegated agents. This handoff’s work is now implemented in `codex/app-responsiveness-storage` for 1.4.153, with all local verification lanes and independent reviews complete. Integration and merged-main artifact results are retained in `logs/responsiveness-storage/release-result.md`. See `docs/planning/2026-09-12-responsiveness-storage.md` for measured causes, implementation, review findings, storage advice, and final release evidence. The running app was verified as 1.4.152 during this work. Health polling was measured at about one request every20 seconds and was not the shared bottleneck; repeated historical Jobs audio hashing was.
