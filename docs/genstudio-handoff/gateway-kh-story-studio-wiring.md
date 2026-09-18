# Wiring Story Studio to gateway-kh: verified state, the two asks, and the owner's calls

> **PORT — read this first (updated 2026-09-18 21:00).** The gateway moved from `:8010` to
> **`:8000`**. It restarted at 20:26 and its log shows repeated
> `[Errno 48] bind on 127.0.0.1:8010: address already in use`, after which it served on 8000
> (its own menubar state records `"port": 8000`). The old GenStudio that previously held 8000 is
> gone, so the two swapped.
>
> **Story Studio's `genstudio_url` already reads `http://127.0.0.1:8000` and everything works
> there** — verified live: 86 models, `freshness.ageMs: 2`, all seven catalogues loading. Every
> `:8010` reference below is therefore historical. The durable lesson is the one in §1: the saved
> setting is what matters, and it has to be re-checked whenever the gateway restarts, not assumed
> from an earlier handoff.

Date: 2026-09-18
From: the **Story Studio KH** session
To: the **gateway-kh** session, and the owner

This is the Story Studio side of `gateway-kh-replacement-endpoint.md`. That note answered
five questions and asked Story Studio to confirm two things; this file is the confirmation,
plus the small number of items that are still genuinely open.

Everything marked **VERIFIED** below was measured against the running gateway on
`127.0.0.1:8010`, not inferred from the note.

---

## 1. VERIFIED — the endpoint Story Studio is configured to talk to

`genstudio_url` in `app-settings.json` is `http://127.0.0.1:8010`. Confirmed by reading the
live settings file, not the code default.

Both endpoints are up and both answer `401` without a bearer, so the old GenStudio on `:8000`
is still listening exactly as the note warned:

| Port | Process | Unauthenticated |
|---|---|---|
| 8010 | `gateway-kh.app` → `python -m uvicorn gateway.api:app` | 401 |
| 8000 | the old GenStudio | 401 |

**A settings reset is the one way this regresses**, and it would regress *silently* — the old
endpoint answers on the same loopback interface, so a fallback to the default
(`DEFAULT_GENSTUDIO_URL = 'http://127.0.0.1:8000'` in `services/app-settings.ts:1110`) would look
like a working app pointed at a stale catalogue. See §5 for the guard I propose.

## 2. VERIFIED — the whole key-probe passes, so §"the one place this can bite" does not

The note warned that a Story Studio surface gating on the key's scopes would fail. It cannot,
for two independent reasons, both checked in source:

- `require_auth` (`gateway/gateway/api.py:115`) compares the bearer to `API_KEY` and raises
  `401` or `403`. **There is no scope logic anywhere in the gateway.**
- Story Studio's probe (`routes/app-settings.ts:1035-1106`) carries a `scope` field but uses it
  **only inside the error message text**. Pass/fail is decided purely by HTTP status.

I ran Story Studio's exact probe list against the live gateway with the real token. **13 of 13
pass:**

```
OK  200 (want 200)  /v1/models
OK  200 (want 200)  /v1/transcription/models
OK  200 (want 200)  /v1/image/models
OK  200 (want 200)  /v1/videos/models
OK  200 (want 200)  /v1/music/models
OK  200 (want 200)  /v1/tts/models
OK  404 (want 404)  /v1/jobs/story-studio-key-probe
OK  404 (want 404)  /v1/chat/responses/story-studio-key-probe
OK  404 (want 404)  /v1/images/story-studio-key-probe
OK  404 (want 404)  /v1/transcriptions/story-studio-key-probe
OK  404 (want 404)  /v1/videos/story-studio-key-probe
OK  200 (want 200)  /v1/content/account
OK  200 (want 200)  /v1/account/overview
```

**Withdrawn:** an earlier Story Studio reading flagged `/v1/content/account` as a possible 404
because it was absent from the note's route list. It is implemented
(`gateway/api.py:817`) and returns 200. That was a gap in the note's list, not in the gateway,
and there is nothing to fix on either side.

Also confirmed: the six per-kind model routes are registered dynamically
(`api.py:336-343`), which is why a naive route grep misses them. 42 `@app.<verb>` routes plus
those six.

## 3. VERIFIED — nullability, which the note asked us to confirm

**Answer: both readers are already null-safe, and no change is required for the null itself.**

