# Standalone Looks preview provenance

Six previews are declared by this collection's two standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

Both packs are **blocked on previews only**; their documents already validate against the signed Content Pack schema, which was checked directly by building each of them once in a throwaway directory with disposable rasters in place. Those rasters were deleted and no placeholder byte was written into this repository.

## A collection with no channel

Neither of these two Visual Styles belongs to a channel. Both declare `compatible_formula_ids: []`, exactly as the shipped Production Looks and Storytelling Looks styles do, because a look that is sold on its own must not claim a Series Formula it was not authored against. That is the whole reason this collection exists as its own directory rather than being folded into either of the two channel collections in this batch.

## Three previews per visual style

The owner's rule, set on 2026-09-08 and applied to Royal History first, carries forward here: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty room.
- **face** — the hardest case the style can be asked for, chosen inside the style's own contract rather than against it.
  - Inked Fable Cartoon carries its menace in small glowing white eyes set deep under a heavy brow, with the muzzle and the hands doing the acting rather than large cartoon eyes. Its hardest case is therefore one animal head held close, where the expression has to be built from brow, muzzle, ear and two soft-edged cel steps alone, with a single amber key and nothing to lift the shadow.
  - Scratchy Editorial Poster is built for a tightly cropped subject on stark white and works in two inks with no gradient of any kind. Its hardest case is the thing scratchy hatching fails at first: a face at close crop, where every value of the skin has to come from spacing and crossing of pen strokes over a rough brush block, with the paper left bare for every lit plane and no smooth tone anywhere on the frame.

