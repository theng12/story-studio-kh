# Lost Voyage preview provenance

Nine previews are declared by six of this collection's eight standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

The two packs that declare no raster assets — `com.storystudio.topic.lost-voyages` and `com.storystudio.metadata-formula.history-for-sleep-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other six are **blocked on previews only**; their documents already validate against the signed Content Pack schema.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only, spending 160 credits. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is a GenStudio text-to-image lane. Nine prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering and title text is drawn by the image model, as the lettering and recipe contracts require).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio text-to-image product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "lost-voyage-previews-1",
  "prompts": [ ...the nine prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.maritime-oil-painting` | `assets/maritime-oil-painting.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.foggy-harbour-realism` | `assets/foggy-harbour-realism.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.victorian-engraved-small-caps` | `assets/victorian-engraved-small-caps.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.antique-wood-type-poster-serif` | `assets/antique-wood-type-poster-serif.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.weathered-brush-stamp` | `assets/weathered-brush-stamp.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-1.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-2.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-3.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-4.webp` | 1672x941 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Prompt 1 — `maritime-oil-painting.webp` (style preview, no text)

> Nineteenth-century marine oil painting on primed canvas. A tall wooden sailing ship under wind-filled sail on a moderate sea, heeling slightly, seen from a little off her bow, placed low and to the right of frame on a clear diagonal, with a smaller boat pulling in the middle distance and a period harbour town of stone moles and low warehouses barely visible on the far left horizon. Loose visible brushwork, thin scumbled glazes through the sky and thick impasto only on spray and the lit crests of water, canvas tooth showing in thin passages, fine craquelure and a warm varnish bloom. Warm ivory and parchment sky kept pale, open and almost empty across the upper third as deliberate negative space; sepia, ochre, raw and burnt sienna and aged gold in the weather; deep navy, slate green and cold grey in the water; a single small oxblood accent on a pennant. Soft diffused daylight from a low overcast sun, light passing through cloud rather than striking hard, no rim light and no artificial glow. Waterline below centre, atmosphere rather than detail carrying the distance. No text, no lettering, no watermark, no signature, no border, no modern vessel of any kind.

## Prompt 2 — `foggy-harbour-realism.webp` (style preview, no text)

> A near-photoreal painted still of a wet stone quay in heavy sea mist, handled so tightly it almost reads as a photograph, with brushwork visible only where wet stone and iron catch the light. In the near foreground, a coil of rope, two barrels and an iron bollard with a chain, all crisply detailed and damp; in the middle ground, a small moored boat sitting quiet at her lines, her edges already softening; beyond, fog dissolving everything but the silhouette of a distant steamer showing one vertical smoke plume, and a single gull settled on a post. Grey-teal, slate, wet stone, pewter and cold off-white throughout, desaturated and low contrast, with exactly one warm source — a lamp on the quay wall — glowing amber into a small part of the frame and nowhere else. Flat, diffuse, sourceless daylight through fog; no hard shadows, no strong highlights, no rim light. Still water holding a soft broken reflection. Eye level, horizon low, generous empty air and water, subject off centre and small in the frame. Nothing in motion, no people, no faces, no crowd, no incident. No text, no lettering, no signage, no watermark, no border.

## Prompt 3 — `victorian-engraved-small-caps.webp` (lettering swatch, axis `font`)

> A lettering specimen of the two words LOST VOYAGE set as engraved nineteenth-century didone small capitals, centred on a plain aged parchment ground. Extreme hairline serifs and very high thick-to-thin stroke contrast, wide even letter tracking, a slight inner bevel on each letter as if cut into a printing plate, and one thin ornamental rule with a small central flourish ruled beneath the line. Dark oxblood ink on warm ivory paper, flat and matte with no glow, no outline and no drop shadow. The letters fill the middle of the frame and are perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no second line of text.

## Prompt 4 — `antique-wood-type-poster-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen of the two words LOST VOYAGE stacked on two lines and set as heavy condensed nineteenth-century wood-type poster capitals, centred on a plain aged newsprint ground. Thick slab-ish bracketed serifs, tall narrow proportions, very tight stacking with the two lines almost touching, slightly worn and broken print edges with uneven ink coverage as if pulled on a hand press. Dense navy-black ink on warm off-white paper, flat and matte, no glow, no outline, no drop shadow. The letters fill the middle of the frame and are perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no third line of text.

## Prompt 5 — `weathered-brush-stamp.webp` (lettering swatch, axis `text`)

