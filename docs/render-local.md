# Local render speed-ups (native scene clips, cheaper grade)

Final Video Assembly stays **local-only** (AGENTS.md, unchanged): nothing here sends work to another Mac.
Two changes make the local render much cheaper on an Apple-silicon Mac.

## 1. Native scene-clip renderer

`native/scene-clip/main.swift` is a one-file Swift helper, built by `npm run build:scene-clip` (plain `swiftc`,
arm64, macOS 13+, output `bundled/scene-clip/`, shipped as `Resources/scene-clip/scene-clip`).

* **Node side** (`electron/server/lib/`): `scene-motion-plan.ts` turns the same motion document the FFmpeg
  compiler reads into one `{z, cx, cy, rot, blur, gain}` row per frame; `native-scene-clip.ts` finds the helper,
  proves it runs, writes the job, runs it under the job's cancellation tracking and returns a typed result.
* **Helper**: Metal compute does the camera move (prepared picture built once, then a separable Lanczos cut-out per
  frame, bilinear for rotation), the focus blur, the fade and the RGB->YCbCr conversion; AVAssetWriter/VideoToolbox
  encodes on the media engine. It knows no move names.
* **Where it is used**: `prepareSceneClips`, when the caller says the clips will be decoded and re-encoded by the
  xfade stage (`planTransitionTail > 0`). A native clip is VideoToolbox H.264; stream-copying it next to x264 clips
  would put two SPS/PPS sets under one header, so with hard cuts the stage stays on FFmpeg.
* **Reveals**: only the expensive part (the picture's `zoompan` drift) is native. FFmpeg still runs the field, the
  xfade wipes and the micro-events, so their timing and easing are bit-identical (`prerenderedPicture` in
  `reveal-compiler.ts`).
* **Fallback is per clip and automatic.** A scene falls back to the FFmpeg chain, with the reason in the job log
  (and a tally line at the end of the stage), when: the helper is missing / not arm64 / fails its start-up probe or
  version check; the plan cannot express the effect (footage, non-integer fps); the scene needs an FFmpeg filter
  (chapter-title drawtext); the helper declines the picture (alpha with transparency, non-RGB, unreadable: exit 3);
  the helper fails (exit 4, timeout, crash); or the output fails the concat-compatibility check
  (`scene-clip-compat.ts`: codec, size, fps, pix_fmt, time base 1/(fps*512), range, colour matrix, duration).
  A failed hybrid reveal re-renders with the all-FFmpeg graph.
* **Switches**: `STORY_STUDIO_NATIVE_SCENE_CLIP=0` turns it off; `STORY_STUDIO_SCENE_CLIP_BIN` points at another
  binary (tests). The render fingerprint includes the renderer, so saved clips from one renderer are not mixed with
  the other on resume.
* **Look**: measured against FFmpeg's own clips, not asserted. `FFmpeg` pads and rounds in ways that move the
  picture by up to a pixel (even-snapped `pad`, 25 fps still clock for `rotate`/`fade`/blur gates); the plan and the
  helper reproduce those, and `zoompan`'s per-frame integer crop is deliberately NOT reproduced (smoother, not
  different). Numbers: `_orchestra/audit-20261001/render-local/`.

## 2. Cheaper grade

`colorbalance` (warmth/tint in every grade preset) cost about ten times the rest of the final pass (42 CPU-s per 30 s of
1080p, against 2.7 for decode alone). `grade-balance.ts` replaces it with a two-input `lut2`: the frame as planar RGB
plus the same frame as a grey image, whose value stands in for the lightness `colorbalance` weights by. The table is
built from the measured model of the filter (`l = max+min`, three banded weights, scale 0.7) and rounds, because `lut2`
truncates. `buildColorGradingFilters` now returns filtergraph statements (the grade has a side branch) and takes the
labels to use.

Measured against the real `colorbalance`: on 20 real scene frames across ten presets mean CIEDE2000 0.05-0.12 (p95 <= 0.64,
PSNR 58-64 dB); on frames of a real episode intermediate through the same chain 0.17 mean (PSNR 56.5 dB). The grade itself is
worth 0.8-2.4. Cost 18 CPU-s per 30 s instead of 42 (about 2x on the whole final pass).

A per-channel `curves` (8 CPU-s) was built and measured first and rejected: a 1-D curve cannot see the pixel's
lightness, and on dark saturated night frames it differs from the old filter by a mean dE of 0.75-2.1.

## Not done

* A cheaper grade still (`curves`, 8 CPU-s) at the price of visible differences on dark scenes; see above.
* Native xfade/transitions, native reveal wipes, or x264 pipe mode for hard-cut episodes.
* Anything on the fleet.
