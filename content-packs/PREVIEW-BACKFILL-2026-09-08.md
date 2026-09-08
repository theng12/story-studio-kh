# Style preview backfill — 2026-09-08

Every Visual Style that shipped before today carries exactly one preview: its hero. This
document is the render brief that brings all of them up to the owner's three-preview rule. It
writes no pack, touches no `pack.json`, no `visual-style.json` and no authoring registry — it
only says what must be rendered, where each accepted file lands, what version each pack moves
to when it lands, and what the registry has to be told.

## The rule

Set by the owner on 2026-09-08, applied to Royal History first and then to Lost Voyage, Golden
Epic and Midnight Archives on the same day: **every Visual Style ships three previews, not one.**
The three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it
is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the
  look does to an empty room, an empty landscape or an empty table. Where a style's subject is an
  animal rather than a person, the scene prompt excludes the animal too: "no figure" is read
  strictly, as an empty picture.
- **face** — the hardest case the style can be asked for, chosen **inside** the style's own bible
  and negative prompt rather than against it. Usually that is a face close to camera or a crowd.
  Where the bible or the negative prompt forbids one or both, the hardest legal case is chosen
  instead and the reason is stated in one line above the prompt.

The four collections authored today — `lost-voyage`, `royal-history`, `golden-epic` and
`midnight-archives` — already ship three each and are out of scope here.

## Scope: 23 styles, 46 prompts

The task that commissioned this document estimated 26 styles and 52 prompts from the
`docs/catalogue/content-pack-index.md` line count. The real figure, taken from the packs on disk
rather than from the index, is **23 styles and 46 prompts**, and the difference is worth recording
rather than quietly absorbing:

- The index lists `com.storystudio.style.archival-documentary-reconstruction` **twice**, once at
  `content-packs/archival-ledger` and once at
  `content-packs/paid/archival-ledger/style/archival-documentary-reconstruction`. They are the
  same style. `content-packs/archival-ledger` is the **retired source monolith** —
  `scripts/content-packs/authoring-registry.mjs` names it in `RETIRED_SOURCE_ROOT` and refuses to
  register any source path under it. Only the `paid/` standalone pack is live, so the style is
  backfilled once, there, and the monolith is left alone.
- Three styles have both their superseded `1.0.0` directory and their current `1.0.1` directory on
  disk: `minimal-stick-figure-explainer`, `prehistoric-stick-cartoon` and
  `pastel-surreal-psychological-collage`. Only the current version needs previews; the superseded
  directory is a historical record and is not touched.

Counting pack directories rather than live styles gives 26–28 and double-counts exactly those
four. 23 is the number of Visual Styles a buyer can actually acquire today that have one preview.

## The render route

Identical to the Midnight Archives record. The Image Pool generator inside a running Story Studio
app, in a project whose configured image product is the GenStudio text-to-image lane for
`gpt-image-2`. One variant each, aspect `16:9`, 2K, `reference_images: []` — text only, no
reference asset, no image-to-image, no compositing, no post-render typography. **No style preview
in this pass contains text of any kind**, so nothing here asks the model to letter anything.