> A lettering specimen of the two words LOST VOYAGE hand-brushed in thick paint and stamped onto a rough dark timber surface, centred in frame. Distressed broken edges, dry-brush gaps and skipped strokes through the letterforms, uneven pressure so some strokes are heavy and others barely register, a single flat colour of bone white, completely matte with no glow, no outline and no drop shadow. The letters fill the middle of the frame and are perfectly spelled and unclipped despite the distressing. Nothing else in the image: no illustration, no border, no watermark, no second line of text.

## Prompt 6 — `maritime-title-left-subject-right-1.webp` (recipe, variant A, portrait)

> A nineteenth-century marine oil painting used as a wide cover image. The left third of the frame is a title column: render the words THE LOST FLEET directly in the image on two lines, THE LOST above FLEET, in engraved didone small capitals with hairline serifs and wide tracking, flat navy fill, no glow and no outline, bottom-weighted in that column, with a thin ornamental rule beneath the last line and a much smaller sub-line under the rule reading SEVENTY-ONE SHIPS. The sky above and behind the title column is pale warm ivory, open and completely empty — no cloud detail, no spar, no rope, no rigging in the letter area. The right two thirds carry a single anonymous period-dressed figure in a seafaring coat, cut at the waist, turned toward the camera with weather in the coat and hair, overlapping the lower right corner, with a low horizon and open water behind. Loose visible brushwork, impasto only on the brightest highlights, sepia, ochre and aged gold with navy water, soft diffused overcast daylight. The figure never crosses into the title column. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second title, no recognisable individual.

## Prompt 7 — `maritime-title-left-subject-right-2.webp` (recipe, variant B, vessel)

> A nineteenth-century marine oil painting used as a wide cover image. The left third of the frame is a title column: render the words STORM PASSAGE directly in the image on two lines, STORM above PASSAGE, in engraved didone small capitals with hairline serifs and wide tracking, flat oxblood fill, no glow and no outline, bottom-weighted in that column, with a thin ornamental rule beneath the last line and a smaller sub-line under the rule reading SIXTY DAYS. The sky above and behind the title column is pale parchment, open and completely empty. The right two thirds carry a wooden ship's hull under sail, anchored to the bottom-right corner and cropped by the frame edge, bow angled toward the title column, her sail mass rising into the right half and never crossing into the title column, spray at the bow and a broken sea beneath. Loose visible brushwork, thick impasto on spray and lit crests, sepia and ochre weather over deep navy water, soft diffused daylight through cloud. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second title, no modern vessel.

## Prompt 8 — `maritime-title-left-subject-right-3.webp` (recipe, variant A, portrait)

> A nineteenth-century marine oil painting used as a wide cover image. The left third of the frame is a title column: render the words THE LAMP KEEPER directly in the image on three lines, THE / LAMP / KEEPER, in engraved didone small capitals with hairline serifs and wide tracking, flat navy fill, no glow and no outline, bottom-weighted in that column, with a thin ornamental rule beneath the last line and no sub-line. The sky above and behind the title column is pale warm ivory, open and completely empty. The right two thirds carry a single anonymous period-dressed figure in oilskins, cut at the waist, turned toward the camera, overlapping the lower right corner, with a low horizon of grey water and a suggestion of a stone tower far behind on the right edge. Loose visible brushwork, restrained impasto, ochre and sepia over slate water, soft diffused overcast light, no hard modern lighting. The figure never crosses into the title column. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second title, no recognisable individual.

## Prompt 9 — `maritime-title-left-subject-right-4.webp` (recipe, variant B, vessel)

> A nineteenth-century marine oil painting used as a wide cover image. The left third of the frame is a title column: render the word ADRIFT directly in the image on one line in engraved didone small capitals with hairline serifs and wide tracking, flat oxblood fill, no glow and no outline, bottom-weighted in that column, with a thin ornamental rule beneath it and a smaller sub-line under the rule reading NINE WEEKS AT SEA. The sky above and behind the title column is pale parchment, open and completely empty. The right two thirds carry a wooden hull under reduced sail, anchored to the bottom-right corner and cropped by the frame edge, bow toward the title column, heeling on a long swell with a torn cloud behind her. Loose visible brushwork, impasto on the lit crests, warm ivory sky falling into sepia and navy, soft diffused daylight. Text is perfectly spelled and unclipped. No wordmark, no logo, no badge, no border, no watermark, no second title, no modern vessel.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
