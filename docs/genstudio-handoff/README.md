# GenStudio handoff

Everything Story Studio is waiting on from GenStudio, in one place.

**This folder is disposable.** When every item below is ANSWERED and the work has
shipped, delete the whole folder — nothing in Story Studio imports or depends on it.
Five items closed out that way on 2026-08-28 (moved to `docs/handoffs-retired/` rather than
deleted, so the shipping evidence survives). Four items remain genuinely open; five files
stay here specifically because a code comment still cites their exact path by name — see each
file's own status header.

Each file is written to be sent as-is. No preamble needed.

---

## Status

**Re-verified against the tree 2026-08-28** (see `docs/handoffs-retired/` for items closed out
below — moved there rather than deleted, each with a one-line closing note and its shipping
commit).

| # | Ask | File | Status |
|---|---|---|---|
| 1 | Split language products into web-capable and offline | `web-search-request.md` | **CONTRACT SHIPPED — runtime activation pending.** Unchanged since 2026-08-10: `research_qualified` confirmed still `false` on every product today. Still genuinely open on the runtime half. Left in place — cited by path in `genstudio-client.ts` and a test. |
| 2 | Citation response shape | `citation-response-request.md` | **CONTRACT SHIPPED, contract still governs the code.** Envelope shape (`citations`, `research_ran_at`, `web_searches_executed`, `web_search_credit_cost`, `citation_claims`, no `retrieved_at`) confirmed unchanged and actively implemented. Left in place — historically valuable, no better home for the rationale. |
| 3 | Image resolution and variant pricing | *(moved to `docs/handoffs-retired/image-options-request.md`)* | **RETIRED 2026-08-28.** Confirmed shipped both sides, unchanged since 2026-08-10. |
| 4 | Small gaps for live credit display | `pricing-display-request.md` | **PARTIAL, progressed.** Gap 3 (`minimum_credits` on image) now shipped. Gap 2 (`price_version`) shipped on music, still missing on the TTS model row itself (only the TTS *quote* carries it). Gap 1 (chat cost estimate) unchanged — still option (a) only. Left in place — cited by path in `tts-request-plan.ts`... *(see file for the exact citing module)*. |
| 5 | Say which layer applied backpressure | *(moved to `docs/handoffs-retired/rate-limit-reason-request.md`)* | **RETIRED 2026-08-28.** Confirmed shipped, unchanged since 2026-08-10. |
| 6 | Publish transcription language support | `transcription-language-request.md` | **PARTIAL, progressed — and a stale comment found.** `supports_language_auto_detect` now has real consumption logic (`subtitles.ts`, shipped 2026-08-10). But the `supported_languages[]` doc comment in `genstudio-client.ts` still says unpublished, dated 2026-07-31 and never updated — contradicts this folder's own 2026-08-10 "shipped" claim. See the file's own status header for detail. Left in place — cited by path in code. |
| 7 | Let the server control job-poll cadence | *(moved to `docs/handoffs-retired/job-poll-hint-request.md`)* | **RETIRED 2026-08-28 — this was actually shipped**, contradicting the OPEN status this table carried. `readGenStudioPollHintMs()` reads GenStudio 1.2's `retry_after_seconds`/`retry_at` at 3 call sites (shipped 2026-08-13, three days after this table was last touched). |
| 8 | Own the per-model step default (FLUX 2 Klein = 4) | *(moved to `docs/handoffs-retired/image-steps-default-request.md`)* | **RETIRED 2026-08-28.** Confirmed shipped, unchanged since 2026-08-10. |
| 9 | Publish per-model voice controls | *(moved to `docs/handoffs-retired/voice-controls-request.md`)* | **RETIRED 2026-08-28.** Confirmed shipped both sides, unchanged since 2026-08-10. |
| 10 | Make the quote text limit follow the model | `quote-limit-request.md` | **More resolved than "on the customer path" suggests.** A code comment in `tts-request-plan.ts` confirms GenStudio removed the fixed 40,000-char cap this ask was about — the core request was granted. C3 (legacy `/v1/models` literal) is unverifiable from this repo. Left in place — cited by path in code. |
| 11 | Publish the serving provider on every modality | `provider-disclosure-request.md` | **OPEN — and the remaining gap is ours, not GenStudio's.** GenStudio publishes `provider_name` for all five model kinds (verified server-side at `0f8f28c1`). Story Studio's client types declare it on Image, Music and Chat, but not on `GenStudioTranscriptionModel` or `GenStudioVideoModel`, and neither `listVideoModelsSnapshot` nor `listTranscriptionModelsSnapshot` reads it — so for those two the field arrives and is discarded. Client-side declaration is the remaining work. |
| 12 | A distinct reason code for content refusals | `content-refusal-code-request.md` | **ANSWERED — shipped both sides 2026-08-28.** GenStudio publishes `failure_class` (`content_refused` / `provider_transient` / `provider_error`) plus a display-only `failure_reason`. Story Studio branches on the class and never on the reason's wording. Content refusals are not charged — the reservation is released. This ask was never listed in this table until now. |
| 13 | The endpoint moved to `gateway-kh` on `:8010` | `gateway-kh-replacement-endpoint.md` | **ANSWERED 2026-09-18.** Repoint, do not rewrite. Story Studio's saved `genstudio_url` is already `:8010`, and the full key-probe passes 13/13 against the live gateway — verified, not assumed. Scopes are gone and nothing here read them. |
| — | Story Studio's reply: verified state, two asks, owner decisions | `gateway-kh-story-studio-wiring.md` | **NEW 2026-09-18.** Confirms nullability is already safe, withdraws an earlier `/v1/content/account` concern (the route exists), and asks only that `maximum_input_characters` may move to `null` once the renderer is fixed. Lists five Story-Studio-side fixes and three owner decisions. |
| 14 | What should happen when a provider states no output-token limit? | `max-output-tokens-unstated-request.md` | **OPEN 2026-09-18 — referred by the owner.** `null` currently makes a model unusable (Story Studio refuses to invent a ceiling), so the owner asked gateway-kh to determine which rows are affected and to *test* whether a real generation succeeds, rather than reason about it. A plain "no stated limit" is an acceptable answer. |
| 15 | Catalogue routes answer with an envelope, not the array Story Studio reads | `catalogue-envelope-contract-break.md` | **FIXED ON OUR SIDE 2026-09-18 (v1.4.172), OPEN ON THEIRS.** Every catalogue refresh was failing silently while the last-good cache kept the pickers populated on data 7 hours old. Story Studio now accepts both shapes as a safety net — but which shape is canonical is gateway-kh's call to state. Also reports the Suno V6 music row being silently dropped for omitting nine nullable fields. |

---

## Notes for whoever picks this up

**Story Studio never infers capability from a product's name.** Every one of these asks
exists because Story Studio refuses to guess. If GenStudio doesn't publish something, the
control is hidden or the value shows as "not reported" — it is never invented locally, and
customer charges are never computed on this side.

**Reconciled 2026-08-10:** GenStudio 0.79 removed the Relaxed entitlement and its
`unlimited_relaxed`/`relaxed_concurrency_limit` fields with no replacement. Story Studio has
removed the retired parser, grouping, badge, and account-access surfaces. Do not recreate a
free/paid model distinction unless GenStudio publishes a new authoritative contract.

**A "no" is a useful answer.** Several of these explicitly say what Story Studio will do if
the answer is no, so GenStudio can decline without blocking anything. `retrieved_at` was
declined for exactly the right reason and that resolved the question rather than leaving it
open.

**One correction worth carrying forward.** GenStudio diagnosed a chapter-generation failure
as Story Studio overriding its transport config to the synchronous route. There was no
override — the running build simply predated the durable-route code. The fix was already
written and unshipped. Worth checking the installed version before concluding a setting is
wrong.
