# Lost Voyage preview provenance

Thirteen previews are declared by six of this collection's eight standalone Content Packs. **All thirteen now exist, and all thirteen passed review.** Job `9e202470` ran to completion on 2026-09-08 and every returned original was accepted; the accepted bytes, their digests and the conversion applied to each are in "Retained bytes" at the end of this file. All eight packs build, sign and pass `validateContentPack` under an ephemeral authoring key.

The sections below are kept as written rather than rewritten in hindsight, because they record why the render was blocked twice and what finally released it. What changed is stated in place: see "Third: the queue was resumed and the job ran".

The two packs that declare no raster assets — `com.storystudio.topic.lost-voyages` and `com.storystudio.metadata-formula.history-for-sleep-titles` — were already complete before this pass. The other six were **blocked on previews only**, and are no longer blocked: their thirteen declared assets are present, decodable and at contract size, so all eight now build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key.

## Why nothing was rendered in the 2026-09-06 authoring pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only, spending 160 credits. No such authorisation existed when this collection was authored, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly. The authorisation arrived on 2026-09-08; what happened then is the next section.

## The 2026-09-08 attempt: authorised, submitted, waiting on a paused queue, nothing charged

The owner authorised this render in chat on 2026-09-08 ("approved.") — about 112 renders across the
whole content-pack programme, of which this collection is thirteen — and ruled that images are made
with `gpt-image-2` and no other product. Three things happened, in order; the first two are recorded
as they were written at the time, when the job was submitted, queued and unstarted, and the third
records the run that followed. Nothing in the first two sections was true any longer once the queue
was resumed.

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

### Second, since resolved: the Story Studio job queue was paused, so the job could not start

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

### Third: the queue was resumed and the job ran, exactly as submitted

A person resumed the queue on 2026-09-08. Job `9e202470` started at `07:05:56Z`, ran for nine
minutes fifty-eight seconds, and finished at `07:15:54Z` with `Done — 13/13 image(s) verified; pool
indexed (+13 new).` Nothing about the submission changed between queueing and running: the thirteen
prompts recorded below are **byte-identical** to `params.prompts` on the executed job, in the same
order, which is what makes the file-to-prompt mapping in "Retained bytes" a fact rather than an
inference. `gen-lost-voyage-previews-1-0001.png` is prompt 1, and so on to `-0013.png`.

Thirteen GenStudio jobs settled at 29 credits each — **377 credits**, no retries, no refunds
(`returned_credits` and `released_credits` are zero on all thirteen), balance `10,667,227` →
`10,666,850`. Every original returned at the requested 2560×1440, so every accepted file is a
**downscale**, never the 1.31× upscale the sleep-history pass had to record.

Independent visual review of all thirteen originals (this pass, at full resolution and again at card
size, for exact spelling, legibility, absence of logos, watermarks and UI, absence of stray text
where the contract forbids it, and absence of any copied composition): **PASS for all thirteen.** No
file was culled, no slot was left unfilled, and nothing was re-rendered. The three lettering swatches
spell `LOST VOYAGE` correctly and unclipped; the four recipe previews spell `THE LOST FLEET` /
`SEVENTY-ONE SHIPS`, `STORM PASSAGE` / `SIXTY DAYS`, `THE LAMP KEEPER`, and `ADRIFT` / `NINE WEEKS AT
SEA` correctly and unclipped, with the subject clear of the title column in all four; the six style
previews carry no text at all. Two deliberate observations rather than defects: in prompt 6 the title
block sits nearer the vertical middle of its column than the "bottom-weighted" the prompt asked for,
which affects nothing the contract tests; and in prompt 13 the moored hull beyond the figure reads a
little more solidly than "faint silhouette", while the figure itself is correctly faceless in the
mist, which is the condition that mattered.

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

The returned files are named `gen-lost-voyage-previews-1-0001.png` through `-0013.png`, one per prompt in the order below. Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize to the dimensions in the table — no overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

**The encoder setting differs from the sleep-history pass, deliberately, and the reason is recorded
rather than left to be rediscovered.** Sleep-history used lossless WebP because its originals were
1280×720 and had to be *upscaled* 1.31× to reach 1672×941; throwing away nothing was the right call
on already-soft pixels. This pass renders at 2560×1440 and *downscales*, and lossless on a
downscaled painterly image is expensive for no visible gain: the thirteen files come to about 20 MB
lossless against 2.9 MB at quality 90, and at card size the two are indistinguishable — the hairline
didone serifs and the title spelling, the only things these previews are judged on, survive
identically. Quality 90 at effort 6 is what was used, and paired encodes are byte-identical, so the
determinism proof is unchanged. Fit is `cover` rather than `fill`: 2560×1440 is 1.77778 and 1672×941
is 1.77683, so cover trims **under one pixel** of width and keeps the pixels square, where `fill`
would stretch the frame by 0.05%. Neither is a crop in any meaningful sense; cover is the honest one.

