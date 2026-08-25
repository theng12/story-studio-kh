# ChatGPT Wave C Preview Qualification

Tool provenance for every selected preview: **built-in ChatGPT image generation**. No selectable backend/model was asserted. Each selected `selected.png` is a byte-identical copy of the tool-produced PNG; no resize, crop, conversion, overlay, composite, or tracked-source modification was made. Every candidate was inspected visually before selection.

| Job | Status | Selected original | SHA-256 | Dimensions | Attempts | Visual qualification / rejections |
| --- | --- | --- | --- | --- | ---: | --- |
| `scale-journey-03` | PASS | `chatgpt-originals/scale-journey-03/selected.png` | `cecce979f25df3f5c65fc05dc2be89b6e0ac74a8a265ba291e3371408a5be0c2` | 1672×941 PNG, 1,940,737 B | 1 | Exact three-line title; three clay bowls clearly progress through studio depth; no numbered-peer treatment. |
| `numbered-lineup-01` | PASS | `chatgpt-originals/numbered-lineup-01/selected.png` | `948d1cbbf54885e41ab644a51a631657b53c946d732ca18e824939c215737d01` | 1672×941 PNG, 1,909,000 B | 2 | Exact one-line title; five distinct clouds and native numerals 1–5. Attempt 1 rejected: separate blue header/title plate. |
| `numbered-lineup-02` | PASS | `chatgpt-originals/numbered-lineup-02/selected.png` | `0f68466c8a42cb12858c731511be99c4ff726227ddee47c7a6ec566df64dfb29` | 1672×941 PNG, 3,133,201 B | 2 | Exact two-line title; three equal-status unbranded cutting tools with native numerals 1–3. Attempt 1 rejected: separate tan header/title plate. |
| `numbered-lineup-03` | PASS | `chatgpt-originals/numbered-lineup-03/selected.png` | `986fdaf39fb3d07190df11fdb0e8f8482a308b6c09bd7e261362460607ce3b9d` | 1672×941 PNG, 2,234,339 B | 2 | Exact three-line title; four visible compost materials and native numerals 1–4. Attempt 1 rejected: separated cream upper title plate. |
| `macro-mystery-detail-01` | PASS | `chatgpt-originals/macro-mystery-detail-01/selected.png` | `44a59d9fd7380f3fcf34d7455785f608e1289ad6168c3b69da93342469723dd1` | 1671×941 PNG, 2,115,087 B | 1 | Exact one-line title; honest sunflower-seed macro with yellow petal contextual clue; no inset or reaction host. |
| `macro-mystery-detail-02` | PASS | `chatgpt-originals/macro-mystery-detail-02/selected.png` | `33d68a3ddcbeb4e3fe4b9877d9704536107102d8ff7e486b1f6eada8f11ec067` | 1672×941 PNG, 2,614,781 B | 1 | Exact two-line title; dew, veins, and far-edge leaf clue meet the macro-mystery grammar. |
| `macro-mystery-detail-03` | PASS | `chatgpt-originals/macro-mystery-detail-03/selected.png` | `7fd46109544f1cba6c61173789ce915d14cde6bd41d6a0cc306baefea7a0bf51` | 1672×941 PNG, 2,944,718 B | 1 | Exact three-line title; bread crust reads as terrain while the loaf edge gives the honest clue. |
| `hands-on-pov-moment-01` | PASS | `chatgpt-originals/hands-on-pov-moment-01/selected.png` | `a0b163a21a56dc630329b5bd837b84f66c5fd8a70d86cfbff77f3cf8816c4590` | 1671×941 PNG, 2,015,758 B | 1 | Exact one-line title; two coherent first-person gloved hands visibly place a seedling in soil. |
| `hands-on-pov-moment-02` | PASS | `chatgpt-originals/hands-on-pov-moment-02/selected.png` | `1e31ec8a480003e228f5b721290c045fc4601d4f8af2c729bbab7d1f2e38562b` | 1672×941 PNG, 2,109,711 B | 3 | Exact two-line title; coherent hands use a hand saw on a small wood piece. Attempt 1 rejected: separate white header/title plate. Attempt 2 rejected: lower-right UI/watermark-like artifact. |
| `hands-on-pov-moment-03` | PASS | `chatgpt-originals/hands-on-pov-moment-03/selected.png` | `e95c6f9f5fd44756a86fe9387649009cb13bb4a6c09a4d2a442605fa24dbd115` | 1671×941 PNG, 2,065,348 B | 3 | Exact three-line title; two coherent hands position a lamp beside a chair and blank book. Attempt 1 rejected: visually separated top title zone. Attempt 2 rejected: book carried extra readable title/author text. |

The accompanying `selection.json` beside each selected file records the exact source-prompt SHA-256, exact title transcription, line-count verdict, recipe-invariant verdict, binary facts, original/no-reference declaration, tool provenance, and exposed `2026-08-24T00:00:00Z` generation timestamp.

## Totals

- PASS: 10
- BLOCKED: 0
- Selected files decoded successfully: 10/10
- Concern: the built-in generator emitted three untouched files at **1671×941** (`macro-mystery-detail-01`, `hands-on-pov-moment-01`, and `hands-on-pov-moment-03`) despite their exact 1672×941 request. They remain PASS on the stated visual criteria and are preserved unmodified, but downstream use requiring exact pixel dimensions should account for this. No resize was performed.
