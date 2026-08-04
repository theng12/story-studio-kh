# Handoff from the GenStudio KH session — 2026-08-04

Owner ran the first real end-to-end test of Story Studio against GenStudio KH
tonight. Five things failed. **Two of the five are GenStudio's and are being
fixed there. Three are Story Studio's and are described below with exact
lines.** Nothing was charged for any of tonight's failures.

Story Studio installed version at time of writing: **1.0.784**, HEAD `bc1dca9`.
GenStudio live migration revision: `0249`.

---

## Read this first: the diagnostic lesson

Two of tonight's wrong diagnoses came from **trusting Story Studio's own error
text**. Story Studio reported *"GenStudio KH published no
maximum_input_characters for the selected voice model"*. GenStudio publishes
`40000` for every TTS model and is structurally incapable of returning null for
that field (`resolve_tts_model_product()` has an unconditional `or 40_000`
fallback). The message was manufactured locally from a failure that had nothing
to do with the field.

**The single highest-value change in this handoff is S1** — stop converting
transport failures into confident claims about what the server published.

---

## S1 — `?? 0` turns any failure into "GenStudio published nothing" (highest priority)

**File:** `electron/server/lib/genstudio-client.ts:2657`

```ts
maximum_input_characters: optionalCount(payload?.maximum_input_characters) ?? 0,
```

This collapses three distinct states into one value:

1. the field was absent from the payload,
2. the response was not a quote at all (an error body, a 4xx, a stale cache entry),
3. the model genuinely published `0`.

That `0` then reaches the guards at `:1579` and `:1602`, which are otherwise
correct — they refuse to guess a request boundary, which is right, because a
wrong boundary bills a failed job. But they then **name GenStudio as the cause**
of a failure that may have originated anywhere.

**Fix:** do not default. Keep it `null`/`undefined` when absent, and make the two
guards distinguish the cases:

- field genuinely absent from a **successful 200 quote** → keep the current
  message; it is accurate in that case only.
- the quote call **did not return 200** → surface the actual HTTP status and the
  response body. Never paraphrase it as a publication claim.

**Acceptance:** given a 422 from `/v1/tts/quotes`, the user-visible error
contains the status code and the server's `detail`, and does **not** contain the
phrase "published no maximum_input_characters".

Same treatment applies to the sibling coercions at `:2656` and `:2658-2660` —
`?? 0` on `billable_characters`, `credits`, and `credits_per_1000_characters` has
the identical failure mode and is worse, because a silent `0` there reads as
"free".

---

## S2 — the connection test calls `/v1/voices` without a model and expects 200

**File:** `electron/server/routes/app-settings.ts:878`

```ts
{ path: '/v1/voices', scope: 'voices:read', label: 'voice catalog', expected: 200 },
```

`GET /v1/voices` on GenStudio **requires** `model_id` (`voices/router.py:892`).
Without it the endpoint returns **422**, so this probe reports the voice
catalogue as broken on an otherwise healthy key.

Per ADR-0016 this is deliberate: TTS is model-first, and a voice list that isn't
scoped to a model is not answerable — voices are not portable across engines.

**Fix:** scope the probe. Resolve one TTS model id from `/v1/tts/models` first
and probe `/v1/voices?model_id=<id>`; if the catalogue is empty, skip the probe
rather than failing it.

Do **not** ask GenStudio to make `model_id` optional. That branch exists in the
service layer but changing the published contract would reintroduce exactly the
cross-engine voice confusion ADR-0016 removed.

**Note:** `routes/audio.ts:93` and `:213` already pass `modelId` correctly. The
quote and generate paths are fine. This is the health check only.

---

## S3 — the unscoped voice picker

**File:** `electron/server/routes/audio.ts:843`

```ts
const modelId = typeof req.query.model === 'string' ? req.query.model : ''
```

When `model` is absent this proceeds with an empty model id. Any downstream
GenStudio voice call made in that state hits the same 422 as S2.

**Fix:** require a model selection before the picker can list voices — return a
400 with a clear "choose a voice model first" message, matching the pattern
already used at `:196`. The UI should select a model first and then list its
voices, which is how the model→voice relationship actually works.

---

## S4 — research contract is not sent (cleanup, not a blocker)

**File:** `electron/server/services/research/genstudio.ts:43`

`JSON_OBJECT_OUTPUT_CONTRACT` is defined but not passed on the research request.
Pass it. Without it the model is free to wrap JSON in prose, and a prose-wrapped
response is what caused the **only real charge** in this whole investigation:
3 + 3 credits on 2026-07-31, output discarded. That was already fixed in
v1.0.759 by other means; passing the contract closes the underlying gap.

---

## S5 — the false comment about the research route

**File:** `electron/server/services/research/genstudio-web.ts:1-7`

The header comment describes the wrong route. The documented and working web
research route is **`/v1/chat/completions`**, not `/v1/chat/responses`. Correct
the comment so the next reader isn't misled the way this session was.

---

## S6 — job list shows time but no date

Owner-reported. The job list renders a time with no date, so yesterday's job and
this morning's job look identical. Show the date, or a relative day marker.

---

## What GenStudio is fixing on its side (do not duplicate)

1. **`POST /v1/chat/responses` resolves the wrong table.** It looks up the
   customer handle in the private `chat_models` table, where zero matching rows
   exist. `GET /v1/chat/models` was migrated to product-first; the submit path
   was not. Being changed to resolve `PublicModelRecord` by
   `customer_handle OR id`.

2. **Web research is rejected unconditionally** on that same route, before any
   product check. Being replaced with the real per-product capability check.

3. **Image models serialize as `qualification_only: true`** because of an
   un-overridden Pydantic default in `images/router.py:400`. `chat/router.py`
   and `transcriptions/router.py` both pass `False`; images was missed. Story
   Studio's client guard at `services/image-model-resolver.ts:32-34` is behaving
   correctly on bad input — **do not weaken that guard.**

### Immediate unblock available now

Setting `STORY_STUDIO_GENSTUDIO_CHAT_TRANSPORT=completions` restores every
language call, including web research, using the switch at
`genstudio-client.ts:1202-1220`. This is a **temporary** measure — once GenStudio
fix (1) lands, the default transport works again. Do not hardcode the
`completions` transport or delete the switch.

---

## Verified, so you don't have to re-check

- **Nothing was charged for any of tonight's failures.** Every rejection occurs
  before credit reservation in code order, on all five paths. Balance unchanged.
- The owner's account is fully entitled: `plan_bayon_scale`,
  `model_access_profile=PAID_CATALOG`, `story_studio_access=true`. None of these
  failures are entitlement or admission problems, despite what the error text on
  the image path implies.
- GenStudio's TTS models publish real `maximum_input_characters` values
  (40000 / 10000 / 5000 / 4096 / 32000). The field is populated and correct.
- `routes/audio.ts` quote and generate paths pass `modelId` correctly.

## Suggested order

S1 first — it is the reason two diagnoses went wrong tonight, and it will make
every subsequent failure legible. Then S2 and S3 together (same root cause), then
S4, S5, S6.