```
POST /api/projects/pack-previews/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "2K",
  "variants": 1,
  "run_id": "style-backfill-2026-09-08-a",
  "prompts": [ ...the prompts for that run id, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each
accepted original with a whole-image resize (cover, lanczos3) to 1672×941 — no crop beyond the
sub-pixel aspect trim, no overlay, composite, or repair — then WebP quality 90 effort 6, falling
back to lossless effort 6 for any file that lands under the 20,480-byte floor at quality 90.
Record the original digest and byte count, the accepted digest, byte count and decode result, and
the credits spent, in a per-collection `PREVIEW-PROVENANCE.md` row before committing the bytes.

Cost at the 2K · 16:9 · 2560×1440 row: **29 credits per image, 46 images, 1,334 credits.**

### Run ids: seven jobs of at most seven prompts

The installed app refuses a request body over 16 KiB on this route
(`CONTENT_STORE_REQUEST_TOO_LARGE`, a path-less body guard that every router mounted after
`content-store` inherits; scoped and fixed in source, but not in the build on this Mac). Forty-six
prompts do not fit in one request, and **no prompt may be shortened, merged or reworded to make it
fit — the prompt text is the contract.** So the pass is split into seven jobs with **distinct run
ids**, because the pool names files `gen-<run_id>-NNNN.png` with the index restarting at 1 for
each job and a shared run id would make the second job overwrite the first.

| Run id | Prompts | Files returned |
| --- | --- | --- |
| `style-backfill-2026-09-08-a` | 1–7 | `gen-style-backfill-2026-09-08-a-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-b` | 8–14 | `gen-style-backfill-2026-09-08-b-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-c` | 15–21 | `gen-style-backfill-2026-09-08-c-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-d` | 22–28 | `gen-style-backfill-2026-09-08-d-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-e` | 29–35 | `gen-style-backfill-2026-09-08-e-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-f` | 36–42 | `gen-style-backfill-2026-09-08-f-0001.png` … `-0007.png` |
| `style-backfill-2026-09-08-g` | 43–46 | `gen-style-backfill-2026-09-08-g-0001.png` … `-0004.png` |

Seven of these prompts serialise, with the request body around them, to between 8.7 KB and 9.9 KB
— comfortably inside the cap, with the largest run (`-f`) at 9,836 bytes. Check the serialised
body before each submission anyway; if a build carrying the scoping fix is installed by the time
this runs, the seven jobs can be collapsed, but the run ids must still be distinct per job.

## Acceptance contract per file

Every one of the 46 files must be:

| Property | Value |
| --- | --- |
| Dimensions | 1672×941 |
| Format | WebP, decodes cleanly |
| Floor | > 20 KB (20,480 bytes) |
| Text in image | none — these are style previews |

Path, pack-relative: `assets/<slug>-scene.webp` and `assets/<slug>-face.webp`, declared in
`content/visual-style.json` as `preview_assets` entries `"assets/<slug>-scene.webp"` and
`"assets/<slug>-face.webp"` alongside the existing hero entry.

Path on disk: **`content-packs/<collection>/style/<new version directory>/assets/<slug>-scene.webp`**.
Note the version directory, and note that `assets/` is a sibling of `content/`, not inside it.
This repository bumps a pack by creating a new sibling directory named `<slug>-v<version>` and
leaving the previous one in place — `minimal-stick-figure-explainer` and
`minimal-stick-figure-explainer-v1.0.1` are the existing precedent. Adding two preview assets
changes the content document, so **every pack in this pass gets a new version directory**; none of
these files land in the directory that ships today.

The six Production Looks heroes are owner-approved migrations with recorded checksums in
`content-packs/production-looks/PREVIEW-PROVENANCE.md`. **Those hero bytes are copied into the new
version directory unchanged and their checksums must still match after the bump.** They are not
re-rendered, not re-encoded and not re-cropped; they only gain two siblings.

## Version bumps when the assets land

| # | Collection | Slug | Current version | New version | New directory |
| --- | --- | --- | --- | --- | --- |
| 1 | `free-starters` | `cinematic-photoreal` | 1.0.0 | 1.0.1 | `free-starters/style/cinematic-photoreal-v1.0.1` |
| 2 | `free-starters` | `flat-vector-explainer` | 1.0.0 | 1.0.1 | `free-starters/style/flat-vector-explainer-v1.0.1` |
| 3 | `free-starters` | `hand-drawn-editorial-diagram` | 1.0.0 | 1.0.1 | `free-starters/style/hand-drawn-editorial-diagram-v1.0.1` |
| 4 | `free-starters` | `minimal-stick-figure-explainer` | 1.0.1 | 1.0.2 | `free-starters/style/minimal-stick-figure-explainer-v1.0.2` |
| 5 | `free-starters` | `paleo-documentary-tableau` | 1.0.0 | 1.0.1 | `free-starters/style/paleo-documentary-tableau-v1.0.1` |
| 6 | `free-starters` | `prehistoric-stick-cartoon` | 1.0.1 | 1.0.2 | `free-starters/style/prehistoric-stick-cartoon-v1.0.2` |
| 7 | `free-starters` | `sepia-ink-wash` | 1.0.0 | 1.0.1 | `free-starters/style/sepia-ink-wash-v1.0.1` |
| 8 | `free-starters` | `watercolor-storybook` | 1.0.0 | 1.0.1 | `free-starters/style/watercolor-storybook-v1.0.1` |
| 9 | `free-starters` | `waxy-outline-cartoon` | 1.0.0 | 1.0.1 | `free-starters/style/waxy-outline-cartoon-v1.0.1` |
| 10 | `legacy-thumbnail-restoration` | `dreamlike-luminous-sleep-illustration` | 1.0.0 | 1.0.1 | `legacy-thumbnail-restoration/style/dreamlike-luminous-sleep-illustration-v1.0.1` |
| 11 | `legacy-thumbnail-restoration` | `hand-drawn-hardship-cartoon` | 1.0.0 | 1.0.1 | `legacy-thumbnail-restoration/style/hand-drawn-hardship-cartoon-v1.0.1` |
| 12 | `legacy-thumbnail-restoration` | `impasto-psychological-animals` | 1.0.0 | 1.0.1 | `legacy-thumbnail-restoration/style/impasto-psychological-animals-v1.0.1` |
| 13 | `paid/archival-ledger` | `archival-documentary-reconstruction` | 1.0.0 | 1.0.1 | `paid/archival-ledger/style/archival-documentary-reconstruction-v1.0.1` |
| 14 | `production-looks` | `anime-cel` | 1.0.0 | 1.0.1 | `production-looks/style/anime-cel-v1.0.1` |
| 15 | `production-looks` | `hand-drawn-cartoon-explainer` | 1.0.0 | 1.0.1 | `production-looks/style/hand-drawn-cartoon-explainer-v1.0.1` |
| 16 | `production-looks` | `pixel-art-story` | 1.0.0 | 1.0.1 | `production-looks/style/pixel-art-story-v1.0.1` |
| 17 | `production-looks` | `retro-paint-fantasy` | 1.0.0 | 1.0.1 | `production-looks/style/retro-paint-fantasy-v1.0.1` |
| 18 | `production-looks` | `studio-catalog-realism` | 1.0.0 | 1.0.1 | `production-looks/style/studio-catalog-realism-v1.0.1` |
| 19 | `production-looks` | `whiteboard-doodle-explainer` | 1.0.0 | 1.0.1 | `production-looks/style/whiteboard-doodle-explainer-v1.0.1` |
| 20 | `psychology-editorial` | `pastel-surreal-psychological-collage` | 1.0.1 | 1.0.2 | `psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.2` |
| 21 | `sleep-history` | `old-master-still-life` | 1.0.0 | 1.0.1 | `sleep-history/style/old-master-still-life-v1.0.1` |
| 22 | `storytelling-looks` | `chinese-ink-wash-storytelling` | 1.0.0 | 1.0.1 | `storytelling-looks/style/chinese-ink-wash-storytelling-v1.0.1` |
| 23 | `symbolic-psychology-studio` | `oil-painting-classical` | 1.0.0 | 1.0.1 | `symbolic-psychology-studio/style/oil-painting-classical-v1.0.1` |

Rows 14–19 are the six Production Looks packs whose heroes are owner-approved migrations.

## The registry transition the assets task must perform

The authoring registry is at revision **185** as this document is written; take the current value
at the time of the change, not this one. Each of the 23 packs is a **new version**, so each needs
a new record — a bump is not an edit of the existing record, and the existing `1.0.0` (or `1.0.1`)
records stay exactly as they are.

For each pack, in one batch:

1. `node scripts/content-packs/authoring-registry.mjs reserve --request <reservation-request.json>`
   — one record per pack at the new version, `kind: "visual-style"`, `pack_id`
   `com.storystudio.pack.style.<slug>`, `item_id` `com.storystudio.style.<slug>`, `source_path`
   the **new** version directory from the table above, `publisher_id` `com.storystudio`,
   `min_app_version` `{{MIN_APP_VERSION}}` with `min_app_version_status` `release-bound`,
   `status: "reserved"`, and `expected_revision` set to the registry revision read immediately
   before the call.
2. `node scripts/content-packs/authoring-registry.mjs transition --request <lifecycle-request.json>`
   — one lifecycle request per pack moving it to `status: "authored"`, carrying the
   `receipt_ref` returned by the reserve above, `expected_revision` advanced to the revision the
   reserve produced, and a `coordinator` block naming this task and branch.

`source_path` must **not** point at `content-packs/archival-ledger` or anything under it; the
validator rejects the retired monolith by name. The Archival Ledger style is registered from its
`paid/` path.

Then regenerate the catalogue with `npm run content-pack:index` so the index picks up the new
versions, and run the pack build/sign/`validateContentPack` check under an ephemeral authoring key
for each of the 23.

## Where the hardest case had to be redefined

Nine of the 23 could not be asked for the obvious hardest thing without breaking their own
contract. In each case the hardest **legal** case was chosen and the reason is repeated in one
line above the prompt itself.

| Slug | Why the obvious hardest case is illegal | What was asked for instead |
| --- | --- | --- |
| `hand-drawn-editorial-diagram` | Bible is explicitly object-led; negatives reject mascot cartoon characters | A group of seven anonymous working people at a market stall, in the same ink-and-flat-colour language |
| `paleo-documentary-tableau` | Reconstructs deep time; there is no modern human subject, and negatives reject frantic action and distorted anatomy | An animal head close to camera inside a twelve-animal herd at three depths |
| `dreamlike-luminous-sleep-illustration` | Bible allows "a single calm character"; negatives reject alarming faces, peril and urgency | One calm sleeping face close, built entirely from wet washes with no hard edge |
| `hand-drawn-hardship-cartoon` | Bible says keep one readable focal animal and avoid crowding; negatives reject dense collage | One animal face very close, wet eyes and species detail, in uneven ink over flat fills only |
| `impasto-psychological-animals` | Negatives reject crowd scenes outright | One anthropomorphic animal's face and both paws, built from palette-knife ridges with no blending |
| `studio-catalog-realism` | Bible is tabletop product documentation with no people at all; negatives reject clutter and harsh reflections | Glass, water, polished chrome and wet ceramic together under one soft overhead source, with no blown highlight |
| `whiteboard-doodle-explainer` | Bible demands pure white ground, one idea per frame and generous empty space; negatives reject cluttered backgrounds | One very large marker face plus four small figures and three anthropomorphised objects, seven expressions, still one idea |
| `pastel-surreal-psychological-collage` | Negatives reject crowded scenes | One eroded portrait held together across painted skin, torn paper and blank plaster |
| `old-master-still-life` | Bible requires any person to be anonymous, at bust or half length, face calm and **turned slightly away** | That figure at bust length beside the objects, carrying skin, cloth and metal in one window falloff |

The other fourteen were asked for a close face or a crowd directly, which is what their bibles
already permit.

---

# The 46 prompts

Each prompt is a single blockquote under its own header. Headers are machine-readable in the same
form the earlier passes used: `## Prompt N — ` then the target filename in backticks, then the
collection and slug in parentheses.

## Prompt 1 — `cinematic-photoreal-scene.webp` (free-starters/cinematic-photoreal)

> A cinematic photorealistic still of an empty room at the end of the day, sixteen by nine, with no person anywhere in it and nothing happening. Late golden-hour sun comes through a tall window on the left and lays two long warm bars across a bare wooden floor, a plain table and an empty chair pushed back from it; a cool blue fill comes off the shadowed wall opposite, so the picture holds a warm key against a cold fill across its whole width. Dust hangs in the light as visible volumetric haze. The lens is long and open: the table edge and the grain of the wood are critically sharp, while the far doorway and the corner of the room fall away into soft round bokeh. Naturalistic materials throughout — worn varnish, chipped paint, the dull sheen of a metal handle, the weave of a folded cloth. Filmic grade with lifted blacks and gentle film grain over the whole frame, high dynamic range holding both the blown window and the detail inside the shadow. Anamorphic framing, horizon low, the right third left quiet. No cartoon, no illustration, no flat colour, no hard outline, no plastic CGI sheen, no harsh on-camera flash, no oversaturation. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 2 — `cinematic-photoreal-face.webp` (free-starters/cinematic-photoreal)

> A cinematic photorealistic still pushed to the hardest case this look can be asked for, sixteen by nine. One anonymous face fills the left half of the frame, cut at the shoulders, held close and turned three-quarters into a low golden-hour key that rakes across the cheek from the right, with a cool open-shade fill on the shadow side. Skin is rendered honestly at close range — visible pores, fine hair at the temple and along the jaw, a damp catchlight in each eye, the soft translucency where the sun passes through the ear and the rim of the nostril, and the small imperfections a prestige drama would leave in. The lens is wide open, so the near eye is critically sharp while the far eye, the shoulder and the whole background soften into round bokeh; behind the head is an out-of-focus street at dusk with warm point lights breaking up in the blur. Filmic grade with lifted blacks, gentle grain across the whole frame, high dynamic range holding the bright edge of the cheek and the detail inside the shadow at once. Anamorphic framing, the right third left as quiet fall-off. No cartoon, no illustration, no flat colour, no hard outline, no plastic CGI skin, no harsh on-camera flash, no beauty smoothing, no oversaturation. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 3 — `flat-vector-explainer-scene.webp` (free-starters/flat-vector-explainer)

