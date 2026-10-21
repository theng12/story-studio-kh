# Illustrated History preview provenance

Three standalone Content Packs are prepared in this collection. This file is the truthful state of
their preview rasters on 2026-10-21: what exists, what was reviewed, and the exact hashes and build
steps. No placeholder or fabricated byte is written into this repository.

## What each pack declares and what exists

| pack | preview_assets declared | source | source bytes / SHA-256 | converted WebP |
|------|------------------------|--------|------------------------|----------------|
| `com.storystudio.pack.style.bold-illustrated-history` | `assets/bold-illustrated-history-hero.webp` | owner-approved Qwen 2.1 Turbo image, text-free | 1,244,646 `663d22b2730ba6f79e28753a18d47899377bde2afd44f9635e601fc8b44c1902` | **yes** — 216104 `7c4b7f21e95202600559f95add22317717c2d0dc297936d5f2108879c2b24073` |
| `com.storystudio.pack.thumbnail.illustrated-subject-sleep-badge` | `assets/illustrated-subject-sleep-badge-1.webp` | owner-approved Z-Image ROME sample | 1,428,338 `749859235ae960661177e61effe98cfb97ff9510d3199f572dcd41eb9d828db3` | **yes** — 287562 `26cf71feb2a7e2b7ea652df292fee2ab64831afcbe0f5476793edd57fc439c10` |
| `com.storystudio.pack.thumbnail.illustrated-subject-sleep-badge` | `assets/illustrated-subject-sleep-badge-2.webp` | owner-approved Qwen 2.1 Turbo image, `THE SILK ROAD` | 1,243,894 `9d538c4a660908168542ddd895c9b58e7d3c45d0ebafd6e6c3788af722db1912` | **yes** — 217490 `ce7a1c214e4ce755397c2ef55a207ce7e6ae3a18d9e67f07003ec594aa3be85a` |
| `com.storystudio.pack.thumbnail.illustrated-subject-sleep-badge` | `assets/illustrated-subject-sleep-badge-3.webp` | owner-approved Qwen 2.1 Turbo image, `THE FALL OF CARTHAGE` | 1,156,789 `f5a28b9cb767887224779d88975b37f233209e79b0029999b59b13a4d6ea6c1c` | **yes** — 201098 `293f7d92f5d6c86b2e980ed56fd4dbf3e7b552580d877e98998fa3926d4594fc` |
| `com.storystudio.pack.formula.illustrated-history-for-sleep` | none — a series formula declares no raster | not applicable | not applicable | complete |

All four declared preview rasters now exist: the style pack and the formula pack have every declared
raster or none at all, and the thumbnail pack has its three varied previews. Each was produced by the
pack's own helper with paired-encode identity, and every output hash above was read back from the
file on disk.

All four sources are **owner-approved**. The ROME sample comes from the owner's one-sample request.
The owner reviewed the three Qwen renders directly on 2026-10-21 and approved them: “i've check the
generated images just now. they are all good quality and accepted.” The coordinator arranged and
recorded the generation; the approval is the owner's.

## The short-subject contract

The signed thumbnail-recipe schema now accepts the engine's `short-hook` mode, and this recipe uses
it. `short-hook` is the existing two-or-three-word engine mode
(`electron/server/models/thumbnail-headlines.ts`); the recipe's own 1–4-word guidance still asks for
a single concrete subject. The portable schema change and the adapter pass-through are covered by
`electron/server/__tests__/content-pack-legacy-adapters.test.ts`; the source-level recipe contract is
covered by `scripts/content-packs/__tests__/illustrated-history-packs.test.mjs`.

Because that schema capability ships in the new runtime, the prepared manifests keep the
`{{MIN_APP_VERSION}}` token and the build binds **1.4.347** with `--min-app-version`. The manifests
remain `release-bound`; no version is written into them and `content-packs/release-floor.json` is not
edited in this lane.

## The Z-Image ROME sample (owner approval, unchanged)

| field | value |
|-------|-------|
| slot | `thumbnail-1` → `assets/illustrated-subject-sleep-badge-1.webp` |
| source | `~/Developer/_orchestra/illustrated-sleep-history-20261021/sample/rome-thumbnail-sample.png` |
| origin | one-sample probe requested by the owner, 2026-10-21 |
| model | `studio-hub::filipstrand/Z-Image-Turbo-mflux-4bit` |
| route | configured Gateway image API → Studio Hub fleet (`terranash-0108-m1-8-256-hub`) |
| job | `d7e867a3-039b-4540-bfba-88bf2ab75381` / upstream `7ffe8c62a7` |
| original | 1,428,338 bytes PNG, 1280x720, SHA-256 `749859235ae960661177e61effe98cfb97ff9510d3199f572dcd41eb9d828db3` |
| review | ROME and FOR SLEEP spelled correctly, one subject line, badge bottom-left, no extra text or watermark |

