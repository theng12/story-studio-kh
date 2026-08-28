# Request to GenStudio: split language products into web-capable and offline

**From:** Story Studio KH
**Why:** Story Studio's Research step currently runs against ordinary language products
with no web access. Its own prompt tells the model *"you do NOT have live web access on
this call. Don't fabricate URLs."* — so Research returns claims with **zero citations**,
by design. That is fine for ideation, but Story Studio is moving into science and
history channels where claims must be traceable to a real source. Unsourced,
confidently-worded claims are the exact failure mode we need to avoid.

Story Studio will not guess which products can search. It needs GenStudio to say so.

**STILL-REFERENCED — status header added 2026-08-28.** Cited directly (as
`docs/genstudio-web-search-request.md`) by `electron/server/lib/genstudio-client.ts` (~L5023)
and `electron/server/__tests__/research-envelope-contract.test.ts` (~L160), both quoting this
document's §3 as the reason citations arrive "as their own field, not folded into the answer
text." Per the folder README, the catalogue contract shipped in v1.0.764, but
`research_qualified` is confirmed still `false` on every product today
(`services/research/genstudio-web.ts`), so live web research remains unavailable — this ask
is still genuinely open on the runtime-activation half. Left in place.

---

## 1. Declare the capability in the chat catalogue

`GET /v1/chat/models` → `ChatModelResponse` currently exposes capability flags such as
`supports_vision`, `supports_structured_output`, `structured_output_mode`,
`input_modalities[]`, `max_input_images`, `controls[]`. Please add web retrieval in the
same style, so Story Studio can filter on a returned field rather than infer from a
product's name:

| Field | Type | Meaning |
|---|---|---|
| `supports_web_search` | bool | Product can retrieve live web content during the call. Default `false`. |
| `web_search_credits_per_search` | int \| null | Extra credits per executed search, if billed separately from tokens. `null` if bundled. |
| `max_web_searches` | int \| null | Cap on searches per request, if any. |
| `returns_citations` | bool | Whether the product returns structured citations (see §3). A product that searches but cannot cite is much less useful to us — please flag it honestly rather than implying citations. |

Existing offline products keep `supports_web_search: false` and are otherwise unchanged.

**Story Studio will use this to split its pickers:** the Research model picker will list
only `supports_web_search: true` products; Script, Thumbnail Prompts, Motion Prompts,
Metadata, Scene Plan and Contextual Cues will continue to use ordinary products, because
those tasks do not need the web and should not pay a search premium.

## 2. Make searching an explicit per-request opt-in

Please do **not** make a web-capable product search implicitly on every call — Story
Studio would then pay a retrieval premium on prompt-writing tasks that never needed it.

On `POST /v1/chat/responses` (and `/v1/chat/completions` if it stays supported), accept
an optional block, rejected with a clear 400 when the selected `model_id` has
`supports_web_search: false`:

```json
{
  "model_id": "...",
  "input": [...],
  "web_search": {
    "enabled": true,
    "max_searches": 8,
    "allowed_domains": ["nature.com", "*.edu"],
    "blocked_domains": []
  }
}
```

`max_searches` is the knob Story Studio's existing "Source depth" control would map to.
Today that control is only a soft cap named in the prompt text, which is why asking for
15 yields whatever the model felt like returning.

## 3. Return citations as structured data, not prose

This is the part Story Studio most needs. Free-text citations inside the answer body are
not usable — they cannot be stored, displayed, deduplicated, or checked. Please return
citations as their own field on the job response:

```json
{
  "citations": [
    {
      "id": "cit_01",
      "url": "https://...",
      "title": "...",
      "publisher": "...",
      "published_at": "2024-03-11",
      "retrieved_at": "2026-07-31T08:00:00Z",
      "quote": "the passage actually retrieved"
    }
  ]
}
```

And a way to tie a claim to its citations — ideally the model emits `citation_ids` per
claim, matching the id above. Story Studio already has a per-claim review UI with a
`citation_indices` concept; structured ids let each claim link to the source a human
would click to check it.

`retrieved_at` and `quote` matter: a URL alone doesn't prove the page said what the
claim says, and pages change.

## 4. Billing must be visible

Whatever a search costs, it should land in the job response's existing credit fields so
Story Studio can display real spend. Story Studio never computes customer charges
locally — it only shows what GenStudio reports. If retrieval is billed separately from
tokens, please make that visible rather than folding it invisibly into `credit_cost`.

## 5. Nothing else should change

- Offline products keep working exactly as they do now.
- The `structured_output_mode` contract (`json_object` / `request_json_schema`) is
  unchanged; Story Studio requests `json_object` and validates locally.
- Provider identities stay private. Story Studio does not want to know which upstream
  vendor performed the search — only that it happened and what it returned.

---

## What Story Studio will do once this ships

1. Filter the Research model picker to `supports_web_search: true`, and show clearly
   when no web-capable product is available rather than silently falling back offline.
2. Map "Source depth" to `web_search.max_searches` instead of a prompt-text hint.
3. Store returned citations with the research sidecar and render them per claim, so
   verification means "I clicked the source and it says this" instead of "I read the
   sentence and it sounded right."
4. Keep every non-research language step on ordinary offline products.

Until then Story Studio will keep labelling Research output as unsourced model recall
rather than evidence, because that is what it is.
