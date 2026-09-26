# Reveal effects — the decided design, and what shipped

**Status: the engine is built and verified; the surfaces are not wired yet.** This file is the
design the owner approved on 2026-09-26, moved into the repository (it lived in `_orchestra/`
until the work started, so that it rides this repo's release cycle from here on). The section at
the end says exactly which half is done and which half is next — read that first if you are
picking this up.

Decided 2026-09-26 by the owner. **Build it inside Story Studio and render locally; evaluate before
distributing the render.** This lives in `_orchestra/` — outside all three repos, so it needs no
release cycle. **When the work starts, move this file into `story-studio-kh/docs/` as part of that
change**, so it rides the repo's own release cycle from then on.

## What it is, and what it is not

An **entrance/reveal effect engine** for scene images: a still image arrives on screen in pieces —
geometric wipes, palette layers, or a draw-on — then holds while it drifts, then the next scene
arrives. Inspired by `leeyeel/Sketch2Motion`, but **not adopting that code**: theirs is
photo → potrace → SVG → Manim → MP4, and it has **no licence** (GitHub reports `license: None`), so
shipping it inside a distributed app is the one case the owner's own rule carves out. We implement
the technique ourselves — trace and reveal — which also drops Manim's native dependency tree
(cairo, pango) and lets us extend it, which is the actual goal.

**Family, three flavours, one engine:**

| Family | Input | Needs |
| --- | --- | --- |
| **Geometric wipes** *(default)* | any image | nothing |
| **Palette layers** | any image; wants real colour, so photoreal is the *better* input | nothing |
| **Draw-on** | **line art** — Story already has this as an image art style | a vector trace (potrace-style) |

## Defaults and controls

- **Default family: geometric wipes.** Default pool: a curated handful that reads well on photoreal
  frames — rows, columns, diagonal, centre-out, blinds, radial. The rest available to add.
- **A preset is a named bundle of:** family, geometry, direction/origin, duration (or *fit to
  narration*), easing, mask softness (feather), push-in amount, stagger, layer count, seed policy.
- **Presets live as a Visual Style / Content Pack** — Story already has that machinery, so a "Wipe
  Pack" is portable, versionable, importable and shippable, and it doubles as the randomisation pool.

## Randomisation — the rules that keep it from looking amateur

1. **Seed per episode, derive per scene.** One seed on the episode; each scene's effect derived from
   `(seed, scene_index)`. Randomisation must be **reproducible** — re-rendering an episode gives the
   identical result, because this project's method depends on same-input-same-output.
2. **Draw from an enabled pool**, not from everything.
3. **No immediate repeats, and a cap per effect per episode.**
4. **Randomise the look, never the duration.** Wipe length jumping scene to scene makes an episode
   feel unstable; keep duration tied to the narration and vary geometry, direction, softness, push-in.
5. **Per-scene "reroll"** for when one reveal doesn't suit.
6. **Derived by default, stored when overridden.** A scene with no override computes its effect from
   the seed; a manual choice is saved with the scene.
7. **Coherence modes:** per scene (default, maximum variety) · **per act** (usually looks most
   professional; one look per group, changing at act boundaries) · fixed (one effect per episode).

## Pacing — the part that pays for itself

The owner's insight: a reveal plus a **hold** lets one image carry 10–15 s instead of 5, so fewer
images are needed. Image generation is the expensive fleet step, so this is the largest saving
available.

**Arithmetic (multiplication, not measurement):** a 5-minute episode at 5 s/image needs ~60 images;
at 12 s/image, ~25. **≈2.4× less image generation.**

What makes a hold watchable — craft, not measurement:

- **Continuous slow drift** (3–8% push-in, or a slow pan). The single biggest factor; a frozen frame
  reads as a slideshow.
- **Stage events during the hold** — frame lands → palette fills → a detail reveals → caption. Two or
  three micro-events across 12 s where one wipe alone fades after ~4.
- **Snap holds to narration lines and music beats** (both already available in this pipeline).
- **A per-episode pace setting** — Fast / Standard / Slow / Documentary, each a bundle of
  reveal-duration, hold-duration, drift and micro-event count. Not a global default: overdone, slow
  pacing reads as padding.

## Local first, fleet later

**Build and render locally in Story.** The render is compositing + ffmpeg — no inference, no model —
so a 30–50 scene episode renders in seconds to minutes on one Mac. Fanning that out solves a problem
we do not have.

The fleet still helps, in this order:
1. **Fewer images to generate** — the real win, and it arrives free with pacing.
2. **Renders can run on the small machines.** No model, no memory tier, so a render can run on the
   8 GB Macs that cannot touch FLUX or video — capacity that is currently unusable, and it does not
   compete with the heavy lanes.
3. **Fan-out only when batching episodes.** Then it is a normal Hub lane: one job per scene (never
   one scene split across machines), a small `render` worker staged into the bundle, an operation
   with a **short** deadline (seconds, not video's 7200 s), Story sending `{preset, seed, narration
   timings, source image}` through the gateway, artifacts returned for Story to assemble. Payloads
   are tiny — 1–3 MB in, an MP4 out — unlike a model lane where the weights are the constraint.
   Rendering is deterministic, so spreading it across machines adds no "which Mac made this"
   variance. (Encoded bytes may differ between ffmpeg builds; the picture will not.)

## Out of scope for the first version

- No hand cursor. Most tools draw one and it usually looks cheaper. Offer it, off by default.
- No subject-cutout / semantic-region reveal — that needs a matting or depth model, and it is a
  second step after the palette and geometric families prove the look.
- No fleet render, no Hub worker, no gateway routing until local rendering proves insufficient.

## Verification

Render one scene per family, per pace setting, on a real episode's images — including a photoreal
Z-Image and FLUX.2 Klein frame — and look at them. Determinism check: same episode seed renders the
identical result twice. Then a full episode at Slow pace, to see whether the pacing reads as
considered or as padding.


---

## What shipped in 1.4.229, and what is next

**Built and verified — the engine, rendering locally in Story:**

| Piece | Where |
| --- | --- |
| The document and its rules (families, field, layers, timing, hold, seed policy) | `electron/server/contracts/scene-reveal.ts` |
| The built-in library — 16 wipes, 3 palettes, 1 draw-on, and the default pool of six | `electron/server/contracts/scene-reveal-presets.ts` |
| The compiler: a document in, an FFmpeg `xfade` chain out | `electron/server/lib/reveal-compiler.ts` |
| Pacing: Fast / Standard / Slow / Documentary, hold snapping, micro-event staging | `electron/server/lib/reveal-pacing.ts` |
| Selection: seeded derivation, no immediate repeats, cap per effect, coherence modes, reroll | `electron/server/lib/reveal-selection.ts` |
| The render itself (local FFmpeg, the same encoder settings every scene clip uses) | `electron/server/lib/reveal-render.ts` |
| A preview harness that renders one clip per preset per pace, with a receipt | `scripts/reveal-preview.mts` |

**Verified `[M]`, 2026-09-27, on this Mac:**

- All 20 presets × 4 paces render (76 clips) on a real scene image, plus the draw-on against line
  art. Contact sheets and `receipt.json` per run.
- **Determinism:** the same preset, pace and window rendered twice gives the identical MP4
  (`sha256 8fa79ca5…`), identical plan and identical filter strings.
- 24 engine tests (`electron/server/__tests__/reveal-engine.test.ts`), including the chain
  arithmetic, the graph's label closure, and every randomisation rule.

**Not built yet — the next slice, in this order:**

1. **The surfaces.** Nothing in the UI can choose a reveal yet. The settings belong beside the
   existing animation randomisation (`animation_pool` / `animation_randomize` / `animation_seed`
   on the video-assembly request): a pool, a seed, a coherence mode, a pace, and a per-scene
   reroll. The plan is already computed deterministically, so the UI only has to *show* it.
2. **The Content Pack kind.** The design says presets ship as Content Packs. The engine's presets
   are built-ins today; a `reveal` kind in `content-packs/schemas.ts` (the shape `scene-effect`
   already uses) is what makes them portable, and it is a small, well-worn change.
3. **The assembly integration — this is the payout.** A reveal clip is longer than the still clip
   it replaces (reveal + hold), so a scene carries 10–15 s instead of 5 and an episode needs
   roughly 2.4× fewer images. That needs `prepareSceneClips` to render reveal clips when the
   episode enables them, and the timeline to take its durations from `planSceneHold` rather than
   the uniform recycling default.
4. **The full-episode check** the design asks for: one episode at Slow pace, watched end to end,
   to judge whether the pacing reads as considered or as padding.

**One honest approximation, already labelled in the app:** the draw-on family is a directional
wipe across the line art, not a stroke-ordered trace — reproducing the order a hand would draw
the lines needs a vector trace (potrace-style) that this version does not do. The preset carries
that sentence in its `approximation` field, and the UI shows it.

---

## Verification receipts

`scripts/reveal-preview.mts` writes `receipt.json` beside the clips it renders: the resolved plan
(reveal, hold, micro-event offsets), the document, the FFmpeg filter graph and the exact argument
list. The runs behind the table above:

| Run | Command | Result |
| --- | --- | --- |
| Every preset × every pace | `npx tsx scripts/reveal-preview.mts --image <scene.png> --out /tmp/reveals/set --family all --pace all` | 76 clips, 1280×720, 6–12 s each |
| Draw-on on line art | `--image /tmp/reveals/line-art.png --preset reveal-draw-on --pace slow` | paper field, ink arriving diagonally |
| Determinism | the same clip rendered twice, compared by sha256 | identical bytes, identical plan and filters |

The arrival was also read frame by frame (0.25 s apart) for `reveal-rows` at Slow: dark field →
a sliver at 0.75 s → a third at 1.25 s → complete at 2.4 s, which is the reveal length the pace
chose.
