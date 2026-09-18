# The GenStudio endpoint on this Mac has moved to `gateway-kh`

**Status: ANSWERED. Repoint, do not rewrite.** This is a drop-in replacement for the
GenStudio endpoint — the contract is unchanged on purpose, which was the whole design
goal. Story Studio needs `genstudio_url` and a key, and nothing else.

Answers to the five questions raised in `docs/genstudio-handoff/README.md`'s sibling
thread, in order.

---

## 1. Transport

Still **loopback HTTP**. No unix socket, no sidecar to bundle, no new path prefix.

| | |
|---|---|
| Base URL | `http://127.0.0.1:8010` (was `...:8000`) |
| Routes | at the root — `/v1/models`, `/v1/voices`, … unchanged |
| Encryption | none, because it is loopback; unchanged in kind from before |
| Lifecycle | a **menu bar app** (`gateway-kh.app`) supervises the service |

`genstudio_url` in `app-settings.json` is already set to `:8010` and confirmed working:
the gateway has recorded `GET /v1/account/overview → 200, authenticated: true` arriving
from Story Studio unprompted. The old GenStudio is **still listening on 8000** and is
untouched, so a settings reset is the one way this regresses.

## 2. Auth

**Same shape, and one thing removed: scopes.**

- One API key, held in Story Studio's app secret store, sent as
  `Authorization: Bearer <key>`. Unchanged.
- **The key carries no scopes, and the gateway reads none.** A key with scope claims is
  not a superset — it is simply a different string and is rejected. Verified: a
  scoped-format token returns 403; the configured key returns 200.

**Action for you:** treat the key as opaque and do not require scope claims from it. If any
Story Studio surface gates a control on the key's scopes being present, that check will
fail against this endpoint — that is the one place this change can bite. The gateway is
single-owner, so scopes never carried authority here anyway.

`401` means no bearer was sent; `403` means the bearer is wrong. **There is no 402 on this
endpoint, ever** (see §4).

## 3. Catalogue compatibility

**Paths and payload shapes are unchanged. `genstudio-client.ts` should be repointed, not
rewritten.** 46 `/v1/*` routes are implemented, including the ones with awkward shapes
that were easy to get wrong:

- models: `/v1/models` plus the per-kind `/v1/{chat,image,video,tts,transcription,music}/models`
- generation: `/v1/chat/responses`, `/v1/images/generations`, `/v1/videos/generations`,
  `/v1/music/generations`
- the split flows: `/v1/tts/quotes` → `/v1/audio/jobs`,
  `/v1/audio/transcriptions/quotes` → `.../confirm`, `/v1/transcriptions/{id}/srt`
- `/v1/voices` and `/v1/voices/{id}/save`
- `/v1/account/overview`, `/v1/account/jobs`, `/v1/account/credit-activity`
- idempotency reattach on every job kind (`.../by-idempotency-key/{key}`)

If anything reads differently, that is a bug on **this** side and I want it reported
rather than worked around — the contract is verified by a 111-check suite that drives it
the way Story Studio does.

## 4. What replaces credits in job payloads

**Fields present, always zero. Not absent, not null, not a different unit.**

This is deliberate and load-bearing. Your parsers build explicit object literals and
**drop any row whose price fields are absent** — so omitting pricing does not yield
"unpriced but working" models, it yields an empty picker. The shape of a priced catalogue
is therefore published with every amount pinned to zero:

- catalogue rows: `credits_per_*: 0` for the modality's unit
  (`credits_per_1000_characters`, `credits_per_image`, `credits_per_video`,
  `credits_per_request`, `credits_per_second`, `input/output_credits_per_million_tokens`),
  plus `minimum_credits: 0`, `price_version: "flat"`, `chargeable: true`, `cost_tier`
- settlements: a balanced `reserved_credits: 0, settled_credits: 0, released_credits: 0`
- `account/overview`: `credit_balance: 0`, `credits_used_30d: 0`, `currency: "credits"`,
  `lifetime_paid_cents: 0`, `tier: "owner"`, `service_tier: "owner"`,
  `paid_concurrency_limit: 4`

**Never 402.** Your credit lock is keyed on the API key and, with no published balance, a
402 never clears — the key would be dead permanently. A provider running out of funds
surfaces as a settled `failed` job instead. The 111-check suite asserts that no response in
a whole run is 402.

Your rule — a limit that is enforced must also be shown — is satisfied honestly: `0` is a
*reported* value here, not an invented one. "Not reported" is still correct where a field is
genuinely absent, and nothing in this catalogue is absent-but-meaning-zero.

## 5. The pivotal one: Studio Hub is a **sibling app Story Studio never talks to**

**No boundary change. No test rewrite.** This is the answer that matters most.

Story Studio talks to **one** endpoint and treats it as GenStudio. Studio Hub — including
every additional location you may connect later — sits **behind** that endpoint and is
never addressed by Story Studio. Your `AGENTS.md` rule that Story Studio must not restore
direct Studio Hub or sibling-Studio routing is not weakened by this change; it is enforced
more strongly, because the gateway is now the only thing that even knows the locations'
addresses.

Concretely: adding a third or fourth Studio Hub machine adds model rows to the same
catalogue and routes work through the same dispatch path. Story Studio sees one catalogue
and one endpoint, and must **never** be handed a second address.

---

## The `paid_*_replacement` question — yours to decide, with our facts

You are right that `image-paid-replacement.ts`, `generation-paid-replacement.ts` and
`subtitle-paid-replacement.ts` lose their footing: `additional_credit_ceiling` authorizes a
*charge*, and nothing here charges. Showing a customer a credit ceiling for something free
is indeed the same lie in reverse.

From this side:

- **Failed work costs provably nothing.** A failed job settles at a balanced zero, which is
  exactly the proof your free-retry logic wants. So a failed artifact can simply be
  re-submitted — a new job with a new idempotency key — with no authorization step.
- **The capability survives; the billing rationale does not.** If "replace this bad
  artifact" is a real user need, the action can stay and the ceiling should go.
- **Watch the zero balance, not the ceiling.** All jobs cost `0` and `credit_balance` is
  `0`, so `0 < 0` is correctly false. But any surface that gates on "balance **> 0**" would
  block a free operation. That is the specific shape of bug worth grepping for.

Remove, hide, or keep inert is your call and I have no preference to impose — the endpoint
supports all three.

## `pricing-display-request.md` is now moot — and its gaps are closed

All three gaps it lists are published by this endpoint, verified per modality across all 86
live rows:

- **Gap 1** (chat cost estimate): chat rows publish `input_credits_per_million_tokens: 0`
  and `output_credits_per_million_tokens: 0`, so an estimate is computable.
- **Gap 2** (`price_version` on the TTS model row itself): published — `"flat"`.
- **Gap 3** (`minimum_credits` on image): published — `0`.

## A bug your ask #11 found on our side

Your note that GenStudio publishes `provider_name` for all five model kinds, and that
Story Studio is about to declare it on the transcription and video model types, was worth
more than a status line: **this endpoint was not publishing it for those two.**

- video rows published **no provider field at all**
- transcription model rows published only `provider`, a different key

Both would have read as a blank provider the moment you added the declaration — a silent
failure, since the row still parses. Fixed: every kind now publishes `provider_name`, and
transcription keeps `provider` as well so any existing reader is unaffected. There is now a
check that fails if any row of any kind lacks `provider_name`.

(Note this is about **model** rows. Voice rows carry `provider`, which is their own field
and is unchanged.)

---

## Two fabrication bugs your rules caught

Your `AGENTS.md` states the rule plainly — *never let "the answer is none" and "I could not
work out the answer" produce the same value*, and *never a number the customer will mistake
for the model's own*. Applying it to this catalogue found two violations, both now fixed:

1. **`context_window_tokens: 0` on 37 of 66 chat rows.** Not "not published" — a claim that
   the model accepts nothing, which is the same value as a genuine limit of zero. Unknown now
   publishes **`null`**, matching the `max_prompt_characters` / `max_reference_images` fields
   in the same row that already did this.

2. **`max_output_tokens` was hardcoded to `8192` for every model on every provider.** The
   providers do publish a real figure (`top_provider.max_completion_tokens` on 439 of
   OpenRouter's 445 models); discovery was discarding it. Now published per model, with
   `null` where a provider states none. Live examples: `943718`, `384000`, `65536`.

**Please confirm your readers treat both as nullable.** They already handle `null` for the
sibling fields above, and your rule says an unpublished limit shows nothing rather than a
number — but these two fields previously always arrived as integers, so any arithmetic on
them (`context - output`) would newly see `null`. That is worth a look before wiring.

Both would have been invisible: a row parses fine with a fabricated allowance, and the only
symptom is that a model's stated limits are wrong in a plausible-looking way.

## Three language bugs, one of which needed your rules to see

`transcription-language-request.md` and your `AGENTS.md` between them exposed three defects in
how this endpoint described languages.

1. **Transcription claimed `language: "en"`, `supported_languages: ["en"]` *and*
   `supports_language_auto_detect: true`** — self-contradictory (a model that knows only English
   cannot detect language) and false: these are MLX Whisper models, multilingual and
   auto-detecting by construction.

   Nothing in the stack publishes a language list — not the Hub's model packages, not
   `/api/hub/capabilities` (its per-worker `models` array is empty in standalone packaging, as
   this gateway already documents), not the model manifest. So the row now publishes **your own
   sentinel**: `language: "multilingual"` with `supported_languages: []`.

   **Empty rather than absent deliberately**, because your rule is that a model publishing
   neither a concrete language nor auto-detect *"has no valid submission state"* — dropping the
   fields entirely would have been worse than the bug.

2. **TTS `supported_languages` contained stringified Python objects.** ElevenLabs publishes 32
   languages as `{"language_id": "af", "name": "Afrikaans"}`, and this endpoint flattened them
   with `str()`, publishing `"{'language_id': 'en', 'name': 'English'}"` as a language name. You
   type the field `string[]` and join it into a customer-visible line
   (`audio.vue`: `` `Languages ${model.supported_languages.join(', ')}` ``), so the narration
   page would have read "Languages {'language_id': 'en', …}". Now `['en','ja','zh','de', …]` —
   32 real codes.

3. **Rows whose provider states no languages claimed `["en"]`.** False for Qwen3, VoxCPM2,
   OmniVoice and Fish, none of which are English-only. They now publish `[]`. Your renderer
   guards on `.length`, so an empty list shows nothing rather than a lie.

**One field I deliberately did *not* stop publishing.** `maximum_input_characters` (40,000) is
also not stated by any provider, so by the same rule it should be omitted — but `audio.vue`
calls `model.maximum_input_characters.toLocaleString()` **unconditionally**, so a `null` there
would crash the page rather than degrade it. It stays a number until you can accept null. Say
the word and I will move it.

**And one thing I checked that was *not* a bug.** Every ElevenLabs voice publishes
`language: "en"`, which looks like the same class of defect — but ElevenLabs genuinely returns
`labels.language: "en"` for all 41 of them. That is provider data being reported, not invented.
Only voices whose source states nothing fall back, and those now fall back to `"multilingual"`
rather than `"en"`.

## Housekeeping

The graph being 9 days stale is worth fixing before wiring, since this handoff is precisely
a map-of-the-boundary question — but that is your call and no answer here depends on it.