## Acceptance contract per file

Every row below is now satisfied by committed bytes; the accepted digests and byte counts are in
"Retained bytes".

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

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. Each `assets/` directory was created when its bytes landed; all six now exist and hold exactly the files this table declares.

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

`preview_assets` in both style documents lists three entries, hero first. Both packs validate with
those three files present, which is the check this rule turns on: a document that declares an asset
the pack cannot ship fails validation, and that is the failure this file exists to prevent.

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
| `content-packs/lost-voyage/style/maritime-oil-painting/assets/maritime-oil-painting.webp` | `gen-lost-voyage-previews-1-0001.png`; original `e0a5a0132bc9a6ca2d83217cf36b746f410f1d85aa2dd1052dae8e980c9a93ac` (6670238 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `8d091e01913cd8a4daec10ab54d8a1a0baabac24e26721b09984c64ed8975a03`; 309102 bytes; 1672x941 WebP decode passed | no text (style preview, hero); prompt 1 sha256 `26c1a6137b78c118599e6dfa0463b40efc9c6299233d85d50371d451c25e8c75`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/style/foggy-harbour-realism/assets/foggy-harbour-realism.webp` | `gen-lost-voyage-previews-1-0002.png`; original `4024109a3d9bb95de833988ab80369f27cb056ea2da9c351dd7f548897acf4b0` (4297613 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `93d81c2eb9a8502463d20d1eb263a5f9f9f2909bcf902c8937938702fb31135e`; 108100 bytes; 1672x941 WebP decode passed | no text (style preview, hero); prompt 2 sha256 `00441617da2ba65623cbaa8f27d0f7bddf556194da999fa5c8610d9aa07e8f73`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/lettering/victorian-engraved-small-caps/assets/victorian-engraved-small-caps.webp` | `gen-lost-voyage-previews-1-0003.png`; original `c3e5766e8f69ae7d0651c13e261c66dc12b1fd5a89c2faf0161e03957862833c` (5869496 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `5d2548de47e8402db213ec30fb64fb9e86f4d7d83a695aa7f0fdea75410e68fc`; 71342 bytes; 1024x576 WebP decode passed | LOST VOYAGE (1 line); prompt 3 sha256 `de3a76f3da7e45895f9ef755060e5533d106b8cd5cba807aa864c06248740b5d`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/lettering/antique-wood-type-poster-serif/assets/antique-wood-type-poster-serif.webp` | `gen-lost-voyage-previews-1-0004.png`; original `317b8d2b0fe2001995462d2a48a12329bac638a5402425a7d33a0ae9f6c314b5` (5740781 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `a5ff665854d6c71a5d3e23d4e4bebb128ea68fc18d89f0850121dffa8ebc0fdb`; 102012 bytes; 1024x576 WebP decode passed | LOST VOYAGE (2 lines); prompt 4 sha256 `7c1233c4ba9afb220ce5c9e3d9af5f828e5a7455753629e921de8b6cd467195f`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/lettering/weathered-brush-stamp/assets/weathered-brush-stamp.webp` | `gen-lost-voyage-previews-1-0005.png`; original `23e92ca2ff04601a05a9a8524553d1bcc4967a1b3e303fe07ab371058be82f23` (7312121 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `6d2cf6e07acef410f66e685a00c9c4aba174919f6a846e84225688739d568a73`; 201792 bytes; 1024x576 WebP decode passed | LOST VOYAGE (2 lines); prompt 5 sha256 `694149429866104954c0e9f1f9ad6ba03ff9a7498014e9adcd5b3d6a3f111745`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-1.webp` | `gen-lost-voyage-previews-1-0006.png`; original `476cc49dce25750dbfea276abbdb88b0ffac90e82dd74de257219de5fc629616` (6517634 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `8a34fff2b0696f6c3c3ea234b442c0199ed0ab836d6879a33444db2127b0c751`; 328224 bytes; 1672x941 WebP decode passed | THE LOST / FLEET, sub-line SEVENTY-ONE SHIPS; prompt 6 sha256 `89ca06ca3808a306ebe14b64739519e48a84917bd61132cadb9bfa4f2dcd8f3e`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-2.webp` | `gen-lost-voyage-previews-1-0007.png`; original `de47c6d8849eaace60e347296a8e7f3b91247339e62994380e77150df92a4cac` (6738994 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `f237685ee2ee44e78460c3c36b672800eafab28c0c958c2a30ac992a705b705b`; 408946 bytes; 1672x941 WebP decode passed | STORM PASSAGE, sub-line SIXTY DAYS; prompt 7 sha256 `bad07d290c763d335b3b78bb172e6af43b66c152fe21766ac0c0df620088835b`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-3.webp` | `gen-lost-voyage-previews-1-0008.png`; original `187ae6d753043fadea634c48ec8ea3ce3a2d3b61cf703b5ce28c9c1535ab0ff6` (5603878 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `b4448d918bfdebc8d01cefb7365322ad4a56a58aaf2acc3e3571e324eee1b48b`; 240278 bytes; 1672x941 WebP decode passed | THE / LAMP / KEEPER (no sub-line); prompt 8 sha256 `0fcc8da678105c0fdbdb5a513e1d722b1d8637686877589abe95313b7516ebb4`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/thumbnail/maritime-title-left-subject-right/assets/maritime-title-left-subject-right-4.webp` | `gen-lost-voyage-previews-1-0009.png`; original `87f6326fa39335d9135eefc2ebde69d2990035be78d7f366b4ab44432ca184e7` (5897447 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `a4c6435f3211f2645e591165ab075c71affc214da3f067df8a718cf7da8735ff`; 257002 bytes; 1672x941 WebP decode passed | ADRIFT, sub-line NINE WEEKS AT SEA; prompt 9 sha256 `46ff7be960b33b02fd58c0c1ba3f5afd4a29cf1fd5672f83620bea271e7c5918`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/style/maritime-oil-painting/assets/maritime-oil-painting-2.webp` | `gen-lost-voyage-previews-1-0010.png`; original `256e98a3c0859795353b56ea923b2ef0b421a53ded7feba35cbe7a9da56111c2` (6745777 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `830eccfcacc230006b8d12be23b18fbb815527cf106ebc401a57445cd0860ffc`; 323036 bytes; 1672x941 WebP decode passed | no text (quiet wide scene, no figure); prompt 10 sha256 `c74f0387feaa31afe17fa5b58e1422341b758d0be6bf152c92997369ee68ad1d`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/style/maritime-oil-painting/assets/maritime-oil-painting-3.webp` | `gen-lost-voyage-previews-1-0011.png`; original `1f93d59a4d5dbfe72aabe83d01e9946c9c1ecbbe742eff27e72b7484f1f4ee81` (6906073 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `8abc1855dcfa711cda676c32cce81cd4d1ac5842e7b89e880024cbbbba0961e1`; 385122 bytes; 1672x941 WebP decode passed | no text (hardest case, faces and a small group); prompt 11 sha256 `6424813002c1dd260358df68ee67db95fab948e4cad1d6d822bc1b829196114f`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/style/foggy-harbour-realism/assets/foggy-harbour-realism-2.webp` | `gen-lost-voyage-previews-1-0012.png`; original `2914558caaa4e65965434c284d04bd824b07ac96f367de6d6177b94154f7856d` (3940974 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `ffc1140c05c36fcefd75c4c1dcb663bffe52004e4f432702683ba0f9be902224`; 46238 bytes; 1672x941 WebP decode passed | no text (quiet wide scene, no figure); prompt 12 sha256 `c1849cde403310fe715418e951e9df2d4c0b6c4e4a3a24c883f41acace3ea6ea`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |
| `content-packs/lost-voyage/style/foggy-harbour-realism/assets/foggy-harbour-realism-3.webp` | `gen-lost-voyage-previews-1-0013.png`; original `30c81585807236253def5bfdbe96d9a760b4486ed40d37dbf7bdc460914ca32a` (4231453 B PNG, 2560x1440) | Whole-image resize(1672×941, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `1af676449d2a3ed9d20b969c070dfb008163e81ff992216ffdb033af496279df`; 79072 bytes; 1672x941 WebP decode passed | no text (hardest case, a lone figure at distance); prompt 13 sha256 `6cd770d0378f4067f75eade8392e215b103aadc9694dc8d813609cce924ef8c9`; GenStudio `gpt-image-2` via Story Studio Image Pool job `9e202470`, 29 credits, `reference_images: []` |

All thirteen rows are entered because all thirteen files were decoded and independently reviewed at
full resolution and again at card size, for exact spelling, legibility, absence of logos, watermarks
and UI, and absence of any copied composition. Nothing was culled, so there is no "Culled candidates"
table here as there is in the sleep-history record.

The thirteen originals are retained outside this repository, in the disposable `pack-previews` image
pool that produced them (`~/Documents/Story Studio KH/B-Roll Assets Pool/Pack Previews - Image Pool/`),
alongside the pool's own task manifest recording each file's GenStudio task id, submitted timestamp,
input hash and 2560×1440 output selector. The digests above are what binds those originals to the
committed bytes.

Rights basis is unchanged from the sleep-history record: OpenAI output terms via GenStudio's provider
agreement; the owner is responsible for use; the non-exclusive / similarity caveat applies. This is
not an exclusive-copyright claim.

All eight packs in this collection — the six preview-bearing ones and the two that declare no raster
assets — build, sign and pass `validateContentPack` under an ephemeral Ed25519 authoring key
generated for review and never committed. The ephemeral key proves archive structure, manifest,
hashes and asset decoding only; it is not a publishing key and no archive built with it is stocked.
