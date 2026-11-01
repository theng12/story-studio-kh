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


# Three-preview authoring pass — 2026-10-24

status: authored-for-review; no registry reservation, archive, installation or shipment performed.

Seven accepted images were generated through the local Gateway (`POST /v1/images/generations`, then `GET /v1/images/<job>/file`) using the live-discovered **studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4** row. Twelve requests were submitted in all, of which five renders were reviewed and refused: the Bold scene twice (first for added figures, then for photographic materials and blurred depth of field with no closed ink outline or flat colour), the quiet anime scene once (a centrally seated figure plus surface grain), the quiet anime face once (grain across sky, skin and clothing against an explicit no-grain negative prompt), and the painted courtyard once (multiple figures and malformed distant anatomy). Every refused render was moved, with its original request and receipts, into `_trash/content-pack-previews-20261024/` and never rewritten; each retry kept its predecessor's medium, colour and light contract while removing the specific fault, so a refused attempt is visible rather than quietly overwritten. The request counts per image are recorded in its section below. Published 16:9 option: **1K, 1280x720, 0 credits, chargeable=false**. Each request had a unique Idempotency-Key and an explicit seed. Credentials were read in memory only and never retained in this evidence.

Each final preview is a 1672x941 WebP over 20,480 bytes and fully decodes. These are whole-image conversions of the 1280x720 PNG originals: resize cover to 1672x941 with Lanczos3, then WebP quality 90 effort 6 (sharp/libwebp 1.6.0 — the same media contract `content-packs/illustrated-history/prepare-previews.mjs` already uses for this collection; ffmpeg on this Mac ships with no libwebp encoder). Every encode was run twice and the pair proved byte-identical, so the result is reproducible. No overlay, mask, retouching, lettering or compositing was applied, and the integer aspect target drops at most one pixel column instead of re-cropping the composition.

Two existing heroes were copied byte-for-byte; their generation was not repeated. The existing 1.0.0 directories and authoring registry remain unchanged. New successor documents differ only in preview_assets; their manifests differ only in version/changelog.

Rights/originality: newly commissioned text-only image generation through the owner's fleet, authorized expressly for this task. No reference image was submitted, no creator/channel identity or copied composition was used, and no exclusive copyright or independent training-data rights claim is made. The copied heroes retain their prior provenance/approvals. New images have worker visual review only, pending the orchestrator/owner's independent review.

| Final asset | SHA-256 | Bytes | Dimensions | Decode |
|---|---|---:|---|---|
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.1/assets/bold-illustrated-history-hero.webp` | `7c4b7f21e95202600559f95add22317717c2d0dc297936d5f2108879c2b24073` | 216104 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.1/assets/bold-illustrated-history-scene.webp` | `dd7990b32e9e42705705d7008eaf53a1e10fafbcb1175f76d9cb2e0edd6f6966` | 287662 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.1/assets/bold-illustrated-history-face.webp` | `bed4f8f6f511c14d636e7b18a90a8dbb08bed7325814309ab30e431f9e58e80b` | 190328 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/cinematic-historical-illustration/assets/cinematic-historical-illustration-hero.webp` | `47f1e768a8d70c5b818e9d268c35749e8b8e3479587a1738cdf69bb7f9d38299` | 271894 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/cinematic-historical-illustration/assets/cinematic-historical-illustration-scene.webp` | `777ebc129a4338b51fcaed8c47a3ecf066752f9c963980af60d987a8d98f0efb` | 256606 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/cinematic-historical-illustration/assets/cinematic-historical-illustration-face.webp` | `a748b1b9369487b46c875cdfe80ea5067a1b5acbd220e69124a1df2a65fbdacb` | 197194 | 1672x941 | full decode passed |

Bold scene compatibility: its negative prompt rejects a calm empty landscape/minimal blank ground. The figure-free preview instead uses a richly detailed, high-contrast unoccupied harbour courtyard; quiet means no event or figure, not muted/minimal rendering.

