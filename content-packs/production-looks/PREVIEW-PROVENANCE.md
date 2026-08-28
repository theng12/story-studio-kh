# Production Looks Preview Provenance

These six previews are owner-approved migrations of publisher-controlled images already checked into Story Studio's legacy built-in catalog. The approved migration preserves the exact bytes; it does not introduce an external license claim, a new composition, production generation, or third-party creator identity.

For every row below, the destination was decoded from the final pack path as WebP at 1672x941. Source and destination SHA-256 values matched, and a direct byte comparison passed.

Row one's source and destination slugs differ on purpose. The product was renamed from the third-party mark to Retro Paint Fantasy on 2026-08-28, in its directory, asset filename and identifiers as well as its display name. The legacy `builtin-` record and the file under `frontend/public/` keep the old slug because existing user projects pin that id; the bytes are unchanged and the SHA-256 below is the same value it has always been.

| Historical identity | Approved source | Product destination | SHA-256 | Bytes | Dimensions | Decode | Copy proof |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| `builtin-ms-paint-fantasy` | `frontend/public/builtin-style-previews/ms-paint-fantasy.webp` | `content-packs/production-looks/style/retro-paint-fantasy/assets/retro-paint-fantasy.webp` | `5dced4a83086703f8b49ce8edff43b137126a0c237a8636c35ef6b4d5b3afbc8` | 226050 | 1672x941 | WebP decode passed | byte-identical |
| `builtin-pixel-art-story` | `frontend/public/builtin-style-previews/pixel-art-story.webp` | `content-packs/production-looks/style/pixel-art-story/assets/pixel-art-story.webp` | `f81fd10b04dabff766f993fe6dfecd80611c5e3d61545abc131431650307adf5` | 191300 | 1672x941 | WebP decode passed | byte-identical |
| `builtin-anime-cel` | `frontend/public/builtin-style-previews/anime-cel.webp` | `content-packs/production-looks/style/anime-cel/assets/anime-cel.webp` | `d5c5336ef911b14dec00deee80b112a0d25f70a6e5106cb755f6dc42173f8e18` | 270804 | 1672x941 | WebP decode passed | byte-identical |
| `builtin-studio-catalog-realism` | `frontend/public/builtin-style-previews/studio-catalog-realism.webp` | `content-packs/production-looks/style/studio-catalog-realism/assets/studio-catalog-realism.webp` | `60e7b00efb4b6c80e691c6241edcb8a19659a7b069842fd3fb36b11af6a1171e` | 239570 | 1672x941 | WebP decode passed | byte-identical |
| `builtin-whiteboard-doodle-explainer` | `frontend/public/builtin-style-previews/whiteboard-doodle-explainer.webp` | `content-packs/production-looks/style/whiteboard-doodle-explainer/assets/whiteboard-doodle-explainer.webp` | `e4ed319d2d1a59b2dabea6d94c114fcdd11e808e80bccd7617e203ae41354dcb` | 158216 | 1672x941 | WebP decode passed | byte-identical |
| `builtin-hand-drawn-cartoon-explainer` | `frontend/public/builtin-style-previews/hand-drawn-cartoon-explainer.webp` | `content-packs/production-looks/style/hand-drawn-cartoon-explainer/assets/hand-drawn-cartoon-explainer.webp` | `ad03fb926514316328776c89684f25e8ee34f0635cfff8d8e9c378d077445b16` | 78230 | 1672x941 | WebP decode passed | byte-identical |
