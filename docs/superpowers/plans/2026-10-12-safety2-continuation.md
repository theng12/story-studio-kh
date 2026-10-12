# Safety checks part 2 — continuation

Owner authorized the existing handoff scope and production takeover on 2026-10-12. Base safety2/core: 650da798914db81083bb19cabf63bc7757f50e85 (local 1.4.301 preparation). Preserve that commit and all unrelated changes. Root owns review, test leases, integration, versioning, DMG/main push and tested release publication.

## Design

Continue the existing per-channel Off/Warn/Block API, registry and Safety checks UI. Reuse safetyGate/safetyMode and current repair/fallback helpers; do not create another policy layer. Warn must reach job.result.safety_warnings. Defaults are lenient except truly broken video/audio/picture output; authentication, model limits, money guards, private uploads and duplicate YouTube protection remain fixed. Explicit stored per-channel choices win; do not rewrite customer config/presets/media.

## Bounded owned tasks

1. Video Assembly/scene-picture wiring: worker owns electron/server/generators/video.ts, lib/video-enabled-inputs.ts and focused new video safety test(s). Wire the fourteen current registry ids (scene_pictures, scenes_approved, stale_picture, picture_opens, scene_overlap, narration_covered, scene_count, merged_audio_exists, subtitles_this_episode, switched_on_inputs, cues_approved, opening_outro, image_pool_covers, final_video_whole). Existing files must remain genuinely renderable; mandatory final artifact existence/decode/FFmpeg completion still prove output. Use current repair/neighbour fallback where an optional check permits continuation.
2. Registry/manual/readiness: worker owns services/safety-checks.ts, routes/scripts.ts, routes/audio-merge.ts, services/asset-status.ts, routes/video.ts, routes/scene-plan.ts and focused new policy/manual/readiness tests. Unlock the fourteen ids; missing narration/final whole/no picture file default Block, others Off/Warn. Set research_approved, lyrics_listen_back, idea_repeat, accepted_idea and retired_media defaults Warn; retired_media copy says costs money. Make manual metadata/audio assembly and fixed 30s readiness checks reflect the same policy. Verify the already-committed lost-writing-request Warn behavior, do not duplicate it.
3. Lyrics length (separate existing worktree feat/lyrics-length): review and finish the inherited uncommitted five-file edits. Prompt 3–4min sheets about250–350words with3verses,3–4choruses,bridge,outro; token allowance must support the requested output without exceeding live published model limits. Duration remains a request, not a guarantee. Preserve existing manifests/model routing and explicit singer recipe. Root integrates only reviewed changes into safety2/core for one release if appropriate.

## Proving / workflow

Every implementer uses Ponytail, Graphify plus source verification and test-first checks. Workers do not commit, publish, deploy, call paid providers, touch real Story data or recursively delegate. There is ONE test suite lease across workers; request the lease from root before RED/GREEN. Code-only graph updated by root after integration; use existing main graph at ~/Developer/story-studio-kh/graphify-out/graph.json now.

Root independently reviews each task and the combined branch. Full release gate: typecheck, lint, five check scripts, backend, frontend, content packs, dist:smoke and test:release; run serially and record completion lines/counts/exit codes. Root lands through normal land/<version>-into-main flow, builds the final DMG from main and publishes through Gateway. Preserve ownership/pauses; no production supervisor overlap. If automatic approval rejects an owner-approved check change, stop that action and report its reason; never route around the rejection.

## Review focus

Warn/Off must not leave an input the renderer cannot use or claim an absent final succeeded. Model/network/auth/file-access protections are independent of optional content checks. Readiness and manual routes must match generators. Omitted configs get documented defaults while explicit channel values remain intact. Lyrics results must remain complete JSON under the actual selected model's live output limit. No model generation in tests.