The new Cinematic Historical Illustration source has explicit registry-issued identity placeholders. It is not buildable/shippable until the authoring lead issues the real records. Contract distinction: blended soft painted edges, natural diffuse light, full scene-dependent colour, selective distant detail and human-scale multi-person scenes; Golden Epic instead requires sharp hyper-detail, sunset rays, gold/bronze/crimson and one regalia figure, while Bold uses closed heavy ink and hard flat/cel colour.

## bold-illustrated-history-scene

Gateway job: `0aa18fe8-116c-4d84-8752-02291494a6e1`. Requested seed: `10242601`. Idempotency key: `style-preview-retry-20261024-a1f7db0131ca4659a0124fe1a0eea04a`.

Original: `content-packs/preview-work-20261024/originals/bold-illustrated-history-scene/original.png`, 1267643 bytes, 1280x720 PNG, SHA-256 `a71118cfb1c07e0c82236f8f9b29bdfec55c8935241497eda04eab637deae832`, full decode passed.

Visual review: Third attempt. An entirely unoccupied harbour courtyard: a carved stone gate opening onto a strip of sea at left, a long ochre building with a terracotta roof, turquoise shutters and doors, stone paving carrying boxes, rope, a barrel and a clay jar. Bold contract met: strong closed dark contours on the arch, openings, crates and jar, saturated flat colour fills with no gradient or photographic surface, and one consistent hard cel shadow direction across the paving. No figure, no animal, no lettering. The ground is richly detailed and high contrast, so the negative prompt's forbidden calm empty landscape and minimal blank ground are absent.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
A bold HAND-DRAWN 2D COMIC BOOK DRAWING of an EMPTY historical harbour courtyard, sixteen by nine. Very prominent BLACK INK OUTLINES enclose every single shape. Confident slightly wobbly heavy ink contours around the gate, warehouse, roof tiles, windows, crates and rope. FLAT SATURATED COLOUR FILLS: ochre stone, brick-red tiled roof, teal shutters, indigo sea, bone highlights. Only ONE HARD CEL SHADOW per surface. Simple hand-inked detail, clear flat shapes, illustrated graphic-novel background art. Strong outer silhouettes and finer interior ink detail. Every distance equally drawn and legible, no blur. Wide richly detailed courtyard with stone gatehouse left, roofed warehouses right, empty paving, one copper pot and a wooden crate. Architecture and objects only, no people, no soldiers, no figures, no faces, no animals, no statues. Quiet uneventful scene but visually bold and colourful. No photographic texture, no realistic material rendering, no gradients, no painterly shading, no depth of field, no bokeh. Black outlined flat-colour drawing, NEVER a photo. No words, letters, caption, signature, watermark, logo or border. An original illustration.
```

## bold-illustrated-history-face

Gateway job: `72c28810-f772-4d4a-bca4-78d30a86657e`. Requested seed: `10242402`. Idempotency key: `style-preview-20261024-bold-illustrated-history-face-1a7ffd0b3816435fa21d7d9f8f4154bb`.

Original: `content-packs/preview-work-20261024/originals/bold-illustrated-history-face/original.png`, 1261108 bytes, 1280x720 PNG, SHA-256 `f521733b037a8342f1c18d4bb9250d2d97938d9cd5e0d9efacfa5982a713295e`, full decode passed.

Visual review: Close three-quarter face of an anonymous young man at left in a blue cloth cap with an ochre cloak, red banners and a torch-lit crowd before a towered fort and an arched aqueduct. Heavy confident ink contour on the silhouette and interior details, flat saturated ochre, brick red, blue and bone fills with a small number of hard shadow steps; depth by overlap and warm-against-cool colour rather than blur. No wounds, no viscera, no lettering, no watermark.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
Close three-quarter face of an anonymous adult historical navigator at left, intent but composed, blue cloth cap, ochre cloak, red sail and detailed harbour behind. Characterful ink-drawn eyes, two flat facial shadow steps. No lettering, caption, logo or watermark. Original composition. 
Rendering contract: A hand-drawn historical illustration built from outline, flat colour and a small number of modelled shadow steps, in the register of a bold history poster rather than a photograph. Line: every shape is closed by a strong ink outline of confident, slightly varied weight — heaviest on the outer silhouette of a landmark or figure, a step lighter inside the form, and lighter again on small interior detail such as windows, ropes, banners and facial features — so the whole picture reads as a bold drawing before any colour is seen. The line is drawn by hand and keeps a little wobble and taper; it is never a uniform machine stroke. Fill: large areas of flat, saturated colour laid inside the outline — deep ochre, brick red, indigo, teal, forest green, sand, and a warm bone highlight — with at most one or two hard cel steps to model a face, a wall or a fold, and never a soft gradient, airbrush or photographic texture. Shadow: one or two hard, clean shadow shapes per form, a darker flat version of the same hue with a simple boundary, thrown consistently from one implied light; night scenes may invert to a warm light against cool dark. Detail and scale: this style is not a single centred subject on an empty ground. It draws whole places — a walled city with towers, gates, aqueducts and harbour cranes; a mountain road with caravans; a plaza with a market and a crowd — at a believable scale, with the figures that matter drawn prominently and legibly at the front and the rest held back by outline weight and colour rather than by blur. Figures: historical people are drawn with clear, characterful faces and period dress — helmets, robes, armour, headdresses — with expression carried in the face and pose; they may be shown in decisive moments. Drama: battles, sieges, burning cities, storms, and crowds in motion are inside this style's range and are drawn with energy — charging figures, raised banners, flames as flat bright shapes with a hard outline — while remaining illustration, not gore: no open wounds, no viscera, no suffering shown for its own sake, and no photorealistic injury. Composition: sixteen by nine, a clear focal landmark or figure group with a readable silhouette, depth built by overlapping planes and by warm-against-cool colour rather than by perspective haze. Atmosphere: dust, smoke, torchlight and weather may be drawn as flat shapes, always outlined, never as soft photographic mist. Palette stays rich and confident; the look is bold and intriguing, and must never be muted, pastel, or calmed. Keep the contract content-independent: bind the style to no single individual, era, place, wordmark or copied composition, while period banners, standards, shields and heraldry remain part of the scenes themselves.
Exclude: photoreal, photorealistic, photograph, film still, camera render, 3D render, clay render, plastic surfaces, soft painterly, oil painting, watercolour, gouache wash, sketchy pencil rendering, pastel palette, muted palette, desaturated, washed out colour, low contrast, calm empty landscape, single small subject on a blank ground, minimal scene, blurred depth of field, atmospheric haze, bloom, glow, lens flare, film grain, halftone noise, smooth gradient shading, airbrush, soft shadow, ambient occlusion, chibi, kawaii, cute mascot proportions, realistic gore, realistic blood, wet tissue, viscera, open wound texture, suffering, agony, torture, cruelty, watermarks, signatures, printed logos, speech balloons, panel borders, UI chrome, an exact copy of another channel's reference composition, a specific living person's likeness
```

