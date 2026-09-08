# Lost Voyage preview provenance

Thirteen previews are declared by six of this collection's eight standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

The two packs that declare no raster assets — `com.storystudio.topic.lost-voyages` and `com.storystudio.metadata-formula.history-for-sleep-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other six are **blocked on previews only**; their documents already validate against the signed Content Pack schema.

## Why nothing was rendered in the 2026-09-06 authoring pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only, spending 160 credits. No such authorisation existed when this collection was authored, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly. The authorisation arrived on 2026-09-08; what happened then is the next section.

## The 2026-09-08 attempt: authorised, submitted, waiting on a paused queue, nothing charged

The owner authorised this render in chat on 2026-09-08 ("approved.") — about 112 renders across the
whole content-pack programme, of which this collection is thirteen — and ruled that images are made
with `gpt-image-2` and no other product. The job for all thirteen is **submitted and queued**; it has
not started, so **no credits have been charged and no image exists yet**. Two things happened, in
order, and both are recorded because the second is still true.

### First: the GenStudio catalogue could not be verified for about an hour, so nothing was submitted

`GET /api/app-settings/genstudio/image-models` returned, repeatedly, that the image catalogue could
not be refreshed and the cached copy was beyond the thirty-minute staleness limit. Story Studio
therefore refused to submit, which is the app working correctly: it will not spend against a product
it cannot currently verify. The cause was upstream saturation rather than a crash — the API answered
`/` and `/docs` in milliseconds but took **60 seconds to return an unauthenticated 401** on
`/v1/image/models`, because PostgreSQL was holding 40–56 simultaneously active connections (of a 100
limit) on two `jobs` queries, individual queries over ten minutes old and waiting on `BufferIO` and
`DataFileRead`. Contributing conditions on the machine: `/System/Volumes/Data` **99% full, 21 GiB free
of 1.8 TiB**, `shared_buffers` 128 MB against a 688 MB `jobs` table of 154,385 rows, and four Story
Studio `ffmpeg` renders each taking 50–60% CPU on the same disk. No workaround was attempted, no
substitute product was used, and the API was deliberately **not** restarted: `make safe-restart`
documents an incident on 2026-08-12 caused by restarting during in-flight fleet work, `FORCE=1` exists
to bypass the guard against exactly that, and the `jobs` table could not be read to learn what was in
flight for any account. The storm drained on its own once the renders eased, and the catalogue
returned at 11:21 local.

### The product, confirmed live before spending

| Field | Value |
| --- | --- |
| Product id / handle | `gpt-image-2` ("GPT Image 2", OpenAI, GenStudio cloud) |
| Availability | `available: true`, `chargeable: true`, `locked: false`, no admission permit required |
| Operations | `text-to-image`, `image-to-image` — this pass uses **text-to-image only** |
| Chosen output row | **2K · 16:9 · 2560×1440**, `price_version` `price_img_0251_d908a58de1e58151dbccb23e` |
| Price | **29 credits per image**; 13 images = **377 credits**, inside the ~600 ceiling for this job |
| Default row not used | 1K · 16:9 · 1280×720 at 20 credits (260 total) |

The 2K row was chosen over the cheaper default deliberately. Both fit the ceiling, and 2560×1440
**downscales** to the 1672×941 and 1024×576 contracts, where 1280×720 would have to be **upscaled**
1.31× as the 2026-09-06 sleep-history pass had to record. Every acceptance test here turns on hairline
didone serifs and correctly spelled title text staying legible at card size; upscaling softens exactly
that. Nine credits an image is the cheapest possible insurance against re-rendering the set.

### Second, and still open: the Story Studio job queue is paused, so the job cannot start

The submission succeeded — job **`9e202470`**, `image_pool_generate`, project `pack-previews`, pool
`pack-previews`, run id `lost-voyage-previews-1`, 13 prompts × 1 variant, aspect `16:9`, resolution
`2K`, `reference_images: []`. It sits at `queued` with `started_at: null`, which is why nothing has
been charged.

It cannot start because `GET /api/system/queue/status` reports `{"paused": true}`. That is a
person-operated control — `/system/queue/pause` and `/system/queue/resume` are reachable only from the
Jobs page buttons, nothing lifts the pause automatically, and the two `continuity_render` jobs parked
beside this one carry `pause_origin: "queue"`, meaning they were **running** when the pause was pressed
earlier today. GenStudio itself is healthy and willing: admission reports a 50-job paid concurrency
limit with 1 active and a credit balance of 10,667,227.

The pause was **not** lifted by this pass, and the reason is worth stating plainly rather than filing
as caution. Resume is global — there is no per-job or per-project override, `resumePausedJobs` only
moves paused records back to `queued` and its `pump` still returns early while the queue is paused — so
clearing it to run thirteen preview images would simultaneously release two mid-flight two-hour
`continuity_render` jobs and two recovery renders onto a boot volume with 21 GiB free. Filling that
volume is not a reversible mistake, and the authorisation covering this pass covers rendering these
previews, not changing a global generation control a person deliberately set for reasons this pass
cannot see.

### What one click finishes

Resume the queue on the Jobs page. Job `9e202470` then runs unchanged, spends 377 credits, and drops
`gen-lost-voyage-previews-1-0001.png` … `-0013.png` into the Pack Previews image pool, in the prompt
order below. Converting, reviewing and recording them is the remaining step, exactly as the
"Retained bytes" table and the sleep-history record describe.

## The exact command a keyed operator must run

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in the disposable `pack-previews` project so no real channel project is touched. This is the exact body submitted on 2026-09-08 as job `9e202470`; it is reproduced rather than paraphrased so a rerun is a resubmission, not a re-derivation. Thirteen prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering and title text is drawn by the image model, as the lettering and recipe contracts require).

```
POST /api/projects/pack-previews/image-pool/generate
Content-Type: application/json

