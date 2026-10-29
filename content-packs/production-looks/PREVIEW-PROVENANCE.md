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