## cinematic-historical-illustration-hero

Gateway job: `38cc217b-4824-4cb5-96be-efd98b2e809a`. Requested seed: `10242405`. Idempotency key: `style-preview-20261024-cinematic-historical-illustration-hero-f8082df281fd48f19f49f8165a3f70d8`.

Original: `content-packs/preview-work-20261024/originals/cinematic-historical-illustration-hero/original.png`, 1579355 bytes, 1280x720 PNG, SHA-256 `de599943bf522290ae637a8c13c57faf47ea3d06e65fc2e97fbfba6cc32cfc2a`, full decode passed.

Visual review: A riverside village at work: two anonymous adults in indigo and terracotta woven clothing mending a fishing net under the shade of a timber veranda, woven baskets on the ground, a placid river with small wooden boats, lush trees, pale blue sky and distant tiled roofs. Full natural colour under diffuse morning daylight with no gold or brown lock, no ink contour, no cel steps, no lettering. Caveat recorded for independent review: the two figures sit large in the foreground rather than in the requested middle distance, and their faces, hands and the net carry more rendered detail than the rest of the frame, making this the least painterly of the style's three images. It remains a painting overall and breaches no explicit exclusion, so it is accepted with the caveat rather than regenerated.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
Original panoramic scene at human eye level: a twelfth-century Southeast Asian riverside village, two anonymous adults in simple indigo and terracotta woven clothing repairing a fishing net under the dappled shade of a timber veranda. River and small wooden boats through the opening; lush green trees, pale blue sky and distant modest tiled roofs. Main figures occupy the middle distance, broad environment all around. Soft morning daylight, quiet purposeful gestures, full natural colour. No ruler, monument, regalia, weapons, modern object or writing. 
Rendering contract: Soft-painted full-colour historical illustration, visibly made of blended brush strokes rather than captured by a camera. Model forms with broad, opaque-to-translucent painted colour planes, soft transitions and selective lost-and-found edges; reserve small crisp strokes for the focal eyes, a tool or an architectural joint. No enclosing ink contour and no hard cel-shadow steps. Keep a fine, unobtrusive painted surface, with neither thick impasto nor distressed paper. Use a broad natural palette: foliage greens, river blues, terracotta, limestone, indigo textiles and varied human skin tones, with colours chosen by each setting instead of a fixed gold or brown grade. Light comes from a believable natural source such as open sky, a window, morning sun or bright cloud; carry coloured reflected light into legible shadows, with gentle highlights and restrained contrast. Historical people have plausible adult proportions, individual understated expressions and simple period-appropriate dress; faces remain brush-modelled at close range rather than pore-sharp or doll-smooth. Allow individuals, small groups, working communities and unoccupied environments as the narrative requires. Stage history at human eye level through lived-in architecture, landscapes, craft and ordinary gestures; ceremonial or dramatic subjects may occur without requiring regal dress, combat or spectacle. Compose a continuous cinematic sixteen-by-nine scene with asymmetrical balance and clear foreground, middle distance and background. Use scale, overlap and softly simplified distant brushwork for depth; keep focal detail selective instead of making every distant object equally sharp. Do not reserve a title block or assemble a promotional montage. Adapt period, place, cast, weather and time of day to the scene. The contract contains no fixed ruler, dynasty, landmark, channel identity, named artist, copied composition or written caption.
Exclude: sepia, monochrome brown, gold-and-bronze colour lock, desaturated wash, photorealism, photograph, film still, camera-sharp pores, glossy 3D render, plastic skin, hyper-detailed cinematic poster, promotional key art, heroic regalia portrait over an empire panorama, collage montage, title block, theatrical god-rays, orange-teal blockbuster grading, thick ink outline, comic contour, flat vector, hard cel shading, anime, heavy impasto, distressed parchment, neon, oversharpening, malformed anatomy, extra fingers, gore, lettering, captions, watermarks, signatures, logos, borders, copied composition, recognisable living person
```

## cinematic-historical-illustration-scene

Gateway job: `6329c84b-d6a2-49c9-9016-7eef5c30546f`. Requested seed: `10242506`. Idempotency key: `style-preview-retry-20261024-cfe245947c814511bb57a3417068965d`.

Original: `content-packs/preview-work-20261024/originals/cinematic-historical-illustration-scene/original.png`, 1568447 bytes, 1280x720 PNG, SHA-256 `4ac778e8cb9b6be2baafcb92154d058a5723ea47a376637b16ff750052de4af7`, full decode passed.

Visual review: Second attempt, accepted. An entirely empty historical courtyard: a tiled terracotta roof over an empty timber veranda at the left edge, a pale limestone wall with climbing green vines at the right, unoccupied stone paving carrying only a low wooden bench and a ceramic water bowl, open blue sky, soft white clouds and distant green hills. Broad blended opaque brush planes, soft transitions and lost edges, natural diffuse daylight with coloured light in the shadows. No person, animal or statue anywhere in the frame; no writing. The first attempt was rejected for adding multiple figures and malformed distant anatomy, so the accepted retry carries the medium, colour and light rules of the contract with the cast descriptions omitted.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
Architecture-only landscape painting. An entirely empty deserted historical courtyard with no living thing in the picture. Wide horizontal view. At the left edge is a tiled terracotta roof over an empty timber veranda; on the right a pale limestone wall with climbing green vines. Unoccupied open stone paving fills the whole foreground, interrupted only by a low empty wooden bench and a ceramic water bowl. Open blue sky, soft white clouds, a glimpse of distant green hills. Still puddles reflect only sky and roof. The whole place is visibly deserted and silent. No person, no human figure, no faces, no statues, no animals, no crowd.
Soft-painted full-colour historical illustration: broad blended opaque brush planes, soft transitions, selective lost-and-found edges, a few crisp painted architectural joints. Fine painted surface without thick impasto, grain or distressed paper. Full natural colour: fresh foliage green, clear river-blue sky, warm terracotta, pale limestone and indigo shadows. Believable diffuse natural daylight with coloured reflected light in legible shadows, gentle highlights and restrained contrast. Depth through scale, overlap and softly simplified distant brushwork. Continuous cinematic sixteen-by-nine scene, asymmetrical balance. A painting with visible soft brush handling, no enclosing ink lines, no cel steps, no photographic finish, no poster montage, no sepia grade or gold-bronze colour lock. Entirely uninhabited architecture and objects only. No writing, typography, caption, signature, watermark, logo, border or title block anywhere.
```

