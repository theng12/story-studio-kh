# Timeless Dreams preview provenance

One preview is declared by one of this collection's two standalone Content Packs. **It now exists, and it passed review.** It was rendered on 2026-09-08 by Story Studio Image Pool job `5f541ae9` (run id `timeless-dreams-previews-1`) against the `pack-previews` project, under the owner authorisation given in chat that day. The returned original was accepted; its digest, byte count and the conversion applied are in "Retained bytes" at the end of this file. Both packs in this collection build, sign and pass `validateContentPack` under an ephemeral authoring key.

The sections below are kept as written rather than rewritten in hindsight, because they record why the render was held and exactly what was run. What changed is stated in place.

The pack that declares no raster assets — `com.storystudio.topic.legends-across-every-civilisation` — is complete: it builds deterministically, signs, and passes `validateContentPack` under an ephemeral authoring key. The lettering pack was **blocked on its preview only**, and is no longer blocked: its declared swatch is present, decodable and at contract size. Its document already validates against the signed Content Pack schema, which was checked directly by building it once in a throwaway directory with a disposable raster in place. That raster was deleted and no placeholder byte was written into this repository.

## One swatch for one lettering style

The three lettering packs shipped by Midnight Archives set the current house practice, which follows the shipped paid lettering packs: one to four swatches is the schema bound, and a collection declares one swatch per lettering style at the 1024x576 figure the paid lettering packs already use. This collection ships a single lettering style and therefore a single swatch.

The three-preview rule the owner set on 2026-09-08 applies to Visual Styles. This collection ships none, so the rule has nothing to bind here; it is recorded so a later reader does not mistake the single file for a shortfall.

## Why nothing was rendered in the authoring pass

`docs/VISUAL_STYLE_CONTENT_PACK_FORMAT.md` and the `story-studio-visual-style-adoption` skill both state that this control Mac verifies preview handoffs and does not perform production image generation, and that previews come only from owner-supplied original bytes or a production-preview handoff. The 2026-09-06 sleep-history pass rendered its six previews under an explicit owner authorisation given in chat for that pass only. No such authorisation existed when this collection was authored, so nothing was generated, nothing was substituted, and no placeholder bytes were written that would let a pack pass validation dishonestly. **The authorisation arrived on 2026-09-08** and the swatch was rendered in that pass; what ran is recorded below.

## The exact command a keyed operator must run (and did)

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

Then poll the returned job, retain the returned PNG outside the repository, and convert the accepted original with a whole-image resize (cover, lanczos3) to the dimensions in the table — no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. What actually ran used WebP quality 90 effort 6, the house encoder the sleep-history, Lost Voyage, Royal History and Midnight Archives passes all used, falling back to lossless effort 6 had the flat swatch landed under the 20,480-byte floor at quality 90; it did not — it encoded to 69,148 bytes — so quality 90 stands and no fallback was needed. Record the original digest and byte count, the accepted digest, byte count and decode result, and the credits spent, in the table below before committing the bytes.

### Request size

The 16 KiB body cap that blocked the Midnight Archives batch on Story Studio 1.4.128 and earlier does not bind here: the request body measures 1,303 bytes. It was sent as one job. The credits are 1 × 29 = 29, as costed.

**That is what was done.** Job `5f541ae9` ran against the `pack-previews` project on 2026-09-08 and reported `done`, returning `gen-timeless-dreams-previews-1-0001.png`. It recorded `gpt-image-2`, aspect `16:9`, resolution `2K`, one variant, and the returned original decodes as 2560x1440 PNG. The prompt recorded below is byte-identical to that executed job's `params.prompts[0]` — checked against `jobs.json` — which is what makes the file-to-prompt mapping in "Retained bytes" a fact rather than an assumption.

## Acceptance contract per file

| Pack | Asset path (pack-relative) | Required dimensions | Required format | Floor |
| --- | --- | --- | --- | --- |
| `com.storystudio.lettering.ornate-fantasy-metal-serif` | `assets/ornate-fantasy-metal-serif.webp` | 1024x576 | WebP | > 20 KB |

The 1024x576 lettering figure matches the swatches already shipped by the paid lettering packs. The `assets/` directory was absent from the authoring commit because git does not track empty directories; it was created when its bytes landed, and the file now sits at the path above at the dimensions and format required.

## Prompt 1 — `ornate-fantasy-metal-serif.webp` (lettering swatch, axis `font`)

> A lettering specimen centred on a plain very dark charcoal ground with the faintest warm tone in it. The three words EVERY OLD STORY set as tall ornate serif capitals cut from engraved metal, stacked tight across two lines of equal width, the letterforms filled with warm gold running into dark bronze in the recesses, a fine scale-like grain lying through every stem, a crisp bevelled highlight along each upper edge, sharp bracketed serifs, and the terminals of the outer letters drawn out into small curling flourishes that stay clear of the neighbouring letters. Beneath the second line, a short tagline reading LEGENDS OF THE WORLD set in widely letter-spaced small capitals of the same metal, held between two thin horizontal rules that begin and end exactly where the tagline does. No drop shadow, no outer glow, no gradient wash behind the letters, no gemstone, crown, wing or shield ornament added to any letter, and no border of any kind. The lettering fills the middle of the frame and is perfectly spelled and unclipped. Nothing else in the image: no illustration, no background scene, no watermark, no fourth line of text.

## Retained bytes

| Runtime source asset | Returned original | Conversion and deterministic proof | Accepted WebP | Title, prompt, route |
| --- | --- | --- | --- | --- |
| `content-packs/timeless-dreams/lettering/ornate-fantasy-metal-serif/assets/ornate-fantasy-metal-serif.webp` | `gen-timeless-dreams-previews-1-0001.png`; original `55e00fed9d7345c010a0c67bd7ddbe2f31fd849e771180ffc65b6f7248717855` (3582733 B PNG, 2560x1440) | Whole-image resize(1024×576, cover, lanczos3) then WebP quality 90 effort 6; paired encodes byte-identical; no crop beyond the sub-pixel aspect trim, no overlay, composite, or repair. | `aab64d3fa7b373a4370d6516df71932d636d4df19ac403fa96b3e1fdc8481f4f`; 69148 bytes; 1024x576 WebP decode passed | EVERY OLD / STORY (2 lines, engraved gold-into-bronze ornate serif capitals with curling outer terminals) over the tagline LEGENDS OF THE WORLD held between two rules that begin and end with it; all four words correctly spelled and unclipped; prompt 1 sha256 `f4271ec35a719fd33bf068f20e4f2463ab25b58e24ceb3e2ce5e726915eef871`; GenStudio `gpt-image-2` via Story Studio Image Pool job `5f541ae9`, 29 credits, `reference_images: []`. |

One row, in the same form the sleep-history, Lost Voyage, Royal History and Midnight Archives records use: original digest and byte count, the exact conversion applied and its paired-encode proof, the accepted digest, byte count, dimensions and decode result, and the route, job id and credits spent. The row above is for a file that was decoded and reviewed at card size for spelling, legibility, absence of logos, watermarks and UI, and absence of any copied composition. One file, 29 credits.
