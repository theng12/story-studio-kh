# Royal History preview provenance

Thirteen previews are declared by six of this collection's eight standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

The two packs that declare no raster assets — `com.storystudio.topic.rulers-and-dynasties` and `com.storystudio.metadata-formula.documentary-for-sleep-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other six are **blocked on previews only**; their documents already validate against the signed Content Pack schema.

## Three previews per visual style

The owner's rule for this collection, new on 2026-09-08 and applied here first: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty room or an empty landscape.
- **face** — the hardest case the style can be asked for: a face close to camera, or a group of figures, whichever is the thing most likely to fail.

Lettering packs keep the shipped house standard of one to four swatches; this collection declares one swatch each, at the 1024x576 figure the paid lettering packs already use. The Thumbnail Recipe declares four, exactly as the Lost Voyage recipe did, so that both title variants are shown twice.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

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
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
