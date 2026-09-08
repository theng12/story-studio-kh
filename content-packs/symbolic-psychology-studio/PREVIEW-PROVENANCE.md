# Symbolic Psychology Studio preview provenance

## Oil Painting Classical

- Status: evidenced migrated asset; the standalone Content Pack retains the cited contract and exact preview byte.
- Asset: `content-packs/symbolic-psychology-studio/style/oil-painting-classical/assets/oil-painting-classical.webp`
- Source commit: `3838fbccc33d7f58485063c2819e23c80c792976`
- SHA-256: `721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a`
- Byte size: `402056`
- Decode: WebP, `1672×941`
- Rights basis: owner-supplied original asset; owner-supplied rights basis.
- Exact retired-contract parity at the cited source commit:
  - `style_bible`: `classical oil painting, old-master technique, visible impasto brushwork, rich layered glazes, deep chiaroscuro lighting, warm earthen palette with deep shadows, canvas texture, dramatic single light source, baroque atmosphere, painterly edges, museum-quality depth`
  - `negative_prompt`: `flat vector, pixel art, cartoon, neon colours, 3D CGI render, hard digital edges, lowres, modern clip-art, text, watermark`

## Gothic Charcoal Animal Editorial

- Status: blocked.
- No Gothic source directory, component identity, preview, or reservation is created by this ledger.
- Missing qualification evidence: original preview bytes; source/rightsholder provenance; rights/license basis; transformation record; independent visual review.
- The proposal remains out of the Symbolic Psychology Studio closure until all five missing evidence items are supplied and independently reviewed.

## Style preview backfill — 2026-09-08

The owner's rule of 2026-09-08 is three previews per Visual Style — the hero, a quiet wide scene with no figure in it, and the hardest case the style can legally be asked for. This collection's Visual Style shipped with one preview, so 2 new previews were rendered and the pack moved to a new `<slug>-v<version>` sibling directory, leaving the directory it shipped from in place. The existing hero bytes were copied into the new directory unchanged.

The full render record — run ids, job ids, prompt digests, the conversion applied and the review of every image — is in `content-packs/PREVIEW-BACKFILL-2026-09-08.md`. The rows below are this collection's accepted bytes.

| Style item | New pack version | Accepted asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | --- | --- | ---: | --- | --- |
| `com.storystudio.style.oil-painting-classical` | 1.0.1 | `content-packs/symbolic-psychology-studio/style/oil-painting-classical-v1.0.1/assets/oil-painting-classical-scene.webp` | `2290022e9369d505f9bf79624714b410f7c761fab33a8423f22a4403e3619a17` | 177282 | 1672x941 | WebP decode passed |
| `com.storystudio.style.oil-painting-classical` | 1.0.1 | `content-packs/symbolic-psychology-studio/style/oil-painting-classical-v1.0.1/assets/oil-painting-classical-face.webp` | `b125560a479574ec0b05beadb0b0eb534d91d8f165e28453134cea0d4209cb98` | 166638 | 1672x941 | WebP decode passed |

Each of these was rendered by GenStudio `gpt-image-2` through the Story Studio Image Pool in the `pack-previews` project, one variant, `16:9`, `2K`, `reference_images: []`, 29 credits each — 58 credits for this collection. Every file decodes as a 1672×941 WebP above the 20,480-byte floor and carries no text of any kind.