> A clean flat vector illustration of an empty workplace, sixteen by nine, with no person anywhere in it. A desk seen straight on carries a laptop, a mug, a stack of paper, a small plant and a wall clock above it, each built from bold simple geometric shapes with crisp even line weights and no gradient anywhere. The palette is held to four colours and no more — a deep navy, a warm coral, a soft sand and an off-white ground — with balanced flat lighting and no modelled shading at all. Generous negative space carries the upper third and the right of the frame, so every silhouette reads instantly at small size. Detail is minimal by design: a shape is a shape, a shadow is a flat offset block of the same hue, and nothing is textured. Friendly modern explainer-video aesthetic, calm and balanced, with clear readable silhouettes throughout. No photorealism, no 3D render, no painterly brushwork, no texture, no gradients, no film grain, no realistic shading, no sketchy line, no busy clutter. No figure, no face, no hands, no text, no lettering, no numerals on the clock face, no watermark, no signature, no border, no logo.

## Prompt 4 — `flat-vector-explainer-face.webp` (free-starters/flat-vector-explainer)

> A clean flat vector illustration pushed to the hardest case this look can be asked for, sixteen by nine: five people in one frame, each with a face, built only from bold simple geometric shapes. They stand in a loose row facing the viewer at three-quarter length — different heights, hair shapes, skin tones and clothing blocks, and five clearly different expressions carried by nothing but the placement of two dots, a curve and two short brows. The palette is still held to four colours and no more, so skin, clothing and ground are all cut from the same small set, and figure-ground separation is achieved by shape and spacing rather than by adding a fifth hue. Crisp even line weights, no gradient anywhere, balanced flat lighting, flat offset blocks where a shadow is needed. Generous negative space above the heads and at both sides keeps every silhouette readable at small size. No photorealism, no 3D render, no painterly brushwork, no texture, no gradients, no film grain, no realistic shading, no rendered anatomy, no sketchy line, no busy clutter. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 5 — `hand-drawn-editorial-diagram-scene.webp` (free-starters/hand-drawn-editorial-diagram)

> A hand-drawn editorial diagram illustration of a quiet corner of a working harbour, sixteen by nine, with no person anywhere in it. On a warm off-white paper ground, fine dark ink outlines with subtly irregular human-drawn contours describe one strong central subject — a wooden crate hoist standing over a stone quay — with a balanced perimeter of supporting objects around it: coiled rope, a stack of sacks, a barrel, a hand cart, a mooring bollard and a low shed. Colour is lightly painted and opaque in ochre, terracotta, sage green, dusty blue and warm brown, laid inside the lines, with restrained crosshatching on the shadow sides and sparse pencil texture across the stone. Every object is grounded with a light shadow and nothing floats. Generous breathing room surrounds the hoist, and silhouettes stay crisp enough to read on a phone. Practical, optimistic, object-led explanatory staging in the manner of a polished magazine visual explainer. No photorealism, no 3D render, no glossy vector art, no mascot cartoon character, no thick marker doodle, no dark moody sepia wash, no monochrome parchment, no heavy watercolour bleeding, no cinematic lighting, no dense clutter, no tiny unreadable detail. No figure, no face, no hands, no text, no lettering, no label, no watermark, no signature, no border, no logo.

## Prompt 6 — `hand-drawn-editorial-diagram-face.webp` (free-starters/hand-drawn-editorial-diagram)

Hardest case redefined: this style is object-led and its negative prompt rejects mascot cartoon characters, so its hardest legal ask is a group of anonymous people drawn in the same restrained ink-and-flat-colour language.

> A hand-drawn editorial diagram illustration pushed to the hardest case this object-led look can be asked for, sixteen by nine: seven anonymous people at a covered market stall, drawn in the same fine dark ink outlines with subtly irregular human-drawn contours on a warm off-white paper ground. Two stand at the front in three-quarter view with their faces turned toward each other at readable size and their hands on the stall rail; five more are ranged behind at smaller scale, overlapping without merging, each given a distinct posture, hair shape and coat. Faces are built from the same restrained ink language as the produce and the scales — a few sure lines for the brow, the eye, the nose and the mouth — and filled with lightly painted opaque colour in ochre, terracotta, sage green, dusty blue and warm brown, with crosshatching only on the shadow sides. Everything stays grounded with a light shadow, and breathing room is kept above the heads so the group reads at mobile size. No photorealism, no 3D render, no glossy vector art, no mascot cartoon character, no thick marker doodle, no cinematic lighting, no dense clutter, no tiny unreadable detail, no rendered skin. No text, no lettering, no label, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 7 — `minimal-stick-figure-explainer-scene.webp` (free-starters/minimal-stick-figure-explainer)

> A polished minimalist stick-figure editorial explainer image, sixteen by nine, on a pure white background, with no person anywhere in it. The frame carries one instantly readable idea built from icon-like objects alone: a large closed suitcase standing slightly left of centre, an upright umbrella leaning against it, a folded map on the floor and a wall clock above, each drawn in smooth thick black outlines of consistent weight with clean interiors and no texture. A single restrained flat colour accent, warm yellow, appears on the map and nowhere else; everything else is black line on white. Subtle light-grey grounding shadows sit directly under the suitcase and the umbrella, and nothing else in the picture is shaded. Generous negative space fills the upper half and the right third, so the arrangement reads immediately at thumbnail size. Simple diagram-like staging, sparse environmental cues, no perspective beyond a flat ground line. No photorealism, no 3D render, no painterly brushwork, no whiteboard marker texture, no rough sketching, no scratchy line, no realistic anatomy, no cinematic lighting, no gradient, no detailed scenery, no cluttered background. No figure, no face, no hands, no text, no lettering, no numerals on the clock face, no watermark, no signature, no border, no logo.

## Prompt 8 — `minimal-stick-figure-explainer-face.webp` (free-starters/minimal-stick-figure-explainer)

> A polished minimalist stick-figure editorial explainer image pushed to the hardest case this look can be asked for, sixteen by nine, on a pure white background: six round white faces in one frame, each carrying a different and unmistakable emotion built from nothing but simple eyes, eyebrows and a mouth. They sit on clean line bodies with thin limbs, arranged in two rows of three at slightly different scales, one nearer the viewer and larger than the rest. The expressions must not blur into one another — confidence, doubt, alarm, boredom, relief and delight, each readable at thumbnail size from the brow angle and the mouth curve alone. Smooth thick black outlines of consistent weight throughout; the artwork stays black and white except for one restrained flat accent, red, used only on the alarmed figure. Subtle light-grey grounding shadows under each figure and nothing else shaded. Generous negative space above the heads and at both sides. No photorealism, no 3D render, no painterly brushwork, no whiteboard marker texture, no rough sketching, no scratchy line, no realistic anatomy, no cinematic lighting, no gradient, no detailed scenery, no cluttered background. No text, no lettering, no speech bubble, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 9 — `paleo-documentary-tableau-scene.webp` (free-starters/paleo-documentary-tableau)

> A painterly natural-history documentary tableau of a deep-time coastline with no animal and no person anywhere in it, sixteen by nine. A calm wide composition holds three clear layers: a foreground of wet black basalt and tide pools with sparse early plant growth at the water's edge, a midground of a shallow lagoon breaking softly against a low bar, and a distant layer of volcanic hills half dissolved in haze. Warm dawn amber comes low from the left through suspended sea mist, throwing soft sun shafts across the water and leaving the far hills in cool volcanic ochre and grey. Serene teal runs through the shallow water, mossy green holds the low growth, and gentle controlled texture sits in the rock and the sand without oversharpening. Softly hand-painted editorial finish, scientifically grounded-looking rather than fantastical, with spacious visual rest across the upper third of the sky. Approachable premium science-documentary mood. No photoreal live-action look, no glossy CGI plastic, no generic sci-fi, no horror, no gore, no dense collage, no frantic action, no oversharpened detail, no copied composition. No animal, no figure, no face, no text, no caption, no typography, no watermark, no logo, no border, no letterbox bars.

## Prompt 10 — `paleo-documentary-tableau-face.webp` (free-starters/paleo-documentary-tableau)

Hardest case redefined: this style reconstructs deep time and has no modern human subject, so its hardest legal ask is animal anatomy at close range inside a crowded herd.

