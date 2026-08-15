# Story Studio KH — Changelog

What's new in each release. Newest first.

---

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