Neither pack is a Thumbnail Recipe or a lettering style, so the four-preview recipe figure and the one-swatch lettering figure have nothing to bind here.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is the GenStudio text-to-image lane for `gpt-image-2`. Six prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "standalone-looks-previews-1",
  "prompts": [ ...the six prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

### Request size

These six prompts serialise to **11,046 bytes**, which is inside the 16 KiB body cap that blocked the thirteen-prompt Midnight Archives batch on Story Studio 1.4.128 and earlier. Send them as one job with the run id above. Do not shorten, merge or reword a prompt to save bytes — the prompt text is the contract. The credits are 6 × 29 = 174.

### Original subjects only

Every subject in these six prompts is invented for this pass: no named character, no existing illustration, no living or historical person, no real publication and no real place. The Scratchy Editorial Poster prompts additionally require that the large background capitals be **broken letter fragments that spell no word in any language**, because the style's contract treats that lettering as texture and leaves real titles to the caption system. A returned image whose background lettering resolves into a readable word, or whose subject resembles an existing character, must be rejected rather than committed.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.inked-fable-cartoon` | `assets/inked-fable-cartoon-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.inked-fable-cartoon` | `assets/inked-fable-cartoon-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.inked-fable-cartoon` | `assets/inked-fable-cartoon-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.scratchy-editorial-poster` | `assets/scratchy-editorial-poster-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.scratchy-editorial-poster` | `assets/scratchy-editorial-poster-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.scratchy-editorial-poster` | `assets/scratchy-editorial-poster-face.webp` | 1672x941 | WebP | > 20 KB |

The 1672x941 figure is the Visual Style contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Prompt 1 — `inked-fable-cartoon-hero.webp` (style preview, hero, no text)

> An inked cartoon illustration with the weight of a fable, sixteen by nine, drawn with a loaded brush over dry paper grain. A crowd of heavy anthropomorphic animals — badgers, boars, hares, foxes, all built with exaggerated shoulders, thick necks, small heads on wide bodies and coats that hang with real weight — packs the lower two thirds of the frame as a mass of almost black inked silhouettes, and the only thing catching light in that mass is their eyes: small points of glowing white set deep in the shadow under each heavy brow. Raised above them on a wooden crate at the centre-right stands one badger in a long coat, one arm out, and he is the only body the light fully reaches. The light is a single hanging lantern just inside the frame at the upper right, amber going to umber, hitting one plane of him and dying immediately; there is no fill, no rim from behind and no ambient blue anywhere. Every shape is closed by a thick black ink outline of visibly variable weight, swelling on the underside and the shadow side of a form, tapering to a dry hairline where a surface turns into the light, and breaking entirely at the brightest edge so the fill runs out into the paper. Fills are flat brush blocks that are not flat on inspection — bristle drag, uneven loading, a lighter core and a dirty edge — with soft-edged cel shading over them in exactly two steps, one shadow and one deeper occlusion. Colour is mixed and low: earth reds, ochres, bark greens and dulled blues sitting against black. The camera looks down from above the crowd with the horizon tilted, so the composition itself is uneasy. Dry paper grain across the whole frame and a slight ink bleed where a heavy line meets a wet fill. No text, no lettering, no watermark, no signature, no border, no speech balloon, no logo, no invented insignia, no human face.

## Prompt 2 — `inked-fable-cartoon-scene.webp` (style preview, quiet wide scene, no figure, no text)

> An inked cartoon illustration of an empty barn interior at dusk, wide, with no person and no animal anywhere in it and nothing happening. A single oil lantern hangs from a beam just left of centre and is the only light in the picture: it lays warm amber and umber across a workbench, a coil of rope, a stack of sacks and one plank of the floor, and dies within a few feet, so the far stalls, the ladder and the whole right side of the frame drop to a deep near-black described only by the ink line. Every shape is closed by a thick black ink outline of visibly variable weight — swelling underneath and on the shadow side, tapering to a dry hairline where a surface turns into the light, breaking entirely at the brightest edge — and filled with flat brush blocks that show bristle drag, uneven loading and dirty edges, with soft-edged cel shading over them in exactly two steps. Colour is mixed and low: bark greens, ochres, dulled earth reds and one dirty blue on a folded tarpaulin, all against black. No fill light, no rim light, no ambient blue in the shadow. The camera looks slightly down and the horizon is tilted, so the boards run as diagonals across the frame. Dry paper grain across the whole image and a slight ink bleed where a heavy line meets a wet fill. No figure, no face, no eyes, no animal, no text, no lettering, no watermark, no signature, no border, no logo.

## Prompt 3 — `inked-fable-cartoon-face.webp` (style preview, hardest case, no text)

> An inked cartoon illustration pushed to the hardest case this look can be asked for, sixteen by nine. One heavy anthropomorphic boar fills the right half of the frame, held close, cut at the shoulders, three-quarters on, and the whole of his expression has to be built without large cartoon eyes: the eyes are two small points of glowing white set deep in the shadow under a thick brow ridge, and everything the picture says about him is carried instead by the set of the muzzle, the flare of the nostril, the angle of one torn ear, the tension in the jaw and one broad hand raised to the collar of a coat that hangs with real weight. A single lantern held low and just outside the lower inner edge of the frame is the only light: sunset gold and amber, it strikes one plane of the muzzle and the ridge of the brow and dies immediately, leaving the far side of the head, the neck and the whole ground behind him in deep near-black with only the ink line to describe them. No fill, no second key, no rim from behind, no ambient blue. The ink line is thick and visibly variable at this range, swelling under the jaw and along the shadow side, tapering to a dry hairline over the lit cheek and breaking entirely where the light is hottest. The fill is a flat brush block with visible bristle drag, uneven loading and a dirty edge, and the shading over it is exactly two soft-edged cel steps and no more — no third step, no blending, no rendered fur, no individual hairs. Dry paper grain across the whole frame and a slight ink bleed where the heaviest line meets the wet fill. The left half of the frame is unlit near-black ground. No text, no lettering, no watermark, no signature, no border, no speech balloon, no logo, no second figure, no human face.

## Prompt 4 — `scratchy-editorial-poster-hero.webp` (style preview, hero, background lettering as texture only)

> An editorial magazine cover illustration, sixteen by nine, drawn fast and printed rough on stark white paper with visible tooth, small flecks and one honest smudge. Two inks only on that white — a hot vermilion and a deep slate blue — plus the black of the pen; where the two inks overlap they make a third darker value, and there is no other colour and no gradient anywhere in the frame. Blocks of colour are brushed in first with a loaded, half-dry brush and stop with dry ragged edges; the drawing goes over the top in scratchy pen and marker and deliberately does not line up with them, running past the block in places and stopping short of it in others. Centred and cropped hard by the frame on both sides, one invented figure: an anonymous adult seen head and shoulders, chin lifted, one hand raised flat in front of the chest, the head cut by the top edge. Every shadow on the face and hand is built from parallel pen scratches, the deepest values from crossed scratches, and every lit plane is bare white paper; contours break off mid-stroke and the shoulder ends in three unconnected marks. Behind the figure, enormous distressed poster capitals in vermilion bleed off every edge of the frame and are cut through by the head and shoulders — they are eroded and broken as if pulled from a worn block, and they are deliberately **fragments of letters that spell no word in any language**, present only to give the background rhythm and scale. Around the subject, three narrow columns of mock body copy drawn as unreadable grey ruled lines, two thin rules, a small folio mark, and a few handwritten margin notes and arrows in black pen. Flat, frontal, no perspective and no rendered space. No smooth digital rendering, no gradient, no photoreal skin, no dark background, no readable headline, no legible body text, no logo, no wordmark, no brand mark, no recognisable existing character, no real person's likeness, no watermark, no border.

## Prompt 5 — `scratchy-editorial-poster-scene.webp` (style preview, quiet wide scene, no figure, background lettering as texture only)

> An editorial magazine cover illustration of an empty scene, sixteen by nine, with no person, no face and no hands anywhere in it. Stark white paper with visible tooth and small flecks; two inks only — a mustard yellow and an ink blue — plus the black of the pen, overlapping in a few places to make a third darker value, with no gradient and no other colour anywhere. The subject is an ordinary kitchen chair standing alone with a folded coat over its back, drawn centred and cropped tight by the top and bottom edges so it reads much larger than the page. Its colour is brushed in first as two rough blocks with a loaded half-dry brush that stop at dry ragged edges, and the drawing goes over the top in scratchy pen: parallel scratches under the seat and along the shadow side of each leg, crossed scratches where the shadow is deepest, scribbled loops on the coat's folds, and bare white paper for every surface that faces the light. Contours break off mid-stroke and one chair leg finishes as two unconnected marks. Behind it, enormous distressed poster capitals in ink blue bleed off all four edges, eroded and broken as if pulled from a worn block, cut through by the chair, and deliberately **fragments of letters that spell no word in any language**. Around the subject, two narrow columns of mock body copy drawn as unreadable grey ruled lines, one thin rule, a small folio mark, and three handwritten margin notes with arrows in black pen. Flat and frontal, no perspective, no rendered depth. No figure, no face, no hands, no animal, no smooth digital rendering, no gradient, no photoreal surface, no dark background, no readable headline, no legible body text, no logo, no wordmark, no recognisable existing character, no watermark, no border.

## Prompt 6 — `scratchy-editorial-poster-face.webp` (style preview, hardest case, background lettering as texture only)

> An editorial magazine cover illustration pushed to the hardest case this look can be asked for, sixteen by nine: one invented anonymous face at close crop, built entirely out of pen scratches on bare paper. Stark white paper with visible tooth, small flecks and one smudge; two inks only — a hot pink and black — plus the black of the pen, overlapping in places to make a denser value, with no gradient and no third colour anywhere in the frame. The head fills most of the height, cropped hard by the top edge and by both sides, turned slightly and looking just past the viewer, the mouth closed, the expression unreadable. A rough block of pink is brushed in first with a loaded half-dry brush and stops at a dry ragged edge that does not follow the face; the drawing goes over the top and does not line up with it. Every value on the face comes from spacing and crossing of pen strokes and from nothing else — parallel scratches under the cheekbone and along the jaw, crossed scratches in the eye sockets and under the nose and lip, dense crossed scratches for the hair, scribbled loops in the collar — and every lit plane, including most of the forehead, the bridge of the nose and one cheek, is left as completely bare white paper. There is no smooth tone anywhere on the frame, no blending and no rendered skin. Contours break off mid-stroke: one ear is three marks, the far side of the jaw is unclosed, one shoulder ends in a single stroke. Behind the head, enormous distressed poster capitals in pink bleed off every edge, eroded and broken as if pulled from a worn block, cut through by the head, and deliberately **fragments of letters that spell no word in any language**. Two narrow columns of mock body copy as unreadable grey ruled lines run down one side, with a thin rule, a folio mark and two handwritten margin notes in black pen. Flat and frontal, no perspective. No smooth digital rendering, no gradient, no photoreal skin, no dark background, no readable headline, no legible body text, no logo, no wordmark, no recognisable existing character, no real person's likeness, no celebrity, no watermark, no border.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, absence of any readable word in the background lettering, and absence of any copied composition.
