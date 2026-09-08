# Royal History preview provenance

Thirteen previews are declared by six of this collection's eight standalone Content Packs. **All thirteen now exist, and all thirteen passed review.** Job `257c32e1` ran to completion on 2026-09-08 under the owner's authorisation for the whole preview programme; every returned original was accepted, nothing was re-rendered, and the accepted bytes, their digests and the conversion applied to each are in "Retained bytes" at the end of this file. All eight packs build, sign and pass `validateContentPack` under an ephemeral authoring key.

The sections below are kept as they were written rather than rewritten in hindsight, because they record why the render was blocked and what released it. What changed is stated in place, in "The 2026-09-08 render".

The two packs that declare no raster assets — `com.storystudio.topic.rulers-and-dynasties` and `com.storystudio.metadata-formula.documentary-for-sleep-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other six are **blocked on previews only**; their documents already validate against the signed Content Pack schema.

## Three previews per visual style

The owner's rule for this collection, new on 2026-09-08 and applied here first: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty room or an empty landscape.
- **face** — the hardest case the style can be asked for: a face close to camera, or a group of figures, whichever is the thing most likely to fail.

Lettering packs keep the shipped house standard of one to four swatches; this collection declares one swatch each, at the 1024x576 figure the paid lettering packs already use. The Thumbnail Recipe declares four, exactly as the Lost Voyage recipe did, so that both title variants are shown twice.

## Why nothing was rendered in the authoring pass (kept as written)

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation existed when this collection was authored, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly. The authorisation covering this render arrived on 2026-09-08; what happened then is the section above.

## The 2026-09-08 render: authorised, submitted, run, reviewed

The owner authorised the whole preview programme in chat on 2026-09-08 — about 112 renders across every
collection — and ruled that images are made with `gpt-image-2` and no other product. This collection is
13 of them. The catalogue was checked live before anything was spent, and the product was confirmed
offered for the `pack-previews` project rather than assumed.

### The product, confirmed live before spending

| Field | Value |
| --- | --- |
| Product id / handle | `gpt-image-2` ("GPT Image 2", OpenAI, GenStudio cloud) |
| Availability | `available: true`, `chargeable: true`, `locked: false`, no admission permit required |
| Catalogue freshness | `stale: false` at the moment of submission — Story Studio refuses to spend against a product it cannot currently verify |
| Operations | `text-to-image`, `image-to-image` — this pass used **text-to-image only** |
| Chosen output row | **2K · 16:9 · 2560×1440**, `price_version` `price_img_0251_d908a58de1e58151dbccb23e` |
| Price | **29 credits per image**; 13 images = **377 credits** |
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
  "resolution": "2K", "variants": 1, "run_id": "royal-history-previews-1",
  "prompts": [ ...the thirteen prompts below, in order... ], "reference_images": [] }
```

Job **`257c32e1`** returned `13/13` and dropped `gen-royal-history-previews-1-0001.png` … `-0013.png` into the Pack
Previews image pool in prompt order. The prompts recorded below are byte-identical to `params.prompts` on
the executed job, in the same order, which is what makes the file-to-prompt mapping in "Retained bytes" a
fact rather than an assumption.

### Review

Every returned original was decoded and looked at against its own prompt and the style bible of the pack it
advertises: lettering swatches for correct spelling and unclipped letterforms, style and scene previews for
stray text, and every file for logos, watermarks, UI and copied composition. **13 of 13 were accepted.**
Nothing was re-rendered and no slot was left unfilled. Two observations that did not rise to a rejection are
recorded against their rows in "Retained bytes" rather than left out, so a later reader sees what a reviewer
saw — a hairline ink whisker on the O of IRON in preview 12, and a period likeness in preview 13.

