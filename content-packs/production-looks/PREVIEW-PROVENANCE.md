# Production Looks Preview Provenance

These six previews are owner-approved migrations of publisher-controlled images that previously shipped in Story Studio's retired built-in catalog. The standalone Content Pack assets below are now the canonical retained bytes; the approved migration did not introduce an external license claim, a new composition, production generation, or third-party creator identity.

For every row below, the final pack asset was decoded as WebP at 1672x941 and checked against the migration-time SHA-256 and byte count.

The first product was renamed from the third-party mark to Retro Paint Fantasy on 2026-08-28. Existing projects retain their project-local legacy ID and copied style prose, while the current product and asset use the neutral standalone identity below.

| Current style identity | Canonical asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | --- | ---: | --- | --- |
| `com.storystudio.style.retro-paint-fantasy` | `content-packs/production-looks/style/retro-paint-fantasy/assets/retro-paint-fantasy.webp` | `5dced4a83086703f8b49ce8edff43b137126a0c237a8636c35ef6b4d5b3afbc8` | 226050 | 1672x941 | WebP decode passed |
| `com.storystudio.style.pixel-art-story` | `content-packs/production-looks/style/pixel-art-story/assets/pixel-art-story.webp` | `f81fd10b04dabff766f993fe6dfecd80611c5e3d61545abc131431650307adf5` | 191300 | 1672x941 | WebP decode passed |
| `com.storystudio.style.anime-cel` | `content-packs/production-looks/style/anime-cel/assets/anime-cel.webp` | `d5c5336ef911b14dec00deee80b112a0d25f70a6e5106cb755f6dc42173f8e18` | 270804 | 1672x941 | WebP decode passed |
| `com.storystudio.style.studio-catalog-realism` | `content-packs/production-looks/style/studio-catalog-realism/assets/studio-catalog-realism.webp` | `60e7b00efb4b6c80e691c6241edcb8a19659a7b069842fd3fb36b11af6a1171e` | 239570 | 1672x941 | WebP decode passed |
| `com.storystudio.style.whiteboard-doodle-explainer` | `content-packs/production-looks/style/whiteboard-doodle-explainer/assets/whiteboard-doodle-explainer.webp` | `e4ed319d2d1a59b2dabea6d94c114fcdd11e808e80bccd7617e203ae41354dcb` | 158216 | 1672x941 | WebP decode passed |
| `com.storystudio.style.hand-drawn-cartoon-explainer` | `content-packs/production-looks/style/hand-drawn-cartoon-explainer/assets/hand-drawn-cartoon-explainer.webp` | `ad03fb926514316328776c89684f25e8ee34f0635cfff8d8e9c378d077445b16` | 78230 | 1672x941 | WebP decode passed |

## Style preview backfill — 2026-09-08

The owner's rule of 2026-09-08 is three previews per Visual Style — the hero, a quiet wide scene with no figure in it, and the hardest case the style can legally be asked for. 6 of this collection's Visual Styles shipped with one preview each, so 12 new previews were rendered and each of those packs moved to a new `<slug>-v<version>` sibling directory, leaving the directory it shipped from in place. The existing hero bytes were copied into the new directory unchanged.

The full render record — run ids, job ids, prompt digests, the conversion applied and the review of every image — is in `content-packs/PREVIEW-BACKFILL-2026-09-08.md`. The rows below are this collection's accepted bytes.

