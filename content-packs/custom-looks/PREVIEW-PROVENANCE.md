# Custom Looks — preview provenance

Fifteen Visual Styles adopted on 2026-10-25 from the owner's own channel art styles,
each with the owner's three-preview set: the hero (the Style Library card image), a
quiet wide scene with no figure, and the hardest legal case for the style.

## Where the styles came from

The owner's 21 channels carried 215 style presets and their two shared style packs
carried 27 more; deduplicated by their own text that is 34 distinct styles. A triage
against the 43 styles already in the Store adopted fifteen of them and mapped the rest
onto styles the Store already sells. The owner accepted the triage in full, then asked
for all fifteen rather than the nine first proposed, with the condition that each be
made visibly distinct from its nearest neighbour. The style text of each pack is the
owner's own description, expanded into a render-ready contract: no new aesthetic was
invented, and no channel, project or preset was changed, migrated or removed.

## How the previews were made

Model: `studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4`, discovered live
from the Gateway catalogue before **every** request. The published 16:9 1K option is
1280x720. The price read at each request was `credits_per_image: 0`,
`minimum_credits: 0`, `chargeable: false` — the local fleet lane, no paid provider, and
no other model was used. Route: `POST /v1/images/generations`, then
`GET /v1/images/<job>/file`, on the local Gateway, one request in flight at a time,
waiting whenever another `mflux-generate` process was running on this Mac.
Every request carried a unique Idempotency-Key derived from the style, the variant, the
seed and the prompt text, and an explicit seed. The 45 seeds are all distinct: **yes**.
Credentials were read into memory from the Gateway's own configuration and were never
printed, logged, written into a receipt or passed as an argument.

Each final preview is a whole-image conversion of the 1280x720 PNG original: resize
cover to 1672x941 with Lanczos3, then WebP quality 90 effort 6 — the same media
contract `content-packs/illustrated-history/prepare-previews.mjs` uses. Every encode was
run twice and the pair proved byte-identical. No crop, mask, retouch, lettering, overlay
or compositing was applied; the integer aspect target drops at most one pixel column
instead of re-cropping the composition. The 1656x931 native size of a 16:9 render means
the 1672x941 preview is an upscale, not a claim of native 1672x941 generation.

### Refused renders

Every refused render was moved, with its original request and receipt, into
`_trash/content-pack-previews-20261026/` and never rewritten. A retry always kept the
same medium contract and changed the specific fault.

- **carved-woodcut-print — scene** (2026-10-26T00:23:32): Refused on visual review: the render left the relief-print medium and became a smooth tonal painting, and a small distant figure stands on the far sandbar in a slot that must be figure-free.
  - medium drift: smooth tonal gradient sky, no carved line, no flat ink masses
  - a distant figure is visible on the sandbar (figure-free slot violated)
- **carved-woodcut-print — scene** (2026-10-26T00:36:37): Refused on second review: still not a relief print. The lead line and the contract were both present in the prompt, so the fault is the subject — a smooth wooden boat on wet sand pulls the model to photography whatever the prompt says.
  - medium drift: photographic boat and a smooth gradient sky
  - no carved line anywhere in the frame
  - the subject itself invites realism; the brief is the thing that has to change
- **dark-moody-painterly — hero** (2026-10-26T01:13:29): Refused on review (hero): reads as a dark photograph of a real room rather than an oil painting; the style forbids photographic surfaces and the render shows photographic materials and paper.
  - photographic surface: real wood, real paper, real glass
  - no visible brushwork or paint texture in the shadows
  - the still-life and interior subjects invite a camera more than a brush
- **dark-moody-painterly — scene** (2026-10-26T01:13:29): Refused on review (scene): reads as a dark photograph of a real room rather than an oil painting; the style forbids photographic surfaces and the render shows photographic materials and paper.
  - photographic surface: real wood, real paper, real glass
  - no visible brushwork or paint texture in the shadows
  - the still-life and interior subjects invite a camera more than a brush
- **dark-moody-painterly — hardest** (2026-10-26T01:13:29): Refused on review (hardest): reads as a dark photograph of a real room rather than an oil painting; the style forbids photographic surfaces and the render shows photographic materials and paper.
  - photographic surface: real wood, real paper, real glass
  - no visible brushwork or paint texture in the shadows
  - the still-life and interior subjects invite a camera more than a brush

## Rights and originality

Newly generated artwork, commissioned by the owner and produced through the owner's own
local fleet. No reference image was submitted, no creator or channel identity was used,
and no copied composition is claimed. This records origin and authorisation; it does not
claim exclusive copyright or independent verification of model-training rights. Every
image was reviewed by eye before acceptance, and each was checked for lettering,
watermarks and unwanted figures.

## The 45 final assets

| Asset | SHA-256 | Bytes | Dimensions | Decode |
|---|---|---:|---|---|
| `content-packs/custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print.webp` | `d5d8287207ed862a92a9c4438d1400145b144299e519b6bfc128b08d0dde16c0` | 379072 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print-scene.webp` | `b3b6db370835ac84eea3e90391e07b55b1761f45658283d3a06be84a04308a7a` | 235596 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print-hardest.webp` | `13d94d8ff8464a81a6f2742ec8e6ee6f9b088f0aaec6942fe62ac34a20198fa0` | 525510 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery.webp` | `3f00b2c9ca62d101961cee7444a350c8ff93a9b2fdc08ac58d3c13a6ab152634` | 207626 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery-scene.webp` | `0bc1065d1291f06403115dec429e21c82fd84e42e9d10d841cf0870738c036e4` | 191464 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery-hardest.webp` | `6c230f472784bc23e02f71ed0fffb9fac4aa5a5d99a8cb11f99e76fd2fdcdf5d` | 227012 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly.webp` | `abfe5cf6607e79c203ca23aea8ca93e2d947fc9c9e8f732b279bf50253ef792c` | 78692 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly-scene.webp` | `403877b380a02a903e10fbe306afbd52120340add1d22521fe64497644d46de9` | 73998 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly-hardest.webp` | `68ac8c941b26f996da76742d0f7c875a79d5700295664e1addd8311a360ddcba` | 78440 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving.webp` | `0a3eb402dc2ae4ad1d77d212e80f8c06e74a0cc226b229526382c104c5e4fd1f` | 207200 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving-scene.webp` | `ddba3273f72624e43c5392380b98b25bd84b1508f245ea1f6ab14746f2282e22` | 381706 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving-hardest.webp` | `988dd80c693ad4380f2d03268c350553222e59904da75ede7baf34047066e7c1` | 401766 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration.webp` | `856a049bc13840fde168bbe7ee4f59b37c7858bf49ee36aea57f652238dba435` | 142232 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration-scene.webp` | `309902f980585aef5dffdd64a2b53f82bce3747d066ff39c9c2e5ed94ec9a7a4` | 177738 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration-hardest.webp` | `6d5f92630098b3a194018cc5e84033fe535ad16215fe7ac4fffd252f5f4fb38e` | 139822 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon.webp` | `f881698dc6e7931b97b666bc5be36ffbad3b8604b015c6c3047e431abf34fb22` | 203650 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon-scene.webp` | `39f9393d6a0a37ab0d62c25a22dd99b4472a8ce29a9f1a6a545828f94504402a` | 245450 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon-hardest.webp` | `4aab69ede9fe630aa3edadb455e699710a39010e372c31586ace8d5119150551` | 347826 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic.webp` | `0143e856089ae71feb62c2bf45d001a119a211a4cd6bfe31ae5885c17e79785a` | 83352 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic-scene.webp` | `0adf2e299ae0c3abab11073d9391ae5339f71a6bbb2830370c5b66c5e87c908c` | 65418 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic-hardest.webp` | `2349e62abb2a81d564f9834d70480232a66cd4b5bcf95e9f45637dc7d50ece4a` | 110330 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache.webp` | `5b7cde7869ba6adf6a5cfabaf58cbabda2f5d0e6a2863830eabacd15e1e0f7ef` | 71138 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache-scene.webp` | `f5205b4fcad35a5f39cc8a5984056b885a96b495b4c9cfcea286681a76629af2` | 98400 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache-hardest.webp` | `01e614db0bf9343686a1e503e52ad3a028a7cfb5e5a4df50803330e1d8346277` | 97116 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration.webp` | `4006ae3971f9ea13f2651f612e84253a37d9d28c8a0097fc595677dbd95f1a95` | 192384 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration-scene.webp` | `1f2f448e4be2ee7a8e36d9cb7d7f6a1868b28250c2f98fe113bbd793ca341f41` | 146856 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration-hardest.webp` | `80fa3712a7a48067a8c3a9140df6f8f6309a4939da7c10ee5b979f95ccdd839b` | 289474 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration.webp` | `09ace08a48e391afe9a892cb80455e26cf5cd56f326ac269c6bf47b3e417341d` | 96932 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration-scene.webp` | `96a1ccf6ec6ce1d6a030d4c08fb853e304fbbbe34c4693e741f805c31500d0db` | 67320 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration-hardest.webp` | `d8cbe9ec6bc8d79e6e53d2455006ad6e52a82fc56d1cd022410a63274d2eb87d` | 94674 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/museum-diorama/assets/museum-diorama.webp` | `9ee5bddf6080e86d8110a81145d3081a2d50facb4a3c918f6e6d3786a8ea93c0` | 245032 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/museum-diorama/assets/museum-diorama-scene.webp` | `12f6def4961ee02a919ecd4992244e763e9f4ebac92945c372ef702b905a7147` | 205064 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/museum-diorama/assets/museum-diorama-hardest.webp` | `2896c28d8fb81e5634a039ba2b834661e8d06b7e15927c77b8ee9958064cb420` | 194512 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art.webp` | `0170f5d1d158d49d015ce15e796bda6ddc14cdf1262c3a740a45f22e439e2aa1` | 44080 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art-scene.webp` | `484a9d9d09714133a42d944d61ee0621ecdb5fb636e4dfbcae30a9e7d17522c3` | 43204 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art-hardest.webp` | `0d1cd55e3c92f94d560accd117525aae44dc430e0515726fb7ba4bdf2c16d8d1` | 34056 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook.webp` | `c245d53e3f4e7ad056ed941ff725a5a0bece68cefc5e38dd6c105807f6082b42` | 135246 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook-scene.webp` | `dc2d83dbc6119800b822e3cb64ece6fb59522b8ab69718845b1352d128f4bd7a` | 288458 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook-hardest.webp` | `901d923b317cd653b60b6b8c21b4f16550feabb5057e7886e5036d76237cabb6` | 261138 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate.webp` | `70afe8c1c072fcabfd6bb624a7f2ad89ed8f4487061d23e42ba7da27428964c6` | 165092 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate-scene.webp` | `09cf19ab3502cc00bb0358cfd5f151e8c7bbeecde3ce5c7b0bc7b1244289d3c4` | 93088 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate-hardest.webp` | `1acbf4a419a97cc2ac170d6294c3bd6d8acb619479b4e008fc29d82001e82c53` | 231834 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life.webp` | `3200658fc237cc8d701cbd9397a4a15f1d5c550104cfe959a258968ed0f3d797` | 247162 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life-scene.webp` | `c7c3a70147c784a58ad71b9324370040c981c683a4da616270951bd9daf99684` | 255624 | 1672x941 | full decode passed |
| `content-packs/custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life-hardest.webp` | `db86f08127eaabaac51d07281a70d61fe913b2375f44a93ef8e22b3837132a91` | 272096 | 1672x941 | full decode passed |

## Per-preview record

Each block records the accepted Gateway job, the seed and idempotency key it was
requested under, the original PNG it produced, and the exact prompt submitted. The
Gateway Hub image adapter does not pass a separate negative-prompt field, so the style
contract and the exclusions travel inside the prompt text, exactly as recorded here.

### carved-woodcut-print — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `dab5c410-35a5-4a66-adb0-8fdf30454642` (final state `succeeded`)
- Seed: `10260101` · Idempotency-Key: `style-preview-20261026-carved-woodcut-print-hero-ada04d8da1f72fb37c6f7185`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1734420 bytes, SHA-256 `934dd84ec1fe6a62bfdea3c45ea55fe63e86d6f9e8e4d3036a1d9d8f9ccefca8`
- Final: `custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print.webp`, 1672x941 WebP, 379072 bytes, SHA-256 `d5d8287207ed862a92a9c4438d1400145b144299e519b6bfc128b08d0dde16c0`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A steep-roofed mountain village at dusk seen from across a valley: stacked timber houses with a few small lit windows, a winding path climbing between them, bare trees along a ridge, and a pale sky mass left as bare paper.

Rendering contract: A relief print pulled by hand from a carved block, in the register of a woodcut or linocut rather than a drawing or a painting. Medium and surface: two or three muted inks only, printed on warm off-white handmade paper whose faint grain and slight fibre texture show through the lighter areas. Every mark in the picture is a mark the gouge made: cuts are confident, of visibly varying width, and they either hold ink or do not. There is no wash, no pencil, no brush and no airbrush anywhere in the frame. Line and mass: shapes are built as solid flats of ink surrounded by carved negative space, with the paper itself supplying the light. Shading is carved, not painted — parallel cut marks and hatching that follow the form, opening into wider cuts where a surface turns into the light and closing into narrow hard lines where it turns away — plus small stippled or nicked passages for texture on stone, water and foliage. Contours carry a carved wobble: a cut edge is never a smooth machine curve. Palette: deep indigo-black as the key colour, warm ochre as the mid, and soft slate grey as the third, in two or three inks in total, with the paper's own warmth standing in for white. Ink coverage is that of a hand-pulled print — slightly uneven, thinner where the block was cut shallow, with occasional small skips and a fine bead of ink at some edges, never a perfect digital flat. Lighting: graphic light only, expressed as flat shapes and carved highlights rather than as gradients — a quiet dusk, a lamplit evening, a pale sky mass left as bare paper. No glow, no bloom, no soft modelling. Composition: calm, balanced and uncluttered, with clear silhouettes and generous negative space, and a clean rectangular image that fills the frame edge to edge. Keep the contract content-independent: no fixed subject, place, era, symbol or copied composition, and no stamp marks, corner seals, printed borders or frames.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, smooth digital gradient, airbrush, soft shading, glow, bloom, watercolour wash, ink wash, oil paint, visible brush strokes, pencil, charcoal sketch, canvas texture, paper photograph, halftone dot, fine engraving cross-hatch, digital flat vector, cel shading, anime, cartoon mascot, chibi, saturated neon, rainbow palette, more than three inks, gradient sky, blurred depth of field, bokeh, stamp mark, corner seal, printed border, frame, margin, lettering, caption, signature, watermark, logo, copied reference composition
```

</details>

### carved-woodcut-print — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `23ea002b-1756-4a68-970c-6cc0b95de14a` (final state `succeeded`)
- Seed: `10260102` · Idempotency-Key: `style-preview-20261026-carved-woodcut-print-scene-5e61587e2f75d1dbe4eeea1c`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1501379 bytes, SHA-256 `b2dff95990baabc7973994f3064d5ed46d7735d988fabcdb2f0b17f461549bcc`
- Final: `custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print-scene.webp`, 1672x941 WebP, 235596 bytes, SHA-256 `b3b6db370835ac84eea3e90391e07b55b1761f45658283d3a06be84a04308a7a`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PULLED WOODCUT PRINT in two or three flat inks on off-white handmade paper: carved gouged lines and solid ink masses, not painted and not photographed.

An empty stone pier seen side-on at dusk: heavy squared masonry blocks stacked in visible courses, three iron mooring rings set into the stone, a folded tarpaulin and a coil of rope on the paving, and a pale sky left as one bare carved mass. The sea appears only as three or four flat horizontal ink bands beyond the pier head. No person, no animal, no boat, and nothing smooth or photographic anywhere.

