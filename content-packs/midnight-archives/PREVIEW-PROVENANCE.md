# Midnight Archives preview provenance

Thirteen previews are declared by six of this collection's eight standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

The two packs that declare no raster assets — `com.storystudio.topic.the-real-story-is-worse` and `com.storystudio.metadata-formula.contrarian-reveal-titles` — are complete: both build deterministically, sign, and pass `validateContentPack` under an ephemeral authoring key. The other six are **blocked on previews only**; their documents already validate against the signed Content Pack schema, which was checked directly by building each of them once in a throwaway directory with disposable rasters in place. Those rasters were deleted and no placeholder byte was written into this repository.

## Three previews per visual style

The owner's rule, set on 2026-09-08 and applied to Royal History first, carries forward here: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty room.
- **face** — the hardest case the style can be asked for, chosen inside the style's own contract rather than against it.
  - Gothic Candlelight Portrait exists to paint one close face lit by one flame, so its hardest case is that contract pushed to its limit: the flame itself inside the frame near the lens, the face carried almost entirely below the falloff, wet eyes and damp skin rendered honestly at close range, and nothing anywhere to lift the shadow.
  - Inked Crosshatch Storybook forbids a portrait crop and a face close to camera, so its hardest case is the other thing pure line art can fail: the densest possible interior, with glass, brass, water and reflection all built from hatching alone, one light inside the frame, and a small incidental figure turned away at the far end.

