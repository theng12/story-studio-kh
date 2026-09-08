# Archival Ledger preview-byte provenance

This is a source-review record, not a publication approval or a license grant.

## Byte lineage

The four legacy preview files were first added as tracked repository bytes in
`badbf3814452dd624d1247c42e4226a5a6efdb79` (`feat: integrate Archival Ledger
planning source`, 2026-08-14). `1578dcd85e8408e9e721994c45d6cf73d506d782`
(`feat: componentize Archival Ledger`, 2026-08-15) copied those exact bytes into
the independently signed Style and Thumbnail component sources. The verified
SHA-256 identities are:

| Legacy path | Component path | SHA-256 |
| --- | --- | --- |
| `content-packs/archival-ledger/assets/archival-documentary-reconstruction.webp` | `content-packs/paid/archival-ledger/style/archival-documentary-reconstruction/assets/archival-documentary-reconstruction.webp` | `f314283a43c106a44aea6cd779ba7c67e23ba0a357b4c7c0db41dbae126e38b5` |
| `content-packs/archival-ledger/assets/archival-map-investigation-1.webp` | `content-packs/paid/archival-ledger/thumbnail/archival-map-investigation/assets/archival-map-investigation-1.webp` | `47c4e35e83e7fd6a44c82adb0543b4a23a609cc311214df9a71b5666f13288ca` |
| `content-packs/archival-ledger/assets/archival-map-investigation-2.webp` | `content-packs/paid/archival-ledger/thumbnail/archival-map-investigation/assets/archival-map-investigation-2.webp` | `8bb88f199fd9517cdcdd397d175117ec868348d3add20ad2aa14180e9f517c05` |
| `content-packs/archival-ledger/assets/archival-map-investigation-3.webp` | `content-packs/paid/archival-ledger/thumbnail/archival-map-investigation/assets/archival-map-investigation-3.webp` | `ed81d317e34cb74606fae2d0770bfbf33613eaba97ea2bd1e1f5b380ff21d24d` |

## License evidence boundary

Neither those commits nor the available repository handoff evidence grants a
separate preview-asset license. The recorded Content Store boundary in
`docs/superpowers/plans/2026-08-14-story-content-store-phase1.md` at commit
`6aa3210124951be72560bcf4f95d74f400a97fa7` explicitly says Story must not
invent or display license terms before GenStudio publishes them. Accordingly,
this record makes no ownership, redistribution, or customer-license claim.
Any stock or publication decision requires the operator-published product and
license evidence; it is outside this source review.

## Style preview backfill — 2026-09-08

The owner's rule of 2026-09-08 is three previews per Visual Style — the hero, a quiet wide scene with no figure in it, and the hardest case the style can legally be asked for. This collection's Visual Style shipped with one preview, so 2 new previews were rendered and the pack moved to a new `<slug>-v<version>` sibling directory, leaving the directory it shipped from in place. The existing hero bytes were copied into the new directory unchanged.

The full render record — run ids, job ids, prompt digests, the conversion applied and the review of every image — is in `content-packs/PREVIEW-BACKFILL-2026-09-08.md`. The rows below are this collection's accepted bytes.

| Style item | New pack version | Accepted asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | --- | --- | ---: | --- | --- |
| `com.storystudio.style.archival-documentary-reconstruction` | 1.0.1 | `content-packs/paid/archival-ledger/style/archival-documentary-reconstruction-v1.0.1/assets/archival-documentary-reconstruction-scene.webp` | `d4afa4decbffe3ef931f44a21596712c6a5ab459fa074adfc219a1e610f4a2d4` | 151372 | 1672x941 | WebP decode passed |
| `com.storystudio.style.archival-documentary-reconstruction` | 1.0.1 | `content-packs/paid/archival-ledger/style/archival-documentary-reconstruction-v1.0.1/assets/archival-documentary-reconstruction-face.webp` | `c9ab47c62d55d647c4898639c8946ae68392d92bf151be6d8047e457122e6b2e` | 219212 | 1672x941 | WebP decode passed |

Each of these was rendered by GenStudio `gpt-image-2` through the Story Studio Image Pool in the `pack-previews` project, one variant, `16:9`, `2K`, `reference_images: []`, 29 credits each — 58 credits for this collection. Every file decodes as a 1672×941 WebP above the 20,480-byte floor and carries no text of any kind.