Rendering contract: A relief print pulled by hand from a carved block, in the register of a woodcut or linocut rather than a drawing or a painting. Medium and surface: two or three muted inks only, printed on warm off-white handmade paper whose faint grain and slight fibre texture show through the lighter areas. Every mark in the picture is a mark the gouge made: cuts are confident, of visibly varying width, and they either hold ink or do not. There is no wash, no pencil, no brush and no airbrush anywhere in the frame. Line and mass: shapes are built as solid flats of ink surrounded by carved negative space, with the paper itself supplying the light. Shading is carved, not painted — parallel cut marks and hatching that follow the form, opening into wider cuts where a surface turns into the light and closing into narrow hard lines where it turns away — plus small stippled or nicked passages for texture on stone, water and foliage. Contours carry a carved wobble: a cut edge is never a smooth machine curve. Palette: deep indigo-black as the key colour, warm ochre as the mid, and soft slate grey as the third, in two or three inks in total, with the paper's own warmth standing in for white. Ink coverage is that of a hand-pulled print — slightly uneven, thinner where the block was cut shallow, with occasional small skips and a fine bead of ink at some edges, never a perfect digital flat. Lighting: graphic light only, expressed as flat shapes and carved highlights rather than as gradients — a quiet dusk, a lamplit evening, a pale sky mass left as bare paper. No glow, no bloom, no soft modelling. Composition: calm, balanced and uncluttered, with clear silhouettes and generous negative space, and a clean rectangular image that fills the frame edge to edge. Keep the contract content-independent: no fixed subject, place, era, symbol or copied composition, and no stamp marks, corner seals, printed borders or frames.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, smooth digital gradient, airbrush, soft shading, glow, bloom, watercolour wash, ink wash, oil paint, visible brush strokes, pencil, charcoal sketch, canvas texture, paper photograph, halftone dot, fine engraving cross-hatch, digital flat vector, cel shading, anime, cartoon mascot, chibi, saturated neon, rainbow palette, more than three inks, gradient sky, blurred depth of field, bokeh, stamp mark, corner seal, printed border, frame, margin, lettering, caption, signature, watermark, logo, copied reference composition
```

</details>

### carved-woodcut-print — hardest

- Variant: the hardest legal case for the style
- Gateway job: `95349179-a8a9-4961-8a0c-04bdf3cb7b78` (final state `succeeded`)
- Seed: `10260103` · Idempotency-Key: `style-preview-20261026-carved-woodcut-print-hardest-1b1bf077a1af35fcd98d95f4`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1935267 bytes, SHA-256 `db782c88a1fae58ecbd2f343876cfc116a51a489f191ab1897a7d6e18a20e969`
- Final: `custom-looks/style/carved-woodcut-print/assets/carved-woodcut-print-hardest.webp`, 1672x941 WebP, 525510 bytes, SHA-256 `13d94d8ff8464a81a6f2742ec8e6ee6f9b088f0aaec6942fe62ac34a20198fa0`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A dense pine wood cut through by a shallow stream: layered masses of needles and trunks, moving water with reflected light, wet stones and reeds, all described with carved parallel cuts, hatching and stipple instead of any wash. No figures anywhere.

Rendering contract: A relief print pulled by hand from a carved block, in the register of a woodcut or linocut rather than a drawing or a painting. Medium and surface: two or three muted inks only, printed on warm off-white handmade paper whose faint grain and slight fibre texture show through the lighter areas. Every mark in the picture is a mark the gouge made: cuts are confident, of visibly varying width, and they either hold ink or do not. There is no wash, no pencil, no brush and no airbrush anywhere in the frame. Line and mass: shapes are built as solid flats of ink surrounded by carved negative space, with the paper itself supplying the light. Shading is carved, not painted — parallel cut marks and hatching that follow the form, opening into wider cuts where a surface turns into the light and closing into narrow hard lines where it turns away — plus small stippled or nicked passages for texture on stone, water and foliage. Contours carry a carved wobble: a cut edge is never a smooth machine curve. Palette: deep indigo-black as the key colour, warm ochre as the mid, and soft slate grey as the third, in two or three inks in total, with the paper's own warmth standing in for white. Ink coverage is that of a hand-pulled print — slightly uneven, thinner where the block was cut shallow, with occasional small skips and a fine bead of ink at some edges, never a perfect digital flat. Lighting: graphic light only, expressed as flat shapes and carved highlights rather than as gradients — a quiet dusk, a lamplit evening, a pale sky mass left as bare paper. No glow, no bloom, no soft modelling. Composition: calm, balanced and uncluttered, with clear silhouettes and generous negative space, and a clean rectangular image that fills the frame edge to edge. Keep the contract content-independent: no fixed subject, place, era, symbol or copied composition, and no stamp marks, corner seals, printed borders or frames.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, smooth digital gradient, airbrush, soft shading, glow, bloom, watercolour wash, ink wash, oil paint, visible brush strokes, pencil, charcoal sketch, canvas texture, paper photograph, halftone dot, fine engraving cross-hatch, digital flat vector, cel shading, anime, cartoon mascot, chibi, saturated neon, rainbow palette, more than three inks, gradient sky, blurred depth of field, bokeh, stamp mark, corner seal, printed border, frame, margin, lettering, caption, signature, watermark, logo, copied reference composition
```

</details>

### lush-painterly-scenery — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `4e7706e2-2474-434f-a032-fca7083fd73d` (final state `succeeded`)
- Seed: `10260201` · Idempotency-Key: `style-preview-20261026-lush-painterly-scenery-hero-b99a2c8f867ccf3bae8cf215`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1496387 bytes, SHA-256 `7bd2df0413688b1bd0f65ad6c9c8331a994a32899b5481e836d05cc4c99a2ef9`
- Final: `custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery.webp`, 1672x941 WebP, 207626 bytes, SHA-256 `3f00b2c9ca62d101961cee7444a350c8ff93a9b2fdc08ac58d3c13a6ab152634`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED ANIMATION BACKGROUND in visible brush, every surface reading as paint rather than a photograph.

A terraced hillside at golden hour, with olive and cypress trees on stone retaining walls, and a shallow valley falling away to a hazy plain beyond.

Rendering contract: Hand-painted landscape scenery, made the way a painted animation background is made: rich, fully furnished places painted in visible brush, with no photographic surface anywhere. Medium and surface: opaque and translucent paint layered over one another — broad translucent washes for sky, water and haze, then smaller opaque strokes for foliage clusters, stone, cloth and timber — with brush texture staying visible in the near ground and simplifying as it recedes. No canvas weave, no impasto ridge, no craquelure, no paper tooth: this is a clean painted panel, not an oil sketch. Palette: rich natural greens and mossy olives held together with warm earth browns and soft sky blues, harmonised and gently desaturated so the picture stays comfortable to watch at night. Golden hour warms the greens toward honey and amber; blue hour cools them toward slate and teal. A single scene sits at one end of that range and never mixes the two lights. Lighting: one soft cinematic source with atmosphere — a low sun casting long gentle light through glowing haze, or a cool evening sky with a rim of warm light along the horizon. Light pools on the planes and falls off into the distance, and distance is dissolved by painted haze rather than by blur. Composition: calm, wide scenic views with a legible foreground, middle distance and background, built from overlapping painted shapes with simplified distant edges, and breathing room across the top of the frame. The place is the subject; anything in it stays small and secondary. Keep the contract content-independent: no fixed landmark, region, era, building or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, lens flare, depth of field blur, bokeh, HDR, oversharpened, canvas weave, craquelure, heavy impasto ridge, torn paper, distressed texture, grunge, neon, oversaturated, black ink contour, comic outline, flat vector, cel shading, hard shadow step, anime, cartoon mascot, chibi, single centred subject on an empty ground, minimal blank landscape, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### lush-painterly-scenery — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `7c894295-37cd-4432-9dae-b1fb27650286` (final state `succeeded`)
- Seed: `10260202` · Idempotency-Key: `style-preview-20261026-lush-painterly-scenery-scene-788a55bc08903b39179e4bd4`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1411136 bytes, SHA-256 `2ca2cde2271f2ab2248f3e7fd6cf823311bef686e2b904cb44a7a1f9d578b8cd`
- Final: `custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery-scene.webp`, 1672x941 WebP, 191464 bytes, SHA-256 `0bc1065d1291f06403115dec429e21c82fd84e42e9d10d841cf0870738c036e4`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED ANIMATION BACKGROUND in visible brush, every surface reading as paint rather than a photograph.

A wide river bend at blue hour: reeds along the near bank, a pale sandbar midstream, wooded hills receding in soft layers, and open evening sky. Nothing living is in the frame.

Rendering contract: Hand-painted landscape scenery, made the way a painted animation background is made: rich, fully furnished places painted in visible brush, with no photographic surface anywhere. Medium and surface: opaque and translucent paint layered over one another — broad translucent washes for sky, water and haze, then smaller opaque strokes for foliage clusters, stone, cloth and timber — with brush texture staying visible in the near ground and simplifying as it recedes. No canvas weave, no impasto ridge, no craquelure, no paper tooth: this is a clean painted panel, not an oil sketch. Palette: rich natural greens and mossy olives held together with warm earth browns and soft sky blues, harmonised and gently desaturated so the picture stays comfortable to watch at night. Golden hour warms the greens toward honey and amber; blue hour cools them toward slate and teal. A single scene sits at one end of that range and never mixes the two lights. Lighting: one soft cinematic source with atmosphere — a low sun casting long gentle light through glowing haze, or a cool evening sky with a rim of warm light along the horizon. Light pools on the planes and falls off into the distance, and distance is dissolved by painted haze rather than by blur. Composition: calm, wide scenic views with a legible foreground, middle distance and background, built from overlapping painted shapes with simplified distant edges, and breathing room across the top of the frame. The place is the subject; anything in it stays small and secondary. Keep the contract content-independent: no fixed landmark, region, era, building or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, lens flare, depth of field blur, bokeh, HDR, oversharpened, canvas weave, craquelure, heavy impasto ridge, torn paper, distressed texture, grunge, neon, oversaturated, black ink contour, comic outline, flat vector, cel shading, hard shadow step, anime, cartoon mascot, chibi, single centred subject on an empty ground, minimal blank landscape, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### lush-painterly-scenery — hardest

- Variant: the hardest legal case for the style
- Gateway job: `d826e3ea-2aaf-41a2-8011-f8d83f3d278f` (final state `succeeded`)
- Seed: `10260203` · Idempotency-Key: `style-preview-20261026-lush-painterly-scenery-hardest-22b4eacac1a547733ff22eea`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1558983 bytes, SHA-256 `a2160b151ed3765c1fde9f0e9c7fcd78c18c4ea0c30bb6d0c6b8918f047f5fa9`
- Final: `custom-looks/style/lush-painterly-scenery/assets/lush-painterly-scenery-hardest.webp`, 1672x941 WebP, 227012 bytes, SHA-256 `6c230f472784bc23e02f71ed0fffb9fac4aa5a5d99a8cb11f99e76fd2fdcdf5d`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED ANIMATION BACKGROUND in visible brush, every surface reading as paint rather than a photograph.

A dense forest clearing under a closed canopy: layered foliage, hanging vines, leaf litter, wet rock and dappled light falling on the ground, keeping every surface as visible paint rather than photographic texture.

Rendering contract: Hand-painted landscape scenery, made the way a painted animation background is made: rich, fully furnished places painted in visible brush, with no photographic surface anywhere. Medium and surface: opaque and translucent paint layered over one another — broad translucent washes for sky, water and haze, then smaller opaque strokes for foliage clusters, stone, cloth and timber — with brush texture staying visible in the near ground and simplifying as it recedes. No canvas weave, no impasto ridge, no craquelure, no paper tooth: this is a clean painted panel, not an oil sketch. Palette: rich natural greens and mossy olives held together with warm earth browns and soft sky blues, harmonised and gently desaturated so the picture stays comfortable to watch at night. Golden hour warms the greens toward honey and amber; blue hour cools them toward slate and teal. A single scene sits at one end of that range and never mixes the two lights. Lighting: one soft cinematic source with atmosphere — a low sun casting long gentle light through glowing haze, or a cool evening sky with a rim of warm light along the horizon. Light pools on the planes and falls off into the distance, and distance is dissolved by painted haze rather than by blur. Composition: calm, wide scenic views with a legible foreground, middle distance and background, built from overlapping painted shapes with simplified distant edges, and breathing room across the top of the frame. The place is the subject; anything in it stays small and secondary. Keep the contract content-independent: no fixed landmark, region, era, building or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, lens flare, depth of field blur, bokeh, HDR, oversharpened, canvas weave, craquelure, heavy impasto ridge, torn paper, distressed texture, grunge, neon, oversaturated, black ink contour, comic outline, flat vector, cel shading, hard shadow step, anime, cartoon mascot, chibi, single centred subject on an empty ground, minimal blank landscape, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### dark-moody-painterly — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `ce9ebdd5-2f51-47cc-bb2c-5e68349137bc` (final state `succeeded`)
- Seed: `10260301` · Idempotency-Key: `style-preview-20261026-dark-moody-painterly-hero-7faae7938428739a98279898`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1185116 bytes, SHA-256 `ba62ea56cec6d90b09926422f512a832b2886cefd8000baf10c1115f6fa8ab17`
- Final: `custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly.webp`, 1672x941 WebP, 78692 bytes, SHA-256 `abfe5cf6607e79c203ca23aea8ca93e2d947fc9c9e8f732b279bf50253ef792c`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED OIL ILLUSTRATION: dry scumbled brushwork visible in every area of the picture, matte oil paint on canvas, no photographic surface, no camera and no realistic material rendering.

A windswept moor at dusk under a heavy low sky, a single bare tree bent by the wind, standing water in the peat reflecting the last pale light, and a distant ridge dissolving into shadow.

Rendering contract: A dark, low-key painterly illustration worked in oil rather than rendered by a camera. Medium and surface: shadowy oil-paint texture throughout — thin scumbled darks that let a fine paint tooth show, softer blended passages where the light falls, and a little loaded paint only on the planes the light actually strikes. Edges stay soft in the shadow and firm where the single light meets a form. Nothing in the frame is glossy, plastic or photographic. Palette: desaturated charcoal, cold slate and warm umber, held close together in value, with exactly one restrained accent colour allowed to carry the eye — a dull crimson, a dim amber. There is no second accent and no saturated fill anywhere in the picture. Lighting: deep low-key light with soft pools of shadow. One source inside the frame, falling off quickly into darkness, so that a large part of the picture sits in the shadow range — but the midtones are kept open enough that silhouettes, hands and faces still read at small size instead of crushing to black. Composition: calm and quiet, with a strong focal subject, layered depth, and generous dark negative space around it and no clutter competing for the eye. The unease comes from what the darkness withholds, never from violence: nothing in the frame is wounded, bloody, monstrous or cruel. Keep the contract content-independent: no fixed subject, place, era, recurring motif or copied composition; the light and the restraint carry the style.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, high-key, bright even lighting, white background, flat lighting, airbrush, smooth digital gradient, neon, saturated colour, rainbow palette, candy colour, two competing accent colours, gore, blood, wounds, viscera, horror monster, corpse, skull pile, suffering, torture, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### dark-moody-painterly — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `a335fdfa-df71-4fc8-bf29-ecedfd1ea79e` (final state `succeeded`)
- Seed: `10260302` · Idempotency-Key: `style-preview-20261026-dark-moody-painterly-scene-7e115693e2521ca259c54d3a`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1155728 bytes, SHA-256 `2e28e0d474916f1a30a0a2be911593efe5a9a9df60f248221817fd2ab090367a`
- Final: `custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly-scene.webp`, 1672x941 WebP, 73998 bytes, SHA-256 `403877b380a02a903e10fbe306afbd52120340add1d22521fe64497644d46de9`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED OIL ILLUSTRATION: dry scumbled brushwork visible in every area of the picture, matte oil paint on canvas, no photographic surface, no camera and no realistic material rendering.

An empty stone bridge over a slow dark river at dusk, wet coping stones, bare willows along the far bank and a low bank of cloud above. No figure, no boat, no animal anywhere in the frame.

Rendering contract: A dark, low-key painterly illustration worked in oil rather than rendered by a camera. Medium and surface: shadowy oil-paint texture throughout — thin scumbled darks that let a fine paint tooth show, softer blended passages where the light falls, and a little loaded paint only on the planes the light actually strikes. Edges stay soft in the shadow and firm where the single light meets a form. Nothing in the frame is glossy, plastic or photographic. Palette: desaturated charcoal, cold slate and warm umber, held close together in value, with exactly one restrained accent colour allowed to carry the eye — a dull crimson, a dim amber. There is no second accent and no saturated fill anywhere in the picture. Lighting: deep low-key light with soft pools of shadow. One source inside the frame, falling off quickly into darkness, so that a large part of the picture sits in the shadow range — but the midtones are kept open enough that silhouettes, hands and faces still read at small size instead of crushing to black. Composition: calm and quiet, with a strong focal subject, layered depth, and generous dark negative space around it and no clutter competing for the eye. The unease comes from what the darkness withholds, never from violence: nothing in the frame is wounded, bloody, monstrous or cruel. Keep the contract content-independent: no fixed subject, place, era, recurring motif or copied composition; the light and the restraint carry the style.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, high-key, bright even lighting, white background, flat lighting, airbrush, smooth digital gradient, neon, saturated colour, rainbow palette, candy colour, two competing accent colours, gore, blood, wounds, viscera, horror monster, corpse, skull pile, suffering, torture, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### dark-moody-painterly — hardest

