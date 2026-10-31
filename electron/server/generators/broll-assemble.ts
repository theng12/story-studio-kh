/**
 * B-Roll video assembly executor — concatenates clips from the per-
 * episode selection sidecar, mixes narration + B-Roll audio + bg music
 * (when present), and renders a single 1920×1080 MP4.
 *
 * Pipeline:
 *   1. Read the selection sidecar (must exist; /broll/assemble validates).
 *   2. Build an FFmpeg filtergraph:
 *      a. For each clip: pick normalized variant if available
 *         (.broll-normalized/<filename>) for fast concat; else use
 *         original and scale/fps in the filtergraph at render time.
 *      b. Trim each clip to its target_duration. For pacing=timed where
 *         segment > native, loop the clip. For pacing=rotate the cap is
 *         already ≤ native so trim is straightforward.
 *      c. Concat all video segments.
 *      d. Mix audio: narration full + B-Roll audio at broll_volume/100
 *         (when broll_volume > 0; omit B-Roll audio entirely when 0).
 *      e. Burn subtitles if a project SRT exists for this episode.
 *   3. Encode H.264 CRF 20 + AAC, write to <episode>/video/.
 *   4. Append usage log entries (one per unique clip in the sequence)
 *      and truncate to keep the last N where N = broll_lookback * 3
 *      (3× headroom so a lookback of 10 doesn't lose history after 11
 *      episodes if the user bumps it later).
 *
 * Minimum-viable scope here: no transitions library, no Ken Burns, no
 * overlay layers. Those plug into the existing video_assembly path's
 * controls in Phase 3.5+.
 */
import path from 'path'
import { existsSync } from 'fs'
import fsp from 'fs/promises'
import { spawn } from 'child_process'
import { appendCappedTail, stillDecoderArgs } from '../lib/ffmpeg-utils.js'
import { MIX_LIMITER } from '../lib/final-loudness.js'
import * as pm from '../services/project-manager.js'
import * as bp from '../services/broll-pool-manager.js'
import * as jq from '../services/job-queue.js'
import { getSelectionSidecar } from '../services/broll-selection-sidecar.js'
import { trimUsageLogToEpisodes } from '../services/broll-selection.js'
import { resolveEpisodePaths } from '../services/utils.js'
import { withFinalVideoPathLock } from '../services/final-video-lock.js'
import {
  inspectBrollAssemblyOutput,
  inspectBrollRenderCoverage,
  readVideoVisualSource,
  resolveAuthoritativeBrollNarration,
  snapshotBrollNarration,
  writeVideoAssemblySourceStamp,
} from '../services/video-visual-source.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { getFFmpegPath, getFFprobePath } from '../services/ffmpeg-manager.js'
import { buildBrollMotion, type BrollMotion, pickRotatedMotion } from '../lib/broll-motion.js'
import { getTransition } from '../models/transitions.js'
import {
  buildSubtitleAssDocument,
  buildSubtitleForceStyle,
  parseSrt,
} from '../lib/subtitle-builder.js'
import { normalizeSubtitleStyle, assOnlySubtitleFeatures } from '../contracts/subtitle-style.js'
import { declareJobDegraded } from '../services/job-completion.js'
import { resolveBurnSubtitle } from '../lib/subtitle-selection.js'
import type { Job, BrollUsageEntry, VideoSubtitleStyle } from '../models/types.js'

/**
 * Probe whether a file contains an audio stream. Used to decide between
 * a real audio trim filter (clip has audio) and an anullsrc silence
 * generator (clip has no audio) when building the amix branch. Falls
 * back to false on any probe error — silence is the safer default.
 */
async function hasAudioStream(filePath: string): Promise<boolean> {
  const ffprobe = await getFFprobePath()
  return new Promise((resolve) => {
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ])
    let stdout = ''
    proc.stdout.on('data', (d) => stdout += String(d))
    proc.on('error', () => resolve(false))
    proc.on('close', () => resolve(stdout.trim() === 'audio'))
  })
}