> A painterly natural-history documentary tableau pushed to the hardest case this look can be asked for, sixteen by nine: a crowded herd on a river flat, with one large plant-eating animal's head brought close to the camera at the left of the frame while eleven more of its kind stand and drink behind it at three clear depths. The near head must hold up at close range — the wet muzzle, the fold and grain of hide, the eye with a soft catchlight, the natural set of the jaw — with anatomy that stays plausible and never gains an extra limb or a doubled joint. Behind it the herd overlaps without merging: bodies at full size in the midground, smaller silhouettes in the haze beyond, each animal readable and correctly proportioned. Warm dawn amber from the low left, mist between the layers, suspended water particles catching the light, mossy green on the banks, serene teal in the shallow water. Soft atmospheric depth, gentle controlled texture, spacious rest in the sky above the herd. No photoreal live-action look, no glossy CGI plastic, no generic sci-fi, no horror, no gore, no distorted anatomy, no extra limbs, no dense collage, no frantic action, no oversharpened detail. No human figure, no text, no caption, no typography, no watermark, no logo, no border, no letterbox bars.

## Prompt 11 — `prehistoric-stick-cartoon-scene.webp` (free-starters/prehistoric-stick-cartoon)

> A simple 2D educational cartoon of an empty prehistoric camp, sixteen by nine, with no person and no animal anywhere in it. Thick clean black outlines and flat digital colours describe a snowy valley floor with a low cave mouth at the left, a ring of stones around a small fire, three leaning shelter poles with hide stretched over them, a stack of firewood and a pair of stone tools left on a flat rock. The palette stays soft and limited — pale icy blues for the snow and the sky, warm browns for the hide, the wood and the rock, a single warm orange in the fire — with minimal shading, smooth clean fills and no gradient. The composition is uncluttered and wide, with the cave at the left third, the fire at the centre and the right half kept as open snow and sky so every shape reads at thumbnail size. Light, playful explainer-video energy without a joke needing to be told. No photorealism, no painterly brushwork, no 3D render, no realistic anatomy, no cinematic lighting, no detailed texture, no gritty darkness, no heavy gradient, no anime rendering, no horror mood, no background clutter. No figure, no face, no animal, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 12 — `prehistoric-stick-cartoon-face.webp` (free-starters/prehistoric-stick-cartoon)

> A simple 2D educational cartoon pushed to the hardest case this look can be asked for, sixteen by nine: eight stick-limbed cave people and one friendly mammoth crowded into a single snowy frame and still completely readable. The people have white round faces with tiny dot eyes and simple smiles, shaggy brown cave-hair silhouettes and thin stick limbs; they stand at three depths around the mammoth, two of them near the viewer at larger scale with their faces clearly visible, the rest smaller behind, overlapping without any silhouette getting lost in another. Each figure is doing one plain thing — carrying a bundle, pointing, crouching by a sled, holding a torch — so the group reads as a single idea rather than as a crowd. Thick clean black outlines throughout, flat digital colours, soft limited palette of pale icy blues and warm browns with one warm orange accent, minimal shading and smooth clean fills. Open snow and pale sky are left across the top of the frame for breathing room. No photorealism, no painterly brushwork, no 3D render, no realistic anatomy, no cinematic lighting, no detailed texture, no gritty darkness, no heavy gradient, no anime rendering, no horror mood, no background clutter. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 13 — `sepia-ink-wash-scene.webp` (free-starters/sepia-ink-wash)

> A line-and-wash illustration of an empty expedition tent at dusk, sixteen by nine, with no person anywhere in it. Fine pen-and-ink linework sits over loose watercolour washes on aged, faintly foxed paper: the canvas wall of the tent takes the left of the frame with its guy ropes and a folded flap, and inside it a camp table carries a lamp turned low, a closed journal, a brass instrument in its case and a tin cup. The palette is heavily desaturated — sepia browns and charcoal greys through the canvas and the ground, cold blue-grey in every shadow, and one warm lamplight accent pooling on the table and dying within a foot of it. Contrast stays low and the light stays dim and atmospheric; subtle crosshatching thickens in the shadow under the table and along the tent seam, and granulated watercolour settles visibly in the washes. A soft vignette closes the corners. Somber, contemplative, early-twentieth-century documentary feeling, the right third left as quiet empty ground. No vivid saturated colour, no neon, no photorealism, no 3D render, no glossy CGI, no clean flat vector, no bright cheerful palette, no hard digital edge, no anime, no lens flare. No figure, no face, no hands, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 14 — `sepia-ink-wash-face.webp` (free-starters/sepia-ink-wash)

> A line-and-wash illustration pushed to the hardest case this look can be asked for, sixteen by nine. One anonymous face in period expedition clothing is held close at the right of the frame, cut at the chest, turned three-quarters toward a low lamp standing just inside the lower left edge. The whole difficulty of the medium is on show: the modelling of the cheek and the brow is carried by loose granulated watercolour washes rather than by line, with only fine pen-and-ink contours at the collar, the hat brim, the bridge of the nose and the corner of the eye, and subtle crosshatching in the shadow under the jaw. Contrast stays deliberately low, so the lit side reads in warm lamplight sepia and the shadow side in cold blue-grey without either going to pure black or pure white. Aged foxed paper texture shows through the thinnest passages, and the washes are allowed to bloom slightly at the edge of the shadow rather than being corrected. Soft vignette at the corners, the left third left as dim empty ground. No vivid saturated colour, no neon, no photorealism, no 3D render, no glossy CGI, no clean flat vector, no bright cheerful palette, no hard digital edge, no anime, no lens flare. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 15 — `watercolor-storybook-scene.webp` (free-starters/watercolor-storybook)

> A soft watercolour storybook illustration of a small empty kitchen in the morning, sixteen by nine, with no person and no animal anywhere in it. Gentle layered washes over visible paper grain describe a round table with a cloth, two chairs, a teapot and a bowl of fruit, a window with the curtain drawn back, and a shelf of jars along the wall. The palette is warm and inviting — buttery yellow through the window light, soft rose and terracotta on the fruit, sage and cream through the room — with delicate colour bleeds where one wash meets another and a light pencil underdrawing still visible at the edges of the shapes. Lighting is soft and diffuse with no hard shadow anywhere, shapes are rounded and friendly, and the corners of the frame are left airy and almost untouched so the picture breathes. Whimsical, cosy, hand-painted picture-book feeling, quiet rather than busy. No photorealism, no 3D render, no harsh contrast, no neon colour, no hard vector edge, no gritty texture, no horror, no heavy black outline. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 16 — `watercolor-storybook-face.webp` (free-starters/watercolor-storybook)

> A soft watercolour storybook illustration pushed to the hardest case this look can be asked for, sixteen by nine: five anonymous children and two small animals gathered close around a low table, every face turned into the frame and every one of them clearly and separately expressive. The faces are the difficulty — round, friendly and painted with gentle layered washes rather than drawn, with the eyes, the mouths and the flush of the cheeks laid in with a small brush and no black outline anywhere. They overlap without merging: three at the near edge at larger scale, two behind and slightly higher, the animals tucked between them. Warm inviting palette of buttery yellow, soft rose, sage and cream, with delicate colour bleeds at the edges of the washes and a light pencil underdrawing showing through. Soft diffuse light with no hard shadow, visible paper grain across the whole frame, airy negative space kept above the heads. No photorealism, no 3D render, no harsh contrast, no neon colour, no hard vector edge, no gritty texture, no horror, no heavy black outline. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 17 — `waxy-outline-cartoon-scene.webp` (free-starters/waxy-outline-cartoon)

> An original waxy-outline cartoon of an empty back garden at midday, sixteen by nine, with no character anywhere in it. Thick black crayon-marker contours with visibly wobbly hand-drawn imperfections and gentle wax texture describe a shed with its door ajar, a watering can tipped on its side, a wheelbarrow, a row of bright flowers and a low fence, all set against flat saturated colour blocks — sky blue above, leaf green across the grass, warm orange on the shed roof, sunny yellow in the flowers, one small red accent on the watering can. Subjects are rounded and simplified with silhouettes readable at mobile size; the layers stay uncluttered, with the shed at the left third, the barrow at the centre and the right half left as open grass and sky. Minimal shading, no glossy polish, no gradient — the wax grain in the outline is the only texture in the picture. Playful science-and-curiosity explainer energy with one clear object of interest, the tipped can. No photorealism, no 3D render, no anime, no polished vector art, no perfectly smooth geometric line, no airbrushed gradient, no cinematic lighting, no detailed painterly scenery, no dense infographic callouts. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 18 — `waxy-outline-cartoon-face.webp` (free-starters/waxy-outline-cartoon)