- Variant: the hardest legal case for the style
- Gateway job: `127f8f3b-4fa3-4996-92ba-94512a374117` (final state `succeeded`)
- Seed: `10260303` · Idempotency-Key: `style-preview-20261026-dark-moody-painterly-hardest-a1c8fae194beab9693bf2d60`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1163320 bytes, SHA-256 `be1cef0863782c07a8034a144628242693457e476ef3116fe9a4d2a6609534b4`
- Final: `custom-looks/style/dark-moody-painterly/assets/dark-moody-painterly-hardest.webp`, 1672x941 WebP, 78440 bytes, SHA-256 `68ac8c941b26f996da76742d0f7c875a79d5700295664e1addd8311a360ddcba`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED OIL ILLUSTRATION: dry scumbled brushwork visible in every area of the picture, matte oil paint on canvas, no photographic surface, no camera and no realistic material rendering.

A dark interior seen through a doorway: a tall mullioned window letting in dim rain light, a heavy draped cloth thrown over a wooden chest, and deep shadow filling the corners — every surface visibly brushed, with paint texture standing where photographic detail would be, and the midtones left open enough to read the cloth and the window frame.

Rendering contract: A dark, low-key painterly illustration worked in oil rather than rendered by a camera. Medium and surface: shadowy oil-paint texture throughout — thin scumbled darks that let a fine paint tooth show, softer blended passages where the light falls, and a little loaded paint only on the planes the light actually strikes. Edges stay soft in the shadow and firm where the single light meets a form. Nothing in the frame is glossy, plastic or photographic. Palette: desaturated charcoal, cold slate and warm umber, held close together in value, with exactly one restrained accent colour allowed to carry the eye — a dull crimson, a dim amber. There is no second accent and no saturated fill anywhere in the picture. Lighting: deep low-key light with soft pools of shadow. One source inside the frame, falling off quickly into darkness, so that a large part of the picture sits in the shadow range — but the midtones are kept open enough that silhouettes, hands and faces still read at small size instead of crushing to black. Composition: calm and quiet, with a strong focal subject, layered depth, and generous dark negative space around it and no clutter competing for the eye. The unease comes from what the darkness withholds, never from violence: nothing in the frame is wounded, bloody, monstrous or cruel. Keep the contract content-independent: no fixed subject, place, era, recurring motif or copied composition; the light and the restraint carry the style.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, high-key, bright even lighting, white background, flat lighting, airbrush, smooth digital gradient, neon, saturated colour, rainbow palette, candy colour, two competing accent colours, gore, blood, wounds, viscera, horror monster, corpse, skull pile, suffering, torture, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### vintage-copperplate-engraving — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `1ff276ab-a94c-42f9-ad7e-fef3e8e81b4a` (final state `succeeded`)
- Seed: `10260401` · Idempotency-Key: `style-preview-20261026-vintage-copperplate-engraving-hero-05f17d55d9e55d9a27906838`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1456453 bytes, SHA-256 `b190176f604b5e19255a000014199e91b2f11a56824eb34f1ceaf1223c568927`
- Final: `custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving.webp`, 1672x941 WebP, 207200 bytes, SHA-256 `0a3eb402dc2ae4ad1d77d212e80f8c06e74a0cc226b229526382c104c5e4fd1f`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A NINETEENTH-CENTURY COPPERPLATE ENGRAVING built entirely from fine cut line and stipple on aged cream paper.

An astronomical instrument on a draped table beside a folded chart and a small brass globe, lit softly from one side, with the whole picture built from line alone.

Rendering contract: An antique intaglio plate reproduced on paper, in the manner of a nineteenth-century copperplate engraving as it appeared in a journal or a learned volume. Medium and surface: the whole picture is built from line — fine, even, closely spaced cut lines that swell and taper with the form, crossed into a lattice where a tone deepens, and resolved into stipple where a surface needs grain rather than direction. There is no brush rendering, no wash modelling and no photographic texture anywhere. Colour: restrained two-tone ink — a warm black-brown key printed over aged cream paper — plus a single muted deep-green wash laid flat and a little unevenly behind the light passages, the way a plate was hand-coloured. The palette never extends beyond those two inks and the paper. Tone: value comes from line density alone. A half tone is one hatching layer, a deep tone is a second crossing layer, and only the darkest recesses take a third; the brightest highlights are bare paper. Light is clear and calm rather than theatrical, bright enough to keep every form legible. Ornament: the fine decorative rules, cartouches and plate numbers of the period are deliberately absent — no caption block, no plate number, no ruled margin. One clear central subject carries the picture in a calm, authoritative arrangement with room around it. Aged paper: a light, even foxing tone and a faint plate-mark impression are welcome; a torn, burnt or heavily stained sheet is not. Keep the contract content-independent: no fixed subject, place, era, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, oil paint, watercolour, gouache, visible brush strokes, airbrush, soft shading, smooth gradient, glow, bloom, colour photograph of paper, halftone photo, saturated colour, neon, cartoon, anime, cel shading, flat vector, thick outline, chalk, crayon, marker, plate number, caption block, ruled margin, cartouche, lettering, handwriting, signature, watermark, logo, border, frame, torn paper, burnt edge, coffee stain, copied reference composition
```

</details>

### vintage-copperplate-engraving — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `4c2cd304-bd44-4b9c-8b8f-c80e97e44f9d` (final state `succeeded`)
- Seed: `10260402` · Idempotency-Key: `style-preview-20261026-vintage-copperplate-engraving-scene-f08bc44c588ad830dce66f82`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1759915 bytes, SHA-256 `d26f488ea6e5535bb062ae56946150a8d03058ece6792958c82243226fc950a5`
- Final: `custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving-scene.webp`, 1672x941 WebP, 381706 bytes, SHA-256 `ddba3273f72624e43c5392380b98b25bd84b1508f245ea1f6ab14746f2282e22`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A NINETEENTH-CENTURY COPPERPLATE ENGRAVING built entirely from fine cut line and stipple on aged cream paper.

An empty walled garden seen frontally: a stone sundial on a pedestal, clipped hedges, a pebbled path and an espaliered fruit tree. No person and no animal in the frame.

Rendering contract: An antique intaglio plate reproduced on paper, in the manner of a nineteenth-century copperplate engraving as it appeared in a journal or a learned volume. Medium and surface: the whole picture is built from line — fine, even, closely spaced cut lines that swell and taper with the form, crossed into a lattice where a tone deepens, and resolved into stipple where a surface needs grain rather than direction. There is no brush rendering, no wash modelling and no photographic texture anywhere. Colour: restrained two-tone ink — a warm black-brown key printed over aged cream paper — plus a single muted deep-green wash laid flat and a little unevenly behind the light passages, the way a plate was hand-coloured. The palette never extends beyond those two inks and the paper. Tone: value comes from line density alone. A half tone is one hatching layer, a deep tone is a second crossing layer, and only the darkest recesses take a third; the brightest highlights are bare paper. Light is clear and calm rather than theatrical, bright enough to keep every form legible. Ornament: the fine decorative rules, cartouches and plate numbers of the period are deliberately absent — no caption block, no plate number, no ruled margin. One clear central subject carries the picture in a calm, authoritative arrangement with room around it. Aged paper: a light, even foxing tone and a faint plate-mark impression are welcome; a torn, burnt or heavily stained sheet is not. Keep the contract content-independent: no fixed subject, place, era, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, oil paint, watercolour, gouache, visible brush strokes, airbrush, soft shading, smooth gradient, glow, bloom, colour photograph of paper, halftone photo, saturated colour, neon, cartoon, anime, cel shading, flat vector, thick outline, chalk, crayon, marker, plate number, caption block, ruled margin, cartouche, lettering, handwriting, signature, watermark, logo, border, frame, torn paper, burnt edge, coffee stain, copied reference composition
```

</details>

### vintage-copperplate-engraving — hardest

- Variant: the hardest legal case for the style
- Gateway job: `1099a556-a931-4dca-aa2f-18584b1c0a4f` (final state `succeeded`)
- Seed: `10260403` · Idempotency-Key: `style-preview-20261026-vintage-copperplate-engraving-hardest-56e5558d9e44ec63cafe161c`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1778419 bytes, SHA-256 `22dfcce33aa8803fcaf49e178a00297fa52e88e75b4be2a68d0b97727c3bac63`
- Final: `custom-looks/style/vintage-copperplate-engraving/assets/vintage-copperplate-engraving-hardest.webp`, 1672x941 WebP, 401766 bytes, SHA-256 `988dd80c693ad4380f2d03268c350553222e59904da75ede7baf34047066e7c1`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A NINETEENTH-CENTURY COPPERPLATE ENGRAVING built entirely from fine cut line and stipple on aged cream paper.

A detailed cutaway view of a busy harbour with cranes, warehouses, stacked cargo and moored boats, the entire scene carried by line density alone, including the small working figures at the quayside.

Rendering contract: An antique intaglio plate reproduced on paper, in the manner of a nineteenth-century copperplate engraving as it appeared in a journal or a learned volume. Medium and surface: the whole picture is built from line — fine, even, closely spaced cut lines that swell and taper with the form, crossed into a lattice where a tone deepens, and resolved into stipple where a surface needs grain rather than direction. There is no brush rendering, no wash modelling and no photographic texture anywhere. Colour: restrained two-tone ink — a warm black-brown key printed over aged cream paper — plus a single muted deep-green wash laid flat and a little unevenly behind the light passages, the way a plate was hand-coloured. The palette never extends beyond those two inks and the paper. Tone: value comes from line density alone. A half tone is one hatching layer, a deep tone is a second crossing layer, and only the darkest recesses take a third; the brightest highlights are bare paper. Light is clear and calm rather than theatrical, bright enough to keep every form legible. Ornament: the fine decorative rules, cartouches and plate numbers of the period are deliberately absent — no caption block, no plate number, no ruled margin. One clear central subject carries the picture in a calm, authoritative arrangement with room around it. Aged paper: a light, even foxing tone and a faint plate-mark impression are welcome; a torn, burnt or heavily stained sheet is not. Keep the contract content-independent: no fixed subject, place, era, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, oil paint, watercolour, gouache, visible brush strokes, airbrush, soft shading, smooth gradient, glow, bloom, colour photograph of paper, halftone photo, saturated colour, neon, cartoon, anime, cel shading, flat vector, thick outline, chalk, crayon, marker, plate number, caption block, ruled margin, cartouche, lettering, handwriting, signature, watermark, logo, border, frame, torn paper, burnt edge, coffee stain, copied reference composition
```

</details>

### warm-cosy-interior-illustration — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `f302aecf-f561-46fa-9468-ef2a3d82c652` (final state `succeeded`)
- Seed: `10260501` · Idempotency-Key: `style-preview-20261026-warm-cosy-interior-illustration-hero-e11b707a9e21fc9e270f4c3a`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1174540 bytes, SHA-256 `0b6a810743a6be563ca7d82d9d3555bf4718c644cb9376439c5aeb52a5bce73f`
- Final: `custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration.webp`, 1672x941 WebP, 142232 bytes, SHA-256 `856a049bc13840fde168bbe7ee4f59b37c7858bf49ee36aea57f652238dba435`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A WARM PAINTED INTERIOR in soft digital brush, illustrated rather than photographed.

A small bookshop interior at lamplight: a wooden counter in the foreground, full shelves behind it, an armchair and a low table holding a steaming cup, and a warm window looking out onto a dark street.

Rendering contract: A warm, inhabited interior painted in soft digital brush, in the register of an illustrated magazine plate rather than a photograph. Medium and surface: soft painterly digital art with visible brush groupings — broad blended planes for walls, floors and ceilings, looser scumbled strokes for textiles, timber and foliage, and a few crisper marks reserved for the nearest object. There is no photographic texture, no lens blur and no three-dimensional gloss. Palette: warm browns, cream and amber across the lit surfaces, held against muted greens that come from plants, upholstery or a view through a window. Warm colours dominate; the greens stay quiet and slightly grey rather than forming a competing scheme. Lighting: gentle lamplight — one or two warm practical sources inside the room, each with a soft halo and a gentle falloff that lets the corners settle into a warm half-dark. Cool daylight may enter through a window as a clearly weaker secondary note. Never an even flood of light and never a harsh key. Composition: a furnished interior with real depth — a near surface such as a table edge or a counter in the foreground, a middle plane of seating, shelving or a serving counter, and a further opening onto a terrace, a window or a street beyond. Clean and uncluttered enough to read at card size, inviting and calm, with no drama and no crowd. Furnishing stays generic to the register: timber, earthenware, cloth, hanging lamps and potted plants. No recognisable brand, no legible signage and no menu lettering. Keep the contract content-independent: no fixed shopfront, city, era or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, 3D render, CGI, glossy plastic, lens blur, depth of field bokeh, HDR, harsh key light, even studio lighting, white background, empty bare room, flat vector, cel shading, thick ink outline, anime, cartoon mascot, chibi, neon, oversaturated, cluttered crowd, dramatic event, violence, legible signage, brand logo, menu lettering, captions, signature, watermark, border, frame, copied reference composition
```

</details>

### warm-cosy-interior-illustration — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `0d94f39c-e7a2-446b-a044-14691479c7af` (final state `succeeded`)
- Seed: `10260502` · Idempotency-Key: `style-preview-20261026-warm-cosy-interior-illustration-scene-5186d456b5607ceec05fefb6`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1239204 bytes, SHA-256 `09c5f7a18e5c5e64cd0c8c2bfa2c3707869467a0974947a677b1690d3406cfed`
- Final: `custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration-scene.webp`, 1672x941 WebP, 177738 bytes, SHA-256 `309902f980585aef5dffdd64a2b53f82bce3747d066ff39c9c2e5ed94ec9a7a4`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A WARM PAINTED INTERIOR in soft digital brush, illustrated rather than photographed.

An empty cafe terrace at twilight: bistro tables and chairs, a striped awning, potted plants, a low railing and warm light spilling from an open doorway. No people anywhere.

