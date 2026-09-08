# Golden Epic preview provenance

Eight previews are declared by three of this collection's five standalone Content Packs. **All eight now exist, and all eight passed review.** Job `69cf46dc` ran to completion on 2026-09-08 under the owner's authorisation for the whole preview programme; every returned original was accepted, nothing was re-rendered, and the accepted bytes, their digests and the conversion applied to each are in "Retained bytes" at the end of this file. All five packs build, sign and pass `validateContentPack` under an ephemeral authoring key.

The sections below are kept as they were written rather than rewritten in hindsight. What changed is stated in place, in "The 2026-09-08 render".

The two packs that declare no raster assets — `com.storystudio.topic.empires-and-civilisations-entire` and `com.storystudio.metadata-formula.entire-story-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other three are **blocked on previews only**; their documents already validate against the signed Content Pack schema.

## Three previews per visual style

The owner's rule, set on 2026-09-08 and applied to Royal History first, carries forward here: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty city.
- **face** — the hardest case the style can be asked for, chosen inside the style's own contract rather than against it. Golden Epic Poster forbids a face close to camera and forbids a second foreground figure, so its hardest case is the other thing it can fail: a face carried almost entirely on the shadow side of a hot sunset backlight, with maximum ornament density on the figure and the densest vista band behind, everything required to stay sharp at once.

The lettering pack keeps the shipped house standard of one to four swatches; this collection declares one swatch, at the 1024x576 figure the paid lettering packs already use. The Thumbnail Recipe declares four, as the Lost Voyage and Royal History recipes did, so that both portrait sides are shown twice and all three tagline styles appear.

## Why nothing was rendered in the authoring pass (kept as written)

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation existed when this collection was authored, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly. The authorisation covering this render arrived on 2026-09-08; what happened then is the section above.

## The 2026-09-08 render: authorised, submitted, run, reviewed

The owner authorised the whole preview programme in chat on 2026-09-08 — about 112 renders across every
collection — and ruled that images are made with `gpt-image-2` and no other product. This collection is
8 of them. The catalogue was checked live before anything was spent, and the product was confirmed
offered for the `pack-previews` project rather than assumed.

### The product, confirmed live before spending

| Field | Value |
| --- | --- |
| Product id / handle | `gpt-image-2` ("GPT Image 2", OpenAI, GenStudio cloud) |
| Availability | `available: true`, `chargeable: true`, `locked: false`, no admission permit required |
| Catalogue freshness | `stale: false` at the moment of submission — Story Studio refuses to spend against a product it cannot currently verify |
| Operations | `text-to-image`, `image-to-image` — this pass used **text-to-image only** |
| Chosen output row | **2K · 16:9 · 2560×1440**, `price_version` `price_img_0251_d908a58de1e58151dbccb23e` |
| Price | **29 credits per image**; 8 images = **232 credits** |
| Default row not used | 1K · 16:9 · 1280×720 at 20 credits |

The 2K row was chosen over the cheaper default deliberately, on the same reasoning the Lost Voyage pass
recorded: 2560×1440 **downscales** to the 1672×941 and 1024×576 contracts, where 1280×720 would have to be
**upscaled** 1.31×. Every acceptance test here turns on correctly spelled title text and fine serifs staying
legible at card size, and upscaling softens exactly that.

### The submission

One request, one job, no retries and no re-renders:

```
POST /api/projects/pack-previews/image-pool/generate
{ "pool_id": "pack-previews", "model": "gpt-image-2", "aspect_ratio": "16:9",
  "resolution": "2K", "variants": 1, "run_id": "golden-epic-previews-1",
  "prompts": [ ...the eight prompts below, in order... ], "reference_images": [] }