> An original waxy-outline cartoon pushed to the hardest case this look can be asked for, sixteen by nine: six rounded characters packed into one frame, all reacting at once to the same thing just out of shot, and every reaction different and instantly readable. Oversized highly expressive eyes and brows do the work — one delighted, one horrified, one sceptical with a single raised brow, one open-mouthed, one squinting, one covering their eyes and peeking — drawn in thick black crayon-marker contours with visibly wobbly hand-drawn imperfections and gentle wax texture. They stand at two depths, three near the viewer at larger scale and three behind, overlapping without any face being cut in half. Flat saturated colour blocks in sky blue, leaf green, warm orange, sunny yellow and purple, with one small red warning accent on the horrified figure; a plain simple location cue behind them and nothing else. Minimal shading, no glossy polish, no gradient, readable at mobile size. No photorealism, no 3D render, no anime, no polished vector art, no perfectly smooth geometric line, no airbrushed gradient, no cinematic lighting, no detailed painterly scenery, no copied mascot character. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 19 — `dreamlike-luminous-sleep-illustration-scene.webp` (legacy-thumbnail-restoration/dreamlike-luminous-sleep-illustration)

> A luminous watercolour-and-gouache sleep-story illustration of an empty bedroom at night, sixteen by nine, with no person and no creature anywhere in it. Moonlit blue shadow fills the room from a tall window at the right, and a single candle on a bedside table lays amber glow and candle-gold highlights across a folded quilt, a wooden bedpost, a water jug and a low stool. Tactile paper grain shows through everywhere, with feathered edges and gentle colour blooms where the blue of the shadow meets the gold of the flame. Silhouettes are rounded and graceful; a spray of soft foliage leans in at the window and is lit only along its upper edges. The lighting stays diffuse and restful, with nothing sharp and nothing alarming, and generous breathing room is left across the upper left of the frame. A bedtime pace: quiet, slow, and entirely without incident. No visual peril, no urgency, no cliffhanger, no loud saturated neon, no high-contrast spectacle, no photoreal stock imagery, no glossy CGI, no hard vector edge, no dense collage. No figure, no face, no hands, no creature, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 20 — `dreamlike-luminous-sleep-illustration-face.webp` (legacy-thumbnail-restoration/dreamlike-luminous-sleep-illustration)

Hardest case redefined: this style's bible allows a single calm character and its negative prompt rejects alarming faces, peril and urgency, so its hardest legal ask is one calm face rendered entirely in a wet medium.

> A luminous watercolour-and-gouache sleep-story illustration pushed to the hardest case this look can be asked for while staying restful, sixteen by nine. One anonymous calm face rests close in the right half of the frame, seen three-quarters from above with the eyes closed and the cheek against a pillow, cut at the shoulder. The difficulty is doing that face in a wet medium without a single hard edge: the brow, the lashes, the bridge of the nose and the line of the lip are all built from layered washes and soft gouache with feathered edges and gentle blooms, and the modelling comes from where one wash was allowed to run into another rather than from any drawn contour. Moonlit blue shadow lies along the shaded side, candle gold rims the temple and the near cheek from a flame outside the frame at the lower right, and amber glow spreads gently into the pillow. Tactile paper grain across the whole picture, rounded graceful silhouette, generous quiet space at the left. The expression stays calm and asleep. No visual peril, no urgency, no alarming face, no loud saturated neon, no high-contrast spectacle, no photoreal stock imagery, no glossy CGI, no hard vector edge, no malformed anatomy. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 21 — `hand-drawn-hardship-cartoon-scene.webp` (legacy-thumbnail-restoration/hand-drawn-hardship-cartoon)

> A hand-drawn illustration of an empty riverbank in the late afternoon, sixteen by nine, with no animal and no person anywhere in it. Uneven black ink contours, thicker where a form turns away from the light and thinning almost to nothing along the top edges, describe a shallow bend of slow water, a half-submerged log, reed beds, a mud shelf with old tracks pressed into it and a leaning tree with exposed roots. Fills are flat and limited — warm moss and muted leaf green through the reeds, cream and faded gold across the mud bank, charcoal in the shadow under the log, quiet water tones in the river — laid inside the ink with no modelling and no gradient. The background is sparse and paper-like, with the upper third left almost bare so the frame breathes. The drawing is tactile and clearly made by hand, with small wobbles left in rather than corrected, and nothing crowds the composition. No photoreal stock imagery, no glossy CGI, no neon colour, no dense collage, no cluttered label, no dramatic glossy lighting, no malformed anatomy. No animal, no figure, no face, no text, no lettering, no caption, no watermark, no signature, no border, no logo.

## Prompt 22 — `hand-drawn-hardship-cartoon-face.webp` (legacy-thumbnail-restoration/hand-drawn-hardship-cartoon)

Hardest case redefined: this style's bible asks for one readable focal animal and no crowding, and its negative prompt rejects dense collage, so its hardest legal ask is a single animal face at very close range.

> A hand-drawn illustration pushed to the hardest case this look can be asked for, sixteen by nine: one animal's face held very close, filling the right half of the frame and cut at the shoulders, drawn only in uneven black ink contours over flat limited fills. Everything the medium finds hard is present at once — the eyes wide open and wet with a clear catchlight in each, species-defining detail crisp at close range in the set of the ears, the whiskers and the texture of the muzzle, the forelimbs folded under the chest with anatomically coherent joints, and the whole expression carried by posture and eye rather than by shading. The ink is thick along the shadow side of every contour and thins to a hairline where a form turns into the light; there is no modelling inside the fills at all. Warm moss, muted leaf green, cream, charcoal and faded gold, with a sparse paper-like ground behind the head and the left of the frame left almost bare. One focal animal only. No photoreal stock imagery, no glossy CGI, no neon colour, no dense collage, no crowd, no cluttered label, no cruelty, no malformed anatomy. No text, no lettering, no caption, no watermark, no signature, no border, no logo.

## Prompt 23 — `impasto-psychological-animals-scene.webp` (legacy-thumbnail-restoration/impasto-psychological-animals)

> A thick impasto oil painting of an empty room, sixteen by nine, with no figure and no animal anywhere in it. Visible palette-knife ridges build a plain wooden chair pushed back from a small table, a folded coat over the chair back, an unlit lamp, a cup and a closed door standing slightly ajar at the right. The paint is matte and dry-edged, with the ridge of each knife stroke catching the light along the table edge and the chair rail and the pigment thinning to bare canvas tooth where a form turns away. The palette is parchment cream and smoky umber through the walls, charcoal in the door frame and the shadow under the table, muted rust in the coat and a restrained dusty blue in the cup. Melancholy and quiet, with strong figure-ground separation between the furniture and the ground behind it and generous breathing room across the upper left. Editorial rather than decorative: the room reads as a place someone has just left. No cute mascot design, no photoreal stock photography, no glossy CGI, no neon colour, no dense collage, no crowd scene. No figure, no animal, no face, no text, no lettering, no caption, no watermark, no signature, no border, no logo.

## Prompt 24 — `impasto-psychological-animals-face.webp` (legacy-thumbnail-restoration/impasto-psychological-animals)

Hardest case redefined: this style's negative prompt rejects crowd scenes outright, so its hardest legal ask is one close animal face and both paws built from palette-knife paint with no blending.

> A thick impasto oil painting pushed to the hardest case this look can be asked for, sixteen by nine: one anthropomorphic animal's face held close in the left half of the frame, cut at the chest, calm and editorial, with both paws raised into frame in a legible human-scale gesture. The difficulty is that every hard thing must be built from palette-knife ridges and dry-brush edges rather than from blending — the fur direction across the muzzle and the brow, the wet look of the eye and its single catchlight, the set of the ears, the anatomically coherent fingers of both paws, and the fold of a plain collar at the throat. Matte pigment throughout, with the thickest paint reserved for the lit edge of the cheek and the knuckles and the ground behind kept thin and quiet so the figure separates cleanly. Parchment cream, smoky umber, charcoal, muted rust and a restrained dusty blue, with no bright colour anywhere. The right of the frame is left as open painted ground. The expression stays calm and melancholy rather than dramatic. No cute mascot design, no photoreal stock photography, no glossy CGI, no neon colour, no dense collage, no crowd scene, no malformed limb. No text, no lettering, no caption, no watermark, no signature, no border, no logo.

## Prompt 25 — `archival-documentary-reconstruction-scene.webp` (paid/archival-ledger/archival-documentary-reconstruction)

> An original archival documentary photographic reconstruction of an empty records office at the end of the working day, sixteen by nine, with no person anywhere in it, in warm charcoal-sepia monochrome. Wooden filing cabinets run back along one wall, a long desk carries an open ledger, a blotter, an inkstand and a stack of tied folders, and a window at the left throws a soft uneven light across the floorboards. The coat rack in the corner is empty; the furniture, materials and technology are all consistent with the period and nothing modern appears anywhere. Contrast is restrained, with softly lifted highlights in the window and deep but readable blacks in the recess behind the cabinets. Subtle silver-gelatin emulsion grain lies across the whole frame, with faint dust, one or two hairline scratches, a gently uneven exposure and a soft vignette at the corners. Modest depth of field, natural lens falloff, candid and observational rather than staged. This is an explicitly created reconstruction, not a claimed recovered source. No modern object, no contemporary clothing, no glossy colour photography, no vivid saturation, no cinematic blockbuster lighting, no polished CGI, no painterly illustration, no ink wash, no cartoon, no copied historical photograph, no extreme film damage. No figure, no face, no readable newspaper claim, no subtitle, no caption, no label, no logo, no watermark, no border, no letterbox bar.