Rendering contract: A warm, inhabited interior painted in soft digital brush, in the register of an illustrated magazine plate rather than a photograph. Medium and surface: soft painterly digital art with visible brush groupings — broad blended planes for walls, floors and ceilings, looser scumbled strokes for textiles, timber and foliage, and a few crisper marks reserved for the nearest object. There is no photographic texture, no lens blur and no three-dimensional gloss. Palette: warm browns, cream and amber across the lit surfaces, held against muted greens that come from plants, upholstery or a view through a window. Warm colours dominate; the greens stay quiet and slightly grey rather than forming a competing scheme. Lighting: gentle lamplight — one or two warm practical sources inside the room, each with a soft halo and a gentle falloff that lets the corners settle into a warm half-dark. Cool daylight may enter through a window as a clearly weaker secondary note. Never an even flood of light and never a harsh key. Composition: a furnished interior with real depth — a near surface such as a table edge or a counter in the foreground, a middle plane of seating, shelving or a serving counter, and a further opening onto a terrace, a window or a street beyond. Clean and uncluttered enough to read at card size, inviting and calm, with no drama and no crowd. Furnishing stays generic to the register: timber, earthenware, cloth, hanging lamps and potted plants. No recognisable brand, no legible signage and no menu lettering. Keep the contract content-independent: no fixed shopfront, city, era or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, 3D render, CGI, glossy plastic, lens blur, depth of field bokeh, HDR, harsh key light, even studio lighting, white background, empty bare room, flat vector, cel shading, thick ink outline, anime, cartoon mascot, chibi, neon, oversaturated, cluttered crowd, dramatic event, violence, legible signage, brand logo, menu lettering, captions, signature, watermark, border, frame, copied reference composition
```

</details>

### warm-cosy-interior-illustration — hardest

- Variant: the hardest legal case for the style
- Gateway job: `07304a8d-6926-4062-917a-8009e57fc249` (final state `succeeded`)
- Seed: `10260503` · Idempotency-Key: `style-preview-20261026-warm-cosy-interior-illustration-hardest-8b6501625acc1cecb82c940a`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1160591 bytes, SHA-256 `d40252456486e877114c0f3f8b4166714f67f2e1896450c687b4125a15daf52d`
- Final: `custom-looks/style/warm-cosy-interior-illustration/assets/warm-cosy-interior-illustration-hardest.webp`, 1672x941 WebP, 139822 bytes, SHA-256 `6d5f92630098b3a194018cc5e84033fe535ad16215fe7ac4fffd252f5f4fb38e`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A WARM PAINTED INTERIOR in soft digital brush, illustrated rather than photographed.

A working kitchen interior with hanging copper pans, stacked crockery, open shelves of jars, a cast-iron stove and linen on a rail, all held under one warm hanging lamp and kept legible.

Rendering contract: A warm, inhabited interior painted in soft digital brush, in the register of an illustrated magazine plate rather than a photograph. Medium and surface: soft painterly digital art with visible brush groupings — broad blended planes for walls, floors and ceilings, looser scumbled strokes for textiles, timber and foliage, and a few crisper marks reserved for the nearest object. There is no photographic texture, no lens blur and no three-dimensional gloss. Palette: warm browns, cream and amber across the lit surfaces, held against muted greens that come from plants, upholstery or a view through a window. Warm colours dominate; the greens stay quiet and slightly grey rather than forming a competing scheme. Lighting: gentle lamplight — one or two warm practical sources inside the room, each with a soft halo and a gentle falloff that lets the corners settle into a warm half-dark. Cool daylight may enter through a window as a clearly weaker secondary note. Never an even flood of light and never a harsh key. Composition: a furnished interior with real depth — a near surface such as a table edge or a counter in the foreground, a middle plane of seating, shelving or a serving counter, and a further opening onto a terrace, a window or a street beyond. Clean and uncluttered enough to read at card size, inviting and calm, with no drama and no crowd. Furnishing stays generic to the register: timber, earthenware, cloth, hanging lamps and potted plants. No recognisable brand, no legible signage and no menu lettering. Keep the contract content-independent: no fixed shopfront, city, era or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, 3D render, CGI, glossy plastic, lens blur, depth of field bokeh, HDR, harsh key light, even studio lighting, white background, empty bare room, flat vector, cel shading, thick ink outline, anime, cartoon mascot, chibi, neon, oversaturated, cluttered crowd, dramatic event, violence, legible signage, brand logo, menu lettering, captions, signature, watermark, border, frame, copied reference composition
```

</details>

### storybook-stick-figure-cartoon — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `a2c5bacc-9a0e-4fa2-8ec7-d7675a9aa2a4` (final state `succeeded`)
- Seed: `10260601` · Idempotency-Key: `style-preview-20261026-storybook-stick-figure-cartoon-hero-a9ff7c1c436c0e318babb144`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1433218 bytes, SHA-256 `8278f070118218e5de069f8828bafc1d792507f72f2f2cf0d2a10091e6bcf412`
- Final: `custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon.webp`, 1672x941 WebP, 203650 bytes, SHA-256 `f881698dc6e7931b97b666bc5be36ffbad3b8604b015c6c3047e431abf34fb22`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A CHILDREN'S STORYBOOK CARTOON: stick-figure characters drawn in clean black outline standing in a soft watercolour-painted place.

Two stick-figure children with large round heads and tiny dot eyes stand at the edge of a wide painted field, one holding a kite string, under a soft watercoloured sky.

Rendering contract: A drawn storybook cartoon where simple stick-figure characters stand inside softly painted places. Medium and surface: two clearly different materials in one picture. The characters and the props they hold are clean flat 2D digital drawing; the environment behind and around them is soft watercolour painting with visible wash variation, softened edges and a little paper texture. The seam between the two is deliberate — drawn figures on a painted world — and never blurred into one rendering style. Line: every character and prop is closed by a clean black outline of even, confident weight; the head is a large circle, the limbs are simple stick strokes with rounded ends, and the face carries only tiny dot eyes, a few sketchy black strokes for hair and at most a small curved mouth. Line weight does not vary much within a form, and nothing is cross-hatched. Fill: characters and props are flat colour or one soft cel step of shading; environments are painted in translucent watercolour with lighter and darker passages inside the same hue. Palette: warm and earthy — ochre, terracotta, sage, warm brown and cream for the figures and their clothing — against watercolour greens, dusty blues and warm neutrals in the places they stand. Lighting: soft and diffused throughout, with only a single gentle shading step on the drawn characters and no dramatic light anywhere. Composition: clean and uncluttered, one clear action per frame, highly readable silhouettes, generous space around the subject, and a rough, imperfect hand-drawn white border framing the picture. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, plastic, airbrush, smooth gradient, oil paint, heavy ink cross-hatching, scratchy pen texture, gritty charcoal, neon, oversaturated, cluttered scene, dense background, many figures, anime, manga, chibi, detailed realistic anatomy, realistic faces, sharp photographic environment, lettering, captions, speech bubbles, signature, watermark, logo, copied reference composition
```

</details>

### storybook-stick-figure-cartoon — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `1d8fdd40-1612-42a9-9e4c-b52636262028` (final state `succeeded`)
- Seed: `10260602` · Idempotency-Key: `style-preview-20261026-storybook-stick-figure-cartoon-scene-b27093f13a84b9a2289a9bf0`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1501374 bytes, SHA-256 `b5434b632078c44f3df875ad71e1f650be13bb500e639b353d8b19073ae11cf6`
- Final: `custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon-scene.webp`, 1672x941 WebP, 245450 bytes, SHA-256 `39f9393d6a0a37ab0d62c25a22dd99b4472a8ce29a9f1a6a545828f94504402a`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A CHILDREN'S STORYBOOK CARTOON: stick-figure characters drawn in clean black outline standing in a soft watercolour-painted place.

An empty watercoloured village lane at dusk: simple painted cottages, a lamp post, a low stone wall and a tree against a soft sky. No figure of any kind in the picture.

Rendering contract: A drawn storybook cartoon where simple stick-figure characters stand inside softly painted places. Medium and surface: two clearly different materials in one picture. The characters and the props they hold are clean flat 2D digital drawing; the environment behind and around them is soft watercolour painting with visible wash variation, softened edges and a little paper texture. The seam between the two is deliberate — drawn figures on a painted world — and never blurred into one rendering style. Line: every character and prop is closed by a clean black outline of even, confident weight; the head is a large circle, the limbs are simple stick strokes with rounded ends, and the face carries only tiny dot eyes, a few sketchy black strokes for hair and at most a small curved mouth. Line weight does not vary much within a form, and nothing is cross-hatched. Fill: characters and props are flat colour or one soft cel step of shading; environments are painted in translucent watercolour with lighter and darker passages inside the same hue. Palette: warm and earthy — ochre, terracotta, sage, warm brown and cream for the figures and their clothing — against watercolour greens, dusty blues and warm neutrals in the places they stand. Lighting: soft and diffused throughout, with only a single gentle shading step on the drawn characters and no dramatic light anywhere. Composition: clean and uncluttered, one clear action per frame, highly readable silhouettes, generous space around the subject, and a rough, imperfect hand-drawn white border framing the picture. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, plastic, airbrush, smooth gradient, oil paint, heavy ink cross-hatching, scratchy pen texture, gritty charcoal, neon, oversaturated, cluttered scene, dense background, many figures, anime, manga, chibi, detailed realistic anatomy, realistic faces, sharp photographic environment, lettering, captions, speech bubbles, signature, watermark, logo, copied reference composition
```

</details>

### storybook-stick-figure-cartoon — hardest

- Variant: the hardest legal case for the style
- Gateway job: `754af0b7-d3d1-4f7b-8011-8c37b53ffa13` (final state `succeeded`)
- Seed: `10260603` · Idempotency-Key: `style-preview-20261026-storybook-stick-figure-cartoon-hardest-8c8ca6ab08e06bb37fa49272`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1674351 bytes, SHA-256 `0e491730694acbba6efdb918d2518c0d26aec8d084f190bd836c3bc5400bbb47`
- Final: `custom-looks/style/storybook-stick-figure-cartoon/assets/storybook-stick-figure-cartoon-hardest.webp`, 1672x941 WebP, 347826 bytes, SHA-256 `4aab69ede9fe630aa3edadb455e699710a39010e372c31586ace8d5119150551`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A CHILDREN'S STORYBOOK CARTOON: stick-figure characters drawn in clean black outline standing in a soft watercolour-painted place.

A stick-figure crowd around a painted market stall: simple drawn goods, stacked crates and a hand-cart, keeping every figure a clean-outlined stick construction standing against a soft watercolour street.

Rendering contract: A drawn storybook cartoon where simple stick-figure characters stand inside softly painted places. Medium and surface: two clearly different materials in one picture. The characters and the props they hold are clean flat 2D digital drawing; the environment behind and around them is soft watercolour painting with visible wash variation, softened edges and a little paper texture. The seam between the two is deliberate — drawn figures on a painted world — and never blurred into one rendering style. Line: every character and prop is closed by a clean black outline of even, confident weight; the head is a large circle, the limbs are simple stick strokes with rounded ends, and the face carries only tiny dot eyes, a few sketchy black strokes for hair and at most a small curved mouth. Line weight does not vary much within a form, and nothing is cross-hatched. Fill: characters and props are flat colour or one soft cel step of shading; environments are painted in translucent watercolour with lighter and darker passages inside the same hue. Palette: warm and earthy — ochre, terracotta, sage, warm brown and cream for the figures and their clothing — against watercolour greens, dusty blues and warm neutrals in the places they stand. Lighting: soft and diffused throughout, with only a single gentle shading step on the drawn characters and no dramatic light anywhere. Composition: clean and uncluttered, one clear action per frame, highly readable silhouettes, generous space around the subject, and a rough, imperfect hand-drawn white border framing the picture. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, plastic, airbrush, smooth gradient, oil paint, heavy ink cross-hatching, scratchy pen texture, gritty charcoal, neon, oversaturated, cluttered scene, dense background, many figures, anime, manga, chibi, detailed realistic anatomy, realistic faces, sharp photographic environment, lettering, captions, speech bubbles, signature, watermark, logo, copied reference composition
```

</details>

### muted-isometric-infographic — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `2c9d5d56-85a0-4f27-9fd8-5e3610478799` (final state `succeeded`)
- Seed: `10260701` · Idempotency-Key: `style-preview-20261026-muted-isometric-infographic-hero-6e9db85693b999e5c9752239`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 881155 bytes, SHA-256 `d0b0d10cc88078772e337d05baa08210ec358d4fbdc070b9c0a46cfcdb59ea18`
- Final: `custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic.webp`, 1672x941 WebP, 83352 bytes, SHA-256 `0143e856089ae71feb62c2bf45d001a119a211a4cd6bfe31ae5885c17e79785a`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FLAT ISOMETRIC INFOGRAPHIC in thirty-degree axonometric projection, vector-clean and diagrammatic.

A tidy isometric arrangement of a small workshop: a workbench, a shelf unit, a stool, a toolbox and a floor lamp, spaced evenly on a plain light ground with soft shadows beneath each object.

Rendering contract: A flat isometric explanatory illustration: objects arranged in a tidy modular diagram rather than a scene. Projection: true thirty-degree axonometric — every vertical stays vertical, the two ground axes rise at thirty degrees, and there is no perspective convergence, no vanishing point and no lens look. Forms: simple extruded blocks and simple solids with crisp clean edges, built from a few straight planes and simple curves; detail is reduced to what identifies the object, and nothing is modelled with micro-texture. Palette: soft teal, sand, slate and warm grey, muted and close in value so the arrangement reads as one calm diagram rather than a set of competing objects. Shading: gentle soft shadow pooled beneath each object and one soft tone on a single side plane; surfaces themselves stay flat, with no gradient running across a face, no specular highlight and no reflective gloss. Composition: objects spaced evenly on a plain light neutral background, aligned to the isometric grid, arranged with deliberate modular order and clear groupings; explanatory and calm, precise but friendly. Keep the contract content-independent and free of labels: no lettering, no numbers, no captions, no icons that carry words.
Exclude: photoreal, photograph, photorealistic, perspective projection, vanishing point, one-point perspective, fisheye, camera lens, 3D render, glossy plastic, specular highlight, reflective metal, emissive glow, neon, drop shadow with blur, gradient across a surface, textured material, wood grain photograph, dark background, cluttered pile, many unaligned objects, organic painterly, watercolour, oil paint, ink outline, cartoon mascot, anime, lettering, numbers, labels, captions, arrows with words, UI panels, signature, watermark, logo, copied reference composition
```

</details>

### muted-isometric-infographic — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `7d67834e-2515-4416-8178-86de0034814f` (final state `succeeded`)
- Seed: `10260702` · Idempotency-Key: `style-preview-20261026-muted-isometric-infographic-scene-1158cbb7a8623ee44d99ccd1`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 809086 bytes, SHA-256 `970c4049e5e62416df093efcda8246c3c8de96a4881684c4bd6c544531e7b636`
- Final: `custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic-scene.webp`, 1672x941 WebP, 65418 bytes, SHA-256 `0adf2e299ae0c3abab11073d9391ae5339f71a6bbb2830370c5b66c5e87c908c`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FLAT ISOMETRIC INFOGRAPHIC in thirty-degree axonometric projection, vector-clean and diagrammatic.

A row of four simple isometric buildings of increasing height along a road, with two trees and a lamp post, spaced along the same grid on a plain light background. No people.

Rendering contract: A flat isometric explanatory illustration: objects arranged in a tidy modular diagram rather than a scene. Projection: true thirty-degree axonometric — every vertical stays vertical, the two ground axes rise at thirty degrees, and there is no perspective convergence, no vanishing point and no lens look. Forms: simple extruded blocks and simple solids with crisp clean edges, built from a few straight planes and simple curves; detail is reduced to what identifies the object, and nothing is modelled with micro-texture. Palette: soft teal, sand, slate and warm grey, muted and close in value so the arrangement reads as one calm diagram rather than a set of competing objects. Shading: gentle soft shadow pooled beneath each object and one soft tone on a single side plane; surfaces themselves stay flat, with no gradient running across a face, no specular highlight and no reflective gloss. Composition: objects spaced evenly on a plain light neutral background, aligned to the isometric grid, arranged with deliberate modular order and clear groupings; explanatory and calm, precise but friendly. Keep the contract content-independent and free of labels: no lettering, no numbers, no captions, no icons that carry words.
Exclude: photoreal, photograph, photorealistic, perspective projection, vanishing point, one-point perspective, fisheye, camera lens, 3D render, glossy plastic, specular highlight, reflective metal, emissive glow, neon, drop shadow with blur, gradient across a surface, textured material, wood grain photograph, dark background, cluttered pile, many unaligned objects, organic painterly, watercolour, oil paint, ink outline, cartoon mascot, anime, lettering, numbers, labels, captions, arrows with words, UI panels, signature, watermark, logo, copied reference composition
```

</details>

### muted-isometric-infographic — hardest

- Variant: the hardest legal case for the style
- Gateway job: `0eff6cef-255d-43b6-ab3a-4e78e6b2a59f` (final state `succeeded`)
- Seed: `10260703` · Idempotency-Key: `style-preview-20261026-muted-isometric-infographic-hardest-b55e46d9ec768fe37557369a`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 960993 bytes, SHA-256 `645591a6b8d610e6050639edb7ef3b2d7a2749b0b74e7904e754d39c7962e2d0`
- Final: `custom-looks/style/muted-isometric-infographic/assets/muted-isometric-infographic-hardest.webp`, 1672x941 WebP, 110330 bytes, SHA-256 `2349e62abb2a81d564f9834d70480232a66cd4b5bcf95e9f45637dc7d50ece4a`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FLAT ISOMETRIC INFOGRAPHIC in thirty-degree axonometric projection, vector-clean and diagrammatic.

A dense isometric cutaway of a two-storey building showing rooms, a staircase, furniture and stacked crates on both floors, every element aligned to the same thirty-degree grid with no perspective convergence anywhere.

Rendering contract: A flat isometric explanatory illustration: objects arranged in a tidy modular diagram rather than a scene. Projection: true thirty-degree axonometric — every vertical stays vertical, the two ground axes rise at thirty degrees, and there is no perspective convergence, no vanishing point and no lens look. Forms: simple extruded blocks and simple solids with crisp clean edges, built from a few straight planes and simple curves; detail is reduced to what identifies the object, and nothing is modelled with micro-texture. Palette: soft teal, sand, slate and warm grey, muted and close in value so the arrangement reads as one calm diagram rather than a set of competing objects. Shading: gentle soft shadow pooled beneath each object and one soft tone on a single side plane; surfaces themselves stay flat, with no gradient running across a face, no specular highlight and no reflective gloss. Composition: objects spaced evenly on a plain light neutral background, aligned to the isometric grid, arranged with deliberate modular order and clear groupings; explanatory and calm, precise but friendly. Keep the contract content-independent and free of labels: no lettering, no numbers, no captions, no icons that carry words.
Exclude: photoreal, photograph, photorealistic, perspective projection, vanishing point, one-point perspective, fisheye, camera lens, 3D render, glossy plastic, specular highlight, reflective metal, emissive glow, neon, drop shadow with blur, gradient across a surface, textured material, wood grain photograph, dark background, cluttered pile, many unaligned objects, organic painterly, watercolour, oil paint, ink outline, cartoon mascot, anime, lettering, numbers, labels, captions, arrows with words, UI panels, signature, watermark, logo, copied reference composition
```