{
  "pool_id": "pack-previews",
  "model": "gpt-image-2",
  "aspect_ratio": "16:9",
  "resolution": "2K",
  "variants": 1,
  "run_id": "lost-voyage-previews-1",
  "prompts": [ ...the thirteen prompts below, in order... ]
}
```

The returned files are named `gen-lost-voyage-previews-1-0001.png` through `-0013.png`, one per prompt in the order below. Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.maritime-oil-painting` | `assets/maritime-oil-painting.webp` (hero) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.maritime-oil-painting` | `assets/maritime-oil-painting-2.webp` (quiet wide, no figure) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.maritime-oil-painting` | `assets/maritime-oil-painting-3.webp` (hardest case, faces) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.foggy-harbour-realism` | `assets/foggy-harbour-realism.webp` (hero) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.foggy-harbour-realism` | `assets/foggy-harbour-realism-2.webp` (quiet wide, no figure) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.foggy-harbour-realism` | `assets/foggy-harbour-realism-3.webp` (hardest case, distant figure) | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.victorian-engraved-small-caps` | `assets/victorian-engraved-small-caps.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.antique-wood-type-poster-serif` | `assets/antique-wood-type-poster-serif.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.weathered-brush-stamp` | `assets/weathered-brush-stamp.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-1.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-2.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-3.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.maritime-title-left-subject-right` | `assets/maritime-title-left-subject-right-4.webp` | 1672x941 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Three previews per visual style (rule added 2026-09-08)

Each visual style now ships **three** previews rather than one, so a buyer judging the style sees
its range and not only its best angle: a **hero** (the signature shot), a **quiet wide scene with no
figure** (what the style looks like carrying a frame on atmosphere alone), and the **hardest case**
the style admits (where it is most likely to fail). Hero is listed first in `preview_assets`.

One deliberate deviation, recorded rather than hidden. The general form of the hardest case is a face
or a crowd. `com.storystudio.style.foggy-harbour-realism` forbids both in its own contract — its
style bible states that no faces appear in close-up and no crowds appear, and its negative prompt
lists `close-up faces, portraits, crowds`. Rendering one would have produced a preview that
contradicts the pack it advertises. Its hardest case is therefore the hardest thing that style
actually permits: a lone figure held at distance in fog, present and readable as a person while the
mist takes the face and the low-stimulation contract survives. `maritime-oil-painting` has no such
restriction, so its hardest case is a face and a small group, as the general rule intends.

`preview_assets` in both style documents moves from one entry to three **when the bytes land**, not
before: a document that declares an asset the pack cannot ship would fail validation, which is the
failure this file exists to prevent.

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

## Prompt 10 — `maritime-oil-painting-2.webp` (style preview, quiet wide scene, no figure, no text)

> Nineteenth-century marine oil painting on primed canvas, composed as a wide, quiet, almost empty seascape carrying the frame on weather alone. An open stretch of moderate sea under a broken overcast, with a single wooden hull becalmed far off on the right, small and low and reduced almost to a silhouette by distance and haze, her sails slack; a spar and a drifting length of rope in the near water on the left as the only close incident; the horizon slightly broken and never ruler-straight. Nobody is aboard her and nobody is anywhere in the frame. Loose visible brushwork, thin scumbled glazes carrying the whole upper half of the sky, impasto reserved for a few lit crests and one torn cloud edge, canvas tooth showing through the thin passages, fine craquelure and a warm varnish bloom. Warm ivory, parchment and aged gold in a pale open sky held across the upper two fifths as deliberate negative space, moving down through raw and burnt sienna in the weather into deep navy and slate green water; no bright accent anywhere, the palette deliberately quieter than the hero. Soft diffused daylight from a low overcast sun, entering from the left and passing through cloud, no rim light, no artificial glow, no drama. Waterline below centre, atmosphere rather than detail carrying the distance. No figure, no face, no crowd, no bird, no text, no lettering, no watermark, no signature, no border, no modern vessel of any kind.

