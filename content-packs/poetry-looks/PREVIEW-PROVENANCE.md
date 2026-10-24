

# Three-preview authoring pass — 2026-10-24

status: authored-for-review; no registry reservation, archive, installation or shipment performed.

Seven accepted images were generated through the local Gateway (`POST /v1/images/generations`, then `GET /v1/images/<job>/file`) using the live-discovered **studio-hub::mflux-community/qwen-image-2-1-turbo-mflux-q4** row. Twelve requests were submitted in all, of which five renders were reviewed and refused: the Bold scene twice (first for added figures, then for photographic materials and blurred depth of field with no closed ink outline or flat colour), the quiet anime scene once (a centrally seated figure plus surface grain), the quiet anime face once (grain across sky, skin and clothing against an explicit no-grain negative prompt), and the painted courtyard once (multiple figures and malformed distant anatomy). Every refused render was moved, with its original request and receipts, into `_trash/content-pack-previews-20261024/` and never rewritten; each retry kept its predecessor's medium, colour and light contract while removing the specific fault, so a refused attempt is visible rather than quietly overwritten. The request counts per image are recorded in its section below. Published 16:9 option: **1K, 1280x720, 0 credits, chargeable=false**. Each request had a unique Idempotency-Key and an explicit seed. Credentials were read in memory only and never retained in this evidence.

Each final preview is a 1672x941 WebP over 20,480 bytes and fully decodes. These are whole-image conversions of the 1280x720 PNG originals: resize cover to 1672x941 with Lanczos3, then WebP quality 90 effort 6 (sharp/libwebp 1.6.0 — the same media contract `content-packs/illustrated-history/prepare-previews.mjs` already uses for this collection; ffmpeg on this Mac ships with no libwebp encoder). Every encode was run twice and the pair proved byte-identical, so the result is reproducible. No overlay, mask, retouching, lettering or compositing was applied, and the integer aspect target drops at most one pixel column instead of re-cropping the composition.

Two existing heroes were copied byte-for-byte; their generation was not repeated. The existing 1.0.0 directories and authoring registry remain unchanged. New successor documents differ only in preview_assets; their manifests differ only in version/changelog.

Rights/originality: newly commissioned text-only image generation through the owner's fleet, authorized expressly for this task. No reference image was submitted, no creator/channel identity or copied composition was used, and no exclusive copyright or independent training-data rights claim is made. The copied heroes retain their prior provenance/approvals. New images have worker visual review only, pending the orchestrator/owner's independent review.

| Final asset | SHA-256 | Bytes | Dimensions | Decode |
|---|---|---:|---|---|
| `content-packs/poetry-looks/style/quiet-anime-poetry-v1.0.1/assets/quiet-anime-poetry.webp` | `f8ae97f301a5ba13b7d9b5ee39b155492a158d241e41976892465fd7ea721a4d` | 177290 | 1672x941 | full decode passed |
| `content-packs/poetry-looks/style/quiet-anime-poetry-v1.0.1/assets/quiet-anime-poetry-scene.webp` | `9f701c8d477140aec1b3514e7250bb00f151aea0cbc2d26ceb58cf975712a5e7` | 164752 | 1672x941 | full decode passed |
| `content-packs/poetry-looks/style/quiet-anime-poetry-v1.0.1/assets/quiet-anime-poetry-face.webp` | `f51960a5209a6d3f43b4f92d7bca95ef05dc45bbe940ac978d94937e49055198` | 61118 | 1672x941 | full decode passed |

## quiet-anime-poetry-scene

Gateway job: `adbf9232-b021-4e19-a699-d223db5a8c55`. Requested seed: `10242503`. Idempotency key: `style-preview-retry-20261024-eedded7fc91141f296747ba9cb215ef2`.

Original: `content-packs/preview-work-20261024/originals/quiet-anime-poetry-scene/original.png`, 1157508 bytes, 1280x720 PNG, SHA-256 `e4758f9a17a1966307f8768fdb9b65ca55ec0f0c5053607969e9a59e5c0ef265`, full decode passed.