</details>

### dark-folk-horror-gouache — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `1e797a9e-7227-43e9-b83d-42a0febe93da` (final state `succeeded`)
- Seed: `10260801` · Idempotency-Key: `style-preview-20261026-dark-folk-horror-gouache-hero-ad81712f187f80a42c1a84b4`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1099018 bytes, SHA-256 `1affea4d6d2863b6aa1f2bfaf1a4746c1bfebadf987d723eeb709db2f5a8ca05`
- Final: `custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache.webp`, 1672x941 WebP, 71138 bytes, SHA-256 `5b7cde7869ba6adf6a5cfabaf58cbabda2f5d0e6a2863830eabacd15e1e0f7ef`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A DARK GOUACHE AND INK-WASH PAINTING on visible paper, hand-drawn contours and dry-brush scumble, never photographic.

A lone stone cottage at the edge of a dark field, one window lit from within, a bare tree leaning across the roofline and mist lying along the ground.

Rendering contract: A dark, non-photoreal painted illustration with the texture of gouache worked on paper. Medium and surface: forms are built from opaque gouache and dry-brush scumbling, with rough ink-wash passages carrying the deepest shadow, all sitting on a subtly visible paper surface — so the picture shows its making in every area and never pretends to be a photograph or a clean digital painting. Line: contours stay hand-drawn and irregular, wobbling slightly and varying in weight; they are never clean vectors or uniform strokes. Figures use stylized but believable proportions with expressive, illustrated faces rather than photographic anatomy. Palette: deep indigo and charcoal for the shadow, muted earthy cloth and wood tones for everything the dark does not take, and one restrained warm accent — amber or ochre — supplied by a motivated practical light such as a lamp, a window, a fire or a lantern. No second warm accent, no saturated fill. Value: clear separation between lit and unlit, holding enough midtone detail that silhouettes, hands and faces still read on a phone; the picture must not resolve into a black rectangle. Lighting: every light source is physically grounded in the scene and falls off believably; shadows are cool and deep, never flat. Composition: one strong focal subject set in layered depth with quiet negative space around it. Dread is carried by environmental darkness and a single uneasy visual contradiction inside the scene, never by gore, wounds, monstrosity or threat. Keep the contract content-independent: no fixed nationality, era, creature, recurring prop or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, clean digital painting, smooth vector lines, airbrush, soft gradient, high-key, bright even light, white background, neon, saturated colour, candy colour, two warm accent colours, flat untextured fill, gore, blood, wounds, viscera, exposed organs, mutilation, demon, monster with fangs, ghost figure, jump-scare face, suffering, torture, cruelty, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### dark-folk-horror-gouache — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `d1c4aa7e-5ea4-4d11-a752-262cd933471c` (final state `succeeded`)
- Seed: `10260802` · Idempotency-Key: `style-preview-20261026-dark-folk-horror-gouache-scene-2062e2401d40b57bff2ecdeb`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1159360 bytes, SHA-256 `e3c10ec59fd6a90e3ac80ac25659173ee2955009c5f396a2d036770f68f273d1`
- Final: `custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache-scene.webp`, 1672x941 WebP, 98400 bytes, SHA-256 `f5205b4fcad35a5f39cc8a5984056b885a96b495b4c9cfcea286681a76629af2`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A DARK GOUACHE AND INK-WASH PAINTING on visible paper, hand-drawn contours and dry-brush scumble, never photographic, showing only a place and its atmosphere with nothing living in it.

An empty marsh at dusk: dead reeds, flat standing water, low mossy stones, a leaning wooden post and a heavy indigo sky, with mist lying low over the water. A single small lantern hangs from the post and casts one restrained amber pool on the water. Nothing living is anywhere in the frame — no creature, no figure, no person, no animal, no ghost, only the marsh, the reeds, the water and the weather.

Rendering contract: A dark, non-photoreal painted landscape illustration with the texture of gouache worked on paper. Medium and surface: forms are built from opaque gouache and dry-brush scumbling, with rough ink-wash passages carrying the deepest shadow, all sitting on a subtly visible paper surface — so the picture shows its making in every area and never pretends to be a photograph or a clean digital painting. Line: contours stay hand-drawn and irregular, wobbling slightly and varying in weight; they are never clean vectors or uniform strokes. Palette: deep indigo and charcoal for the shadow, muted earthy tones for the land and water, and one restrained warm accent — amber or ochre — supplied by a single motivated practical light such as a lantern, a window or a low fire. No second warm accent, no saturated fill. Value: clear separation between lit and unlit, holding enough midtone detail that the place still reads on a phone; the picture must not resolve into a black rectangle. Lighting: the one light source is physically grounded in the scene and falls off believably; shadows are cool and deep, never flat. Composition: one strong focal place-feature — the marsh pool, a leaning post with its lantern, a standing stone — set in layered depth with quiet negative space around it. Dread is carried by environmental darkness and a single uneasy visual contradiction inside the place itself, such as a reflection that does not match the sky above, and never by gore, wounds, monstrosity, threat or any living thing. This is a place and its atmosphere only: no creature, no figure, no person, no animal, no ghost and no silhouette of any living thing anywhere in the frame. Keep the contract content-independent: no fixed nationality, era, creature, recurring prop or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, clean digital painting, smooth vector lines, airbrush, soft gradient, high-key, bright even light, white background, neon, saturated colour, candy colour, two warm accent colours, flat untextured fill, gore, blood, wounds, viscera, exposed organs, mutilation, demon, monster with fangs, ghost figure, jump-scare face, suffering, torture, cruelty, lettering, captions, signature, watermark, logo, border, frame, copied reference composition, creature, creature of any kind, figure, person, people, human, humanoid, silhouette of a figure, silhouette of a creature, animal, monster, demon, ghost, skull face, hands, eyes, face
```

</details>

### dark-folk-horror-gouache — hardest

- Variant: the hardest legal case for the style
- Gateway job: `58236d11-fe54-4570-b63b-02bd94bcadc4` (final state `succeeded`)
- Seed: `10260803` · Idempotency-Key: `style-preview-20261026-dark-folk-horror-gouache-hardest-a99cd9733cf80e0dd5f9f2c7`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1093457 bytes, SHA-256 `7182f3d15cab5242cfd6d70220e03df24b20a6012b21c192c9b29719dbab9e53`
- Final: `custom-looks/style/dark-folk-horror-gouache/assets/dark-folk-horror-gouache-hardest.webp`, 1672x941 WebP, 97116 bytes, SHA-256 `01e614db0bf9343686a1e503e52ad3a028a7cfb5e5a4df50803330e1d8346277`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A DARK GOUACHE AND INK-WASH PAINTING on visible paper, hand-drawn contours and dry-brush scumble, never photographic.

A dim interior lit only by a single lantern standing low on a table: rough plaster walls, hanging dried herbs, a wooden bowl, and deep indigo shadow filling the corners, with one quiet wrongness in the scene — a door standing open onto pure darkness where the next room should be.

Rendering contract: A dark, non-photoreal painted illustration with the texture of gouache worked on paper. Medium and surface: forms are built from opaque gouache and dry-brush scumbling, with rough ink-wash passages carrying the deepest shadow, all sitting on a subtly visible paper surface — so the picture shows its making in every area and never pretends to be a photograph or a clean digital painting. Line: contours stay hand-drawn and irregular, wobbling slightly and varying in weight; they are never clean vectors or uniform strokes. Figures use stylized but believable proportions with expressive, illustrated faces rather than photographic anatomy. Palette: deep indigo and charcoal for the shadow, muted earthy cloth and wood tones for everything the dark does not take, and one restrained warm accent — amber or ochre — supplied by a motivated practical light such as a lamp, a window, a fire or a lantern. No second warm accent, no saturated fill. Value: clear separation between lit and unlit, holding enough midtone detail that silhouettes, hands and faces still read on a phone; the picture must not resolve into a black rectangle. Lighting: every light source is physically grounded in the scene and falls off believably; shadows are cool and deep, never flat. Composition: one strong focal subject set in layered depth with quiet negative space around it. Dread is carried by environmental darkness and a single uneasy visual contradiction inside the scene, never by gore, wounds, monstrosity or threat. Keep the contract content-independent: no fixed nationality, era, creature, recurring prop or copied composition.
Exclude: photoreal, photograph, photorealistic, camera render, film still, 3D render, CGI, glossy, plastic, clean digital painting, smooth vector lines, airbrush, soft gradient, high-key, bright even light, white background, neon, saturated colour, candy colour, two warm accent colours, flat untextured fill, gore, blood, wounds, viscera, exposed organs, mutilation, demon, monster with fangs, ghost figure, jump-scare face, suffering, torture, cruelty, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### stained-glass-panel-illustration — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `c7994fe3-1e50-4d16-8f8f-1626957471de` (final state `succeeded`)
- Seed: `10260901` · Idempotency-Key: `style-preview-20261026-stained-glass-panel-illustration-hero-a232eb59cb9f34d45c04b854`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1207848 bytes, SHA-256 `210460df931382683f6a6876fd4225f233acf01c1edf1d72064e393864972649`
- Final: `custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration.webp`, 1672x941 WebP, 192384 bytes, SHA-256 `4006ae3971f9ea13f2651f612e84253a37d9d28c8a0097fc595677dbd95f1a95`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A LEADED STAINED-GLASS PANEL seen as the object itself: jewel-coloured translucent glass divided by dark lead came, lit from behind.

A stained-glass panel of a single tree in full leaf: the canopy built from many small panes of emerald and gold, a deep blue sky behind it, and a narrow trunk formed by dark leading.

Rendering contract: A painted stained-glass panel, seen as the object itself rather than as a photograph of a church interior. Medium and surface: the picture is made of glass in lead. Every area of colour is a pane of translucent glass, and every boundary is a strip of dark lead came — thick, dark, slightly irregular in width, and never perfectly straight. Line: the leading is the only linework in the picture, and it closes every shape into a cell; there are no drawn contours inside a pane. Fill: each pane is one jewel hue, or the same hue with a subtle streaked marbling inside the colour, and never a photographic texture. Palette: deep blue, ruby, gold and emerald are the working colours, with a few pale or near-white panes to carry the brightest passages; the palette stays saturated and luminous rather than muted. Lighting: light comes through the panel from behind, so the colours glow from within. The palest and warmest panes are the brightest, the deep blues and emeralds sit darker, and the leading reads as the darkest element. There are no cast shadows lying across the glass and no bloom spilling outside it. Composition: simple, graceful, broad shapes that read as one panel — leading follows the form of what is depicted rather than a grid of small equal squares, and the arrangement stays balanced and calm, close to symmetry without being rigid. A plain stone reveal may frame the panel edge; a full architectural surround, window furniture or a room interior may not. Keep the contract content-independent: no fixed sacred figure, saint, emblem, wording or copied window.
Exclude: photograph, photorealistic, camera render, 3D render, CGI, glossy, glass reflection, glare, specular highlight, transparent window, room interior, church architecture, window frame, stone tracery wall, grid of many small equal panes, geometric honeycomb, cartoon, anime, cel shading, thick outer outline, ink contour, flat vector, watercolour, oil paint, neon, rainbow palette, muted palette, cast shadow across the glass, bloom, lettering, numbers, captions, signature, watermark, logo, copied reference window
```

</details>

### stained-glass-panel-illustration — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `d353c9c1-a4ce-4b13-a267-132bb519e11f` (final state `succeeded`)
- Seed: `10260902` · Idempotency-Key: `style-preview-20261026-stained-glass-panel-illustration-scene-d1294f7c12f74f0895dd040f`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1206202 bytes, SHA-256 `200919cc4ad18a6e1ecffc433b573a87572ab6cdc9cadbf8416155359b47669c`
- Final: `custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration-scene.webp`, 1672x941 WebP, 146856 bytes, SHA-256 `1f2f448e4be2ee7a8e36d9cb7d7f6a1868b28250c2f98fe113bbd793ca341f41`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A LEADED STAINED-GLASS PANEL seen as the object itself: jewel-coloured translucent glass divided by dark lead came, lit from behind.

A stained-glass panel of a calm sea and a low sun: a broad band of deep blue water, a pale gold sky, and a few simple horizontal wave shapes. No figures and no boats.

Rendering contract: A painted stained-glass panel, seen as the object itself rather than as a photograph of a church interior. Medium and surface: the picture is made of glass in lead. Every area of colour is a pane of translucent glass, and every boundary is a strip of dark lead came — thick, dark, slightly irregular in width, and never perfectly straight. Line: the leading is the only linework in the picture, and it closes every shape into a cell; there are no drawn contours inside a pane. Fill: each pane is one jewel hue, or the same hue with a subtle streaked marbling inside the colour, and never a photographic texture. Palette: deep blue, ruby, gold and emerald are the working colours, with a few pale or near-white panes to carry the brightest passages; the palette stays saturated and luminous rather than muted. Lighting: light comes through the panel from behind, so the colours glow from within. The palest and warmest panes are the brightest, the deep blues and emeralds sit darker, and the leading reads as the darkest element. There are no cast shadows lying across the glass and no bloom spilling outside it. Composition: simple, graceful, broad shapes that read as one panel — leading follows the form of what is depicted rather than a grid of small equal squares, and the arrangement stays balanced and calm, close to symmetry without being rigid. A plain stone reveal may frame the panel edge; a full architectural surround, window furniture or a room interior may not. Keep the contract content-independent: no fixed sacred figure, saint, emblem, wording or copied window.
Exclude: photograph, photorealistic, camera render, 3D render, CGI, glossy, glass reflection, glare, specular highlight, transparent window, room interior, church architecture, window frame, stone tracery wall, grid of many small equal panes, geometric honeycomb, cartoon, anime, cel shading, thick outer outline, ink contour, flat vector, watercolour, oil paint, neon, rainbow palette, muted palette, cast shadow across the glass, bloom, lettering, numbers, captions, signature, watermark, logo, copied reference window
```

</details>

### stained-glass-panel-illustration — hardest

- Variant: the hardest legal case for the style
- Gateway job: `4c55a59d-d4fc-45f3-ba73-3750fc773470` (final state `succeeded`)
- Seed: `10260903` · Idempotency-Key: `style-preview-20261026-stained-glass-panel-illustration-hardest-a929d554c347444b73daa39a`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1456280 bytes, SHA-256 `c3339b525294f2f53fcd91d39e06ba4edf02cb25d2a99b59b3108590e397a7d7`
- Final: `custom-looks/style/stained-glass-panel-illustration/assets/stained-glass-panel-illustration-hardest.webp`, 1672x941 WebP, 289474 bytes, SHA-256 `80fa3712a7a48067a8c3a9140df6f8f6309a4939da7c10ee5b979f95ccdd839b`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A LEADED STAINED-GLASS PANEL seen as the object itself: jewel-coloured translucent glass divided by dark lead came, lit from behind.

A stained-glass panel of a crowded harbour with a tall ship under full rigging, water, quayside buildings and many small figures, every element separated by dark leading and every pane a single jewel hue.

Rendering contract: A painted stained-glass panel, seen as the object itself rather than as a photograph of a church interior. Medium and surface: the picture is made of glass in lead. Every area of colour is a pane of translucent glass, and every boundary is a strip of dark lead came — thick, dark, slightly irregular in width, and never perfectly straight. Line: the leading is the only linework in the picture, and it closes every shape into a cell; there are no drawn contours inside a pane. Fill: each pane is one jewel hue, or the same hue with a subtle streaked marbling inside the colour, and never a photographic texture. Palette: deep blue, ruby, gold and emerald are the working colours, with a few pale or near-white panes to carry the brightest passages; the palette stays saturated and luminous rather than muted. Lighting: light comes through the panel from behind, so the colours glow from within. The palest and warmest panes are the brightest, the deep blues and emeralds sit darker, and the leading reads as the darkest element. There are no cast shadows lying across the glass and no bloom spilling outside it. Composition: simple, graceful, broad shapes that read as one panel — leading follows the form of what is depicted rather than a grid of small equal squares, and the arrangement stays balanced and calm, close to symmetry without being rigid. A plain stone reveal may frame the panel edge; a full architectural surround, window furniture or a room interior may not. Keep the contract content-independent: no fixed sacred figure, saint, emblem, wording or copied window.
Exclude: photograph, photorealistic, camera render, 3D render, CGI, glossy, glass reflection, glare, specular highlight, transparent window, room interior, church architecture, window frame, stone tracery wall, grid of many small equal panes, geometric honeycomb, cartoon, anime, cel shading, thick outer outline, ink contour, flat vector, watercolour, oil paint, neon, rainbow palette, muted palette, cast shadow across the glass, bloom, lettering, numbers, captions, signature, watermark, logo, copied reference window
```