## Prompt 26 — `archival-documentary-reconstruction-face.webp` (paid/archival-ledger/archival-documentary-reconstruction)

> An original archival documentary photographic reconstruction pushed to the hardest case this look can be asked for, sixteen by nine: a crowd of about twenty anonymous people gathered on a city street outside an institutional doorway, in warm charcoal-sepia monochrome. Three stand near the camera at readable size with their faces plainly visible in candid, unposed attitudes — one turned partly away, one caught mid-sentence, one looking past the lens — and the rest recede in three depths behind them, overlapping without merging, with hats, coats and shoulders reading correctly at every scale. Period clothing, architecture and materials throughout and nothing modern in the frame. Contrast stays restrained: softly lifted highlights across the pale stone, deep but readable blacks in the doorway. Subtle silver-gelatin emulsion grain over the whole picture, faint dust, a hairline scratch, gently uneven exposure, soft vignette, and a modest depth of field so the third rank begins to fall away. Observational documentary staging rather than a theatrical pose; every face is invented and none of them is a real person. No modern object, no contemporary clothing, no glossy colour photography, no vivid saturation, no cinematic blockbuster lighting, no polished CGI, no painterly illustration, no cartoon, no copied historical photograph, no famous-person likeness, no propaganda poster styling. No subtitle, no caption, no label, no readable newspaper claim, no logo, no watermark, no border, no letterbox bar.

## Prompt 27 — `anime-cel-scene.webp` (production-looks/anime-cel)

> A modern anime cel-shaded illustration of an empty street in the late afternoon, sixteen by nine, with no character anywhere in it. Clean confident lineart describes a narrow shopping lane with awnings, a vending machine, a bicycle leaning against a wall, a telegraph pole and a flight of steps rising at the far end; the background is painted in more detail than the foreground objects, as a key visual would have it, under a subtle gradient sky going from warm peach at the horizon to soft blue above. Cel shading throughout: crisp hard-edged shadow shapes, two values per surface and no more, no soft falloff, and a soft rim light along the top of the awnings and the pole where the low sun catches them. The palette is vivid but harmonious — warm ochre and terracotta in the buildings, deep teal in the shadow, a single saturated red on the vending machine. Dynamic composition with a strong diagonal from the near kerb to the steps, the upper right kept quiet. No photorealism, no 3D render, no western cartoon, no muddy colour, no sketchy unfinished line, no heavy film grain. No figure, no face, no hands, no text, no lettering, no signage copy, no watermark, no signature, no border, no logo.

## Prompt 28 — `anime-cel-face.webp` (production-looks/anime-cel)

> A modern anime cel-shaded illustration pushed to the hardest case this look can be asked for, sixteen by nine: a key-visual group of five original characters arranged across the frame, each face fully rendered and each one distinct. Two are near the camera at three-quarter length with their faces at large scale, two stand behind at mid scale, and one is turned in profile at the right edge; all five hold different expressions and no two share a hairstyle, a silhouette or a colour. Clean confident lineart of even weight throughout, flat cel shading with crisp hard-edged shadow shapes and exactly two values per surface, and a soft rim light along the shoulders and the hair from a low sun behind. The palette is vivid but harmonious and has to hold together across five costumes; the painted background behind them is a detailed street at dusk under a subtle gradient sky, kept a value darker so the group separates. Dynamic composition with the group set off centre and the upper left left open. No photorealism, no 3D render, no western cartoon, no muddy colour, no sketchy unfinished line, no heavy film grain, no realistic skin pores. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 29 — `hand-drawn-cartoon-explainer-scene.webp` (production-looks/hand-drawn-cartoon-explainer)

> A simple hand-drawn 2D cartoon explainer image of an empty room, sixteen by nine, with no character anywhere in it. Clean but slightly uneven thick black outlines with visibly wobbly human-drawn contours describe a desk with a laptop and a mug, a swivel chair, a low bookshelf, a potted plant and a wall calendar, set against a plain pale cream background. Flat solid colour fills only, in the house palette of medium blue, teal, sage green, warm yellow, tan, cream and grey, with minimal shading and no gradient anywhere. One clear visual idea carries the frame: the chair is turned away from the desk and the mug still steams. The composition is readable and medium-wide with generous breathing room above and to the right, and the interior is only lightly detailed so nothing competes. No photorealism, no 3D render, no anime, no painterly brushwork, no glossy polished vector art, no perfectly geometric shape, no cinematic lighting, no gradient, no complex texture, no dense clutter, no dramatic depth of field. No figure, no face, no hands, no text, no lettering, no writing on the calendar, no speech bubble, no watermark, no signature, no border, no logo.

## Prompt 30 — `hand-drawn-cartoon-explainer-face.webp` (production-looks/hand-drawn-cartoon-explainer)

> A simple hand-drawn 2D cartoon explainer image pushed to the hardest case this look can be asked for, sixteen by nine: seven round-headed characters in one frame, each with oversized outlined circular eyes, dot pupils, bold eyebrows and a small expressive mouth, and each carrying a different clear emotion. Four stand at the front at larger scale in three-quarter view and three behind at smaller scale, overlapping without any head being cut into by another; their black line limbs and rounded plain coloured torsos keep every silhouette separate. The expressions must not collapse into a single default smile — surprise, worry, satisfaction, confusion, impatience, amusement and calm, each readable from the brow and the mouth alone. Clean but slightly uneven thick black outlines with wobbly human-drawn contours, flat solid colour fills in medium blue, teal, sage green, warm yellow, tan, cream and grey, a plain pale cream background, minimal shading and no gradient. Generous breathing room above the heads. No photorealism, no 3D render, no anime, no painterly brushwork, no glossy polished vector art, no perfectly geometric shape, no cinematic lighting, no gradient, no complex texture, no realistic skin, no dense clutter. No text, no lettering, no speech bubble, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 31 — `pixel-art-story-scene.webp` (production-looks/pixel-art-story)

> A 16-bit pixel art fantasy scene with no character anywhere in it, sixteen by nine, in a retro RPG aesthetic. An abandoned forest shrine sits off centre to the left: a mossy stone arch, a cracked flagstone floor, a stone basin holding still water, a broken lantern post, and a path of worn steps leading away to the right into tileable trees. Every edge is pixel-defined with no anti-aliased softness, forms are clean and sprite-like, and the palette is restricted to a small retro set of muted greens, cool stone greys, warm sand and one saturated cyan for the water. Dramatic light is translated into pixel clusters rather than gradients — a hard band of dappled sun across the flagstones, a dithered transition into the shade under the trees, and a few bright single pixels for highlights on the wet stone. Readable silhouettes at every scale, tileable background logic in the tree line and the path, side-scrolling adventure energy with the composition weighted off centre. No photorealism, no painterly brushwork, no smooth gradient, no ultra-detailed rendering, no 3D render, no soft airbrush shading, no centred static composition. No figure, no face, no creature, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 32 — `pixel-art-story-face.webp` (production-looks/pixel-art-story)

> A 16-bit pixel art fantasy scene pushed to the hardest case this look can be asked for, sixteen by nine: a crowded market square in a retro RPG town with fourteen distinct sprites in it, and one large near-camera character bust at the left occupying a third of the frame. The bust is the difficulty — a face built from pixel clusters alone, with the eyes, the brow, the mouth and the jaw all readable at that scale without a single anti-aliased edge, the hair blocked in three tones and the skin in four, and dithering used for every transition instead of a gradient. Behind it the square is full: stallholders, shoppers, a child, a dog, a guard on the steps, each a clean sprite-like form with a readable silhouette at small size and none of them merging into another. Restricted retro palette of warm sand, terracotta, muted green and cool grey with one saturated cyan accent; dramatic light translated into hard pixel bands across the awnings and the cobbles. Tileable background logic in the buildings, composition weighted off centre. No photorealism, no painterly brushwork, no smooth gradient, no ultra-detailed rendering, no 3D render, no soft airbrush shading, no realistic skin texture, no centred static composition. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 33 — `retro-paint-fantasy-scene.webp` (production-looks/retro-paint-fantasy)

