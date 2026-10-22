# Quiet Anime Poetry — standalone visual style

status: authored-for-review
component: visual-style
release_classification: content-only; existing released Story 1.4.347 supports the visual-style schema and local keyless .sspack import. Build floor: content-packs/release-floor.json = 1.0.843. No app version/changelog bump, DMG or restart.
reservation: revision 297, receipt authoring:1edebe1dc0261a14756cfea819db55d206686175dbdaab36ebf5f437670c3397. Coordinator verified the complete expected identity before authoring. Authored transition revision 298, lifecycle:ea0300a157680098b204b0f0f2b170555100e11ea07e82147e94a628c23a77dc.
identity: com.storystudio.pack.style.quiet-anime-poetry@1.0.0; item com.storystudio.style.quiet-anime-poetry; publisher com.storystudio. No bundle_id.
stocking_proposal: family com.storystudio.family.style.quiet-anime-poetry and SKU com.storystudio.sku.style.quiet-anime-poetry remain proposed; no live store, price, grant or publication.
source: content-packs/poetry-looks/style/quiet-anime-poetry/{pack.json,content/visual-style.json,assets/quiet-anime-poetry.webp}
intent: delicate ink contours, restrained clean cel shading, painted environments, muted cinematic colour, understated emotional metaphor and no grain. The owner approved the Qwen sample direction; the reusable wording is authored from that direction, not separately approved verbatim.
compatibility: content-independent and useful with any appropriate format; no specific formula pairing has been tested, so compatible_formula_ids is empty.
dependencies: []

## Originality and preview provenance

Owner-supplied channel screenshots inform broad medium, emotional restraint and composition principles. They were not submitted as image inputs, traced or embedded. No channel identity, poem wording, logo, named character or exact composition is used. The preview is a new scene: an adult at a hillside tram stop, a scarf in an unoccupied place and a distant approaching light. Qwen selection is provenance and the owner's generation preference; it is absent from runtime style dispatch fields.

Generated through the configured Gateway with the live Qwen Image 2.1 Turbo selection, job 377e97ee-5d9c-44d0-abb8-ecf71b5a76e7. Actual generation exit 0. Source PNG: 1280×720, 1,133,505 bytes, SHA-256 2e6b72471e56b0237fd861c4d78b65987f31bf165d61ed509fa8c5d3518525ed, full decode passed. Pack WebP: Lanczos resize and centre crop to 1672×941, 177,290 bytes, SHA-256 f8ae97f301a5ba13b7d9b5ee39b155492a158d241e41976892465fd7ea721a4d, full decode passed. The pack image is an upscale, not native 1672×941 generation. Source prompts, exact request and receipts are retained under samples/quiet-anime-poetry/.

Rights: newly generated artwork commissioned by the owner through their configured service. This establishes origin and authorization; no exclusive copyright or independently verified training-data rights are claimed.

## Evidence

- schema: passed; coordinator shipContentPacks call exited 0, archive validator PASS (genstudio-store-receipt-v1), no forbidden marks. Receipt: _orchestra/app-closeout-20261021/quiet-anime-poetry-pack-20261022/build-result.json.
- coverage_uniqueness: source comparison passed against Anime Cel (vivid, expressive, dynamic), Watercolor Storybook (paper grain/washes) and Chinese Ink-Wash Storytelling (monochrome rice-paper brushwork); this contract adds restrained emotional metaphor and clean coloured anime environments.
- golden_prompt_parity: passed; isolated verification asserts exact style_bible/negative_prompt equality against style-direction.md and catalogue reload. Receipt: quiet-anime-poetry-pack-20261022/install-result.json.
- decoded_previews: passed, concrete decode/size/hash evidence in samples/quiet-anime-poetry/quiet-anime-poetry-preview-receipt.json.
- tests: passed isolated local import/catalogue/prompt parity/reload/preview hash check, actual exit 0 (install-result.json). First check attempt installed and loaded correctly but failed its hand-written preview path because publisher directory was omitted; corrected proof then passed. Full content-pack lane bh4ewvp7c actual child exit 0: 374 tests, 0 suites, 372 pass, 0 fail, 2 skip, 0 cancelled/todo; completion `content-packs suite coverage: 39/39 file(s) completed, 374 test(s) + 0 suite(s) = 374 marks`; retained filesystem complete. Permanent retained sandbox: retained-evidence-quiet-poetry-20261022/story-studio-content-packs-harness-6E3D94. This lane validates pack tooling/content contracts; it does not prove model quality or real project rendering.
- deterministic_build: passed; two byte-identical builds, validator PASS, 179,374 bytes, SHA-256 c6e226402f01644aa553a9e624a328be6a1d939bdf208ed05af1010ce362c2f7. No key_id/signature in archive. Temporary build trees preserved by retained filesystem adapter. Build source was dirty on base 46e43aa6; the shipper's source_commit names that base, not a claim the new pack was already committed.

independent_review: contract/schema/originality-provenance/compatibility/commercial-boundary review a324191 completed with no blocking findings. Its separate visual review passed: matching PNG/WebP composition, muted blue/teal palette, delicate contours, soft lighting and restrained posture; no obvious anatomy defects, text, logos, watermarks or grain/halftone effects. Painterly environmental texture remains, with subtle cel shading. Reference screenshots were unavailable to the reviewer, so similarity to them was not independently assessed; external copyright/training rights remain unverified. The first visual worker returned unrelated text and is not accepted as evidence.
blocked_by: []

## Delivery boundary

One portable .sspack, built with genstudio-store-receipt-v1 and min-app-version 1.0.843. The builder strips the authoring key_id placeholder. Released 347's local-import path accepts the keyless archive without purchase or entitlement. No second user-style JSON product is created. The ship helper builds/validates archives locally; it does not install into the owner's app or publish anything.