| Style item | New pack version | Accepted asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | --- | --- | ---: | --- | --- |
| `com.storystudio.style.anime-cel` | 1.0.1 | `content-packs/production-looks/style/anime-cel-v1.0.1/assets/anime-cel-scene.webp` | `c6b4ee5d47f841139d653e7ac8f2e873f0062139b806ca033d2280bae17dabba` | 217930 | 1672x941 | WebP decode passed |
| `com.storystudio.style.anime-cel` | 1.0.1 | `content-packs/production-looks/style/anime-cel-v1.0.1/assets/anime-cel-face.webp` | `d833f10575a9035b6d63501b3cbc9c5c59a940ae385cca866c608e47553060e9` | 189884 | 1672x941 | WebP decode passed |
| `com.storystudio.style.hand-drawn-cartoon-explainer` | 1.0.1 | `content-packs/production-looks/style/hand-drawn-cartoon-explainer-v1.0.1/assets/hand-drawn-cartoon-explainer-scene.webp` | `022c99c531c8857d143159898b170db1355223cc826a842a1944550e5bb9026a` | 88780 | 1672x941 | WebP decode passed |
| `com.storystudio.style.hand-drawn-cartoon-explainer` | 1.0.1 | `content-packs/production-looks/style/hand-drawn-cartoon-explainer-v1.0.1/assets/hand-drawn-cartoon-explainer-face.webp` | `e2491670b096ad24e3d579df0857d47a9ac970d945d9efed19a8ea79e80fd0b4` | 102458 | 1672x941 | WebP decode passed |
| `com.storystudio.style.pixel-art-story` | 1.0.1 | `content-packs/production-looks/style/pixel-art-story-v1.0.1/assets/pixel-art-story-scene.webp` | `2fc59c67d5ca67ce7e9bd27131adfdb04cda9426ef556c42e8b279700e649c2c` | 238462 | 1672x941 | WebP decode passed |
| `com.storystudio.style.pixel-art-story` | 1.0.1 | `content-packs/production-looks/style/pixel-art-story-v1.0.1/assets/pixel-art-story-face.webp` | `acb45269b78abe570548506d7acc5a153622de7a722e75a468c064488bb4ac95` | 272340 | 1672x941 | WebP decode passed |
| `com.storystudio.style.retro-paint-fantasy` | 1.0.1 | `content-packs/production-looks/style/retro-paint-fantasy-v1.0.1/assets/retro-paint-fantasy-scene.webp` | `523705e1c37fcc4de451137bfe1c54d84c50d8e6ebabf51d458fb534bdad88e2` | 130794 | 1672x941 | WebP decode passed |
| `com.storystudio.style.retro-paint-fantasy` | 1.0.1 | `content-packs/production-looks/style/retro-paint-fantasy-v1.0.1/assets/retro-paint-fantasy-face.webp` | `9e9e50212ec50772a3545b9852c139c35131d90c57f435277dc70033a6c5aa6a` | 231016 | 1672x941 | WebP decode passed |
| `com.storystudio.style.studio-catalog-realism` | 1.0.1 | `content-packs/production-looks/style/studio-catalog-realism-v1.0.1/assets/studio-catalog-realism-scene.webp` | `a199fff423a5208463443b386a5ed7a040254ebccf23fbd7b58489aac9b35590` | 202168 | 1672x941 | WebP decode passed |
| `com.storystudio.style.studio-catalog-realism` | 1.0.1 | `content-packs/production-looks/style/studio-catalog-realism-v1.0.1/assets/studio-catalog-realism-face.webp` | `f10586c004347f852633ba4a21282af283402f63e25d35cb5a10544945c2f6de` | 112122 | 1672x941 | WebP decode passed |
| `com.storystudio.style.whiteboard-doodle-explainer` | 1.0.1 | `content-packs/production-looks/style/whiteboard-doodle-explainer-v1.0.1/assets/whiteboard-doodle-explainer-scene.webp` | `664f217a329332eebc74429d7ab1b02c4c5821454bf8daa8b0ef065853a1732f` | 62976 | 1672x941 | WebP decode passed |
| `com.storystudio.style.whiteboard-doodle-explainer` | 1.0.1 | `content-packs/production-looks/style/whiteboard-doodle-explainer-v1.0.1/assets/whiteboard-doodle-explainer-face.webp` | `be1e6ede7e9192156ec4bb827a3f7c1c0c7db9361409600e74a923ffc71fbc2e` | 72974 | 1672x941 | WebP decode passed |

Each of these was rendered by GenStudio `gpt-image-2` through the Story Studio Image Pool in the `pack-previews` project, one variant, `16:9`, `2K`, `reference_images: []`, 29 credits each — 348 credits for this collection. Every file decodes as a 1672×941 WebP above the 20,480-byte floor and carries no text of any kind.

The six owner-approved migrated heroes in the table at the top of this file were copied into the new version directories unchanged and their SHA-256 and byte counts re-verified after the bump; all six still match. They were not re-rendered, not re-encoded and not re-cropped — they only gained two siblings each.

## Webtoon Martial Arts — 2026-10-29

