# Custom style adoption — run record, 2026-10-25/26

What this directory is: the identity reservation, the run log and the refusal log for
adopting fifteen of the owner's own channel art styles as standalone Store Visual Styles.
The pack sources live in `content-packs/custom-looks/`; their provenance lives in
`content-packs/custom-looks/PREVIEW-PROVENANCE.md`.

## Authorisation

Owner, 2026-10-25, after reading the triage:

- accepted all fifteen ADOPT items, the sixteen "use the store style" mappings, both merges
  and the one skip;
- then cut the adoption to nine, then reversed the cut on the same day: **"make it all 15 but
  make them a bit distinct from each other"**. The fifteen below are that final set, and the
  six restored by the reversal carry an explicit contrast clause in their style bible.

Owner, 2026-10-25, on previews: **"for the preview images, we just use the local Qwen 2.1
turbo to generate it"** — the named authorisation for a preview-generation pass on the local,
zero-credit lane only.

## Identities

Reserved in one batch, originally at authoring-registry revision 302 → **303** on `main`.
When the collection was rebased onto `release/1.4.359` (which already carries the Formula
revisions), the reserve and author steps were **replayed through the registry module's own
functions** at revision 326 → **327**, with the seventeen transitions (15 authored to
revision 342) keeping the journal a valid replay.

Re-chained a third time, 2026-10-27, onto `release/1.4.361`: that branch had already reserved
the five Sleep Formula successors at 326 → **332**, so this branch's 326-based chain could not
merge. The same reserve and author steps were replayed once more through the registry
module's own functions at revision 332 → **333**, with the fifteen authored transitions
reaching revision **348**. The two batches the 1.4.359 branch had repaired (293 and 303) were
repaired first and re-derived **byte-identical receipts**, because a re-mint's values depend
on the batch's own `expected_revision`, not on the head. No pack identity moved.

Current receipt (the 1.4.361 re-chain): `authoring:85da73f8062c23ff136e937dd298ab93db64bfa19e8242e945761c786e3b6aed`

Superseded receipt (the 1.4.359 replay, still the one recorded in that branch's history):
`authoring:3deacf1b2cad68dad4aa7a3cda1323cfa9eb230c055a3edcc847ecd1acdf0fd8`

Pack ids: `com.storystudio.pack.style.<slug>`, item ids `com.storystudio.style.<slug>`,
version `1.0.0`, source path `content-packs/custom-looks/style/<slug>`.

| slug | name | nearest Store neighbour |
|---|---|---|
| carved-woodcut-print | Carved Woodcut Print | Inked Crosshatch Storybook (pen, not carved) |
| lush-painterly-scenery | Lush Painterly Scenery | Paleo Documentary Tableau (teal, misty, places organisms) |
| dark-moody-painterly | Dark Moody Painterly | Dark Sepia Documentary Scene (sepia/slate, mist, distant figures) |
| vintage-copperplate-engraving | Vintage Copperplate Engraving | Sepia Ink & Wash / Inked Crosshatch Storybook |
| warm-cosy-interior-illustration | Warm Cosy Interior Illustration | none — the Store paints no interior |
| storybook-stick-figure-cartoon | Storybook Stick-Figure Cartoon | Prehistoric Stick Cartoon (bound to prehistory) |
| muted-isometric-infographic | Muted Isometric Infographic | none — no isometric style on the shelf |
| dark-folk-horror-gouache | Dark Folk-Horror Gouache | Dark Sepia Documentary Scene |
| stained-glass-panel-illustration | Stained-Glass Panel Illustration | none — no leaded glass on the shelf |
| clean-editorial-illustration | Clean Editorial Illustration | Flat Vector Explainer |
| museum-diorama | Museum Diorama | Studio Catalog Realism |
| cosy-night-pixel-art | Cosy Night Pixel Art | Pixel Art Story |
| matte-gouache-storybook | Matte Gouache Storybook | Watercolor Storybook |
| naturalist-watercolour-plate | Naturalist Watercolour Plate | Naturalist Sketchbook |
| painterly-prehistoric-life | Painterly Prehistoric Life | Paleo Documentary Tableau |

## Generation lane

`studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4`, discovered live from the Gateway
catalogue before every request, 16:9 1K (1280x720), unique Idempotency-Key per request,
explicit seed. Price read at each request: `credits_per_image: 0`, `minimum_credits: 0`,
`chargeable: false`. One request in flight at a time; the runner waits while any
`mflux-generate` process is running on this Mac. No paid provider and no other model was used.

## Refusals

Every refused render was moved, with its request and receipt, to
`_trash/content-pack-previews-20261026/` and never rewritten. See `refusals.json` beside this
file for the exact list and faults; the pattern worth knowing is that **landscape and
linear subjects hold these mediums, while smooth man-made objects on a table drift to
photography whatever the prompt says**. The woodcut quietly-scene brief and the whole
dark-moody-painterly set were re-briefed on that finding rather than re-rolled unchanged.

## The alias map

`electron/server/content-packs/style-aliases.ts` resolves the owner's 46 existing preset ids
(21 project presets + 27 shared-pack style ids, minus the one skipped style) to the Store
style that now owns each look, at READ time only. No preset, project config or user style
pack is rewritten. Its own commit is flagged `app`; it needs the 1.4.359 runtime.