</details>

### clean-editorial-illustration — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `bbda9d64-1f71-428b-9250-4e3cc45feae8` (final state `succeeded`)
- Seed: `10261001` · Idempotency-Key: `style-preview-20261026-clean-editorial-illustration-hero-0d13024abdf4893af2c97e35`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1124555 bytes, SHA-256 `f4bd317c2f0c4b314f84fe0ecfe390c5bbc92a3523645bcecdcd9becdfce8027`
- Final: `custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration.webp`, 1672x941 WebP, 96932 bytes, SHA-256 `09ace08a48e391afe9a892cb80455e26cf5cd56f326ac269c6bf47b3e417341d`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A MODERN EDITORIAL ILLUSTRATION of large flat grainy shapes and simple confident linework on off-white paper.

One hand holding a compact camera at chest height, built from a few large flat grainy shapes in navy, slate and coral on an off-white ground, with generous space around it.

Rendering contract: A modern editorial illustration made for a printed page: one clear idea, one clear focal subject, and a making that is visibly hand-controlled rather than generated by geometry. Medium and surface: flat shapes are laid on an off-white paper ground that keeps a fine, even grain; inside each shape the colour carries the same soft grain together with a subtle tonal shift, so a plane is never a dead, perfectly even fill. There is no gradient mesh, no airbrush and no photographic texture. Line: a confident, simple line runs around and occasionally through the shapes — one or two weights only, occasionally broken where a form turns into the light, and slightly uneven in a way a hand produces; it is never a uniform machine stroke and never a heavy comic contour. Fill: a small number of large, calm flat shapes rather than many small busy ones, with at most one subtle shadow step to separate two planes. Palette: muted navy, slate, sand and coral against the off-white ground, held low in saturation and close in value so the picture reads as intelligent and calm rather than as a poster shouting. Composition: generous white space, clearly asymmetric balance, one dominant focal subject with a readable silhouette, and crisp edges that survive being scaled down to a phone; supporting elements stay few and quiet. Register: a business-magazine or op-ed illustration, not an explainer diagram — no arrows, no charts, no labelled callouts, no UI panels, no icon grids. Keep the contract content-independent: no fixed subject, brand, place, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, gradient mesh, airbrush, smooth vector gradient, perfectly even flat fill with no grain, hard geometric bauhaus shapes, explainer diagram, arrows, callout labels, charts, graphs, icon grid, UI panels, app screenshot, neon, oversaturated, candy colour, heavy comic outline, thick ink contour, cross-hatching, scratchy pen texture, watercolour wash, oil paint, anime, cartoon mascot, chibi, clutter, busy detail, lettering, captions, signature, watermark, logo, border, copied reference composition
```

</details>

### clean-editorial-illustration — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `67a60224-99b3-4008-af2a-def00f4779bb` (final state `succeeded`)
- Seed: `10261002` · Idempotency-Key: `style-preview-20261026-clean-editorial-illustration-scene-b6fd95348e019cb930099a53`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 990735 bytes, SHA-256 `23c9955944f40bdacb220c34554f1f41970a180a84f2b6c4f7cb85615c31d14d`
- Final: `custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration-scene.webp`, 1672x941 WebP, 67320 bytes, SHA-256 `96a1ccf6ec6ce1d6a030d4c08fb853e304fbbbe34c4693e741f805c31500d0db`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A MODERN EDITORIAL ILLUSTRATION of large flat grainy shapes and simple confident linework on off-white paper.

An empty reading-room corner: a desk, a chair, a lamp and a tall stack of books, described with a small number of large flat shapes and a single soft shadow step. No people.

Rendering contract: A modern editorial illustration made for a printed page: one clear idea, one clear focal subject, and a making that is visibly hand-controlled rather than generated by geometry. Medium and surface: flat shapes are laid on an off-white paper ground that keeps a fine, even grain; inside each shape the colour carries the same soft grain together with a subtle tonal shift, so a plane is never a dead, perfectly even fill. There is no gradient mesh, no airbrush and no photographic texture. Line: a confident, simple line runs around and occasionally through the shapes — one or two weights only, occasionally broken where a form turns into the light, and slightly uneven in a way a hand produces; it is never a uniform machine stroke and never a heavy comic contour. Fill: a small number of large, calm flat shapes rather than many small busy ones, with at most one subtle shadow step to separate two planes. Palette: muted navy, slate, sand and coral against the off-white ground, held low in saturation and close in value so the picture reads as intelligent and calm rather than as a poster shouting. Composition: generous white space, clearly asymmetric balance, one dominant focal subject with a readable silhouette, and crisp edges that survive being scaled down to a phone; supporting elements stay few and quiet. Register: a business-magazine or op-ed illustration, not an explainer diagram — no arrows, no charts, no labelled callouts, no UI panels, no icon grids. Keep the contract content-independent: no fixed subject, brand, place, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, gradient mesh, airbrush, smooth vector gradient, perfectly even flat fill with no grain, hard geometric bauhaus shapes, explainer diagram, arrows, callout labels, charts, graphs, icon grid, UI panels, app screenshot, neon, oversaturated, candy colour, heavy comic outline, thick ink contour, cross-hatching, scratchy pen texture, watercolour wash, oil paint, anime, cartoon mascot, chibi, clutter, busy detail, lettering, captions, signature, watermark, logo, border, copied reference composition
```

</details>

### clean-editorial-illustration — hardest

- Variant: the hardest legal case for the style
- Gateway job: `572faee8-a5ff-44d5-a229-ade42c7e008f` (final state `succeeded`)
- Seed: `10261003` · Idempotency-Key: `style-preview-20261026-clean-editorial-illustration-hardest-de599b28654b50a0da79ae10`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1207355 bytes, SHA-256 `e2e6b160373f43eaa7e1717eb9bb0c2ae3983d18c8bcb0a5a5992e7b768cd82a`
- Final: `custom-looks/style/clean-editorial-illustration/assets/clean-editorial-illustration-hardest.webp`, 1672x941 WebP, 94674 bytes, SHA-256 `d8cbe9ec6bc8d79e6e53d2455006ad6e52a82fc56d1cd022410a63274d2eb87d`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A MODERN EDITORIAL ILLUSTRATION of large flat grainy shapes and simple confident linework on off-white paper.

A small group of three figures in conversation seen from behind at a distance, held to simple flat silhouettes with one subtle shadow step separating them so the picture still reads clearly at phone size.

Rendering contract: A modern editorial illustration made for a printed page: one clear idea, one clear focal subject, and a making that is visibly hand-controlled rather than generated by geometry. Medium and surface: flat shapes are laid on an off-white paper ground that keeps a fine, even grain; inside each shape the colour carries the same soft grain together with a subtle tonal shift, so a plane is never a dead, perfectly even fill. There is no gradient mesh, no airbrush and no photographic texture. Line: a confident, simple line runs around and occasionally through the shapes — one or two weights only, occasionally broken where a form turns into the light, and slightly uneven in a way a hand produces; it is never a uniform machine stroke and never a heavy comic contour. Fill: a small number of large, calm flat shapes rather than many small busy ones, with at most one subtle shadow step to separate two planes. Palette: muted navy, slate, sand and coral against the off-white ground, held low in saturation and close in value so the picture reads as intelligent and calm rather than as a poster shouting. Composition: generous white space, clearly asymmetric balance, one dominant focal subject with a readable silhouette, and crisp edges that survive being scaled down to a phone; supporting elements stay few and quiet. Register: a business-magazine or op-ed illustration, not an explainer diagram — no arrows, no charts, no labelled callouts, no UI panels, no icon grids. Keep the contract content-independent: no fixed subject, brand, place, wording or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, gradient mesh, airbrush, smooth vector gradient, perfectly even flat fill with no grain, hard geometric bauhaus shapes, explainer diagram, arrows, callout labels, charts, graphs, icon grid, UI panels, app screenshot, neon, oversaturated, candy colour, heavy comic outline, thick ink contour, cross-hatching, scratchy pen texture, watercolour wash, oil paint, anime, cartoon mascot, chibi, clutter, busy detail, lettering, captions, signature, watermark, logo, border, copied reference composition
```

</details>

### museum-diorama — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `63c28a07-503b-4ec8-add1-92925d991881` (final state `succeeded`)
- Seed: `10261101` · Idempotency-Key: `style-preview-20261026-museum-diorama-hero-94e147758ec70f455da55400`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1340343 bytes, SHA-256 `d77edf4b49280c125063cd14f9a919bfb8ef1e33c3c6ccc61c3ec72b8eeb3660`
- Final: `custom-looks/style/museum-diorama/assets/museum-diorama.webp`, 1672x941 WebP, 245032 bytes, SHA-256 `9ee5bddf6080e86d8110a81145d3081a2d50facb4a3c918f6e6d3786a8ea93c0`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A PHOTOGRAPHED MUSEUM DIORAMA: hand-built painted models standing in front of a curved painted backdrop under warm exhibit light.

A natural-history diorama of a woodland clearing: a sculpted fox standing on a modelled forest floor of painted leaves and cut-paper ferns, with a curved painted backdrop of layered trees behind it and warm display light from above.

Rendering contract: A photographed natural-history museum exhibit — the objects in the frame are hand-built, and the picture is honest about that. Medium and surface: everything in front of the backdrop is a physical model, sculpted and painted by hand. Fur, feather and foliage read as shaped and painted material rather than as living tissue; a sculpted tool mark, a slightly matte patch, a wired stem or a painted eye is part of the look and is welcome rather than hidden. Palette: warm exhibit light — amber, ochre, warm brown — on the modelled group, the painted backdrop carrying a softer, hazier version of the same colours so distance reads as paint rather than as blur, and the room beyond the case falling into cool dim shadow. Lighting: warm display light from above and in front of the group, with a gentle falloff that lets the outer edges of the case go dark; the space outside the diorama stays dim and cool. There is no studio softbox and no neutral sweep. Composition: a wide visitor's-eye view — a modelled foreground of painted ground or a plinth edge, the group in the middle plane, and the curved painted backdrop filling the upper and rear field, with the seam where the modelled floor meets the backdrop often visible. The framing is calm, full and educational, carrying a sense of awe rather than drama. No people in the frame, no crowd, no glass reflection, no label boards and no lettering anywhere. Keep the contract content-independent: no fixed species, era, museum or copied exhibit composition.
Exclude: photograph of a living animal, living creature in a natural habitat, wildlife photograph, photoreal skin, wet nose, individual hair strands, glossy fabric, studio catalog photography, neutral grey sweep, product photography, softbox lighting, white background, flat even light, film still, 3D render, CGI, digital painting, watercolour, oil painting, cartoon, anime, cel shading, thick ink outline, children's sticker art, glass reflection, glare, vignetting, people, visitors, crowd, hands, label board, museum placard, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### museum-diorama — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `06dab152-26a0-4f11-ad12-6bd50e908529` (final state `succeeded`)
- Seed: `10261102` · Idempotency-Key: `style-preview-20261026-museum-diorama-scene-3fe05b2fc59714f67917e198`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1293105 bytes, SHA-256 `8a2e3a1f1317b121426b99cda13ce55bab03aa081a11a8208093d41786e6af44`
- Final: `custom-looks/style/museum-diorama/assets/museum-diorama-scene.webp`, 1672x941 WebP, 205064 bytes, SHA-256 `12f6def4961ee02a919ecd4992244e763e9f4ebac92945c372ef702b905a7147`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A PHOTOGRAPHED MUSEUM DIORAMA: a hand-built painted set standing in front of a curved painted backdrop under warm exhibit light, with an empty stage and no specimen, animal or figure.

A museum diorama of an empty coastal cliff set: modelled rock with lichen, a scatter of shells and painted shingle on a modelled floor, standing in front of a curved painted backdrop of sea and sky that wraps around behind it, with the visible seam where the floor meets the backdrop. The stage is empty — no specimen, no stuffed animal, no figure, no person and no creature anywhere in the frame; only the built set, the painted backdrop and the warm exhibit light.

Rendering contract: A photographed natural-history museum exhibit — the objects in the frame are hand-built, and the picture is honest about that. Medium and surface: everything in front of the backdrop is a physical model, sculpted and painted by hand; rock, earth, foliage and water read as shaped and painted material rather than as living tissue, and a sculpted tool mark, a slightly matte patch or a painted highlight is part of the look and is welcome rather than hidden. Palette: warm exhibit light — amber, ochre, warm brown — on the modelled foreground, the painted backdrop carrying a softer, hazier version of the same colours so distance reads as paint rather than as blur, and the room beyond the case falling into cool dim shadow. Lighting: warm display light from above and in front of the set, with a gentle falloff that lets the outer edges of the case go dark; the space outside the diorama stays dim and cool. There is no studio softbox and no neutral sweep. Composition: a wide visitor's-eye view — a modelled foreground of painted ground or a plinth edge, an empty middle plane, and the curved painted backdrop filling the upper and rear field, with the seam where the modelled floor meets the backdrop often visible. The stage carries no specimen, no animal, no figure and no person in the frame; it is the empty set only, calm, full and educational. No crowd, no glass reflection, no label boards and no lettering anywhere. Keep the contract content-independent: no fixed era, museum or copied exhibit composition.
Exclude: photograph of a living animal, living creature in a natural habitat, wildlife photograph, photoreal skin, wet nose, individual hair strands, glossy fabric, studio catalog photography, neutral grey sweep, product photography, softbox lighting, white background, flat even light, film still, 3D render, CGI, digital painting, watercolour, oil painting, cartoon, anime, cel shading, thick ink outline, children's sticker art, glass reflection, glare, vignetting, people, visitors, crowd, hands, label board, museum placard, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition, specimen, mounted animal, stuffed animal, taxidermy, animal model, bear, bird, rodent, fox, creature, figure, person, human, silhouette, statue of an animal
```

</details>

### museum-diorama — hardest

- Variant: the hardest legal case for the style
- Gateway job: `bbba5bb1-5ead-4522-b71a-e22c4eaef879` (final state `succeeded`)
- Seed: `10261103` · Idempotency-Key: `style-preview-20261026-museum-diorama-hardest-0a7c10992ae1f6ac6eeb0fd2`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1321207 bytes, SHA-256 `b078fab16ec65e43952d1ccdcc9912c5e492abee5aaf54c4122e6acaa5a29d2f`
- Final: `custom-looks/style/museum-diorama/assets/museum-diorama-hardest.webp`, 1672x941 WebP, 194512 bytes, SHA-256 `2896c28d8fb81e5634a039ba2b834661e8d06b7e15927c77b8ee9958064cb420`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A PHOTOGRAPHED MUSEUM DIORAMA: hand-built painted models standing in front of a curved painted backdrop under warm exhibit light.

A diorama holding several large specimens at once — a standing bear, a bird mounted on a branch and a small group of rodents at the base — arranged before a painted tundra backdrop, with the modelled joins, matte paint and painted eyes of the hand-built figures clearly visible.