A new standalone Visual Style, `com.storystudio.style.webtoon-martial-arts`, approved by the
owner on 2026-10-29 from three supplied webtoon reference panels: a young martial artist
shouting with a bamboo staff from a low angle; two old scholars in patterned silk robes against
blue sky; and a cloaked youth before a snowy stone watchtower. The references set the rendering
contract only. No reference composition was copied, no reference image was used as input, and
nothing was traced, cropped or composited.

Model: `mflux-community/qwen-image-2-1-turbo-mflux-q4`, on **this Mac's own Studio Hub** only
(`http://127.0.0.1:47873`, the owner's single local exception for drawing art-style pack
previews). Steps 8, guidance 1.0, `16:9`, `1K` — the model's published 1280x720 PNG output.
The Hub token was read from its ready file into a shell/python variable and never printed,
logged, written to a receipt or passed as an argument. One job in flight at a time: the Hub
answers a second concurrent submission with HTTP 409.

Each final preview is a whole-image conversion of its 1280x720 PNG original with the Pillow
bundled in Studio Hub's Image runtime (12.3.0, `webp` enabled): `convert("RGB")`, Lanczos
resize to exactly 1672x941, then WebP `quality=90, method=6`. No crop, mask, retouch, lettering,
overlay or compositing. The 1280x720 render is 1.7778:1 and the 1672x941 target is 1.7768:1, so
the resize changes the aspect by about 0.06% and drops no content; the preview is an upscale,
not a claim of native 1672x941 generation.

| Accepted asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | ---: | --- | --- |

| `webtoon-martial-arts.webp` | `89adc9b70e7b3912f7b0b460f79027baa50d00849085f80ae0b1361d3c023f38` | 172462 | 1672x941 | WebP decode passed |
| `webtoon-martial-arts-scene.webp` | `381e7eaa0861d360abe2dedc3bb82d67eaed56d88bf57a5c82d71941deb7e30a` | 280792 | 1672x941 | WebP decode passed |
| `webtoon-martial-arts-hardest.webp` | `e5e7e380e70905164ad7c9d39a3dbe693613b7991291b2a8cdaa89757e3326e5` | 194394 | 1672x941 | WebP decode passed |

### Refused renders

Every refused render is retained with its request in
`_trash/webtoon-pack-20261029/raw/` and was never rewritten. A retry kept the same medium
contract and changed the specific fault.

- **hero, seed 101** (job `5b1c1ea7f79b48f1b5bbc2c4e4bca803`): refused on review — the shading
  was soft and airbrushed rather than flat cel with a hard shadow edge, and the training hall
  read as fully rendered rather than a softly painted background. The style bible was tightened
  to "large flat cel colour areas, posterised flat tonal steps ... and a crisp drawn shadow
  edge" and the hero re-rendered.
- **scene, seed 101** (job `e7adf168f0c8449ca188627ae6b1b33d`): refused on review — a man in a
  robe stands in the middle of the courtyard. The slot must be figure-free.
- **scene, seed 303** (job `9c3832248e864de8b13748997a4ec871`): refused on review — a man in a
  robe again fills the frame, though the prompt asked for an empty courtyard. The full style
  bible primes people ("figures", "anatomy", "faces"), so the scene prompt was rewritten as a
  figure-free background plate that keeps every rendering trait and drops the figure vocabulary.
- **hardest, seed 101** (job `eaf22dc33d984e88bd949a7dab565cb7`): refused on review
  — the second figure reads as a young man rather than an old scholar, and the composition copies
  the reference panel's "two faces leaning toward the viewer" framing.

### webtoon-martial-arts — hero

