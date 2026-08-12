# Story Studio KH — Changelog

What's new in each release. Newest first.

---

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