The later Qwen 2.1 Turbo sample
(`sample/rome-thumbnail-qwen-turbo-sample.png`, SHA-256
`34326ed5db7fa4675f8f2b15562989c203c84b8f97f6ab3533d48149bf95d086`) is **retained but rejected**:
its subject line reads `ROME SLEENT ROMENTOE`, so it fails the recipe's spelling and extra-text cull
rules. It is not an input to any preview. Qwen 2.1 Turbo is the direction set for new thumbnail
renders; that does not make the failed sample usable.

## The three owner-approved Qwen renders

All three used the existing published Qwen 2.1 Turbo image product through the configured local
Gateway image API (`POST /v1/images/generations`), with remote Studio Hub dispatch and no local
inference: `studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4`, `16:9`, `1K`, PNG, no
reference images. Source receipts live in
`_orchestra/illustrated-sleep-history-20261021/preview-generation/receipts/`.

| slot | subject | Gateway job | upstream | machine | source |
|------|---------|-------------|----------|---------|--------|
| `style-1` | text-free harbour scene | `4a2a328e-89f0-49f7-9c55-22fab2a7e117` | `e3c5a0a759` | `studio-mini` | 1,244,646 PNG, 1280x720, `663d22b2…c1902` |
| `thumbnail-2` | `THE SILK ROAD` | `addd7961-82b6-4dad-9bee-b4e3c9dc0bb7` | `05968c6747` | `terranash-1502-m4-16-256-hub` | 1,243,894 PNG, 1280x720, `9d538c4a…db1912` |
| `thumbnail-3` | `THE FALL OF CARTHAGE` | `efc08ad8-32c3-4609-8d3a-d9dc2735f0af` | `eca1f5c2fd` | `studio-mini` | 1,156,789 PNG, 1280x720, `f5a28b9c…ea6c1c` |

The owner reviewed all three directly on 2026-10-21 and approved them for these previews: “i've
check the generated images just now. they are all good quality and accepted.” No additional sample
was generated, and no channel, project, preset or production job was changed.

## Conversion

The coordinator ran the pack helper in its media lane. Contract: whole-image
`resize(1672x941, cover, lanczos3)` then WebP quality 90 effort 6, with paired encodes proven
byte-identical; no crop, mask, overlay, composite, repair or re-lettering. The helper refuses any
source whose digest, byte count, format or dimensions differ from its pin, and refuses to overwrite
an existing output.

The ROME conversion used the owner-approved source with the same helper and the same contract:

```sh
node content-packs/illustrated-history/prepare-previews.mjs --status
node content-packs/illustrated-history/prepare-previews.mjs \
  --slot thumbnail-1 \
  --source ~/Developer/_orchestra/illustrated-sleep-history-20261021/sample/rome-thumbnail-sample.png
```

No further media is pending.

## Build commands

All three packs are ready to build: every declared preview raster exists and matches the hashes
above. Every candidate archive binds the release floor explicitly; the delivery-attested profile is
keyless by design.

```sh
# 1.4.347 is the coordinator-selected floor for the short-hook schema capability.
node scripts/content-packs/build-pack.mjs \
  content-packs/illustrated-history/formula/illustrated-history-for-sleep \
  --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.4.347 \
  --output dist/content-packs/illustrated-history/formula-illustrated-history-for-sleep-1.0.0.sspack

node scripts/content-packs/build-pack.mjs \
  content-packs/illustrated-history/style/bold-illustrated-history \
  --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.4.347 \
  --output dist/content-packs/illustrated-history/style-bold-illustrated-history-1.0.0.sspack

node scripts/content-packs/build-pack.mjs \
  content-packs/illustrated-history/thumbnail/illustrated-subject-sleep-badge \
  --delivery-profile genstudio-store-receipt-v1 --min-app-version 1.4.347 \
  --output dist/content-packs/illustrated-history/thumbnail-illustrated-subject-sleep-badge-1.0.0.sspack

node scripts/content-packs/validate-pack.mjs <archive> --delivery-profile genstudio-store-receipt-v1
```

`content-pack:ship` is not used here: all three registry records were advanced `reserved → authored`
at lifecycle revisions 294–296, and this lane did not sign, stock or publish them.

## Retained bytes

| asset | source | converted WebP |
|-------|--------|----------------|
| `bold-illustrated-history-hero.webp` | 1,244,646 PNG, `663d22b2…c1902` | 216104, `7c4b7f21…b24073` |
| `illustrated-subject-sleep-badge-1.webp` | 1,428,338 PNG, `74985923…828db3` | 287562, `26cf71fe…fc439c10` |
| `illustrated-subject-sleep-badge-2.webp` | 1,243,894 PNG, `9d538c4a…db1912` | 217490, `ce7a1c21…a3be85a` |
| `illustrated-subject-sleep-badge-3.webp` | 1,156,789 PNG, `f5a28b9c…ea6c1c` | 201098, `293f7d92…6d4594fc` |

## Remaining work, stated concretely

1. **Build and validate — done 2026-10-21.** All three archives built and validated with exit 0;
   exact file names, byte counts and SHA-256 pins live in the permanent
   `_orchestra/illustrated-sleep-history-20261021/archives/MANIFEST.json`.
2. **Registry — done.** The three records were advanced `reserved → authored` at lifecycle
   revisions 294–296. Stocking and publication remain separate decisions and are not claimed here.