- Variant: the hero, and the Style Library card image
- Hub job: `1917aa89fe7e415fbdaea83b8e95655e` (final state `done`)
- Seed: `202` · Requested: 16:9 1K → 1280x720 PNG
- Original: `1280x720` PNG, 1216804 bytes, SHA-256 `f0cb1a016044e42e007d31b6153d12201403bd9a3f2f199657404d6466714a99`
- Final: `content-packs/production-looks/style/webtoon-martial-arts/assets/webtoon-martial-arts.webp`, 1672x941 WebP, 172462 bytes, SHA-256 `89adc9b70e7b3912f7b0b460f79027baa50d00849085f80ae0b1361d3c023f38`
- Full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
Korean martial-arts webtoon manhwa panel, a drawn and painted 2D digital comic key art: bold clean confident black ink outlines of varied weight, heavier on outer contours and lighter on interior detail, large flat cel colour areas, posterised flat tonal steps with one single hard-edged shadow tone modelling each form and a crisp drawn shadow edge, a few short straight ink hatch marks placed only inside shadows and cloth creases, simplified stylised manhwa anatomy with large expressive eyes and exaggerated sometimes comedic facial expressions, dramatic cinematic camera angle with strong diagonals and foreshortening, softly digital-painted background kept slightly out of focus and lower in contrast than the figures, airy light pastel palette of muted jade pale sand dusty rose soft slate and warm cream, bright even light, crisp finished high-resolution modern webtoon key art, smooth flat colour, clean graphic shapes. a young martial artist in a worn grey training robe shouting, gripping a long bamboo staff across one shoulder, seen from a dramatic low angle inside a wooden training hall, sweat-beaded forehead, fierce determined eyes, wind-blown black hair.
```

</details>

### webtoon-martial-arts — scene

- Variant: a quiet wide scene with no figure in it
- Hub job: `1cfa9613ab63432aa73aa0d4b14dee54` (final state `done`)
- Seed: `606` · Requested: 16:9 1K → 1280x720 PNG
- Original: `1280x720` PNG, 1383389 bytes, SHA-256 `66d556d190509dd5d4dc092151fd4e5e3417d185456aa3baeea23471b31b58b1`
- Final: `content-packs/production-looks/style/webtoon-martial-arts/assets/webtoon-martial-arts-scene.webp`, 1672x941 WebP, 280792 bytes, SHA-256 `381e7eaa0861d360abe2dedc3bb82d67eaed56d88bf57a5c82d71941deb7e30a`
- Full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A wide establishing background plate of an empty ancient walled stone courtyard in falling snow, a tall tiered stone watchtower standing alone behind the low wall, deep snow lying on the flagstones and on the bare pine branches, thin mist drifting at ground level, a bright pale overcast sky filling the upper frame, the whole courtyard deserted and uninhabited with nothing alive in it. Korean martial-arts webtoon manhwa background art, a drawn and painted 2D digital comic key art: bold clean confident black ink outlines of varied weight, large flat cel colour areas, posterised flat tonal steps with one single hard-edged shadow tone on each form and a crisp drawn shadow edge, a few short straight ink hatch marks placed only inside shadows and creases, softly digital-painted artwork kept slightly out of focus, airy light pastel palette of muted jade pale sand dusty rose soft slate and warm cream, bright even light, crisp finished high-resolution modern webtoon key art, smooth flat colour, clean graphic shapes, an empty uninhabited landscape panel
```

</details>

### webtoon-martial-arts — hardest

- Variant: the hardest legal case for the style
- Hub job: `89ffa40dedd9496d92de6bdbbeff03d7` (final state `done`)
- Seed: `404` · Requested: 16:9 1K → 1280x720 PNG
- Original: `1280x720` PNG, 1238160 bytes, SHA-256 `68c251e1573e01e30a0ca70f504e670d32311e47a02f67059f79aeeddc595c39`
- Final: `content-packs/production-looks/style/webtoon-martial-arts/assets/webtoon-martial-arts-hardest.webp`, 1672x941 WebP, 194394 bytes, SHA-256 `e5e7e380e70905164ad7c9d39a3dbe693613b7991291b2a8cdaa89757e3326e5`
- Full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
Korean martial-arts webtoon manhwa panel, a drawn and painted 2D digital comic key art: bold clean confident black ink outlines of varied weight, heavier on outer contours and lighter on interior detail, large flat cel colour areas, posterised flat tonal steps with one single hard-edged shadow tone modelling each form and a crisp drawn shadow edge, a few short straight ink hatch marks placed only inside shadows and cloth creases, simplified stylised manhwa anatomy with large expressive eyes and exaggerated sometimes comedic facial expressions, dramatic cinematic camera angle with strong diagonals and foreshortening, softly digital-painted background kept slightly out of focus and lower in contrast than the figures, airy light pastel palette of muted jade pale sand dusty rose soft slate and warm cream, bright even light, crisp finished high-resolution modern webtoon key art, smooth flat colour, clean graphic shapes. two old scholars in richly patterned silk robes with embroidered roundels, both white-bearded and weathered, walking together in profile along a stone temple terrace, one with his eyes closed and his hands folded behind his back, against a bright blue sky with soft painted clouds and the tiled roof of a temple behind them.
```

</details>