interface AssembleParams {
  episode_id: string
  title: string
  broll_volume: number
  /** v1.0.127+ — when false, skip subtitle burn-in even if a file exists.
   *  Was previously implicit "present == on" which forced users to delete
   *  the SRT to render without subtitles. Default true preserves legacy
   *  behaviour: callers who don't pass the field still get subtitles
   *  burned when a file is present. */
  subtitles_enabled?: boolean
  /** When present, subtitle style is applied to the burn-in. Precise placement
   *  or animation uses a generated ASS document; legacy static placement uses
   *  the subtitles filter's force_style override. */
  subtitles_style?: VideoSubtitleStyle
}

/** The testable producer boundary: reject unusable staged bytes before the
 * canonical final is touched, then promote/stamp/re-audit under one lock. */
export async function promoteVerifiedBrollFinal(input: {
  tempPath: string
  finalPath: string
  projectSlug: string
  episodeId: string
  title: string
  narrationPath: string
  paths: Awaited<ReturnType<typeof resolveEpisodePaths>>
  visualSource: Awaited<ReturnType<typeof readVideoVisualSource>>
  narrationEvidence: Awaited<ReturnType<typeof snapshotBrollNarration>>
}): Promise<{ bytes: number; completion: Awaited<ReturnType<typeof inspectBrollAssemblyOutput>> }> {
  return withFinalVideoPathLock(input.finalPath, async () => {
    const currentNarration = await snapshotBrollNarration(
      input.narrationPath, input.paths, input.episodeId,
    )
    if (currentNarration.location !== input.narrationEvidence.location
      || currentNarration.filename !== input.narrationEvidence.filename
      || currentNarration.sha256 !== input.narrationEvidence.sha256
      || Math.abs(currentNarration.duration_sec - input.narrationEvidence.duration_sec) > 0.05) {
      throw new Error('Narration changed during B-Roll Assembly. The prior final was preserved; Retry Assembly against the current audio.')
    }
    const staged = await inspectBrollRenderCoverage(
      input.tempPath, input.narrationEvidence.duration_sec,
    )
    if (!staged.complete) {
      throw new Error(`${staged.reason} The prior final was preserved. ${staged.retry_hint}`.trim())
    }

    await fsp.rename(input.tempPath, input.finalPath)
    const stat = await fsp.stat(input.finalPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`Final video is empty: ${path.basename(input.finalPath)}`)
    }
    await writeVideoAssemblySourceStamp(
      input.finalPath,
      input.episodeId,
      input.visualSource.source,
      input.visualSource.image_pool,
      input.narrationEvidence,
      0,
    )
    const completion = await inspectBrollAssemblyOutput({
      project_slug: input.projectSlug,
      episode_id: input.episodeId,
      title: input.title,
      final_video_path: input.finalPath,
    })
    if (!completion.complete) {
      throw new Error(`${completion.reason} ${completion.retry_hint}`.trim())
    }
    return { bytes: stat.size, completion }
  })
}

