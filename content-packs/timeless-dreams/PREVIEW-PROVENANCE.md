# Timeless Dreams preview provenance

One preview is declared by one of this collection's two standalone Content Packs. **It does not exist yet.** This file records why, exactly what must be run to produce it, and the prompt text prepared for it, so the render is a keyed operator's single step rather than a re-authoring pass.

The pack that declares no raster assets — `com.storystudio.topic.legends-across-every-civilisation` — is complete: it builds deterministically, signs, and passes `validateContentPack` under an ephemeral authoring key. The lettering pack is **blocked on its preview only**; its document already validates against the signed Content Pack schema, which was checked directly by building it once in a throwaway directory with a disposable raster in place. That raster was deleted and no placeholder byte was written into this repository.

## One swatch for one lettering style

The three lettering packs shipped by Midnight Archives set the current house practice, which follows the shipped paid lettering packs: one to four swatches is the schema bound, and a collection declares one swatch per lettering style at the 1024x576 figure the paid lettering packs already use. This collection ships a single lettering style and therefore a single swatch.

The three-preview rule the owner set on 2026-09-08 applies to Visual Styles. This collection ships none, so the rule has nothing to bind here; it is recorded so a later reader does not mistake the single file for a shortfall.

## Why nothing was rendered in this pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation exists for this pass, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly.

## The exact command a keyed operator must run

Same route the sleep-history previews used: the Image Pool generator inside a running Story Studio app, in a project whose configured image product is the GenStudio text-to-image lane for `gpt-image-2`. One prompt, one variant, aspect `16:9`, `reference_images: []` (text-only, no reference asset, no image-to-image, no compositing, no post-render typography — the lettering is drawn by the image model, as the lettering contract requires).

```
POST /api/projects/<project-slug>/image-pool/generate
Content-Type: application/json

{
  "pool_id": "<image pool id>",
  "model": "<published GenStudio gpt-image-2 product id>",
  "aspect_ratio": "16:9",
  "resolution": "<published output row, 1K or higher>",
  "variants": 1,
  "run_id": "timeless-dreams-previews-1",
  "prompts": [ ...the single prompt below... ]
}
```

Then poll the returned job, retain the returned PNG outside the repository, and convert the accepted original with a whole-image resize plus lossless WebP (effort 6) to the dimensions in the table — no crop, overlay, composite, or repair. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

### Request size

The 16 KiB body cap that blocked the Midnight Archives batch on Story Studio 1.4.128 and earlier does not bind here: this request serialises to well under 2 KiB. Send it as one job. The credits are 1 × 29 = 29.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.lettering.ornate-fantasy-metal-serif` | `assets/ornate-fantasy-metal-serif.webp` | 1024x576 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs. The `assets/` directory is absent from this commit because git does not track empty directories; create it when its bytes land.

## Prompt 1 — `ornate-fantasy-metal-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen centred on a plain very dark charcoal ground with the faintest warm tone in it. The three words EVERY OLD STORY set as tall ornate serif capitals cut from engraved metal, stacked tight across two lines of equal width, the letterforms filled with warm gold running into dark bronze in the recesses, a fine scale-like grain lying through every stem, a crisp bevelled highlight along each upper edge, sharp bracketed serifs, and the terminals of the outer letters drawn out into small curling flourishes that stay clear of the neighbouring letters. Beneath the second line, a short tagline reading LEGENDS OF THE WORLD set in widely letter-spaced small capitals of the same metal, held between two thin horizontal rules that begin and end exactly where the tagline does. No drop shadow, no outer glow, no gradient wash behind the letters, no gemstone, crown, wing or shield ornament added to any letter, and no border of any kind. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no background scene, no watermark, no fourth line of text.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Fill one row when the bytes land, in the same form the sleep-history record uses: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. Do not enter a row for a file that has not been decoded and independently reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition.
