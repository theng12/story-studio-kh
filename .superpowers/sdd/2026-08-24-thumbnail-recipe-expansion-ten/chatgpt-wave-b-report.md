# ChatGPT Wave B preview qualification

Tool provenance for every attempt: **built-in ChatGPT image generation**. No reference images were supplied or used. Every selected file is an untouched copied PNG original; no resize, crop, conversion, overlay, composite, pack-source edit, or tracked-file modification was performed.

| Job | Status | Selected original | SHA-256 | Dimensions | Attempts | Qualification / rejection notes |
| --- | --- | --- | --- | --- | ---: | --- |
| cutaway-exploded-object-02 | PASS | `chatgpt-originals/cutaway-exploded-object-02/selected.png` | `7f6e89379c02397062bd86871b6b0d739bcd6bb11ac05563846ae9e75f6fdcf5` | 1672×941 PNG, 1,986,151 bytes | 1 | Exact two-line title; thermos cutaway clearly shows ordered outer wall, vacuum gap, inner wall, warm liquid. |
| cutaway-exploded-object-03 | PASS | `chatgpt-originals/cutaway-exploded-object-03/selected.png` | `f7363e63f841a87dc6539d9a722a7237f28fe019530c8feae48070afa24caf3f` | 1672×941 PNG, 2,092,324 bytes | 1 | Exact three-line title; isometric roof cutaway clearly shows shingles, membrane, insulation, rafters. |
| hero-payoff-companion-01 | PASS | `chatgpt-originals/hero-payoff-companion-01/selected.png` | `32061c1c2370fa15e48bfdccf4c98862d61b34eb6295455123cca7073244b99d` | 1671×941 PNG, 2,274,220 bytes | 2 | Attempt 1 rejected: red title banner/title plate. Selected attempt has exact one-line title against natural background; gardener/basket relationship clear. |
| hero-payoff-companion-02 | PASS | `chatgpt-originals/hero-payoff-companion-02/selected.png` | `0217ee0ddde2879c87e6fa7d60f9578c089a061b14adee2f61b9dc53e2e131d9` | 1672×941 PNG, 1,884,789 bytes | 2 | Attempt 1 rejected: painted title band/title plate. Selected attempt has exact two-line title on plain studio wall; maker/organizer relationship clear. |
| hero-payoff-companion-03 | PASS | `chatgpt-originals/hero-payoff-companion-03/selected.png` | `12ec6a8e45ef0acf120f7e28662853d765c4f01974d5e4855dbffae09d2722a3` | 1672×941 PNG, 2,169,402 bytes | 2 | Attempt 1 rejected: teal painted title banner/title plate. Selected attempt has exact three-line title against natural background; young adult/birdhouse relationship clear. |
| iconic-result-closeup-01 | PASS | `chatgpt-originals/iconic-result-closeup-01/selected.png` | `c0ae4932e4b66909829ee9d41745425f1b06c6f0fe5d372e3436b11a86736974` | 1672×941 PNG, 2,471,624 bytes | 1 | Exact one-line title; a single scored loaf is the detail-revealing dominant result. |
| iconic-result-closeup-02 | PASS | `chatgpt-originals/iconic-result-closeup-02/selected.png` | `8f38437b19b595082a7d8f479615e2e3af7975ae3690b2e2f1570fdeedb5babb` | 1671×941 PNG, 2,841,778 bytes | 1 | Exact two-line title; one dew-covered completed raised bed dominates. |
| iconic-result-closeup-03 | PASS | `chatgpt-originals/iconic-result-closeup-03/selected.png` | `970c5dd76116e6f68634de9aca7ff63dac4af9b411dff96c2f9916af266e7e90` | 1671×941 PNG, 1,936,323 bytes | 1 | Exact three-line title; one finished compact reading corner dominates, no people. |
| scale-journey-01 | PASS | `chatgpt-originals/scale-journey-01/selected.png` | `6948eb7ece83bec59406886b52c5f24f79d2aa0f2cd72ba7257372fa99043872` | 1672×941 PNG, 2,306,910 bytes | 1 | Exact one-line title; exactly three related forms (seedling, young tree, mature canopy) progress through one hill scene. |
| scale-journey-02 | PASS | `chatgpt-originals/scale-journey-02/selected.png` | `4c62b241147a00df11aa2113774d82f408e1abb7cc129c6d3db54ceb50d56f4a` | 1672×941 PNG, 2,056,131 bytes | 1 | Exact two-line title; exactly three related forms (pebble, stone, boulder) progress along one riverbank. |

## Totals

- PASS: 10
- BLOCKED: 0
- Attempts: 13 total (three title-plate rejections, each corrected once)
- Decode/type validation: 10/10 PNG originals decoded successfully with macOS ImageIO/sips.

## Concerns

The built-in generator emitted 1671×941 (rather than the requested 1672×941) for `hero-payoff-companion-01`, `iconic-result-closeup-02`, and `iconic-result-closeup-03`. The originals were intentionally preserved untouched per the no-resize/no-conversion requirement. All other visual, headline, line-count, and recipe-invariant checks passed.