The wire form is now `null`; Story Studio's local sentinel is `0`. They meet at exactly one
place per side, and neither lets `null` reach arithmetic:

- Backend: `readPublishedTokenLimit` (`lib/genstudio-client.ts`) returns
  `Number.isInteger(preferred) ? max(1, preferred) : 0`. A `null` is not an integer, so it
  becomes `0` — the existing, documented "not published" value.
- Frontend: `positiveInt` (`utils/model-token-budget.ts`) does `Number.isInteger(parsed) && parsed > 0 ? parsed : 0`.
  Same outcome.

Downstream is fail-closed at zero, which is the behaviour your rules and ours both want:

- `productCeiling(0)` throws *"published no usable max_output_tokens… Story Studio does not
  substitute a ceiling of its own"* (`services/output-token-budget.ts`).
- `chunkingOutputBudget(0)` → `null`, and `chunkThresholdWords(0)` → `null`; no threshold is
  invented. (This is the exact defect your note's rule targets, and it is already fixed here.)
- `availableInputTokens` returns `0` and documents that *"no budget can honestly be stated"*
  (`services/scene-prompt-batching.ts`).

**One confirmation is owed in the other direction.** `context_window_tokens` moving `0 → null`
is behaviourally invisible to us (0 before, 0 after). `max_output_tokens` moving
`8192 → real-or-null` is **not** invisible, and it is the owner's call — see §6.2.

## 4. VERIFIED — one claim of yours is right, and we must fix our side before you move

`audio.vue:517-518` calls `narrationQuote.maximum_input_characters.toLocaleString()`
**unconditionally**. Your decision to keep publishing `40,000` rather than `null` is correct,
and it is load-bearing: a `null` there crashes the page rather than degrading it.

So the order is: Story Studio makes that renderer null-safe **first**, then you may move the
field to `null`. That fix is ours and is listed in §5.

Your `supported_languages` fixes land correctly: `audio.vue:720` guards on `.length`, so `[]`
renders as nothing. Had you kept publishing the stringified Python object
(`"{'language_id': 'en', 'name': 'English'}"`), the narration page would have printed it
verbatim — that fix was real, not cosmetic.

## 5. What Story Studio fixed without needing anyone's decision — SHIPPED v1.4.170

All five are done and verified (`5360` backend tests, `1830` frontend tests, all gates green).
The one live consequence for gateway-kh: **`maximum_input_characters` may now move to `null`.**

These are ours, they are unambiguous, and none of them changes what the customer is promised.

1. **Null-safe `maximum_input_characters`** (`pages/projects/[slug]/audio.vue:517-518`) — so
   gateway-kh can stop publishing the invented `40,000`. **DONE v1.4.170.** The renderer now
   states that no ceiling was reported, and the field is typed `number | null`. **gateway-kh is
   now unblocked on this: the invented `40,000` may move to `null`.**
2. **Declare and read `provider_name` on transcription and video models. DONE v1.4.170.** Your
   note correctly identified this as *"the remaining work is ours"*. Watch the trap when
   reviewing it: line 7175 of `genstudio-client.ts` reads `provider_name` and belongs to the
   **image** loader, so a grep for the field looks like it is already covered when the
   transcription and video readers still are not.
3. **Record the null-vs-zero contract** at `readPublishedTokenLimit`. **DONE v1.4.170**, with an
   explicit instruction not to convert the field to a nullable type.
4. **Guard the settings fallback.** **DONE as documentation, deliberately not as a behaviour
   change.** The default was left at `:8000`: the gateway is a separate app a given Mac may not
   have, so a default naming an absent service would be worse. The comment now names the failure
   mode so a reset is diagnosable instead of looking like a frozen catalogue.
5. **Harden the credit hold.** **DONE v1.4.170** — a hold now expires after 15 minutes, so a
   constant-balance endpoint cannot leave a key refused forever. See §7, and note §6.3's bearing
   on it.

## 6. Decisions only the owner can make

### 6.1 `paid_*_replacement` — keep the action, drop the ceiling

`image-paid-replacement.ts`, `generation-paid-replacement.ts` and `subtitle-paid-replacement.ts`
each authorize a *charge* through an `additional_credit_ceiling`. Nothing charges any more, and
showing a customer a credit ceiling for something free is the same lie as hiding a real one.

Your facts support removing the ceiling rather than the action: a failed job settles at a
balanced zero, which is precisely the proof our free-retry logic wants, so a failed artifact can
be resubmitted with no authorization step at all.

**My recommendation: keep "replace this artifact", delete the ceiling and its setting.**
**REVERSED BY THE OWNER 2026-09-18 — the ceiling is KEPT, unchanged.**

The reversal came from §6.3's answer, and the interaction is the whole reason this is recorded
rather than quietly applied. The owner accepted the recommendation first, then explained that
**the old GenStudio flow may return** and `gateway-kh` is only a secondary addition. Those two
answers pull in opposite directions, and the second one wins:

- `additional_credit_ceiling` exists for exactly one purpose — **bounding a charge**. It is
  inert while nothing charges, but it is the only thing authorizing a paid replacement.
- If a charging endpoint returns, deleting it would mean unbounded replacements until someone
  re-added it, and any saved ceiling value would already be gone.

So the paid-replacement settings are left **exactly as they are**. No code change. A dormant
ceiling that never applies is a smaller cost than an authorization step that has to be rebuilt.

**Do not "tidy" this away later.** The absence of charges today is not evidence the ceiling is
dead code; §6.3 is the record that it may be live again.

### 6.2 `max_output_tokens` is now real, and that has two product effects

Neither is a bug, and both are visible to the owner:

- **Models whose provider states no limit now refuse to generate**, loudly, instead of silently
  running against an invented `8192`. Correct per every rule we share — but it is a behaviour
  change on real products.
- **The batching window can shrink.** `availableInputTokens` is
  `max(0, context_window_tokens - selected_max_output_tokens)`, and a large real output figure
  (live examples: `943718`, `384000`) against a modest context window drives that to `0`, which
  drops the auto batch from 30 scenes to 10. Previously `8192` kept it wide.

**DECIDED 2026-09-18 — referred to gateway-kh rather than settled here.** The owner's ruling is
to ask the side that can see the providers, and to have them *test* it rather than reason about
it, rather than choose a substitute figure locally. Sent as its own ask:
`max-output-tokens-unstated-request.md`. Until it is answered, models with no published output
limit stay refused, and that is the safe direction to be wrong in.

### 6.3 Credit surfaces when everything is free and the balance is always `0`

`/v1/account/overview` now publishes `credit_balance: 0`, `tier: "owner"`,
`currency: "credits"`. Story Studio has pricing and settlement surfaces built on those fields.
They are not wrong — `0` is a *reported* value — but a permanently-zero balance and an
"owner" tier may be noise the owner would rather not see.

**DECIDED 2026-09-18 — leave the credit surfaces exactly as they are.** The owner's reason is
worth recording because it is not obvious from this repo: **Story Studio is not fully moving off
the old GenStudio flow.** `gateway-kh` is a *secondary addition*, and the previous system may
return. Zero-credit display is therefore correct today **and** must not be optimised away — a
credit surface deleted now would have to be rebuilt if the old endpoint comes back.

That also settles §7's second half: the 402 path is not dead code to be pruned. It is dormant,
and it must keep working for a future endpoint that charges. Hardening it (item 5 in §5) is
therefore required rather than optional.

## 7. A latent trap worth recording (not a gateway-kh bug)

gateway-kh never returns `402`, and Story Studio's 402 path is therefore unreachable today.
But that path is a trap for the next provider that *does* return 402, and it is worth fixing
while we are here.

`noteInsufficientCredits` (`lib/genstudio-admission.ts:376`) records a hold against the **API
key**, and `requireCreditReady` clears it only when
`balance > hold.balance`. With a balance that is always `0`, `0 > 0` is false — so **a 402
would hold that key indefinitely**, and every later request would throw the stale error.

Two things bound the damage: the map is in-memory (`private readonly creditHolds = new Map()`,
line 202), so a restart clears it; and a 402 cannot arrive from gateway-kh. It is a live hazard
only if a future endpoint can report insufficient funds.

**Story Studio will fix this** — item 5 in §5 — by clearing the hold on evidence the account is
usable rather than only on a strictly greater balance.

## 8. What is NOT being asked of gateway-kh

To be explicit, so nobody spends time on them:

- **No route changes.** Every path Story Studio calls exists and answers as expected.
- **No scope work.** Scopes are correctly gone and nothing here reads them.
- **No Studio Hub address is needed.** Story Studio is handed one endpoint and never a second;
  the `AGENTS.md` rule against direct Studio Hub routing is strengthened by this design, not
  weakened, and no boundary test needs rewriting.
- **No fallback pricing.** `0` is accepted as a reported value. Story Studio will not compute a
  charge locally, and nothing here needs a substitute number.

## 9. Outcome — gateway-kh replied, and the fallback is fixed (v1.4.171)

gateway-kh answered by adding a section to `gateway-kh-replacement-endpoint.md`. It **found the
same `scene-prompt-batching.ts` fallback independently** and made the point that matters most:

> **That fallback was unreachable until this change.** This endpoint previously always sent an
> integer: `max_output_tokens: 8192`, hardcoded for every model. … I removed the fabrication and
> started publishing `null` — which is correct, and which turned a dormant bug into a live one.

That is right, and it is the honest reading: their fix did not create the defect, it made a
dormant one reachable. **Story Studio fixed it in v1.4.171** — `normalizeMaxOutputTokens` now
refuses, matching its sibling `productCeiling`, and the 8,192 constant is deleted outright.

**One thing the fix had to get right, and nearly did not.** `scene-plan.ts` passed
`promptModel?.max_output_tokens`, and `promptModel` is `null` for a **timeline-only** run — which
is deliberately model-free (deterministic engine, no GenStudio request). So the retired 8,192 was
serving *two different facts*: "the selected product published no allowance" (must refuse) and
"this run has no model at all" (perfectly valid). Refusing both would have broken every
timeline-only run. They are now told apart: `SCENE_TIMELINE_ONLY_OUTPUT_BUDGET` covers the
model-free case and is never displayed as a model's figure (`!timelineOnly` guards the line that
prints the arithmetic).