```

Job **`69cf46dc`** returned `8/8` and dropped `gen-golden-epic-previews-1-0001.png` … `-0008.png` into the Pack
Previews image pool in prompt order. The prompts recorded below are byte-identical to `params.prompts` on
the executed job, in the same order, which is what makes the file-to-prompt mapping in "Retained bytes" a
fact rather than an assumption.

### Review

Every returned original was decoded and looked at against its own prompt and the style bible of the pack it
advertises: lettering swatches for correct spelling and unclipped letterforms, style and scene previews for
stray text, and every file for logos, watermarks, UI and copied composition. **8 of 8 were accepted.**
Nothing was re-rendered and no slot was left unfilled. Two observations that did not rise to a rejection are
recorded against their rows in "Retained bytes" rather than left out, so a later reader sees what a reviewer
saw — a capitals-versus-small-capitals variance across the four recipe titles.

## The exact command a keyed operator ran

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is the GenStudio text-to-image lane for `gpt-image-2`. Eight prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering and title text is drawn by the image model, as the lettering and recipe contracts require).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "golden-epic-previews-1",
  "prompts": [ ...the eight prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.golden-epic-poster` | `assets/golden-epic-poster-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.golden-epic-poster` | `assets/golden-epic-poster-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.golden-epic-poster` | `assets/golden-epic-poster-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.bevelled-gold-cinematic-serif` | `assets/bevelled-gold-cinematic-serif.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.thumbnail.regalia-portrait-title-quadrant` | `assets/regalia-portrait-title-quadrant-1.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.regalia-portrait-title-quadrant` | `assets/regalia-portrait-title-quadrant-2.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.regalia-portrait-title-quadrant` | `assets/regalia-portrait-title-quadrant-3.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.regalia-portrait-title-quadrant` | `assets/regalia-portrait-title-quadrant-4.webp` | 1672x941 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Prompt 1 — `golden-epic-poster-hero.webp` (style preview, hero, no text)

> A hyper-detailed painterly digital illustration built as a cinematic history poster, sixteen by nine. On the right of the frame, one anonymous ruler in the full regalia of an ancient Mediterranean court stands at three-quarter length, cut at the hip, weight settled, turned slightly inward toward the centre, one hand resting on a staff of office — layered brocade, a bronze cuirass with worn edges, a heavy crimson mantle, a jewelled collar, every stitch and every scratch on the metal painted honestly. Behind and around them a whole civilisation sprawls away in receding bands: a near marble terrace with steps, then a city of palaces, temple platforms, colonnades and terraced roofs, then a working harbour crowded with masts and cranes, then walls and watchtowers and a road climbing into hills at the far edge. A low sunset sun sits behind the vista and throws broad god-rays through cloud and dust across the whole width of the frame, backlighting the figure with a hot bronze rim down the near shoulder and arm and lifting warm bounce into the shadow side of the face so nothing goes black. Everything is sharp, from the collar seam to the furthest mast; depth is made by volumetric haze thickening band by band, never by blur. Palette locked to gold, amber, bronze and deep crimson, with cool blue-grey and slate only in the shadow side and the deepest recesses. The upper left quadrant is kept quiet — sky, haze and the smallest distant architecture only. Horizon low, sky given the upper third, eye line just above the upper third. Monumental, warm and settled, nothing in motion. No text, no lettering, no watermark, no signature, no border, no second figure, no modern object.

## Prompt 2 — `golden-epic-poster-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A hyper-detailed painterly digital illustration of a whole ancient city at sunset, wide, with no person anywhere in it. From a height above an empty terrace, the eye reads down through receding bands: a marble balustrade and a still reflecting basin in the near ground, then temple platforms, colonnades, tiled roofs and courtyards, then a harbour with moored ships and empty quays, then long walls and watchtowers and a road running out into hills. Nothing is happening and nothing is about to; every street is empty, every ship is at rest. A low sunset sun sits behind the far hills, throwing broad god-rays through cloud and dust across the full width of the frame and laying warm light along every roofline and cornice. Everything is sharp, from the carving on the near balustrade to the rigging on the furthest ship; depth comes from volumetric haze thickening band by band, never from blur or from an unfinished background. Palette locked to gold, amber, bronze and deep crimson, with cool blue-grey and slate reserved for the shadowed courtyards and the deepest recesses. Horizon low, sky given the upper third and kept quiet. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 3 — `golden-epic-poster-face.webp` (style preview, hardest case, no text)

> A hyper-detailed painterly digital illustration pushed to the hardest case this look can be asked for, sixteen by nine. On the left of the frame, one anonymous ruler in the full regalia of a steppe court stands at three-quarter length, cut at the waist, turned slightly inward, positioned almost directly in front of a low sunset sun so the face is carried almost entirely on the shadow side against a blazing sky. Every difficult thing is present at once — the shadowed face still fully readable on warm bounce alone with no key light and no fill, the eyes holding a small warm catch, fine filigree on a headdress, riveted lamellar and chainmail, embroidered brocade over a fur collar, a chased gold belt plate and a worn scabbard mount, and bare hands at rest with the knuckles rendered as honestly as the face. A hot bronze rim runs the whole outer contour of the head, shoulder and arm. Behind and around them the densest vista band the format allows, still entirely sharp: a marching column with baggage train crossing the middle ground, a river crossing with a pontoon, a walled city with terraced roofs and watchtowers beyond, and a road climbing into hills at the far edge, each band separated by thickening volumetric haze with dust standing in the god-rays. Palette locked to gold, amber, bronze and deep crimson, cool blue-grey and slate only in the shadow side and the recesses. The upper right quadrant is kept quiet. No smoothing of the shadowed face, no fill light, no second sun. No text, no lettering, no watermark, no signature, no border, no second foreground figure, no face close to camera, no modern object.

