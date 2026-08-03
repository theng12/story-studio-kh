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
| 4 | Small gaps for live credit display | `pricing-display-request.md` | **OPEN — but no longer blocking.** Story Studio shipped live cost display for image, batch and chat in v1.0.770 using the fields that do publish. Remaining asks are audit-trail quality, not correctness: `price_version` missing on voice and music; `minimum_credits` missing on voice and image. Gap 1 (chat estimate) is **settled as option (a)** — Story Studio shows the published rate plus the actual charge and states that the total depends on length. (b) or (c) can still be adopted with no redesign. |
| 5 | Say which layer applied backpressure | `rate-limit-reason-request.md` | **ANSWERED — shipped.** Language HTTP 429 responses now include a provider-agnostic `capacity_reason` and `retry_after_seconds`, with matching `Retry-After` and `X-GenStudio-Capacity-Reason` headers. |
| 6 | Publish transcription language support | `transcription-language-request.md` | **OPEN.** Needed so the language picker can be driven by the catalogue instead of a hardcoded list. |
| 8 | Own the per-model step default (FLUX 2 Klein = 4) | `image-steps-default-request.md` | **ANSWERED — shipped.** GenStudio owns fixed steps server-side; FLUX.2 Klein uses 4. Story Studio correctly sends no `steps` field. |
| 9 | Publish per-model voice controls | `voice-controls-request.md` | **SENT 2026-08-01 — awaiting reply.** Story Studio shows Stability and Similarity sliders that reach nothing — the TTS job body is `{voice_id, text, speed}`. Each engine takes different expression parameters (ElevenLabs, Fish Audio, Chatterbox and Google all differ), and Story Studio deliberately cannot see which engine serves a model, so only GenStudio can publish this. Asks for a per-model `controls[]` with name, range, default and label, following the `ChatModelResponse.controls` precedent. A "no" is useful — the sliders get deleted. |
| 10 | Make the quote text limit follow the model | `quote-limit-request.md` | **SENT 2026-08-01 — awaiting reply.** `TTSQuoteRequest.text` is fixed at `maxLength: 40000` while `maximum_input_characters` is per model. A model publishing more than 40,000 cannot be quoted. Preference is to align the two rather than add a field. Not blocking — Story Studio quotes per generation chunk, which matches how the jobs are actually billed. |
| 11 | Publish the serving provider on every modality | `provider-disclosure-request.md` | **OPEN.** Provider is published for voice (`provider`/`engine_*`/`model_family`), TTS models (`provider_id`/`provider_name`) and transcription (`provider`), but not for chat, image, video or music. Story Studio shows it wherever published and refuses to infer it anywhere, so the same product is candid on some pickers and silent on others. Asks for the `provider_id` + `provider_name` pair the TTS work already established. A "no" is a fine answer — the awkwardness is only that the split has no stated reason. |
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