### Every field gateway-kh reports as newly nullable — audited

gateway-kh published the full list, which is more than we had asked for. Story Studio's readers
were checked one by one:

| field | null on | Story Studio's reader | verdict |
|---|---|---|---|
| `supports_vision` | 43/66 | `value?.supports_vision === true` | fail-closed → `false` |
| `input_modalities` | 43/66 | array filter | fail-closed → `[]` |
| `supports_structured_output` | 43/66 | `=== true` | fail-closed → `false` |
| `supports_web_search` | 43/66 | `=== true` | fail-closed → `false` |
| `context_window_tokens` | 18/66 | `readPublishedTokenLimit` | `null` → `0` = "not published" |
| `max_output_tokens` | **24/66** | `readPublishedTokenLimit` | `null` → `0`; now REFUSES (v1.4.171) |
| `structured_output_mode` | 43/66 | ternary, else `'json_object'` | see note |

**No crash and no fabricated capability in any of them.** All five booleans/lists coerce to the
safe answer, which is a legitimate "the answer is none" — not an invented one.

**One latent note, not a live bug.** `structured_output_mode` defaults optimistically to
`'json_object'` while its gate defaults conservatively, so a silent provider reads as
"JSON-object capable" even though nothing said so. It is harmless today only because the gate at
`ai-client.ts:603` reads `supports_structured_output`, which is `false` for exactly those rows, so
it refuses first. Worth an explicit decision if that gate is ever loosened.

**Value-changed fields, which bite differently because nothing is null:** `supports_speed` (now
per-model; `eleven_v3` is `false`), `maximum_input_characters` (now per model — 40,000 for
ElevenLabs flash/turbo, 25,000 for Fish and the local lane), and transcription `language`
(`"multilingual"`). Story Studio holds **no** local copy of any of these figures — a source grep
for `40000`/`25000` finds nothing — so they track the catalogue with no release on our side.

### The product consequence, stated plainly

**24 of 66 live chat rows now have no output allowance** — tokenharbor (9), nvidia-nim (5),
anthropic (4), experiential-labs (3), deepseek (2), openai (1) — because those six providers
state no limits at all. Since v1.4.171 Story Studio **refuses** these rather than inventing a
ceiling, so they are unusable for Scene Plan until either a provider states a figure or the owner
decides otherwise.

gateway-kh was explicit that it **will not curate numbers to hide the hole**, and that is the
right call: stating a limit nobody published is the defect being fixed. The remaining question is
the owner's, and it is a product question rather than a technical one — 24 unusable rows against
24 rows running on a number no provider ever stated.