## Prompt 4 — `bevelled-gold-cinematic-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen centred on a plain dark bronze ground. On one line, the two words GOLDEN EPIC set as bevelled metallic gold serif capitals with faceted stems, a warm highlight running along the top of each bevel and a subtle cool chrome edge tracing the lower contour, with even tracking. Directly beneath, held between two thin gold rules that run the full width of the words above, the three words THE ENTIRE STORY set much smaller in widely spaced small capitals of the same serif, in pale bronze rather than gold. Everything is matte-metallic with no outline, no glow and no drop shadow. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no third line of text.

## Prompt 5 — `regalia-portrait-title-quadrant-1.webp` (recipe, portrait right, title upper left, years tagline)

> A hyper-detailed painterly digital illustration used as a wide cover image, sixteen by nine. The right half of the frame carries one anonymous ruler in the full regalia of an ancient North African seafaring court at three-quarter length, cut at the hip, weight settled, turned slightly inward toward the centre, eyes level and unhurried rather than confronting the camera, one hand at rest on a staff of office; layered linen and brocade, a bronze pectoral, a deep crimson mantle. A low sunset sun behind the vista lays a hot bronze rim down the near shoulder and arm and leaves warm bounce in the shadow side of the face. Behind and around the figure a whole civilisation fills the rest of the frame in receding hazed bands — a near stone terrace, then temples and terraced roofs, then a circular war harbour crowded with masts, then walls and hills — with broad god-rays crossing the width of the frame. Everything is sharp, from the pectoral inlay to the furthest mast. In the upper left quadrant, and only there, render the title directly in the image on two lines: CARTHAGE on the first line in bevelled metallic gold serif capitals with faceted stems, a warm highlight along the top of each bevel and a subtle cool chrome edge beneath, and directly under it, held between two thin gold rules running the full width of that word, the line SIX HUNDRED YEARS BY SEA set much smaller in widely spaced small capitals of the same serif in pale bronze. Keep that quadrant's ground to sky, haze and the smallest distant architecture so nothing crosses behind the letters, and hold a clear margin between the outermost letter and both the top and the left edge. Palette locked to gold, amber, bronze and deep crimson with cool shadow. Text is perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no third line of copy, no second face, no recognisable individual.

## Prompt 6 — `regalia-portrait-title-quadrant-2.webp` (recipe, portrait left, title upper right, "the empire that" tagline)

> A hyper-detailed painterly digital illustration used as a wide cover image, sixteen by nine. The left half of the frame carries one anonymous ruler in the full regalia of a mainland Southeast Asian temple court at three-quarter length, cut at the waist, weight settled, turned slightly inward toward the centre, eyes level and unhurried, hands at rest; patterned silk, a tiered gold headdress, heavy gold armbands and a dark red sash. A low sunset sun behind the vista lays a hot bronze rim down the near shoulder and arm and leaves warm bounce in the shadow side of the face. Behind and around the figure a whole civilisation fills the rest of the frame in receding hazed bands — a near flagstone court, then stepped temple towers and colonnaded galleries, then a vast reservoir with causeways and moored boats, then rice terraces and forested hills — with broad god-rays crossing the width of the frame. Everything is sharp, from the carving on the near gallery to the furthest causeway. In the upper right quadrant, and only there, render the title directly in the image on two lines: THE TEMPLE KINGS on the first line in bevelled metallic gold serif capitals with faceted stems, a warm highlight along each bevel and a subtle cool chrome edge beneath, and directly under it, between two thin gold rules running the full width of that line, the line THE EMPIRE THAT BUILT ON WATER set much smaller in widely spaced small capitals of the same serif in pale bronze. Keep that quadrant's ground to sky, haze and the smallest distant architecture so no tower or causeway crosses behind the letters, and hold a clear margin to the top and the right edge. Palette locked to gold, amber, bronze and deep crimson with cool shadow. Text is perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no third line of copy, no second face, no recognisable individual.

