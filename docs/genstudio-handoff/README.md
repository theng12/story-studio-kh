# GenStudio handoff

Everything Story Studio is waiting on from GenStudio, in one place.

**This folder is disposable.** When every item below is ANSWERED and the work has
shipped, delete the whole folder — nothing in Story Studio imports or depends on it.

Each file is written to be sent as-is. No preamble needed.

---

## Status

| # | Ask | File | Status |
|---|---|---|---|
| 1 | Split language products into web-capable and offline | `web-search-request.md` | **ANSWERED — shipped.** GenStudio published `supports_web_search`, `returns_citations`, `citation_format`, `supports_domain_filters`, `research_qualified`, `web_search_credits_per_search`, `max_web_searches`, `web_research_credits_per_request`. Story Studio built against them in v1.0.764. **Still waiting on:** `research_qualified` being flipped true on a real model. Until then web research shows as unavailable by design. |
| 2 | Citation response shape | `citation-response-request.md` | **MOSTLY ANSWERED.** Citations confirmed in the response envelope; real field names given (`research_ran_at`, `web_searches_executed`, `web_search_credit_cost`) and wired in v1.0.765. Per-source `retrieved_at` deliberately not provided — Story Studio uses run-level "Research ran on". `citation_claims` exists but providers don't populate it, so citations display per run, not per claim. **Open: Q8** — should `qualification_only` be a sixth condition in the research filter? |
| 3 | Image resolution and variant pricing | `image-options-request.md` | **ANSWERED — shipped by GenStudio.** `default_resolution` and `output_options[]` now publish, and `ImageGenerationRequest` accepts `resolution`. Story Studio is carrying the fields through the transport; the selector UI is a separate task awaiting the owner's go-ahead. |
| 4 | Small gaps for live credit display | `pricing-display-request.md` | **OPEN.** Three items: `price_version` missing on voice and music; `minimum_credits` missing on voice and image; and whether a chat cost estimate is feasible (chat is token-priced, so cost can't be known before a run — TTS and transcription have quote endpoints, chat doesn't). |
| 5 | Say which layer applied backpressure | `rate-limit-reason-request.md` | **OPEN.** Every capacity refusal reads identically, so a customer nowhere near their limits sees the same message as one who is genuinely over quota. |
| 6 | Publish transcription language support | `transcription-language-request.md` | **OPEN.** Needed so the language picker can be driven by the catalogue instead of a hardcoded list. |
| 8 | Own the per-model step default (FLUX 2 Klein = 4) | `image-steps-default-request.md` | **OPEN — time-sensitive.** Story Studio's next release stops sending `steps`. GenStudio should apply 4 for FLUX 2 Klein server-side before that reaches customers, or its output could change with no visible cause. |
| 7 | Let the server control job-poll cadence | `job-poll-hint-request.md` | **OPEN.** Load-shape, not correctness. Story Studio is shipping capped backoff with jitter regardless; a `poll_after_ms` hint would let GenStudio widen intervals under load with no client release. Relevant once hosted customer count grows. |

---

## Notes for whoever picks this up

**Story Studio never infers capability from a product's name.** Every one of these asks
exists because Story Studio refuses to guess. If GenStudio doesn't publish something, the
control is hidden or the value shows as "not reported" — it is never invented locally, and
customer charges are never computed on this side.

**A "no" is a useful answer.** Several of these explicitly say what Story Studio will do if
the answer is no, so GenStudio can decline without blocking anything. `retrieved_at` was
declined for exactly the right reason and that resolved the question rather than leaving it
open.

**One correction worth carrying forward.** GenStudio diagnosed a chapter-generation failure
as Story Studio overriding its transport config to the synchronous route. There was no
override — the running build simply predated the durable-route code. The fix was already
written and unshipped. Worth checking the installed version before concluding a setting is
wrong.
