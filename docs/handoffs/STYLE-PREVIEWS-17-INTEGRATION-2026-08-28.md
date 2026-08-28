# 17 cave-subject style previews — verified, converted, integration blocked

**Delivery:** `gpt-storystudio`, 2026-08-28
**Artifact:** `~/Developer/_handoffs/artifacts/style-previews-17-2026-08-25/`
**Request:** `image-request-02-seventeen-style-previews` (now in `_handoff-trash`, marked completed)
**Status:** delivery verified · conversion done and reproducible · **not integrated — two blockers**

The intended destination was `frontend/public/builtin-style-previews/<slug>.webp`, replacing the
current mixed set (16 lantern-and-bridge + 1 outlier) with 17 renderings of one cave-mouth subject.
Nothing in this branch writes to that directory. Below is what was verified, what was produced, and
why it stopped.

## 1. Delivery verification — PASS

All 17 SHA-256 digests and byte counts recomputed from disk against `manifest.json`: **17/17 match.**
File set on disk equals the manifest set exactly — no omissions, no extras. Every file parsed from
its PNG IHDR chunk as **1672 × 941, 8-bit, RGB**, matching both the manifest and the repo contract in
`docs/BUILT_IN_STYLE_FORMAT.md`. 1672 × 941 is 16:9 to within one pixel (exact would be 1672.889).

## 2. Conversion — done, deterministic

House recipe, as recorded in `content-packs/thumbnail-recipe-expansion-ten/PREVIEW-PROVENANCE.md`:

```js
sharp(src).resize(1672, 941, { fit: 'fill', kernel: 'lanczos3' })
          .webp({ lossless: true, effort: 6 })
```

The resize is a no-op here — sources are already 1672 × 941. Run twice into separate directories:
**all 17 byte-identical across both runs.** All decode as 1672 × 941 WebP, all far above the 20 KiB
floor the regression test enforces.

Note the style-preview corpus has **no recorded conversion recipe of its own** — the existing
previews predate it and the signed style packs were byte-for-byte *migrations* of those legacy bytes,
not conversions (`content-packs/production-looks/PREVIEW-PROVENANCE.md`). The lossless recipe above is
the repo's only documented image conversion, and is what was applied.

Size consequence, worth a decision: lossless output is 0.78–2.64 MB per file against 58–442 KB today.
`frontend/public/builtin-style-previews/` would grow **3.7 MB → ~26 MB**. There is precedent for
multi-MB lossless WebP in `frontend/public/` (`thumbnail-recipe-previews/` is already 8.2 MB), so this
is within house practice, but a lossy encode would serve a card-scale picker just as well. Choosing a
quality number would be an invention, not a recipe, so lossless was used and the tradeoff is reported
rather than decided.

Target digests, should the blockers clear (reproducible from the artifact with the recipe above):

| slug | sha256 | bytes |
| --- | --- | ---: |
| anime-cel | `596382717969bcdfd37c6a83ba3ff05b55d325d630a27288510e2cf6d99958a1` | 1649504 |
| archival-documentary-reconstruction | `d8db6f6d999cbabaed5b9218f32ec378f448a461c74bc754e158eb9d13bbdfac` | 1540490 |
| cinematic-photoreal | `046ca9b8201100a0131c95ab902fb0838f33d0ef57c258b477544fe3ba992041` | 1607108 |
| flat-vector-explainer | `4503ac792df24ac4064d77deca5a74d2d1efc987512908eb6ce95a5e9802d5bd` | 818520 |
| hand-drawn-cartoon-explainer | `c8ab0825ede33d42775c9cb2e0518dddf5ef8da7d7156138dc8183babc568f72` | 1167860 |
| hand-drawn-editorial-diagram | `c69873a1f805a97aeea9ecf5c11b785f34eef117b4a44226762f11f0dd90fd06` | 2193700 |
| minimal-stick-figure-explainer | `a0c472f0b6c2af3b711e64f6d311d3d1c2751aeebb22195a4143ef5cb863aba9` | 780606 |
| ms-paint-fantasy | `c160217304d9a1ac10b698c06a009cf8d49302bb983242478cf23130b411b743` | 1158792 |
| oil-painting-classical | `fdff689d3f9911a5cb3f3bb615e5145b588e1455d313bb037e4dcfcd45da4268` | 1954994 |
| paleo-documentary-tableau | `25278863752955264c2073231be82c80118cd1ffc45ae32e5ce5e91a0de295b5` | 1719728 |
| pixel-art-story | `0a2299375b5b639c083b3767813b106090d9de82a04939e403ed106d62450621` | 1683710 |
| prehistoric-stick-cartoon | `63730397cfa290692b33e3cc82cf81f50af10ff81524168ed31e5663632c56c0` | 1496834 |
| sepia-ink-wash | `c8116f50f3b98bb915b7df93de8f49e3147238eb6a06d05fec1d31b9ebbf7d50` | 1843290 |
| studio-catalog-realism | `5be4e2cbf9a59af83dbe697a8898bc3bad90ed0c32f079d9de9602af75853266` | 1750694 |
| watercolor-storybook | `0d97c549c5822068fdcefeb8d890d4539c38a6cebcd69ac9ce1720b84d52ad8d` | 1924702 |
| waxy-outline-cartoon | `47980da677b2c5ad2d5330a07247aef671f6ab6b535cf5eaedea62d26f12303b` | 2640418 |
| whiteboard-doodle-explainer | `8ef47a4a68b58ce264b3d0d3820d4cf8d7048838baf7e26de951c29e2446c79c` | 1068028 |

