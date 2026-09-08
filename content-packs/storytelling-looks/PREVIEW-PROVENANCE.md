# Chinese Ink-Wash Storytelling preview provenance

- Story item: `com.storystudio.style.chinese-ink-wash-storytelling`
- Declared pack asset: `assets/chinese-ink-wash-storytelling.webp`
- Generation source: GPT built-in image generation in Codex; no user API key or GenStudio credits used
- Source declaration: `reference_images: []`
- Inspection-only reference inventory: six owner-supplied screenshots were used to define and review the reusable visual language, but none was submitted to GPT image generation: `6b82467a5d84da89fe025827fe1a6a49d527f41fd29bdf5d99761cd958003666`, `abe3556c77660c127f7bb1f064ecff77562b3867383342f767b545031423af6c`, `ae01f11211f01e7eaa2f28250eb9d3bc77a91b47b5552b6f4a53a02811096819`, `b765bcc1b389384152d2d0dfe841f36ca9fa580f6a51286d46a28b59f8be84d5`, `6a2e3a715a607c70267e559b4167035692f7de4e396fdab5b9617ff2523e3a48`, and `537d59d3f5f8ce24ffa98fe130c3302d98e84743e2601c3ed4edf0c8183ca36c`
- Owner authority: explicit request on 2026-09-02 to use GPT image generation and proceed with generation, certification, repository integration, and sale
- Rights basis: newly generated original output for the owner's project under the built-in generation service terms; no third-party image bytes were submitted or embedded as references
- Original generated file: `<owner-home>/.codex/generated_images/019fe7d8-5d5a-7431-a655-8c9ea70710f3/exec-db1516aa-3f58-4925-beb1-74398210a935.png`
- Original SHA-256: `6b190decc6365e95b2b0d6b29c7f5dc5f918aa981e177693c48d80dae5d14f10`
- Original measurements: PNG, 1672x941, 2472858 bytes, RGB/sRGB, decode passed
- Transformation: deterministic whole-image WebP encoding with repository `sharp`, quality 92, effort 6, smart subsampling; no crop, resize, repaint, mask, composite, text replacement, or regional edit
- Final SHA-256: `b31459ec20c7e59c4907a04106b8c87b3f5e3cf8e39d91c4b2f94ed99a26e6e4`
- Final measurements: WebP, 1672x941, 315978 bytes, RGB/sRGB, WebP decode passed

## Generation prompt

```text
Use case: illustration-story
Asset type: final 16:9 preview card for the standalone Story Studio Visual Style product “Chinese Ink-Wash Storytelling”
Primary request: Create one completely original narrative landscape showing a small solitary ferryman standing in a slender wooden boat and guiding it through a quiet, mist-filled river valley. This must be a fresh composition, not a reproduction of any supplied reference.
Scene/backdrop: layered river, low mist, distant mountain silhouettes, a few sparse reeds or windswept trees, large areas of untouched warm ivory paper
Subject: one small anonymous ferryman and one boat, readable at card size, no recognizable historical or copyrighted character
Style/medium: traditional Chinese ink-wash painting on warm ivory xuan/rice paper; charcoal-black and gray ink; expressive variable-pressure calligraphic contours; pooled diluted washes; wet-on-wet blooms; broken dry-brush texture; soft feathered edges; restrained hatching; near-black value anchors; quiet literati stillness
Composition/framing: full-frame widescreen 16:9 landscape; elegant asymmetry; strong foreground, midground, and far-distance depth built through mist; generous active negative space; no border, mat, frame, letterbox, or pillarbox
Lighting/mood: diffuse misty light, contemplative, timeless, spacious, calm
Color palette: monochrome charcoal-black and layered gray ink on warm ivory paper only; no bright colors
Materials/textures: visible rice-paper fibers, authentic ink absorption, dry-brush breakup, soft bleed
Constraints: no reference images; exactly one original scene; no copied composition; no hand holding a coin; no bowed robed figure; no temple gate; no arrangement of vessels or books; no isolated mountain study; no scroll-and-brush still life
Avoid: any text, captions, calligraphy, letters, numbers, seals, chops, signatures, logos, watermarks, UI, player chrome, device bars, home indicator, border, frame, vignette, sepia-brown expedition-journal look, foxed parchment, lamplight, colored watercolor, storybook palette, pastel, gouache, oil paint, photorealism, glossy CGI, vector, cartoon, anime, infographic layout
Output intent: polished final production preview with no text and clean full-bleed edges; compose for deterministic resize/crop to exactly 1672×941 WebP without cutting the ferryman or boat.
```

## Visual certification

- Original narrative composition: passed
- Ferryman and boat remain legible at card size: passed
- Chinese ink-wash medium, active paper space, wet/dry brush variation, mist depth, and asymmetrical literati framing: passed
- No copied reference composition or excluded reference subject arrangement: passed
- No text, caption, calligraphy, seal/chop, signature, logo, watermark, border, player/device UI, letterbox, or pillarbox: passed
- No malformed or unsafe subject matter: passed

## Style preview backfill — 2026-09-08

The owner's rule of 2026-09-08 is three previews per Visual Style — the hero, a quiet wide scene with no figure in it, and the hardest case the style can legally be asked for. This collection's Visual Style shipped with one preview, so 2 new previews were rendered and the pack moved to a new `<slug>-v<version>` sibling directory, leaving the directory it shipped from in place. The existing hero bytes were copied into the new directory unchanged.

The full render record — run ids, job ids, prompt digests, the conversion applied and the review of every image — is in `content-packs/PREVIEW-BACKFILL-2026-09-08.md`. The rows below are this collection's accepted bytes.

| Style item | New pack version | Accepted asset | SHA-256 | Bytes | Dimensions | Decode |
| --- | --- | --- | --- | ---: | --- | --- |
| `com.storystudio.style.chinese-ink-wash-storytelling` | 1.0.1 | `content-packs/storytelling-looks/style/chinese-ink-wash-storytelling-v1.0.1/assets/chinese-ink-wash-storytelling-scene.webp` | `f911663ef70f173c3209d8f8314f3d123dd1cab97c37114d586c97f658ba57b1` | 197946 | 1672x941 | WebP decode passed |
| `com.storystudio.style.chinese-ink-wash-storytelling` | 1.0.1 | `content-packs/storytelling-looks/style/chinese-ink-wash-storytelling-v1.0.1/assets/chinese-ink-wash-storytelling-face.webp` | `05858bb33216e451452689d18575003fb2b380efc7457e4a89666d5827c7bca0` | 138234 | 1672x941 | WebP decode passed |

Each of these was rendered by GenStudio `gpt-image-2` through the Story Studio Image Pool in the `pack-previews` project, one variant, `16:9`, `2K`, `reference_images: []`, 29 credits each — 58 credits for this collection. Every file decodes as a 1672×941 WebP above the 20,480-byte floor and carries no text of any kind.
