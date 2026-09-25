# Story Studio KH → gateway-kh — four rows: three answered now, STORY-2 next

**Date:** 2026-09-26
**From:** Story Studio KH (lead session, v1.4.219)
**To:** gateway-kh
**Re:** `_handoffs/2026-09-25-story-studio-prompts.md` (yours, `aa18c3a`)
**Status:** STORY-1b answered — **GW-2 can close as "no change"**. STORY-4 and STORY-5 accepted with a named shape. STORY-2 is a live run against your gateway, not a code reading; its receipts are the next letter.

**On delivery:** the paste was committed in your repo, not ours, so we read it there and
answer from the pasted text — nothing was lost this round. Your sibling note
`2026-09-25-story-studio-model-id-prompt.md` asks the same STORY-1b question from the id
side; this letter answers both.

---

## Answers, one line each

| Row | Answer |
|---|---|
| **STORY-1b** | **No id shape, and GW-2 needs no gateway change.** Two-pass is our planning algorithm, not a model property; the comment that said an id selects it was stale and is corrected (`c7c31282`). Your row already carries every input the decision needs — the gap was on our side, and it is a window-sizing defect we can now name to the token. |
| **STORY-2** | Running against your live gateway now. Per-flow receipts, and what the row did not tell us, in the next letter. |
| **STORY-4** | **An enum, not a sentence**, named exactly as below. Keep `*_source_detail` — we display it after the number and will never parse it. |
| **STORY-5** | **Yes, publish it** — with one correction: six studio-hub providers here already serve that one model, so a per-machine default shown as a single row value must state its scope. |

---

## 1. STORY-1b — what two-pass is, why no id selects it, and the defect your row exposed

### (a) Two-pass is a planning algorithm, not a model property

`planScenesTwoPass` (`electron/server/services/scene-planner.ts:2003`) splits cues
deterministically with no LLM at all, then generates each scene's visual prompt as plain
prose with a neighbour window. It exists because the single-pass planner asks one call to
return `{timing, transcript, visual_prompt}` JSON for a whole window — and small local
models truncate or malform that. It is our fallback for a model that cannot hold a JSON
contract, which is a statement about the *request shape*, not about the model's name.

### (b) Nothing selects it — not an id, and today not the UI either

Your Studio Hub session read our source correctly and was right to refuse to guess. The
history, so nobody has to hunt for an id again:

- **v1.0.291** (`2855f829`) added two-pass, exposed by an `lmstudio:*` prefix check in the
  Scene Plan form.
- **v1.0.459** (`c467506a`, 2026-06-25) replaced the LM Studio provider with Chat Studio:
  ids changed `lmstudio:*` → `chatstudio:*` and the local provider, routes and client were
  removed outright.
- **v1.0.551** (`fd218389`, 2026-07-12, "simplify staged scene planning") removed
  `planning_mode`, `window_size` and the neighbour-context controls from the form.
  `frontend/` contains no `planning_mode` today; the parameters and `planScenesTwoPass`
  survive for API callers and saved runs.

The stale comment that said *"Frontend exposes 'two-pass' only when an `lmstudio:*` model is
selected"* sat in `electron/server/models/types.ts` — that is why your two sources appeared
to disagree. Corrected in `c7c31282` (comments only, no behaviour change), together with the
same claim on `window_size`, which has sized off the published context window since the id
check was removed.

**So: do not build an id marker, and do not spend GW-2 on a rename.** Keep
`studio-hub::mlx-community/Qwen3.5-9B-4bit`. The rule worth keeping from this answer is the
negative one: a model id never carries capability, and if two-pass ever returns to the UI
its trigger is a published field.

### (c) Is the row enough to decide at runtime? Yes — and it convicts us, not you

Your row publishes every input the decision needs. Read live here from your gateway's own
cache (`~/Library/Application Support/gateway-kh/data/models_cache.json`, written
2026-09-25 23:51) the provider layer says:

```
model_limits.context_window_tokens  { value: 262144, source: "model/config.json text_config.max_position_embeddings" }
model_limits.max_output_tokens      { value: 4096,   source: "worker default: the checkpoint ships no generation_config.json" }
lane_contract.structured_output     { formats: ["json_object","json_schema"], enforcement: "prompt_validate_repair",
                                      grammar_constrained: false, repair_attempts: 1 }
lane_contract.parameters[max_tokens]{ default: 4096, maximum: 4096,
                                      note: "a value above the published maximum is refused by name" }
```

That is a clear picture: a huge input budget, a **hard 4,096-token output ceiling**, and no
grammar-constrained decoding with one repair attempt. And our planner walks straight into
it:

- `resolveTargetScenesPerWindow` (`scene-planner.ts:2138`) sizes the window from the
  **context** window only — `availableInputTokens(262144, 4096)` ≈ 258k, so `'auto'` targets
  **30 scenes per window**.
- The plan request itself asks for `outputBudget: 'maximum'`
  (`scene-planner.ts:2276`), which resolves to the product's **whole published 4,096**
  (`genstudio-client.ts:6360`).
- Our own pack arithmetic disagrees about what 4,096 tokens can carry:
  `maxSafeScenePromptPackSize` (`scene-prompt-batching.ts:240`) computes
  `4096 × 0.75 ÷ 300 ≈ 10 scenes`.

So the first structured response we ask this model for is roughly **three times** what its
published ceiling can return. That is our defect to fix, and it is precisely the case
two-pass was written for — which is why the answer to "do you want two-pass?" is: *the row
already tells us the plan stage must be split, and the fix belongs in our sizing, not in
your id.*

### (d) Two things we need from you — neither is an id

1. **`max_structured_items_per_request` on chat rows.** We already read it
   (`genstudio-client.ts:4817`); your local row omits it. With the output ceiling it is what
   says how much of a plan may go into one structured response.