Rendering contract: A photographed natural-history museum exhibit — the objects in the frame are hand-built, and the picture is honest about that. Medium and surface: everything in front of the backdrop is a physical model, sculpted and painted by hand. Fur, feather and foliage read as shaped and painted material rather than as living tissue; a sculpted tool mark, a slightly matte patch, a wired stem or a painted eye is part of the look and is welcome rather than hidden. Palette: warm exhibit light — amber, ochre, warm brown — on the modelled group, the painted backdrop carrying a softer, hazier version of the same colours so distance reads as paint rather than as blur, and the room beyond the case falling into cool dim shadow. Lighting: warm display light from above and in front of the group, with a gentle falloff that lets the outer edges of the case go dark; the space outside the diorama stays dim and cool. There is no studio softbox and no neutral sweep. Composition: a wide visitor's-eye view — a modelled foreground of painted ground or a plinth edge, the group in the middle plane, and the curved painted backdrop filling the upper and rear field, with the seam where the modelled floor meets the backdrop often visible. The framing is calm, full and educational, carrying a sense of awe rather than drama. No people in the frame, no crowd, no glass reflection, no label boards and no lettering anywhere. Keep the contract content-independent: no fixed species, era, museum or copied exhibit composition.
Exclude: photograph of a living animal, living creature in a natural habitat, wildlife photograph, photoreal skin, wet nose, individual hair strands, glossy fabric, studio catalog photography, neutral grey sweep, product photography, softbox lighting, white background, flat even light, film still, 3D render, CGI, digital painting, watercolour, oil painting, cartoon, anime, cel shading, thick ink outline, children's sticker art, glass reflection, glare, vignetting, people, visitors, crowd, hands, label board, museum placard, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### cosy-night-pixel-art — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `1eea5d68-3b2f-495e-b944-19c970a37ea2` (final state `succeeded`)
- Seed: `10261201` · Idempotency-Key: `style-preview-20261026-cosy-night-pixel-art-hero-28e9831a3d116d1872f18500`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 703165 bytes, SHA-256 `2cc3c312d165ef3967978a353b3bad17ffc7e96c2ac71843895b6495b90de6d7`
- Final: `custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art.webp`, 1672x941 WebP, 44080 bytes, SHA-256 `0170f5d1d158d49d015ce15e796bda6ddc14cdf1262c3a740a45f22e439e2aa1`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
LOW-RESOLUTION 16-BIT PIXEL ART with visible square pixels and a limited night-blue, lavender and lamplight palette.

A cosy bedroom at night in pixel art: a low bed with a folded quilt, a bedside table carrying a small lamp, a curtained window showing a deep blue sky, and a rug on the floorboards.

Rendering contract: Pixel art built at a low logical resolution and scaled up, so that every pixel is a visible square. Medium and surface: hand-placed pixels on a regular grid; diagonals show clean aliased stair-stepping, every edge is hard, and there is no anti-aliasing, no smoothing and no soft gradient anywhere — values change in discrete steps and, where two steps need bridging, a small amount of ordered dithering does it. Palette: one small fixed ramp — three or four night blues from the mid-blue down to blue-violet, two lavenders, and two or three warm lamplight tones — used consistently so the whole picture reads as one coherent set of colours. Value: deliberately low contrast. The lightest tone stays a soft cream rather than pure white and the darkest a deep blue-violet rather than black, so nothing on the screen glares. Lighting: one or two small warm pools cast by a lamp, a window or a candle, with the rest of the frame staying cool and quiet; light falls in stepped pixel bands rather than as a gradient. Composition: calm, simple and uncluttered — one room, one window, one quiet view, with generous areas of flat pixel colour and detail concentrated where the light is. This is a bedtime register, restful rather than playful. No game interface of any kind: no HUD, no health bar, no inventory grid, no dialogue box, no tileset, no side-scrolling platform arrangement, no character sprite in action. No lettering, numbers or captions.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, anti-aliasing, smooth gradient, soft shading, airbrush, high resolution detail, single-pixel noise, dithering noise everywhere, high contrast, pure black, pure white, neon, saturated colour, rainbow palette, game UI, HUD, health bar, inventory, dialogue box, tileset grid, side-scrolling level, platformer, character sprite in action, combat, menu text, pixel font, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### cosy-night-pixel-art — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `f16301ef-4912-4f07-8c15-d78e0ada9112` (final state `succeeded`)
- Seed: `10261202` · Idempotency-Key: `style-preview-20261026-cosy-night-pixel-art-scene-a79f2981d5462b5f3472181f`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 654329 bytes, SHA-256 `128858b066a9ec6f6888794ac8ace0a08e8b75995e6cc5dbde745713c200adaa`
- Final: `custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art-scene.webp`, 1672x941 WebP, 43204 bytes, SHA-256 `484a9d9d09714133a42d944d61ee0621ecdb5fb636e4dfbcae30a9e7d17522c3`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
LOW-RESOLUTION 16-BIT PIXEL ART with visible square pixels and a limited night-blue, lavender and lamplight palette.

A quiet room corner in pixel art with a bookshelf, an armchair, a floor lamp and a potted plant, lit only by the lamp, with a deep blue window beyond. No figure in the room.

Rendering contract: Pixel art built at a low logical resolution and scaled up, so that every pixel is a visible square. Medium and surface: hand-placed pixels on a regular grid; diagonals show clean aliased stair-stepping, every edge is hard, and there is no anti-aliasing, no smoothing and no soft gradient anywhere — values change in discrete steps and, where two steps need bridging, a small amount of ordered dithering does it. Palette: one small fixed ramp — three or four night blues from the mid-blue down to blue-violet, two lavenders, and two or three warm lamplight tones — used consistently so the whole picture reads as one coherent set of colours. Value: deliberately low contrast. The lightest tone stays a soft cream rather than pure white and the darkest a deep blue-violet rather than black, so nothing on the screen glares. Lighting: one or two small warm pools cast by a lamp, a window or a candle, with the rest of the frame staying cool and quiet; light falls in stepped pixel bands rather than as a gradient. Composition: calm, simple and uncluttered — one room, one window, one quiet view, with generous areas of flat pixel colour and detail concentrated where the light is. This is a bedtime register, restful rather than playful. No game interface of any kind: no HUD, no health bar, no inventory grid, no dialogue box, no tileset, no side-scrolling platform arrangement, no character sprite in action. No lettering, numbers or captions.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, anti-aliasing, smooth gradient, soft shading, airbrush, high resolution detail, single-pixel noise, dithering noise everywhere, high contrast, pure black, pure white, neon, saturated colour, rainbow palette, game UI, HUD, health bar, inventory, dialogue box, tileset grid, side-scrolling level, platformer, character sprite in action, combat, menu text, pixel font, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### cosy-night-pixel-art — hardest

- Variant: the hardest legal case for the style
- Gateway job: `480a07a8-54fa-47de-9d44-fd1d0ab0424c` (final state `succeeded`)
- Seed: `10261203` · Idempotency-Key: `style-preview-20261026-cosy-night-pixel-art-hardest-4ebe62b8fc44999691e51714`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 578983 bytes, SHA-256 `c01592d192178b8afb2f0321764283808d8e868f974cc984fdeb64c2528f50f3`
- Final: `custom-looks/style/cosy-night-pixel-art/assets/cosy-night-pixel-art-hardest.webp`, 1672x941 WebP, 34056 bytes, SHA-256 `0d1cd55e3c92f94d560accd117525aae44dc430e0515726fb7ba4bdf2c16d8d1`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
LOW-RESOLUTION 16-BIT PIXEL ART with visible square pixels and a limited night-blue, lavender and lamplight palette.

A pixel-art window looking out over rooftops at night: layered roof silhouettes at different depths, small lit windows, a moon and scattered stars, kept to a limited colour ramp with stepped dithering and no gradients anywhere.

Rendering contract: Pixel art built at a low logical resolution and scaled up, so that every pixel is a visible square. Medium and surface: hand-placed pixels on a regular grid; diagonals show clean aliased stair-stepping, every edge is hard, and there is no anti-aliasing, no smoothing and no soft gradient anywhere — values change in discrete steps and, where two steps need bridging, a small amount of ordered dithering does it. Palette: one small fixed ramp — three or four night blues from the mid-blue down to blue-violet, two lavenders, and two or three warm lamplight tones — used consistently so the whole picture reads as one coherent set of colours. Value: deliberately low contrast. The lightest tone stays a soft cream rather than pure white and the darkest a deep blue-violet rather than black, so nothing on the screen glares. Lighting: one or two small warm pools cast by a lamp, a window or a candle, with the rest of the frame staying cool and quiet; light falls in stepped pixel bands rather than as a gradient. Composition: calm, simple and uncluttered — one room, one window, one quiet view, with generous areas of flat pixel colour and detail concentrated where the light is. This is a bedtime register, restful rather than playful. No game interface of any kind: no HUD, no health bar, no inventory grid, no dialogue box, no tileset, no side-scrolling platform arrangement, no character sprite in action. No lettering, numbers or captions.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, anti-aliasing, smooth gradient, soft shading, airbrush, high resolution detail, single-pixel noise, dithering noise everywhere, high contrast, pure black, pure white, neon, saturated colour, rainbow palette, game UI, HUD, health bar, inventory, dialogue box, tileset grid, side-scrolling level, platformer, character sprite in action, combat, menu text, pixel font, lettering, numbers, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### matte-gouache-storybook — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `b847ea23-2932-4321-8912-a0457b77ad3f` (final state `succeeded`)
- Seed: `10261301` · Idempotency-Key: `style-preview-20261026-matte-gouache-storybook-hero-f89f7fd2d5ebcbb665bc4e06`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1365086 bytes, SHA-256 `381539981674e827d7199eb3cd81b684ad2a6dfbff61d0bb898dee1089c8344d`
- Final: `custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook.webp`, 1672x941 WebP, 135246 bytes, SHA-256 `c245d53e3f4e7ad056ed941ff725a5a0bece68cefc5e38dd6c105807f6082b42`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
AN OPAQUE MATTE GOUACHE PICTURE-BOOK PAINTING, chalky flat paint with dry-brush edges and no transparent wash.

A small windmill on a low hill with a trimmed hedge, a few rounded clouds and a broad pale field, painted in flat chalky gouache under calm evening light.

Rendering contract: A picture-book painting in opaque gouache, where the paint is chalky and matte and never transparent. Medium and surface: gouache laid thickly enough to cover completely, so every shape is an opaque flat of colour with the gentle unevenness of hand-applied paint. There are no transparent washes, no colour bleeding beyond a shape's edge, no wet-in-wet blooms, no granulation and no visible pencil underdrawing. Brushwork: dry-brush strokes carry a visible tooth, and shape edges are soft and slightly ragged from the chalkiness of the medium — a hand-cut edge, never a hard vector line. Forms are built from a few broad simple strokes, with rounded, simplified shapes and only light hand-drawn detail inside them. Palette: gentle and muted — dusty blue, sage green, warm ochre and a soft warm off-white — held at low saturation with harmonious values so no single colour jumps forward. Lighting: soft, calm evening light, with gentle warm highlights and quiet shadows; contrast stays low and nothing is lit by a hard key. Composition: clear and simple picture-book staging with one readable focal point and calm space around it, built to be read at small size. A fine chalky paper tooth is visible in the dry passages. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, transparent watercolour, wet-in-wet wash, watercolour bloom, colour bleeding outside shapes, pigment granulation, pencil underdrawing, visible sketch lines, ink outline, thick contour, hard vector edge, smooth digital gradient, airbrush, oil paint impasto, canvas weave, high contrast, saturated colour, neon, candy colour, dramatic key light, anime, manga, cel shading, detailed realistic anatomy, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### matte-gouache-storybook — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `f08eedfa-d44b-4ce1-81b4-f1c799e927f9` (final state `succeeded`)
- Seed: `10261302` · Idempotency-Key: `style-preview-20261026-matte-gouache-storybook-scene-122713b9baa4fd562ab4ed1b`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1610903 bytes, SHA-256 `f156f4c12c186e5cf6e6cc56fde980bd3d0098e4cc4fb54050250606bea9e304`
- Final: `custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook-scene.webp`, 1672x941 WebP, 288458 bytes, SHA-256 `dc2d83dbc6119800b822e3cb64ece6fb59522b8ab69718845b1352d128f4bd7a`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
AN OPAQUE MATTE GOUACHE PICTURE-BOOK PAINTING, chalky flat paint with dry-brush edges and no transparent wash.

An empty farmyard at evening: a barn, a water trough, a stacked woodpile and a low fence, painted in chalky opaque flats with dry-brush edges. Nothing living is in the frame.

Rendering contract: A picture-book painting in opaque gouache, where the paint is chalky and matte and never transparent. Medium and surface: gouache laid thickly enough to cover completely, so every shape is an opaque flat of colour with the gentle unevenness of hand-applied paint. There are no transparent washes, no colour bleeding beyond a shape's edge, no wet-in-wet blooms, no granulation and no visible pencil underdrawing. Brushwork: dry-brush strokes carry a visible tooth, and shape edges are soft and slightly ragged from the chalkiness of the medium — a hand-cut edge, never a hard vector line. Forms are built from a few broad simple strokes, with rounded, simplified shapes and only light hand-drawn detail inside them. Palette: gentle and muted — dusty blue, sage green, warm ochre and a soft warm off-white — held at low saturation with harmonious values so no single colour jumps forward. Lighting: soft, calm evening light, with gentle warm highlights and quiet shadows; contrast stays low and nothing is lit by a hard key. Composition: clear and simple picture-book staging with one readable focal point and calm space around it, built to be read at small size. A fine chalky paper tooth is visible in the dry passages. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, transparent watercolour, wet-in-wet wash, watercolour bloom, colour bleeding outside shapes, pigment granulation, pencil underdrawing, visible sketch lines, ink outline, thick contour, hard vector edge, smooth digital gradient, airbrush, oil paint impasto, canvas weave, high contrast, saturated colour, neon, candy colour, dramatic key light, anime, manga, cel shading, detailed realistic anatomy, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### matte-gouache-storybook — hardest

- Variant: the hardest legal case for the style
- Gateway job: `d181652c-0f18-4e01-9620-20ef3f1aa4db` (final state `succeeded`)
- Seed: `10261303` · Idempotency-Key: `style-preview-20261026-matte-gouache-storybook-hardest-b3c584bff6b218b1d1906438`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1598166 bytes, SHA-256 `88817f63f3e1c7266934208188a6ae9366a9cfc68b58b666939c78310b47f6ff`
- Final: `custom-looks/style/matte-gouache-storybook/assets/matte-gouache-storybook-hardest.webp`, 1672x941 WebP, 261138 bytes, SHA-256 `901d923b317cd653b60b6b8c21b4f16550feabb5057e7886e5036d76237cabb6`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
AN OPAQUE MATTE GOUACHE PICTURE-BOOK PAINTING, chalky flat paint with dry-brush edges and no transparent wash.

A tightly cropped flowering bush with many leaves and open blossoms built from broad simple strokes, holding the matte opaque surface throughout and avoiding any transparent wash or outline.

Rendering contract: A picture-book painting in opaque gouache, where the paint is chalky and matte and never transparent. Medium and surface: gouache laid thickly enough to cover completely, so every shape is an opaque flat of colour with the gentle unevenness of hand-applied paint. There are no transparent washes, no colour bleeding beyond a shape's edge, no wet-in-wet blooms, no granulation and no visible pencil underdrawing. Brushwork: dry-brush strokes carry a visible tooth, and shape edges are soft and slightly ragged from the chalkiness of the medium — a hand-cut edge, never a hard vector line. Forms are built from a few broad simple strokes, with rounded, simplified shapes and only light hand-drawn detail inside them. Palette: gentle and muted — dusty blue, sage green, warm ochre and a soft warm off-white — held at low saturation with harmonious values so no single colour jumps forward. Lighting: soft, calm evening light, with gentle warm highlights and quiet shadows; contrast stays low and nothing is lit by a hard key. Composition: clear and simple picture-book staging with one readable focal point and calm space around it, built to be read at small size. A fine chalky paper tooth is visible in the dry passages. Content-independent: no fixed character, story, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, transparent watercolour, wet-in-wet wash, watercolour bloom, colour bleeding outside shapes, pigment granulation, pencil underdrawing, visible sketch lines, ink outline, thick contour, hard vector edge, smooth digital gradient, airbrush, oil paint impasto, canvas weave, high contrast, saturated colour, neon, candy colour, dramatic key light, anime, manga, cel shading, detailed realistic anatomy, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### naturalist-watercolour-plate — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `a2a485eb-2c2f-44e2-aa61-c6b9b57ae909` (final state `succeeded`)
- Seed: `10261401` · Idempotency-Key: `style-preview-20261026-naturalist-watercolour-plate-hero-3541be167a43a623cacca821`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1425084 bytes, SHA-256 `2dd5bfb4e9acee5e3d4c2dc1f7ed8f7d8c28b438302cdd39aade1bfc4002ab3f`
- Final: `custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate.webp`, 1672x941 WebP, 165092 bytes, SHA-256 `70afe8c1c072fcabfd6bb624a7f2ad89ed8f4487061d23e42ba7da27428964c6`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FINISHED NINETEENTH-CENTURY NATURALIST PLATE: precise watercolour and gouache over fine ink on aged paper, filling the frame.