Visual review: An empty glasshouse at dusk on the right quarter, a slatted wooden bench and terracotta pots on a mossy paved path, dark hills and still green grass to the left. Pristine digital contract met: broad perfectly uniform cel colour fills, clean smooth gradients in the teal sky and in the glass, clean ink edges. No visible grain or stippling over sky, glass or foliage. Human figure absent; no lettering. Only restraint keeps it quiet — the image is a lit, coloured scene, not a blank or minimal ground.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
A pristine clean digital anime background painting of an EMPTY hillside greenhouse at blue hour. Environment art only. A completely vacant wooden bench stands on the right beside clear glass panes and three terracotta plant pots. Empty stone path in the foreground; distant teal valley, deep blue sky and forest-green hills at left. Soft amber light shines from inside the greenhouse. The frame consists exclusively of architecture, plants, furniture and landscape. Every seat and path is visibly vacant. Delicate confident ink contours, restrained clean cel shading, spatially convincing softly painted environment, smooth sky and glass gradients, perfectly polished digital colour with no grain or paper texture. Muted teal, deep blue and forest green with selective amber and cream highlights. Original asymmetrical wide sixteen-by-nine composition with quiet contemplative atmosphere, soft directional light and elegant layered depth. No person, no character, no human body, no face, no hands, no animal, no statue, no figure or reflection of a figure. No surface noise, grain, grunge, halftone, stippling, canvas or paper texture. No caption, word, lettering, watermark, signature, logo or border.
```

## quiet-anime-poetry-face

Gateway job: `c94b0777-d8b8-468b-9f30-5a80eeabc67a`. Requested seed: `10242504`. Idempotency key: `style-preview-retry-20261024-a5508442f24a42e6828f9b584d6a8198`.

Original: `content-packs/preview-work-20261024/originals/quiet-anime-poetry-face/original.png`, 792779 bytes, 1280x720 PNG, SHA-256 `f8b6a9a5fea9e05778b452890d62c4780790342ff95305645044548db2017c5a`, full decode passed.

Visual review: Third attempt. Wide close three-quarter portrait of one anonymous adult woman at the right half, dark hair tucked back, dusty peach collar, deep teal window and forest-green evening trees behind with a small selective amber light. Delicate confident ink contours, two restrained cel shadow planes on the face, skin as flat clean colour planes. No visible grain over sky, skin or clothing, unlike the rejected first attempt. No theatrical expression, no lettering.

Exact submitted prompt (the initial requests incorporated the full style bible and negative prompt as prose because the Gateway Hub image adapter does not pass a separate negative_prompt field; accepted figure-free scene retries retain the medium/colour/light rules while omitting distracting cast/example text):

```text
Pristine clean digital anime cel illustration, smooth perfectly uniform colour fills, no surface texture. Original wide sixteen-by-nine close portrait of one anonymous adult woman in three-quarter view, face at the right half, quietly thoughtful, dark hair tucked behind her ear, dusty peach collar. Natural adult proportions, delicate confident ink contours, two clean restrained cel shadow planes on the face. Smooth skin painted as absolutely flat clean colour planes, luminous clear eyes and small understated mouth; no theatrical expression. Behind her is a softly painted yet smooth deep teal-blue window and forest-green evening trees, a small selective amber light. Contemplative, emotionally restrained, natural spatial depth, asymmetrical balance, uncluttered breathing room. All large colour areas have a flawless polished digital finish. Clean smooth sky and glass gradients. No grain, no sensor noise, no stippling, no halftone, no paper texture, no canvas texture, no grunge, no distressed surface, no rough dry brush. No photographic skin, no glossy 3D, no chibi, no neon, no muddy shadow. No letters, text, captions, signature, watermark, logo or border. An original composition without any recognisable person or copied artwork.
```
