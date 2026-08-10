# Request to GenStudio: image resolution and valid-combination pricing

**From:** Story Studio KH
**Why:** Story Studio wants to show customers only the output options their selected
image model actually supports, and price the exact combination before they generate.
It can already do this for **video**, because `VideoModelResponse.variants[]` declares
valid `(operation, duration_seconds, resolution)` combinations with their own
`credits_per_video`. The image catalogue has no equivalent, so Story Studio cannot
offer resolution choice without inventing capability — which it will not do.

## What the image contract exposes today

`ImageModelResponse`: `aspect_ratios[]`, `default_aspect_ratio`, one flat
`credits_per_image` (plus `base_credits_per_image`, `promotion_*`, `chargeable`,
`reference_generation_credits`). The historical `unlimited_relaxed` entitlement was later
retired and is not part of the current contract.

`ImageGenerationRequest`: `prompt`, `model_id`, `aspect_ratio`, `seed`,
`reference_asset_ids`.

`ImageJobResponse`: returns `width`, `height`, `steps` — so a resolution *is* decided,
server-side, and reported after the fact. The customer just has no say in it and cannot
see it in advance.

## The three gaps

1. **No declared resolutions.** Nothing says what a model can output, so there is
   nothing to show or select.
2. **No combination validity.** Story Studio's requirement is that a ratio may be
   supported at one resolution and not another. A flat `aspect_ratios[]` cannot express
   that, and pairing two independent lists would advertise combinations that fail.
3. **No per-combination price.** `credits_per_image` is one number per model. If a 2K
   render costs more than 1K, Story Studio cannot show the real figure, and it will not
   compute customer prices locally.

## Requested shape — mirror what video already does

Please add a variants list to `ImageModelResponse`, in the same spirit as
`VideoModelResponse.variants[]`:

```json
{
  "id": "...",
  "aspect_ratios": ["16:9", "1:1"],
  "default_aspect_ratio": "16:9",
  "default_variant": { "resolution": "1k", "aspect_ratio": "16:9" },
  "variants": [
    {
      "resolution": "1k",
      "aspect_ratio": "16:9",
      "width": 1344,
      "height": 768,
      "credits_per_image": 4,
      "minimum_credits": 4,
      "price_version": "2026-07-01",
      "available": true
    },
    {
      "resolution": "2k",
      "aspect_ratio": "16:9",
      "width": 2688,
      "height": 1536,
      "credits_per_image": 9,
      "minimum_credits": 9,
      "price_version": "2026-07-01",
      "available": true
    }
  ]
}
```

Key points:

- **One row per valid combination.** This is the whole request. A ratio offered at 1K but
  not at 2K is expressed by simply not emitting that row — no client-side rule needed.
- **`default_variant`** is what Story Studio's batch and automated runs will use, so an
  unattended run is deterministic and consistent across an episode. Please make it an
  explicit field rather than "first row wins."
- **`width`/`height` per variant** lets Story Studio show the true pixel output before
  generating, and match it against the `width`/`height` the job later reports.
- **Per-variant price**, since that is the number the customer is shown. Keep
  `credits_per_image` at the model level for backwards compatibility if useful, but the
  variant price should win when present.
- **`available` per variant**, so a temporarily unavailable resolution can be disabled
  without retiring the whole model.

Then accept the choice on the request:

```json
{ "model_id": "...", "prompt": "...", "aspect_ratio": "16:9", "resolution": "2k" }
```

Please reject an unlisted `(resolution, aspect_ratio)` combination with a clear 400
rather than silently substituting a different one — a silent substitution would mean the
customer is charged for something other than what they chose, which Story Studio treats
as a correctness bug.

Echoing the chosen `resolution` back on `ImageJobResponse` (alongside the existing
`width`/`height`) would also let Story Studio audit old jobs after the catalogue changes.

## Until this exists

Story Studio will:
- show only `aspect_ratios[]` for the selected model, with a fixed label rather than a
  one-option selector when a model declares only one;
- price from `credits_per_image` and the promotion/reference fields;
- expose no resolution control at all, because none is contract-backed;
- surface the `width`/`height` the job reports as output information after the fact;
- use `default_aspect_ratio` for batch runs, resolved once and reused.

Nothing else changes. Story Studio will not infer resolutions from a model's name, and
will not pair independent lists into combinations GenStudio has not declared valid.