## cinematic-historical-illustration-face

Gateway job: `e6d4b261-6da5-4182-8db6-5ea18c53c1e5`. Requested seed: `10242407`. Idempotency key: `style-preview-20261024-cinematic-historical-illustration-face-8a3e245f0b2d4dbbaf4cb31c856a939d`.

Original: `content-packs/preview-work-20261024/originals/cinematic-historical-illustration-face/original.png`, 1482572 bytes, 1280x720 PNG, SHA-256 `5aa96447a76e623a2f7fed259e3f3841c3e9499c6a217f640484a718d4855bc4`, full decode passed.

Visual review: Close three-quarter portrait of one anonymous middle-aged craftswoman in simple indigo clothing, red-clay workshop wall behind and a green garden with a river through the opening. Visibly painted: broad blended brush planes, soft lost-and-found edges, a few crisp strokes at the eyes, warm skin with cool reflected light in the shadows, no enclosing ink contour and no cel shadow steps. Faces read brush-modelled rather than pore-sharp. No crown, no jewellery spectacle, no bokeh, no lettering.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
Original close three-quarter portrait of one anonymous middle-aged Southeast Asian craftswoman in simple muted indigo historical clothing, shoulder cut, face filling the left half of a wide frame, looking slightly down toward her work outside the frame. Soft window daylight models warm brown skin with reflected cool sky in the shadows; subtle lines around the eyes painted with a few strokes, calm concentration, individually plausible eyes and mouth. Background is a gently simplified red-clay workshop wall and green garden beyond an opening. No jewellery spectacle, crown, makeup, camera bokeh or writing. 
Rendering contract: Soft-painted full-colour historical illustration, visibly made of blended brush strokes rather than captured by a camera. Model forms with broad, opaque-to-translucent painted colour planes, soft transitions and selective lost-and-found edges; reserve small crisp strokes for the focal eyes, a tool or an architectural joint. No enclosing ink contour and no hard cel-shadow steps. Keep a fine, unobtrusive painted surface, with neither thick impasto nor distressed paper. Use a broad natural palette: foliage greens, river blues, terracotta, limestone, indigo textiles and varied human skin tones, with colours chosen by each setting instead of a fixed gold or brown grade. Light comes from a believable natural source such as open sky, a window, morning sun or bright cloud; carry coloured reflected light into legible shadows, with gentle highlights and restrained contrast. Historical people have plausible adult proportions, individual understated expressions and simple period-appropriate dress; faces remain brush-modelled at close range rather than pore-sharp or doll-smooth. Allow individuals, small groups, working communities and unoccupied environments as the narrative requires. Stage history at human eye level through lived-in architecture, landscapes, craft and ordinary gestures; ceremonial or dramatic subjects may occur without requiring regal dress, combat or spectacle. Compose a continuous cinematic sixteen-by-nine scene with asymmetrical balance and clear foreground, middle distance and background. Use scale, overlap and softly simplified distant brushwork for depth; keep focal detail selective instead of making every distant object equally sharp. Do not reserve a title block or assemble a promotional montage. Adapt period, place, cast, weather and time of day to the scene. The contract contains no fixed ruler, dynasty, landmark, channel identity, named artist, copied composition or written caption.
Exclude: sepia, monochrome brown, gold-and-bronze colour lock, desaturated wash, photorealism, photograph, film still, camera-sharp pores, glossy 3D render, plastic skin, hyper-detailed cinematic poster, promotional key art, heroic regalia portrait over an empire panorama, collage montage, title block, theatrical god-rays, orange-teal blockbuster grading, thick ink outline, comic contour, flat vector, hard cel shading, anime, heavy impasto, distressed parchment, neon, oversharpening, malformed anatomy, extra fingers, gore, lettering, captions, watermarks, signatures, logos, borders, copied composition, recognisable living person
```

# Style-text clean-up pass — 2026-11-01

status: authored; archive built and validated; no stocking, publication or installation performed.

The Bold Illustrated History style text was rewritten so it names a drawing style and no longer names
its subjects. The old text's own wording — "battles, sieges, burning cities", "charging figures,
raised banners", the walled city, the market and the crowd — was what drew cavalry and banners into
canal scenes on Qwen 2.1 Turbo. The cleaned text is the owner's, byte for byte:
2,367 characters, SHA-256 `1e0c91359da77ef2d50feaf5d422c11974a6f2fc72e18700267b306c5b12a131`.

**No preview was regenerated.** The three rasters below were copied byte-for-byte from the published
1.0.1 directory; they were not re-encoded, re-rendered or re-reviewed. Their digests are therefore
identical to the 1.0.1 pins above, which is the point: the 1.0.2 change is to the text, not to the
pictures.

| Final asset | SHA-256 | Bytes | Dimensions | Decode |
|---|---|---:|---|---|
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.2/assets/bold-illustrated-history.webp` | `7c4b7f21e95202600559f95add22317717c2d0dc297936d5f2108879c2b24073` | 216104 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.2/assets/bold-illustrated-history-scene.webp` | `dd7990b32e9e42705705d7008eaf53a1e10fafbcb1175f76d9cb2e0edd6f6966` | 287662 | 1672x941 | full decode passed |
| `content-packs/illustrated-history/style/bold-illustrated-history-v1.0.2/assets/bold-illustrated-history-face.webp` | `bed4f8f6f511c14d636e7b18a90a8dbb08bed7325814309ab30e431f9e58e80b` | 190328 | 1672x941 | full decode passed |

**A caveat the owner should see, recorded rather than hidden.** The cleaned text no longer promises
any subject, but two of the three carried-over previews still show one:

- `bold-illustrated-history.webp` (the hero) shows a walled harbour city in flames with cavalry and
  a crowd on the quay.
- `bold-illustrated-history-face.webp` shows a close face with raised banners, torches and a mounted
  charge behind it.

Both were drawn under the old text, which promised exactly those subjects. The previews are not
wrong pictures — the style's drawing contract (closed ink outline, flat saturated colour, hard cel
shadows, warm-against-cool depth) is intact in all three — but the two of them show the style doing
the thing the new text deliberately stops naming. They are kept as they are because the owner asked
for the same three files unredrawn; whether a later pass replaces them with subjects the cleaned text
still allows is the owner's call, not this change's.

The third preview, `bold-illustrated-history-scene.webp`, is an unoccupied harbour courtyard with a
stone gate, teal shutters and no figure at all. It shows the cleaned contract directly and needs no
replacement.

Archive: `style-bold-illustrated-history-1.0.2.sspack`, 697,774 bytes, SHA-256
`83389e347e6f7ed303c40ec48c7eee9564cc763042ded9eae67d315ef8a7ed3d`. The style bible inside that
archive hashes to the cleaned file's digest, proven by reading the bytes back out of the built ZIP.