export async function generateBrollAssemble(job: Job): Promise<void> {
  const { project_slug, episode_id } = job
  const {
    title,
    broll_volume = 0,
    subtitles_enabled = true,
    subtitles_style,
  } = job.params as AssembleParams

  const sidecar = await getSelectionSidecar(project_slug, episode_id, title)
  if (!sidecar || !sidecar.selection?.length) {
    throw new Error('No selection sidecar — run /broll/pick (or /image-pool/pick) before assembling.')
  }
  // v1.0.407 — Image Pool slideshow: same assembler, but each input is a
  // looped still (crop-filled to the frame) instead of a video clip, and
  // there's no clip audio to mix. Driven by the sidecar's media stamp.
  const isImage = (sidecar as any).media === 'image'
  const fitMode: 'crop' | 'fit' | 'blur' = ((sidecar as any).fit === 'fit' || (sidecar as any).fit === 'blur') ? (sidecar as any).fit : 'crop'
  const pool = await bp.getPool(sidecar.pool_id)
  if (!pool) throw new Error(`Pool '${sidecar.pool_id}' missing from registry`)
  if (!existsSync(pool.folder_path)) {
    throw new Error(`Pool folder offline — plug in the SSD at ${pool.folder_path} before rendering.`)
  }

  job.output_lines.push(`Pool: ${pool.name} (${pool.folder_path})`)
  job.output_lines.push(`Selection: ${sidecar.selection.length} clip(s) · pacing=${sidecar.pacing_mode}`)

  // Resolve each clip's on-disk path. Prefer normalized variant for
  // concat performance; fall back to the original with filtergraph
  // scaling at render time. The renderer below uses one consistent
  // filtergraph approach for all clips regardless of normalization
  // state, so mixing in this batch is harmless.
  const clipPaths: Array<{ src: string; duration: number; normalized: boolean }> = []
  // A clip renamed in the library after the pick keeps its sha256, so a
  // missing filename is looked up by content before failing.
  let byShaCache: Map<string, string> | null = null
  const renamedTo = async (sha: string | undefined): Promise<string | undefined> => {
    if (!sha) return undefined
    byShaCache ??= new Map((await bp.listClips(pool.id, { includeMissing: false })).map(c => [c.sha256, c.filename]))
    return byShaCache.get(sha)
  }
  for (const picked of sidecar.selection) {
    let entry = picked
    if (!existsSync(path.join(pool.folder_path, entry.filename))) {
      const current = await renamedTo(entry.sha256)
      if (current && current !== entry.filename) {
        job.output_lines.push(`Clip renamed since the pick: ${entry.filename} → ${current}`)
        entry = { ...entry, filename: current }
      }
    }
    const normalized = path.join(bp.normalizedSubdir(pool.folder_path), entry.filename)
    const original = path.join(pool.folder_path, entry.filename)
    if (existsSync(normalized)) {
      clipPaths.push({ src: normalized, duration: entry.target_duration, normalized: true })
    } else if (existsSync(original)) {
      clipPaths.push({ src: original, duration: entry.target_duration, normalized: false })
    } else {
      throw new Error(`Clip missing from pool folder: ${entry.filename}`)
    }
  }

  // Narration audio: find merged or single-file. Same logic as the
  // selector's duration probe; we re-walk here so a sidecar generated
  // pre-merge but assembled post-merge picks up the merged file.
  const paths = await resolveEpisodePaths(project_slug, episode_id, title || '')
  const narrationPath = await resolveAuthoritativeBrollNarration(paths, episode_id)
  if (!narrationPath) throw new Error('No narration audio found — generate audio (and merge if multi-chapter) first.')
  const visualSource = await readVideoVisualSource(project_slug, episode_id)
  const narrationEvidence = await snapshotBrollNarration(narrationPath, paths, episode_id)

  // v1.0.130+ — Resolve the final output directory BEFORE the render so
  // ffmpeg writes its temp file directly into the final destination. Two
  // wins: (1) honors the user's `external_final_video_root` opt-in
  // (Settings → Storage) so B-Roll renders can land OUTSIDE iCloud-synced
  // project trees, matching the scene-based video.ts:1395-1437 path; (2)
  // no cross-filesystem rename, so the EXDEV copy-and-delete fallback
  // dance isn't needed. Falls back to the project tree's `video_dir` if
  // the external root isn't set or resolution fails — never blocks a
  // render because of misconfigured optional storage.
  const outFilename = `${episode_id}_final_video.mp4`
  let finalDir = paths.video_dir
  try {
    const { ensureExternalFinalVideoDir } = await import('../services/external-video-store.js')
    const externalDir = await ensureExternalFinalVideoDir(project_slug, episode_id, title || '')
    if (externalDir) {
      finalDir = externalDir
      job.output_lines.push(`External final-video root configured → ${finalDir}`)
    }
  } catch (e: any) {
    job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
  }
  await fsp.mkdir(finalDir, { recursive: true })
  const outPath = path.join(finalDir, outFilename)
  const tempPath = path.join(finalDir, `.tmp-${Date.now()}-${outFilename}`)

  // v1.0.130+ — Clean up stale .tmp- orphans from prior crashes / cancels
  // for THIS episode's output before starting. The dot-prefix was meant to
  // hide in-progress renders from Finder, but if the rename to outPath
  // never ran (ffmpeg crashed, user cancelled, OS killed the process), the
  // hidden temp file sits on disk forever — and on iCloud-synced project
  // trees, it syncs across machines too. Walk finalDir for any prior
  // `.tmp-…-${outFilename}` and remove it. Strict filename match so we
  // never delete unrelated temp files in the same directory.
  try {
    const existing = await fsp.readdir(finalDir).catch(() => [])
    for (const f of existing) {
      if (!f.startsWith('.tmp-') || !f.endsWith(outFilename)) continue
      const full = path.join(finalDir, f)
      if (full === tempPath) continue  // ours from this run — ffmpeg will overwrite
      await fsp.rm(full, { force: true }).catch(() => { /* best effort */ })
      job.output_lines.push(`Cleaned up stale temp file: ${f}`)
    }
  } catch { /* swallow — cleanup is best-effort */ }

  // ── Probe each clip for audio presence ────────────────────────────
  // amix needs every input stream to actually exist; clips without an
  // audio track get a generated silence stream of the same target
  // duration so concat + amix work uniformly.
  const clipHasAudio: boolean[] = []
  if (broll_volume > 0 && !isImage) {
    for (const c of clipPaths) clipHasAudio.push(await hasAudioStream(c.src))
  }

  // ── Subtitle burn-in (optional) ────────────────────────────────────
  // Mirrors the existing video-assembly path's behaviour — picks up an
  // SRT / ASS / VTT in the episode's subtitles_dir and burns it into
  // the final video. Path needs single quotes escaped for ffmpeg's
  // subtitles filter (its parser is finicky about colons in macOS paths).
  // v1.0.127+ — Only locate the SRT when subtitles are enabled. Disabled
  // skips the disk scan AND the burn-in branch below, no matter what
  // files exist in subtitles_dir. The user can keep a generated SRT on
  // disk and toggle rendering with subs vs without without re-running
  // the generate step.
  // v1.0.396 — honour the user's pinned subtitle (.selected_subtitle sidecar),
  // else AUTO-pick the full stitched/whisper transcript over per-chapter
  // partials. Replaces the old "first .srt in readdir order" which alphabetically
  // favoured Chapter_01 over the full _stitched file.
  const subPath = subtitles_enabled ? await resolveBurnSubtitle(paths.subtitles_dir) : null
  function escapeForSubtitlesFilter(p: string): string {
    // ffmpeg's subtitles filter interprets `:` as an argument separator
    // unless the path is wrapped + colons escaped. Backslash-escape both.
    return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  }
  // v1.0.127+ — force_style overrides. ffmpeg's subtitles filter accepts
  // a `force_style=` clause that libass applies on top of the file's own
  // styling, mirroring the scene-based assembly's per-style overrides.
  // The value must NOT be wrapped in single quotes (the outer filter is
  // already inside single quotes); commas inside the value are fine.
  function escapeForceStyleValue(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  }
  // v1.1.0 — the full ASS document is the ONLY styled path, exactly as in the
  // scene assembler. `force_style` remains solely as the fallback for a
  // subtitle file that will not parse; it can express no word mode, no
  // animation, no precise placement, and it ignores the style's line-wrapping
  // entirely. Keeping both assemblers on one renderer is what guarantees a
  // preset looks the same whether the episode uses scenes or a B-Roll pool.
  const normalizedSubtitleStyle = subtitles_style ? normalizeSubtitleStyle(subtitles_style) : null
  let generatedSubtitleAssPath: string | null = null
  let subtitleFallbackReason: string | null = null
  if (subPath && normalizedSubtitleStyle) {
    try {
      const cues = parseSrt(await fsp.readFile(subPath, 'utf-8'))
      if (cues.length > 0) {
        const rendered = buildSubtitleAssDocument(cues, normalizedSubtitleStyle, { width: 1920, height: 1080 })
        if (!rendered.events) throw new Error('subtitle document contained no events')
        generatedSubtitleAssPath = path.join(finalDir, `.tmp-${Date.now()}-${episode_id}-subtitles.ass`)
        await fsp.writeFile(generatedSubtitleAssPath, rendered.ass, 'utf-8')
        if (normalizedSubtitleStyle.word.mode !== 'off') {
          job.output_lines.push(`Subtitles: word mode ${normalizedSubtitleStyle.word.mode} using ${rendered.wordPrecision} word timing (${rendered.events} events).`)
        }
      } else {
        subtitleFallbackReason = 'the subtitle file contained no parseable cues'
        job.output_lines.push('Subtitles: selected file could not be converted for styling; using its original formatting.')
      }
    } catch (error: any) {
      subtitleFallbackReason = error?.message || String(error)
      job.output_lines.push(`Subtitles: styled document preparation failed (${error?.message || error}); falling back to coarse anchors, which cannot render word modes, animation or line wrapping.`)
      generatedSubtitleAssPath = null
    }
    // Same contract as the scene assembler: a fallback that ships without the
    // requested caption features must say so in `result.degraded`, not only in
    // the job log (AGENTS.md §8).
    if (!generatedSubtitleAssPath) {
      const assOnlyFeatures = assOnlySubtitleFeatures(normalizedSubtitleStyle)
      if (assOnlyFeatures.length) {
        declareJobDegraded(job, {
          tier: 'B-Roll subtitles force_style fallback',
          reason: subtitleFallbackReason || 'the styled subtitle document could not be built',
          requested: assOnlyFeatures,
          survived: ['caption text and basic style'],
          dropped: assOnlyFeatures,
        })
      }
    }
  }
  const forceStyleClause = (subPath && normalizedSubtitleStyle)
    ? `:force_style='${escapeForceStyleValue(buildSubtitleForceStyle(normalizedSubtitleStyle))}'`
    : ''

  // ── Resolve per-segment motion + transition for this episode ──────
  //
  // The selection sidecar carries motion_mode + motion_default + motion_pool
  // + transition_id + transition_duration. Build the per-segment motion
  // assignment up front so the filtergraph generation stays linear.
  type Motion = BrollMotion
  const motionMode = (sidecar as any).motion_mode || 'fixed'
  const motionDefault: Motion = ((sidecar as any).motion_default || 'static') as Motion
  const motionPool: Motion[] = Array.isArray((sidecar as any).motion_pool)
    ? ((sidecar as any).motion_pool as Motion[])
    : ['static']
  const perSegmentMotion: Motion[] = clipPaths.map((_, i) => {
    if (motionMode === 'fixed') return motionDefault
    if (motionMode === 'rotate') return motionPool[i % motionPool.length] || 'static'
    // 'random' — seeded per-segment so re-rendering the same sidecar gives
    // identical output. Seed = episode + clip index for determinism.
    const seed = (episode_id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 0) + i) | 0
    return pickRotatedMotion(motionPool, seed)
  })

  const transitionId = (sidecar as any).transition_id || 'none'
  const transitionDef = getTransition(transitionId)
  const useXfade = !!(transitionDef && transitionDef.xfade && clipPaths.length >= 2)
  const xfadeDur = useXfade
    ? Math.max(0.1, Math.min(2.0, (sidecar as any).transition_duration || 0.5))
    : 0

  job.output_lines.push(
    `Motion: mode=${motionMode}${motionMode === 'fixed' ? ` (${motionDefault})` : ` pool=[${motionPool.join(',')}]`}`,
  )
  if (useXfade) {
    job.output_lines.push(`Transitions: ${transitionDef!.label} (${xfadeDur}s xfade between every clip)`)
  } else if (transitionId !== 'none') {
    job.output_lines.push(`Transitions: requested "${transitionId}" but falling back to hard cuts (single-clip episode or unknown id).`)
  } else {
    job.output_lines.push(`Transitions: hard cuts (no xfade)`)
  }

  // ── Build the filtergraph ──────────────────────────────────────────
  //
  // Per-clip preparation (always): trim → motion filter → fps lock →
  //                                 setsar → produce label [vN].
  //
  // Stitch — two paths:
  //   useXfade=false → concat=n=N:v=1:a=0 → [vbase]
  //   useXfade=true  → xfade chain: pairwise xfade with running offset.
  //                    Each xfade's offset = sum(prior clip durations) - xfadeDur
  //                    Output of pair = (sum of prior durations) - xfadeDur,
  //                    so the next xfade's offset uses the chained label.
  //
  // Then: [vbase] subtitles='…' → [vout]   (only when an SRT exists)
  const targetFps = pool.fps_target
  // v1.0.407 — still images aren't frame-sized like normalized clips, so
  // bring each one to the 1920×1080 frame BEFORE motion: crop = fill +
  // slight crop (the chosen default), fit = letterbox. After this prefix the
  // source is exactly frame-sized, so buildBrollMotion's zoom/pan (and its
  // static pad case) behave identically to a normalized clip.
  const imagePrefix = fitMode === 'fit'
    ? `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,`
    : `scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,setsar=1,`
  const filterParts: string[] = []
  for (let i = 0; i < clipPaths.length; i++) {
    const c = clipPaths[i]!
    const motionFilter = buildBrollMotion({ motion: perSegmentMotion[i]!, duration: c.duration })
    filterParts.push(
      `[${i}:v]trim=duration=${c.duration},setpts=PTS-STARTPTS,` +
      `${isImage ? imagePrefix : ''}${motionFilter},fps=${targetFps},setsar=1[v${i}]`,
    )
  }

  // Pre-subtitle stitch label.
  let stitchLabel: string
  if (useXfade) {
    // Build an n-way xfade chain. Output of each step replaces the previous
    // base. Offsets are cumulative in the OUTPUT timeline (not the source
    // timeline) — that's why xfadeDur is subtracted at each step.
    let prevLabel = '[v0]'
    let cumulativeOutDur = clipPaths[0]!.duration
    for (let i = 1; i < clipPaths.length; i++) {
      const outLabel = (i === clipPaths.length - 1) ? '[vxfade_final]' : `[vxfade${i}]`
      const offset = (cumulativeOutDur - xfadeDur).toFixed(3)
      filterParts.push(
        `${prevLabel}[v${i}]xfade=transition=${transitionDef!.xfade}:duration=${xfadeDur}:offset=${offset}${outLabel}`,
      )
      cumulativeOutDur = cumulativeOutDur + clipPaths[i]!.duration - xfadeDur
      prevLabel = outLabel
    }
    stitchLabel = '[vxfade_final]'
  } else {
    const concatLabels = clipPaths.map((_, i) => `[v${i}]`).join('')
    filterParts.push(`${concatLabels}concat=n=${clipPaths.length}:v=1:a=0[vstitched]`)
    stitchLabel = '[vstitched]'
  }

  // Final video label — subtitle burn-in if enabled AND a file exists.
  let finalVideoLabel = stitchLabel
  if (generatedSubtitleAssPath) {
    filterParts.push(`${stitchLabel}ass=filename='${escapeForSubtitlesFilter(generatedSubtitleAssPath)}'[vout]`)
    finalVideoLabel = '[vout]'
  } else if (subPath) {
    filterParts.push(`${stitchLabel}subtitles='${escapeForSubtitlesFilter(subPath)}':original_size=1920x1080${forceStyleClause}[vout]`)
    finalVideoLabel = '[vout]'
  } else if (!subtitles_enabled) {
    job.output_lines.push(`Subtitles: disabled by request — skipping burn-in even though a file may exist.`)
  }

  const narrationInputIdx = clipPaths.length // first non-clip input
  const args: string[] = ['-y']
  // v1.0.407 — still images must be looped + bounded to their on-screen
  // seconds (`-loop 1 -t N`); video clips are read as-is.
  for (const c of clipPaths) {
    if (isImage) args.push(...(await stillDecoderArgs(c.src)), '-loop', '1', '-t', String(c.duration), '-i', c.src)
    else args.push('-i', c.src)
  }
  args.push('-i', narrationPath)

  // Build the audio filtergraph branch only when we're actually mixing
  // B-Roll audio in. Below volume 1% it's inaudible vs the narration
  // floor — fall through to narration-only to skip the amix overhead.
  const wantMix = broll_volume >= 1 && !isImage  // stills are silent — narration only
  let audioMapTarget = `${narrationInputIdx}:a`
  if (wantMix) {
    for (let i = 0; i < clipPaths.length; i++) {
      const c = clipPaths[i]!
      if (clipHasAudio[i]) {
        filterParts.push(`[${i}:a]atrim=duration=${c.duration},asetpts=PTS-STARTPTS[a${i}]`)
      } else {
        filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${c.duration}[a${i}]`)
      }
    }
    const aConcatLabels = clipPaths.map((_, i) => `[a${i}]`).join('')
    filterParts.push(`${aConcatLabels}concat=n=${clipPaths.length}:v=0:a=1[aconcat]`)
    filterParts.push(`[aconcat]volume=${(broll_volume / 100).toFixed(3)}[aducked]`)
    // normalize=0: the narration stays at full level instead of being halved by amix (1.4.270).
    filterParts.push(`[aducked][${narrationInputIdx}:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,${MIX_LIMITER}[aout]`)
    audioMapTarget = '[aout]'
  }

  args.push('-filter_complex', filterParts.join(';'))
  args.push('-map', finalVideoLabel)
  args.push('-map', audioMapTarget)
  // Encoder
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(targetFps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest', // stop when narration ends (clips already pad past it)
    '-movflags', '+faststart',
    tempPath,
  )

  if (wantMix) {
    const withAudio = clipHasAudio.filter(Boolean).length
    job.output_lines.push(
      `B-Roll audio: ${broll_volume}% (mixed under narration). ` +
      `${withAudio}/${clipPaths.length} clip(s) have audio; rest filled with silence.`,
    )
  } else {
    job.output_lines.push(`B-Roll audio: muted (narration-only mix)`)
  }
  if (subPath) {
    job.output_lines.push(`Subtitles: burning ${path.basename(subPath)} into the final frame.`)
  }
  job.output_lines.push(`Encoding ${clipPaths.length} ${isImage ? 'image(s)' : 'clip(s)'} → ${outFilename}…`)

  const ffmpeg = await getFFmpegPath()
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, args)
      let stderr = ''
      proc.stderr.on('data', (d) => {
        const s = String(d)
        stderr = appendCappedTail(stderr, s)
        const tMatch = /time=([\d:.]+)/.exec(s)
        if (tMatch) {
          const last = job.output_lines[job.output_lines.length - 1] || ''
          if (!last.startsWith('  progress:')) job.output_lines.push(`  progress: ${tMatch[1]}`)
          else job.output_lines[job.output_lines.length - 1] = `  progress: ${tMatch[1]}`
        }
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) return resolve()
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))
      })
      const cancelWatcher = setInterval(() => {
        if (jq.isCancelled(job.job_id)) { proc.kill('SIGTERM'); clearInterval(cancelWatcher) }
      }, 500)
      proc.on('close', () => clearInterval(cancelWatcher))
    })
  } catch (err) {
    // v1.0.130+ — Error-path cleanup. Without this, a failed/cancelled
    // ffmpeg leaves the `.tmp-…` file hidden in finalDir (which on
    // iCloud-synced project trees syncs across every machine). The
    // startup cleanup above catches it on the next run, but an immediate
    // sweep prevents the user's Finder from showing a partial render
    // they can't see (and can't easily delete without `ls -la`). Best
    // effort — if removal fails (file already gone, perms), we just
    // rethrow the original ffmpeg error.
    await fsp.rm(tempPath, { force: true }).catch(() => { /* swallow */ })
    if (generatedSubtitleAssPath) await fsp.rm(generatedSubtitleAssPath, { force: true }).catch(() => { /* swallow */ })
    throw err
  }

  if (generatedSubtitleAssPath) await fsp.rm(generatedSubtitleAssPath, { force: true }).catch(() => { /* swallow */ })

  // Reject a short/unprobeable staged render before touching any valid prior
  // final, then promote, stamp, and re-prove under one final-path lock.
  let promoted: Awaited<ReturnType<typeof promoteVerifiedBrollFinal>>
  try {
    promoted = await promoteVerifiedBrollFinal({
      tempPath,
      finalPath: outPath,
      projectSlug: project_slug,
      episodeId: episode_id,
      title,
      narrationPath,
      paths,
      visualSource,
      narrationEvidence,
    })
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => { /* promotion may already have consumed it */ })
    throw error
  }
  requireJobCompletion(job, {
    label: 'B-Roll Assembly',
    expected: 1,
    completed: promoted.completion.complete ? 1 : 0,
    invalid: promoted.completion.complete ? [] : [outFilename],
    item_name: 'final video',
    retry_hint: promoted.completion.retry_hint || 'Retry B-Roll Assembly; completed inputs are preserved.',
  })
  job.output_dir = finalDir
  job.output_lines.push(`Done → ${outFilename} (${(promoted.bytes / 1024 / 1024).toFixed(1)} MB)`)

  // Append usage log (per-channel) — for cross-episode repeat avoidance.
  // Image pools use a SEPARATE log so their dedup never collides with B-Roll's.
  await appendUsageLog(project_slug, episode_id, sidecar.selection, isImage)
}

async function appendUsageLog(
  slug: string,
  episodeCode: string,
  selection: Array<{ filename: string; sha256: string }>,
  isImage = false,
): Promise<void> {
  const cfg = await pm.getConfig(slug)
  if (!cfg) return
  // v1.0.407 — image pools log to image_pool_usage_log (read by /image-pool/pick);
  // video B-Roll keeps broll_usage_log. Independent so the two never interfere.
  const logKey = isImage ? 'image_pool_usage_log' : 'broll_usage_log'
  const existing: BrollUsageEntry[] = Array.isArray((cfg as any)[logKey])
    ? (cfg as any)[logKey]
    : []
  const now = new Date().toISOString()
  // One entry per unique sha in this selection — duplicates within one
  // sequence don't need separate log entries.
  const seen = new Set<string>()
  const additions: BrollUsageEntry[] = []
  for (const s of selection) {
    if (seen.has(s.sha256)) continue
    seen.add(s.sha256)
    additions.push({ clip_sha: s.sha256, clip_filename: s.filename, episode_code: episodeCode, used_at: now })
  }
  // Keep a generous tail, measured in EPISODES (the lookback unit), so a
  // future lookback bump still has history. Image pools default to a
  // 20-episode window.
  const capEpisodes = isImage ? 60 : Math.max(30, ((cfg as any).broll_lookback ?? 10) * 3)
  const merged = trimUsageLogToEpisodes([...existing, ...additions], capEpisodes)
  await pm.updateConfig(slug, { [logKey]: merged } as any)
}