## Prompt 11 — `maritime-oil-painting-3.webp` (style preview, hardest case: faces and a small group, no text)

> Nineteenth-century marine oil painting on primed canvas. A small group of five or six anonymous period-dressed figures in seafaring coats and oilskins hauling an open boat up a shingle beach in wind, three of them turned enough toward the viewer that their faces are visible at middle distance, the others seen from behind and in profile as they lean into the gunwale; weather in every coat and every head of hair, hands on wood and rope, a spar and a coil of line on the shingle in the near foreground. Faces are softly modelled and painterly, held together by tone rather than outline, quietly generic and never a recognisable individual, never a portrait likeness and never a caricature. Loose visible brushwork, directional oil strokes that stay readable as paint, impasto only on the lit edges of coats, spray and the crest of the surf behind, dry-brush drag on rope and spar, fine craquelure and a warm varnish bloom. Sepia, ochre, raw and burnt sienna and aged gold through the sky and the wet shingle, deep navy and slate green in the broken water behind, one small muted oxblood accent on a single garment and nowhere else. Soft diffused daylight from a low overcast sun entering from one side, faces lit softly and from above, no hard modern key light, no rim light, no artificial glow. Pale open sky held across the upper third as deliberate negative space, the group placed low and to the left on a clear diagonal, waterline below centre. No text, no lettering, no watermark, no signature, no border, no modern clothing, no life jackets, no modern vessel of any kind.

## Prompt 12 — `foggy-harbour-realism-2.webp` (style preview, quiet wide scene, no figure, no text)

> A near-photoreal painted still of an almost empty harbour mouth in heavy sea mist, handled so tightly it nearly reads as a photograph, deliberately emptier and wider than the hero: no close still-life anchor in the foreground at all, only flat still water running unbroken to the bottom edge. A wet stone slipway enters the water from the left and is lost within a few feet; one mooring post stands in the shallows a little further out, its reflection soft and broken; beyond it fog dissolves everything, leaving a single pale suggestion of a breakwater and nothing else. Smooth blended passages, no exposed canvas tooth, no impasto except two or three small highlights where wet stone and still water catch the light, an even matte finish. Grey-teal, slate, wet stone, pewter and cold off-white throughout, desaturated and held inside a very narrow band of value, with exactly one warm source — a low sun barely showing through cloud on the far right — glowing amber into a small part of the sky and nowhere else. Flat, diffuse, sourceless light; no hard shadows, no strong highlights, no rim light, contrast deliberately low. Eye level, horizon low, at least half the frame given to empty air and empty water. Nothing is in motion and nothing is happening. No people, no figure, no face, no crowd, no boat, no bird, no text, no lettering, no signage, no watermark, no border.

## Prompt 13 — `foggy-harbour-realism-3.webp` (style preview, hardest case: a lone figure at distance, no text)

> A near-photoreal painted still of a wet stone quay in heavy sea mist, handled so tightly it almost reads as a photograph, with a single distant human figure as the hardest thing this style admits. One lone person in a long dark coat stands still on the quay in the middle distance, small in the frame, turned three-quarters away and seen at full length, already softening at the edges — the mist takes the face entirely, so no features, no expression and no likeness are readable, and the figure registers as a quiet silhouette with weight rather than as a portrait. A coil of rope and an iron bollard sit crisply detailed in the near foreground; beyond the figure, fog dissolves everything but the faint silhouette of a moored hull. Smooth blended passages, no exposed canvas tooth, no impasto except small highlights on wet stone and iron, an even matte finish, soft edges everywhere and softer with distance. Grey-teal, slate, wet stone, pewter and cold off-white, desaturated and low contrast, with exactly one warm source — a lamp on the quay wall — glowing amber into a small part of the frame and nowhere else. Flat, diffuse, sourceless daylight through fog; no hard shadows, no strong highlights, no rim light. Still water holding a soft broken reflection. Eye level, horizon low, generous empty air and water, the figure placed off centre and small. Nothing in motion, no incident. No close-up face, no portrait, no second person, no crowd, no text, no lettering, no signage, no watermark, no border.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