The three lettering packs keep the shipped house standard of one to four swatches; this collection declares one swatch each, at the 1024x576 figure the paid lettering packs already use. The Thumbnail Recipe declares four, as the Lost Voyage, Royal History and Golden Epic recipes did, so that both of its variants are shown twice and all three of this collection's letterforms appear at least once.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is the GenStudio text-to-image lane for `gpt-image-2`. Thirteen prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering and title text is drawn by the image model, as the lettering and recipe contracts require).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "midnight-archives-previews-1",
  "prompts": [ ...the thirteen prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

### One request will not fit in Story Studio 1.4.128 or earlier

Attempted on 2026-09-08 and recorded here so the next operator does not lose the attempt. These thirteen prompts serialise to **16,832 bytes**, and every build up to and including 1.4.128 refuses the request with

```
HTTP 413 {"code":"CONTENT_STORE_REQUEST_TOO_LARGE",
          "detail":"Content Store request body exceeds 16 KiB."}
```

The message is misleading: nothing about this route belongs to the Content Store. `routes/content-store.ts` mounted its 16 KiB body guard as a **path-less** `router.use`, and `routes/index.ts` mounts that router bare on `/api` ahead of about thirty others, so every router registered after it — b-roll, research, scene plan, scene review, continuity, music pool, library, changelog — silently inherited the Store's cap. The guard is now scoped to `/content-store`, with a regression test that mounts a sibling router after it and pushes an oversized body through. Once a build carrying that fix is installed, the single request above works as written.

**Until such a build is installed**, do not shorten, merge or reword a prompt to fit — the prompt text is the contract. Send the thirteen as two jobs with distinct run ids (`…-previews-1` for prompts 1-7, `…-previews-1b` for prompts 8-13), because the pool names files `gen-<run_id>-NNNN.png` with the index restarting at 1 for each job, and a shared run id would make the second job overwrite the first. The credits are identical either way: 13 × 29 = 377.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.gothic-candlelight-portrait` | `assets/gothic-candlelight-portrait-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.gothic-candlelight-portrait` | `assets/gothic-candlelight-portrait-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.gothic-candlelight-portrait` | `assets/gothic-candlelight-portrait-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.inked-crosshatch-storybook` | `assets/inked-crosshatch-storybook-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.inked-crosshatch-storybook` | `assets/inked-crosshatch-storybook-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.inked-crosshatch-storybook` | `assets/inked-crosshatch-storybook-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.red-glow-serif-capitals` | `assets/red-glow-serif-capitals.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.distressed-pale-serif` | `assets/distressed-pale-serif.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.lettering.dripping-paint-finish` | `assets/dripping-paint-finish.webp` | 1024x576 | WebP | > 20 KB |
| `com.storystudio.thumbnail.hook-left-frightened-face-right` | `assets/hook-left-frightened-face-right-1.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.hook-left-frightened-face-right` | `assets/hook-left-frightened-face-right-2.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.hook-left-frightened-face-right` | `assets/hook-left-frightened-face-right-3.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.thumbnail.hook-left-frightened-face-right` | `assets/hook-left-frightened-face-right-4.webp` | 1672x941 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style and Thumbnail Recipe contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Prompt 1 — `gothic-candlelight-portrait-hero.webp` (style preview, hero, no text)

> A dark gothic painterly illustration, sixteen by nine, over a heavy ink texture that reads like etching grain. On the right of the frame, one anonymous face fills half the picture, cut at the shoulders, turned toward the viewer and caught in the instant of understanding something: the eyes wide with the whites showing above the iris, the mouth just parted, the brow drawn hard together. A single candle held low and close on the inner side of the face is the only light in the image; it climbs from beneath the cheekbone so the eye sockets, the underside of the brow and the hollow of the throat drop into deep shadow, and everything more than an arm's length behind the head goes to unlit ground. Skin is painted honestly at close range — the damp on the forehead, the wet line along the lower lid, warm colour pooling in the nose and the ear where the flame passes through. The lit side runs amber, honey and ember orange over warm bone; every shadow and the whole ground behind the figure runs cold teal and slate, and no third colour takes any area. Ink grain lies across the entire frame at even weight, heaviest where the light dies. The left half of the frame is empty unlit ground with no architecture, drapery or second subject. No fill light, no second key, no rim from behind. No text, no lettering, no watermark, no signature, no border, no second face, no modern object.

## Prompt 2 — `gothic-candlelight-portrait-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A dark gothic painterly illustration of an empty room at night, wide, with no person anywhere in it and nothing happening. A single candle stands on a plain table near the left of the frame and is the only light in the picture: it lays warm amber across the tabletop, a folded cloth, a closed book and a pewter cup, catches one edge of a chair back, and dies within a few feet, so that the plaster walls, the doorway and the far corner are all cold teal and slate going to unlit ground. Everything the flame reaches is painted honestly — the wax running down the candle, the grain of the wood, the dull sheen on the cup — and everything beyond it is left as dark with only the faintest suggestion of an edge. Heavy ink texture lies across the whole frame at even weight, heaviest in the shadow and in the transition where the light fails. The right half of the frame is quiet unlit ground. Amber and honey on the lit side, cold teal and slate everywhere else, no third colour. No figure, no face, no hands, no animal, no text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 3 — `gothic-candlelight-portrait-face.webp` (style preview, hardest case, no text)

> A dark gothic painterly illustration pushed to the hardest case this look can be asked for, sixteen by nine. One anonymous face fills the right half of the frame, cut at the shoulders, held very close, in open grief: the eyes wet with the lashes clumped and a tear on the cheek catching one point of light, the mouth open, the jaw slack, the lower lip going. The candle itself is inside the frame at the lower inner edge, close to the viewer and very bright, so the flame and the top of the wick blow out to near white while the face sits almost entirely below the falloff, carried on warm bounce alone with no fill, no second key and no rim from behind. Every difficult thing is present at once — the wet lower lid, damp on the forehead and the upper lip, fine stubble or fine hair at the temple, a thin gold chain at the throat with a single highlight, and a bare hand entering the frame at the jaw with the knuckles rendered as honestly as the face. Amber, honey and ember on the narrow lit side; cold teal and slate through the whole shadow and the ground behind. Heavy ink grain across the entire frame, heaviest in the transition. The left half of the frame is unlit ground. No smoothing of the shadowed face, no bloom haze over the whole image, no second candle. No text, no lettering, no watermark, no signature, no border, no second face, no modern object.

## Prompt 4 — `inked-crosshatch-storybook-hero.webp` (style preview, hero, no text)

> A thick-line pen and ink illustration printed like an engraved graphic novel, sixteen by nine. A candlelit writing desk seen from just above and to one side: a single candle in a plain holder near the centre is the only light in the scene, and the hatching radiates from it — the pool of light on the desk left as bare paper with only a thinning hatch, the mid-ground crossed once, the corners crossed twice and going to solid black. On the desk, a quill in an inkwell, a sheet of parchment with a broken wax seal beside it, a folded letter, a pair of spectacles and a stack of tied papers, each drawn first in confident black line of uneven weight — heavy on the contour and on the shadow side, thinning to a hairline where a surface turns into the light — and shaded only by hatching that follows the form. Behind the desk, pigeonholes stuffed with rolled documents recede into cross-hatched dark. Flat, slightly uneven colour washes are laid under the ink with visible edges: dark teal and slate everywhere the light has not reached, warm amber and ochre everywhere it has, and the paper's own bone white left bare for the brightest accents. Stipple for the plaster and the old paper only. One-point perspective with a clear near edge at the desk lip so the eye enters at the bottom of the frame; the upper left third left as quiet dark. No smooth gradient anywhere, no airbrush, no glow bloom. No figure, no text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 5 — `inked-crosshatch-storybook-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A thick-line pen and ink illustration of an empty stone corridor at night, wide, with no person anywhere in it. A single lamp bracketed to the wall at the mid point is the only light: the flagstones and the nearest arch are left as bare paper with a thinning hatch, the middle of the corridor is crossed once, and the far end with its barred door is crossed twice and goes to solid black. Every form is drawn in confident black line of uneven weight — heavy on the contour and on the shadow side, thinning to a hairline where a surface turns into the light — and every value inside is built from hatching that follows the stone's own curve, with stipple for the damp plaster and the worn floor. A low stair at the near edge gives the frame its entry point; a dripping seam runs down one wall; an empty iron ring hangs from a bracket. Flat, slightly uneven colour washes under the ink with visible edges: dark teal and slate for everything unlit, warm amber and ochre for everything the lamp reaches, bone white paper left bare at the brightest points. Two-point perspective, horizon low, the upper right third left as quiet dark. No smooth gradient, no airbrush, no glow bloom, no soft focus. No figure, no face, no hands, no text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 6 — `inked-crosshatch-storybook-face.webp` (style preview, hardest case, no text)

> A thick-line pen and ink illustration pushed to the hardest case pure line art can be asked for, sixteen by nine. A museum store room at night, crowded with the four things hatching handles worst all at once: a tall glass display case with its own reflections, polished brass fittings and a brass microscope, a wide shallow water basin on the floor holding a broken reflection of the room, and a stack of glazed frames leaning against a pillar. A single candle stands inside the display case near the centre of the frame and is the only light, so the hatching radiates outward through the glass, is broken and doubled by every reflective surface, and closes to solid black in the corners. Everything is drawn first in confident black line of uneven weight and shaded only by hatching and cross-hatching that follows each form — the curve of the glass, the turn of the brass, the ripple of the water — with a third crossing layer only in the deepest recesses and stipple for the dust and the old plaster. At the far end of the room, a small incidental figure stands turned away, seen at a distance and drawn no larger than a hand. Flat, uneven colour washes under the ink: dark teal and slate unlit, amber and ochre lit, bare bone white paper for the brightest accents. No smooth gradient anywhere, no airbrush, no glow bloom, no soft focus, no blur to solve a reflection. No portrait crop, no face close to camera, no text, no lettering, no watermark, no signature, no border, no modern object.

## Prompt 7 — `red-glow-serif-capitals.webp` (lettering swatch, axis `font`)

> A lettering specimen centred on a plain very dark teal ground. The three words THE REAL STORY set as bold serif capitals in clean bone white with strong thick-to-thin stroke contrast and sharp bracketed serifs, stacked tight across two lines of equal width, each letter carrying a thin hard outline in deep blood red and, behind that, a soft red glow burning outward into the dark. The white fill is slightly distressed with fine broken edges and small chipped flecks as if printed on rough stock. No bevel, no gradient, no drop shadow. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no third line of text.

## Prompt 8 — `distressed-pale-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen centred on a plain very dark teal ground. The three words WAS NEVER TRUE set as bold serif capitals with crisp bracketed serifs and strong thick-to-thin stroke contrast, stacked tight across two lines of equal width, filled in a cold blue-white. Every letter is heavily distressed — broken edges, dry gaps through the stems, small chipped flecks as if stamped on damp paper — and carries one thin dark edge of even weight all the way round with the faintest cool glow just beyond it. No bevel, no gradient, no drop shadow. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no third line of text.

## Prompt 9 — `dripping-paint-finish.webp` (lettering swatch, axis `text`)

> A lettering specimen centred on a plain very dark teal ground. The two words THEY KNEW set as plain heavy capitals on one line, finished as freshly applied wet paint in a single flat deep red, the surface glossy and slightly uneven with visible brush loading. Thin runs leave the baseline of four of the letters and travel straight down before thinning to a point and stopping partway; two of the runs carry a small bead at the tip, and the paint pools very slightly where each run begins. No outline, no bevel, no glow, no drop shadow. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no border, no watermark, no second line of text.

## Prompt 10 — `hook-left-frightened-face-right-1.webp` (recipe, variant A, red-glow hook)

> A dark gothic painterly illustration used as a wide cover image, sixteen by nine, over a heavy ink texture. The right half of the frame carries one anonymous face, cut at the shoulders, turned toward the viewer with the eyes to camera and caught in fear — the whites showing above the iris, the mouth just parted. A single candle held low and close on the inner side of the face is the only light: it climbs from beneath the cheekbone, drops the eye sockets and the throat into shadow, and dies to unlit ground behind the head. The lit side runs amber and honey; every shadow and the whole ground runs cold teal and slate. The left half of the frame is empty unlit ground and carries only the hook, rendered directly in the image on two lines of equal width: THE REAL over STORY IS WORSE, set as bold serif capitals in clean bone white with sharp bracketed serifs, each letter carrying a thin hard deep-red outline and a soft red glow burning outward into the dark, the white fill slightly distressed with broken edges and small chipped flecks. Hold a clear margin between the outermost letter and the left, top and bottom edges, and let nothing — costume, architecture, smoke or beam — cross behind the letters. Text perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no second line of copy beyond the hook's own two lines, no second face, no recognisable individual.

## Prompt 11 — `hook-left-frightened-face-right-2.webp` (recipe, variant A, red-glow hook, different subject)

> A dark gothic painterly illustration used as a wide cover image, sixteen by nine, over a heavy ink texture. The right half of the frame carries one anonymous face in a plain high collar, cut at the upper chest, turned toward the viewer with the eyes to camera and caught in shock — the mouth open, the jaw slack, the brow drawn hard together. A torch held just outside the lower inner edge of the frame is the only light: it climbs the face from beneath, throws the underside of the brow and the hollow of the throat into deep shadow, and falls away to unlit ground within a foot of the head. Amber, honey and ember on the lit side; cold teal and slate through every shadow and across the whole ground behind. Ink grain over the entire frame at even weight. The left half is empty unlit ground and carries only the hook, rendered directly in the image on three lines of equal width: THEY BURNED over THE ONLY over RECORD, set as bold serif capitals in clean bone white with sharp bracketed serifs, a thin hard deep-red outline on every letter and a soft red glow behind, the fill slightly distressed. Clear margin to the left, top and bottom edges; nothing crossing behind the letters. Text perfectly spelled and unclipped. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no fourth line, no second face, no recognisable individual.

## Prompt 12 — `hook-left-frightened-face-right-3.webp` (recipe, variant B, title across the top, distressed pale serif)

> A thick-line pen and ink illustration used as a wide cover image, sixteen by nine, printed like an engraved graphic novel. A whole scene fills the frame: a records room at night, tied bundles of paper in pigeonholes running back along one wall, a long table with an open ledger and a spilled box of loose sheets, and one lamp standing on the table as the only light in the room, with the hatching radiating from it — bare paper in the pool of light, one crossing in the mid-ground, two crossings and solid black in the far corners. Two-point perspective with a clear near edge at the table corner so the eye enters at the bottom of the frame and travels to the lamp; a small incidental figure stands at the far end turned away, drawn no larger than a hand. Flat uneven washes under the ink: dark teal and slate unlit, amber and ochre lit, bare bone white for the brightest accents. Across the full width of the top of the frame, and only there, render the title on one line: THE FILE WAS ALREADY GONE, set as bold serif capitals with crisp bracketed serifs in a cold blue-white, heavily distressed with broken edges and dry gaps through the stems, each letter carrying one thin dark edge of even weight with the faintest cool glow just beyond it. Keep the band of picture behind those letters flat, dark and quiet so no shelf, beam or edge crosses them, and hold a clear margin to the top and to both side edges. Text perfectly spelled and unclipped. No smooth gradient, no airbrush, no glow bloom. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no second line of copy, no face close to camera, no recognisable individual.

## Prompt 13 — `hook-left-frightened-face-right-4.webp` (recipe, variant B, title across the bottom, dripping paint finish)

> A thick-line pen and ink illustration used as a wide cover image, sixteen by nine, printed like an engraved graphic novel. A whole scene fills the frame: a cellar workshop at night, a small brick furnace with its door open at the right as the only light in the room, glass vessels and a copper still on a bench, a mortar, a set of scales, and a stone stair rising out of frame at the left. The hatching radiates from the furnace mouth — bare paper at the opening, a single crossing across the bench, two crossings and solid black in the vaulting overhead — and every form is drawn first in confident black line of uneven weight, shaded only by hatching that follows the curve of the glass and the turn of the copper, with stipple for the brick and the floor. One-point perspective with a clear near edge at the bench lip. Flat uneven washes under the ink: dark teal and slate unlit, amber and ochre lit, bare bone white for the brightest accents. Across the full width of the bottom of the frame, and only there, render the title on one line: NOBODY PAID FOR GOLD, set as plain heavy capitals finished as freshly applied wet paint in a single flat deep red, glossy and slightly uneven with visible brush loading, with thin runs leaving the baseline of four letters and travelling straight down before thinning to a point and stopping partway, two of them carrying a small bead at the tip. Keep the band of picture behind those letters flat, dark and quiet so no bench edge, vessel or stair crosses them, and hold a clear margin to the bottom and to both side edges. Text perfectly spelled and unclipped. No smooth gradient, no airbrush, no glow bloom. No wordmark, no channel name, no logo, no badge, no ribbon, no numeral, no border, no watermark, no second line of copy, no face close to camera, no recognisable individual.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
