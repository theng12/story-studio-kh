# Baroque Myth preview provenance

Four previews are declared by two of this collection's three standalone Content Packs. **None of them exist yet.** This file records why, exactly what must be run to produce them, and the prompt text prepared for each, so the render is a keyed operator's single step rather than a re-authoring pass.

The pack that declares no raster assets — `com.storystudio.topic.gods-heroes-and-epics` — is complete: it builds deterministically, signs, and passes `validateContentPack` under an ephemeral authoring key. The other two are **blocked on previews only**; their documents already validate against the signed Content Pack schema, which was checked directly by building each of them once in a throwaway directory with disposable rasters in place. Those rasters were deleted and no placeholder byte was written into this repository.

## Three previews per visual style, one swatch per lettering style

The owner's rule, set on 2026-09-08 and applied to Royal History first, carries forward here: every Visual Style declares **three** previews rather than one, and the three are chosen so a buyer sees the style where it is easy, where it is quiet, and where it is hard.

- **hero** — the shot the style exists for, the one a cover would use.
- **scene** — a quiet wide scene with **no figure in it at all**, so a buyer can see what the look does to an empty frame. This is the hard one for a style whose whole subject is figures on cloud, which is exactly why it is worth showing.
- **face** — the hardest case the style can be asked for, chosen inside the style's own contract rather than against it.
  - Baroque Mythological Sky refuses the close-cropped screaming face by name in its negative prompt, so its hardest case is the opposite: one calm head held very close, carried entirely on warm flesh against a stormy sky with a single high source and no fill, where the blended half-tones, the canvas tooth and the varnish bloom all have to survive at portrait range without any drapery, any diagonal or any cherub to carry the composition.

The Lettering Style declares one swatch, at the 1024x576 figure the shipped paid lettering packs already use, because a lettering style is bought by looking at it and one correctly spelled specimen is what there is to look at.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. Earlier passes rendered their previews under explicit owner authorisations given in chat for those passes only. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

Same route the earlier collections used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is the GenStudio text-to-image lane for `gpt-image-2`. Four prompts, one variant each, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering in the fourth prompt is drawn by the image model, as the lettering contract requires).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "baroque-myth-previews-1",
  "prompts": [ ...the four prompts below, in order... ]
}
```

Then poll the returned job, retain the returned PNGs outside the repository, and convert each accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. The lettering swatch resizes to 1024x576 from the same sixteen by nine original; the three style previews resize to 1672x941. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

### Request size

These four prompts serialise to **6,708 bytes**, well inside the 16 KiB body cap that blocked the thirteen-prompt Midnight Archives batch on Story Studio 1.4.128 and earlier; this collection's body holds four prompts against the seven-prompt ceiling this pass is working to. Send them as one job with the run id above. Do not shorten, merge or reword a prompt to save bytes — the prompt text is the contract. The credits are 4 × 29 = 116.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.style.baroque-mythological-sky` | `assets/baroque-mythological-sky-hero.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.baroque-mythological-sky` | `assets/baroque-mythological-sky-scene.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.style.baroque-mythological-sky` | `assets/baroque-mythological-sky-face.webp` | 1672x941 | WebP | > 20 KB |
| `com.storystudio.lettering.spaced-light-serif-edition-label` | `assets/spaced-light-serif-edition-label.webp` | 1024x576 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs; the 1672x941 figure is the Visual Style contract in `docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md`. The `assets/` directories are absent from this commit because git does not track empty directories; create each one when its bytes land.

## Acceptance rules specific to this collection

Original subjects only. The figures in these prompts are anonymous and are described from scratch; no real person, no recognisable living individual and no copied composition may appear, and a returned image that reproduces a known painting's arrangement must be rejected rather than committed. The three style previews must carry no word in any language: a returned image with readable lettering anywhere in it is unusable. The lettering swatch is the opposite case — its two lines must be spelled exactly as written, correctly tracked, unclipped at both ends, and with no third line and no ornament of any kind. Divine attributes must be drawn as real objects rather than as floating symbols, and no invented insignia, coat of arms or emblem may be added to any of the four.

## Prompt 1 — `baroque-mythological-sky-hero.webp` (style preview, hero, no text)

> A high-baroque mythological oil painting on coarse primed canvas, sixteen by nine, painted and never photographed. A bank of sunlit cloud fills the lower half of the frame, piled thick where bodies rest on it and dissolving to slate and violet in shadow beneath. Three anonymous figures are arranged on a long rising diagonal from the lower left corner toward the upper right: at the bottom a heavily built bearded man reclines on the cloud with one arm thrown back, a great length of crimson drapery snapping around his hip and thigh; above and behind him a woman in gold and slate cloth leans forward with one arm extended along the diagonal, her drapery lifting behind her in heavy sculptural folds; highest of all a younger male figure twists to look back down the line, seen sharply from below. Beside the reclining man an eagle stands on the cloud with its wings half open, drawn as a real bird; a bronze trident lies across the cloud below the woman, and a small lyre rests against her knee. Four small winged infants tumble at the edges of the group, carrying cloth and reaching, always subordinate. The sky behind is gilded amber and honey on the right, bruised slate and grey-green storm on the left, with one shaft of brighter opening directly behind the highest figure. Strong chiaroscuro from a single high source outside the frame at the upper right: one side of every figure fully lit in warm cream and rose flesh, the other falling into a warm brown shadow that keeps its colour. Soft blended oil handling through the flesh, drier drag through the cloth and hair, loaded impasto only on the brightest turn of a shoulder and a knee, canvas weave showing through the thinner darks, fine craquelure and a warm varnish bloom over the whole surface. Nothing is centred and nothing is symmetrical. No photograph, no flat vector, no anime, no modern object, no muted grey palette, no text, no lettering, no watermark, no signature, no border, no logo, no invented insignia, no recognisable individual, no screaming face.