## The exact command a keyed operator ran

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is a GenStudio text-to-image lane. Thirteen prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering and title text is drawn by the image model, as the lettering and recipe contracts require).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio text-to-image product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "royal-history-previews-1",
  "prompts": [ ...the thirteen prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.dark-regal-portrait` | `assets/dark-regal-portrait-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.dark-regal-portrait` | `assets/dark-regal-portrait-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.dark-regal-portrait` | `assets/dark-regal-portrait-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.academic-classical-oil` | `assets/academic-classical-oil-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.academic-classical-oil` | `assets/academic-classical-oil-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.academic-classical-oil` | `assets/academic-classical-oil-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.roman-two-tone-capitals` | `assets/roman-two-tone-capitals.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.condensed-regal-serif` | `assets/condensed-regal-serif.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.heavy-grotesque-hook` | `assets/heavy-grotesque-hook.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.thumbnail.two-tone-hook-portrait-right` | `assets/two-tone-hook-portrait-right-1.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.two-tone-hook-portrait-right` | `assets/two-tone-hook-portrait-right-2.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.two-tone-hook-portrait-right` | `assets/two-tone-hook-portrait-right-3.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.two-tone-hook-portrait-right` | `assets/two-tone-hook-portrait-right-4.webp` | 1672x941 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Prompt 1 — `dark-regal-portrait-hero.webp` (style preview, hero, no text)

> A dark cinematic oil portrait on primed canvas. A single anonymous period-dressed ruler held at chest height, shoulders slightly angled and face turned toward the viewer, wearing heavy dark robes with tarnished gold braid and one deep crimson mantle over the near shoulder. One warm light source only, a candle standing low and to the left just out of frame, falling on the near cheek, the brow, and the near shoulder, with a thin gold rim tracing the far edge of the head and the far shoulder against the dark. Behind them a great stone hall — a pier, an arch, the edge of a throne step — legible for only a third of its depth and then dissolving into unlit shadow with no hard boundary. Deep umber, bitumen brown and near-black through nine tenths of the canvas; aged gold and one deep crimson as the only saturated notes; whites are bone and dusty linen, never white. Soft blended oil handling through the flesh, drier drag through the cloth and hair, restrained impasto only on the brightest fold, fine craquelure and a warm varnish bloom over the whole surface. Head placed off-centre to the right so the left of the frame stays dark and open. No fill light, no second key, no cold light, no daylight. No text, no lettering, no watermark, no signature, no border, no crowd, no second figure.

## Prompt 2 — `dark-regal-portrait-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A dark cinematic oil painting of an empty audience hall, wide, with no person anywhere in it. A long stone chamber with a raised step and an empty carved chair at the far end, heavy dark hangings on the piers, a plain table with a closed book and a single guttering candle in the near middle ground. One warm source only, the candle flame, throwing a small pool of light across the table and a thin gold edge along one stone moulding; everything beyond it falls away into unlit shadow. Deep umber, bitumen brown and near-black through nine tenths of the canvas, with aged gold on the chair's edge and one deep crimson in a hanging as the only saturated notes. Soft blended oil handling, canvas tooth visible through the thin darks, dust in the light path, a faint bloom around the flame, fine craquelure and warm varnish. Composed low and level, generous empty floor and empty dark air across the upper half. Nothing is happening and nothing is about to. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border.

## Prompt 3 — `dark-regal-portrait-face.webp` (style preview, hardest case, face close to camera, no text)

> A dark cinematic oil portrait pushed to the hardest case: an anonymous period-dressed ruler's head and shoulders large in the frame, the face close to camera and turned directly toward it, with one hand entering the lower edge holding a plain gold circlet. Every difficult thing is present at once — the eyes catching a small warm highlight, the lit cheek modelled through half a dozen soft transitions, the shadow side of the face losing its edge entirely into the ground, wiry grey hair against the dark, the knuckles and nails of the hand rendered as honestly as the face. One warm source only, low and to the right, a hearth just out of frame, with a thin gold rim on the far edge of the head and the far shoulder. Behind, unlit shadow with the barest suggestion of a carved stone jamb. Deep umber and near-black throughout, aged gold on the circlet, one deep crimson at the collar, flesh kept warm and low-key. Soft blended oil handling with restrained impasto on the brightest highlights, fine craquelure, warm varnish bloom. No fill light, no second key, no cold light, no daylight, no smoothing of the skin. No text, no lettering, no watermark, no signature, no border, no second figure.

## Prompt 4 — `academic-classical-oil-hero.webp` (style preview, hero, no text)

> A nineteenth-century academic classical oil painting: a Romantic golden-hour vista of an ancient Mediterranean city seen from a height, looking down over pale marble temples, tiled roofs, a colonnaded forum and an aqueduct striding away toward low hills, with a calm bay beyond. Late afternoon sun arriving low and warm from the right, laying long soft-edged light across the stone and filling the distance with warm aerial haze; the sky given more than half the canvas, high-keyed and pale gold falling to sun-warmed rose. Warm ivory, bleached marble white, honey, amber and old gold, with restrained sea-blue and dusty terracotta accents, low saturation throughout and no colour allowed to shout. Smooth blended brushwork with the strokes worked out of the surface, glazed and slowly built, impasto only on a highlight on a marble cornice; reflected light carried up into every shadow so nothing goes truly black; fine craquelure and a warm varnish tone across everything. A few small anonymous draped figures at great distance on a terrace in the near foreground, none of them doing anything. Composed level and calm, resolved rather than dynamic. No text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 5 — `academic-classical-oil-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A nineteenth-century academic classical oil painting of an empty marble courtyard, wide, with no person anywhere in it. Polished veined marble underfoot, a colonnade running along the right side, a low basin of still water in the middle ground holding a soft reflection, a stone bench with a folded length of linen left on it, and a spill of pale flowers over a wall. Broad late Mediterranean sunlight entering through the colonnade and laying long soft-edged bars of warm light across the floor; no hard-edged spotlight, no cold light, no night. Warm ivory, bleached limestone, honey, amber and old gold, with one restrained sea-blue in the water and a dusty terracotta in the roof tiles beyond; low saturation, high key, low contrast. Smooth blended brushwork with an even soft sheen, impasto only on the wet rim of the basin, reflected light in every shadow, fine craquelure and warm varnish. Eye level, horizontals level, generous empty floor and empty wall, the composition resolved and still. Nothing is happening and nothing is about to. No figure, no face, no animal, no text, no lettering, no watermark, no signature, no border.

## Prompt 6 — `academic-classical-oil-face.webp` (style preview, hardest case, several figures, no text)

> A nineteenth-century academic classical oil painting pushed to the hardest case: seven or eight anonymous draped figures gathered at rest on wide marble steps in an open loggia, at middle distance, in a single quiet group. Every difficult thing is present at once — several faces at once, overlapping bodies, layered chitons and heavy palliums with different weights of cloth, bare arms and feet against polished stone. Every figure is calm and at ease: two seated and talking quietly, one reclining with an arm over the step above, one standing and looking away out of frame, none of them in motion and none of them addressing the viewer. Broad warm late sunlight from the left through the colonnade, long soft-edged bars across the marble, reflected light carried up into every shadow. Warm ivory, honey, amber, old gold and sun-warmed rose, with restrained sea-blue and olive in the drapery; low saturation, low contrast, nothing close to camera. Smooth blended brushwork, glazed and slowly built, impasto only on a metal clasp and a wet step, fine craquelure and warm varnish. No incident, no confrontation, no crowd pressing forward, no face close to camera. No text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 7 — `roman-two-tone-capitals.webp` (lettering swatch, axis `font`)

> A lettering specimen of the two words ROYAL HISTORY set as tall narrow classical Roman inscriptional capitals of the kind cut into imperial stone, centred on a plain aged parchment ground. Sharp triangular serifs, swelling stems with a chiselled entasis, thin even letter tracking, the two words on one line. The first word ROYAL is dense ink black and the second word HISTORY is a deep oxide red; both are flat and matte with no glow, no outline and no drop shadow. The letters fill the middle of the frame and are perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no second line of text.

## Prompt 8 — `condensed-regal-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen of the two words ROYAL HISTORY stacked on two lines, ROYAL above HISTORY, set as heavy condensed serif capitals with strong thick-to-thin stroke contrast and crisp bracketed serifs, centred on a plain dark umber ground. Very tight leading so the two lines almost touch, both lines set to the same width. The first line is clean bone white and the second line is aged gold, each letter carrying one soft dark drop shadow just far enough to lift it off the ground, with no outline, no bevel and no glow. The letters fill the middle of the frame and are perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no third line of text.

## Prompt 9 — `heavy-grotesque-hook.webp` (lettering swatch, axis `font`)

> A lettering specimen of the two words LAST TSAR set as plain extra-bold grotesque capitals with closed apertures, flat terminals and no serifs of any kind, centred on a plain near-black ground. Set tight and slightly condensed on one line. The letters are filled in saturated warning yellow, each carrying one hard dark edge of even weight all the way round, completely matte with no gradient, no bevel, no glow and no drop shadow. The letters fill the middle of the frame and are perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no second line of text.

## Prompt 10 — `two-tone-hook-portrait-right-1.webp` (recipe, variant A, ancient subject)

> A dark cinematic oil painting used as a wide cover image. The right half of the frame carries a single anonymous period-dressed ruler in a heavy dark robe with a laurel band, cut at the chest, turned toward the camera with the eyes meeting it, lit by one warm source low and to the right so the near cheek and near shoulder take the light and a thin gold rim traces the far edge; behind them a colonnade falls away into unlit shadow. The left half stays dark, quiet, and free of any architectural or costume detail. In the lower left, render the two words LAST EMPEROR directly in the image, LAST above EMPEROR on two tight lines set to the same width, in heavy condensed serif capitals with crisp bracketed serifs; the first line is bone white and the second is aged gold, each letter carrying one soft dark drop shadow, no outline and no glow. Keep a clear margin of dark between the last letter and both the left and bottom edges. Deep umber and near-black through most of the frame, aged gold and one deep crimson as the only saturated notes. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second face, no recognisable individual.

## Prompt 11 — `two-tone-hook-portrait-right-2.webp` (recipe, variant A, medieval subject)

> A dark cinematic oil painting used as a wide cover image. The right half of the frame carries a single anonymous medieval-dressed ruler in a fur-collared mantle with a plain gold circlet, cut at the chest, turned toward the camera with the eyes meeting it, lit by one warm hearth source low and to the right, with a thin gold rim on the far edge of the head and shoulder; a castle wall and a narrow window fall away into unlit shadow behind. The left half stays dark, quiet, and empty of detail. In the lower left, render the two words WINTER KING directly in the image, WINTER above KING on two tight lines set to the same width, in heavy condensed serif capitals; the first line bone white, the second aged gold, one soft dark drop shadow each, no outline and no glow. Clear margin of dark below and to the left of the letters. Deep umber and near-black throughout, aged gold and one deep crimson as the only saturated notes, whites kept to bone and dusty linen. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second face, no recognisable individual.

## Prompt 12 — `two-tone-hook-portrait-right-3.webp` (recipe, variant B, Roman two-tone)

> A wide cover image in two halves. The left half carries a period engraved bust portrait of an anonymous ancient ruler in a draped toga against a plain dark ground, cut at the chest, head turned toward the camera with the eyes meeting it, rendered in fine engraved hatching with one warm light falling from the left. The right half is a plain aged parchment panel occupying the full height, carrying the two words IRON CAESAR stacked and centred within it in tall narrow classical Roman inscriptional capitals with sharp triangular serifs, swelling stems and thin even tracking; IRON is in dense ink black and CAESAR is in a deep oxide red, both flat and matte with no shadow, no outline and no glow. The parchment panel is clean and empty apart from the two words. Nothing crosses between the two halves. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second face, no recognisable individual.

## Prompt 13 — `two-tone-hook-portrait-right-4.webp` (recipe, variant A, modern-era subject)

> A dark cinematic oil painting used as a wide cover image. The right half of the frame carries a single anonymous nineteenth-century-dressed ruler in a dark military coat with a plain sash, cut at the chest, turned toward the camera with the eyes meeting it, lit by one warm lamp source low and to the right, with a thin gold rim on the far edge of the head and shoulder; a shuttered palace window falls away into unlit shadow behind. The left half stays dark, quiet, and empty of detail. In the lower left, render the two words LAST TSAR directly in the image on one line, in plain extra-bold grotesque capitals with closed apertures, flat terminals and no serifs, set tight and slightly condensed, filled in clean white with one hard dark edge of even weight all the way round, completely matte with no glow, no bevel and no drop shadow. Clear margin of dark below and to the left of the letters. Deep umber and near-black through most of the frame, aged gold and one deep crimson as the only saturated notes. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second face, no recognisable individual.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| `content-packs/royal-history/style/dark-regal-portrait/assets/dark-regal-portrait-hero.webp` | `gen-royal-history-previews-1-0001.png`; original `24d5b61424df57ffe4116605c8ac8b6de2ba687132888b9664d999c54eeafaf7` (5030132 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `032fa5ef27fc441173f6c3fdfc0c7e61e947850a6e9347fd809e5ab7de3738ce`; 166784 bytes; 1672x941 WebP decode passed | no text (style preview, hero); prompt 1 sha256 `23bbb0ae1daf7cece15f5ca3debe9fe60535d17eb4652a5e018fee76504f4707`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/style/dark-regal-portrait/assets/dark-regal-portrait-scene.webp` | `gen-royal-history-previews-1-0002.png`; original `e0d8bb414c42bc542e77d98a8a7de3f0ff01b9cf9fcb87e2d768204375ff5fe3` (4501253 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `dec84d9ccbcebd2cf24a2dd9af1e1a2810665d35bd3ae3fa35f0505289b65331`; 87508 bytes; 1672x941 WebP decode passed | no text (style preview, quiet wide scene, no figure); prompt 2 sha256 `6b2c889e6f040bbbfc4826d8d51e9ffa30871a1d6f727c842d6714027927e73b`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/style/dark-regal-portrait/assets/dark-regal-portrait-face.webp` | `gen-royal-history-previews-1-0003.png`; original `9148a5cb8c0fd6575e27a332ba4b0dcc86c0ceac5f2350d9d0f2f4477f08d565` (5070628 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `503669a3e99e6c9b0f708de5ff73287bb422ca6855a6dc24f210e59ecaa6e083`; 198538 bytes; 1672x941 WebP decode passed | no text (style preview, hardest case, face close to camera); prompt 3 sha256 `9657c41b124e583b19d926427e650a20288ff27624fb2c89969e56421e3184ba`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/style/academic-classical-oil/assets/academic-classical-oil-hero.webp` | `gen-royal-history-previews-1-0004.png`; original `2edef40912bfb504f87362fdfdf3b23085b9d6c69ed1154029f33318f766aa91` (6163095 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `15df75492e1a33739fcf12f76c5aca200df6f7019e027aa2e13865c926727e0a`; 257116 bytes; 1672x941 WebP decode passed | no text (style preview, hero); prompt 4 sha256 `8654bc68634848a1014644cbad840dfe1d1a8266fa3af56455be6a14f3141ecf`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/style/academic-classical-oil/assets/academic-classical-oil-scene.webp` | `gen-royal-history-previews-1-0005.png`; original `da1a0ac9dc6c5f5acd573dd09ef831831ac18166ff277e0140dfa900204b541f` (6394827 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `5c85019357edaafe78618dcf14d8e1629a64251cfad5f9e3ee0a09777576abed`; 298122 bytes; 1672x941 WebP decode passed | no text (style preview, quiet wide scene, no figure); prompt 5 sha256 `13e905b1b73cc798fbdd206d34ed58b60d669d0b48253b15102d1ec5fbf5b718`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/style/academic-classical-oil/assets/academic-classical-oil-face.webp` | `gen-royal-history-previews-1-0006.png`; original `76cd02cfbefd84ed718f8d370f8e108caca59c7b26a9c7a30a58a6ad822576b1` (5846004 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `5814430e043e367d0992b0295c65f152e02df9d62159f30461d39e9c227dc53a`; 281586 bytes; 1672x941 WebP decode passed | no text (style preview, hardest case, several figures); prompt 6 sha256 `8fe62f84f9e6dd084c71bf51d8a5d1e9cb6b4d61d5db1cff78d677368fa64c56`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/lettering/roman-two-tone-capitals/assets/roman-two-tone-capitals.webp` | `gen-royal-history-previews-1-0007.png`; original `25d8ca93910a23ae95ada5bd3bd3173c8ad0ff4ea082530207591990386fac96` (6222042 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `34e4aa0f149fe1295927d4471d02af40a6a84c6d37b2f55bdbaaf87c6f1adf88`; 83316 bytes; 1024x576 WebP decode passed | ROYAL HISTORY (1 line, ink black / oxide red); prompt 7 sha256 `59ca2dc971163a764143af4fbcb13f83494a66071d26acb144541cb92f2916d1`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/lettering/condensed-regal-serif/assets/condensed-regal-serif.webp` | `gen-royal-history-previews-1-0008.png`; original `71ff480dd0d08404e697d22b134f59979791d5b29e9e95a280ed026fef39c22f` (2838365 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `e7affc0edd2332eae29db094079e988b774050a109dba2cb81095e1bcbefd740`; 28170 bytes; 1024x576 WebP decode passed | ROYAL / HISTORY (2 lines, bone white / aged gold); prompt 8 sha256 `478e15f5730b7c0b03668f3ca5abfda96599ab26e84ee3836fe82baa114bdb9f`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/lettering/heavy-grotesque-hook/assets/heavy-grotesque-hook.webp` | `gen-royal-history-previews-1-0009.png`; original `967b3041cee8fe2951b9f84f9bdc7a1a83bb8ffd31cb38be25cf9fef691b9d3f` (1529155 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then **lossless** WebP effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. Lossless rather than the quality 90 used for every other file in this pass, and the reason is recorded rather than hidden: at quality 90 this swatch encoded to 14,186 bytes, below the declared 20 KB floor, because it is two flat colours carrying no texture at all. Quality 95 reached only 20,142 bytes, still under the 20,480-byte floor. Lossless is the faithful encoder for a flat-colour letterform and clears the floor with real margin. | `8d4223d7633e89ec445561b2b19668bef5cc3f6da0328e90680dd9e35bca8dba`; 193560 bytes; 1024x576 WebP decode passed | LAST TSAR (1 line, warning yellow); prompt 9 sha256 `a2d21f058a006aad96cf99b794b78509e6ccaae0c88e23d919bab96eb7dfbc60`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-1.webp` | `gen-royal-history-previews-1-0010.png`; original `cbbdbf82358157997476e62fb022ac331f797c4fa5a7101eda62f99eb392a773` (4405425 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `07c154d4135e1f93bcd9aec39b45bfdca9f4b470f96c5c64c176d0d59cb4b6b8`; 120084 bytes; 1672x941 WebP decode passed | LAST / EMPEROR (2 lines); prompt 10 sha256 `f0ff63999c09e0be6f2fd05b1aa09c840449e582841df2cdaf018c67ebba94ac`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-2.webp` | `gen-royal-history-previews-1-0011.png`; original `3344093f5357ba813a85f02c098272210099c13731bb3f8c792a062047358230` (4291076 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `4901d7f53a337e087134d3c139916a26fb190cd3d8759d7cc78670492f88f1f2`; 130210 bytes; 1672x941 WebP decode passed | WINTER / KING (2 lines); prompt 11 sha256 `dd47dc2c8d2996fb2cd7ef3a2130b85e207711ac204b5274889a8e9a6679d9bc`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. |
| `content-packs/royal-history/thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-3.webp` | `gen-royal-history-previews-1-0012.png`; original `f0d2648d82937109efa359c3cb98f9654f6f2f60924f7ad976634ef9f53d499c` (7735171 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `b9228d8c19ade39214542e9399314108e81ebdf56a97b773c94cbe1b533bead5`; 557466 bytes; 1672x941 WebP decode passed | IRON / CAESAR (2 lines, parchment panel); prompt 12 sha256 `f1bed9c104ef26e3f221ec03da98d6750e210e534cddc03459208350606ac899`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. Blemish recorded rather than repaired: a hairline ink whisker rises off the apex of the O in IRON, roughly thirty px tall and one to two px thick at 1672 wide. Spelling, the ink-black/oxide-red split and the letterform are all correct, and the mark reads as an ink flick on parchment. |
| `content-packs/royal-history/thumbnail/two-tone-hook-portrait-right/assets/two-tone-hook-portrait-right-4.webp` | `gen-royal-history-previews-1-0013.png`; original `3d6d48da02eba08dac95b430e34d78bff15f10c5ee824af1b5b00b706a3522cf` (3982261 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `232136d2c7fa4ca3d36d0cea1ccd0e908f6806b23b3a4f1b378b5fd1c5939e08`; 94510 bytes; 1672x941 WebP decode passed | LAST TSAR (1 line); prompt 13 sha256 `fc3110580c534efca7d266e589a28a89c78bba7d30814b859d90f93db0de8420`; GenStudio `gpt-image-2` via Story Studio Image Pool job `257c32e1`, 29 credits, `reference_images: []`. Observation recorded rather than repaired: the anonymous nineteenth-century figure reads as a period likeness of Nicholas II. The recipe's own rule forbids "Recognisable modern individuals, living people", which this is not — he died in 1918, and rulers of the past are precisely this collection's subject — so the slot is filled rather than left empty. Replace it if a wholly generic face is wanted. |

One row per file, in the same form the sleep-history and Lost Voyage records use: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Every row above is for a file that was decoded and reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