> A crude 90s paint-program fantasy scene with no character anywhere in it, sixteen by nine, in a retro internet animation aesthetic. A medieval hall stands empty: a long trestle table with tankards and a spilled bowl, a stone hearth with a rough fire in it at the right, banners hanging crookedly from the beams, a suit of armour on a stand, and a heavy door standing open at the far end. Thick black outlines, rough hand-drawn lines with obvious wobble, flat colours from a limited palette of brick red, mud brown, dull gold, deep green and grey, simple shading in one flat darker tone per surface, and intentionally low-detail rendering throughout. Dramatic wide-angle perspective from low down at the near end of the table, so the boards rush away toward the door, and a dynamic off-centre composition with the hearth pushed to the right edge. Minimal texture and clean digital fill areas — the roughness is in the line, not in the paint. No photorealism, no realistic anatomy, no cinematic realism, no ultra-detailed rendering, no 3D render, no smooth glossy surface, no centred composition. No figure, no face, no creature, no text, no lettering, no writing on the banners, no watermark, no signature, no border, no logo.

## Prompt 34 — `retro-paint-fantasy-face.webp` (production-looks/retro-paint-fantasy)

> A crude 90s paint-program fantasy scene pushed to the hardest case this look can be asked for, sixteen by nine: nine characters crammed into a tavern frame, all reacting at once, every face drawn with the same rough hand-drawn line and every expression exaggerated and unmistakable. Three are near the camera at large scale with wide eyes and open mouths, four are ranged behind at mid scale, and two more peer in from the right edge, while a barrel-chested figure at the left is caught mid-shout. Thick black outlines with obvious wobble, flat colours from a limited palette of brick red, mud brown, dull gold, deep green and grey, one flat darker tone per surface for shading, and intentionally low-detail rendering — the faces are expressive because of the drawing, not because anything is rendered. Dramatic wide-angle perspective with the near figures stretched by the lens and the room falling away behind them; dynamic off-centre composition with the crowd weighted to the left. No photorealism, no realistic anatomy, no cinematic realism, no ultra-detailed rendering, no 3D render, no smooth skin, no glossy realism, no centred composition. No text, no lettering, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 35 — `studio-catalog-realism-scene.webp` (production-looks/studio-catalog-realism)

> A clean studio catalogue photograph of a carefully staged physical miniature diorama with no figure in it, sixteen by nine. A neutral charcoal textured sweep runs behind and beneath a small tabletop arrangement: a wooden crate, a coil of rope, three ceramic jars of different heights, a folded length of coarse linen and a pair of iron shears, set out with space between them so each object is fully visible. A soft large overhead source lights everything evenly, laying natural soft-edged shadows to the lower right and modelling the materials honestly — the grain and dust of the wood, the fibre of the rope, the matte glaze of the ceramic, the weave of the cloth, the dull grey of the iron. Colour is accurate and restrained; depth of field is high, so the nearest crate corner and the farthest jar are equally sharp. Centred product-documentation composition, minimal styling, generous breathing room at the top of the frame, and a subtle commercial polish that never becomes a set piece. No dramatic cinematic lighting, no fantasy digital painting, no clutter, no glossy CGI, no floating object, no extreme shallow depth of field, no harsh reflection, no oversaturated colour. No figure, no face, no hands, no logo, no packaging, no label, no barcode, no typography, no watermark, no border.

## Prompt 36 — `studio-catalog-realism-face.webp` (production-looks/studio-catalog-realism)

Hardest case redefined: this style is tabletop product documentation with no people in its bible at all, and its negative prompt rejects clutter and harsh reflections, so its hardest legal ask is the four materials this lighting handles worst, together, under one soft source.

> A clean studio catalogue photograph pushed to the hardest case this look can be asked for, sixteen by nine, with no figure in it: a carefully staged miniature still life of the four materials this lighting handles worst, all at once. On a neutral charcoal textured sweep stand a tall clear glass cylinder half filled with water, a polished chrome sphere resting in a shallow steel dish, a sheet of clear acrylic leaning against a matte block, and a wet black ceramic bowl with a film of water in it. A single soft large overhead source lights the group, so every transparent edge, every refraction through the glass and the water line, and every reflection in the chrome and the acrylic has to resolve without one harsh specular hotspot and without a blown highlight anywhere. Shadows are natural and soft-edged, falling to the lower right; depth of field is high, so the reflected sweep inside the sphere is as sharp as the rim of the cylinder. Accurate restrained colour, honest tactile materials, minimal styling, centred product-documentation composition with generous breathing room. No dramatic cinematic lighting, no fantasy digital painting, no clutter, no glossy CGI, no floating object, no extreme shallow depth of field, no harsh reflection, no oversaturated colour. No figure, no face, no hands, no logo, no packaging, no label, no barcode, no typography, no watermark, no border.

## Prompt 37 — `whiteboard-doodle-explainer-scene.webp` (production-looks/whiteboard-doodle-explainer)

> A simple hand-drawn whiteboard-doodle illustration on a pure white background, sixteen by nine, with no character anywhere in it. Thick black marker outlines with smooth rounded shapes and clean vector-like lines draw one large central object — an open suitcase seen slightly from above — with a small ring of simplified icons around it: a folded map, a compass, an umbrella, a plain rectangular card and a clock. Two curved arrows and a hand-drawn circle direct attention from the icons to the case. The artwork is almost entirely black line on white; one limited flat colour accent, blue, fills the compass needle and nothing else. There is no realistic perspective, no environment and no shading of any kind, and generous empty space is left across the upper third and the right of the frame. One idea per image, drawn as if quickly sketched on a whiteboard but with confident even line weight, highly readable at small size. No photorealism, no 3D render, no painterly brushwork, no cinematic lighting, no realistic shading, no gradient, no film grain, no busy cluttered background, no detailed environment, no soft airbrush, no colour photograph. No figure, no face, no hands, no text, no lettering, no marker headline, no watermark, no signature, no border, no logo.

## Prompt 38 — `whiteboard-doodle-explainer-face.webp` (production-looks/whiteboard-doodle-explainer)

Hardest case redefined: this style demands a pure white ground, one idea per frame and generous empty space, and its negative prompt rejects cluttered backgrounds, so its hardest legal ask is seven expressions held inside a single idea rather than a crowd.

> A simple hand-drawn whiteboard-doodle illustration pushed to the hardest case this look can be asked for, sixteen by nine, on a pure white background: one very large stick-figure head at the left, a circle filling nearly half the frame, with a single unmistakable expression — eyebrows raised high, eyes wide, mouth open — drawn in thick black marker line and nothing else. Facing it at the right, four smaller stick figures and three anthropomorphised everyday objects, a clock, a lightbulb and a folded box, each given its own simple face and its own clear reaction to the same thing. Seven expressions in one frame, all built from circles, dots and a few marker strokes, all separable at thumbnail size. Two curved arrows run from the small group toward the large head. The artwork stays black line on white except for two limited flat accents — yellow inside the lightbulb, red on one alarmed figure. No realistic perspective, no environment, no shading, and clear empty space kept between the head and the group. No photorealism, no 3D render, no painterly brushwork, no cinematic lighting, no realistic shading, no gradient, no film grain, no busy cluttered background, no detailed environment, no soft airbrush, no realistic anatomy. No text, no lettering, no marker headline, no speech bubble, no watermark, no signature, no border, no logo, no recognisable individual.

## Prompt 39 — `pastel-surreal-psychological-collage-scene.webp` (psychology-editorial/pastel-surreal-psychological-collage)

> A matte mixed-media psychological collage with no figure in it, sixteen by nine. A doorway stands alone in an otherwise bare interior: a pale plaster wall, a shallow step, and the door itself slightly open onto flat unlit dark. Painterly and sculptural traces sit over the surfaces — torn paper edges where the wall meets the ground, a rubbed and eroded passage along the door frame, a restrained blur across the lower left corner as if a layer had been lifted away — with subtle grain across the whole picture. The palette stays low in saturation and holds together: dusty peach in the light on the wall, mauve and lavender through the shadow, pale blue in the doorway, cream and warm grey across the floor, charcoal in the opening, and one restrained ember-orange accent on the very edge of the door where a light beyond it catches. Figure-ground separation stays strong despite the low contrast. Sparse, tactile and psychologically suggestive rather than literal, with the right half of the frame left almost empty. No glossy CGI, no photoreal stock imagery, no neon colour, no crowded scene, no malformed anatomy. No figure, no face, no hands, no text, no typography, no logo, no watermark, no border.

## Prompt 40 — `pastel-surreal-psychological-collage-face.webp` (psychology-editorial/pastel-surreal-psychological-collage)

Hardest case redefined: this style's negative prompt rejects crowded scenes, so its hardest legal ask is one portrait held together across three different physical materials.

