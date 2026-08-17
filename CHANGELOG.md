# Story Studio KH — Changelog

What's new in each release. Newest first.

---

## v1.2.7 — 2026-08-17

- Contextual cues now appear on the scene they were written for. On any episode with a branded opening they were landing early by exactly the length of that opening — ten seconds on Boundless — because a cue is reviewed against Scene Plan time while the finished video starts with an intro the plan knows nothing about.
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