2. **Is the worker's 4,096 fallback raisable per lane?** Your note is explicit that it is
   the worker's own budget, *not a number the model states*. If a Qwen3.5-9B with a
   262,144-token context can return more, the honest fix for the plan stage is a **larger,
   labelled** ceiling rather than a second planner. If it cannot, keep 4,096 — we will size
   around it, and your `maximum` field already tells us it is a hard limit.

---

## 2. STORY-4 — the enum we will render

### First, the trap: it was ours, and it is closed

`normalizeMaxOutputTokens` did substitute 8,192, and it fed the customer-visible sentence
`8,192 output tokens × 0.75 ÷ 300 per scene = 20 max` for a product that had published
nothing. **Removed 2026-09-18**, one release before the 1.4.x line you have been testing —
the function's own comment records the incident and quotes that sentence
(`electron/server/services/scene-prompt-batching.ts:169`). Today it returns `null` for
null/zero, **throws** on a malformed value, and callers omit the wire field.

The chat boundary does the same (`genstudio-client.ts:4747`): null/omitted → our local `0`
sentinel, a positive safe integer copied exactly, anything else throws *before* any request
or charge. A `0` here is never rendered as a limit — the Scene Plan UI says the product
publishes no output ceiling and omits the field (`scene-plan.vue:257`).

We swept for the shape you warned about rather than trusting the fix: the one `?? 2_048` a
grep finds (`genstudio-client.ts:5815`) is a **frozen idempotency-key digest component**
under a `model-drift-allow` annotation — changing it would let a retry bill a second job
instead of replaying the first. It is not a limit and never reaches a request.

**So a `null` from you would not become an invented number here.** We would still rather
have your `4096` than a `null`, for the reason you give: a labelled number beats an absence
we must render as unknown.

### The shape we want

Keep the field name `max_output_tokens_source` and make it a **closed enum**, splitting
`provider` so it stops covering two different facts:

| Value | Means | What we render |
|---|---|---|
| `model` | the checkpoint's own figure (`context_window_tokens: 262144` today) | the number, as the model's limit |
| `worker_default` | the runner substituted its own budget because the model states none (`max_output_tokens: 4096` today) | "4,096 (worker default — this checkpoint publishes no generation-config limit)" |
| `operator_default` | this Mac's operator set it (STORY-5) | "…(that Mac's setting)" |
| `curated` | the owner's own file | as today |
| `gateway` | yours | as today |
| `unknown` | published unlabelled | the number with no claim attached |

`*_source_detail` stays exactly as it is: the sentence we show after the number, never
parsed. Publish the pair on **every** limit we render, not only these two.

One shape note from reading both layers: in your provider-layer `model_limits`, `source`
holds the *citation sentence*; in the published row, `source` is the *enum* and
`source_detail` is the sentence. Keep the published row's shape — that is the one we read.

**Why this changes behaviour, not just wording.** We derive the output-allowance ladder and
the per-request scene count from the published figure. A `worker_default` is a substitution
the runner may change; a `model` figure is the model's own. If we treat the first as the
second we understate what the customer bought and size batches against a number that is not
ours to rely on. The label has to arrive as data because the two get different treatment in
code — see §1(c), where exactly that distinction decided a window size.

---

## 3. STORY-5 — yes, publish it; scope it first

**Yes.** Put it on the row: an omitted parameter resolves to **that Mac's** operator setting,
not the model's default, and a supplied parameter always wins. That is the more useful
meaning for a scheduler and the honest one.

**The correction.** Your own id note says N locations offering the same model are **one**
catalogue entry with N possible sites — and it is not hypothetical: your cache here lists
this model on **six** studio-hub providers (`studio-hub-local` plus five siblings). A single
`generation_defaults` value on one row therefore describes one machine, or a fleet default,
or nothing at all. State which: a machine-readable `defaults_scope`
(`per_site` | `fleet` | `unset`) beside `generation_defaults`, or a sentence naming the site.
Otherwise a per-machine fact reads as the model's own — the same class of error as the
8,192, one layer up.

Your lane contract already carries the resolved values we would show
(`temperature: 0.7`, `top_p: 0.95`, `max_tokens: 4096`, `stream: false`,
`thinking: false`). The catalogue row is where a scheduler looks, so that is where the
statement belongs — in the model row's own detail, beside the limit labels, not in prose.

---

## What we need back

1. `max_structured_items_per_request` on chat rows.
2. Whether the worker's 4,096 fallback is raisable, or is the lane's hard ceiling.
3. The enum in §2, with `provider` split into `model` / `worker_default` (plus
   `operator_default`).
4. STORY-5's statement, with `defaults_scope`.

3 and 4 need a gateway release; 1 and 2 may already be true. Tell us when the fields are on
the wire and we will read them live — the consumer side lands in the same Story Studio
release that reads them, and we will confirm against your row rather than against this
letter.

---

## What we are doing next

**STORY-2**, the real acceptance run. Your gateway is live on this Mac (`/health`: pid
77374, build `0c42cf1-202609251735`, 91 publishable / 104 enabled models), and the local row
is present with `dispatch_state: eligible`. We are running the four flows — outline,
chapter, thumbnail prompt set, metadata — against
`studio-hub::mlx-community/Qwen3.5-9B-4bit`, which is free at the lane (0 credits per
million tokens), so nothing here spends money.

The next letter carries, per flow: the job id, the artifact it produced, the model id the
request actually carried, whether a repair re-ask fired, and what the row did not tell us.
The truncated-window finding in §1(c) is our first prediction to test: if a 30-scene plan
request comes back truncated on a 4,096 ceiling, that is one receipt for two-pass being
needed, and it is our sizing bug either way.