## Prompt 2 — `baroque-mythological-sky-scene.webp` (style preview, quiet wide scene, no figure, no text)

> A high-baroque oil painting of an empty sky, wide, sixteen by nine, with no person, no infant, no animal and no face anywhere in it and nothing happening. Great banks of cloud fill the lower two thirds of the frame, sunlit and piled like carded wool along their upper edges and falling away into slate and violet shadow beneath, arranged on a long diagonal from the lower left toward the upper right. Lying unattended on the cloud, as though set down and left: a bronze trident on its side, a small wooden lyre with its strings catching the light, a plain gold circlet, and a length of crimson drapery spread across the cloud with its heavy folds catching a broad lit face and a deep shadow trough. Above and behind, the sky is gilded amber and honey toward the right and bruised slate, grey-green and storm-dark toward the left, with one shaft of brighter opening high on the right where the light comes from. Strong chiaroscuro from that single high source outside the frame, so the cloud has a fully lit upper surface and a warm coloured shadow underneath, and the metal objects each carry one bright highlight and one long soft reflected light. Soft blended oil handling throughout, drier drag through the drapery folds, restrained impasto only on the brightest edge of the cloud and on the rim of the circlet, coarse canvas weave visible through the thin darks, fine craquelure and a warm varnish bloom across the whole surface. The upper left of the frame is quiet dark storm and nothing else. No figure, no face, no hands, no wings, no animal, no bird, no photograph, no flat vector, no anime, no modern object, no muted grey palette, no text, no lettering, no watermark, no signature, no border, no logo, no invented insignia.

## Prompt 3 — `baroque-mythological-sky-face.webp` (style preview, hardest case, no text)

> A high-baroque oil painting pushed to the hardest case this look can be asked for, sixteen by nine. One anonymous head and bare shoulder fill the right half of the frame, held very close and cropped at the top of the hair and at the upper arm: a calm adult face turned three-quarters toward the light and tilted slightly back, the eyes open and quiet, the mouth closed, the expression settled rather than dramatic. Every difficult thing is present at once — the lit cheek modelled through half a dozen soft blended half-tones from cream to rose to warm umber, the shadow side losing its edge entirely into the ground without any fill light, a small warm catchlight in each eye, damp hair against the temple painted wet-in-wet, and the collarbone and the top of the shoulder rendered as honestly as the face. One high source outside the frame at the upper left is the only light. Behind the head, a bruised slate and grey-green storm sky occupies the left of the frame with one narrow shaft of gilded amber opening low behind the shoulder; a single fold of crimson drapery crosses the lower left corner and nothing else. Coarse primed canvas tooth shows through the thin darks of the background, the flesh is built in soft blended oil with a loaded impasto only on the brightest turn of the cheekbone and the shoulder, and a fine craquelure and warm varnish bloom lie over the whole surface. No smoothing of the shadow side, no second light, no rim light from behind, no cool grey in the shadows, no cherub, no wings, no attribute, no photograph, no flat vector, no anime, no modern object, no text, no lettering, no watermark, no signature, no border, no logo, no second figure, no recognisable individual, no open mouth, no scream, no distress.

## Prompt 4 — `spaced-light-serif-edition-label.webp` (lettering swatch, text is the subject)

> A lettering specimen, sixteen by nine, centred on a flat dark charcoal band that fills the whole frame. Two lines of type and nothing else. The lower and larger line reads THE GOLDEN SKY in thin light-weight serif capitals with fine hairline serifs and low stroke contrast, in clean white, tracked very wide so that the letters sit well apart with generous even air between every pair, set as one line across the centre of the frame with a clear margin at both ends. Directly above it, separated by a comfortable gap, one much smaller line reads SERIES ONE in the same serif as small capitals, at roughly a quarter of the height of the title, tracked wider still, and set in a dimmed grey-white rather than full white. Both lines are horizontally centred on the same axis. Both are perfectly flat and matte: no outline, no bevel, no gradient, no drop shadow, no glow, no texture, no distressing and no ornament. The background is a single even charcoal with no image, no vignette, no pattern and no rule. Text perfectly spelled, correctly and evenly tracked, unclipped at both ends, with no third line, no punctuation, no numerals, no logo, no watermark, no signature and no border.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row per file when the bytes land, in the same form the earlier records use: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