## 3. Blocker A — the delivered set is not subject-consistent

The request's central requirement: *"Same composition, same framing, same time of day, in every one of
the 17. Only the rendering style changes... a customer choosing a style must see one variable, not
two."* Period dress was authorised for exactly two slugs, `paleo-documentary-tableau` and
`prehistoric-stick-cartoon`.

Every image was opened at reduced scale and inspected. Composition, framing, cave-mouth crop, river,
mountains and sunrise are held constant throughout — that part is correct. **The traveller is not.**

- **Modern traveller with pack and staff, as specified (8):** anime-cel, cinematic-photoreal,
  flat-vector-explainer, hand-drawn-cartoon-explainer, hand-drawn-editorial-diagram,
  minimal-stick-figure-explainer, ms-paint-fantasy, oil-painting-classical.
- **Period explorer in hat and coat (1):** archival-documentary-reconstruction — defensible, the
  style is a period photographic reconstruction.
- **Fur-clad stone-age figure (8):** the two authorised slugs, plus **six that were not** —
  `pixel-art-story`, `sepia-ink-wash`, `studio-catalog-realism`, `watercolor-storybook`,
  `waxy-outline-cartoon`, `whiteboard-doodle-explainer`. Several also add mammoths or aurochs to the
  valley, introducing a second varying element.

This is not style fidelity. Each of those six `style_bible` entries in
`frontend/composables/useBuiltInStyles.ts` was checked: **none contains any prehistoric, cave, ice-age,
mammoth or stone-age term.** Only `prehistoric-stick-cartoon` does. The drift came from the generation,
not from the contracts it was told to honour.

The delivery's own `independent-review.md` states in its cross-set section that *the two prehistoric
slugs* use period-appropriate figures rather than modern hikers. Eight do. That review passed 17/17 and
missed this, so it should not be relied on as the sole visual gate.

Integrating as-is would ship a picker where six styles differ from their neighbours in both style *and*
subject — the precise failure the request existed to prevent, and the same failure that caused Batch B
of request 01 to be rejected.

## 4. Blocker B — the previews are byte-sealed into signed packs, 11 of them already sold

Every one of the 17 live preview files is **byte-identical** to the swatch asset inside a signed
Visual Style content pack (verified by digest across all 21 style-pack assets in `content-packs/`):

| pack source | slugs | on the GenStudio store |
| --- | --- | --- |
| `content-packs/free-starters/style/` | 9 | `active`, release `1.0.0` `published`, 300 credits |
| `content-packs/paid/archival-ledger/style/` | 1 | `active`, release `1.0.0` `published`, 300 credits |
| `content-packs/symbolic-psychology-studio/style/` | 1 | `active`, release `1.0.0` `published`, 300 credits |
| `content-packs/production-looks/style/` | 6 | **absent** — never stocked |

**The two sides disagree, and the store is the one that counts.** This repo's
`content-packs/authoring-registry.json` marks all 17 `status: "authored"` with SKU and family still
`"proposed"` — but that vocabulary has no stocked state at all (`STATUSES = new Set(['authored',
'reserved'])` in `scripts/content-packs/authoring-registry.mjs`), because stocking is a GenStudio-side
act this repo can only propose. The live GenStudio catalogue holds 14 `visual_style` products, all
`active`, each with a `published` `1.0.0` release and a `.sspack` on disk. Eleven of them are exactly
the first three rows above. A Story-side "authored" record is therefore not evidence that nothing was
sold.