## Prompt 7 — `regalia-portrait-title-quadrant-3.webp` (recipe, portrait right, title upper left, whole-life "the conqueror who" tagline)

> A hyper-detailed painterly digital illustration used as a wide cover image, sixteen by nine. The right half of the frame carries one anonymous ruler in the full regalia of a steppe court at three-quarter length, cut at the hip, weight settled, turned slightly inward toward the centre, eyes level and unhurried rather than confronting the camera, one hand resting on a sheathed sword that stays lowered; riveted lamellar over a fur-collared coat, a chased gold belt plate, a fur-trimmed helm carried in the other hand. A low sunset sun behind the vista lays a hot bronze rim down the near shoulder and arm and leaves warm bounce in the shadow side of the face. Behind and around the figure a whole civilisation fills the rest of the frame in receding hazed bands — a near grass rise with tethered horses, then a felt-tent camp, then a marching column with a baggage train crossing the middle ground, then a walled city with watchtowers and a road climbing into hills — with broad god-rays crossing the width of the frame. Nothing is in motion close to camera and no weapon is raised. In the upper left quadrant, and only there, render the title directly in the image on two lines: THE STEPPE CONQUEROR on the first line in bevelled metallic gold serif capitals with faceted stems, a warm highlight along each bevel and a subtle cool chrome edge beneath, and directly under it, between two thin gold rules running the full width of that line, the line THE CONQUEROR WHO NEVER LOST A FIELD set much smaller in widely spaced small capitals of the same serif in pale bronze. Keep that quadrant's ground to sky, haze and the smallest distant architecture, and hold a clear margin to the top and the left edge. Palette locked to gold, amber, bronze and deep crimson with cool shadow. Text is perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no third line of copy, no second face, no recognisable individual.

## Prompt 8 — `regalia-portrait-title-quadrant-4.webp` (recipe, portrait left, title upper right, years tagline)

