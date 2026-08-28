# GenStudio handoff

Everything Story Studio is waiting on from GenStudio, in one place.

**This folder is disposable.** When every item below is ANSWERED and the work has
shipped, delete the whole folder — nothing in Story Studio imports or depends on it.

Each file is written to be sent as-is. No preamble needed.

---

## Status

| # | Ask | File | Status |
|---|---|---|---|
| 1 | Split language products into web-capable and offline | `web-search-request.md` | **CONTRACT SHIPPED — runtime activation pending.** GenStudio published `supports_web_search`, `returns_citations`, `citation_format`, `supports_domain_filters`, `research_qualified`, `web_search_credits_per_search`, `max_web_searches`, `web_research_credits_per_request`. Story Studio built against them in v1.0.764. **Still waiting on:** a qualified direct-provider research route becoming runnable; until then `research_qualified` remains false and web research stays unavailable by design. |
| 2 | Citation response shape | `citation-response-request.md` | **CONTRACT SHIPPED — runtime activation pending.** Citations arrive in the response envelope; the field names are `research_ran_at`, `web_searches_executed`, and `web_search_credit_cost`, wired in v1.0.765. Per-source `retrieved_at` is deliberately not provided — Story Studio uses run-level "Research ran on". `citation_claims` exists but providers do not currently populate it, so citations display per run, not per claim. `research_qualified` already represents an effective customer-runnable route; Story Studio may also defensively filter `!qualification_only`. |
| 3 | Image resolution and variant pricing | `image-options-request.md` | **CLOSED — shipped both sides.** `default_resolution` and `output_options[]` publish, `ImageGenerationRequest` accepts `resolution`, and Story Studio's selector shipped in v1.0.770. Each published row is offered verbatim with its own price; combinations are never synthesised by crossing lists. |
| 4 | Small gaps for live credit display | `pricing-display-request.md` | **PARTIAL — not blocking.** Story Studio uses model catalogues, quotes, and settled jobs only. The retired `unlimited_relaxed` field is gone. Remaining audit-quality asks: `price_version` on TTS/music model rows and `minimum_credits` on image rows. Chat remains option (a): published rates plus actual settled charge, with no locally invented total. |
| 5 | Say which layer applied backpressure | `rate-limit-reason-request.md` | **ANSWERED — shipped.** Language HTTP 429 responses now include a provider-agnostic `capacity_reason` and `retry_after_seconds`, with matching `Retry-After` and `X-GenStudio-Capacity-Reason` headers. |
| 6 | Publish transcription language support | `transcription-language-request.md` | **PARTIAL.** `supported_languages[]` ships and drives Story Studio's picker. Still open: `supports_language_auto_detect` and `detected_language`. Until those publish, Story Studio sends an explicit published language and does not offer auto-detect. |
| 8 | Own the per-model step default (FLUX 2 Klein = 4) | `image-steps-default-request.md` | **ANSWERED — shipped.** GenStudio owns fixed steps server-side; FLUX.2 Klein uses 4. Story Studio correctly sends no `steps` field. |
| 9 | Publish per-model voice controls | `voice-controls-request.md` | **ANSWERED — shipped both sides.** `/v1/tts/models` publishes `controls[]` with names, ranges, defaults, labels, and descriptions. Story Studio renders and submits only the selected model's published controls and re-clamps state on model change. |
| 10 | Make the quote text limit follow the model | `quote-limit-request.md` | **ANSWERED on the customer path.** `/v1/tts/models.maximum_input_characters` drives quote and submission validation. Story Studio consumes that endpoint. GenStudio still needs to correct the contradictory legacy `/v1/models` literals, tracked there as C3. |
| 11 | Publish the serving provider on every modality | `provider-disclosure-request.md` | **CLOSED — verified already shipped 2026-08-28.** All five remaining modalities publish `provider_name`; video and transcription populate it via `origin_provider_name()` at `videos/router.py:284` and `transcriptions/router.py:367`. The table in the request body was stale. A scalar shipped rather than an operation-aware shape, because a product's maker does not vary by operation. |
| 12 | A distinct reason code for content refusals | `content-refusal-code-request.md` | **ANSWERED — shipped both sides 2026-08-28.** GenStudio publishes `failure_class` (`content_refused` / `provider_transient` / `provider_error`) plus a display-only `failure_reason`. Story Studio branches on the class, never on the wording. Content refusals are **not charged** — the reservation is released. A category hint was declined: upstream gives a refusal signal, not a taxonomy, and synthesising one was explicitly out of scope. This ask was never tracked in this table until now. |
| 7 | Let the server control job-poll cadence | `job-poll-hint-request.md` | **OPEN.** Load-shape, not correctness. Story Studio is shipping capped backoff with jitter regardless; a `poll_after_ms` hint would let GenStudio widen intervals under load with no client release. Relevant once hosted customer count grows. |

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