A completed naturalist plate of a single large spiral shell, drawn finely and painted in translucent-to-opaque layers, filling the frame edge to edge on warm aged paper.

Rendering contract: A finished nineteenth-century natural-history plate, reproduced from a hand-painted original on aged paper. Medium and surface: precise watercolour and gouache laid over a fine ink drawing. The ink establishes structure and small detail — veins, scales, fibres, joints, the exact edge of a shell — and is drawn finely and deliberately, never as a heavy contour; the paint then builds form in controlled layers that move from translucent in the lights to opaque in the solids. Nothing is loose: there is no wet-in-wet accident, no granulation left as a gesture, and no uncovered sketch. Palette: soft muted earths and sea-greens — ochre, olive, umber, slate green, bone — at low saturation and in harmonious values, with a small saturated note allowed only where the subject itself would show one. Lighting: even, diffuse and observational, describing form with subtle modelled washes rather than with a dramatic key; the light exists to make the specimen legible, not to make a picture. Composition: the subject is painted as a finished plate that fills the frame edge to edge. There is no border, no margin and no ring of blank paper around the subject; the ground behind it is a soft neutral within the same palette, painted rather than left bare. Aged paper: a light even tone and a faint fibrous texture are welcome. Absolutely no labels, plate numbers, captions, handwriting, arrows, scale bars or signatures anywhere in the frame. Content-independent: no fixed species, era, institution or copied plate.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, loose sketch, field-notes page, sketchbook, white paper margin, blank border, unpainted paper edge, pencil underdrawing, construction lines, heavy ink contour, wet-in-wet watercolour accident, watercolour bloom, drips, splatter, granulated wash, palette knife, impasto, canvas weave, airbrush, soft gradient, neon, saturated colour, cartoon, anime, cel shading, vector flat, labels, plate number, caption, handwriting, arrows, scale bar, numbers, lettering, signature, watermark, logo, frame, border, copied reference plate
```

</details>

### naturalist-watercolour-plate — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `665df970-d4e5-4272-985e-90c97f7a3e3f` (final state `succeeded`)
- Seed: `10261402` · Idempotency-Key: `style-preview-20261026-naturalist-watercolour-plate-scene-7f07b1377cc2307861320e5d`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1255646 bytes, SHA-256 `8a54d396c502ce7d35a6bda6a3d9da5a411b1f5119b6765dfff5acd9d4af2501`
- Final: `custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate-scene.webp`, 1672x941 WebP, 93088 bytes, SHA-256 `09cf19ab3502cc00bb0358cfd5f151e8c7bbeecde3ce5c7b0bc7b1244289d3c4`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FINISHED NINETEENTH-CENTURY NATURALIST PLATE: precise watercolour and gouache over fine ink on aged paper, filling the frame.

A finished plate of a single bare branch carrying three seed pods and two leaves, laid diagonally across the picture and filling the whole frame on aged paper, with no white margin and nothing else in view.

Rendering contract: A finished nineteenth-century natural-history plate, reproduced from a hand-painted original on aged paper. Medium and surface: precise watercolour and gouache laid over a fine ink drawing. The ink establishes structure and small detail — veins, scales, fibres, joints, the exact edge of a shell — and is drawn finely and deliberately, never as a heavy contour; the paint then builds form in controlled layers that move from translucent in the lights to opaque in the solids. Nothing is loose: there is no wet-in-wet accident, no granulation left as a gesture, and no uncovered sketch. Palette: soft muted earths and sea-greens — ochre, olive, umber, slate green, bone — at low saturation and in harmonious values, with a small saturated note allowed only where the subject itself would show one. Lighting: even, diffuse and observational, describing form with subtle modelled washes rather than with a dramatic key; the light exists to make the specimen legible, not to make a picture. Composition: the subject is painted as a finished plate that fills the frame edge to edge. There is no border, no margin and no ring of blank paper around the subject; the ground behind it is a soft neutral within the same palette, painted rather than left bare. Aged paper: a light even tone and a faint fibrous texture are welcome. Absolutely no labels, plate numbers, captions, handwriting, arrows, scale bars or signatures anywhere in the frame. Content-independent: no fixed species, era, institution or copied plate.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, loose sketch, field-notes page, sketchbook, white paper margin, blank border, unpainted paper edge, pencil underdrawing, construction lines, heavy ink contour, wet-in-wet watercolour accident, watercolour bloom, drips, splatter, granulated wash, palette knife, impasto, canvas weave, airbrush, soft gradient, neon, saturated colour, cartoon, anime, cel shading, vector flat, labels, plate number, caption, handwriting, arrows, scale bar, numbers, lettering, signature, watermark, logo, frame, border, copied reference plate
```

</details>

### naturalist-watercolour-plate — hardest

- Variant: the hardest legal case for the style
- Gateway job: `60b5fcaf-9db6-4cde-90e7-0861a46cbd4b` (final state `succeeded`)
- Seed: `10261403` · Idempotency-Key: `style-preview-20261026-naturalist-watercolour-plate-hardest-235661bcfd78dedfea4f178d`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1540011 bytes, SHA-256 `96d8b5305cfa5c385be361936a1438ec06cc4d9808828fc07aa986e71c02e4ec`
- Final: `custom-looks/style/naturalist-watercolour-plate/assets/naturalist-watercolour-plate-hardest.webp`, 1672x941 WebP, 231834 bytes, SHA-256 `1acbf4a419a97cc2ac170d6294c3bd6d8acb619479b4e008fc29d82001e82c53`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A FINISHED NINETEENTH-CENTURY NATURALIST PLATE: precise watercolour and gouache over fine ink on aged paper, filling the frame.

A finished naturalist plate of a single butterfly with fully patterned wings: the antennae, legs and wing scales drawn in fine ink and painted in muted earths and sea-greens, filling the frame edge to edge with no plate number, label or margin.

Rendering contract: A finished nineteenth-century natural-history plate, reproduced from a hand-painted original on aged paper. Medium and surface: precise watercolour and gouache laid over a fine ink drawing. The ink establishes structure and small detail — veins, scales, fibres, joints, the exact edge of a shell — and is drawn finely and deliberately, never as a heavy contour; the paint then builds form in controlled layers that move from translucent in the lights to opaque in the solids. Nothing is loose: there is no wet-in-wet accident, no granulation left as a gesture, and no uncovered sketch. Palette: soft muted earths and sea-greens — ochre, olive, umber, slate green, bone — at low saturation and in harmonious values, with a small saturated note allowed only where the subject itself would show one. Lighting: even, diffuse and observational, describing form with subtle modelled washes rather than with a dramatic key; the light exists to make the specimen legible, not to make a picture. Composition: the subject is painted as a finished plate that fills the frame edge to edge. There is no border, no margin and no ring of blank paper around the subject; the ground behind it is a soft neutral within the same palette, painted rather than left bare. Aged paper: a light even tone and a faint fibrous texture are welcome. Absolutely no labels, plate numbers, captions, handwriting, arrows, scale bars or signatures anywhere in the frame. Content-independent: no fixed species, era, institution or copied plate.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, loose sketch, field-notes page, sketchbook, white paper margin, blank border, unpainted paper edge, pencil underdrawing, construction lines, heavy ink contour, wet-in-wet watercolour accident, watercolour bloom, drips, splatter, granulated wash, palette knife, impasto, canvas weave, airbrush, soft gradient, neon, saturated colour, cartoon, anime, cel shading, vector flat, labels, plate number, caption, handwriting, arrows, scale bar, numbers, lettering, signature, watermark, logo, frame, border, copied reference plate
```

</details>

### painterly-prehistoric-life — hero

- Variant: the hero, and the Style Library card image
- Gateway job: `db46869a-d2e2-452e-b81e-aefff051d256` (final state `succeeded`)
- Seed: `10261501` · Idempotency-Key: `style-preview-20261026-painterly-prehistoric-life-hero-b7d9658f789ee14687f03cf3`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1560280 bytes, SHA-256 `0047f04bf1bbc791dec8c1fbda772bb65700eef7af15f2646b6a198d9bc9dd2b`
- Final: `custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life.webp`, 1672x941 WebP, 247162 bytes, SHA-256 `3200658fc237cc8d701cbd9397a4a15f1d5c550104cfe959a258968ed0f3d797`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED ILLUSTRATION of early human life with visible textured brushwork, warm firelight and realistic proportions.

A small group of early humans around a low fire inside a rock shelter at dusk: one tending the fire, one shaping a stone tool, a stretched hide and simple woven baskets nearby, all painted in warm firelight with visible textured brushwork.

Rendering contract: A hand-painted illustration of early human life, made with visible, textured brushwork. Medium and surface: loaded, dry and scumbled strokes that show the bristle and the tooth underneath, with the paint left visibly handled rather than blended away; edges are painterly and soft, with a few firm passages where a fire catches a face or a tool. Palette: ochre, umber, warm earth red, bone and charcoal, with cool notes reserved for shadow and distance so the fire keeps the temperature of the picture. Lighting: one low, warm, localised source — a fire, a torch, a cave mouth, a low sun — pooling on the figures and the ground around them and letting the rest of the place fall into deep but legible shade. Figures: early humans drawn with realistic adult proportions, believable posture and period-appropriate simple dress and tools; faces are shaped and individual, never caricatured, and they are shown doing something — working stone, tending a fire, carrying, cooking, resting, watching. Setting: natural prehistoric shelter and landscape — rock, earth, grass, water, timber — painted convincingly as a place rather than decoratively as a backdrop. Mood: grounded and educational, calm in composition, with one clear human activity as the focal subject, layered depth and room around it. Animals appear only where the narration names them, painted with the same realism. Not cartoonish, no fantasy creatures, no invented technology. Content-independent: no fixed person, era, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, cartoon, cartoonish, anime, manga, chibi, caricature, exaggerated proportions, mascot, sticker art, flat vector, cel shading, thick ink outline, comic contour, neon, saturated colour, pastel candy palette, cool teal colour lock, misty monochrome, white background, empty landscape with no people, dinosaur park, fantasy creature, dragon, magic, invented machinery, modern clothing, modern object, weapons used in violence, gore, blood, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>

### painterly-prehistoric-life — scene

- Variant: a quiet wide scene with no figure in it
- Gateway job: `46d7a4a7-7c7c-49b7-85df-ad8e9a538f8c` (final state `succeeded`)
- Seed: `10261502` · Idempotency-Key: `style-preview-20261026-painterly-prehistoric-life-scene-37685ac2cf01e31088c8e6b3`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1492816 bytes, SHA-256 `eda1b061bc3a1449da0366060e14a9056704a8121b79b05e6c986f2f60dcfe29`
- Final: `custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life-scene.webp`, 1672x941 WebP, 255624 bytes, SHA-256 `c7c3a70147c784a58ad71b9324370040c981c683a4da616270951bd9daf99684`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED LANDSCAPE ILLUSTRATION with visible textured brushwork, in the ochre-and-umber palette of prehistoric country, showing a wide place and its atmosphere with no one in it.

A wide empty prehistoric valley at dawn: a shallow braided river winding between scattered boulders, stands of dry grass and low hills receding into cool morning shade, under a large pale sky. Nothing living is anywhere in the frame — no people, no humans, no animals, no creatures, no figures of any kind; only the valley, the water, the rock, the grass and the morning light.

Rendering contract: A hand-painted landscape illustration made with visible, textured brushwork. Medium and surface: loaded, dry and scumbled strokes that show the bristle and the tooth underneath, with the paint left visibly handled rather than blended away; edges are painterly and soft. Palette: ochre, umber, warm earth red, bone and charcoal, with cool notes reserved for shadow and distance so the light keeps the temperature of the picture. Lighting: one low, warm, localised source — a low sun or a pale dawn sky — pooling across the ground and letting the far hills fall into deep but legible cool shade. Setting: natural prehistoric landscape — rock, earth, grass and water — painted convincingly as a place rather than decoratively as a backdrop, with layered depth and generous open space. Mood: grounded, calm and atmospheric, wide and quiet. This picture is a place and its weather only: no people, no humans, no figures, no silhouettes of figures; no animals, no creatures, no wildlife, no birds, no fish, no insects anywhere in the frame. Not cartoonish, no fantasy, no invented technology. Content-independent: no fixed era, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, cartoon, cartoonish, anime, manga, chibi, caricature, exaggerated proportions, mascot, sticker art, flat vector, cel shading, thick ink outline, comic contour, neon, saturated colour, pastel candy palette, cool teal colour lock, misty monochrome, white background, dinosaur park, fantasy creature, dragon, magic, invented machinery, modern clothing, modern object, weapons used in violence, gore, blood, lettering, captions, signature, watermark, logo, border, frame, copied reference composition, early humans, cavemen, hunters, campfire with people, dinosaur park, animals, creatures, wildlife, birds, fish, insects, silhouettes of figures, group of people
```

</details>

### painterly-prehistoric-life — hardest

- Variant: the hardest legal case for the style
- Gateway job: `1992166e-7168-4fb2-b20d-2586f9f21d4b` (final state `succeeded`)
- Seed: `10261503` · Idempotency-Key: `style-preview-20261026-painterly-prehistoric-life-hardest-dd2a8ae202296135de5b5d06`
- Requested: 16:9 1K → 1280x720
- Price at request: credits_per_image=0, chargeable=false, minimum_credits=0
- Original: `1280x720` PNG, 1614141 bytes, SHA-256 `087141924bae7184406185f6c5c14488bff93fc809b9743f5c0c777adfbd7bd9`
- Final: `custom-looks/style/painterly-prehistoric-life/assets/painterly-prehistoric-life-hardest.webp`, 1672x941 WebP, 272096 bytes, SHA-256 `db86f08127eaabaac51d07281a70d61fe913b2375f44a93ef8e22b3837132a91`
- Paired encode byte-identity: PASS · full decode: passed

<details><summary>Exact prompt submitted</summary>

```text
A HAND-PAINTED ILLUSTRATION of early human life with visible textured brushwork, warm firelight and realistic proportions.

A single early human figure carrying a bundle across open ground in low warm light, with realistic adult proportions, a shaped individual face and period-appropriate simple dress, and no cartoon exaggeration.

Rendering contract: A hand-painted illustration of early human life, made with visible, textured brushwork. Medium and surface: loaded, dry and scumbled strokes that show the bristle and the tooth underneath, with the paint left visibly handled rather than blended away; edges are painterly and soft, with a few firm passages where a fire catches a face or a tool. Palette: ochre, umber, warm earth red, bone and charcoal, with cool notes reserved for shadow and distance so the fire keeps the temperature of the picture. Lighting: one low, warm, localised source — a fire, a torch, a cave mouth, a low sun — pooling on the figures and the ground around them and letting the rest of the place fall into deep but legible shade. Figures: early humans drawn with realistic adult proportions, believable posture and period-appropriate simple dress and tools; faces are shaped and individual, never caricatured, and they are shown doing something — working stone, tending a fire, carrying, cooking, resting, watching. Setting: natural prehistoric shelter and landscape — rock, earth, grass, water, timber — painted convincingly as a place rather than decoratively as a backdrop. Mood: grounded and educational, calm in composition, with one clear human activity as the focal subject, layered depth and room around it. Animals appear only where the narration names them, painted with the same realism. Not cartoonish, no fantasy creatures, no invented technology. Content-independent: no fixed person, era, place or copied composition.
Exclude: photoreal, photograph, photorealistic, 3D render, CGI, glossy, cartoon, cartoonish, anime, manga, chibi, caricature, exaggerated proportions, mascot, sticker art, flat vector, cel shading, thick ink outline, comic contour, neon, saturated colour, pastel candy palette, cool teal colour lock, misty monochrome, white background, empty landscape with no people, dinosaur park, fantasy creature, dragon, magic, invented machinery, modern clothing, modern object, weapons used in violence, gore, blood, lettering, captions, signature, watermark, logo, border, frame, copied reference composition
```

</details>