Confirmed across the boundary: the archive GenStudio serves for Cinematic Photoreal contains
`assets/cinematic-photoreal.webp` at **118,754 bytes** — the exact size of
`frontend/public/builtin-style-previews/cinematic-photoreal.webp` in this tree. The bytes a customer
bought are the bytes this change would overwrite. That is the same objection that keeps the font
swatches frozen.

Test consequences of replacing only `frontend/public/builtin-style-previews/`:

- **Breaks now (3 files).** `scripts/content-packs/__tests__/production-looks.test.mjs` hardcodes the
  current digests from line 25 and re-hashes the *live* file at line 183
  (`assert.equal(sha256(sourceBytes), expected.sha256)`, then `assert.deepEqual(destinationBytes,
  sourceBytes)`). `free-starter-inventory.test.mjs` re-hashes each public file against the ledger in
  `free-starters/ASSET-PROVENANCE.md` at line 163. `production-looks-signed-styles.test.ts` builds real
  archives and asserts the served swatch equals the public file — this one self-heals if both sides
  move together.
- **Passes unchanged.** `frontend/__tests__/builtInStyles.test.ts` only checks the path shape, that the
  file exists and that it exceeds 20 KB. No hash, no dimensions.
- **Breaks additionally if the pack copies are updated too (5 more files).** `free-starter-wave-one`,
  `-two`, `-three`, `archival-ledger-components.test.mjs`, and
  `symbolic-psychology-studio-wave-1-source.test.ts` all pin pack-side digests; three of them also
  hard-assert `1672 × 941`, which the new set does satisfy.
- **Silently wrong.** The symbolic-psychology and archival-ledger provenance markdown name the public
  path beside a now-false hash, with no assertion covering them.

So a swap is a nine-file change plus two hand-edited ledgers, not a drop-in.

The unstocked six are not a safe partial route either: three of them (`pixel-art-story`,
`studio-catalog-realism`, `whiteboard-doodle-explainer`) carry Blocker A, and the six-style stocking
handoff of 2026-08-28 requires their receipt chain be repaired through its canonical workflow and not
disturbed.

Worth recording, since it cuts the other way: the content packs are **not** bundled into the DMG —
`electron-builder.json` ships only `content-packs/recovery`. The previews reach customers as ordinary
frontend static assets inside `app.asar`, and have shipped in every recent release including 1.4.75.

## 5. What is genuinely broken today, and stays broken

The live `hand-drawn-cartoon-explainer.webp` was confirmed by eye: **a stick figure at a bank ATM** —
cash, a receipt, a green tick. It is the one preview in a storytelling style picker with nothing to do
with storytelling, and the replacement for it is one of the eight correct images in this delivery.

It is not fixable in isolation. Those bytes are sealed into the `production-looks` pack whose receipt
chain is mid-repair, and its digest is hardcoded in `production-looks.test.mjs`.

## 6. To reach customers, in order

1. Regenerate the six subject-drifted slugs on the modern traveller. Generation lives with
   gpt-storystudio; nothing here regenerated any asset.
2. An owner call on the sold eleven: leave the published swatches frozen and let the in-app preview
   diverge, or reissue those packs at a new version so preview and purchased swatch stay identical.
3. Land the six unstocked slugs together with their pack assets, provenance rows and the hardcoded
   digests in `production-looks.test.mjs` — after the receipt-chain repair, not before.
4. Decide lossless versus lossy, given the 3.7 MB → 26 MB bundle growth.

When the swap does happen, this is the gate. The content-pack tests are **not** part of `npm test` and
must be invoked directly, from the repo root — `production-looks.test.mjs` resolves through
`process.cwd()`:

```bash
node --test scripts/content-packs/__tests__/production-looks.test.mjs \
            scripts/content-packs/__tests__/free-starter-inventory.test.mjs \
            scripts/content-packs/__tests__/free-starter-wave-one.test.mjs \
            scripts/content-packs/__tests__/free-starter-wave-two.test.mjs \
            scripts/content-packs/__tests__/free-starter-wave-three.test.mjs \
            scripts/content-packs/__tests__/archival-ledger-components.test.mjs
npm run test:backend        # unfiltered; --only is explicitly not the release gate
npm run test:frontend
```

No asset was regenerated, no pack was rebuilt, no product, price or publication state was touched, and
nothing was deployed.