> A matte mixed-media psychological collage pushed to the hardest case this look can be asked for, sixteen by nine: one anonymous face, close and set left of centre, deliberately fragmented. The upper half is painted as skin with sculptural traces and a chalky matte surface; across the eyes the image tears into a torn-paper edge and continues as a smooth blank plaster mask; the lower half returns to painted skin with the mouth softly eroded at one corner. A restrained blur passes through the shoulder and the ground behind, and subtle grain lies over the whole picture. The whole difficulty is holding one readable, psychologically legible face together across three different physical materials without any of the joins reading as damage. The palette stays low in saturation — dusty peach and cream in the lit skin, mauve and lavender in the shadow, pale blue in the plaster, charcoal and warm grey behind — with a single restrained ember-orange accent at the tear itself. Strong figure-ground separation despite the low contrast, and the right third left as sparse empty ground. No glossy CGI, no photoreal stock imagery, no neon colour, no crowded scene, no gore, no malformed anatomy. No text, no typography, no logo, no watermark, no border, no recognisable individual.

## Prompt 41 — `old-master-still-life-scene.webp` (sleep-history/old-master-still-life)

> An old-master oil still life in the seventeenth-century northern European manner, sixteen by nine, with no person in it. One hero object carries the frame: a wide earthenware bowl on a worn wooden tabletop, with a pewter jug, a horn-handled knife, a folded coarse linen cloth and three walnuts arranged sparingly beside it. A single cool window light falls from the upper left and dies quickly, so the near rim of the bowl and the shoulder of the jug are lit while the far side of the table drops toward the deep umber-to-black ground, which carries no visible wall detail at all. Thick layered glazes with soft painterly edges, visible impasto only on the brightest specular points — the wet inside of the bowl, the lit curve of the pewter, the edge of the blade — with fine craquelure across the whole surface and a subtle varnish sheen as if photographed under museum lighting. Warm earth browns, ochre, muted crimson and olive with bone white in the linen, and cool grey-blue only in the light itself. Framing is close and quiet, the tabletop just below eye level, with ample dark negative space above the objects. No flat vector, no cartoon, no anime, no pixel art, no watercolour, no pastel, no gouache, no photorealistic photograph, no 3D render, no CGI, no neon, no saturated modern colour, no bright even studio lighting, no white background, no lens flare, no bokeh. No figure, no face, no readable text, no lettering, no caption, no logo, no watermark, no signature, no frame, no border.

## Prompt 42 — `old-master-still-life-face.webp` (sleep-history/old-master-still-life)

Hardest case redefined: this style's bible requires any person to be anonymous, shown at bust or half length, calm, and turned slightly away, so a face to camera is out of contract and the hardest legal ask is that figure carrying skin, cloth and metal in one window falloff.

> An old-master oil still life in the seventeenth-century northern European manner pushed to the hardest case this look permits, sixteen by nine. An anonymous period-dressed figure is shown at bust length at the right of the frame, calm and turned slightly away from the viewer, lit by the same single cool window light from the upper left; the objects remain the subject — a pewter cup, a clay jar, a coarse linen cloth and a horn-handled knife on the worn wooden tabletop in front of the figure. The difficulty is carrying skin, cloth and metal in the same falloff: the lit temple and the near cheek take small specular highlights and the rest of the face descends into the deep umber-to-black ground, with the eye on the shadow side barely readable and never lifted by a fill. Thick layered glazes, soft painterly edges, impasto only on the brightest points — the rim of the cup, the damp lower lip, the lit edge of the collar — with fine craquelure and a subtle varnish sheen over everything. Warm earth browns, ochre, muted crimson and olive, bone white in the linen, cool grey-blue only in the light. The face is invented and is not a recognisable individual, and no wall detail appears behind it. No flat vector, no cartoon, no anime, no pixel art, no watercolour, no pastel, no gouache, no photorealistic photograph, no 3D render, no CGI, no neon, no saturated modern colour, no bright even studio lighting, no white background, no lens flare, no bokeh. No readable text, no lettering, no caption, no logo, no watermark, no signature, no frame, no border.

## Prompt 43 — `chinese-ink-wash-storytelling-scene.webp` (storytelling-looks/chinese-ink-wash-storytelling)

> A monochrome Chinese ink-wash narrative on warm ivory rice paper, sixteen by nine, with no figure in it. A river bend occupies the lower left: a rocky spur drawn with variable-pressure calligraphic contours, a stand of bare trees whose branches thin from a loaded black stroke to a dry-brush hairline, and a low reed bank where diluted ink has pooled and dried with a visible edge. Beyond it, mist takes the middle of the picture entirely, and a far ridge returns as the palest wash with a few near-black anchors at its base. Wet blooms are allowed where the wash was laid into damp paper along the water's edge, dry-brush texture carries the rock, and restrained hatching appears only in the deepest recess under the spur. Active negative space fills the upper right and reads as air rather than as emptiness. Asymmetrical, spacious narrative framing with contemplative literati stillness and selective detail — the near reeds fully drawn, everything beyond them given only what it needs. No sepia or foxed expedition-journal styling, no lamplight, no edge vignette, no coloured watercolour, no storybook, no pastel, no gouache, no oil paint, no photorealism, no CGI, no vector, no cartoon, no anime. No figure, no face, no readable calligraphy, no seal, no chop, no signature, no logo, no watermark, no border, no letterbox.

## Prompt 44 — `chinese-ink-wash-storytelling-face.webp` (storytelling-looks/chinese-ink-wash-storytelling)

> A monochrome Chinese ink-wash narrative on warm ivory rice paper pushed to the hardest case this look can be asked for, sixteen by nine: one anonymous face brought close at the left of the frame, cut at the shoulder, built entirely from variable-pressure brush contours and diluted pooled ink, with no drawn outline and no hatching in the skin. The brow, the eyelid, the bridge of the nose and the line of the mouth are each a single loaded stroke that thins as it travels; the modelling of the cheek is one pale wash allowed to bloom into damp paper and left uncorrected; the hair is near-black and laid in with a dry brush so the paper shows through at its edge. A small grouping of three more figures stands at middle distance behind, each given no more than five strokes and still legible in posture. Mist separates the near face from the group, and active negative space carries the whole right of the picture. Near-black anchors at the shoulder and in the hair hold the tonal range while everything else stays pale. Contemplative literati stillness, selective detail, asymmetrical spacious framing. No sepia or foxed expedition-journal styling, no lamplight, no edge vignette, no coloured watercolour, no storybook, no pastel, no gouache, no oil paint, no photorealism, no CGI, no vector, no cartoon, no anime. No readable calligraphy, no seal, no chop, no signature, no logo, no watermark, no border, no letterbox, no recognisable individual.

## Prompt 45 — `oil-painting-classical-scene.webp` (symbolic-psychology-studio/oil-painting-classical)

> A classical oil painting in the old-master manner of an empty interior, sixteen by nine, with no figure in it. A single dramatic light source enters high from the left — a narrow shaft through a shuttered window — and picks out a heavy draped table, a pewter ewer, a stack of leather-bound volumes, a fallen glove and the carved arm of a chair, leaving the rest of the room in deep warm shadow. Visible impasto sits on the lit edges of the ewer, the fold of the drape and the spine of the topmost book; rich layered glazes carry everything in the half-light; painterly edges let the chair arm dissolve into the dark rather than ending in a line. Deep chiaroscuro with a warm earthen palette — umber, ochre, muted crimson in the drape, olive in the shadow — and canvas texture visible through the thinner passages. Baroque atmosphere and museum-quality depth, with the upper right two-thirds of the picture given over to unlit ground. No flat vector, no pixel art, no cartoon, no neon colour, no 3D CGI render, no hard digital edge, no modern clip-art look, no low-resolution rendering. No figure, no face, no hands, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 46 — `oil-painting-classical-face.webp` (symbolic-psychology-studio/oil-painting-classical)

> A classical oil painting in the old-master manner pushed to the hardest case this look can be asked for, sixteen by nine. One anonymous face is held close in the right half of the frame, cut at the chest, turned three-quarters into a single dramatic light source entering high from the left, with no fill of any kind. The chiaroscuro is severe: the lit temple, the bridge of the nose, the near cheek and the collar carry the whole tonal range while the far eye, the jaw and the shoulder descend into deep warm shadow, held together only by rich layered glazes and the faintest reflected warmth. Visible impasto is reserved for the brightest points alone — the highlight on the cheekbone, the wet line of the lower lid, a single point on the lip — and painterly edges let the shadow side dissolve into the ground with no contour anywhere. Warm earthen palette of umber, ochre and muted crimson over an olive underpainting, with canvas texture reading through the thin darks. Baroque atmosphere and museum-quality depth; the left third of the picture is unlit ground. The face is invented and is not a recognisable individual. No flat vector, no pixel art, no cartoon, no neon colour, no 3D CGI render, no hard digital edge, no modern clip-art look, no low-resolution rendering. No text, no lettering, no watermark, no signature, no border, no logo.