> A hyper-detailed painterly digital illustration used as a wide cover image, sixteen by nine. The left half of the frame carries one anonymous ruler in the full regalia of a West African trading court at three-quarter length, cut at the waist, weight settled, turned slightly inward toward the centre, eyes level and unhurried, one hand at rest on a gold-mounted staff; layered indigo and gold-thread robes, a heavy gold collar and cuffs, a worked leather belt. A low sunset sun behind the vista lays a hot bronze rim down the near shoulder and arm and leaves warm bounce in the shadow side of the face. Behind and around the figure a whole civilisation fills the rest of the frame in receding hazed bands — a near packed-earth court under an awning, then a mud-brick city with a great pillared mosque and terraced roofs, then a caravan of loaded camels strung out along a river bend with moored canoes, then dunes and a road running to the horizon — with broad god-rays crossing the width of the frame. Everything is sharp, from the gold thread at the cuff to the furthest camel. In the upper right quadrant, and only there, render the title directly in the image on two lines: THE GOLD ROAD KINGS on the first line in bevelled metallic gold serif capitals with faceted stems, a warm highlight along each bevel and a subtle cool chrome edge beneath, and directly under it, between two thin gold rules running the full width of that line, the line FOUR HUNDRED YEARS set much smaller in widely spaced small capitals of the same serif in pale bronze. Keep that quadrant's ground to sky, haze and the smallest distant architecture so no roofline or minaret crosses behind the letters, and hold a clear margin to the top and the right edge. Palette locked to gold, amber, bronze and deep crimson with cool shadow. Text is perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no third line of copy, no second face, no recognisable individual.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| `content-packs/golden-epic/style/golden-epic-poster/assets/golden-epic-poster-hero.webp` | `gen-golden-epic-previews-1-0001.png`; original `efc3206f089884280ce6f7373e6fb179c1d7230ebb53b4a6f078afb5728a9bc4` (5573249 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `28b7c145996945ddbe979a603973b754e98caa143faa4108c7f7ab1905033e7d`; 326854 bytes; 1672x941 WebP decode passed | no text (style preview, hero); prompt 1 sha256 `cbfd1760396807ce4fa469b4791dc652216a891935249f8acdd7f58c7f2e452a`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/style/golden-epic-poster/assets/golden-epic-poster-scene.webp` | `gen-golden-epic-previews-1-0002.png`; original `09d7d7ec989ce35ba82f3281838c76c69825c9a4975467a44079da37c1392d4e` (5519845 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `470e7af082d0777f13163bc66a8967f18ffed4dda7a781404f09a17fbb892ae4`; 282846 bytes; 1672x941 WebP decode passed | no text (style preview, quiet wide scene, no figure); prompt 2 sha256 `c69eb39ff98a5c530b349fa9b1ee8dcc6d1cb9635c2e6b1cef6484c0eadd6f45`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/style/golden-epic-poster/assets/golden-epic-poster-face.webp` | `gen-golden-epic-previews-1-0003.png`; original `05b6860e0a8811bce2528c289631c1d4a5ee4a4ef89773b8f95e98b5008dd910` (4679731 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `d51ca0a44c2e7c8e18bf459f4dfded7a68da655deda6c95235de1faf8135760b`; 221888 bytes; 1672x941 WebP decode passed | no text (style preview, hardest case, backlit shadow-side face); prompt 3 sha256 `f151799d917ae5945dbad925548632c73e97887f94a915cc3df1cf29d69a80b1`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/lettering/bevelled-gold-cinematic-serif/assets/bevelled-gold-cinematic-serif.webp` | `gen-golden-epic-previews-1-0004.png`; original `c6dff8885420031c731dfdd9a023a70631654c2868aec0805bd08080fe49715e` (5728334 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `89e1c057a01e25fca56813088c0c9d5c81ab2e0c8ee7d9da539f3b59f5e5ebac`; 43682 bytes; 1024x576 WebP decode passed | GOLDEN EPIC / THE ENTIRE STORY (2 lines); prompt 4 sha256 `d583cb13da190e208e5ebc2b06ab656f97695870b36f2358667f541965457edb`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-1.webp` | `gen-golden-epic-previews-1-0005.png`; original `4320496348d210a0e813e145aaff03c9f50bbd4a24d398a0bddc0031ce0b4741` (5844733 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `c31fe07f02a4de16a5b769a008231a31650651ecbf5c04bc8e56d74235a45cd4`; 397578 bytes; 1672x941 WebP decode passed | CARTHAGE / SIX HUNDRED YEARS BY SEA; prompt 5 sha256 `278bf6141a5869484626c938376f0eecf0ac4586b9b167c1d54c7a977e9513d1`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-2.webp` | `gen-golden-epic-previews-1-0006.png`; original `f644430f7ca332ea9536e3368dc69a7509d2bf9c21277e0335bce9e323b982f6` (5869214 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `7af02ff4c42a1785f6bb76f0eaff2d9ba5ca34ce9fd7c2cd38fe0f014ac44cac`; 445572 bytes; 1672x941 WebP decode passed | THE TEMPLE KINGS / THE EMPIRE THAT BUILT ON WATER; prompt 6 sha256 `4fdf5ec025d9ecc682f917e10eb27eea4cbf14b8554f624ca6fd5cdc503a5195`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |
| `content-packs/golden-epic/thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-3.webp` | `gen-golden-epic-previews-1-0007.png`; original `37a15b961b289cec64b38f64b6620e5a45848e977f8cc96d68f69c4e1f527d4d` (5519597 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `4a45f014a178d96e9540d0bdf1810a6fd8b754da4337730f6469ab21afb023d1`; 340394 bytes; 1672x941 WebP decode passed | THE STEPPE CONQUEROR / THE CONQUEROR WHO NEVER LOST A FIELD; prompt 7 sha256 `f3ce584a9ad1be329617429a77c2c85f7afae3b483d72d45599b7e5d7bbcda10`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. Letterform note: this title and prompt 8 render as capitals-and-small-capitals rather than the uniform capitals of prompts 5 and 6. Both are capitals and both are correctly spelled, so both were accepted; the variance is recorded so a later pass can decide whether the recipe should pin one treatment. |
| `content-packs/golden-epic/thumbnail/regalia-portrait-title-quadrant/assets/regalia-portrait-title-quadrant-4.webp` | `gen-golden-epic-previews-1-0008.png`; original `be46e27913f6a54d6f536c072ee40624bc4b6dceb97c8589aa4585532b8e78d8` (5943948 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `249736cd00549e2e7107e2dec6591fbc0b2d2e048321298a00e8bf40d8b13311`; 400504 bytes; 1672x941 WebP decode passed | THE GOLD ROAD KINGS / FOUR HUNDRED YEARS; prompt 8 sha256 `4f079a25b15e0fc33cc3479fd29905710d475d963163d25aacfdd72da4f2d6d9`; GenStudio `gpt-image-2` via Story Studio Image Pool job `69cf46dc`, 29 credits, `reference_images: []`. |

One row per file, in the same form the sleep-history and Lost Voyage records use: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Every row above is for a file that was decoded and reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
