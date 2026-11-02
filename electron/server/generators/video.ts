/**
 * Video generator — multi-pass pipeline for assembling scene images + narration + logo + music.
 *
 * Architecture (replaces the old single filter_complex approach):
 *   1. Prep phase   — generate short video clips from each scene image
 *   2. Concat phase — build a concat list that cycles scenes to fill target duration
 *   3. Final phase  — single FFmpeg command: concat + logo overlay + audio mix
 *
 * This scales to 3-hour videos with recycled scenes without blowing up the filter graph.
 */

import { constants, existsSync } from 'fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import * as pm from '../services/project-manager.js'
import { sceneImageStaleReason } from '../services/scene-plan-staleness.js'
import { checkpointJobProgress, checkpointJobState, isCancelled, trackChild } from '../services/job-queue.js'
import { withFinalVideoPathLock } from '../services/final-video-lock.js'
import { publishOverPreviousFinal } from '../services/final-video-retention.js'
import { preparePrivateFinalRenderDescriptor } from '../services/final-render-transport.js'
import { resolveSubfolderNames, resolveScenePlanPath, resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
// v1.0.338 — episode-dir + subfolder lookups consolidated into the shared
// folder-resolver (this file used to carry private copies; the ✅-prefix
// and title-hint semantics moved there verbatim).
import { findEpisodeDir, findSubfolder as resolveSubfolder } from '../lib/folder-resolver.js'
import { findEpisodeSubfolderDir, resolveEpisodeSubfolderDir } from '../services/media-root.js'
import { homogenizeForConcat } from '../lib/audio-concat.js'
import { runFfmpeg, lowerFfmpegPriority, withX264ThreadCap, getAudioDuration, checkFfmpeg, hasDrawtextFilter, formatConcatFileLine, appendCappedTail, stillDecoderArgs, escapeFilterPath, escapeFilterArgValue, ffmpegExitErrorLine } from '../lib/ffmpeg-utils.js'
import { renderRevealClip, revealClipPath } from '../lib/reveal-render.js'
import {
  plannedRevealForScene,
  resolveSceneReveals,
  revealSecondsForImage,
  type ResolvedSceneReveals,
} from '../lib/reveal-assembly.js'
import { mapWithConcurrency } from '../lib/map-with-concurrency.js'
import { mulberry32 } from '../lib/seeded-random.js'
import { MERGED_AUDIO_FILENAME } from '../lib/merged-audio-selection.js'
import { assertDecodableImage, isDecodableImage } from '../lib/image-validation.js'
import { getFFmpegPath } from '../services/ffmpeg-manager.js'
import { bundledFontsFilterOption } from '../lib/subtitle-font-dir.js'
import { assertValidMedia, getMediaInfo, summarizeMedia, fileExistsNonEmpty } from '../lib/ffmpeg-validation.js'
import { planTransitions, buildXfadeFilterComplex, buildVariableXfadeFilterComplex, buildEngineTransitionFilterComplex, fallbackXfadeKeywords, hasTransitionEngine } from '../lib/transition-filters.js'
import { getTransition } from '../models/transitions.js'
import { inspectScenePlanCoverage, COVERAGE_FAIL_SEC } from '../services/scene-planner.js'
import { buildAnimationFilter, resolveSceneMotionDocument, supersampleMultiplier, normalizeFrame, isZoompanAnimation } from '../lib/animation-filters.js'
import { probeNativeSceneClip, renderNativeSceneClip, NATIVE_SCENE_CLIP_VERSION } from '../lib/native-scene-clip.js'
import { sharpenUpscaledStills } from '../lib/upscale-sharpen.js'
import { probeVideoStream, sceneClipCompatibilityProblems } from '../lib/scene-clip-compat.js'
import { getAnimation } from '../models/animations.js'
import { resolveAssetPath, isPortablePath } from '../services/path-resolver.js'
import { checkAssetAvailability } from '../lib/sync-safe.js'
import { finalDurationIssue, missingEnabledVideoInputs, missingInputsMessage, switchedOnCueGate } from '../lib/video-enabled-inputs.js'
import {
  closingMusicWanted, runFinalCheck, storeFinalCheck, finalCheckSummary, readPlannedSectionGaps,
  type FinalCheckExpectation, type FinalCheckIntro, type FinalCheckResult, type PlannedSectionGaps,
} from '../lib/final-video-check.js'
import { withLock } from '../lib/atomic-store.js'
import { estimateBytesForStep, getFreeBytes, formatBytes } from '../lib/disk.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import { resolveStoryStudioVersion } from '../lib/app-version.js'
import {
  buildVideoAssemblyRenderFingerprint,
  createVideoAssemblyCheckpoint,
  findReusableVideoAssemblySceneClips,
  getValidVideoAssemblyCheckpoint,
  moveCheckpointFinalSegments,
  moveCheckpointFinalStage,
  moveCheckpointSceneClips,
  setVideoAssemblyCheckpoint,
  validateVideoAssemblySceneClip,
  type VideoAssemblyCheckpoint,
  type VideoAssemblyCompletedSceneClip,
  type VideoAssemblyFinalSegment,
  type VideoAssemblyFinalStage,
} from '../lib/video-assembly-checkpoint.js'
import { resolveSceneImagesDir } from './scene-image.js'
import { resolveVideoAssetsDir } from './scene-clip.js'
import { sceneClipStaleReason, resolveSketchDrawSettings } from '../services/scene-media-checkpoint.js'
import { buildVideoFrameFilter } from '../lib/video-frame-filter.js'
import {
  FINAL_SEGMENT_SEC, STILL_TAIL_LOOP_SEC, canResumeGraph, concatMuxArgs, frameSecFromFramemd5, hashJson, planFinalSegments, segmentCount,
  segmentRange, segmentRenderArgs, sha256File, splitOneShotArgv, workFolderIdentity, workFolderName,
} from '../lib/segmented-render.js'
import { logoCornerRadiusPct, logoShapeOf, writeShapedLogo } from '../lib/logo-shape.js'
import { displayAspectRatio, frameTextUnit, resolveRenderCanvas } from '../lib/render-canvas.js'
import { inspectSourceAspect } from '../lib/source-aspect.js'
import { buildContextualCueDrawtextFilters, buildLabelOverlayFilters, labelOverlayGeometry, labelCueForRender } from '../lib/contextual-cue-filters.js'
import { findLabelDesign, renderLabelDesign, renderLeaderLine, renderLabelWipe, writeLabelRevealFrames } from '../lib/label-design-render.js'
import { resolveLabelTargets } from '../lib/label-target.js'
import { measureOpeningSec } from '../lib/opening-duration.js'
import {
  buildColorGradingFilters,
  buildGateEnable,
  buildGateExpression,
  buildLetterboxFilter,
} from '../lib/video-effects.js'
import { compileSceneMotion, compileSceneOverlay, letterboxBarHeight, overlayLoopShapes } from '../lib/scene-effect-compiler.js'
import { assertNoUnavailablePackOverlays, isRotationMotion, motionPoolSlots, resolveAppliedOverlays } from '../contracts/scene-effect-presets.js'
import { LIBRARY_V1_5_KINDS } from '../contracts/scene-effects.js'
import { describeEffectStack, normalizeEffectsLook, splitLegacySlots } from '../contracts/effects-look.js'
import { loopShapeKey } from '../contracts/effect-loops.js'
import { bakeEffectLoop, bakeTransitionMatte } from '../lib/effect-loop-baker.js'
import {
  emptyEpisodeEffects,
  episodeEffectsCount,
  isLowerStackGroup,
  readEpisodeEffects,
  resolveEpisodeEffectStack,
  resolveSceneStage,
  type ResolvedEpisodeStack,
  type ResolvedStackEntry,
  type SceneWindow,
} from '../services/episode-effects.js'
import { listSceneEffectLibrary } from '../services/style-effect-loader.js'
import { applySceneStage, sceneClipEncodeArgs, type SceneStageItem } from '../lib/scene-stage.js'
import { readSceneAnalysis, resolveVisionMotion, sceneAnalysisSwitches, visionFromEntry, SCENE_ANALYSIS_DIR, type SceneVision } from '../services/scene-analysis.js'
import { OUTLINE_MASK_DIR, outlineMaskPath } from '../services/outline-masks.js'
import { requireJobCompletion, declareJobDegraded } from '../services/job-completion.js'
import { nonRetryable } from '../services/job-retry-policy.js'
import { FINAL_RENDER_ACCEPTED_FINAL_CONFLICT } from '../lib/final-render-remote-wait.js'
import { EBUR128_FILTER, measureLoudness, parseEbur128Summary, type LoudnessMeasurement } from './music-episode-build.js'
import { finalLoudnessIssue, loudnessTarget, withinToleranceNote, type LevelPlan, type LoudnessTarget } from '../lib/final-loudness.js'
import {
  defaultEncodingEffort,
  describeEncoder,
  encoderKind,
} from '../lib/final-render-encoder.js'
import {
  buildFinalArchiveFilters,
  buildFinalEncodeTiers,
  buildFinalFilmGrainFilters,
  buildFinalInputArgs,
  buildFinalLogoFilters,
  buildFinalOverlayFilters,
  buildFinalVignetteFilters,
  describeFinalBurnIns,
  type EncodeTier,
} from '../lib/final-render-core.js'
import { isStaticImagePath as isFinalRenderStaticImagePath } from '../lib/final-render-export.js'
import { levelAndCheck, mergedAudioMaster } from '../lib/level-audio.js'
import { safetyGate, safetyMode } from '../services/safety-checks.js'
import {
  normalizeContextualCueConfig,
  resolveRenderableContextualCues,
} from '../services/contextual-cues.js'
import {
  DEFAULT_SOUND_DESIGN_SETTINGS,
  normalizeSoundDesignConfig,
  resolveRenderableSoundCues,
} from '../services/sound-design.js'
import { describeAnchorMoves, hasAnchorMoves, readAnchoredEpisodeCues } from '../services/sound-cue-anchors.js'
import { stitchedSrtPath } from '../services/subtitle-correction.js'
import { formatSoundCredits } from '../services/sound-resolver.js'
import { approvedSoundDesignMixCues } from '../services/sound-design-resolver.js'
import { mixSoundDesignIntoAudio } from '../lib/sound-design-mixer.js'
import {
  describeMergedAudioOpening,
  type MergedAudioOpening,
} from '../services/merged-audio-opening.js'
import { scenePlanLeadInShiftSec, shiftScenesForLeadIn } from '../lib/intro-lead-in.js'
import { mergedBackgroundMusic, narrationSecFromMaster, postRollSeconds } from '../lib/closing-tail.js'
import { resolveEpisodeMergedAudioChoice } from '../lib/merged-audio-selection.js'
import { compareMergedAudio, MIN_RENDERABLE_SCENE_SEC, unrenderableSceneProblem } from '../lib/scene-plan-timeline.js'
import {
  buildImagePoolPlayOrder,
  readVideoVisualSource,
  resolveImagePoolSelection,
  writeVideoAssemblySourceStamp,
  type VideoVisualSource,
} from '../services/video-visual-source.js'
import type {
  GenerateVideoRequest, Job, VideoLogoConfig, VideoIntroConfig,
  VideoOutroConfig, VideoTimelineClip, VideoTimelineClipStatic, TimelineAnchor,
  VideoTitleImageConfig, VideoTitleCard, VideoOutroCard, VideoSceneRecycling, VideoMusicConfig,
  VideoDurationConfig, VideoColorGrading, VideoVignetteConfig,
  VideoChromaKeyConfig, VideoOverlaysConfig, VideoOverlay, VideoBackgroundNoise, VideoFilmGrain, VideoAgedArchiveFilm, VideoLetterbox, VideoFrameConfig,
  BackgroundPlate, ForegroundDefaults, ForegroundPosition,
  VideoSceneAnimation, VideoPostAudio, VideoScene, ScenePlan, ContextualCue, SoundDesignCue,
} from '../models/types.js'

// ── Constants ──────────────────────────────────────────────────────────────

// The canvas a render will use now lives in `lib/render-canvas.ts`, along with
// the four hardcoded landscape sizes this file used to hold (v1.4.15). The
// caption preflight imports it from there directly — it must draw its frames at
// the render's own canvas, because `buildSubtitleAssDocument` takes its PlayRes
// from these numbers and a preflight at another size would describe a
// differently-scaled caption from the one that gets burned.

const TIMESTAMP_SCENE_IMAGES_SUBFOLDER = 'scene_images'
const SCENE_PLAN_FILENAME = 'scene_plan.json'
type SceneMotionLibrary = Awaited<ReturnType<typeof listSceneEffectLibrary>>['scene_motions']

async function publishLocalFinalVideo(job: Job, source: string, destination: string, publish: () => Promise<void>): Promise<void> {
  return withFinalVideoPathLock(destination, async () => {
    if (job.final_render_remote_wait?.phase !== 'refused') return publish()
    // Exclusive publication protects an accepted final even from a writer in another process.
    try {
      try { await fs.link(source, destination) }
      catch (error: any) {
        if (error?.code !== 'EXDEV') throw error
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      throw nonRetryable(Object.assign(new Error(FINAL_RENDER_ACCEPTED_FINAL_CONFLICT), {
        name: 'FinalRenderFallbackConflict',
      }))
    }
  })
}

export { publishLocalFinalVideo as _publishLocalFinalVideoForTesting }

async function selfHealFinalPromotion(
  currentPath: string,
  projectTreeFinalPath: string,
  finalName: string,
  job: Job,
): Promise<string> {
  if (path.basename(currentPath) === finalName && fileExistsNonEmpty(currentPath)) return currentPath
  if (!fileExistsNonEmpty(currentPath)) return currentPath
  try {
    await publishLocalFinalVideo(job, currentPath, projectTreeFinalPath, async () => {
      await fs.copyFile(currentPath, projectTreeFinalPath)
      if (!fileExistsNonEmpty(projectTreeFinalPath)) throw new Error('copied file is empty')
      await fs.rm(currentPath, { force: true })
    })
    job.output_lines.push(`Self-healed final promotion → ${finalName} (project tree)`)
    return projectTreeFinalPath
  } catch (error: any) {
    if (error?.name === 'FinalRenderFallbackConflict') throw error
    job.output_lines.push(`⚠ Could not self-heal final promotion: ${error?.message || error}`)
    return currentPath
  }
}


/**
 * Give the finished episode its slot in the channel's publishing schedule.
 *
 * v1.4.20, and the owner's report is the whole reason: *"i have to manually
 * update the schedule each time. and also select the videos."* The queue lists
 * episodes on its own — what was manual was picking the new ones out of it and
 * pressing apply. A render already knows which episode it just made, so there
 * is nothing to pick.
 *
 * Gives the finished episode a local publish time and optionally queues its upload.
 * It declines to move an episode that is already public or
 * already scheduled, so re-rendering never disturbs a date you have set.
 *
 * Best-effort by construction. A render that produced a good video must not be
 * reported as failed because a schedule could not be written, so every outcome
 * — including "no plan yet" — is a line in the job log, not an error.
 *
 * The switch is ON unless the channel says otherwise (2026-10-31): a channel
 * that never touched it still gives every finished episode its slot.
 */
async function autoScheduleFinishedEpisode(
  job: Job, project_slug: string, code: string, finalPath: string,
): Promise<void> {
  try {
    const pm = await import('../services/project-manager.js')
    const config = (await pm.getConfig(project_slug)) as any
    const { autoScheduleEnabled } = await import('../services/publish-cadence.js')
    // On unless the channel says otherwise (2026-10-31): the owner wants every
    // finished video to take a slot, and only an explicit `false` turns it off.
    if (!autoScheduleEnabled(config)) return

    const { scheduleCheckedEpisode } = await import('../services/episode-autoschedule.js')
    const result = await scheduleCheckedEpisode(project_slug, code, finalPath, (job.result as any)?.final_check_error === true)
    if (result.hold) job.result = { ...(job.result || {}), auto_schedule_hold: result.hold }
    if (result.scheduled) {
      job.output_lines.push(
        `Scheduled for ${result.publish_at} by plan "${result.plan_name}".`,
      )
    } else if (result.reason) {
      job.output_lines.push(`Not scheduled: ${result.reason}`)
    }
    if (result.auto_upload_log) job.output_lines.push(result.auto_upload_log)
  } catch (e: any) {
    job.output_lines.push(`Could not write a publish time (${e?.message || e}) — the video is fine.`)
  }
}

/**
 * Owner decision 2026-10-09: once the final video is verified and in place, the render's segments
 * are deleted right away (not the Trash Folder). Working files only; the one exception to "never
 * delete". Callers run this only after verifyFinalVideo, so any failure keeps them for a resume.
 */
export async function deleteFinalSegments(workDir: string, job: Job): Promise<void> {
  const dir = path.join(workDir, 'final_segments')
  if (!existsSync(dir)) return
  try {
    const names = await fs.readdir(dir)
    const sizes = await Promise.all(names.map(name => fs.stat(path.join(dir, name)).then(s => s.size, () => 0)))
    await fs.rm(dir, { recursive: true, force: true })
    job.output_lines.push(`Final render: deleted ${names.length} segment file(s), ${formatBytes(sizes.reduce((a, b) => a + b, 0))} freed.`)
  } catch (e) {
    // The work folder is removed with the run anyway.
    job.output_lines.push(`Final render segments could not be deleted (${(e as Error)?.message || e}); they are removed with the work folder.`)
  }
}

type EncodeProgress = { offsetSec: number; totalSec: number; label?: () => string }

/** 1.4.265 — the job's checkpoint, how to save it, and what the episode's inputs are (for a resumed final render). */
export type FinalSegmentation = {
  checkpoint: VideoAssemblyCheckpoint
  persist: () => Promise<void>
  /** The render fingerprint without the app version: the same inputs and settings after an update. */
  inputsFingerprint: string
  /** tests only */
  segmentSec?: number
}

// Run the encode. Wrapped in a helper so we can retry once with H.264
// if libx265 returns the EINVAL signature — some concat intermediates
// with mixed colour metadata trigger `return code -22` at x265 init even
// when every clip individually is valid. Falling back is nicer than
// failing the whole job outright; the user ends up with an H.264 .mp4
// rather than no video at all. On any other failure mode, the error
// propagates (no retry).
async function spawnFinalEncode(
  job: Job,
  targetDuration: number,
  encodeArgs: string[],
  progress: EncodeProgress = { offsetSec: 0, totalSec: targetDuration },
): Promise<void> {
  // Resolve the bundled/installed ffmpeg path BEFORE spawning. Packaged Macs
  // without Homebrew's `/opt/homebrew/bin/ffmpeg` in PATH previously hit
  // `spawn ffmpeg ENOENT` at this line — the bundled binary inside
  // `.app/Contents/Resources/ffmpeg/` was never consulted because this
  // caller passed a bare string. All three encode tiers share this helper,
  // so the ENOENT repeated identically across the recovery chain.
  const ffmpegBin = await getFFmpegPath()

  // Wall-clock watchdog. This spawn can take hours on long-form renders
  // (sleep-story channels routinely append 2-3 hours of ambient tail
  // to a 30-min narration), but a pathological input — malformed
  // chapter MP3, CMYK title image, FFmpeg 8 edge case — can also hang
  // it indefinitely. The job queue serialises video jobs, so a stuck
  // encode pins the slot forever and nothing else runs.
  //
  // Scale the watchdog with the actual output `-t` so a 2.5-hour
  // render gets ~3.5h of budget, while a short 5-min clip still has
  // a reasonable safety net. Formula:
  //   floor: 30 min (matches the previous fixed default)
  //   scaled: 1.5× output duration + 5 min buffer
  //   ceiling: 12 hours (truly hung after this much)
  // The env override `STORY_STUDIO_FFMPEG_TIMEOUT_MS` still wins
  // unconditionally — power users with custom workflows can pin a
  // value that ignores the scaling.
  const timeoutMs = computeWatchdogMs(targetDuration, process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS)
  const timeoutMin = Math.round(timeoutMs / 60_000)
  job.output_lines.push(`FFmpeg watchdog: ${timeoutMin} min for ${(targetDuration / 60).toFixed(1)} min output`)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin, withX264ThreadCap(encodeArgs), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    lowerFfmpegPriority(proc)
    // Track for cancellation — the final encode pass is the longest ffmpeg
    // run in the entire pipeline (minutes), so this is the most important
    // cancellable child in the app.
    trackChild(proc)

    let stderr = ''

    let watchdogKilled = false
    const termTimer = setTimeout(() => {
      watchdogKilled = true
      try { proc.kill('SIGTERM') } catch { /* exited */ }
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* exited */ }
      }, 5000)
      proc.once('close', () => clearTimeout(killTimer))
    }, timeoutMs)

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString()
      stderr = appendCappedTail(stderr, line)

      const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/)
      if (timeMatch) {
        const hours = parseInt(timeMatch[1])
        const minutes = parseInt(timeMatch[2])
        const seconds = parseInt(timeMatch[3])
        const ms = parseInt(timeMatch[4])
        const currentTime = hours * 3600 + minutes * 60 + seconds + ms / 100 + progress.offsetSec

        if (progress.totalSec > 0) {
          const percent = Math.min(99, Math.round((currentTime / progress.totalSec) * 100))
          job.progress = percent
          const progressLine = `Encoding: ${percent}% (${currentTime.toFixed(1)}s / ${progress.totalSec.toFixed(1)}s) · ${encoderKind(encodeArgs)}${progress.label?.() ?? ''}`
          const lastIdx = job.output_lines.length - 1
          if (lastIdx >= 0 && job.output_lines[lastIdx].startsWith('Encoding:')) {
            job.output_lines[lastIdx] = progressLine
          } else {
            job.output_lines.push(progressLine)
          }
        }
      }
    })

    proc.on('error', (err) => {
      clearTimeout(termTimer)
      reject(new Error(`FFmpeg failed to start: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      clearTimeout(termTimer)
      if (code === 0) {
        resolve()
        return
      }
      // Watchdog first — distinct message so the job log disambiguates
      // a queue-blocking hang from a user-initiated cancel (which also
      // arrives with signal=SIGTERM). Tag the error so the recovery
      // chain can decide not to retry (a watchdog kill on tier 1 almost
      // certainly means tiers 2/3 will hang the same way).
      if (watchdogKilled) {
        const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
        const lines = stderr.split('\n').filter(l => l.trim())
        const tail = lines.slice(-5).join('\n') || '(no stderr captured)'
        const err = new Error(
          `FFmpeg exceeded ${minutes}-minute wall-clock watchdog — job killed to free the queue. Last stderr: ${tail}`,
        )
        ;(err as any).watchdog = true
        ;(err as any).stderr = stderr
        reject(err)
        return
      }
      // Killed by cancel: surface a clean message, not an exit-code diagnostic.
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`FFmpeg killed (${signal})`))
        return
      }
      // Preserve stderr on the Error object so the retry decision can
      // inspect it. Input paths go straight into the job log for repro.
      const err = new Error(`FFmpeg exited with code ${code}:\n${ffmpegExitErrorLine(stderr)}`)
      ;(err as any).stderr = stderr
      ;(err as any).exitCode = code
      reject(err)
    })
  })
}


// Validate the output file passed by `ffmpeg exit 0` actually contains
// a usable video stream. A 0-byte mp4 from a stream-with-no-packets
// scenario passes the exit-code check but is useless. We re-throw with
// a stderr-shaped Error so the next tier's `shouldRun` can inspect it.
async function validateFinalOutput(outputFile: string, targetDuration: number): Promise<void> {
  if (!fileExistsNonEmpty(outputFile)) {
    const err: any = new Error(`Encoder exited 0 but output file is missing or empty: ${outputFile}`)
    err.stderr = 'output file empty after encode'
    throw err
  }
  try {
    const info = await getMediaInfo(outputFile)
    // The container duration can follow the longer premixed audio track,
    // even when the visual stream stopped early. Use the independently
    // probed video duration whenever ffprobe supplies it so a short concat
    // cannot be promoted as a complete render.
    const videoEndsEarly = info.videoDurationSec !== undefined
      && info.videoDurationSec < targetDuration - 0.25
    if (!info.hasVideo || info.durationSec < 1 || videoEndsEarly) {
      const err: any = new Error(
        `Encoder exited 0 but output is unusable: ${summarizeMedia(info)}`
          + (videoEndsEarly
            ? ` (video ${info.videoDurationSec!.toFixed(3)}s, expected ${targetDuration.toFixed(3)}s)`
            : '')
      )
      err.stderr = 'output validation failed'
      throw err
    }
  } catch (e: any) {
    // Re-throw with .stderr so tier shouldRun checks still work.
    if (e?.stderr) throw e
    const err: any = new Error(`ffprobe rejected encoder output: ${e.message}`)
    err.stderr = `ffprobe: ${e.message}`
    throw err
  }
}


/** Finish a final render that a restart or an update interrupted, with its own saved command. Returns the encoded file. */
export async function resumeSavedFinalRender(
  job: Job,
  stage: VideoAssemblyFinalStage,
  segmentation: FinalSegmentation,
  format: string,
): Promise<string> {
  const argv = stage.argv
  await runSegmentedFinal({
    job, argv, targetDuration: stage.total_render_sec, format, stillTailFrom: stage.still_tail_from, segmentation,
    narrationOffsetSec: stage.narration_offset_sec,
    runEncode: (encodeArgs, progress) => spawnFinalEncode(job, stage.total_render_sec, encodeArgs, progress),
  })
  await validateFinalOutput(argv.at(-1)!, stage.total_render_sec)
  const encoderLine = describeEncoder(argv, false)
  job.output_lines.push(encoderLine)
  job.result = { ...(job.result || {}), encoder: encoderLine.replace(/^Encoder: /, '') }
  return argv.at(-1)!
}

/**
 * The final encode in checkpointed segments (lib/segmented-render.ts): plan, keep every finished
 * segment that still matches, render from the first missing one, record each as it lands, then join
 * them without re-encoding and mux the audio. A render that cannot be cut renders in one piece.
 */
async function runSegmentedFinal(ctx: {
  job: Job
  /** The one-shot argv of the encode tier (`… -t T output`). */
  argv: string[]
  targetDuration: number
  format: string
  stillTailFrom: number | null
  narrationOffsetSec?: number
  segmentation?: FinalSegmentation
  runEncode: (argv: string[], progress?: EncodeProgress) => Promise<void>
}): Promise<void> {
  const { job, argv, targetDuration, format, stillTailFrom, segmentation, runEncode } = ctx
  const split = segmentation && format !== 'webm' ? splitOneShotArgv(argv) : null
  if (!segmentation || !split || !canResumeGraph(split.graph)) return runEncode(argv)
  const outputFile = split.output
  const workDir = path.dirname(outputFile)
  const checkpoint = segmentation.checkpoint
  // The output's own frame grid (a still frame board drives it at 25 fps): two frames are enough.
  const probe = path.join(workDir, 'final_probe.framemd5')
  const probeArgs = [...split.pre]
  probeArgs.splice(split.graph_index, 0, '-filter_complex', split.graph)
  await runFfmpeg([...probeArgs, '-map', '[vout]', '-frames:v', '2', '-f', 'framemd5', probe])
  const frameSec = frameSecFromFramemd5(await fs.readFile(probe, 'utf8').catch(() => ''))
  if (!frameSec) return runEncode(argv)
  const plan = planFinalSegments(targetDuration, frameSec, { stillTailFromSec: stillTailFrom, segmentSec: segmentation.segmentSec })
  const count = segmentCount(plan)
  // What this render reads from the work folder, by sha256 (the audio too: the final join needs it).
  const identity = await workFolderIdentity(argv, workDir, outputFile)
  // The audio may sit in a subfolder (`loudness_first/premixed_audio.wav`), so compare its whole name.
  const audioName = workFolderName(split.audio_input, workDir) ?? path.basename(split.audio_input)
  const videoFiles = Object.fromEntries(Object.entries(identity.files).filter(([name]) => name !== audioName))
  // Segments are video only, so the audio is not part of what makes them valid.
  const fingerprint = hashJson({ version: 1, inputs: segmentation.inputsFingerprint, plan, argv: identity.argv, files: videoFiles })
  // The exact command, so a restart (or an update) finishes this render as it began (generateVideo).
  checkpoint.final_stage = {
    inputs: segmentation.inputsFingerprint, argv, files: identity.files,
    total_render_sec: targetDuration, still_tail_from: stillTailFrom,
    ...(ctx.narrationOffsetSec === undefined ? {} : { narration_offset_sec: ctx.narrationOffsetSec }),
  }
  const segDir = path.join(workDir, 'final_segments')
  await fs.mkdir(segDir, { recursive: true })
  const saved = checkpoint.final_segments
  const kept: VideoAssemblyFinalSegment[] = []
  if (saved?.fingerprint === fingerprint) {
    for (let index = 0; index < count; index++) {
      const seg = saved.segments.find(s => s.index === index)
      const range = segmentRange(plan, index)
      if (!seg || Math.abs(seg.start_sec - range.start_sec) > 1e-6 || Math.abs(seg.end_sec - range.end_sec) > 1e-6
        || (await fs.stat(seg.path).catch(() => null))?.size !== seg.bytes
        || await sha256File(seg.path).catch(() => '') !== seg.sha256) break
      kept.push(seg)
    }
  } else if (saved?.segments.length) {
    job.output_lines.push(`Final render: the ${saved.segments.length} saved segment(s) were made with different inputs or settings, so every segment is rendered again.`)
  }
  checkpoint.final_segments = { fingerprint, segments: kept }
  await segmentation.persist()
  const minutes = (sec: number) => `${(sec / 60).toFixed(1)} min`
  job.output_lines.push(`Final render: ${count} segment(s) of up to ${minutes(FINAL_SEGMENT_SEC)}, each saved as it finishes`
    + (plan.tail_loop
      ? `; the still image from ${minutes(plan.tail_loop.from_sec)} on is rendered once for ${STILL_TAIL_LOOP_SEC}s and repeated (${plan.tail_loop.repeats + 1}×), so ${minutes(plan.render_end_sec)} is rendered for a ${minutes(targetDuration)} video.`
      : '.'))
  const from = kept.length
  if (from) job.output_lines.push(`Final render: resuming at segment ${from + 1} of ${count}; ${from} finished segment(s) (${minutes(segmentRange(plan, from).start_sec)}) are kept.`)

  if (from < count) {
    const listPath = path.join(workDir, `final_segments_${Date.now()}.csv`)
    const group = checkpoint.final_segments
    let recording = Promise.resolve()
    const record = () => {
      recording = recording.then(async () => {
        const listed = (await fs.readFile(listPath, 'utf8').catch(() => '')).split('\n')
        for (const name of listed.map(line => line.split(',')[0]!.trim())) {
          const match = /^final_seg_(\d{4})\.mp4$/.exec(name)
          if (!match || group.segments.some(seg => seg.index === Number(match[1]))) continue
          const file = path.join(segDir, name)
          group.segments.push({ index: Number(match[1]), ...segmentRange(plan, Number(match[1])), path: file,
            bytes: (await fs.stat(file)).size, sha256: await sha256File(file) })
          await segmentation.persist()
        }
      }).catch(() => { /* the next look, or the final one, records it */ })
      return recording
    }
    const timer = setInterval(() => { void record() }, 5_000)
    try {
      await runEncode(
        segmentRenderArgs(split, plan, from, path.join(segDir, 'final_seg_%04d.mp4'), listPath),
        { offsetSec: segmentRange(plan, from).start_sec, totalSec: plan.render_end_sec,
          label: () => ` · segment ${Math.min(count, group.segments.length + 1)}/${count}` },
      )
    } finally {
      clearInterval(timer)
      await record()
    }
  }
  const segments = checkpoint.final_segments.segments.sort((a, b) => a.index - b.index)
  if (segments.length !== count || segments.some((seg, index) => seg.index !== index)) throw new Error(`The final render stopped after ${segments.length} of ${count} segments.`)
  const concatList = path.join(workDir, 'final_concat.txt')
  await fs.writeFile(concatList, plan.order.map(index => formatConcatFileLine(segments[index]!.path)).join('\n') + '\n')
  job.output_lines.push(`Final render: joining ${count} segment(s) without re-encoding and adding the audio.`)
  await runFfmpeg(concatMuxArgs(split, concatList))
}

/**
 * Promote the encoded file to the episode's final video, check it, and finish the job: shared by a
 * full render and a final render resumed after a restart or an update (1.4.265).
 */
async function finishFinalVideo(ctx: {
  job: Job
  project_slug: string
  code: string
  titleHint: string
  videoDir: string
  format: string
  tempDir: string
  outputFile: string
  totalRenderDuration: number
  visualSource: Parameters<typeof writeVideoAssemblySourceStamp>[2]
  imagePool: Parameters<typeof writeVideoAssemblySourceStamp>[3]
  loudness: LoudnessTarget
  narrationOffsetSec?: number
  /** What this render was asked to produce; the final check measures the file against it. */
  expected: FinalCheckExpectation
}): Promise<void> {
  const { job, project_slug, code, titleHint, videoDir, format, tempDir, outputFile, totalRenderDuration, visualSource, imagePool, expected } = ctx
  const finalName = `${code}_final_video.${format}`
  const projectTreeFinalPath = path.join(videoDir, finalName)
  let finalPath = projectTreeFinalPath
  try {
    const { ensureExternalFinalVideoDir } = await import('../services/external-video-store.js')
    // titleHint is the project's canonical title for this episode
    // (loaded from ideas store earlier in this function); falls back
    // to the code-only folder name when missing.
    const externalDir = await ensureExternalFinalVideoDir(project_slug, code, titleHint || '')
    if (externalDir) {
      finalPath = path.join(externalDir, finalName)
      job.output_lines.push(`External final-video root configured → ${finalPath}`)
    }
  } catch (e: any) {
    // Logging only; treat as fallback to project tree.
    job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
  }

  // A re-assembly must never silently drop the final it replaces (owner, 2026-10-27): the new
  // render passes this render's own checks FIRST, the previous final and the sidecars that belong to
  // it are then kept for three days beside it, and only then does the new file take the name. A
  // failed render leaves the accepted final exactly where it was.
  const replacement = await publishOverPreviousFinal({
    job,
    project_slug,
    projectDir: pm.getProjectDir(project_slug) || '',
    code,
    finalPath,
    newRenderPath: outputFile,
    finalName,
    verify: staged => verifyFinalVideo(job, staged, finalName, totalRenderDuration, ctx.loudness, true),
    publish: async () => {
      let landed = outputFile
      try {
        await publishLocalFinalVideo(job, outputFile, finalPath, () => fs.rename(outputFile, finalPath))
        landed = finalPath
        job.output_lines.push(`Renamed to: ${finalName}`)
      } catch (e: any) {
        if (e?.name === 'FinalRenderFallbackConflict') throw e
        // First failure mode: external path is on a different filesystem
        // (EXDEV). Fall back to copy + remove so the user still gets a
        // final at their chosen location.
        if (e?.code === 'EXDEV' && finalPath !== projectTreeFinalPath) {
          try {
            await publishLocalFinalVideo(job, outputFile, finalPath, async () => {
              await fs.copyFile(outputFile, finalPath)
              await fs.rm(outputFile, { force: true })
            })
            landed = finalPath
            job.output_lines.push(`Copied to external (cross-device): ${finalName}`)
          } catch (copyErr: any) {
            if (copyErr?.name === 'FinalRenderFallbackConflict') throw copyErr
            // External-copy failure → fall back to project-tree rename so
            // we don't lose the file the user just spent compute on.
            job.output_lines.push(`Warning: external copy failed (${copyErr.message || copyErr}); falling back to project tree`)
            try {
              await publishLocalFinalVideo(job, outputFile, projectTreeFinalPath, () => fs.rename(outputFile, projectTreeFinalPath))
              landed = projectTreeFinalPath
              job.output_lines.push(`Renamed to: ${finalName} (project tree fallback)`)
            } catch (fallbackErr: any) {
              if (fallbackErr?.name === 'FinalRenderFallbackConflict') throw fallbackErr
              job.output_lines.push(`Warning: final rename skipped (${fallbackErr.message || 'unknown error'})`)
            }
          }
        } else {
          // Cloud-synced filesystems (iCloud, Dropbox) sometimes reject rename
          // with EPERM. Keep the timestamped file as the canonical output in
          // that case — the render is still usable.
          job.output_lines.push(`Warning: final rename skipped (${e.message || 'unknown error'})`)
        }
      }
      return landed
    },
  })
  let resolvedOutputPath = replacement.resolved
  // A publication that did not land put the previous final back; promoting the
  // new file over it now would undo exactly that.
  if (!replacement.restored) {
    resolvedOutputPath = await selfHealFinalPromotion(resolvedOutputPath, projectTreeFinalPath, finalName, job)
  }
  // The final check runs FIRST, so the file carries a verdict even when the check below stops the
  // job — a stopped render is exactly the one somebody wants to look at and override (AGENTS.md §8).
  await finalCheckFinalVideo(job, resolvedOutputPath, expected)
  // A replacement was verified before the previous final moved; a first render keeps the historical
  // order (checks after publication).
  if (!replacement.previousExisted) {
    await verifyFinalVideo(job, resolvedOutputPath, finalName, totalRenderDuration, ctx.loudness)
  }
  await deleteFinalSegments(tempDir, job)
  await finishImportedFinalVideo(job, code, resolvedOutputPath, visualSource, imagePool, ctx.narrationOffsetSec)
}

/**
 * The same final checks a local render runs, for a final rendered on the private fleet. The importer
 * runs them on the downloaded candidate BEFORE the prior final is moved, anything is published, or
 * the Gateway is acknowledged, so a short, empty, or mis-levelled import never becomes the canonical
 * final. The expectation comes from the render's own staged plan — never today's settings — and a
 * staged row that did not save one is reported honestly by the caller.
 *
 * This is the strict entry point: the checked file must already carry its final name. The importer's
 * pre-publication gate uses `verifyStagedCandidateFinalVideo` for the `.output-import.partial` name.
 */
export async function verifyImportedFinalVideo(
  job: Job,
  code: string,
  format: string,
  finalPath: string,
  totalRenderDuration: number,
  expected: FinalCheckExpectation,
  loudness: LoudnessTarget,
): Promise<FinalCheckResult | null> {
  return verifyFinalForPath(
    job, code, format, finalPath, totalRenderDuration, expected, loudness, false,
  )
}

/**
 * The same checks for the importer's downloaded candidate, which still carries the intent's
 * `.output-import.partial` name. The importer first holds the staged destination's final name
 * against the plan, so only the content differs here. Not reachable from the local render path.
 */
export async function verifyStagedCandidateFinalVideo(
  job: Job,
  code: string,
  format: string,
  finalPath: string,
  totalRenderDuration: number,
  expected: FinalCheckExpectation,
  loudness: LoudnessTarget,
): Promise<FinalCheckResult | null> {
  return verifyFinalForPath(
    job, code, format, finalPath, totalRenderDuration, expected, loudness, true,
  )
}

async function verifyFinalForPath(
  job: Job,
  code: string,
  format: string,
  finalPath: string,
  totalRenderDuration: number,
  expected: FinalCheckExpectation,
  loudness: LoudnessTarget,
  stagedCandidate: boolean,
): Promise<FinalCheckResult | null> {
  const finalName = `${code}_final_video.${format}`
  const check = await finalCheckFinalVideo(job, finalPath, expected)
  await verifyFinalVideo(job, finalPath, finalName, totalRenderDuration, loudness, stagedCandidate)
  return check
}

/**
 * The finished-video tail: stamp, cache, schedule, plays. Shared by a local render and a private-fleet
 * render imported into the same job (services/final-render-import.ts), which must not skip it.
 */
export async function finishImportedFinalVideo(
  job: Job,
  code: string,
  finalPath: string,
  visualSource: Parameters<typeof writeVideoAssemblySourceStamp>[2],
  imagePool: Parameters<typeof writeVideoAssemblySourceStamp>[3],
  narrationOffsetSec?: number,
): Promise<void> {
  const project_slug = job.project_slug
  await writeVideoAssemblySourceStamp(
    finalPath,
    code,
    visualSource,
    imagePool,
    undefined,
    narrationOffsetSec,
  )
  job.progress = 100
  job.output_lines.push(`Video saved: ${path.basename(finalPath)}`)
  job.output_lines.push(`Full path: ${finalPath}`)
  job.output_dir = path.dirname(finalPath)

  // Invalidate the episode-status cache so the next /episodes call
  // recomputes status.video_assembly. The chokidar watcher catches
  // writes inside the project tree, but when the final video lands
  // at an external path (eg ~/Downloads/YouTube - Channels/...) the
  // watcher never fires — so we must signal the cache explicitly.
  try {
    const { episodeStatusCache } = await import('../services/episode-status-cache.js')
    episodeStatusCache.invalidate(project_slug, code)
  } catch { /* best-effort — not worth failing the job over */ }

  await autoScheduleFinishedEpisode(job, project_slug, code, finalPath)
  try {
    const { autoEnqueueEpisodeShorts } = await import('../services/episode-shorts.js')
    await autoEnqueueEpisodeShorts(job, project_slug, code)
  } catch (error: any) {
    job.output_lines.push(`Could not start Shorts: ${error?.message || error}. The final video is fine.`)
  }
  await recordMusicEpisodePlays(job, project_slug, code)
}

/**
 * What this render was asked to produce, from the request that made it (lib/final-video-check.ts).
 *
 * `tailFromEndSec` is what sits AFTER the closing tail — the outro and any `after_outro` clip — so
 * the check measures the tail where it actually landed rather than always at the file's end.
 *
 * `speechEndSec` is where the narration stops in the file, when this path knows it. Left out, the
 * check reads the speech end as "not recorded" and reports a silence it cannot place as unknown
 * rather than as speech — so a path that cannot say must not send 0 as if it had measured.
 */
export function finalCheckExpectation(
  req: GenerateVideoRequest,
  opts: {
    plannedSec: number
    tailSec: number
    /**
     * Seconds of closing music the merged master carries (`closing_tail_sec`: baked at Audio Assembly or
     * re-mixed by the guard). Required, so no call site can leave the expectation to the preset.
     */
    bakedTailSec: number
    /**
     * Whether the master's merge recorded a background music bed: true / false as recorded, null when it
     * did not say (an older merge, or no merged master). Only a KNOWN music-free master may have a
     * silent tail without the check objecting; "could not tell" keeps the check on (AGENTS.md §6).
     */
    backgroundMusic: boolean | null
    tailFromEndSec: number
    width: number
    height: number
    speechEndSec?: number
    /** The pauses the episode's merge planned between sections (`readPlannedSectionGaps`). */
    sectionGaps?: PlannedSectionGaps | null
    /** The branded intro this render drew, so the check can tell its own black from a fault. */
    intro?: FinalCheckIntro
  },
): FinalCheckExpectation {
  return {
    planned_sec: opts.plannedSec,
    tail: { sec: opts.tailSec, from_end_sec: opts.tailFromEndSec },
    // Music is expected over a tail the master carries, and over a padded tail unless the master is
    // known to have no bed (music off on purpose). A silent ending is never accepted for lack of a record.
    closing_music: closingMusicWanted(req.post_audio)
      && (opts.bakedTailSec > 0 || (opts.tailSec > 0 && opts.backgroundMusic !== false)),
    width: opts.width,
    height: opts.height,
    subtitles_path: req.subtitles?.enabled ? ((req.subtitles.srt_path || '').trim() || null) : null,
    ...(Number(opts.speechEndSec) > 0 ? { speech_end_sec: Number(opts.speechEndSec) } : {}),
    ...(opts.sectionGaps ? { section_gaps: opts.sectionGaps } : {}),
    ...(opts.intro ? { intro: opts.intro } : {}),
  }
}

/**
 * Where this render's branded intro clip sits in the finished file, and the asset behind it.
 *
 * The owner's own intro assets carry black (Story Sprout's, measured 2026-10-20: 4.67–9.13 s of a
 * 9.6 s intro), and that black is inside a video he made with his own settings. Handing the check the
 * clip's window and the asset is what lets it tell that black from a stretch the render invented
 * (`lib/final-video-check.ts`'s `isIntroAssetBlack`). Undefined when this render drew no intro.
 */
async function introForFinalCheck(
  req: GenerateVideoRequest,
  timelineClipsByAnchor: { before_intro: Array<{ duration: number }> },
  introClipPath: string | undefined,
): Promise<FinalCheckIntro | undefined> {
  const asset = req.intro?.video_path
  if (!introClipPath || !asset) return undefined
  const introSec = (await getAudioDuration(introClipPath)) || 0
  if (!(introSec > 0)) return undefined
  // The concat list plays `before_intro` clips first, then the intro.
  const beforeIntroSec = timelineClipsByAnchor.before_intro.reduce((sum, clip) => sum + clip.duration, 0)
  return { asset, window: { start_sec: beforeIntroSec, end_sec: beforeIntroSec + introSec } }
}

/**
 * Measure the finished final and store the verdict beside it. Never throws and never fails the job:
 * the render is done, and what to do about a bad verdict is decided at the upload (the `final_check`
 * safety check) — a check that could not run is logged as loudly as one that failed.
 */
async function finalCheckFinalVideo(
  job: Job,
  outputPath: string,
  expected: FinalCheckExpectation,
): Promise<FinalCheckResult | null> {
  try {
    const result = await runFinalCheck(outputPath, expected)
    await storeFinalCheck(outputPath, result)
    job.output_lines.push(`Final check: ${finalCheckSummary({ result, stale: false })}`)
    for (const issue of result.issues) job.output_lines.push(`Final check: ${issue.verdict}`)
    job.result = { ...(job.result || {}), final_check_error: false, final_check: { passed: result.passed, issues: result.issues } }
    return result
  } catch (error: any) {
    job.result = { ...(job.result || {}), final_check_error: true }
    job.output_lines.push(`⚠ Final check could not run (${error?.message || error}). The video is kept, `
      + 'and Upload Center can run the check on it later.')
    return null
  }
}

async function verifyFinalVideo(
  job: Job, outputPath: string, finalName: string, plannedSec: number, loudness: LoudnessTarget,
  stagedCandidate = false,
): Promise<void> {
  // A staged candidate is the same file the caller is about to publish under `finalName`; it has
  // already held that name against the plan, so only the content check applies here.
  const valid = (stagedCandidate || path.basename(outputPath) === finalName) && fileExistsNonEmpty(outputPath)
  // 2026-10-07 — a file on disk is not proof of a finished render: its length
  // must match the plan (narration + opening + outro + tail).
  const actualSec = valid ? await getAudioDuration(outputPath).catch(() => null) : null
  let durationIssue = valid ? finalDurationIssue(actualSec, plannedSec) : null
  // A missing/empty/unreadable artifact is never a finished render. Only a
  // measurable length mismatch is the channel's Final video is whole choice.
  if (durationIssue && Number(actualSec) > 0) {
    await safetyGate(job.project_slug, 'final_video_whole', job,
      `The finished video ${finalName} ${durationIssue}. The file was kept so you can inspect it.`)
    durationIssue = null
  }
  requireJobCompletion(job, {
    label: 'Final video assembly', expected: 1, completed: valid && !durationIssue ? 1 : 0,
    missing: valid ? [] : [finalName],
    invalid: valid ? (durationIssue ? [`${finalName} (${durationIssue})`] : []) : [path.basename(outputPath)],
    retry_hint: durationIssue
      ? 'The file was kept so you can look at it. Retry renders it again.'
      : 'The encoded file was retained when possible. Retry promotion or import it as the canonical final.',
  })
  await verifyFinalLoudness(job, outputPath, loudness)
}

/** Measure the finished video's audio and fail when it missed the level it was mixed to (1.4.270). */
export async function verifyFinalLoudness(job: Job, outputPath: string, target: LoudnessTarget): Promise<void> {
  const measured = await measureLoudness(outputPath)
  const issue = finalLoudnessIssue(measured, target)
  if (measured.lufs !== null && measured.true_peak_db !== null) {
    job.output_lines.push(`Final loudness: ${measured.lufs.toFixed(1)} LUFS, peak ${measured.true_peak_db.toFixed(1)} dBTP${issue ? '' : withinToleranceNote(measured, target)}`)
    job.result = { ...(job.result || {}), final_loudness: { lufs: measured.lufs, true_peak_db: measured.true_peak_db } }
  }
  // Rendering again gives the same audio, so this fails once instead of using up the automatic retries.
  // 1.4.300 — a level that cannot be read still stops; a miss stops only when the loudness check is Block.
  if (issue && measured.lufs !== null && measured.lufs > -69 && (target.check ?? 'block') !== 'block') {
    job.output_lines.push(`${target.check === 'warn' ? '⚠ ' : ''}Final loudness is outside the allowance (${issue}). `
      + `The loudness check is ${target.check === 'warn' ? 'set to Warn' : 'Off'} for this channel, so the video was kept.`)
    if (target.check === 'warn') {
      const warnings = Array.isArray(job.result?.safety_warnings) ? job.result!.safety_warnings : []
      job.result = { ...(job.result || {}), safety_warnings: [...warnings, { check: 'loudness', message: issue }] }
    }
    return
  }
  if (issue) {
    throw nonRetryable(new Error(`The final video's sound is not at its target level: ${issue}. `
      + 'The file was kept so you can listen to it. Send the job log to support.'))
  }
}

/** A feature that was switched on but rendered without, by a reviewer's choice — reported in the result, not only the log. */
function noteRender(job: Job, note: string): void {
  job.output_lines.push(note)
  job.result = { ...(job.result || {}), render_notes: [...((job.result?.render_notes as string[] | undefined) || []), note] }
}

/**
 * Quality tier → default (CRF, x264/x265 preset) pair.
 *
 *   `compact` — new in this release. CRF 32 is right at the edge of where
 *               macroblocks start to show on still-image content (sleep
 *               stories with slow motion). File size is ~half of `fast`
 *               and YouTube re-transcodes to VP9 regardless, so the quality
 *               loss is mostly invisible on upload.
 *   `fast`    — historical default. Reasonable quality for local review.
 *   `medium`  — YouTube's sweet spot when you want a clean master.
 *   `high`    — near-visually-lossless for archival.
 *
 * Callers can override the preset independently via `encoding_effort`.
 */
const QUALITY_PRESETS: Record<string, { crf: number; preset: string }> = {
  compact: { crf: 32, preset: 'ultrafast' },
  fast:    { crf: 28, preset: 'ultrafast' },
  medium:  { crf: 23, preset: 'medium' },
  high:    { crf: 18, preset: 'slow' },
}

export const DEFAULT_FPS = 30

/**
 * Pure builder for the codec/audio/pixfmt portion of the final encode argv.
 * Pulled out of `runFinalComposition` so it can be snapshot-tested against a
 * silent flag flip (wrong codec, wrong CRF, wrong preset, missing
 * `+faststart`, etc.) without spawning ffmpeg or constructing a full episode.
 *
 * Inputs map 1:1 onto the closure variables that used to drive the inline
 * builder; the call site in `runFinalComposition` now delegates here.
 */
/**
 * Summarise the total runtime of all user-supplied timeline clips so a
 * long after-scenes tail (a sleep-story staple — 1-3 hours of ambient
 * footage layered over post-narration silence) is visible in the job
 * log before the encode starts. Originally written as a hard abort
 * after a 7212s clip blew through the encode watchdog, but sleep
 * stories deliberately ship 2-hour tails and aborting was wrong: the
 * fix landed in the watchdog instead (it scales with output duration
 * now). Kept as a warn-only summary so the operator gets a heads-up
 * about expected wall-clock time without losing the run.
 *
 * Pure helper — exported separately from `generateVideo` so it can be
 * unit-tested without spawning ffmpeg or building an episode fixture.
 */
export type TimelineClipForCheck = { path: string; duration: number; anchor: string }
export type TimelineSanityResult = { warning?: string }

export function checkTimelineDurationSanity(
  clips: TimelineClipForCheck[],
  referenceDuration: number,
): TimelineSanityResult {
  if (clips.length === 0) return {}
  const totalTimelineDur = clips.reduce((s, c) => s + c.duration, 0)
  if (totalTimelineDur <= referenceDuration) return {}
  // Long-tail surface area — common for sleep-story channels. Surface
  // the expected output length up-front so the user reads the right
  // number in the job log and isn't confused by a hours-long encode.
  const totalMin = (totalTimelineDur / 60).toFixed(1)
  const finalMin = ((totalTimelineDur + referenceDuration) / 60).toFixed(1)
  return {
    warning:
      `Timeline clips total ${totalTimelineDur.toFixed(1)}s (~${totalMin} min) — longer than the narration ` +
      `(${(referenceDuration / 60).toFixed(1)} min). Final video will be ~${finalMin} min; encode wall-clock ` +
      `scales with that. The ffmpeg watchdog auto-extends for long renders, so this will run to completion.`,
  }
}

/**
 * Wall-clock budget for a single ffmpeg encode invocation, scaled by the
 * intended output duration. Pure: takes `outputDurationSec` (the value
 * passed to ffmpeg's `-t`) and the optional env override, returns ms.
 *
 * Floor 30 min keeps short videos safe; ceiling 12h prevents a truly
 * runaway process from holding the queue forever. Between the bounds:
 *   1.5× output + 5 min buffer
 * — derived from observed encode rates on M-series Macs at libx264
 * `medium` preset (≈1.2-1.5× real-time). 2026-04-28 case study: a
 * 9219s output needed ~2.1h wall-clock; the formula gives 14129 ms ×
 * 1000 ≈ 235 min ≈ 3.9h, comfortable headroom on a slower CPU too.
 */
export function computeWatchdogMs(
  outputDurationSec: number,
  envOverrideMs?: string | undefined,
): number {
  if (envOverrideMs) {
    const n = Number(envOverrideMs)
    if (Number.isFinite(n) && n > 0) return n
  }
  const FLOOR_MS = 30 * 60_000          // 30 min
  const CEILING_MS = 12 * 3600 * 1000   // 12 hours
  if (!Number.isFinite(outputDurationSec) || outputDurationSec <= 0) return FLOOR_MS
  const scaled = Math.ceil(outputDurationSec * 1.5 * 1000) + 5 * 60_000
  return Math.min(CEILING_MS, Math.max(FLOOR_MS, scaled))
}

/**
 * FFmpeg cannot emit a meaningful video segment shorter than one frame.
 * Timeline subtraction can still leave a tiny positive IEEE-754 remainder
 * (for example 4.5e-13s), which lavfi rejects when used as `color=...:d=`.
 */
export function clampVideoDurationToFrame(durationSec: number, fps: number): number {
  if (!Number.isFinite(durationSec) || !Number.isFinite(fps) || durationSec <= 0 || fps <= 0) return 0
  return durationSec + Number.EPSILON >= 1 / fps ? durationSec : 0
}

export function splitFadeToBlackDuration(
  postDuration: number,
  requestedFadeDuration: number,
  fps: number,
): { fadeDuration: number; holdDuration: number } {
  const fadeDuration = Math.min(requestedFadeDuration, postDuration)
  return {
    fadeDuration,
    holdDuration: clampVideoDurationToFrame(Math.max(0, postDuration - fadeDuration), fps),
  }
}

export {
  buildEncoderArgs,
  crfToVideotoolboxQ,
  defaultEncodingEffort,
  describeEncoder,
  encoderKind,
  videoBitrateCapKbps,
} from '../lib/final-render-encoder.js'
export type { EncodeTier } from '../lib/final-render-core.js'

/**
 * Build the `:enable='<expr>'` suffix that FFmpeg filters like `noise`,
 * `eq`, `colorbalance`, `vignette`, and `overlay` accept to time-gate their
 * application. Cheap pure string op — no I/O.
 *
 *   start > 0, end > 0 → `between(t,start,end)`
 *   start > 0          → `gt(t,start)`
 *   end   > 0          → `lt(t,end)`
 *   both zero          → `''`  (no gate; filter applies to every frame)
 *
 * Used to keep intro/title/outro/post-audio segments free of colour
 * grading, grain, vignette, chroma, and logo — the user's branded or
 * flat-black content shouldn't get stylised.
 *
 * ⚠️ Do NOT apply this to the libass filters (`ass` / `subtitles`): they do
 * not support the timeline `enable` option, and adding it makes the entire
 * filtergraph fail to initialise. Subtitles are kept off the intro by their
 * cue timestamps being offset past the lead-in, not by a filter gate.
 */
export { buildLetterboxFilter, computeVignetteAngle } from '../lib/video-effects.js'

// ── Portable-path expansion ────────────────────────────────────────────────
// Walks the fields of a GenerateVideoRequest that carry user-supplied file
// paths and expands portable forms (`${PROJECT}/foo`, `${MY_FOLDER}/bar`) to
// absolute paths for this machine. Mutates `req` in place so downstream
// code (existsSync, ffmpeg -i arg builders) doesn't need to know about
// portable paths at all. Legacy absolute paths pass through unchanged.
//
// When a `${NAME}` variable isn't defined on this machine, we log a warning
// to the job output panel and blank the field so the generator silently
// skips that asset — same behaviour as an absent file. The user sees the
// log line and knows to define the named root in Settings.
export function resolveAssetPathsInPlace(req: GenerateVideoRequest, outputRoot: string, job: Job): void {
  const tryResolve = (p: string | undefined, label: string): string | undefined => {
    if (!p || !isPortablePath(p)) return p
    try {
      return resolveAssetPath(p, outputRoot)
    } catch (e: any) {
      job.output_lines.push(`⚠ ${label}: ${e.message}`)
      return undefined
    }
  }
  if (req.title_image?.image_path) {
    req.title_image.image_path = tryResolve(req.title_image.image_path, 'title_image.image_path') || ''
  }
  if (req.intro?.video_path) {
    req.intro.video_path = tryResolve(req.intro.video_path, 'intro.video_path') || ''
  }
  if (req.outro?.video_path) {
    req.outro.video_path = tryResolve(req.outro.video_path, 'outro.video_path') || ''
  }
  if (req.logo?.image_path) {
    req.logo.image_path = tryResolve(req.logo.image_path, 'logo.image_path') || ''
  }
  if (req.chroma_key?.source_path) {
    req.chroma_key.source_path = tryResolve(req.chroma_key.source_path, 'chroma_key.source_path') || ''
  }
  if (req.frame?.background_path) {
    req.frame.background_path = tryResolve(req.frame.background_path, 'frame.background_path') || ''
  }
  if (req.title_card?.background_media_path) {
    req.title_card.background_media_path = tryResolve(req.title_card.background_media_path, 'title_card.background_media_path') || ''
  }
  if (req.outro_card?.background_media_path) {
    req.outro_card.background_media_path = tryResolve(req.outro_card.background_media_path, 'outro_card.background_media_path') || ''
  }
  if (req.background_noise?.custom_file) {
    req.background_noise.custom_file = tryResolve(req.background_noise.custom_file, 'background_noise.custom_file') || ''
  }
  if (req.music?.files?.length) {
    req.music.files = req.music.files
      .map((f, i) => tryResolve(f, `music.files[${i}]`) || '')
      .filter(Boolean)
  }
  // Overlay layers and the compilation plate are picked from the channel's own
  // `overlays/` / `backgrounds/` folders, which collapse to `${CHANNEL}/…`.
  // An unexpanded token would reach ffmpeg as a literal and the layer would
  // vanish from the render.
  if (req.overlays?.layers?.length) {
    req.overlays.layers = req.overlays.layers.map((l, i) => l?.source_path
      ? { ...l, source_path: tryResolve(l.source_path, `overlays.layers[${i}].source_path`) || '' }
      : l)
  }
  if (req.background_plate?.source_path) {
    req.background_plate.source_path = tryResolve(req.background_plate.source_path, 'background_plate.source_path') || ''
  }
  // User-supplied timeline clips (before_intro / after_intro / after_scenes /
  // after_outro). Resolve each path; drop rows whose portable token can't be
  // expanded on this machine (same "warn + skip" pattern as above). Don't
  // drop rows whose path is legit-but-not-yet-existing — that existence
  // check happens later in prepareTimelineClips alongside intro/outro.
  if (req.timeline_clips?.length) {
    req.timeline_clips = req.timeline_clips
      .map((c, i) => {
        // Static clips carry image_path; classic clips carry video_path.
        // Resolve whichever this row uses; drop the row if the portable
        // token can't expand on this machine.
        if (c.kind === 'static') {
          const resolved = tryResolve(c.image_path, `timeline_clips[${i}].image_path`)
          return resolved ? { ...c, image_path: resolved } : null
        }
        const resolved = tryResolve(c.video_path, `timeline_clips[${i}].video_path`)
        return resolved ? { ...c, video_path: resolved } : null
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
  }
  // Scene paths come from the scanner (always absolute) so we skip them.
}

// ── Scanned Assets Interface ───────────────────────────────────────────────

export interface ScannedAssets {
  scenes: Array<{
    filename: string
    path: string
    number: number
    width?: number
    height?: number
    source?: 'classic' | 'scene_plan' | 'image_pool'
    planned_scene_index?: number
    plan_scene_id?: string
    /** v1.0.435 — scene_plan renders are surfaced regardless of approval; this
     *  carries the flag so the UI can still distinguish reviewed vs not. */
    approved?: boolean
    /** Exact still remains mandatory even when an approved motion clip is used. */
    still_path?: string
    media_type?: 'still' | 'motion'
    clip_shortfall_mode?: 'hold'
    start_sec?: number
    end_sec?: number
    duration_sec?: number
  }>
  scene_sources?: { classic: number; scene_plan: number; image_pool?: number }
  visual_source?: VideoVisualSource
  /** Episode Builder (music) episode: the render settings it was planned with,
   *  so Video Assembly can offer its "Music episode" settings in one click. */
  music_episode?: {
    frame_rate: number
    resolution: '720p' | '1080p'
    upscale_sharpen: 'off' | 'light'
    scene_change: { transition: string; seconds: number }
    built_at: string | null
    songs: number
  }
  image_pool?: {
    pool_id: string
    selected_images: Array<{ filename: string; sha256: string; target_duration: number }>
    seconds_per_image: number
    target_duration: number
    generated_at: string
    warnings: string[]
  }
  /** Planned-image coverage is separate from the returned pool: the pool only
   * contains files that exist, while this records how many files should exist. */
  scene_plan_coverage?: {
    total: number
    ready: number
    missing: Array<{ id: string; scene_index: number }>
    unapproved: Array<{ id: string; scene_index: number }>
    stale: Array<{ id: string; scene_index: number }>
    /** Selected clips Assembly refused as stale; each names the scene and why it fell back to the still. */
    motion_fallback?: Array<{ id: string; scene_index: number; reason: string }>
  }
  scene_plan_timing?: {
    built_at?: string
    opening_mode: 'branded-opening' | 'from-start'
    opening_reserved_sec: number
    /** v1.3.1 — present when the reserve was probed from the real opening
     *  clips at plan time, so it already equals `preSceneDuration`. */
    opening_source?: 'measured'
    /** 1.4.272 — seconds every scene after the first was moved so a plan timed
     *  before a music lead-in sits on the merged audio's clock. Absent when none. */
    audio_lead_in_shift_sec?: number
    /** 1.4.276 — why the plan no longer matches the merged narration it was
     *  timed against. Absent when it matches (keeps the render identity). */
    audio_stale_reason?: string
    plan_duration_sec: number
    audio_duration_sec: number
    approved: number
    stills_ready: number
    motion_ready: number
    uncovered_sec: number
    /** Narration before the first scene. Split out of `uncovered_sec` so the
     *  page can say WHICH end of the timeline is short instead of naming
     *  images and approvals that may be perfectly complete. */
    head_gap_sec: number
    /** Narration after the last scene. Same reason. */
    tail_gap_sec: number
    gap_count: number
    overlap_sec: number
    overlap_count: number
    complete: boolean
    scenes: Array<{
      id: string
      scene_index: number
      start_sec: number
      end_sec: number
      duration_sec: number
      approved: boolean
      image_ready: boolean
      stale: boolean
      media_type: 'still' | 'motion'
      /** The scene's theme when its plan names one (Episode Builder scenes); drives theme-scoped effects. */
      theme?: string
    }>
  }
  thumbnails: Array<{ filename: string; path: string; number: number }>
  audio_sections: Array<{ filename: string; path: string; label: string; duration?: number }>
  narration_full?: { path: string; duration: number }
  /** `opening` (v1.3.2) states what precedes the narration in each track. */
  merged_audio: Array<{
    filename: string
    path: string
    duration?: number
    opening?: MergedAudioOpening
    /**
     * Seconds of music this track carries AFTER the narration (the closing tail
     * Audio Assembly baked into it; 0 for a merge that baked none). `duration`
     * is the whole file; `duration − closing_tail_sec` is the narration.
     */
    closing_tail_sec?: number
  }>
  /**
   * Which merged track this episode's narration is, and why (v1.4.314).
   *
   * `merged_audio[0]` is always this track when `source` is `selected` or
   * `unset`; when it is `invalid` the owner's pin names a file that is no longer
   * here, and `merged_audio[0]` is the legacy order but MUST NOT be rendered —
   * callers that choose the artifact refuse instead of substituting.
   */
  merged_audio_selection?: {
    source: 'selected' | 'unset' | 'invalid'
    /** The pinned basename, when the owner chose one. */
    pinned: string | null
    /** The track `merged_audio[0]` resolves to, when there is one. */
    filename: string | null
  }
  /**
   * Whether this episode's merged narration is CURRENT: the verdict episode status gives, from the
   * same function (`inspectAudioMergeAtPaths`), so the scan and the Board cannot disagree. A merge
   * built from chapters that were since replaced is on disk but not current; `reason` says why.
   */
  merged_audio_current?: { current: boolean; file: string | null; reason?: import('../services/asset-status.js').AudioMergeReason }
  intro_videos: Array<{ filename: string; path: string }>
  music_files: Array<{ filename: string; path: string; duration?: number }>
  rendered_videos: Array<{ filename: string; path: string; mtime: number }>
  episode_dir: string
  video_dir: string
  // When true, intro/chapter audio files are bypassed in favor of merged_audio.
  // The audio assembly step is now upstream; raw chapters should not be remuxed here.
  skip_chapters: boolean
}

// Re-export checkFfmpeg for routes that import from this module
export { checkFfmpeg } from '../lib/ffmpeg-utils.js'

/** Episode Builder episodes: a finished render is what counts as a play (SPEC §3). */
async function recordMusicEpisodePlays(job: Job, slug: string, code: string): Promise<void> {
  try {
    const { recordRenderedMusicEpisode } = await import('../services/music-episode-store.js')
    await recordRenderedMusicEpisode(slug, code, line => job.output_lines.push(line))
  } catch (e: any) {
    job.output_lines.push(`Warning: song plays were not recorded (${e?.message || e}). The video is fine.`)
  }
}

// ── Scan Episode Assets ────────────────────────────────────────────────────

export async function scanEpisodeAssets(
  slug: string,
  episodeId: string,
  /**
   * v1.4.314 — the merged track to put FIRST (`merged_audio[0]`), used by the
   * render to keep an already-accepted job on the narration it was accepted with
   * (see `prepareUnifiedVideoAssemblyInputs`). Ignored when it is not a member of
   * this episode's merged-audio folder. Omitted by every read-only caller, which
   * then follows the episode's own pin (or the legacy order when there is none).
   */
  opts?: { preferredMergedFilename?: string | null },
): Promise<ScannedAssets> {
  const code = episodeId.toUpperCase()
  const projectDir = pm.getProjectDir(slug)
  const outputRoot = await pm.getProjectOutputRoot(slug)
  if (!projectDir || !outputRoot) throw new Error('Project directory not found')

  const names = await resolveSubfolderNames(slug, code)

  // Look up the canonical title from the ideas store so findEpisodeDir
  // can disambiguate when the user has multiple folders starting with the
  // same {code} prefix (e.g. leftover from a rename).
  let titleHint: string | undefined
  try {
    const im = await import('../services/idea-manager.js')
    const ideas = await im.getIdeas(slug, 'accepted')
    const match = ideas.find(i => i.episode_code === code)
    if (match?.title) titleHint = match.title
  } catch { /* fall back to code-only match */ }

  let episodeDir = await findEpisodeDir(outputRoot, code, { titleHint })
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  // The source choice is episode state. A selection sidecar in a renamed
  // sibling wins over the title-derived path, just like Scene Plan sidecars.
  const visualSourceState = await readVideoVisualSource(slug, code)
  if (visualSourceState.sidecar) episodeDir = visualSourceState.episode_dir
  const visualSource = visualSourceState.source

  // Media-aware (Level B): heavy subfolders may live under an external media
  // root when the project opts in; for non-split projects these resolve to the
  // same iCloud episodeDir as before (non-creating, null when missing).
  const thumbsDir = await findEpisodeSubfolderDir(slug, code, 'thumbnails', episodeDir, names.thumbnails)
  const audioDir = await findEpisodeSubfolderDir(slug, code, 'audio', episodeDir, names.audio)
  const mergedAudioDir = await findEpisodeSubfolderDir(slug, code, 'merged_audio', episodeDir, names.merged_audio)
  const videoDir = await findEpisodeSubfolderDir(slug, code, 'video', episodeDir, names.video)

  const result: ScannedAssets = {
    scenes: [],
    scene_sources: { classic: 0, scene_plan: 0 },
    scene_plan_coverage: undefined,
    scene_plan_timing: undefined,
    thumbnails: [],
    audio_sections: [],
    merged_audio: [],
    intro_videos: [],
    music_files: [],
    rendered_videos: [],
    episode_dir: episodeDir,
    video_dir: videoDir || path.join(episodeDir, names.video),
    skip_chapters: false,
    visual_source: visualSource,
  }

  // Continuity projects render reviewed images into
  // <episode>/scene_images/<scene-id>.png and track timing in scene_plan.json,
  // not the retired numbered scene-image pool. Only stable Scene Plan IDs are
  // eligible for unified Video Assembly.
  const planPath = await resolveScenePlanPath(slug, code, episodeDir)
  // v1.0.457 — continuity renders now live in the unified named "NN Scene Images"
  // folder (legacy flat scene_images/ kept as a read fallback). Only the plan is
  // required; the named/flat dirs are resolved per scene below.
  const namedSceneDir = existsSync(planPath)
    ? await resolveSceneImagesDir(slug, code, episodeDir).catch(() => path.join(episodeDir, TIMESTAMP_SCENE_IMAGES_SUBFOLDER))
    : ''
  const legacySceneDir = path.join(episodeDir, TIMESTAMP_SCENE_IMAGES_SUBFOLDER)
  let scannedPlan: ScenePlan | null = null
  if (visualSource === 'scene_plan' && existsSync(planPath)) {
    try {
      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
      scannedPlan = plan
      const planScenes = Array.isArray(plan.scenes) ? plan.scenes : []
      const missingPlannedScenes: Array<{ id: string; scene_index: number }> = []
      const unapprovedPlannedScenes: Array<{ id: string; scene_index: number }> = []
      const stalePlannedScenes: Array<{ id: string; scene_index: number }> = []
      const motionFallback: Array<{ id: string; scene_index: number; reason: string }> = []
      const clipsDir = await resolveVideoAssetsDir(slug, code, episodeDir)
      // One readdir per folder instead of up to 4 existsSync per scene (S7).
      const listing = async (dir: string) => new Set(dir ? await safeReaddir(dir) : [])
      const [namedFiles, flatFiles, clipFiles] = await Promise.all([listing(namedSceneDir), listing(legacySceneDir), listing(clipsDir)])
      // Resolved once for this scan; only a Sketch Draw selection needs it.
      const scanSketchSettings = planScenes.some((scene: any) => scene.clip_renderer === 'sketch_draw')
        ? await resolveSketchDrawSettings(slug, code).catch(() => undefined)
        : undefined
      let usableCount = 0
      for (const scene of planScenes) {
        // v1.0.456/457 — resolve robustly: unified named folder first, then the
        // stored absolute image_path (which can be stale across Macs/users —
        // /Users/old-user/… vs /Users/current-user/…), then the legacy flat folder.
        // This keeps continuity renders visible in Video Assembly regardless of
        // where they physically live.
        const namedPath = namedSceneDir ? path.join(namedSceneDir, `${scene.id}.png`) : ''
        const flatPath = path.join(legacySceneDir, `${scene.id}.png`)
        const named = !!namedPath && namedFiles.has(`${scene.id}.png`)
        const stored = !named && !!scene.image_path && existsSync(scene.image_path)
        const hasStill = named || stored || flatFiles.has(`${scene.id}.png`)
        const plannedPath = named ? namedPath : stored ? scene.image_path! : flatPath
        const canonicalClip = path.join(clipsDir, `${scene.id}.mp4`)
        const clipPath = clipFiles.has(`${scene.id}.mp4`) ? canonicalClip
          : scene.clip_path && existsSync(scene.clip_path) ? scene.clip_path : ''
        const clipFreshReason = scene.motion_choice === 'clip' && clipPath
          ? await sceneClipStaleReason(scene, { slug, episodeId: code, episodeDir, imagePath: hasStill ? plannedPath : null, sketchSettings: scanSketchSettings, revealScenes: plan.scenes.map(item => item.id) })
          : null
        const useMotion = scene.motion_choice === 'clip'
          && !!clipPath
          && !clipFreshReason
        const isT2VScene = scene.visual_lane === 'text_to_video'
        // A scene with a fresh selected clip and NO still is complete — the T2V shape. It is never
        // reported missing, and it never borrows another scene's picture. Every other lane must
        // still have its own still (§7: a missing image is a blocking error there).
        if (!hasStill && !useMotion) {
          missingPlannedScenes.push({ id: scene.id, scene_index: scene.scene_index })
          continue
        }
        const stale = sceneImageStaleReason(scene) !== null
        if (stale) stalePlannedScenes.push({ id: scene.id, scene_index: scene.scene_index })
        // A T2V scene's approval is its OWN Motion Review decision (owner, 2026-10-26). An
        // unapproved T2V clip falls back to its backup still and says why — the same shape as a
        // stale clip, so the operator sees the one decision still owed.
        // v1.4.375 — a chosen clip whose file is gone (deleted, moved, import never landed) also
        // falls back, and says so: a selection the operator made must never be dropped silently.
        const fallbackReason = clipFreshReason
          || (scene.motion_choice === 'clip' && !clipPath ? 'no clip file on disk' : null)
          || (isT2VScene && !useMotion && scene.motion_choice !== 'still'
            ? (clipPath ? 'clip not approved in Motion Review' : 'no clip yet')
            : null)
        // Scene Review owns the still of every image lane; a T2V scene is approved in Motion
        // Review instead, so its backup still never counts as an approval.
        if (!isT2VScene && !scene.approved && hasStill) {
          unapprovedPlannedScenes.push({ id: scene.id, scene_index: scene.scene_index })
        }
        if (fallbackReason) motionFallback.push({ id: scene.id, scene_index: scene.scene_index, reason: fallbackReason })
        result.scenes.push({
          filename: path.basename(useMotion ? clipPath : plannedPath),
          path: useMotion ? clipPath : plannedPath,
          still_path: plannedPath,
          media_type: useMotion ? 'motion' : 'still',
          clip_shortfall_mode: useMotion ? scene.clip_shortfall_mode : undefined,
          number: scene.scene_index,
          source: 'scene_plan',
          planned_scene_index: scene.scene_index,
          plan_scene_id: scene.id,
          approved: !!scene.approved || useMotion,
          start_sec: scene.start_sec,
          end_sec: scene.end_sec,
          duration_sec: Math.max(0, scene.end_sec - scene.start_sec),
        })
        // 1.4.296 — a stale picture is still usable (see prepareUnifiedVideoAssemblyInputs).
        if (scene.approved || useMotion) usableCount++
      }
      result.scene_sources!.scene_plan = result.scenes.filter(scene => scene.source === 'scene_plan').length
      result.scene_plan_coverage = {
        total: planScenes.length,
        ready: usableCount,
        missing: missingPlannedScenes,
        unapproved: unapprovedPlannedScenes,
        stale: stalePlannedScenes,
        motion_fallback: motionFallback,
      }
    } catch (error: any) {
      throw new Error(`Scene Plan could not be read safely: ${error?.message || error}`)
    }
  }

  // Scan thumbnails — surface EVERY image in the folder so the title-image
  // picker shows all of them (v1.0.422). In-app composed templates
  // (`*_composed_vN.png`) and title-based names don't match the scene_NN /
  // thumb_NN pattern, so they used to be invisible to the picker. Numbered
  // files keep their number for ordering; the rest are appended in filename
  // order with sequential numbers after the highest, so the list is stable.
  if (thumbsDir) {
    const files = await safeReaddir(thumbsDir)
    const numbered: Array<{ filename: string; path: string; number: number }> = []
    const unnumbered: Array<{ filename: string; path: string }> = []
    for (const file of files) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue
      const num = extractSceneNumber(file)
      if (num !== null) numbered.push({ filename: file, path: path.join(thumbsDir, file), number: num })
      else unnumbered.push({ filename: file, path: path.join(thumbsDir, file) })
    }
    numbered.sort((a, b) => a.number - b.number)
    unnumbered.sort((a, b) => a.filename.localeCompare(b.filename))
    let next = (numbered.length ? Math.max(...numbered.map(t => t.number)) : 0) + 1
    result.thumbnails = [
      ...numbered,
      ...unnumbered.map(t => ({ filename: t.filename, path: t.path, number: next++ })),
    ]
  }

  // Scan audio files. Legacy projects store both chapter clips and the
  // merged output in the same "07 Audio Assets" folder — filter anything
  // matching *_merged_audio* off to the merged_audio array instead of the
  // chapters list so the video pipeline picks the merged track. ONE rule:
  // the canonical pattern from lib/merged-audio-selection.ts.
  const isMergedFilename = (name: string) => MERGED_AUDIO_FILENAME.test(name)

  if (audioDir) {
    const files = await safeReaddir(audioDir)
    let fullNarrationPath: string | undefined

    const audioFiles = files.filter(file => /\.(mp3|wav|m4a)$/i.test(file))
    const durations = await mapWithConcurrency(audioFiles, 4, file => getAudioDuration(path.join(audioDir, file)))
    for (const [index, file] of audioFiles.entries()) {
      const filePath = path.join(audioDir, file)
      const duration = durations[index]

      // Merged-audio files sometimes live in the chapter folder (legacy layout).
      // Route them to the merged_audio list so downstream logic sees them.
      if (isMergedFilename(file)) {
        result.merged_audio.push({ filename: file, path: filePath, duration })
        continue
      }

      if (!/\.mp3$/i.test(file)) continue

      const label = file
        .replace(/^[A-Z]+\d+_/, '')
        .replace(/\.mp3$/i, '')
        .replace(/_/g, ' ')

      result.audio_sections.push({
        filename: file,
        path: filePath,
        label,
        duration,
      })

      if (file.toLowerCase().includes('full') || file.toLowerCase().includes('narration')) {
        fullNarrationPath = filePath
      }
    }

    // Sort audio sections: Introduction first, then chapters numerically
    result.audio_sections.sort((a, b) => {
      const aIsIntro = /intro/i.test(a.filename)
      const bIsIntro = /intro/i.test(b.filename)
      if (aIsIntro && !bIsIntro) return -1
      if (!aIsIntro && bIsIntro) return 1
      // Extract chapter numbers for numeric sort
      const aNum = a.filename.match(/chapter[_\s]*(\d+)/i)
      const bNum = b.filename.match(/chapter[_\s]*(\d+)/i)
      if (aNum && bNum) return parseInt(aNum[1]) - parseInt(bNum[1])
      if (aNum && !bNum) return 1
      if (!aNum && bNum) return -1
      return a.filename.localeCompare(b.filename, undefined, { numeric: true })
    })

    if (fullNarrationPath) {
      const dur = await getAudioDuration(fullNarrationPath)
      if (dur) {
        result.narration_full = { path: fullNarrationPath, duration: dur }
      }
    } else if (result.audio_sections.length === 1 && result.audio_sections[0].duration) {
      result.narration_full = {
        path: result.audio_sections[0].path,
        duration: result.audio_sections[0].duration,
      }
    }
  }

  // Scan merged audio files
  if (mergedAudioDir) {
    const files = await safeReaddir(mergedAudioDir)
    const audioFiles = files.filter(file => /\.(mp3|wav|m4a)$/i.test(file) && !file.startsWith('.tmp_'))
    const durations = await mapWithConcurrency(audioFiles, 4, file => getAudioDuration(path.join(mergedAudioDir, file)))
    for (const [index, file] of audioFiles.entries()) {
      const filePath = path.join(mergedAudioDir, file)
      const duration = durations[index]
      result.merged_audio.push({
        filename: file,
        path: filePath,
        duration,
      })
    }

    // v1.4.314 — `merged_audio[0]` is the narration every downstream reader uses
    // (the render, the plan's lead-in shift, the coverage/drift checks, the
    // Image-Pool duration). Before this, it was simply the first file in raw
    // `readdir` order, which need not be the track the owner chose. Put the
    // chosen track first so the scan agrees with the stitcher, the plan gate,
    // Scene Review and B-Roll. An episode nobody pinned keeps the exact order it
    // had before — the fix is the explicit choice, not a global re-ordering.
    const choice = await resolveEpisodeMergedAudioChoice(mergedAudioDir, code)
    const preferred = (opts?.preferredMergedFilename || '').trim()
    let chosen: string | null = null
    if (preferred && result.merged_audio.some(entry => entry.filename === preferred)) {
      // An accepted job's own snapshot wins over a later change of choice, so a
      // queued render never silently switches narration under the customer.
      chosen = preferred
    } else if (choice.source === 'selected') {
      chosen = choice.filename
    }
    if (chosen) {
      const at = result.merged_audio.findIndex(entry => entry.filename === chosen)
      if (at > 0) result.merged_audio.unshift(...result.merged_audio.splice(at, 1))
    }
    result.merged_audio_selection = {
      source: choice.source,
      pinned: choice.pinned,
      // What `merged_audio[0]` actually resolves to — null only when the pin is
      // invalid and there is therefore no track this episode may render.
      filename: choice.source === 'invalid' ? null : (chosen ?? result.merged_audio[0]?.filename ?? null),
    }
    const { inspectAudioMergeAtPaths } = await import('../services/asset-status.js')
    const verdict = await inspectAudioMergeAtPaths({
      episode_dir: episodeDir, audio_dir: audioDir || path.join(episodeDir, names.audio), merged_audio_dir: mergedAudioDir,
      script_dir: path.join(episodeDir, names.script),
    }, code)
    result.merged_audio_current = { current: verdict.present, file: verdict.file ?? null, ...(verdict.reason ? { reason: verdict.reason } : {}) }
  }

  // If merged audio exists, intro/chapter audio is stale — the audio assembly
  // step already consumed those. Flag it so the UI stops offering them.
  if (result.merged_audio.length > 0) {
    result.skip_chapters = true
  }

  // v1.3.2 — say what is in front of the narration in each merged track, so
  // Video Assembly Step 1 can answer "does this already include my intro?"
  // without the owner having to play the file and guess. Costs one small JSON
  // read per merged file; the ffprobe it needs was already done above.
  for (const entry of result.merged_audio) {
    entry.opening = await describeMergedAudioOpening({
      mergedDir: path.dirname(entry.path),
      code,
      filename: entry.filename,
      mergedDurationSec: entry.duration,
      episodeDir,
    })
    // Carried onto the entry so every reader of this scan has the narration's
    // real length without re-reading the record: the plan's clock, the coverage
    // check and the Image Pool budget all mean `duration − closing_tail_sec`.
    entry.closing_tail_sec = entry.opening.closing_tail_sec
  }

  const { isMusicEpisodeDir, readEpisodeDoc } = await import('../services/music-episode-store.js')
  if (isMusicEpisodeDir(episodeDir)) {
    const musicDoc = await readEpisodeDoc(slug, code).catch(() => null)
    if (musicDoc) {
      result.music_episode = {
        frame_rate: musicDoc.settings.frame_rate,
        resolution: musicDoc.settings.resolution,
        upscale_sharpen: musicDoc.settings.upscale_sharpen,
        scene_change: musicDoc.settings.scene_change,
        built_at: musicDoc.built?.at || null,
        songs: musicDoc.songs.length,
      }
    }
  }

  if (visualSource === 'image_pool') {
    // Pictures cover the narration, not the closing music tail after it.
    const narrationDuration = narrationSecFromMaster(
      Number(result.merged_audio[0]?.duration || result.narration_full?.duration || 0),
      result.merged_audio[0]?.closing_tail_sec || 0,
    )
    const imagePool = await resolveImagePoolSelection(slug, code, narrationDuration > 0 ? narrationDuration : undefined)
    result.image_pool = {
      pool_id: imagePool.pool_id,
      selected_images: imagePool.selected_images,
      seconds_per_image: imagePool.seconds_per_image,
      target_duration: imagePool.target_duration,
      generated_at: imagePool.generated_at,
      warnings: imagePool.warnings,
    }
    const playOrder = buildImagePoolPlayOrder(imagePool, narrationDuration || imagePool.target_duration)
    result.scenes = playOrder.map((item, index) => ({
      filename: item.filename,
      path: item.path,
      number: index + 1,
      source: 'image_pool' as const,
      media_type: 'still' as const,
      still_path: item.path,
      duration_sec: item.duration,
    }))
    result.scene_sources!.image_pool = result.scenes.length
  }

  // The NARRATION's length — the merged master minus any closing music tail
  // baked into it. The plan's clock, its coverage and its drift are all timed
  // against the speech, never against the music that follows it.
  const mergedNarrationSec = scannedPlan
    ? narrationSecFromMaster(
      Number(result.merged_audio[0]?.duration || result.narration_full?.duration || scannedPlan.total_duration_sec || 0),
      result.merged_audio[0]?.closing_tail_sec || 0,
    )
    : 0

  // 1.4.272 — the ONE place the plan meets the merged audio. A plan timed from
  // narration at 0 s, rendered over audio with a music lead-in, moves onto the
  // audio's clock here: scene 1 holds through the intro, every other scene (and
  // so every duration, reveal, effect window and the coverage check below)
  // shifts by the lead-in the merge recorded. Captions are already on the
  // merged clock and are not touched.
  let leadInShiftSec = 0
  if (scannedPlan) {
    leadInShiftSec = scenePlanLeadInShiftSec(
      scannedPlan.scenes, result.merged_audio[0]?.opening?.lead_in_sec, mergedNarrationSec,
    )
    if (leadInShiftSec > 0) {
      scannedPlan = {
        ...scannedPlan,
        scenes: shiftScenesForLeadIn(scannedPlan.scenes, leadInShiftSec),
        total_duration_sec: (Number(scannedPlan.total_duration_sec) || 0) + leadInShiftSec,
      }
      const shifted = new Map(scannedPlan.scenes.map(scene => [scene.id, scene]))
      for (const row of result.scenes) {
        const scene = row.source === 'scene_plan' ? shifted.get(row.plan_scene_id!) : undefined
        if (!scene) continue
        row.start_sec = scene.start_sec
        row.end_sec = scene.end_sec
        row.duration_sec = Math.max(0, scene.end_sec - scene.start_sec)
      }
    }
  }

  if (scannedPlan) {
    const audioDuration = mergedNarrationSec
    const openingReserved = scannedPlan.opening_mode === 'branded-opening'
      ? Math.max(0, Number(scannedPlan.opening_reserved_sec) || 0) : 0
    const integrity = inspectScenePlanCoverage({
      scenes: scannedPlan.scenes,
      total_duration_sec: audioDuration,
      opening_mode: scannedPlan.opening_mode,
    }, { headCovered: openingReserved > 0 })
    let overlapSec = 0
    let overlapCount = 0
    for (let index = 1; index < scannedPlan.scenes.length; index++) {
      const overlap = Number(scannedPlan.scenes[index - 1]!.end_sec) - Number(scannedPlan.scenes[index]!.start_sec)
      if (overlap > 0.05) { overlapSec += overlap; overlapCount++ }
    }
    const audioDrift = compareMergedAudio(scannedPlan.source_merged_audio, mergedNarrationSec, leadInShiftSec)
    const planRows = result.scenes.filter(scene => scene.source === 'scene_plan')
    const byId = new Map(planRows.map(scene => [scene.plan_scene_id, scene]))
    result.scene_plan_timing = {
      built_at: scannedPlan.timeline_built_at,
      opening_mode: scannedPlan.opening_mode === 'branded-opening' ? 'branded-opening' : 'from-start',
      opening_reserved_sec: openingReserved,
      ...(scannedPlan.opening_source === 'measured' ? { opening_source: 'measured' as const } : {}),
      // Present only when a shift was applied, so an episode without one keeps its render identity.
      ...(leadInShiftSec > 0 ? { audio_lead_in_shift_sec: leadInShiftSec } : {}),
      ...(audioDrift.stale ? { audio_stale_reason: audioDrift.reason } : {}),
      plan_duration_sec: Number(scannedPlan.total_duration_sec) || 0,
      audio_duration_sec: audioDuration,
      approved: scannedPlan.scenes.filter(scene => scene.approved).length,
      stills_ready: scannedPlan.scenes.filter(scene => !!byId.get(scene.id)?.still_path).length,
      motion_ready: planRows.filter(scene => scene.media_type === 'motion').length,
      uncovered_sec: integrity.blockingUncoveredSec,
      head_gap_sec: integrity.headCovered ? 0 : (integrity.coverage?.headGapSec || 0),
      tail_gap_sec: integrity.coverage?.tailGapSec || 0,
      gap_count: integrity.coverage?.internalGaps.length || 0,
      overlap_sec: overlapSec,
      overlap_count: overlapCount,
      complete: !!result.scene_plan_coverage
        && result.scene_plan_coverage.ready === result.scene_plan_coverage.total
        // 1.4.296 — overlaps and a slightly different narration are re-aligned by the render itself.
        && integrity.complete,
      scenes: scannedPlan.scenes.map(scene => {
        const scanned = byId.get(scene.id)
        const stale = sceneImageStaleReason(scene) !== null
        return {
          id: scene.id,
          scene_index: scene.scene_index,
          start_sec: scene.start_sec,
          end_sec: scene.end_sec,
          duration_sec: Math.max(0, scene.end_sec - scene.start_sec),
          approved: !!scene.approved,
          image_ready: !!scanned?.still_path,
          stale,
          media_type: scanned?.media_type || 'still',
          ...(typeof (scene as any).theme === 'string' && (scene as any).theme.trim() ? { theme: String((scene as any).theme).trim() } : {}),
        }
      }),
    }
  }

  // Scan already-rendered videos in the episode's video folder so the UI can
  // tell the user this episode has been assembled before (and show an mtime).
  if (videoDir) {
    const files = await safeReaddir(videoDir)
    for (const file of files) {
      if (!/\.(mp4|mov|webm|mkv)$/i.test(file)) continue
      if (file.startsWith('.tmp_')) continue
      const filePath = path.join(videoDir, file)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        result.rendered_videos.push({
          filename: file,
          path: filePath,
          mtime: stat.mtimeMs,
        })
      } catch { /* ignore */ }
    }
    result.rendered_videos.sort((a, b) => b.mtime - a.mtime)
  }

  // Scan for intro videos in episode dir and project root
  const introLocations = [episodeDir, projectDir]
  for (const loc of introLocations) {
    const files = await safeReaddir(loc)
    for (const file of files) {
      if (!/\.(mp4|mov|mkv|webm)$/i.test(file)) continue
      if (/intro/i.test(file)) {
        result.intro_videos.push({
          filename: file,
          path: path.join(loc, file),
        })
      }
    }
  }

  // Scan for music files in project root, episode dir, and a "music" subfolder
  const musicLocations = [projectDir, episodeDir]
  const musicSubdir = path.join(projectDir, 'music')
  if (existsSync(musicSubdir)) musicLocations.push(musicSubdir)
  const episodeMusicDir = path.join(episodeDir, 'music')
  if (existsSync(episodeMusicDir)) musicLocations.push(episodeMusicDir)

  const seenMusicPaths = new Set<string>()
  for (const loc of musicLocations) {
    const files = await safeReaddir(loc)
    for (const file of files) {
      if (!/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file)) continue
      const fullPath = path.join(loc, file)
      if (seenMusicPaths.has(fullPath)) continue
      seenMusicPaths.add(fullPath)
      const duration = await getAudioDuration(fullPath)
      result.music_files.push({
        filename: file,
        path: fullPath,
        duration,
      })
    }
  }

  return result
}

/** True when `child` is the same path as, or lives underneath, `parent`. */
function isInsideDir(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Bring `{CODE}_stitched.srt` up to date for the episode's CHOSEN merged track.
 *
 * Shared by the auto-repair prologue in `prepareUnifiedVideoAssemblyInputs`
 * (which re-anchors the Scene Plan against these captions) and
 * `resolveEpisodeSubtitleFile` (which then decides what to burn). Idempotent —
 * `ensureStitchedSubtitle` is a no-op once the timeline is already the correct
 * consequence of the chosen track, so the second call in a pass writes nothing.
 */
async function stitchEpisodeSubtitles(
  subtitlesDir: string,
  stitchPaths: { episodeDir: string; mergedAudioDir: string; audioDir: string; scriptDir?: string },
  episodeId: string,
) {
  const { ensureStitchedSubtitle } = await import('../lib/subtitle-autostitch.js')
  return ensureStitchedSubtitle({
    episodeDir: stitchPaths.episodeDir,
    subtitlesDir,
    mergedAudioDir: stitchPaths.mergedAudioDir,
    audioDir: stitchPaths.audioDir,
    episodeCode: episodeId.toUpperCase(),
    ...(stitchPaths.scriptDir ? { scriptDir: stitchPaths.scriptDir } : {}),
  })
}

/**
 * Fill in the episode's own subtitle file when the caller named none (v1.3.4).
 *
 * `routes/pipeline.ts` builds the batch request from a saved video bundle and
 * deliberately drops `srt_path` because it is episode-specific, with the comment
 * "the generator regenerates it per episode … when subtitles.enabled is true".
 * Nothing regenerated it. A batch render therefore reached the burn step with
 * `enabled: true` and an empty path, skipped the `existsSync` gate, produced a
 * video with no captions — and did not even register as a missing burn-in,
 * because the degradation report only counts a burn-in as *requested* when a
 * path is present. Silently shipping a batch of videos without the captions the
 * customer asked for is the same disease as the silent lead-in zero this release
 * fixes; it is the same comment block that records batch renders once dropping
 * logos, grading, chroma-key and overlays for a sibling reason.
 *
 * Unlike the transcript ownership question below, this one has a definite
 * answer and no editorial content: `resolveBurnSubtitle` honours the user's own
 * `.selected_subtitle` pin first and otherwise applies the documented AUTO
 * heuristic (corrected stitch → stitch → whisper → never a per-chapter
 * partial). It is the same resolver B-Roll assembly already uses. So this fills
 * rather than refuses — and says which file it chose, because a file picked on
 * the customer's behalf must be visible in the log before he sees it in the
 * video.
 *
 * ── v1.4.0: this is now the ONLY thing that chooses a transcript ──
 *
 * The owner asked for the choice to be taken away: *"there's no need for me to
 * select which subtitle but automatically selected the stitched subtitle"*. So
 * Video Assembly no longer sends `srt_path` at all, and this function — not the
 * browser — decides for the single-episode page exactly as it already decided
 * for batch. One mechanism, one answer, and the page shows what it picked.
 *
 * The note that used to sit here, that the page "cannot reach this because
 * `useVideoAssemblyIo` omits the whole subtitles block unless a path is set", is
 * no longer true and was removed rather than left to mislead: the page now
 * always arrives with `enabled` and no path, which is precisely this path.
 *
 * A caller that DOES name a path still gets it, unchanged, so the ownership
 * guard below stays the backstop for Pipeline bundles and anything outside this
 * app rather than becoming dead code.
 */
export async function resolveEpisodeSubtitleFile(
  episodeId: string,
  subtitlesDir: string,
  req: GenerateVideoRequest,
  job?: Job,
  /**
   * v1.4.0 — where the stitcher's own inputs live. Supplied by
   * `prepareUnifiedVideoAssemblyInputs`, so every render (page and batch alike)
   * brings the stitched transcript up to date before choosing what to burn.
   * Omitted by the ownership unit tests, which exercise selection alone.
   */
  stitchPaths?: { episodeDir: string; mergedAudioDir: string; audioDir: string; scriptDir?: string },
): Promise<void> {
  if (!req.subtitles?.enabled) return

  // ── Auto-stitch (v1.4.0) ──────────────────────────────────────────────
  // Before deciding WHICH transcript to burn, make sure the stitched one is
  // still the correct consequence of this episode's chapters. This runs even
  // when a path was named, because a named path does not make a stale timeline
  // any less stale — and it throws rather than continuing if a needed stitch
  // cannot be performed, which is why it sits in preflight and not in the
  // encoder.
  if (stitchPaths) {
    const outcome = await stitchEpisodeSubtitles(subtitlesDir, stitchPaths, episodeId)
    const { describeAutoStitch } = await import('../lib/subtitle-autostitch.js')
    job?.output_lines.push(describeAutoStitch(outcome, episodeId.toUpperCase()))
  }

  // An explicitly named path is left alone so the ownership guard below can
  // judge it. Everything Story Studio itself sends now arrives with none.
  if ((req.subtitles.srt_path || '').trim()) return
  const { resolveBurnSubtitle } = await import('../lib/subtitle-selection.js')
  const resolved = await resolveBurnSubtitle(subtitlesDir).catch(() => null)
  if (resolved) {
    req.subtitles = { ...req.subtitles, srt_path: resolved }
    job?.output_lines.push(
      `Subtitles: no file was named for this render — using ${episodeId.toUpperCase()}'s own `
      + `${path.basename(resolved)}.`,
    )
    return
  }
  // Loud, not silent. Leaving `enabled: true` with no path here would sail
  // past the burn step AND past the "what did this render fail to include?"
  // report, so the missing captions would surface only in the finished file.
  job?.output_lines.push(
    `⚠ Subtitles are switched on for ${episodeId.toUpperCase()} but this episode has no subtitle `
    + 'file to burn. Transcribe and stitch it in the Subtitles workspace — this render will have '
    + 'no captions.',
  )
}

/**
 * The subtitle file about to be burned in must belong to THIS episode (v1.3.4).
 *
 * The report: a finished EP0047 video was rendered with EP0048's captions burned
 * across it — 989.833s of Roman grain-dole footage carrying "At Timbuktu, that
 * process has". The immediate cause was in the browser (Video Assembly held an
 * absolute `srt_path` and never re-resolved it when the episode changed, fixed
 * in the same release). This is the second half of the fix, and it is here
 * because a page forgetting to reset is a bug, while a renderer accepting any
 * readable SRT from anywhere on the disk is what turned that bug into a video
 * he was about to publish.
 *
 * ── Why this REFUSES rather than quietly substituting the right file ──
 *
 * Everything else this function does is a silent re-resolve: scenes, merged
 * audio, contextual cues and sound design are all re-derived from the episode's
 * own authoritative data, because for each of those there is exactly one
 * correct answer and the browser's copy is merely stale. Captions are not like
 * that. Which transcript to burn is an editorial choice — stitched, corrected,
 * whisper, a hand-imported file — and substituting one silently would be this
 * app deciding what words go into a customer's video without being asked.
 *
 * Refusing also keeps the failure visible. A silent repair here would mean a
 * frontend regression of exactly this kind could never be noticed again: the
 * renderer would paper over it forever, which is the same disease as the silent
 * lead-in zero fixed elsewhere in this release. And it is cheap — this runs in
 * preflight, before a single frame is encoded, so the cost of being wrong is
 * one click in Step 5 rather than a re-render or a retracted upload.
 */
export async function assertSubtitleFileBelongsToEpisode(
  slug: string,
  episodeId: string,
  episodeDir: string,
  req: GenerateVideoRequest,
  job?: Job,
): Promise<void> {
  const raw = req.subtitles?.enabled ? (req.subtitles.srt_path || '').trim() : ''
  if (!raw) return
  const code = episodeId.toUpperCase()

  // Portable forms (`${PROJECT}/…`) are expanded here rather than trusted,
  // because the ownership test is meaningless against an unexpanded token. A
  // token that cannot be expanded on this machine falls through to the refusal
  // below — which is right: an unresolvable path cannot be shown to belong.
  let abs = raw
  if (isPortablePath(raw)) {
    try {
      abs = resolveAssetPath(raw, (await pm.getProjectOutputRoot(slug)) || undefined)
    } catch { /* leave unexpanded; the check below refuses it by name */ }
  }

  if (isInsideDir(abs, episodeDir)) {
    // Write the expansion back. `resolveAssetPathsInPlace` expands every other
    // user-supplied path but has never listed `srt_path`, so a portable value
    // would reach the burn step as the literal string `${PROJECT}/…`, fail its
    // `existsSync` check, and the captions would vanish from the render without
    // a word. This used to be masked by an accident: every caller handed
    // `toPortablePath` the RELATIVE './episodes', which it refuses, so nothing
    // was ever collapsed into `${PROJECT}/…` in the first place. That accident
    // is gone — the episodes folder is absolute everywhere now — so this
    // expansion is the only thing standing between a portable srt_path and a
    // silently caption-less render.
    if (abs !== raw) req.subtitles!.srt_path = abs
    // Never silent in the other direction either. The job log used to print
    // "Burning in subtitles: EP0048_stitched.srt" for a correct render and a
    // catastrophic one in identical words, so the one line that could have
    // caught this read exactly like every successful render.
    job?.output_lines.push(`Subtitles: ${path.basename(abs)} — confirmed to belong to ${code}.`)
    return
  }

  // Name the other episode when the filename states it. Every subtitle this app
  // writes is prefixed with its own episode code, so this is read, not guessed,
  // and it is omitted entirely for a file that does not carry one.
  const foreignCode = path.basename(abs).match(/^([A-Za-z]+\d+)[_.\- ]/)?.[1]?.toUpperCase()
  const owner = foreignCode && foreignCode !== code ? ` It belongs to ${foreignCode}.` : ''
  const message = `Video Assembly is blocked: the selected subtitle file is not ${code}'s. `
    + `"${path.basename(abs)}" lives outside this episode's folder.${owner} `
    + 'Burning it would put another episode\'s words into this video. '
    + `Pick ${code}'s own subtitle file in Step 5 (Subtitles), or create one in the Subtitles workspace, then retry.`
  await safetyGate(slug, 'subtitles_this_episode', job, message)
  // Off/Warn may omit captions, but never authorizes reading another episode
  // or an arbitrary path into this render.
  req.subtitles = { ...req.subtitles!, enabled: false, srt_path: undefined }
}

/**
 * Build the only supported assembly input set from authoritative episode data.
 * The browser and Pipeline may supply reusable editing settings, but neither is
 * allowed to choose a partial or reordered set of Scene Plan assets.
 */
/**
 * Timing overlaps Video Assembly repairs by itself. 1.4.296 — any size (owner: "Imperfection is
 * often accepted"); before, only ≤ 2 s each and ≤ 5 s in all, and Brain Wise EP0044-EP0048 stopped
 * on 2.9-49 s. Null when there are none.
 */
export function repairableTimingOverlaps(
  timing: Pick<NonNullable<ScannedAssets['scene_plan_timing']>, 'overlap_count' | 'overlap_sec' | 'scenes'> | undefined,
): { count: number; totalSec: number; maxSec: number } | null {
  if (!timing || timing.overlap_count <= 0) return null
  let maxSec = 0
  for (let i = 1; i < timing.scenes.length; i++) {
    maxSec = Math.max(maxSec, Number(timing.scenes[i - 1]!.end_sec) - Number(timing.scenes[i]!.start_sec))
  }
  return { count: timing.overlap_count, totalSec: timing.overlap_sec, maxSec }
}

function hasAvailablePlanOpening(
  req: Pick<GenerateVideoRequest, 'intro' | 'title_image' | 'title_card' | 'timeline_clips' | 'skip_intro_scenes'>,
  projectOutputRoot?: string,
): boolean {
  const available = (raw: string | undefined): boolean => {
    if (!raw) return false
    try {
      const resolved = isPortablePath(raw) ? resolveAssetPath(raw, projectOutputRoot) : raw
      return checkAssetAvailability(resolved).status === 'available'
    } catch {
      return false
    }
  }
  return !!(
    req.intro?.enabled && available(req.intro.video_path)
    || req.title_image?.enabled && available(req.title_image.image_path)
    || (req.title_card?.enabled && req.title_card.text?.trim())
    || req.skip_intro_scenes
    || (req.timeline_clips || []).some(clip => {
      const source = clip.kind === 'static' ? clip.image_path : clip.video_path
      return clip.enabled && (clip.anchor === 'before_intro' || clip.anchor === 'after_intro')
        && available(source)
    })
  )
}

export function blockingUncoveredNarrationSeconds(
  timing: Pick<NonNullable<ScannedAssets['scene_plan_timing']>, 'uncovered_sec' | 'head_gap_sec'>,
  req: Pick<GenerateVideoRequest, 'intro' | 'title_image' | 'title_card' | 'timeline_clips' | 'skip_intro_scenes'>,
  projectOutputRoot?: string,
): number {
  const headCovered = hasAvailablePlanOpening(req, projectOutputRoot)
  return Math.max(0, timing.uncovered_sec - (headCovered ? timing.head_gap_sec : 0))
}

export async function absorbUncoveredNarration(
  slug: string,
  job: Job,
  sceneClipDurations: number[],
  uncoveredSec: number,
  details: string,
): Promise<void> {
  if (!(uncoveredSec > 0)) return
  if (!sceneClipDurations.length) {
    throw new Error('Video Assembly cannot continue: narration is uncovered and there is no scene clip to hold across it.')
  }
  if (uncoveredSec > COVERAGE_FAIL_SEC) await safetyGate(slug, 'narration_covered', job, details)
  sceneClipDurations[sceneClipDurations.length - 1]! += uncoveredSec
  job.output_lines.push(
    uncoveredSec > COVERAGE_FAIL_SEC
      ? `Coverage: held the final scene across ${uncoveredSec.toFixed(2)}s of uncovered narration.`
      : `Coverage: absorbed ${uncoveredSec.toFixed(2)}s of micro-gaps into the final scene (scene body meets the narration end).`,
  )
}

export async function resolveSoundDesignCuesForRender(
  slug: string,
  req: GenerateVideoRequest,
  job: Job,
): Promise<Awaited<ReturnType<typeof approvedSoundDesignMixCues>>> {
  if (!req.sound_design?.cues.length) return []
  if (!req.merged_audio_path || !existsSync(req.merged_audio_path)) {
    await safetyGate(
      slug,
      'cues_approved',
      job,
      'Sound Design mix is blocked: merged audio is missing. Rendering without Sound Design.',
    )
    req.sound_design = undefined
    return []
  }
  return approvedSoundDesignMixCues(req.sound_design.cues as SoundDesignCue[])
}

/**
 * A merged track mixed without the closing music this render asks for would draw a silent, padded tail
 * (Night Atlas History EP0012–14). With a job, re-mix the audio with the tail first and render the new
 * track; without one (admission, caption preflight) only refuse what could not be re-mixed.
 * See services/closing-tail-remix.ts.
 */
export async function guardClosingTail(
  slug: string,
  episodeId: string,
  req: GenerateVideoRequest,
  assets: ScannedAssets,
  job?: Job,
): Promise<ScannedAssets> {
  const merged = assets.merged_audio[0]
  if (!merged) return assets
  const { planClosingTailRemix, remixForClosingTail, recoverPendingRemix } = await import('../services/closing-tail-remix.js')
  const { claimClosingTailRemix } = await import('../services/closing-tail-remix-admission.js')
  const code = episodeId.toUpperCase()
  // One re-mix of an episode at a time: a second render asking for the same tail waits, then finds the
  // first one's pinned track and uses it. Admission (no job) only reads and never waits for a re-mix.
  const decide = async (): Promise<ScannedAssets> => {
    // `req.merged_audio_path` can still name the track this job was accepted with, from before its own
    // (or another render's) re-mix; the plan resolves it to the re-mixed track instead of refusing.
    const plan = () => planClosingTailRemix({ slug, code, postAudio: req.post_audio, preferredFilename: merged.filename })
    let verdict = await plan()
    if (verdict.action === 'refuse') throw nonRetryable(new Error(verdict.reason))
    // Admission mutates nothing: a stopped re-mix is finished by the render, which preflight announces.
    if (verdict.action === 'none' || ((verdict.action === 'remix' || verdict.action === 'recover') && !job)) return assets
    let filename: string | null = null
    if (verdict.action === 'recover') {
      const claim = await claimClosingTailRemix(slug, code)
      if ('busy' in claim) throw new Error(claim.busy)
      try { filename = await recoverPendingRemix(job!, code, verdict) }
      catch (error) { throw nonRetryable(error as Error) }
      finally { claim.release() }
      // Rolled back: the folder is as it was before the stopped re-mix, so decide again from there.
      if (!filename) {
        verdict = await plan()
        if (verdict.action === 'refuse') throw nonRetryable(new Error(verdict.reason))
        if (verdict.action === 'none') return assets
      }
    }
    if (!filename) {
      if (verdict.action === 'use') filename = verdict.filename
      else if (verdict.action === 'remix') {
        const claim = await claimClosingTailRemix(slug, code)
        if ('busy' in claim) throw new Error(claim.busy)
        try { filename = await remixForClosingTail(job!, slug, code, verdict) }
        catch (error) { throw nonRetryable(error as Error) }
        finally { claim.release() }
      } else return assets
    }
    req.merged_audio_path = path.join(path.dirname(merged.path), filename)
    return scanEpisodeAssets(slug, episodeId, { preferredMergedFilename: filename })
  }
  return job ? withLock(`closing-tail-remix:${slug}:${code}`, decide) : decide()
}

export async function prepareUnifiedVideoAssemblyInputs(
  slug: string,
  episodeId: string,
  req: GenerateVideoRequest,
  /** Render job, when there is one. Contextual Cues and Sound Design are
   *  optional and no longer block an episode that never proposed anything —
   *  but "renders with none" must still SAY so, so the absence is never a
   *  surprise in the finished video. The preflight route has no job and just
   *  omits it. */
  job?: Job,
): Promise<ScannedAssets> {
  // v1.4.314 — an accepted job carries the merged track it was accepted with in
  // its own params (`req.merged_audio_path`, set at queue time). Hold on to it
  // BEFORE the scan overwrites it: a queued render must keep rendering the
  // narration it was accepted with, never silently switch to a newer choice.
  const acceptedMergedPath = (req.merged_audio_path || '').trim() || null
  let acceptedMergedName = acceptedMergedPath ? path.basename(acceptedMergedPath) : null
  let assets = await scanEpisodeAssets(slug, episodeId, { preferredMergedFilename: acceptedMergedName })

  // The owner pinned a track and it is no longer in this episode's folder. Do NOT
  // pick another one for him: which narration the video carries is his call, so
  // refuse loudly and name the repair, exactly as the subtitle ownership guard
  // refuses a foreign transcript rather than substituting one.
  const selection = assets.merged_audio_selection
  if (selection?.source === 'invalid') {
    const message = `Video Assembly is blocked: ${episodeId.toUpperCase()}'s selected merged audio `
      + `"${selection.pinned}" is not in this episode's merged-audio folder (it may have been deleted or `
      + 'renamed). Choose this episode\'s narration again in Video Assembly Step 1, then retry.'
    await safetyGate(slug, 'merged_audio_selection', job, message)
    throw new Error(message)
  }
  // An accepted job carries the merged track it was accepted with, in its own
  // params. If that exact file is no longer in this episode's folder, REFUSE —
  // never fall back to whatever is chosen now, not even with a note in the log.
  // Which narration the video carries is the owner's call, and acceptance pins
  // it: silently rendering a different track would produce a video the customer
  // never approved. This is the same "refuse, do not substitute" rule the
  // subtitle ownership guard applies to a foreign transcript.
  if (acceptedMergedName && !assets.merged_audio.some(entry => entry.filename === acceptedMergedName)) {
    const message = `Video Assembly is blocked: this render was accepted with ${episodeId.toUpperCase()}'s `
      + `merged audio "${acceptedMergedName}", which is no longer in this episode's merged-audio folder `
      + '(it may have been deleted or renamed). Restore that track, or choose this episode\'s narration again '
      + 'in Video Assembly Step 1 and queue a new render, then retry.'
    await safetyGate(slug, 'merged_audio_selection', job, message)
    throw new Error(message)
  }

  // The scan's verdict is the one freshness rule (`inspectAudioMergeAtPaths`). A merge it says is not
  // current is refused here, before the closing-tail re-mix or any FFmpeg work could build on it.
  // `missing` stays with the existing "merged audio is missing" handling further down.
  const mergeVerdict = assets.merged_audio_current
  if (mergeVerdict && !mergeVerdict.current && mergeVerdict.reason && mergeVerdict.reason !== 'missing') {
    const { staleMergedAudioMessage } = await import('../services/asset-status.js')
    throw nonRetryable(new Error(staleMergedAudioMessage(episodeId, mergeVerdict.file, mergeVerdict.reason)))
  }

  assets = await guardClosingTail(slug, episodeId, req, assets, job)
  acceptedMergedName = assets.merged_audio[0]?.filename ?? acceptedMergedName

  // 1.4.368 — a TRANSLATED episode's Scene Plan is retimed onto its OWN narration before any
  // timing repair runs. Reconcile cannot do it: it matches the stored scene text against the
  // captions, and until the retime runs that text is the source language's. The retime keeps every
  // scene's id, picture, order and approval, and it is a no-op when the plan already follows this
  // narration. A plan that still does not follow it blocks the render, naming the scenes, rather
  // than letting the pictures drift under the target voice.
  {
    const { ensureTranslatedEpisodePlanRebased } = await import('../services/translation-timeline-rebase.js')
    // An Image Pool render does not play the Scene Plan, so it has no timeline to retime.
    const rebased = assets.visual_source === 'image_pool' ? null : await ensureTranslatedEpisodePlanRebased(slug, episodeId)
    if (rebased) {
      if (rebased.changed) {
        job?.output_lines.push(rebased.message)
        if (rebased.dropped.length) {
          job?.output_lines.push(`${rebased.dropped.length} scene(s) left the plan because this narration has no such chapter: `
            + `${rebased.dropped.slice(0, 8).map(entry => `${entry.id} (${entry.chapter})`).join(', ')}`
            + `${rebased.dropped.length > 8 ? `, … ${rebased.dropped.length - 8} more` : ''}. Their pictures stay on disk.`)
        }
        for (const note of rebased.notes) job?.output_lines.push(`Timeline: ${note}`)
        assets = await scanEpisodeAssets(slug, episodeId, { preferredMergedFilename: acceptedMergedName })
      }
      const stale = assets.scene_plan_timing?.audio_stale_reason
      if (stale) {
        const rows = assets.scene_plan_timing?.scenes || []
        const named = rows.slice(0, 8).map(row => `#${row.scene_index} (${row.start_sec.toFixed(1)}–${row.end_sec.toFixed(1)}s)`)
        throw new Error('Video Assembly is blocked: this translated episode\'s Scene Plan does not follow its narration — '
          + `${stale.replace(/ Re-stitch.*$/, '')} `
          + `Scenes: ${named.join(', ')}${rows.length > 8 ? `, … ${rows.length - 8} more` : ''}. `
          + 'Retime the plan (translate the episode again) or rebuild its timeline. Nothing was rendered.')
      }
    }
  }

  // Timing overlaps of any size, and a plan timed against a slightly different narration, are
  // repaired with the Scene Plan's own "Reconcile timings", which keeps every scene and image, and
  // the render goes on (1.4.278 for small overlaps; 1.4.296 for all of them and for narration
  // drift). A request with no job (preflight, queueing) leaves the repair to the render.
  const overlaps = repairableTimingOverlaps(assets.scene_plan_timing)
  const audioDrift = assets.scene_plan_timing?.audio_stale_reason
  if (job && (overlaps || audioDrift)) {
    // Re-anchoring measures the plan against this episode's stitched captions, and
    // those captions are offset by the CHOSEN merged track's intro lead-in. Bring
    // the stitch up to date FIRST, so the plan is re-anchored to the timeline this
    // render will actually use. The other order (reconcile, then stitch) re-anchored
    // the plan to the PREVIOUS track's captions and then rewrote them, leaving the
    // plan a whole lead-in out of step inside one pass — reachable on any
    // render-only/batch run, where the page's preflight never brought the stitch up
    // to date first. The subtitle resolution below re-runs this and finds it already
    // fresh, so nothing is stitched twice.
    if (req.subtitles?.enabled) {
      const stitchPaths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
      const { describeAutoStitch } = await import('../lib/subtitle-autostitch.js')
      const outcome = await stitchEpisodeSubtitles(stitchPaths.subtitles_dir, {
        episodeDir: stitchPaths.episode_dir,
        mergedAudioDir: stitchPaths.merged_audio_dir,
        audioDir: stitchPaths.audio_dir,
      }, episodeId)
      // `fresh` is what the resolution below will report; say it once, there.
      if (outcome.status !== 'fresh') job.output_lines.push(describeAutoStitch(outcome, episodeId.toUpperCase()))
    }
    const { reconcileScenePlanTimings } = await import('../services/scene-plan-reconcile.js')
    try {
      const repaired = await reconcileScenePlanTimings(slug, episodeId, { auto: true })
      assets = await scanEpisodeAssets(slug, episodeId, { preferredMergedFilename: acceptedMergedName })
      job.output_lines.push(
        'Scene Plan: '
        + [overlaps ? `${overlaps.count} timing overlap(s) totalling ${overlaps.totalSec.toFixed(1)}s (largest ${overlaps.maxSec.toFixed(1)}s)` : '',
          audioDrift ? `out of step with the narration (${audioDrift.replace(/ Re-stitch.*$/, '')})` : '']
          .filter(Boolean).join('; ')
        + ` — re-anchored the timings to the subtitles (${repaired.matched}/${repaired.total} scenes matched, `
        + `median shift ${repaired.median_shift_sec.toFixed(2)}s); every scene and image kept. `
        + `Overlaps now: ${assets.scene_plan_timing?.overlap_count ?? 0}.`,
      )
    } catch (error) {
      // A refused repair leaves the saved plan intact; the timing audit below applies its safety mode.
      job.output_lines.push(`Scene Plan timings could not be re-aligned automatically: ${(error as Error)?.message || error}.`)
    }
  }
  if (assets.visual_source === 'image_pool') {
    const merged = assets.merged_audio[0]
    if (!merged?.path || !existsSync(merged.path)) {
      await safetyGate(slug, 'merged_audio_exists', job, 'Video Assembly is blocked: merged audio is missing. Run Audio Assembly, then retry.')
      const chapters = assets.audio_sections.map(row => row.path).filter(existsSync)
      if (!chapters.length) throw new Error('Video Assembly cannot continue: this episode has no usable narration audio.')
      req.merged_audio_path = undefined
      req.narration_chapters = chapters
      req.narration_path = chapters[0]!
    }
    const narrationDuration = merged?.path && existsSync(merged.path)
      ? narrationSecFromMaster(
        Number(merged.duration || await getAudioDuration(merged.path) || 0),
        merged.closing_tail_sec || 0,
      )
      : (await Promise.all((req.narration_chapters || []).map(file => getAudioDuration(file))))
        .reduce<number>((sum, sec) => sum + Number(sec || 0), 0)
    const imagePool = await resolveImagePoolSelection(slug, episodeId, narrationDuration)
    const playOrder = buildImagePoolPlayOrder(imagePool, narrationDuration)
    if (!playOrder.length) {
      await safetyGate(slug, 'image_pool_covers', job, 'Video Assembly is blocked: Image Pool selection cannot cover the narration. Pick images again, then retry.')
      throw new Error('Video Assembly cannot continue: Image Pool has no usable picture interval to render.')
    }
    req.scenes = playOrder.map((item, index) => ({
      image_path: item.path,
      duration: item.duration,
      scene_number: index + 1,
      title: `Image ${index + 1}`,
      show_title: false,
      clip_shortfall_mode: 'hold',
    }))
    req.scene_pool_mode = 'image_pool'
    if (merged?.path && existsSync(merged.path)) {
      req.merged_audio_path = merged.path
      req.narration_path = merged.path
    }
    req.scene_recycling = {
      ...(req.scene_recycling || {}),
      seconds_per_scene: imagePool.seconds_per_image,
      shuffle: false,
      excluded_scenes: [],
      broll_natural_duration: false,
    }

    // Captions keep the episode's own audio timeline. Existing optional cues
    // retain their validated timestamps when a Scene Plan record is present.
    const paths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, 'broll-selection.json')
    await resolveEpisodeSubtitleFile(episodeId, paths.subtitles_dir, req, job, {
      episodeDir: paths.episode_dir,
      mergedAudioDir: paths.merged_audio_dir,
      audioDir: paths.audio_dir,
    })
    await assertSubtitleFileBelongsToEpisode(slug, episodeId, paths.episode_dir, req, job)
    await hydrateEpisodeRenderCues(slug, episodeId, req, job, true)
    job?.output_lines.push(
      `Image Pool source: ${imagePool.selected_images.length} frozen image(s), `
      + `cycled at ${imagePool.seconds_per_image.toFixed(2)}s intervals to ${narrationDuration.toFixed(2)}s merged narration (final interval may be partial).`,
    )
    return assets
  }
  const timing = assets.scene_plan_timing
  const coverage = assets.scene_plan_coverage
  if (!timing || !coverage || coverage.total === 0) {
    throw new Error('No Scene Plan timeline was found. Build the timeline, generate visual prompts, and review every scene first.')
  }
  if (timing.audio_stale_reason && job) {
    throw new Error(`Video Assembly is blocked: the Scene Plan is out of date — ${timing.audio_stale_reason} Nothing was rendered.`)
  }
  if (coverage.missing.length) {
    await safetyGate(slug, 'scene_pictures', job, `${coverage.missing.length} missing image(s): ${coverage.missing.slice(0, 8).map(row => `#${row.scene_index}`).join(', ')}. A nearest episode picture will stand in for this render.`)
  }
  if (coverage.unapproved.length) {
    await safetyGate(slug, 'scenes_approved', job, `${coverage.unapproved.length} unapproved scene(s): ${coverage.unapproved.slice(0, 8).map(row => `#${row.scene_index}`).join(', ')}. Their existing pictures will be used.`)
  }
  // 1.4.296 — a picture drawn from an older wording of its prompt is still that scene's picture.
  // It is used as it is and named here; Scene Review still marks it for a re-render.
  if (coverage.stale.length) {
    await safetyGate(slug, 'stale_picture', job, `${coverage.stale.length} scene picture(s) were drawn from an older prompt (${coverage.stale.slice(0, 8).map(row => `#${row.scene_index}`).join(', ')}). Their existing pictures will be used.`)
    job?.output_lines.push(`${coverage.stale.length} scene picture(s) were drawn from an older prompt `
      + `(${coverage.stale.slice(0, 8).map(row => `#${row.scene_index}`).join(', ')}${coverage.stale.length > 8 ? ', …' : ''}); `
      + 'using them as they are. Re-render them in Scene Review to refresh them.')
  }
  if (coverage.motion_fallback?.length) {
    // §4 announce rule: a selected clip that Assembly drops must be named, with its reason.
    for (const row of coverage.motion_fallback) {
      job?.output_lines.push(`Scene #${row.scene_index} (${row.id}) clip not used — ${row.reason}; its approved still will be used. Re-generate it in Motion Review.`)
    }
  }
  const blockingUncovered = blockingUncoveredNarrationSeconds(
    timing,
    req,
    (await pm.getProjectOutputRoot(slug)) || undefined,
  )
  if (blockingUncovered > COVERAGE_FAIL_SEC) {
    // 1.4.288 — a zero-length row voids the whole coverage audit; say that, not "all of it is unplanned" (BW EP0040).
    const zeroLength = timing.scenes.filter(scene => !(scene.end_sec > scene.start_sec)).length
    await safetyGate(slug, 'narration_covered', job, zeroLength
      ? `${zeroLength} scene(s) have no length (end time not after start time); rebuild the Scene Plan timeline`
      : `${blockingUncovered.toFixed(1)}s of narration has no planned scene. Existing scene clips will extend to cover it.`)
  }
  if (timing.overlap_count > 0 && job) {
    await safetyGate(slug, 'scene_overlap', job, `${timing.overlap_count} timing overlap(s) totalling ${timing.overlap_sec.toFixed(1)}s could not be re-aligned. The scene clips will render in plan order.`)
  }
  // Coverage can pass while short rows expand at the renderer's floor. Use the existing
  // narration-coverage mode: Block stops; Warn/Off continue with the timing explanation.
  const unrenderable = unrenderableSceneProblem(timing.scenes)
  if (unrenderable) {
    await safetyGate(slug, 'narration_covered', job,
      `${unrenderable}. Video Assembly holds each such scene for the ${MIN_RENDERABLE_SCENE_SEC}s floor, `
      + 'so the rendered scene track runs longer than the plan and the narration. '
      + 'Reconcile timings on the Scene Plan page re-times the existing scenes and keeps their images; '
      + 'if it cannot match this narration, rebuild the timeline — a rebuild replaces the timing and prompts '
      + 'and does not carry the existing images.')
  }

  const available = assets.scenes
    .filter(scene => scene.source === 'scene_plan')
    .sort((a, b) => (a.planned_scene_index || a.number) - (b.planned_scene_index || b.number))
  if (available.length !== coverage.total) {
    await safetyGate(slug, 'scene_count', job, `Video Assembly expected ${coverage.total} Scene Plan assets but resolved ${available.length}. Missing rows will use the nearest episode picture.`)
  }
  const byId = new Map(available.map(scene => [scene.plan_scene_id, scene]))
  const planned = timing.scenes.map((row, index) => {
    const own = byId.get(row.id)
    if (own) return own
    let neighbour: ScannedAssets['scenes'][number] | undefined
    for (let distance = 1; !neighbour && distance < timing.scenes.length; distance++) {
      neighbour = byId.get(timing.scenes[index - distance]?.id) || byId.get(timing.scenes[index + distance]?.id)
    }
    if (!neighbour) throw new Error(`Video Assembly cannot continue: scene #${row.scene_index} has no usable episode picture or neighbour.`)
    return {
      ...neighbour,
      path: neighbour.still_path || neighbour.path,
      media_type: 'still' as const,
      plan_scene_id: row.id,
      planned_scene_index: row.scene_index,
      number: row.scene_index,
      start_sec: row.start_sec,
      end_sec: row.end_sec,
      duration_sec: row.duration_sec,
    }
  })
  const merged = assets.merged_audio[0]
  if (!merged?.path || !existsSync(merged.path)) {
    await safetyGate(slug, 'merged_audio_exists', job, 'Video Assembly is blocked: merged audio is missing. Run Audio Assembly, then retry.')
    const chapters = assets.audio_sections.map(row => row.path).filter(existsSync)
    if (!chapters.length) throw new Error('Video Assembly cannot continue: this episode has no usable narration audio.')
    req.merged_audio_path = undefined
    req.narration_chapters = chapters
    req.narration_path = chapters[0]!
  }

  req.scenes = planned.map(scene => ({
    image_path: scene.path,
    duration: scene.duration_sec,
    plan_scene_id: scene.plan_scene_id,
    scene_number: scene.planned_scene_index || scene.number,
    title: `Scene ${scene.planned_scene_index || scene.number}`,
    show_title: false,
    __scene_plan_duration: true,
    clip_shortfall_mode: scene.clip_shortfall_mode,
  }))
  req.scene_pool_mode = 'scene_plan'
  if (merged?.path && existsSync(merged.path)) {
    req.merged_audio_path = merged.path
    req.narration_path = merged.path
  }
  req.scene_recycling ||= { seconds_per_scene: 10, shuffle: false, excluded_scenes: [] }
  const cuePaths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  await resolveEpisodeSubtitleFile(episodeId, cuePaths.subtitles_dir, req, job, {
    episodeDir: cuePaths.episode_dir,
    mergedAudioDir: cuePaths.merged_audio_dir,
    audioDir: cuePaths.audio_dir,
  })
  await assertSubtitleFileBelongsToEpisode(slug, episodeId, cuePaths.episode_dir, req, job)
  const leadInShiftSec = timing.audio_lead_in_shift_sec || 0
  if (leadInShiftSec > 0) {
    job?.output_lines.push(
      `Music lead-in: the merged audio plays ${leadInShiftSec.toFixed(2)}s before the narration, but this Scene Plan was timed `
      + `from narration at 0s. Scene 1 holds through the intro and every later scene moves ${leadInShiftSec.toFixed(2)}s; `
      + 'captions already follow the merged audio. Nothing is re-made.',
    )
  }
  await hydrateEpisodeRenderCues(slug, episodeId, req, job, false, leadInShiftSec, new Map(
    available.filter(scene => scene.plan_scene_id && scene.still_path)
      .map(scene => [scene.plan_scene_id!, scene.still_path!]),
  ))
  return assets
}

async function hydrateEpisodeRenderCues(
  slug: string, episodeId: string, req: GenerateVideoRequest, job?: Job, allowMissing = false, leadInShiftSec = 0,
  sceneImages: Map<string, string> = new Map(),
): Promise<void> {
  // Cues are reviewed on the plan's clock; a lead-in shift moves them with their scenes.
  const onAudioClock = <T extends { start_sec: number; end_sec?: number }>(cue: T): T => (leadInShiftSec > 0
    ? { ...cue, start_sec: cue.start_sec + leadInShiftSec, ...(typeof cue.end_sec === 'number' ? { end_sec: cue.end_sec + leadInShiftSec } : {}) }
    : cue)
  const cueConfig = normalizeContextualCueConfig((await pm.getConfig(slug))?.contextual_cues)
  const cuePaths = await resolveEpisodePathsByCodeWithSidecar(slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(slug, episodeId, cuePaths.episode_dir)
  if (allowMissing && !existsSync(planPath)) {
    // Image Pool without a Scene Plan: cues and sound design have nothing to
    // be placed on. Switched on, that is a stop, not a silent drop.
    const on = [
      cueConfig.enabled ? 'Contextual Cues' : '',
      normalizeSoundDesignConfig((await pm.getConfig(slug))?.sound_design).enabled ? 'Sound Design' : '',
    ].filter(Boolean)
    if (on.length) {
      await safetyGate(slug, 'cues_approved', job, `Video Assembly stopped before encoding ${episodeId}: ${on.join(' and ')} ${on.length > 1 ? 'are' : 'is'} switched on, `
        + 'but this Image Pool episode has no Scene Plan to place them on. Build a Scene Plan for it, '
        + `or switch ${on.join(' and ')} off in the project settings. Rendering without them.`)
    }
    req.contextual_cues = undefined
    req.sound_design = undefined
    return
  }
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  // v1.4.365 — ONE read re-anchors BOTH halves against this plan and this
  // episode's own captions, so a label and a sound in the same scene can never
  // disagree about where that scene starts. The stored seconds are kept for a
  // cue with no anchor (every v1 file) and are overridden for one that has.
  const anchored = await readAnchoredEpisodeCues(planPath, plan, stitchedSrtPath(cuePaths.subtitles_dir, episodeId))
  const cueTimeline = anchored.labels
  const soundTimeline = anchored.sounds
  if (hasAnchorMoves(anchored.moves)) {
    for (const line of describeAnchorMoves(anchored.moves)) job?.output_lines.push(`Sound & Labels: ${line}`)
  }
  // An editorial gap never blocks assembly any more (owner, 2026-10-28): an
  // approved label draws, an unapproved one is reported, and the episode still
  // renders. Only a genuine drawing defect reaches `safetyGate` below, because
  // `resolveRenderable*` throws for exactly those.
  let cueFailure = false
  try {
    const renderable = resolveRenderableContextualCues(cueConfig, cueTimeline, plan, req.subtitles)
    req.contextual_cues = renderable.cues.map(onAudioClock)
    if (req.scene_pool_mode !== 'image_pool') {
      req.contextual_cues = await resolveLabelTargets({
        episodeDir: cuePaths.episode_dir, plan, cues: req.contextual_cues, sceneImages,
        log: message => job?.output_lines.push(message),
      })
    }
    for (const skip of renderable.skipped) {
      job?.output_lines.push(`Sound & Labels: label "${labelOf(cueTimeline, skip.cue_id)}" ${skip.detail}`)
    }
  } catch (error: any) {
    cueFailure = true
    await safetyGate(slug, 'cues_approved', job, `${error?.message || error} Rendering without Contextual Cues.`)
    req.contextual_cues = []
  }
  // Rendering with none is allowed, but never silent: an optional feature that
  // is switched on and contributes nothing has to say so, or its absence in the
  // finished video reads as a bug.
  const cueGate = switchedOnCueGate('On-screen text', episodeId, {
    enabled: cueConfig.enabled, timeline: cueTimeline, approved: req.contextual_cues.length,
  })
  if (cueGate.stop && !cueFailure) await safetyGate(slug, 'cues_approved', job, cueGate.stop)
  if (cueGate.note && job) noteRender(job, cueGate.note)
  const soundConfig = normalizeSoundDesignConfig((await pm.getConfig(slug))?.sound_design)
  let approvedSoundCues: SoundDesignCue[] = []
  let soundFailure = false
  try {
    const renderable = resolveRenderableSoundCues(soundConfig, soundTimeline, plan)
    approvedSoundCues = renderable.cues.map(onAudioClock)
    for (const skip of renderable.skipped) {
      job?.output_lines.push(`Sound & Labels: sound "${soundLabelOf(soundTimeline, skip.cue_id)}" ${skip.detail}`)
    }
  } catch (error: any) {
    soundFailure = true
    await safetyGate(slug, 'cues_approved', job, `${error?.message || error} Rendering without Sound.`)
  }
  // A missing or unapproved sound is SILENCE plus a stated note, never a stop.
  // The only sound that stops a render is one the mixer genuinely cannot make.
  if (soundConfig.enabled && !soundFailure && !approvedSoundCues.length && job) {
    noteRender(job, 'Sound: every sound on this episode was turned off, unreviewed or could not be placed — this render is narration-only. Open Sound & Labels to place or approve one.')
  } else if (soundConfig.enabled && !soundFailure && job) {
    job.output_lines.push(`Sound: mixing ${approvedSoundCues.length} approved sound${approvedSoundCues.length === 1 ? '' : 's'}.`)
  }
  const transitionCues: SoundDesignCue[] = []
  try {
    const transitions = await import('../services/transition-sounds.js')
    const channel = await pm.getConfig(slug)
    const episode = await transitions.readTransitionEpisodeSettings(planPath)
    const settings = transitions.effectiveTransitionSettings((channel as any)?.transition_sounds, episode)
    if (settings.enabled) {
      const sets = Array.isArray((channel as any)?.transition_sound_sets) ? (channel as any).transition_sound_sets : transitions.DEFAULT_TRANSITION_SETS
      const set = sets.find((item: any) => item.id === settings.set_id && item.enabled)
      if (!set) job?.output_lines.push('Transition sounds: selected set is missing or off; no transition sounds were mixed.')
      else {
        const library = await transitions.listTransitionClips()
        for (const note of library.notes) job?.output_lines.push(`Transition sounds: ${note}`)
        const resolved = transitions.resolveTransitionSet(set, library.clips)
        for (const missing of resolved.missing) job?.output_lines.push(`Transition sounds: pinned clip "${missing}" is unavailable.`)
        const placed = transitions.placeTransitionSounds(plan, episodeId, episode.shuffle || 0, resolved.clips, settings.gain_db)
        for (const cue of placed) {
          try {
            await approvedSoundDesignMixCues([cue])
            transitionCues.push(onAudioClock(cue))
          } catch (error: any) {
            job?.output_lines.push(`Transition sounds: "${cue.label}" could not be mixed: ${error?.message || error}`)
          }
        }
        if (!placed.length) job?.output_lines.push('Transition sounds: the selected set is empty, so no transition sounds were mixed.')
      }
    }
  } catch (error: any) {
    job?.output_lines.push(`Transition sounds could not be prepared: ${error?.message || error}. Rendering without them.`)
  }
  // Per-clip credits for the Gateway library's licences. Recorded on the job
  // result so the credits survive into the publish record, and printed here so
  // an episode that used one says so where the render is reviewed.
  const credits = formatSoundCredits([...approvedSoundCues, ...transitionCues])
  if (credits.length) {
    job?.output_lines.push(`Sound credits (${credits.length} clip${credits.length === 1 ? '' : 's'}):`)
    for (const line of credits) job?.output_lines.push(`  ${line}`)
    if (job) job.result = { ...(job.result || {}), sound_credits: credits }
  }
  // `soundTimeline` is null exactly when nothing was ever added, which now
  // reaches here instead of throwing — so the ducking profile falls back to the
  // shipped default rather than dereferencing null. With no approved cues the
  // mixer is a no-op either way; the field only exists to keep the shape stable.
  req.sound_design = soundConfig.enabled || transitionCues.length
    ? {
        cues: [...approvedSoundCues, ...transitionCues],
        ducking_profile: soundTimeline?.settings.ducking_profile ?? DEFAULT_SOUND_DESIGN_SETTINGS.ducking_profile,
      }
    : undefined
}

/** A label named the way the page lists it — never by its internal id. */
function labelOf(timeline: { cues: Array<{ id: string; title: string }> } | null, id?: string): string {
  const cue = id ? timeline?.cues.find(row => row.id === id) : undefined
  return cue?.title?.trim() || 'A label'
}

function soundLabelOf(timeline: { cues: Array<{ id: string; label: string }> } | null, id?: string): string {
  const cue = id ? timeline?.cues.find(row => row.id === id) : undefined
  return cue?.label?.trim() || 'A sound'
}

// ── Generate Video (multi-pass pipeline) ──────────────────────────────────

/** The active Video Assembly bundle preset's `fallback.export.loudness_tolerance_pct`; undefined when there is none. */
export async function channelLoudnessTolerancePct(slug: string): Promise<number | undefined> {
  try {
    const { findActivePreset } = await import('../routes/pipeline.js')
    type Bundle = { fallback?: { export?: { loudness_tolerance_pct?: unknown } } }
    const preset = findActivePreset(await pm.getConfig(slug), 'video_assembly').preset as (Bundle & { data?: Bundle }) | null
    const pct = (preset?.data?.fallback ?? preset?.fallback)?.export?.loudness_tolerance_pct
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : undefined
  } catch { return undefined }
}

export type VideoAssemblyDisposition = void | { kind: 'video-assembly-remote-wait' }

export async function generateVideo(job: Job): Promise<VideoAssemblyDisposition> {
  const { project_slug, episode_id, params } = job
  const req = createVideoAssemblyExecutionRequest(params)
  const code = episode_id.toUpperCase()
  for (const note of normalizeEffectsLook(params).notes) job.output_lines.push(`Effects: ${note}`)
  job.output_lines.push(`Effects this render bakes in: ${describeEffectStack(req).join(' · ') || 'none'}`
    + ' (plus any per-episode Effects Library effects, listed below when present).')

  // Intro skip is a PLANNER-time economy switch, not a render-time one.
  //
  // What it still does: `config.skip_intro_scenes` tells Scene Plan not to
  // spend prompts and images on the Introduction chapter, so scenes begin at
  // the story start (see `generators/scene-plan.ts`, search `skipUntilSec`).
  // What it no longer does: excuse the resulting hole here. A request-level
  // `skip_intro_scenes` once let the render treat any head gap as intentional,
  // which is exactly how an episode could reach the encoder with minutes of
  // narration and nothing to show over it.
  //
  // So the coverage gate below stays authoritative: whatever the planner chose
  // to skip, the render still requires something to cover it — an opening clip,
  // a title card, or scene 1 held across it (Scene Plan → "Cover the opening").
  // That is chosen per episode, deliberately, and never defaulted here.
  //
  // v1.3.1 — the caption default that used to read `visual_opening_mode` from
  // the project config moved to where the plan's reserve is known (search
  // `hide_during_intro` below). A remembered "this project has a branded
  // opening" flag is the same class of stale copy this release removed from
  // the reserve itself; the plan already states whether an opening exists.
  // The explicit "Hide captions during the intro" checkbox in Video Assembly
  // still wins whenever the customer has expressed a preference.
  req.skip_intro_scenes = false

  // 1. Validate FFmpeg
  const ffmpegCheck = await checkFfmpeg()
  if (!ffmpegCheck.installed) {
    throw new Error('FFmpeg is not installed. Please install FFmpeg to generate videos.')
  }
  job.output_lines.push(`FFmpeg version: ${ffmpegCheck.version}`)
  const canDrawtext = ffmpegCheck.has_drawtext
  if (!canDrawtext) {
    job.output_lines.push('Warning: drawtext filter not available — text overlays will be skipped')
  }
  if (defaultEncodingEffort(req, ffmpegCheck.hw_encoders)) {
    req.encoding_effort = 'hardware'
    job.output_lines.push('Encoder: Apple Media Engine (h264_videotoolbox) by default; the CPU encoder takes over by itself if it cannot start.')
  }

  // Resolve output directory
  const outputRoot = await pm.getProjectOutputRoot(project_slug)
  if (!outputRoot) throw new Error('Project directory not found')

  // Re-resolve the authoritative Scene Plan immediately before work starts.
  // This self-heals stale browser payloads and makes Pipeline/manual/Hub jobs
  // share one exact input contract.
  const authoritativeAssets = await prepareUnifiedVideoAssemblyInputs(project_slug, code, req, job)

  // Per-episode free-disk-space precheck. The run-batch route does this
  // up front for the whole batch; this is a defence-in-depth gate for
  // single-episode runs (and for batches that started with enough space
  // but were drained by an earlier episode). Throw BEFORE any FFmpeg
  // spawns so we don't burn encode time only to fail on the final write.
  // 1.2× margin here (vs 1.5× at the batch gate) — temp files for one
  // episode are bounded by the final output size plus per-clip prep.
  {
    const dur = authoritativeAssets.scene_plan_timing?.audio_duration_sec || (req.duration?.mode === 'custom'
      ? (req.duration.max_duration || req.duration.min_duration || 0)
      : 0) || undefined
    const estBytes = estimateBytesForStep('video_assembly', {
      durationSec: dur,
      resolution: req.resolution,
      quality: req.quality,
    })
    const required = Math.ceil(estBytes * 1.2)
    const free = await getFreeBytes(outputRoot)
    if (free > 0 && free < required) {
      throw new Error(
        `Not enough free disk space for ${code}. Have: ${formatBytes(free)}, need: ${formatBytes(required)} ` +
        `(estimated for ${req.resolution || '1080p'} ${req.quality || 'medium'}, includes 1.2× safety margin). ` +
        `Free up space and retry.`,
      )
    }
  }

  // Expand any portable asset paths (`${PROJECT}/...`, `${MY_FOLDER}/...`)
  // to absolute paths on this machine BEFORE downstream code touches them.
  // Keeps legacy absolute paths unchanged.
  resolveAssetPathsInPlace(req, outputRoot, job)
  // Everything switched on must have its input — checked here, on the
  // resolved paths and before any encode, so a missing piece costs seconds
  // instead of a whole render (owner decision 2026-10-07).
  {
    const missing = missingEnabledVideoInputs(req, {
      canDrawtext,
      episodeCode: code,
      availableThumbnailPaths: authoritativeAssets.thumbnails?.map(t => t.path),
    })
    if (missing.length) await safetyGate(project_slug, 'switched_on_inputs', job, missingInputsMessage(missing, code))
  }
  // Keep the resolved authoritative inputs before Sound Design replaces the
  // narration path with a freshly mixed derivative. The source narration,
  // cue identities, and settings are what make scene clips reusable.
  // Final loudness (1.4.270): resolved onto the request so it is part of the render's identity. A final
  // render begun by an older version (not levelled) is then rendered again rather than resumed.
  // 1.4.279: a request with no allowance of its own (a retry of an older job, a resumed or conductor
  // job, a recovery job) takes the channel's current Video Assembly preset's, as run-batch does.
  if (typeof req.loudness_tolerance_pct !== 'number') req.loudness_tolerance_pct = await channelLoudnessTolerancePct(project_slug)
  const loudness = { ...loudnessTarget(req), check: await safetyMode(project_slug, 'loudness') }
  req.loudness_lufs = loudness.lufs
  req.true_peak_db = loudness.true_peak_db
  const renderFingerprintRequest = structuredClone(req)
  // 1.4.274 — the allowed difference only judges the finished file; changing it must not re-render.
  delete renderFingerprintRequest.loudness_tolerance_pct

  const names = await resolveSubfolderNames(project_slug, code)
  // Prefer the titled folder when the user has leftover renamed siblings.
  let titleHint: string | undefined
  try {
    const im = await import('../services/idea-manager.js')
    const ideas = await im.getIdeas(project_slug, 'accepted')
    const match = ideas.find(i => i.episode_code === code)
    if (match?.title) titleHint = match.title
  } catch { /* fall back to code-only match */ }
  const episodeDir = authoritativeAssets.episode_dir || await findEpisodeDir(outputRoot, code, { titleHint })
  if (!episodeDir) throw new Error(`Episode directory not found for ${code}`)

  // Sound Design is preflighted before final assembly. Once enabled, approved
  // local assets are a required part of this render: fail loudly rather than
  // silently claiming a video includes sound effects when it does not.
  const resolvedSoundDesignCues = await resolveSoundDesignCuesForRender(project_slug, req, job)

  // **The narration's own line ends, read before the reveal plan is resolved.** A hold can snap to
  // the end of the line it is covering, and that is a fact about the script — not about the render
  // — so it belongs with the other authoritative inputs. It used to be read after the render
  // fingerprint was built, which made it unreachable for the plan: the fingerprint hashes the
  // resolved plan, so the plan cannot depend on anything read after it. Reading it here is what
  // lets the plan snap without moving the fingerprint or making it lie.
  let sentenceSidecar: Awaited<ReturnType<typeof import('../lib/sentence-timing.js').parseSentenceSidecar>> = null
  let sentenceReadNote = ''
  if (req.scene_reveal?.enabled) {
    try {
      const sentencesPath = path.join(episodeDir, 'audio_sentences.json')
      const rawSentences = await fs.readFile(sentencesPath, 'utf-8').catch(() => null)
      if (rawSentences) {
        const { parseSentenceSidecar } = await import('../lib/sentence-timing.js')
        sentenceSidecar = parseSentenceSidecar(JSON.parse(rawSentences))
      } else {
        sentenceReadNote = 'audio_sentences.json is missing — re-run Audio Merge to emit it.'
      }
    } catch (error: any) {
      sentenceReadNote = error?.message || 'read error'
    }
  }
  // Absolute narration line ends, for the reveal plan's snapping. Empty when the sidecar is absent,
  // which is not an error: a project that never opted into sentence alignment has no line ends, and
  // a hold then stays on its window exactly as it did before snapping existed.
  const narrationLineEnds: number[] = (sentenceSidecar?.sections ?? [])
    .flatMap(section => section.sentences.map(sentence => Number(sentence.end_s)))
    .filter(value => Number.isFinite(value) && value > 0)

  const videoDir = await resolveEpisodeSubfolderDir(project_slug, code, 'video', episodeDir, names.video)
  await fs.mkdir(videoDir, { recursive: true })

  // Validate scenes
  if (!req.scenes || req.scenes.length === 0) {
    throw new Error('No scenes provided for video generation')
  }
  await replaceUndecodableSceneImages(project_slug, req.scenes, job)

  // Unified Video Assembly has one authoritative timing source. The preflight
  // above already replaced every browser/Pipeline scene with the approved plan
  // row, so no secondary bridge or legacy pool mode may reinterpret it here.
  const planStrict = authoritativeAssets.visual_source !== 'image_pool'
  // Image Pool has no Scene Plan coverage checks, but its expanded selection
  // is still exact: no shuffle, exclusions, fit-trim, or implicit recycling.
  const exactSceneTiming = planStrict || authoritativeAssets.visual_source === 'image_pool'
  const planCoverageScenes = authoritativeAssets.scene_plan_timing?.scenes.map(scene => ({
    id: scene.id,
    start_sec: scene.start_sec,
    end_sec: scene.end_sec,
    theme: scene.theme ?? null,
  })) || []
  const planOpeningReservedSec = authoritativeAssets.scene_plan_timing?.opening_reserved_sec || 0
  // v1.3.1 — a plan whose reserve was PROBED from the real opening clips
  // already equals `preSceneDuration`, so the render just plays those clips.
  // A legacy plan's reserve is a number someone typed, which the render still
  // repairs by stretching the intro to fill it. See the guard below.
  const planOpeningMeasured = authoritativeAssets.scene_plan_timing?.opening_source === 'measured'
  job.output_lines.push(
    planStrict
      ? `Scene Plan timing: ${req.scenes.length} scene(s), exact order + duration; recycling, shuffle, and chapter alignment are disabled.`
      : `Image Pool timing: ${req.scenes.length} frozen still interval(s); cyclic selection is resolved from the persisted pool sidecar.`,
  )

  // Validate narration — merged audio takes priority, then chapters, then single narration
  const useMergedAudio = !!req.merged_audio_path && existsSync(req.merged_audio_path)
  const narrationChapters = req.narration_chapters || []
  const hasChapters = !useMergedAudio && narrationChapters.length > 1

  if (useMergedAudio) {
    job.output_lines.push(`Using pre-merged audio: ${path.basename(req.merged_audio_path!)}`)
  } else if (hasChapters) {
    const validChapters = narrationChapters.filter(f => existsSync(f))
    if (validChapters.length === 0) {
      throw new Error(`No valid narration chapter files found. Checked: ${narrationChapters[0]}`)
    }
    job.output_lines.push(`Found ${validChapters.length}/${narrationChapters.length} narration chapters`)
  } else if (!req.narration_path || !existsSync(req.narration_path)) {
    throw new Error(`Narration audio not found: ${req.narration_path}`)
  }

  const { w, h } = resolveRenderCanvas(req.resolution, req.aspect_ratio)
  // The canvas is now two choices rather than one, so the log says which frame
  // is being drawn before anything is drawn on it.
  job.output_lines.push(`Canvas: ${w}×${h} (${displayAspectRatio(req.aspect_ratio, w, h)}, ${req.resolution || '1080p'})`)
  const baseQuality = QUALITY_PRESETS[req.quality] || QUALITY_PRESETS['medium']
  const fps = req.fps ?? DEFAULT_FPS
  // Every clip-prep function reads from this shared bag. `fps` hitches a
  // ride so we don't need to thread a separate parameter through six
  // function signatures. The final encode overrides `preset` with the
  // user's `encoding_effort` pick (see `runFinalComposition`).
  const quality = { ...baseQuality, fps }
  const format = req.format || 'mp4'

  // 2. Calculate target duration
  let narrationDuration: number | undefined
  if (useMergedAudio) {
    narrationDuration = await getAudioDuration(req.merged_audio_path!)
  } else if (hasChapters) {
    let totalChapterDur = 0
    for (const chPath of narrationChapters) {
      if (!existsSync(chPath)) continue
      const d = await getAudioDuration(chPath)
      if (d) totalChapterDur += d
    }
    // Add estimated gap time
    const audioGapEst = req.audio_gap ?? 5
    totalChapterDur += (narrationChapters.filter(f => existsSync(f)).length - 1) * audioGapEst
    narrationDuration = totalChapterDur > 0 ? totalChapterDur : undefined
  } else {
    narrationDuration = await getAudioDuration(req.narration_path!)
  }
  if (!narrationDuration) {
    throw new Error('Could not determine narration audio duration')
  }
  job.output_lines.push(`Narration duration: ${narrationDuration.toFixed(1)}s`)

  // v1.0.354 — Target Duration removed. The video body always equals the
  // narration: scenes (looping stills or per-scene-timed continuity clips)
  // cover exactly the narration, and the ONLY thing that extends the body is
  // an intentional "after narration" tail (a fade-out, a held final frame, or
  // a black screen). The old `+30` pad and the custom min/max range padded
  // silent video or risked cutting the audio, so they're gone — the post-audio
  // tail now carries its own explicit length instead of being sized by a
  // target/narration gap.
  //
  // The closing music tail is baked into the merged master at Audio Assembly,
  // which wrote down how long it is. When it did, the master ALREADY runs to the
  // end of that tail: it is the video's real length, so the tail is not added a
  // second time (a second silent pad) and the narration is not cut short by
  // treating the master as speech. `narrationDuration` becomes the SPEECH end —
  // where the scenes stop and where every "how long is the narration" reader
  // (coverage, captions, Image Pool, the plan's clock) must look — while
  // `targetDuration` stays the master's own length.
  const mergedClosingTailSec = useMergedAudio ? (authoritativeAssets.merged_audio[0]?.closing_tail_sec || 0) : 0
  // Whether that master was recorded with a music bed — the final check's answer to a silent tail.
  const mergedBackgroundMusicRecord = useMergedAudio && authoritativeAssets.merged_audio[0]
    ? await mergedBackgroundMusic(authoritativeAssets.merged_audio[0].path, code)
    : null
  const lengths = resolveVideoLengths({
    sourceDurationSec: narrationDuration,
    bakedClosingTailSec: mergedClosingTailSec,
    postAudio: req.post_audio,
  })
  narrationDuration = lengths.narrationDurationSec
  const postRoll = lengths.postRollSec
  if (mergedClosingTailSec > 0) {
    job.output_lines.push(
      `Closing tail: ${mergedClosingTailSec.toFixed(1)}s of music after the narration are already in `
      + `${path.basename(req.merged_audio_path!)}, so the video ends with the audio at `
      + `${lengths.targetDurationSec.toFixed(1)}s (speech ends at ${narrationDuration.toFixed(1)}s) — no second tail is added.`,
    )
    if (postRollSeconds(req.post_audio) !== mergedClosingTailSec) {
      job.output_lines.push(
        `  Video Assembly's post-audio tail now says ${postRollSeconds(req.post_audio).toFixed(1)}s. `
        + 'The merged audio that exists is the truth; re-merge the audio to change the tail.',
      )
    }
  }

  const targetDuration = lengths.targetDurationSec
  job.output_lines.push(
    postRoll > 0
      ? `Video length: narration ${narrationDuration.toFixed(1)}s + ${postRoll.toFixed(1)}s tail = ${targetDuration.toFixed(1)}s`
      : `Video length follows narration: ${targetDuration.toFixed(1)}s`,
  )

  // 3. Create or recover the temp directory under os.tmpdir() (never
  // iCloud-synced). Compilation mode has no reusable scene-clip stage and
  // keeps the historical fresh-directory behavior.
  // so the multi-GB intermediate clips/concat-list/premixed-audio don't
  // trigger an iCloud upload while ffmpeg is mid-encode. The final
  // rename to `videoDir` or the external root happens after success
  // (see the EXDEV-aware copy fallback near the end of this function).
  const sceneEffectLibrary = req.video_layout === 'compilation' ? null : await listSceneEffectLibrary()
  const resolvedSceneAnimation = sceneEffectLibrary
    ? resolveVideoAssemblySceneAnimation(req, req.scenes.length)
    : null
  // 1.4.284 — living pictures and outlined effects are drawn per scene clip, so
  // they are read before the fingerprint: a changed outline re-renders its clip.
  // E2–E4 — each scene's saved analysis, read (never fetched) when the channel has it on.
  const sceneVision = sceneEffectLibrary
    ? await readSceneVisionForRender(project_slug, episodeDir, req.scenes, job)
    : null
  const sceneStage = sceneEffectLibrary
    ? await readSceneStageForRender(episodeDir, sceneEffectLibrary.overlays, job, {
        scenes: planCoverageScenes.map(scene => ({ scene_id: scene.id, theme: scene.theme })),
        projectLook: req.scene_effects?.enabled && Array.isArray(req.scene_effects.overlays) ? req.scene_effects.overlays : [],
        ...(sceneVision ? { found: (sceneId: string) => sceneVision.get(sceneId)?.regions } : {}),
      })
    : null
  // Reveal effects: one plan for the episode, resolved before the fingerprint so a changed reveal
  // re-renders and an unchanged one reuses its clips. Duration comes from the plan, which is why it
  // has to be resolved this early — the timeline reads the same numbers.
  const resolvedSceneReveals = sceneEffectLibrary
    ? resolveSceneReveals({
        scenes: req.scenes.map((scene, index) => ({
          scene_id: sceneIdForIndex(scene, index),
          scene_index: index,
          act_index: actIndexForScene(scene),
          window_seconds: resolveRevealWindowSeconds(scene, req.scene_recycling?.seconds_per_scene || 10),
          narration_seconds: narrationForScene(scene),
          snap: snapCandidatesForScene({
            scene,
            index,
            narration_line_ends: narrationLineEnds,
            // A beat is a cue boundary: where a bed starts or ends, or where a one-shot lands.
            beat_seconds: resolvedSoundDesignCues.flatMap(cue => (
              [cue.start_sec, cue.end_sec].filter((value): value is number => (
                typeof value === 'number' && Number.isFinite(value)))
            )),
            scene_start_seconds: sceneStartForIndex(req.scenes, index),
          }),
        })),
        settings: req.scene_reveal,
        library: sceneEffectLibrary.reveals,
      })
    : undefined
  const renderState = sceneEffectLibrary
    ? {
        request: renderFingerprintRequest,
        authoritative_scene_plan: authoritativeAssets.scene_plan_timing,
        canvas: { w, h },
        quality,
        narration_duration_sec: narrationDuration,
        target_duration_sec: targetDuration,
        can_drawtext: canDrawtext,
        ffmpeg_version: ffmpegCheck.version,
        // A saved clip made by one scene renderer must not be mixed with clips from the other on resume.
        scene_clip_renderer: (await probeNativeSceneClip()).available ? `native-v${NATIVE_SCENE_CLIP_VERSION}` : 'ffmpeg',
        resolved_sound_design_cues: resolvedSoundDesignCues,
        resolved_scene_effect_library: sceneEffectLibrary,
        resolved_scene_animation: resolvedSceneAnimation,
        resolved_scene_reveals: resolvedSceneReveals,
        content_pack_provenance: job.content_pack_provenance || [],
        // Absent unless a scene uses one, so every other render keeps its fingerprint.
        ...(sceneStage?.byScene.size ? { scene_stage: sceneStage.fingerprint } : {}),
        ...(sceneVision?.size ? { scene_vision: [...sceneVision.values()].map(v => [v.scene_id, v.key]) } : {}),
      }
    : null
  // Scene clips are reused only by the same app version. A final render that was already running is
  // finished with its own saved command after any restart or update, as long as the episode's inputs
  // and settings are unchanged (1.4.265): that check leaves the app version out.
  const renderFingerprint = renderState
    ? await buildVideoAssemblyRenderFingerprint({ ...renderState, app_version: await resolveStoryStudioVersion() })
    : null
  const inputsFingerprint = renderState ? await buildVideoAssemblyRenderFingerprint(renderState) : null
  const savedCheckpoint = renderFingerprint
    ? await getValidVideoAssemblyCheckpoint(job, ['running'])
    : null
  const matchingCheckpoint = savedCheckpoint?.render_fingerprint === renderFingerprint ? savedCheckpoint : null
  // Every attempt gets a FRESH temp dir: an encoder orphaned by a crash may
  // still be writing into the old one. Verified checkpoint clips move across.
  const tempDir = await getWorkTempDir(project_slug, code)
  // A final render already under way: its files and finished segments move first (moving the scene
  // clips drops the old folder). Order matters — every file the saved command reads, nested ones
  // included, is out of the old folder before it is disposed of. A stage whose dependencies cannot
  // all be moved comes back null and the episode renders from the start instead of resuming against
  // a missing input (Myth EP0012, 2026-10-20).
  const carriedFinalStage = savedCheckpoint?.final_stage && savedCheckpoint.final_stage.inputs === inputsFingerprint
    ? await moveCheckpointFinalStage(savedCheckpoint, tempDir)
    : null
  const carriedFinalSegments = carriedFinalStage
    ? await moveCheckpointFinalSegments(savedCheckpoint!, tempDir)
    : undefined
  const carriedSceneClips = matchingCheckpoint || savedCheckpoint?.final_stage
    ? await moveCheckpointSceneClips(matchingCheckpoint ?? { ...savedCheckpoint!, completed_scene_clips: [] }, tempDir)
    : []
  const videoAssemblyCheckpoint = renderFingerprint
    ? createVideoAssemblyCheckpoint(
        job,
        tempDir,
        renderFingerprint,
        carriedSceneClips,
        carriedFinalSegments,
      )
    : null
  if (videoAssemblyCheckpoint && carriedFinalStage) videoAssemblyCheckpoint.final_stage = carriedFinalStage
  // A private-fleet render finishes later on this same row, and its remote-wait receipt freezes
  // job.result, so the facts its finish tail needs are saved now, before either composition can stage it.
  job.result = {
    ...(job.result || {}),
    final_render_finish: {
      code, visual_source: authoritativeAssets.visual_source || 'scene_plan', image_pool: authoritativeAssets.image_pool ?? null,
      work_dir: tempDir,
    },
  }
  if (!videoAssemblyCheckpoint) await checkpointJobState(job)
  if (videoAssemblyCheckpoint) {
    setVideoAssemblyCheckpoint(job, videoAssemblyCheckpoint)
    await checkpointJobState(job)
    if (matchingCheckpoint) job.output_lines.push(`Recovery: validating ${carriedSceneClips.length} saved scene clip(s) (moved into a fresh work folder).`)
  }
  // Debug mode: when STORY_STUDIO_VIDEO_DEBUG is truthy, preserve the
  // temp dir on every run (success OR failure) so the user can replay a
  // single FFmpeg stage manually. Without it, the temp dir is preserved
  // only on failure, so post-mortem analysis of a broken intermediate
  // is still possible from a normal run.
  const debugMode = !!process.env.STORY_STUDIO_VIDEO_DEBUG && process.env.STORY_STUDIO_VIDEO_DEBUG !== '0'
  if (debugMode) {
    job.output_lines.push(`Debug mode ON — temp dir will be preserved: ${tempDir}`)
  }
  let succeeded = false
  let remoteHeld = false
  const finalSegmentation = (): FinalSegmentation | undefined => (videoAssemblyCheckpoint && inputsFingerprint ? {
    checkpoint: videoAssemblyCheckpoint,
    inputsFingerprint,
    persist: async () => {
      setVideoAssemblyCheckpoint(job, videoAssemblyCheckpoint)
      await checkpointJobProgress(job)
    },
  } : undefined)

  try {
    if (carriedFinalStage && videoAssemblyCheckpoint) {
      // The final render was already running: finish it with its own command. Everything before it
      // (scene clips, the timeline, the audio mix) is already in the saved work files.
      job.output_lines.push(`Recovery: the final render was under way; finishing it with its saved command`
        + ` (${carriedFinalSegments?.segments.length || 0} finished segment(s) moved into a fresh work folder).`)
      try {
        const outputFile = await resumeSavedFinalRender(job, carriedFinalStage, finalSegmentation()!, format)
        await finishFinalVideo({
          job, project_slug, code, titleHint: titleHint || '', videoDir, format, tempDir,
          outputFile, totalRenderDuration: carriedFinalStage.total_render_sec,
          visualSource: authoritativeAssets.visual_source || 'scene_plan', imagePool: authoritativeAssets.image_pool, loudness,
          narrationOffsetSec: carriedFinalStage.narration_offset_sec,
          // A resumed final render knows its own length and canvas but not what followed the tail;
          // the tail is still measured where it is, and nothing sits after it that this run knows of.
          // Old checkpoints did not record the narration's lead-in, so their speech end remains unknown.
          // Never infer it from the current request.
          expected: finalCheckExpectation(req, {
            plannedSec: carriedFinalStage.total_render_sec, tailSec: postRoll, bakedTailSec: mergedClosingTailSec, backgroundMusic: mergedBackgroundMusicRecord,
            tailFromEndSec: 0, width: w, height: h,
          }),
        })
        succeeded = true
        return
      } catch (e) {
        // Next time it renders from the start, the way it always did.
        delete videoAssemblyCheckpoint.final_stage
        delete videoAssemblyCheckpoint.final_segments
        throw e
      }
    }

    if (resolvedSoundDesignCues.length) {
      job.output_lines.push(`Sound Design: mixing ${resolvedSoundDesignCues.length} approved cue(s) into narration…`)
      const basePath = req.merged_audio_path!
      req.merged_audio_path = await mixSoundDesignIntoAudio({
        basePath,
        cues: resolvedSoundDesignCues,
        outPath: path.join(path.dirname(basePath), `${code}_sound_design_mixed.mp3`),
        ducking_profile: req.sound_design!.ducking_profile,
      })
      job.output_lines.push(`Sound Design: mixed ${resolvedSoundDesignCues.length} approved cue(s) → ${path.basename(req.merged_audio_path)}`)
    }

    const { w: resW, h: resH } = { w, h }

    job.output_lines.push(`Resolution: ${resW}x${resH} @ ${quality.fps}fps`)
    job.output_lines.push(`Quality: ${req.quality} (CRF ${quality.crf}, preset ${req.encoding_effort || quality.preset})`)
    if (req.codec && req.codec !== 'h264') job.output_lines.push(`Codec: ${req.codec.toUpperCase()}`)
    job.output_lines.push(`Scenes: ${req.scenes.length}`)

    // 4. Prepare narration audio
    let narrationFilePath: string
    const audioGap = req.audio_gap ?? 5

    if (useMergedAudio) {
      // Use pre-merged audio directly — skip chapter concatenation. 1.4.281: its levelled lossless master
      // when Audio Assembly kept one, so the final AAC is not encoded from an MP3.
      const master = await mergedAudioMaster(req.merged_audio_path!, code)
      narrationFilePath = master ?? req.merged_audio_path!
      job.output_lines.push(`Merged audio duration: ${narrationDuration!.toFixed(1)}s`
        + (master ? ` (mixed from its lossless master ${path.basename(master)})` : ''))
    } else if (hasChapters && audioGap > 0) {
      narrationFilePath = await prepareNarrationWithGaps(narrationChapters, audioGap, tempDir, job)
      // Re-measure duration after adding gaps
      const newDur = await getAudioDuration(narrationFilePath)
      if (newDur) {
        narrationDuration = newDur
        job.output_lines.push(`Narration with gaps: ${narrationDuration.toFixed(1)}s (${narrationChapters.length} chapters, ${audioGap}s gaps)`)
      }
    } else if (hasChapters) {
      // Multiple chapters but no gap — just concatenate
      narrationFilePath = await prepareNarrationWithGaps(narrationChapters, 0, tempDir, job)
      const newDur = await getAudioDuration(narrationFilePath)
      if (newDur) narrationDuration = newDur
    } else {
      narrationFilePath = req.narration_path
    }

    // 1.4.281 — the sound is levelled and its encoded peak checked FIRST, before any picture work (owner,
    // 2026-10-11): a level the mix cannot reach stops the job in minutes, not after an hour of scene
    // clips. The pre-mix before the final render starts from the level settled here, and uses this very
    // file when its length and start are the same. A final render resumed above has its own saved audio.
    let musicFilePath: string | undefined
    if (req.music?.enabled && req.music.files.length > 0) {
      musicFilePath = await prepareMusicTrack(req.music, tempDir, job)
    }
    let settledPlan: LevelPlan | null = null
    const earlyAudioDir = path.join(tempDir, 'loudness_first')
    await fs.mkdir(earlyAudioDir, { recursive: true })
    const earlyPremix = {
      duration_sec: targetDuration,
      path: await premixAudio({
        narrationPath: narrationFilePath,
        narrationDuration: narrationDuration!,
        narrationVolume: req.narration_volume ?? 1.0,
        musicFilePath, musicConfig: req.music,
        backgroundNoise: req.background_noise,
        targetDuration, tempDir: earlyAudioDir, job, loudness, format,
        settled: plan => { settledPlan = plan },
      }),
    }

    // ── Compilation video layout (Path C / v1.0.63+) ─────────────────────
    // When the request opts into compilation mode, the standard scene-
    // clip pipeline below is bypassed entirely. Instead we render a
    // looping background plate as the base video and convert the per-
    // scene image list into chapter-aligned foreground overlays. The
    // final composition + rename + cleanup steps are duplicated inline
    // here so the standard flow stays byte-identical for sleep-story
    // projects (regression-safe).
    if (req.video_layout === 'compilation') {
      // Validation up front so we fail fast with a clear message.
      if (!req.background_plate?.source_path) {
        throw new Error(
          'Compilation video_layout requires a background_plate.source_path. ' +
          'Pick a looping background video (e.g. starfield) in Video Assembly settings.',
        )
      }
      if (!existsSync(req.background_plate.source_path)) {
        throw new Error(`Background plate file not found: ${req.background_plate.source_path}`)
      }
      if (!Array.isArray(req.chapter_durations) || req.chapter_durations.length === 0) {
        throw new Error(
          'Compilation mode requires chapter_durations from audio_chapters.json — ' +
          'run Audio Merge first to generate the per-chapter duration sidecar.',
        )
      }
      const totalRenderDuration = narrationDuration!
      job.output_lines.push(
        `Compilation mode ON · ${req.scenes.length} scene(s), ${req.chapter_durations.length} chapter(s), ${totalRenderDuration.toFixed(1)}s total`,
      )

      // 1. Build the looped background as the intermediate video.
      const intermediateVideoPath = await prepareCompilationBackground(
        req.background_plate, resW, resH, quality, tempDir, totalRenderDuration, job,
      )

      // 2. Auto-generate one foreground overlay per chapter, merge with
      //    any user-provided decorative overlays (fireflies, frames…).
      const fgDefaults: ForegroundDefaults = req.foreground_defaults || {
        scale_pct: 0.5,
        position: 'center',
        chroma_key: { color: '#FFFFFF', similarity: 0.15, blend: 0.10 },
      }
      const audioGap = req.audio_gap ?? 0
      const autoOverlays = buildCompilationOverlays(
        req.scenes, req.chapter_durations, fgDefaults, audioGap, job,
      )
      const userOverlays = (req.overlays?.layers || [])
      req.overlays = {
        enabled: true,
        layers: [...autoOverlays, ...userOverlays],
      }

      // 3. Premix audio (same helper the standard pipeline uses), from the level settled at the start.
      const premixedAudioPath = totalRenderDuration === earlyPremix.duration_sec ? earlyPremix.path : await premixAudio({
        narrationPath: narrationFilePath,
        narrationDuration: narrationDuration!,
        narrationVolume: req.narration_volume ?? 1.0,
        musicFilePath, musicConfig: req.music,
        backgroundNoise: req.background_noise,
        targetDuration: totalRenderDuration, tempDir, job, loudness, format, plan: settledPlan,
      })

      // 4. Final composition + rename, mirroring the standard flow's
      //    structure so the Promote-to-final + cache-invalidate paths
      //    stay identical.
      const compTimestamp = Date.now()
      const compOutputFile = path.join(tempDir, `${code}_video_${compTimestamp}.${format}`)
      // Compilation mode draws no closing tail and has no outro segment (v1), so the plan is the
      // narration and nothing sits after it — the speech runs to the file's own end.
      const compExpected = finalCheckExpectation(req, {
        plannedSec: totalRenderDuration, tailSec: 0, bakedTailSec: 0, backgroundMusic: null, tailFromEndSec: 0, width: resW, height: resH,
        speechEndSec: totalRenderDuration,
      })
      let compEncodeOk = false
      try {
        const compositionResult = await runFinalComposition({
          videoInputPath: intermediateVideoPath, premixedAudioPath,
          logo: req.logo,
          targetDuration: totalRenderDuration, w: resW, h: resH, quality, format,
          outputFile: compOutputFile,
          colorGrading: req.color_grading,
          vignette: req.vignette,
          chromaKey: req.chroma_key,
          overlays: req.overlays,
          filmGrain: req.film_grain,
          agedArchiveFilm: req.aged_archive_film,
          letterbox: req.letterbox,
          frame: req.frame,
          subtitles: req.subtitles,
          contextualCues: req.contextual_cues,
          sceneEffects: req.scene_effects,
          // Compilation has no intro/title/outro segments in v1, so the
          // intro-exclusion gate is a no-op. Effects play through the
          // entire bg-plate duration.
          excludeIntroFromEffects: false,
          preSceneDuration: 0,
          // Compilation lays its chapter overlays out from t=0 against the same
          // audio the cues were reviewed against, and prepends nothing — so the
          // scene clock and the composed clock are already the same clock.
          sceneTimelineOffsetSec: 0,
          postAudioStart: undefined,
          encodingEffort: req.encoding_effort,
          codec: req.codec,
          videoBitrateKbps: req.video_bitrate_kbps,
          code,
          titleHint,
          videoDir,
          resolvedLoudness: {
            lufs: loudness.lufs, true_peak_db: loudness.true_peak_db,
            tolerance_pct: loudness.tolerance_pct!, check: loudness.check!,
          },
          finalCheckExpected: compExpected,
          narrationOffsetSec: 0,
          job,
        })
        if (compositionResult?.kind === 'video-assembly-remote-wait') {
          remoteHeld = true
          return compositionResult
        }
        compEncodeOk = true
      } finally {
        if (!compEncodeOk && !remoteHeld) {
          try {
            await fs.rm(compOutputFile, { force: true })
            job.output_lines.push(`Removed partial output: ${path.basename(compOutputFile)}`)
          } catch { /* best-effort */ }
        }
      }

      // Promote to final name — same external-root vs project-tree
      // logic the standard flow uses below.
      const compFinalName = `${code}_final_video.${format}`
      const compProjectTreeFinalPath = path.join(videoDir, compFinalName)
      let compFinalPath = compProjectTreeFinalPath
      try {
        const { ensureExternalFinalVideoDir } = await import('../services/external-video-store.js')
        const externalDir = await ensureExternalFinalVideoDir(project_slug, code, titleHint || '')
        if (externalDir) {
          compFinalPath = path.join(externalDir, compFinalName)
          job.output_lines.push(`External final-video root configured → ${compFinalPath}`)
        }
      } catch (e: any) {
        job.output_lines.push(`External path resolve failed (${e?.message || e}); using project tree`)
      }
      // Same rule as the standard flow: the new render passes its checks before the previous final
      // moves aside, and a failed render leaves that final in place (owner, 2026-10-27).
      const compReplacement = await publishOverPreviousFinal({
        job,
        project_slug,
        projectDir: pm.getProjectDir(project_slug) || '',
        code,
        finalPath: compFinalPath,
        newRenderPath: compOutputFile,
        finalName: compFinalName,
        verify: staged => verifyFinalVideo(job, staged, compFinalName, totalRenderDuration, loudness, true),
        publish: async () => {
          let landed = compOutputFile
          try {
            await publishLocalFinalVideo(job, compOutputFile, compFinalPath, () => fs.rename(compOutputFile, compFinalPath))
            landed = compFinalPath
            job.output_lines.push(`Renamed to: ${compFinalName}`)
          } catch (e: any) {
            if (e?.name === 'FinalRenderFallbackConflict') throw e
            if (e?.code === 'EXDEV' && compFinalPath !== compProjectTreeFinalPath) {
              try {
                await publishLocalFinalVideo(job, compOutputFile, compFinalPath, async () => {
                  await fs.copyFile(compOutputFile, compFinalPath)
                  await fs.rm(compOutputFile, { force: true })
                })
                landed = compFinalPath
                job.output_lines.push(`Copied to external (cross-device): ${compFinalName}`)
              } catch (copyErr: any) {
                if (copyErr?.name === 'FinalRenderFallbackConflict') throw copyErr
                job.output_lines.push(`Warning: external copy failed (${copyErr.message || copyErr}); falling back to project tree`)
                try {
                  await publishLocalFinalVideo(job, compOutputFile, compProjectTreeFinalPath, () => fs.rename(compOutputFile, compProjectTreeFinalPath))
                  landed = compProjectTreeFinalPath
                  job.output_lines.push(`Renamed to: ${compFinalName} (project tree fallback)`)
                } catch (fallbackErr: any) {
                  if (fallbackErr?.name === 'FinalRenderFallbackConflict') throw fallbackErr
                  job.output_lines.push(`Warning: final rename skipped (${fallbackErr.message || 'unknown'})`)
                }
              }
            } else {
              job.output_lines.push(`Warning: final rename skipped (${e.message || 'unknown error'})`)
            }
          }
          return landed
        },
      })

      let compResolvedPath = compReplacement.resolved
      if (!compReplacement.restored) {
        compResolvedPath = await selfHealFinalPromotion(compResolvedPath, compProjectTreeFinalPath, compFinalName, job)
      }
      await finalCheckFinalVideo(job, compResolvedPath, compExpected)
      if (!compReplacement.previousExisted) {
        await verifyFinalVideo(job, compResolvedPath, compFinalName, totalRenderDuration, loudness)
      }
      await finishImportedFinalVideo(
        job, code, compResolvedPath, authoritativeAssets.visual_source || 'scene_plan', authoritativeAssets.image_pool, 0,
      )

      succeeded = true
      return  // skip the standard scene-clip pipeline below
    }

    // 6. Prepare scene clips.
    // v1.0.81+: when the project's format opts into sentence alignment
    // AND audio_sentences.json exists, compute per-scene durations from
    // sentence-level timing instead of using the uniform recycling
    // default. This is what gives reasons-explainer pacing — each
    // scene stays on screen exactly as long as its assigned sentences.
    // The block is fully optional and best-effort: any failure falls
    // back to uniform per-scene durations and logs why.
    let sentenceDurations: number[] | undefined
    try {
      const { getEffectiveFormat } = await import('../services/format-loader.js')
      const fmt = await getEffectiveFormat(project_slug)
      if (fmt.imagePrompts.alignment === 'sentence') {
        const sentencesPath = path.join(episodeDir, 'audio_sentences.json')
        const raw = sentenceSidecar ? 'read-once' : await fs.readFile(sentencesPath, 'utf-8').catch(() => null)
        if (raw) {
          const { parseSentenceSidecar, assignScenesToSentences } = await import('../lib/sentence-timing.js')
          const parsed = sentenceSidecar ?? parseSentenceSidecar(JSON.parse(raw as string))
          if (parsed && parsed.sections.length > 0) {
            const fallback = req.scene_recycling?.seconds_per_scene || 4
            const result = assignScenesToSentences(
              req.scenes.map(s => ({ chapter_slug: s.chapter_slug })),
              parsed,
              fallback,
            )
            sentenceDurations = result.perSceneDurations
            const totalSec = sentenceDurations.reduce((a, b) => a + b, 0)
            job.output_lines.push(
              `Sentence alignment: ON — ${result.assignments.length} scene(s) mapped to ` +
              `${parsed.sections.reduce((s, sec) => s + sec.sentences.length, 0)} sentence(s); ` +
              `target scene-track duration ${totalSec.toFixed(1)}s`,
            )
          } else {
            job.output_lines.push(`Sentence alignment: format opts in but audio_sentences.json is empty/invalid — falling back to uniform per-scene duration.`)
          }
        } else {
          job.output_lines.push(`Sentence alignment: format opts in but audio_sentences.json missing — re-run Audio Merge to emit it. Falling back to uniform per-scene duration.`)
        }
      }
    } catch (e: any) {
      job.output_lines.push(`Note: sentence-alignment check skipped (${e?.message || 'lookup error'})`)
    }

    const defaultSceneDuration = req.scene_recycling?.seconds_per_scene || 10
    // v1.0.415+ — optional "B-roll plays its full natural length" mode. When on,
    // a VIDEO scene uses its own probed duration instead of the uniform
    // per-scene length; still images are unaffected (no natural length). A probe
    // failure falls back to the normal cascade so a bad clip never zeroes out.
    const brollNaturalDuration = !!req.scene_recycling?.broll_natural_duration
    const isVideoScenePath = (p?: string) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(p || '')
    let naturalBrollCount = 0
    let sceneClipDurations = authoritativeAssets.visual_source === 'image_pool'
      ? []
      : await Promise.all(req.scenes.map(async (scene, i) => {
      if (brollNaturalDuration && isVideoScenePath(scene.image_path)) {
        const natural = await getAudioDuration(scene.image_path).catch(() => undefined)
        if (typeof natural === 'number' && Number.isFinite(natural) && natural > 0) {
          naturalBrollCount++
          return Math.max(MIN_RENDERABLE_SCENE_SEC, natural)
        }
        // probe failed → fall through to the uniform cascade below
      }
      const hasScenePlanDuration = !!(scene as any).__scene_plan_duration
      const sceneOverride = sentenceDurations?.[i]
      const explicitSceneDuration = scene?.duration
      const durationCandidate = hasScenePlanDuration && typeof explicitSceneDuration === 'number' && Number.isFinite(explicitSceneDuration) && explicitSceneDuration > 0
        ? explicitSceneDuration
        : (typeof sceneOverride === 'number' && Number.isFinite(sceneOverride) && sceneOverride > 0)
        ? sceneOverride
        : (typeof explicitSceneDuration === 'number' && Number.isFinite(explicitSceneDuration) && explicitSceneDuration > 0)
            ? explicitSceneDuration
            : defaultSceneDuration
      return Math.max(MIN_RENDERABLE_SCENE_SEC, durationCandidate)
      }))
    if (brollNaturalDuration) {
      job.output_lines.push(
        `B-roll natural length: ON — ${naturalBrollCount} video scene(s) play their full clip duration; ` +
        `still images keep the ${defaultSceneDuration}s per-scene length.`,
      )
    }

    // ── Reveal effects: the plan's durations are the timeline's durations ──────
    // A reveal plus a hold is what lets one image carry a whole narration window, so the pace plan
    // — not the uniform recycling default — decides how long a revealed scene stays. The plan was
    // resolved before the fingerprint, from the same window cascade this timeline uses, so the two
    // cannot disagree. A scene the plan could not cover keeps its own duration.
    if (resolvedSceneReveals?.enabled) {
      let revealed = 0
      for (const scene of resolvedSceneReveals.scenes) {
        if (scene.scene_index < 0 || scene.scene_index >= sceneClipDurations.length) continue
        const planned = Math.max(MIN_RENDERABLE_SCENE_SEC, scene.hold.total_seconds)
        if (Math.abs(planned - sceneClipDurations[scene.scene_index]!) > 0.01) revealed++
        sceneClipDurations[scene.scene_index] = planned
      }
      const total = sceneClipDurations.reduce((sum, value) => sum + value, 0)
      job.output_lines.push(
        `Reveal effects: ON — pace ${resolvedSceneReveals.pace}, coherence `
        + `${resolvedSceneReveals.coherence}, seed ${resolvedSceneReveals.seed}, `
        + `${resolvedSceneReveals.scenes.length} scene(s) planned`
        + (revealed ? `, ${revealed} duration(s) set by the plan` : '')
        + (() => {
          const snapped = resolvedSceneReveals.scenes.filter(scene => scene.hold.snapped_to !== 'window')
          if (!snapped.length) return ''
          const kinds = new Set(snapped.map(scene => scene.hold.snapped_to))
          return `, ${snapped.length} hold(s) snapped to ${[...kinds].join(' / ')}`
        })()
        + `; scene track ${total.toFixed(1)}s`,
      )
    }

    // ── Audio-coverage gate (v1.0.522, plan-strict only) ──────────────────
    // "Every second of narration must have a scene." Route >2s of uncovered
    // narration through channel policy; Warn/Off holds the final scene instead
    // of leaving the post-audio tail black. The HEAD gap is exempt when intro-ish
    // content covers it (intro clip, title card, before/after-intro timeline
    // clips, or the sleep-story intro-skip hold). A ≤2s remainder is absorbed
    // into the last scene's window so the body meets the narration end.
    if (planStrict && planCoverageScenes?.length && typeof narrationDuration === 'number' && narrationDuration > 0) {
      const headCovered = hasAvailablePlanOpening(req)
      const coverageIntegrity = inspectScenePlanCoverage({
        scenes: planCoverageScenes,
        total_duration_sec: narrationDuration,
      }, { headCovered })
      const cov = coverageIntegrity.coverage!
      const gatedUncovered = coverageIntegrity.blockingUncoveredSec
      await absorbUncoveredNarration(
        project_slug,
        job,
        sceneClipDurations,
        gatedUncovered,
        `Narration has ${gatedUncovered.toFixed(1)}s with NO planned scene ` +
          `(before scene 1: ${cov.headGapSec.toFixed(1)}s${headCovered ? ' — covered by intro/title' : ''} · ` +
          `${cov.internalGaps.length} gap(s) between scenes: ${cov.internalGapTotalSec.toFixed(1)}s · ` +
          `after the last scene: ${cov.tailGapSec.toFixed(1)}s; audio ${narrationDuration.toFixed(1)}s). ` +
          `The final scene will hold across the uncovered narration.`,
      )
    }

    // v1.0.521 — plan-strict xfade tail. In plan mode with a crossfade
    // transition, each clip renders (window + T) long so dissolves can anchor
    // at plan boundaries without eating scene time. T is clamped against the
    // SHORTEST plan window (the unified Scene Plan timing rule at
    // the plan's shortest window; seconds_per_scene never controls the plan.
    let planTransitionTail = 0
    // (>= 2 scenes AFTER exclusions: a single-clip body never xfades, and the
    // non-xfade concat path uses the clip verbatim — a baked tail there would
    // overrun the window.)
    const planExcluded = exactSceneTiming ? new Set<number>() : new Set(req.scene_recycling?.excluded_scenes || [])
    const planEffectiveScenes = req.scenes.filter((_, i) => !planExcluded.has(i + 1)).length
    if (exactSceneTiming && sceneClipDurations.length > 0 && planEffectiveScenes >= 2 && req.transition && req.transition !== 'none' && getTransition(req.transition)?.xfade) {
      const minWindow = Math.min(...sceneClipDurations)
      planTransitionTail = Math.min(
        Math.max(0.1, req.transition_duration || 1.5),
        Math.max(0.1, minWindow - 0.1),
      )
    }

    let sceneClips: string[] = []
    if (authoritativeAssets.visual_source !== 'image_pool') {
      sceneClips = await prepareSceneClips(
        req.scenes, resolvedSceneAnimation!.settings, req.chapter_titles, resW, resH, quality, tempDir, canDrawtext, req.scene_recycling, job,
        {
          pool: resolvedSceneAnimation!.pool,
          randomizeMode: resolvedSceneAnimation!.randomize_mode,
          seed: resolvedSceneAnimation!.seed,
          picks: resolvedSceneAnimation!.picks,
          ...(resolvedSceneReveals?.enabled ? { reveals: resolvedSceneReveals } : {}),
          crf: quality.crf,
          upscaleSharpen: req.upscale_sharpen,
          // The xfade stage (planTransitionTail > 0) decodes and re-encodes every clip, which is what
          // makes a VideoToolbox clip safe to use; with hard cuts the clips are stream-copied.
          native: { enabled: planTransitionTail > 0 },
          ...(sceneStage?.byScene.size ? { sceneStage: { byScene: sceneStage.byScene, episodeDir } } : {}),
          ...(sceneVision ? { vision: sceneVision } : {}),
        },
        sceneClipDurations,
        exactSceneTiming ? planTransitionTail : 0,
        sceneEffectLibrary!.scene_motions,
        videoAssemblyCheckpoint && renderFingerprint
          ? { checkpoint: videoAssemblyCheckpoint, renderFingerprint }
          : undefined,
      )
    }

    const storyStartSec = planOpeningReservedSec
    // Whether captions should sit out the opening is decided by whether there
    // IS an opening — a fact the plan already carries — not by a project flag
    // someone set once. An explicit choice from the customer still wins.
    if (req.subtitles && req.subtitles.hide_during_intro == null) {
      req.subtitles.hide_during_intro = planOpeningReservedSec > 0
    }
    if (planStrict && planOpeningReservedSec > 0) {
      const headEnabled = !!(
        req.intro?.enabled && req.intro.video_path
        || req.title_image?.enabled && req.title_image.image_path
        || req.title_card?.enabled && req.title_card.text?.trim()
        || (req.timeline_clips || []).some(c => c.enabled && (c.anchor === 'before_intro' || c.anchor === 'after_intro'))
      )
      if (!headEnabled) {
        await safetyGate(project_slug, 'opening_outro', job, `Scene Plan reserves a ${planOpeningReservedSec.toFixed(1)}s branded opening, but no opening clip is enabled. Scene 1 will hold across that opening window.`)
      }
      if (planOpeningMeasured) {
        // Nothing to repair. The reserve was probed from these very clips, so
        // playing them at their own length lands the first scene exactly where
        // the plan timed it. Stretching the intro to fill the reserve here
        // would double-count a title card that is already inside the number,
        // and dropping the title card would make the opening too short.
        job.output_lines.push(
          `Opening sync: Scene Plan reserved the measured ${planOpeningReservedSec.toFixed(2)}s opening — `
          + 'playing your opening clips at their own length.',
        )
      } else {
        if (!req.intro?.enabled || !req.intro.video_path) {
          await safetyGate(project_slug, 'opening_outro', job, `Scene Plan reserves a ${planOpeningReservedSec.toFixed(1)}s branded opening, but no intro video is enabled. Scene 1 will hold across that opening window.`)
        } else {
          req.intro.duration = planOpeningReservedSec
        }
        if (req.title_image?.enabled) {
          req.title_image.enabled = false
          job.output_lines.push('Title card skipped: the branded opening already owns the full reserved opening window.')
        }
        if (req.title_card?.enabled) {
          req.title_card.enabled = false
          job.output_lines.push('Text title card skipped: the branded opening already owns the full reserved opening window.')
        }
        job.output_lines.push(`Opening sync: intro clip will be trimmed/padded to exactly ${planOpeningReservedSec.toFixed(1)}s, matching Scene Plan.`)
      }
    }

    // Optional: drop intro captions from the BURN copy (welcome / CTA / breathing).
    // The full SRT sidecar (YouTube upload) is left untouched — we burn a trimmed
    // copy that keeps each story cue at its original (audio-aligned) timestamp and
    // simply omits everything before the story start.
    if (req.subtitles?.enabled && req.subtitles.hide_during_intro && storyStartSec > 0
        && req.subtitles.srt_path && existsSync(req.subtitles.srt_path)) {
      try {
        const { parseSrt, formatSrtTime, trimCuesBeforeStoryStart } = await import('../lib/subtitle-builder.js')
        const cues = parseSrt(await fs.readFile(req.subtitles.srt_path, 'utf-8'))
        // v1.4.0 — the same trim the caption preflight frames are drawn from, so
        // the three stills a person approves cannot describe a different cue set
        // from the one that is burned.
        const kept = trimCuesBeforeStoryStart(cues, storyStartSec)
        if (kept.length && kept.length < cues.length) {
          const body = kept
            .map((c, i) => `${i + 1}\n${formatSrtTime(c.start_sec)} --> ${formatSrtTime(c.end_sec)}\n${c.text}`)
            .join('\n\n') + '\n'
          const trimmedPath = path.join(tempDir, 'subtitles_story_only.srt')
          await fs.writeFile(trimmedPath, body, 'utf-8')
          job.output_lines.push(`Intro captions: hidden — burning ${kept.length}/${cues.length} cue(s) (dropped ${cues.length - kept.length} before ${storyStartSec.toFixed(1)}s). Full SRT sidecar unchanged.`)
          req.subtitles = { ...req.subtitles, srt_path: trimmedPath }
        }
      } catch (e: any) {
        job.output_lines.push(`Intro captions: could not trim (${e?.message || e}) — burning the full SRT.`)
      }
    }

    // Do the scene images fit the frame he asked for? Letterboxing a set of
    // 16:9 stills into a 9:16 canvas is not an error, but finding out about it
    // by watching the finished Short is the expensive way. Said here, before
    // any encode, and never fatal — see `lib/source-aspect.ts`.
    try {
      const shapes = await inspectSourceAspect(
        (req.scenes || []).map(s => s.image_path).filter(Boolean),
        w, h,
      )
      if (shapes.message) job.output_lines.push(`⚠ ${shapes.message}`)
    } catch { /* a shape check must never be the thing that fails a render */ }

    // ── Caption preflight frames, for an UNATTENDED render (v1.4.0) ────────
    //
    // The single-episode page produces these before the render and waits for a
    // person to look at them. A batch has nobody watching, and stopping one for
    // a click would defeat the point of running it — so here the frames are
    // produced and saved beside the finished video, where they can be checked
    // afterwards without scrubbing through the whole thing.
    //
    // Never fatal. A batch that rendered perfectly must not be failed because a
    // convenience still could not be drawn; the failure is logged and the encode
    // carries on.
    if (req.subtitles?.enabled && req.subtitles.srt_path && existsSync(req.subtitles.srt_path)) {
      try {
        const { parseSrt } = await import('../lib/subtitle-builder.js')
        const { normalizeSubtitleStyle } = await import('../contracts/subtitle-style.js')
        const { renderSubtitlePreflightFrames } = await import('../lib/subtitle-preflight-frames.js')
        // `srt_path` is already the trimmed burn copy when the intro is hidden,
        // so these are exactly the cues about to be burned.
        const preflight = await renderSubtitlePreflightFrames({
          episodeCode: code,
          outDir: videoDir,
          cues: parseSrt(await fs.readFile(req.subtitles.srt_path, 'utf-8')),
          subtitleFilename: path.basename(req.subtitles.srt_path),
          style: normalizeSubtitleStyle(req.subtitles.style),
          width: w,
          height: h,
          scenes: (req.scenes || []).map(s => ({ image_path: s.image_path, duration: Number(s.duration) || 0 })),
          openingOffsetSec: planOpeningReservedSec,
          durationSec: narrationDuration || 0,
        })
        if (preflight.frames.length) {
          job.output_lines.push(
            `Caption preflight: wrote ${preflight.frames.length} frame(s) beside the video `
            + `(${preflight.frames.map(f => f.filename).join(', ')}) in ${(preflight.elapsed_ms / 1000).toFixed(1)}s.`,
          )
        }
      } catch (e: any) {
        job.output_lines.push(`Caption preflight frames could not be produced (${e?.message || e}) — the render continues.`)
      }
    }

    // 6. Prepare title image clip (if provided)
    let titleClipPath: string | undefined
    let titleImagePath = req.title_image?.image_path
    if (req.title_image?.enabled && !titleImagePath && authoritativeAssets.thumbnails.length > 0) {
      titleImagePath = authoritativeAssets.thumbnails[0]!.path
      job.output_lines.push(`Title image / cover frame auto-resolved to episode thumbnail: ${path.basename(titleImagePath)}`)
    }
    if (req.title_image?.enabled && titleImagePath) {
      const avail = checkAssetAvailability(titleImagePath, 'title_image.image_path')
      if (avail.status === 'available') {
        titleClipPath = await prepareTitleClip({ ...req.title_image, image_path: titleImagePath }, resW, resH, quality, tempDir, job)
      } else {
        // Stale image_path from a preset saved in a different episode is a
        // common way to hit 'missing'. 'placeholder' means the file is
        // waiting for iCloud to download it — the message explains how.
        job.output_lines.push(`${avail.message} — title step skipped`)
      }
    }
    if (req.title_card?.enabled && req.title_card.text?.trim()) {
      if (!canDrawtext) {
        job.output_lines.push('Text title card skipped: this FFmpeg build has no drawtext filter.')
      } else {
        if (titleClipPath) job.output_lines.push('Text title card replaces the separate title image clip for this render.')
        titleClipPath = await prepareTextCardClip(req.title_card, 'title', resW, resH, quality, tempDir, job)
      }
    }

    // 7. Prepare intro video (if provided)
    let introClipPath: string | undefined
    if (req.intro?.enabled && req.intro.video_path) {
      const avail = checkAssetAvailability(req.intro.video_path, 'intro.video_path')
      if (avail.status === 'available') {
        introClipPath = await prepareIntroClip(req.intro, resW, resH, quality, tempDir, job)
      } else {
        job.output_lines.push(`${avail.message} — intro step skipped`)
      }
    }

    // 7b. Prepare outro video (if provided). Outro is purely cosmetic tail
    // content and lives at the very end of the concat list, AFTER the
    // post-audio segment. Never receives effects — the final composition
    // gate clears at `sceneEndTime` which is before the outro starts.
    let outroClipPath: string | undefined
    if (req.outro?.enabled && req.outro.video_path) {
      const avail = checkAssetAvailability(req.outro.video_path, 'outro.video_path')
      if (avail.status === 'available') {
        outroClipPath = await prepareOutroClip(req.outro, resW, resH, quality, tempDir, job)
      } else {
        job.output_lines.push(`${avail.message} — outro step skipped`)
      }
    }

    // 7c. Prepare user-supplied timeline clips. Each clip is normalised to
    // the output frame (same as intro/outro) and bucketed by anchor so
    // `buildConcatList` can emit the right set at each insertion point.
    // Failures are isolated per-clip: a missing file warns + skips that row
    // rather than aborting the job — consistent with intro/outro handling.
    const timelineClipsByAnchor: Record<TimelineAnchor, Array<{ path: string; duration: number; still?: boolean }>> = {
      before_intro: [],
      after_intro: [],
      after_scenes: [],
      after_outro: [],
    }
    if (req.timeline_clips?.length) {
      let idx = 0
      for (const clip of req.timeline_clips) {
        if (!clip.enabled) { idx++; continue }
        // Discriminate: static = image+duration; video (default) = video_path.
        // Old presets that predate the variant don't carry `kind` — treat
        // missing kind as 'video' for back-compat.
        const isStatic = clip.kind === 'static'
        const sourcePath = isStatic ? clip.image_path : clip.video_path
        const fieldName = isStatic ? `timeline_clips[${idx}].image_path` : `timeline_clips[${idx}].video_path`
        if (!sourcePath) { idx++; continue }
        const avail = checkAssetAvailability(sourcePath, fieldName)
        if (avail.status !== 'available') {
          job.output_lines.push(`${avail.message} — timeline clip [${clip.anchor}] skipped`)
          idx++
          continue
        }
        if (isStatic && (!Number.isFinite(clip.duration_sec) || clip.duration_sec <= 0)) {
          job.output_lines.push(`⚠ Static timeline clip [${clip.anchor}] has invalid duration_sec=${clip.duration_sec} — skipped`)
          idx++
          continue
        }
        try {
          const preparedPath = await prepareTimelineClip(clip, idx, resW, resH, quality, tempDir, job)
          const dur = (await getAudioDuration(preparedPath)) || 0
          timelineClipsByAnchor[clip.anchor].push({ path: preparedPath, duration: dur, ...(isStatic ? { still: true } : {}) })
        } catch (e: any) {
          await safetyGate(project_slug, 'opening_outro', job, `Timeline clip ${idx + 1} (${clip.anchor}) could not be prepared: ${e.message}. Rendering without that clip.`)
        }
        idx++
      }
    }
    if (req.outro_card?.enabled && req.outro_card.text?.trim()) {
      if (!canDrawtext) {
        job.output_lines.push('Text outro card skipped: this FFmpeg build has no drawtext filter.')
      } else {
        const cardPath = await prepareTextCardClip(req.outro_card, 'outro', resW, resH, quality, tempDir, job)
        const duration = (await getAudioDuration(cardPath)) || req.outro_card.duration || 4
        timelineClipsByAnchor.after_outro.push({ path: cardPath, duration })
      }
    }
    // Image Pool intervals begin after any measured opening clips. The merged
    // narration remains the clock, so the frozen cyclic body covers only the
    // narration seconds still available after before/intro/title/after-intro
    // content. This keeps the final interval partial at the true boundary.
    const preSceneDuration = await measureOpeningSec({
      before_intro: timelineClipsByAnchor.before_intro.map(c => ({ duration_sec: c.duration })),
      intro: introClipPath ? { path: introClipPath, fallback_sec: 5, label: 'intro' } : null,
      title: titleClipPath ? { path: titleClipPath, fallback_sec: 5, label: 'title' } : null,
      after_intro: timelineClipsByAnchor.after_intro.map(c => ({ duration_sec: c.duration })),
    }, getAudioDuration)
    if (authoritativeAssets.visual_source === 'image_pool') {
      const bodyDuration = Math.max(0, narrationDuration - preSceneDuration)
      if (bodyDuration <= 0) {
        await safetyGate(project_slug, 'image_pool_covers', job, 'The configured opening is as long as the narration, so Image Pool has no scene time left.')
        throw new Error('Video Assembly cannot continue: the opening leaves no usable Image Pool scene interval.')
      }
      const imagePool = await resolveImagePoolSelection(project_slug, code, bodyDuration)
      // **The pace decides how long one still stays, so it decides how many stills are needed.**
      // The pool's own `seconds_per_image` is the window a still gets with reveals off; with them
      // on, the pace's band says how long that image *wants* to stay — and a longer stay means fewer
      // images cover the same narration, which is the saving this feature exists for. Asked before
      // the play order is built, because the order is what fixes the count.
      const secondsPerImage = revealSecondsForImage(
        req.scene_reveal,
        imagePool.seconds_per_image,
        sceneEffectLibrary?.reveals,
      )
      const playOrder = buildImagePoolPlayOrder({ ...imagePool, seconds_per_image: secondsPerImage }, bodyDuration)
      req.scenes = playOrder.map((item, index) => ({
        image_path: item.path,
        duration: item.duration,
        scene_number: index + 1,
        title: `Image ${index + 1}`,
        show_title: false,
        clip_shortfall_mode: 'hold',
      }))
      job.output_lines.push(
        `Image Pool body: ${playOrder.length} frozen interval(s) cover ${bodyDuration.toFixed(2)}s after a measured ${preSceneDuration.toFixed(2)}s opening.`
        + (req.scene_reveal?.enabled && Math.abs(secondsPerImage - imagePool.seconds_per_image) > 0.01
          ? ` Reveal pace ${req.scene_reveal.pace ?? 'standard'} holds each image ${secondsPerImage.toFixed(2)}s `
            + `instead of ${imagePool.seconds_per_image}s — ${playOrder.length} image(s) instead of `
            + `${Math.ceil(bodyDuration / imagePool.seconds_per_image)}.`
          : ''),
      )
      sceneClipDurations = req.scenes.map(scene => Math.max(1 / quality.fps, Number(scene.duration) || secondsPerImage))

      // The plan for THESE scenes. The one resolved earlier was built from the pool scenes the
      // asset scan produced — before the opening was measured — so its windows can differ by a
      // frame or two; re-resolving here is what makes the plan, the durations and the clips the
      // same statement. Its fingerprint contribution is folded in below, because the plan is what
      // the clips were rendered from and a checkpoint that ignored it could reuse the wrong ones.
      let poolReveals: ResolvedSceneReveals | undefined
      let poolFingerprint = renderFingerprint
      if (resolvedSceneReveals?.enabled && sceneEffectLibrary) {
        poolReveals = resolveSceneReveals({
          scenes: req.scenes.map((scene: VideoScene, index: number) => ({
            scene_id: sceneIdForIndex(scene, index),
            scene_index: index,
            window_seconds: Math.max(MIN_RENDERABLE_SCENE_SEC, Number(scene.duration) || secondsPerImage),
            snap: snapCandidatesForScene({
              scene,
              index,
              narration_line_ends: narrationLineEnds,
              beat_seconds: resolvedSoundDesignCues.flatMap(cue => (
                [cue.start_sec, cue.end_sec].filter((value): value is number => (
                  typeof value === 'number' && Number.isFinite(value)))
              )),
              scene_start_seconds: sceneStartForIndex(req.scenes, index),
            }),
          })),
          settings: req.scene_reveal,
          library: sceneEffectLibrary.reveals,
        })
        for (const scene of poolReveals.scenes) {
          if (scene.scene_index >= 0 && scene.scene_index < sceneClipDurations.length) {
            sceneClipDurations[scene.scene_index] = Math.max(MIN_RENDERABLE_SCENE_SEC, scene.hold.total_seconds)
          }
        }
        if (renderFingerprint && videoAssemblyCheckpoint) {
          poolFingerprint = await buildVideoAssemblyRenderFingerprint({
            parent_render_fingerprint: renderFingerprint,
            scene_reveals: poolReveals,
            scene_durations: sceneClipDurations,
          })
          videoAssemblyCheckpoint.render_fingerprint = poolFingerprint
        }
        job.output_lines.push(
          `Reveal effects (Image Pool): pace ${poolReveals.pace}, seed ${poolReveals.seed}, `
          + `${poolReveals.scenes.length} still(s) planned; scene track `
          + `${sceneClipDurations.reduce((sum, value) => sum + value, 0).toFixed(1)}s`,
        )
      }
      planTransitionTail = 0
      if (exactSceneTiming && sceneClipDurations.length >= 2 && req.transition && req.transition !== 'none' && getTransition(req.transition)?.xfade) {
        const minWindow = Math.min(...sceneClipDurations)
        planTransitionTail = Math.min(
          Math.max(0.1, req.transition_duration || 1.5),
          Math.max(0.1, minWindow - 0.1),
        )
      }
      sceneClips = await prepareSceneClips(
        req.scenes, resolvedSceneAnimation!.settings, req.chapter_titles, resW, resH, quality, tempDir, canDrawtext, req.scene_recycling, job,
        {
          pool: resolvedSceneAnimation!.pool,
          randomizeMode: resolvedSceneAnimation!.randomize_mode,
          seed: resolvedSceneAnimation!.seed,
          picks: resolvedSceneAnimation!.picks,
          ...(poolReveals ? { reveals: poolReveals } : {}),
          crf: quality.crf,
          upscaleSharpen: req.upscale_sharpen,
          native: { enabled: planTransitionTail > 0 },
        },
        sceneClipDurations,
        planTransitionTail,
        sceneEffectLibrary!.scene_motions,
        videoAssemblyCheckpoint && poolFingerprint
          ? { checkpoint: videoAssemblyCheckpoint, renderFingerprint: poolFingerprint }
          : undefined,
        1 / quality.fps,
      )
    }
    // Bucket totals drive head-of-video (preSceneDuration) vs tail
    // (totalRenderDuration) math below. Sum once here, reuse below.
    const afterScenesDur = timelineClipsByAnchor.after_scenes.reduce((s, c) => s + c.duration, 0)
    const afterOutroDur  = timelineClipsByAnchor.after_outro.reduce((s, c) => s + c.duration, 0)
    const totalTimelineClipCount =
      timelineClipsByAnchor.before_intro.length +
      timelineClipsByAnchor.after_intro.length +
      timelineClipsByAnchor.after_scenes.length +
      timelineClipsByAnchor.after_outro.length
    if (totalTimelineClipCount > 0) {
      job.output_lines.push(
        `Timeline clips: ${totalTimelineClipCount} clip(s) — ` +
        `before_intro=${timelineClipsByAnchor.before_intro.length} ` +
        `after_intro=${timelineClipsByAnchor.after_intro.length} ` +
        `after_scenes=${timelineClipsByAnchor.after_scenes.length} ` +
        `after_outro=${timelineClipsByAnchor.after_outro.length}`
      )

      const allClips: TimelineClipForCheck[] = [
        ...timelineClipsByAnchor.before_intro.map(c => ({ ...c, anchor: 'before_intro' })),
        ...timelineClipsByAnchor.after_intro.map(c  => ({ ...c, anchor: 'after_intro'  })),
        ...timelineClipsByAnchor.after_scenes.map(c => ({ ...c, anchor: 'after_scenes' })),
        ...timelineClipsByAnchor.after_outro.map(c  => ({ ...c, anchor: 'after_outro'  })),
      ]
      const referenceDuration = Math.max(narrationDuration, targetDuration)
      const sanity = checkTimelineDurationSanity(allClips, referenceDuration)
      if (sanity.warning) job.output_lines.push(sanity.warning)
    }

    // How many seconds of the final video are intro + title. When the
    // `exclude_intro_from_effects` flag is on, effects gated by `enable=`
    // (color grade, vignette, grain, subtitles, logo, chroma key) only
    // start after this point — so the user's branded pre-scene content
    // doesn't get tinted or vignetted.
    //
    // User timeline clips at before_intro / after_intro also live at the
    // head of the video, so their durations count toward the effect-gate
    // start. Without this, color grade / vignette / grain would start
    // playing ON the user's pre-scene clips instead of on the first scene.
    //
    // v1.3.1 — this sum moved into `lib/opening-duration.ts` so Scene Plan can
    // reserve the SAME number from the same four buckets. Two independent
    // measurements of "what precedes the scenes" is how the drift below
    // recurs; one shared function with a required key per bucket means a new
    // head bucket is a compile error in both places.
    // ── The one derived intro offset ────────────────────────────────────────
    //
    // `preSceneDuration` above is where the SCENE TRACK actually begins in the
    // composed video, measured from the real opening assets — never a number
    // the user has to remember or restate per episode. `buildConcatList` emits
    // the same four head buckets (before_intro → intro → title → after_intro)
    // and accumulates the same probed durations, so the two are the same
    // number by construction.
    //
    // Scene Plan, meanwhile, times everything against the merged audio: its
    // first scene starts at 0 for a "from-start" plan and at the reserved
    // opening for a "branded-opening" plan. Anything reviewed against plan
    // time — contextual cues today — must be shifted by the gap between the
    // two clocks:
    //
    //     composed_time = preSceneDuration + (plan_time − plan_scene_origin)
    //
    // Both terms are measured facts, so the three real cases fall out with
    // nothing to configure:
    //   • no opening at all   → 0 − 0                = 0, nothing shifts
    //   • the plan reserved the opening (the strict path above trims the intro
    //     to exactly that window and drops title cards)
    //                         → reserved − reserved  = 0, nothing shifts
    //   • intro enabled, plan reserved nothing (the live branded-intro case)
    //                         → openingLength − 0    = openingLength
    // A legacy plan whose scenes begin after the merged audio's lead-in gives a
    // negative shift, which is equally correct: the cue follows its scene.
    const planSceneOriginSec = planCoverageScenes[0]?.start_sec ?? 0
    const sceneTimelineOffsetSec = Math.round((preSceneDuration - planSceneOriginSec) * 1000) / 1000
    // A title image / title card / opening still the plan did not reserve is
    // silent picture that is NOT in the merged audio. Instead of playing the
    // narration under it (every scene then lands that many seconds after its
    // words — Dreamlands EP0002, 5 s), the narration and its captions start
    // after it, so the opening leads in and the scenes stay on their narration.
    const narrationLeadInSec = narrationLeadInForOpening({
      planStrict,
      sceneTimelineOffsetSec,
      introVideoInOpening: !!introClipPath,
    })
    if (narrationLeadInSec > 0) {
      job.output_lines.push(
        `Opening sync: the ${narrationLeadInSec.toFixed(2)}s opening (title image or card) is not part of the narration, ` +
        `so the narration${req.subtitles?.enabled ? ' and captions' : ''} start after it — every scene stays on the narration it was planned against.`,
      )
      if (req.subtitles?.enabled && req.subtitles.srt_path && existsSync(req.subtitles.srt_path)) {
        const { parseSrt, formatSrtTime } = await import('../lib/subtitle-builder.js')
        const cues = parseSrt(await fs.readFile(req.subtitles.srt_path, 'utf-8'))
        const shiftedPath = path.join(tempDir, 'subtitles_after_opening.srt')
        await fs.writeFile(shiftedPath, cues
          .map((c, i) => `${i + 1}\n${formatSrtTime(c.start_sec + narrationLeadInSec)} --> ${formatSrtTime(c.end_sec + narrationLeadInSec)}\n${c.text}`)
          .join('\n\n') + '\n', 'utf-8')
        req.subtitles = { ...req.subtitles, srt_path: shiftedPath }
      }
    }
    if (Math.abs(sceneTimelineOffsetSec) >= 0.05 && narrationLeadInSec === 0) {
      // The reverse of the guard above, and the owner's live situation: an
      // intro is enabled while the plan reserved nothing for it. Deriving the
      // offset puts the CUES back on their scenes, but it cannot put the scenes
      // back on their narration — the scene track really does start
      // `sceneTimelineOffsetSec` away from where the plan timed it, and the
      // merged audio is not delayed to match. That was silent before; it is a
      // real editorial fact and it says so now. Not fatal: refusing to render
      // would strand every episode planned "from first second", and the render
      // is still the one the customer asked for.
      job.output_lines.push(
        `Warning: the composed opening measures ${preSceneDuration.toFixed(2)}s but Scene Plan starts its first scene at ` +
        `${planSceneOriginSec.toFixed(2)}s, so every scene appears ${Math.abs(sceneTimelineOffsetSec).toFixed(2)}s ` +
        `${sceneTimelineOffsetSec > 0 ? 'later than' : 'earlier than'} the narration it was planned against. ` +
        'To lock them together, open Scene Plan and create the timeline again — it measures your opening ' +
        `clips (${preSceneDuration.toFixed(1)}s right now) and reserves exactly that.`,
      )
    }
    if (Math.abs(sceneTimelineOffsetSec) >= 0.05) {
      if (req.contextual_cues?.length) {
        job.output_lines.push(
          `Contextual cues shifted ${sceneTimelineOffsetSec > 0 ? '+' : ''}${sceneTimelineOffsetSec.toFixed(2)}s ` +
          'so each one stays on the scene it annotates. Measured from the opening clips — nothing to configure.',
        )
      }
    }

    // Measure outro length so the final encode's `-t` flag covers it.
    // Without this, the outro IS appended to the concat list (so it lives
    // in the intermediate video) but the encoder's `-t targetDuration`
    // truncates output at narration+30s — and since the outro lives
    // beyond `sceneEndTime`, it gets silently chopped off. Mirrors the
    // intro duration measurement above.
    let outroDuration = 0
    if (outroClipPath) {
      const probed = await getAudioDuration(outroClipPath)
      if (probed && probed > 0) {
        outroDuration = probed
        job.output_lines.push(`Outro duration: ${outroDuration.toFixed(1)}s`)
        if (outroDuration > 300) {
          job.output_lines.push(
            `Warning: outro is ${outroDuration.toFixed(1)}s (>5 min) — final render extended accordingly`
          )
        }
      } else {
        await safetyGate(project_slug, 'opening_outro', job, 'The outro video\'s length could not be measured, so it will be omitted from this render.')
        outroClipPath = undefined
      }
    }

    // Two duration scales — keep them separate:
    //   `targetDuration`        (= narration+30) governs the concat list's
    //                           post-audio fill math (postDuration =
    //                           targetDuration - sceneEndTime). Inflating
    //                           it would stretch the black/fade/hold tail.
    //   `totalRenderDuration`   (= targetDuration + outroDuration) governs
    //                           the premix audio length and the final
    //                           encode's `-t` flag, so the outro segment
    //                           that sits after the post-audio tail isn't
    //                           clipped by the encoder.
    // Tail duration includes outro plus user timeline clips that live
    // after_scenes (before post-audio) and after_outro (very end). Both
    // extend the encoder's `-t` so nothing gets clipped, and both
    // contribute to the premix audio length in identical fashion.
    const tailClipsDuration = afterScenesDur + afterOutroDur
    // The narration lead-in pushes the narration (and its post-audio tail) later by the same amount.
    const sceneTrackTargetDuration = targetDuration + narrationLeadInSec
    const totalRenderDuration = sceneTrackTargetDuration + outroDuration + tailClipsDuration
    if (outroDuration > 0 || tailClipsDuration > 0) {
      const parts = [`target ${targetDuration.toFixed(1)}s`]
      if (outroDuration > 0) parts.push(`outro ${outroDuration.toFixed(1)}s`)
      if (afterScenesDur > 0) parts.push(`after_scenes ${afterScenesDur.toFixed(1)}s`)
      if (afterOutroDur > 0) parts.push(`after_outro ${afterOutroDur.toFixed(1)}s`)
      job.output_lines.push(
        `Total render duration: ${totalRenderDuration.toFixed(1)}s (${parts.join(' + ')})`
      )
    }

    // Disk-space pre-flight gate #2 — accurate edition. The early gate at
    // the top of generateVideo() runs BEFORE narration + timeline durations
    // are known, so it has to fall back to a 1-hour estimate that wildly
    // under-counts long sleep-story tails (a 2.5h render needs ~25 GB peak
    // temp; the early check would estimate ~540 MB and pass on a nearly-
    // full disk). Now that totalRenderDuration is locked in, re-check with
    // the real number and a 6× safety margin that covers the four parallel
    // disk consumers during a render:
    //   1. per-scene clip prep   (~0.5× output bytes — short pre-rendered MP4s)
    //   2. intermediate concat   (~1.0× output — stream-copy of the per-scene clips)
    //   3. premix WAV (PCM)      (~1.5× output — uncompressed at 48k/s16le is bigger than H.264)
    //   4. final output          (~1.0× output)
    // Plus ~2× general buffer for the user's other apps + filesystem
    // overhead. The early gate keeps catching truly drained disks; this
    // gate catches the much more common "8 GB free, need 14 GB" case.
    {
      const estOutputBytes = estimateBytesForStep('video_assembly', {
        durationSec: totalRenderDuration,
        resolution: req.resolution,
        quality: req.quality,
      })
      const required = Math.ceil(estOutputBytes * 6)
      const free = await getFreeBytes(outputRoot)
      if (free > 0 && free < required) {
        const minutesFinal = (totalRenderDuration / 60).toFixed(1)
        throw new Error(
          `Not enough free disk space for the ${minutesFinal}-min render of ${code}. ` +
          `Have: ${formatBytes(free)}, need: ${formatBytes(required)} ` +
          `(${req.resolution || '1080p'} ${req.quality || 'medium'} × 6× safety for intermediate/premix/per-clip temps). ` +
          `Free up space and retry — your render would otherwise crash near the end with "No space left on device".`,
        )
      }
      if (free > 0) {
        job.output_lines.push(
          `Disk pre-flight OK: ${formatBytes(free)} free, ~${formatBytes(required)} estimated peak usage.`,
        )
      }
    }

    // 9. Resolve post-audio behavior
    const postAudio = req.post_audio ?? { behavior: 'fade-to-black' as const, fade_duration: 5 }
    // The tail that exists is the one in the merged audio. When it baked one and
    // the preset since changed to a behavior that draws no tail at all
    // ('hard-cut' / legacy 'continue-cycling'), the picture would stop while the
    // tail's music kept playing — so the last scene is held across it instead.
    const tailAudio = mergedClosingTailSec > 0 && postRollSeconds(postAudio) === 0
      ? { ...postAudio, behavior: 'hold-last-scene' as const, tail_seconds: mergedClosingTailSec }
      : postAudio

    // 10. Build concat list — scenes match narration duration, post-audio fills the rest
    const { listPath: concatListPath, sceneEndTime } = await buildConcatList(
      tempDir, introClipPath, titleClipPath, sceneClips,
      sceneTrackTargetDuration, narrationDuration, tailAudio,
      req.scene_recycling, resW, resH, quality, job,
      sceneClipDurations,
      req.transition && req.transition !== 'none' ? {
        primaryId: req.transition,
        pool: (req as any).transition_pool || [],
        randomizeMode: ((req as any).transition_randomize || 'off') as 'off' | 'single' | 'per-scene',
        // v1.0.521 — plan-strict clamps T against the shortest PLAN window
        // (matches the +T tail baked into the prepared clips); the legacy
        // clamp against seconds_per_scene only applies to recycled pools.
        durationSec: exactSceneTiming && planTransitionTail > 0
          ? planTransitionTail
          : Math.max(0.2, Math.min(req.transition_duration || 1.5, req.scene_recycling.seconds_per_scene - 0.5)),
        seed: (req as any).transition_seed,
      } : undefined,
      outroClipPath,
      timelineClipsByAnchor,
      exactSceneTiming,
      authoritativeAssets.visual_source === 'image_pool' ? 1 / quality.fps : MIN_RENDERABLE_SCENE_SEC,
    )

    // 11. Pre-mix all audio into a single WAV file. Length must match the
    // intermediate video's full span (= `totalRenderDuration`) so audio
    // doesn't run out mid-outro. The level was settled before the scene clips (1.4.281): the same
    // length and no lead-in is that very file; otherwise it is mixed again from the settled level.
    const premixedAudioPath = narrationLeadInSec === 0 && totalRenderDuration === earlyPremix.duration_sec
      ? earlyPremix.path
      : await premixAudio({
        narrationPath: narrationFilePath,
        narrationDuration,
        narrationVolume: req.narration_volume ?? 1.0,
        narrationDelaySec: narrationLeadInSec,
        musicFilePath, musicConfig: req.music,
        backgroundNoise: req.background_noise,
        targetDuration: totalRenderDuration, tempDir, job, loudness, format, plan: settledPlan,
      })

    // 12. Run final composition (simple: concat video + premixed audio + logo/effects)
    // Encode into the OS-tempdir scratch area so iCloud doesn't see the
    // multi-GB output stream while ffmpeg is mid-encode. The rename
    // below moves the finished file to videoDir or the external root —
    // a same-volume rename is atomic + invisible to iCloud, and the
    // existing EXDEV branch handles cross-volume moves.
    const timestamp = Date.now()
    const outputFile = path.join(tempDir, `${code}_video_${timestamp}.${format}`)

    // Concat all scene clips into a single intermediate MP4 (stream copy, near-instant)
    const intermediateVideoPath = await concatToIntermediate(concatListPath, tempDir, job, totalRenderDuration)
    // A static after-outro image is the very end of the intermediate; where it starts lets the final
    // render loop it instead of drawing every frame of it (runFinalComposition decides if it may).
    const lastAfterOutro = timelineClipsByAnchor.after_outro.at(-1)
    const intermediateSec = lastAfterOutro?.still ? await getAudioDuration(intermediateVideoPath).catch(() => null) : null
    const stillTailFromSec = lastAfterOutro && intermediateSec ? Math.max(0, intermediateSec - lastAfterOutro.duration) : undefined

    // Track whether the final encode succeeded so the finally block can
    // remove a partial `outputFile` on failure. Before this, a watchdog
    // kill / cancel / all-tiers-failed run left a multi-hundred-MB
    // truncated `.mp4` in the user's `_video/` folder with no marker —
    // sometimes mistaken for a valid render. The finally only deletes on
    // failure; the rename below handles the happy path.
    // Effects Library (v1.5): this episode's own stack — whole episode, theme
    // runs and single scenes — placed on the COMPOSED timeline with the same
    // derived offset the contextual cues use, so a scene effect lands on its scene.
    const episodeStack = await resolveEpisodeStackForRender({
      episodeDir,
      sceneEffects: req.scene_effects,
      windows: planCoverageScenes.map(scene => ({
        scene_id: scene.id,
        start_sec: scene.start_sec + sceneTimelineOffsetSec,
        end_sec: scene.end_sec + sceneTimelineOffsetSec,
        theme: scene.theme,
      })),
      duration: totalRenderDuration,
      job,
    })

    const introClipForCheck = await introForFinalCheck(req, timelineClipsByAnchor, introClipPath)
    const finalCheckExpected = finalCheckExpectation(req, {
      plannedSec: totalRenderDuration, tailSec: postRoll, bakedTailSec: mergedClosingTailSec, backgroundMusic: mergedBackgroundMusicRecord,
      tailFromEndSec: outroDuration + afterOutroDur,
      width: resW, height: resH,
      // `narrationDuration` is the speech end (see the merged-closing-tail note above), and the
      // narration plays from `narrationLeadInSec` in the file, so this is where the words stop.
      speechEndSec: narrationLeadInSec + narrationDuration,
      sectionGaps: await readPlannedSectionGaps(episodeDir),
      ...(introClipForCheck ? { intro: introClipForCheck } : {}),
    })
    let encodeSucceeded = false
    try {
      const compositionResult = await runFinalComposition({
        videoInputPath: intermediateVideoPath, premixedAudioPath,
        // Pass `totalRenderDuration` so the encoder's `-t` flag covers the
        // outro segment too. Using `targetDuration` here (the historical
        // bug) chopped off any outro that lived past narration+30s.
        logo: req.logo, targetDuration: totalRenderDuration, w: resW, h: resH, quality, format, outputFile,
        colorGrading: req.color_grading,
        vignette: req.vignette,
        chromaKey: req.chroma_key,
        overlays: req.overlays,
        filmGrain: req.film_grain,
        agedArchiveFilm: req.aged_archive_film,
        letterbox: req.letterbox,
        frame: req.frame,
        subtitles: req.subtitles,
        contextualCues: req.contextual_cues,
        sceneEffects: req.scene_effects,
        episodeStack,
        excludeIntroFromEffects: req.exclude_intro_from_effects,
        preSceneDuration,
        sceneTimelineOffsetSec,
        postAudioStart: sceneEndTime,
        encodingEffort: req.encoding_effort,
        codec: req.codec,
        videoBitrateKbps: req.video_bitrate_kbps,
        stillTailFromSec,
        segmentation: finalSegmentation(),
        code,
        titleHint,
        videoDir,
        resolvedLoudness: {
          lufs: loudness.lufs, true_peak_db: loudness.true_peak_db,
          tolerance_pct: loudness.tolerance_pct!, check: loudness.check!,
        },
        finalCheckExpected,
        narrationOffsetSec: narrationLeadInSec,
        job,
      })
      if (compositionResult?.kind === 'video-assembly-remote-wait') {
        remoteHeld = true
        return compositionResult
      }
      encodeSucceeded = true
    } finally {
      if (!encodeSucceeded && !remoteHeld) {
        try {
          await fs.rm(outputFile, { force: true })
          job.output_lines.push(`Removed partial output: ${path.basename(outputFile)}`)
        } catch { /* best-effort cleanup */ }
      }
    }

    // Promote the just-finished render to the project-standard "final" name.
    // Atomic on-same-filesystem rename: fs.rename() is atomic per POSIX so
    // there's no partial state at any point, and if a previous "_final_video"
    // exists the rename replaces it in one step. If FFmpeg had failed,
    // runFinalComposition would have thrown above and we'd never reach here —
    // so this path only runs on confirmed-good output.
    //
    // External final-video root (Phase C of the storage plan):
    //   When the user configured `external_final_video_root` in
    //   app-settings.json, the final lands at the EXTERNAL location
    //   instead of inside the project tree's `Video Assembly Output`
    //   folder. Detection in asset-status.ts already looks at both
    //   places, so the pipeline view sees it either way. Keeps the
    //   5-10 GB output OUT of iCloud-synced project trees while
    //   preserving the project-tree fallback for users who haven't
    //   opted in. Falls back to the project-tree path if the external
    //   write fails (cross-device error, perms, etc.) — never blocks
    //   the user from getting a final video.
    await finishFinalVideo({
      job, project_slug, code, titleHint: titleHint || '', videoDir, format, tempDir, outputFile, totalRenderDuration,
      visualSource: authoritativeAssets.visual_source || 'scene_plan', imagePool: authoritativeAssets.image_pool, loudness,
      expected: finalCheckExpected, narrationOffsetSec: narrationLeadInSec,
    })

    succeeded = true

  } finally {
    // Cleanup policy:
    //   - debug mode  → keep tempDir always (replay any stage)
    //   - failed run  → keep tempDir so the user can inspect the broken
    //                   intermediate / xfade chunk that caused the failure
    //   - success     → remove tempDir (default historical behaviour)
    const keep = debugMode || !succeeded || remoteHeld
    if (succeeded) setVideoAssemblyCheckpoint(job, null)
    if (keep) {
      job.output_lines.push(
        remoteHeld
          ? `Remote intent staged — preserved temp files at ${tempDir}`
          : debugMode
            ? `Debug mode: preserved temp files at ${tempDir}`
            : `Run failed — preserved temp files for inspection at ${tempDir}`
      )
    } else {
      try {
        await fs.rm(tempDir, { recursive: true, force: true })
      } catch {
        // Non-critical cleanup failure
      }
    }
  }
}

/**
 * ── Why every prepared clip carries `-an` ────────────────────────────────
 *
 * Story Studio assembles ONE episode-wide audio timeline. `premixAudio`
 * builds it from narration (+ optional music, + optional ambience), pads it
 * to the full episode duration, and the final encode maps that single mixed
 * stream. There is no per-clip audio lane anywhere in this file, and there
 * cannot be one cheaply: prepared clips are stream-looped to fill a window,
 * hard-trimmed by `-t`, cross-faded across chunk boundaries, re-encoded into
 * chunks, and finally stream-copy concatenated (`-c:v copy -an`). A clip's
 * own track would have to be re-timed through every one of those steps.
 *
 * So `-an` is deliberate at every site, but for two different reasons — worth
 * keeping straight, because only the first group involves a source that HAS
 * audio a customer might have paid for:
 *
 *   A. Sources that carry real audio, dropped as a COMPOSITION decision:
 *      `prepareCompilationBackground` (looping background plate),
 *      `prepareSceneClips` when the scene source is a video — an AI-generated
 *      clip, a materialized B-Roll clip (see its own note at the call site),
 *      `prepareIntroClip`, `prepareOutroClip`, `prepareTimelineClip`.
 *      Narration is the soundtrack; a model's or a stock clip's own audio
 *      competing with it would be the regression, not the fix. The AI-video
 *      generator still writes the downloaded clip to disk untouched, so the
 *      generated track survives in the clip file the customer can play.
 *      A model that BILLS for that track is disclosed at the point of
 *      choosing — see `generates_audio` in lib/genstudio-client.ts and the
 *      notice on the Motion Review model picker.
 *
 *   B. Sources that have no audio at all, where `-an` only stops FFmpeg
 *      inventing an empty stream: `prepareTextCardClip`, `prepareTitleClip`,
 *      `prepareStaticTimelineClip` (stills and drawtext cards), and every
 *      re-encode/concat of an already-silent intermediate — the chunk passes
 *      and `commonPostArgs` in `buildConcatList`, `trimPreparedSceneClip`,
 *      `concatToIntermediate`.
 *
 * Do not "fix" group B by removing `-an`; there is nothing to keep. Changing
 * group A means building a real per-clip audio lane first.
 */

// ── Compilation-mode helpers (Path C — v1.0.63+) ─────────────────────────

/**
 * Render a looped background-plate clip that fills the full target
 * duration. Used as the base video in compilation mode (compilation-mode-style
 * listicle / explainer channels) where the visual continuity comes
 * from a starfield / atmospheric loop and per-chapter foreground icons
 * are composited on top via the auto-generated overlay layers.
 *
 * Static images vs videos: ffmpeg uses different loop flags. Detect by
 * extension and apply the right one — `-loop 1` for stills,
 * `-stream_loop -1` for videos. Result is always re-encoded to libx264
 * at the canvas resolution + project fps so downstream filter graphs
 * have predictable input dimensions/timestamps.
 */
async function prepareCompilationBackground(
  plate: BackgroundPlate,
  w: number,
  h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  totalDuration: number,
  job: Job,
): Promise<string> {
  const outputPath = path.join(tempDir, 'compilation_background.mp4')
  const isImage = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(plate.source_path)
  job.output_lines.push(
    `Compilation: ${isImage ? 'looping still' : 'looping video'} background ` +
    `(${path.basename(plate.source_path)}) → ${totalDuration.toFixed(1)}s @ ${w}×${h} ${quality.fps}fps`,
  )

  const args: string[] = ['-y']
  if (isImage) {
    // Stills: -loop 1 + -t target. Frame rate is provided by the
    // output -r flag; ffmpeg synthesises a stream of frames from the
    // single image.
    args.push(...(await stillDecoderArgs(plate.source_path)), '-loop', '1', '-i', plate.source_path)
  } else {
    // Videos: -stream_loop -1 wraps the input infinitely; -t below
    // caps the output. We accept the small perf cost of reading the
    // file repeatedly because users typically supply a 10-30s loop
    // and a 1h+ episode would otherwise need a very long source.
    args.push('-stream_loop', '-1', '-i', plate.source_path)
  }

  args.push(
    '-t', totalDuration.toString(),
    // scale=force_aspect_ratio=decrease,pad=… letterboxes/pillarboxes
    // sources that don't match canvas aspect — keeps the bg crisp
    // without distorting it. fps + format normalise the stream so the
    // downstream concat / filter passes don't trip on mismatched
    // pixel formats.
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${quality.fps},format=yuv420p`,
    '-c:v', 'libx264',
    // Pre-render speed — the FINAL encode at runFinalComposition uses
    // the user's chosen preset/crf. This is just an intermediate.
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    // Match standard pipeline's color tagging (see prepareSceneClips
    // commentary) so the concat into the final filter graph doesn't
    // produce mixed bt709/unspecified streams.
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-an',
    outputPath,
  )

  await runFfmpeg(args)

  try {
    const info = await assertValidMedia(outputPath, {
      label: 'compilation_background.mp4',
      requireVideo: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Compilation background ready · ${summarizeMedia(info)}`)
  } catch (e: any) {
    job.output_lines.push(`Compilation background validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

/**
 * Generate one foreground overlay per chapter from the scene image
 * list + chapter audio durations. Each overlay is gated to its
 * chapter's time range (`[start_s, start_s + duration_s + gap]`) so
 * chapter N narration plays with chapter N foreground. Carries the
 * project's foreground_defaults (scale_pct + position_anchor +
 * chroma_key) onto every overlay so the layout stays consistent
 * across chapters without per-scene tuning.
 *
 * Mismatched counts (more scenes than chapters or vice versa) are
 * warned but tolerated — extras are dropped, missing chapters render
 * with no foreground.
 */
function buildCompilationOverlays(
  scenes: Array<{ image_path: string }>,
  chapterDurations: Array<{ slug: string; duration_s: number }>,
  fgDefaults: ForegroundDefaults,
  audioGap: number,
  job: Job,
): VideoOverlay[] {
  const sceneCount = Math.min(scenes.length, chapterDurations.length)
  if (sceneCount === 0) {
    job.output_lines.push(
      `Compilation: no scenes/chapters to align (scenes=${scenes.length}, chapters=${chapterDurations.length}). ` +
      `Background plate will play with no foreground overlays.`,
    )
    return []
  }
  if (scenes.length !== chapterDurations.length) {
    job.output_lines.push(
      `Compilation: ${scenes.length} scene(s) vs ${chapterDurations.length} chapter(s) — ` +
      `using positional pairing for the first ${sceneCount}, dropping any extras.`,
    )
  }

  const overlays: VideoOverlay[] = []
  let cumulativeOffset = 0
  for (let i = 0; i < sceneCount; i++) {
    const scene = scenes[i]!
    const chapter = chapterDurations[i]!
    const isLast = i === sceneCount - 1
    const startS = cumulativeOffset
    // Extend each foreground through the silent gap that follows it
    // so there's never a "no foreground" beat between chapters. Last
    // chapter has no trailing gap.
    const endS = cumulativeOffset + chapter.duration_s + (isLast ? 0 : audioGap)
    overlays.push({
      id: `compilation-scene-${i + 1}`,
      enabled: true,
      source_path: scene.image_path,
      chroma_key: fgDefaults.chroma_key
        ? { color: fgDefaults.chroma_key.color, similarity: fgDefaults.chroma_key.similarity, blend: fgDefaults.chroma_key.blend }
        : null,
      opacity: 1,
      scale_pct: fgDefaults.scale_pct,
      position_anchor: fgDefaults.position,
      time_range: { start_s: startS, end_s: endS },
      loop: false,
    })
    cumulativeOffset = endS
  }
  job.output_lines.push(
    `Compilation: ${overlays.length} foreground overlay(s) generated · ` +
    `total ${cumulativeOffset.toFixed(1)}s coverage`,
  )
  return overlays
}

// ── Prepare Scene Clips ───────────────────────────────────────────────────

/**
 * A scene's stable identity as the reveal planner sees it.
 *
 * The plan's ids travel into the fingerprint and into the per-scene overrides the UI saves, so they
 * have to be the *plan's* ids rather than positions: a scene inserted at the top would otherwise
 * move every override down one and re-dress the episode. Position is the fallback only for a scene
 * the plan did not name.
 */
function sceneIdForIndex(scene: VideoScene, index: number): string {
  const stable = (scene as { plan_scene_id?: unknown }).plan_scene_id
  return typeof stable === 'string' && stable ? stable : `scene:${index}`
}

/** The act a scene belongs to, for the `act` coherence mode: its chapter, by first appearance. */
function actIndexForScene(scene: VideoScene): number | undefined {
  const chapter = typeof scene.chapter_slug === 'string' ? scene.chapter_slug.trim() : ''
  if (!chapter) return undefined
  const seen = scene.__revealChapterOrder ??= new Map<string, number>()
  if (!seen.has(chapter)) seen.set(chapter, seen.size)
  return seen.get(chapter)
}

/**
 * The window a scene has to fill, in the order the authoritative plan states it.
 *
 * The plan's own duration wins, then an explicit scene duration, then the uniform recycling
 * default — the same cascade `sceneClipDurations` uses below, and deliberately the same order so
 * the reveal plan and the timeline cannot disagree about how long a scene is.
 */
function resolveRevealWindowSeconds(scene: VideoScene, recyclingDefault: number): number {
  const stated = typeof scene.duration === 'number' && Number.isFinite(scene.duration) && scene.duration > 0
    ? scene.duration
    : undefined
  if (stated) return stated
  // The same fallback the timeline uses, passed in rather than restated: a plan built on a
  // different default would put the reveal's own length out of step with the scene's window.
  return recyclingDefault
}

/**
 * A scene's narration length, when the scene itself is narration-derived.
 *
 * `planSceneHold` raises a scene's total to its narration length, so passing this is what stops a
 * pace band from trimming a long line. A scene with no narration window (a B-Roll scene, a
 * title-driven beat) passes nothing and the band decides.
 */
/**
 * The absolute second a scene starts on the timeline.
 *
 * The scene plan's own `start_sec` is the authority — it is what the narration was cut against.
 * Failing that (an Image Pool body, or a plan written before the field existed) the running sum of
 * the scenes' durations is the only statement available, and it is the same clock the snap
 * candidates are on: both come from the merged narration.
 */
function sceneStartForIndex(scenes: VideoScene[], index: number): number {
  const planned = Number((scenes[index] as { start_sec?: number }).start_sec)
  if (Number.isFinite(planned) && planned >= 0) return planned
  let total = 0
  for (let i = 0; i < index; i++) total += Math.max(0, Number(scenes[i]?.duration) || 0)
  return total
}

function narrationForScene(scene: VideoScene): number | undefined {
  const planned = (scene as { __scene_plan_duration?: boolean }).__scene_plan_duration
  if (!planned) return undefined
  const stated = typeof scene.duration === 'number' && Number.isFinite(scene.duration) && scene.duration > 0
    ? scene.duration
    : undefined
  return stated
}

/**
 * The narration lines and beats a scene's hold may snap to.
 *
 * **Deliberately empty for now, and that is a real limitation rather than an oversight.** The
 * planner accepts both, and the numbers exist in `audio_sentences.json` and in the Sound Design
 * cue list — but neither is loaded at the point the plan is resolved (the plan has to be resolved
 * before the render fingerprint, and those reads happen after it). Snapping is a refinement on top
 * of a hold that already fits the window, so it is the part to leave out rather than to load late
 * and disagree with the fingerprint. Recorded in `docs/reveal-effects.md`.
 */
function snapCandidatesForScene(input: {
  scene: VideoScene
  index: number
  /** Absolute narration line ends, seconds, from `audio_sentences.json`. */
  narration_line_ends: number[]
  /** Absolute cue boundaries from the approved Sound Design mix. */
  beat_seconds: number[]
  /** Absolute start of this scene's window on the timeline. */
  scene_start_seconds: number
}): { narration_line_ends?: number[]; beat_seconds?: number[] } | undefined {
  // `planSceneHold` compares candidates against a *duration*, so a scene's candidates are offsets
  // from its own start: "the line that ends 4.2 s in" is a hold length, "the line that ends at
  // 4.2 s" is a timestamp on a different clock. A candidate outside the scene is not offered —
  // snapping to a line the scene does not cover would stretch or crush it to hit a moment it has
  // nothing to do with, which is the padding the pace setting exists to avoid.
  const window = Math.max(MIN_RENDERABLE_SCENE_SEC, Number(input.scene.duration) || 0)
  const offsets = (values: number[]): number[] => [...new Set(values
    .map(value => Number((value - input.scene_start_seconds).toFixed(3)))
    .filter(offset => Number.isFinite(offset) && offset > 0.5 && offset < window - 0.2))]
    .sort((a, b) => a - b)
  const lines = offsets(input.narration_line_ends)
  const beats = offsets(input.beat_seconds)
  if (!lines.length && !beats.length) return undefined
  return {
    ...(lines.length ? { narration_line_ends: lines } : {}),
    ...(beats.length ? { beat_seconds: beats } : {}),
  }
}

/** Keep generator-only normalization off the durable request persisted by the queue. */
export function createVideoAssemblyExecutionRequest(params: Job['params']): GenerateVideoRequest {
  // 1.4.282 — one effects route: misplaced entries go where they render, and a
  // classic checkbox kept as a marked library entry renders through its old field.
  const req = splitLegacySlots(normalizeEffectsLook(structuredClone(params)).look as GenerateVideoRequest)
  delete (req as any).effect_stack
  return req
}

export interface ResolvedVideoAssemblySceneAnimation {
  settings: VideoSceneAnimation
  pool: string[]
  randomize_mode: 'off' | 'single' | 'per-scene'
  seed: number
  picks: string[]
}

/** The camera move a still gets when the request names none: slow zoom (Ken Burns, 100 → 108 %). */
export const DEFAULT_STILL_CAMERA_MOVE = 'ken-burns'

/** Resolve the exact animation choices once so retry fingerprints and encodes agree. */
export function resolveVideoAssemblySceneAnimation(
  req: GenerateVideoRequest,
  sceneCount: number,
): ResolvedVideoAssemblySceneAnimation {
  // A request that names no camera move gets the slow zoom stills are made
  // for (owner, 2026-10-03: "default camera move on stills = slow zoom/pan") —
  // the same Ken Burns the Video Assembly page starts on, so a Pipeline batch
  // with no saved timeline preset no longer renders frozen stills while the
  // page would have zoomed. Every other move stays one click away.
  const settings: VideoSceneAnimation = req.scene_animation ?? {
    type: DEFAULT_STILL_CAMERA_MOVE, zoom_start: 100, zoom_end: 108, parallax_direction: 'right', parallax_speed: 2, breathe_amplitude: 2, breathe_base_zoom: 103,
  }
  const pool = Array.isArray((req as any).animation_pool) ? [...(req as any).animation_pool] : []
  const requestedMode = (req as any).animation_randomize
  const randomizeMode = requestedMode === 'single'
    ? 'single'
    : requestedMode && requestedMode !== 'off'
      ? 'per-scene'
      : 'off'
  const rawSeed = (req as any).animation_seed
  const requestedSeed = rawSeed == null ? 7 : Number(rawSeed)
  const seed = Number.isFinite(requestedSeed) ? requestedSeed : 7
  return {
    settings,
    pool,
    randomize_mode: randomizeMode,
    seed,
    picks: pickAnimationsPerScene(sceneCount, settings.type || 'none', pool, randomizeMode, seed),
  }
}

/** Deterministic per-scene animation pick — same seed → same sequence. */
function pickAnimationsPerScene(
  count: number,
  primary: string,
  pool: string[],
  mode: 'off' | 'single' | 'per-scene',
  seed?: number,
): string[] {
  const picks: string[] = []
  if (count === 0) return picks
  // 1.4.280 — never a rotation, even when an old preset names one or keeps one in its pool.
  if (isRotationMotion(primary)) primary = DEFAULT_STILL_CAMERA_MOVE
  pool = pool.filter(id => !isRotationMotion(id))
  if (mode === 'off' || pool.length === 0) {
    for (let i = 0; i < count; i++) picks.push(primary)
    return picks
  }
  const rnd = mulberry32(seed ?? 7)
  // 1.4.282 (owner-approved) — strengths of one family (Zoom in, Zoom out,
  // Breathe) are ONE pick, then a strength from those ticked, so a family no
  // longer gets two or three times the share of a single move. A pool without
  // two strengths of one family draws exactly the sequence it always did.
  const slots = motionPoolSlots(pool)
  const draw = () => {
    const slot = slots[Math.floor(rnd() * slots.length)]!
    return slot.length === 1 ? slot[0]! : slot[Math.floor(rnd() * slot.length)]!
  }
  if (mode === 'single') {
    const pick = draw()
    for (let i = 0; i < count; i++) picks.push(pick)
  } else {
    for (let i = 0; i < count; i++) picks.push(draw())
  }
  return picks
}

export interface VideoAssemblySceneClipRecovery {
  checkpoint: VideoAssemblyCheckpoint
  renderFingerprint: string
  /** Test seam: production always uses the real FFmpeg runner. */
  encodeSceneClip?: (args: string[], options: { timeoutMs: number }) => Promise<unknown>
  /** Test seam for the reveal path, exactly like `encodeSceneClip`: production runs FFmpeg. */
  runRevealClip?: (args: string[], options: { timeoutMs?: number }) => Promise<unknown>
  /** Test seam: production always persists through the durable job queue. */
  persistCheckpoint?: (job: Job) => Promise<void>
}

/** Replace an unreadable still only with a decodable still from this episode. */
export async function replaceUndecodableSceneImages(
  slug: string,
  scenes: GenerateVideoRequest['scenes'],
  job: Job,
): Promise<void> {
  const still = (scene: GenerateVideoRequest['scenes'][number]) => !/\.(mp4|mov|webm|mkv|m4v)$/i.test(scene.image_path || '')
  const usable = await mapWithConcurrency(scenes, 2, async scene => still(scene) && await isDecodableImage(scene.image_path))
  for (let index = 0; index < scenes.length; index++) {
    if (!still(scenes[index]!) || usable[index]) continue
    const scene = scenes[index]!
    const stableId = (scene as any).plan_scene_id || `scene ${index + 1}`
    await safetyGate(slug, 'picture_opens', job, `Scene ${index + 1}/${scenes.length} (${stableId}) has a missing or unreadable picture. A decodable neighbouring picture will stand in.`)
    let neighbour = -1
    for (let distance = 1; neighbour < 0 && distance < scenes.length; distance++) {
      for (const candidate of [index - distance, index + distance]) {
        if (candidate >= 0 && candidate < scenes.length && usable[candidate]) { neighbour = candidate; break }
      }
    }
    if (neighbour < 0) {
      throw new Error(`Video Assembly cannot continue: ${stableId} is unreadable and this episode has no decodable neighbouring picture.`)
    }
    scene.image_path = scenes[neighbour]!.image_path
    usable[index] = true
    job.output_lines.push(`Scene ${index + 1}: using scene ${neighbour + 1}'s decodable picture for this render.`)
  }
}

export async function prepareSceneClips(
  scenes: GenerateVideoRequest['scenes'],
  sceneAnimation: VideoSceneAnimation,
  chapterTitles: GenerateVideoRequest['chapter_titles'],
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  canDrawtext: boolean,
  recycling: VideoSceneRecycling,
  job: Job,
  /** Optional per-scene animation randomization. When enabled, each scene
   *  clip gets an animation picked from the pool; deterministic via seed. */
  animationOpts?: {
    pool: string[]
    randomizeMode: 'off' | 'single' | 'per-scene'
    seed?: number
    picks?: string[]
    /** The episode's reveal plan, when reveals are on. A scene it covers renders a reveal clip. */
    reveals?: ResolvedSceneReveals
    /** The pace's own size, because a reveal clip is rendered at the canvas, not cropped to it. */
    crf?: number
    /** Light sharpening of smaller stills while they are upscaled to the canvas (request `upscale_sharpen`). */
    upscaleSharpen?: 'off' | 'light'
    /**
     * Render still scenes with the native Metal/VideoToolbox helper, falling back to FFmpeg per clip.
     *
     * The caller sets this ONLY when every scene clip is decoded and re-encoded downstream (the
     * xfade stage). A native clip is VideoToolbox H.264, and a stream-copy concat of it next to
     * x264 clips would mix two SPS/PPS sets under one header. Otherwise the clip is FFmpeg's, as ever.
     */
    /** 1.4.284 — living pictures / outlined effects per Scene Plan scene id, drawn on that scene's clip. */
    sceneStage?: { byScene: Map<string, SceneStageItem[]>; episodeDir: string | null }
    /**
     * E2–E4 — each Scene Plan scene's saved analysis (absent = the channel has it off). Moves that
     * need it aim, add depth or fall back per scene; depth moves only with transitions (Q9).
     */
    vision?: Map<string, SceneVision>
    native?: {
      enabled: boolean
      /** Test seams. */
      render?: typeof renderNativeSceneClip
      probe?: () => Promise<{ available: boolean; reason?: string }>
      verify?: (clipPath: string, expected: { w: number; h: number; fps: number; duration: number }) => Promise<string[]>
    }
  },
  /** v1.0.81+: sentence-aligned per-scene durations. Index-aligned with
   *  `scenes`. When provided, scene i renders for perSceneDurations[i]
   *  seconds instead of the uniform recycling.seconds_per_scene. Falls
   *  back to the uniform default when an entry is 0/undefined. Clamped
   *  to a sane floor (0.5s) to avoid sub-frame clips. */
  perSceneDurations?: number[],
  /** v1.0.521 — plan-strict xfade tail. When set (> 0), each clip is rendered
   *  extraTailSec LONGER than its planned window so window-anchored dissolves
   *  have overlap material that doesn't eat the scene's on-screen time. All
   *  timeline math elsewhere keeps using the plain window duration; only the
   *  physical clip is longer (the xfade chunk caps its output at ΣD). */
  extraTailSec?: number,
  motionLibrary: SceneMotionLibrary = [],
  recovery?: VideoAssemblySceneClipRecovery,
  minimumDurationSec = MIN_RENDERABLE_SCENE_SEC,
): Promise<string[]> {
  // v1.0.515 — filled by index (scenes render in a parallel pool; order must hold).
  const clipPaths: string[] = new Array(scenes.length)
  const defaultDuration = recycling.seconds_per_scene || 10

  // Pre-pick an animation type for each scene. 'off' = use the primary type;
  // 'single' = one random type for all scenes; 'per-scene' = different each time.
  const picks = animationOpts?.picks || pickAnimationsPerScene(
    scenes.length,
    sceneAnimation.type || 'none',
    animationOpts?.pool || [],
    animationOpts?.randomizeMode || 'off',
    animationOpts?.seed,
  )

  const durationFor = (i: number): { duration: number; renderDuration: number } => {
    const scene = scenes[i]
    const sceneOverride = perSceneDurations?.[i]
    const explicitSceneDuration = scene?.duration
    // Already resolved from the authoritative plan above, including any
    // narration-tail coverage correction. Do not undo that correction here.
    const durationCandidate = (typeof sceneOverride === 'number' && Number.isFinite(sceneOverride) && sceneOverride > 0)
      ? sceneOverride
      : (typeof explicitSceneDuration === 'number' && Number.isFinite(explicitSceneDuration) && explicitSceneDuration > 0)
          ? explicitSceneDuration
          : defaultDuration
    const duration = Math.max(minimumDurationSec, durationCandidate)
    return { duration, renderDuration: duration + Math.max(0, extraTailSec || 0) }
  }
  const expectedRecoveryClips: VideoAssemblyCompletedSceneClip[] = scenes.map((_, i) => ({
    scene_index: i,
    clip_path: path.join(tempDir, `scene_${String(i).padStart(4, '0')}.mp4`),
    render_duration_sec: durationFor(i).renderDuration,
  }))
  const reusable = recovery
    ? await findReusableVideoAssemblySceneClips(
        recovery.checkpoint,
        recovery.renderFingerprint,
        expectedRecoveryClips,
      )
    : new Map<number, string>()
  let checkpointWrite = Promise.resolve()
  const persistRecovery = (): Promise<void> => {
    if (!recovery) return Promise.resolve()
    setVideoAssemblyCheckpoint(job, recovery.checkpoint)
    checkpointWrite = checkpointWrite.then(() => (
      // A finished clip is a recovery hint: it may share one jobs.json rewrite with its neighbours (S4).
      recovery.persistCheckpoint ? recovery.persistCheckpoint(job) : checkpointJobProgress(job)
    ))
    return checkpointWrite
  }
  if (recovery) {
    recovery.checkpoint.completed_scene_clips = expectedRecoveryClips.filter(clip => reusable.has(clip.scene_index))
    await persistRecovery()
  }

  // Validate every still before starting any expensive clip encoding. A
  // truncated provider download can have a valid PNG header and non-zero size
  // yet emit zero frames in FFmpeg. Reporting the stable scene id here avoids
  // discovering one bad asset after dozens of clips have already rendered.
  const stills = scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => !/\.(mp4|mov|webm|mkv|m4v)$/i.test(scene.image_path || ''))
  if (stills.length) {
    job.output_lines.push(`Preflight: validating ${stills.length} still image(s) before encoding…`)
    for (const { scene, index } of stills) {
      try {
        await assertDecodableImage(scene.image_path, `Scene ${index + 1} image`)
      } catch (error: any) {
        const stableId = (scene as any).plan_scene_id || `scene ${index + 1}`
        throw new Error(
          `Scene ${index + 1}/${scenes.length} (${stableId}) failed image preflight: ${error?.message || error}`,
        )
      }
    }
    job.output_lines.push(`Preflight: all ${stills.length} still image(s) decoded successfully.`)
  }

  // Optional light sharpening while upscaling smaller stills (e.g. the fleet's 720p scenes in a
  // 1080p render). Once per still, before any clip; 'off'/absent leaves every input untouched.
  if (animationOpts?.upscaleSharpen === 'light') {
    scenes = await sharpenUpscaledStills(scenes, w, h, tempDir, args => runFfmpeg(args), line => job.output_lines.push(line))
  }

  // v1.0.515 — scenes render through a small parallel pool instead of a strict
  // serial loop. Each clip's ffmpeg (zoompan) is effectively single-threaded,
  // so 4 concurrent clips ≈ 4× the wall-clock on Apple Silicon while leaving
  // cores for the rest of the app. Per-clip work + errors stay per-scene.
  const PREP_CONCURRENCY = Math.max(2, Math.min(4, os.cpus().length - 2))
  let preparedCount = 0
  job.output_lines.push(`Preparing ${scenes.length} scene clip(s) — up to ${PREP_CONCURRENCY} in parallel…`)

  // Native fast path (Metal + VideoToolbox). Decided once; every clip still falls back on its own.
  let nativeOn = false
  const nativeTally = { native: 0, fallback: 0, reasons: new Map<string, number>() }
  if (animationOpts?.native?.enabled) {
    const probe = await (animationOpts.native.probe ?? probeNativeSceneClip)()
    nativeOn = probe.available
    job.output_lines.push(nativeOn
      ? `Scene clips: native renderer on (Metal + VideoToolbox, helper v${NATIVE_SCENE_CLIP_VERSION}); FFmpeg for anything it cannot do.`
      : `Scene clips: native renderer unavailable (${probe.reason || 'unknown'}) — using FFmpeg.`)
  }
  const nativeFallback = (index: number, detail: string): void => {
    nativeTally.fallback++
    const key = detail.replace(/\s+/g, ' ').slice(0, 120)
    nativeTally.reasons.set(key, (nativeTally.reasons.get(key) || 0) + 1)
    job.output_lines.push(`Scene ${index + 1}: native renderer skipped (${key}) — rendering with FFmpeg.`)
  }

  const prepOne = async (i: number): Promise<void> => {
    const scene = scenes[i]
    const clipPath = path.join(tempDir, `scene_${String(i).padStart(4, '0')}.mp4`)

    if (reusable.has(i)) {
      clipPaths[i] = clipPath
      preparedCount++
      job.output_lines.push(`Scene clips: ${preparedCount}/${scenes.length} done [reused checkpoint clip]`)
      return
    }

    // Pick per-scene duration: an exact Scene Plan duration wins first;
    // then sentence-aligned override; then an explicit scene.duration from the
    // caller; then the uniform recycling default. Floor at 0.5s so tiny windows
    // don't produce sub-frame clips.
    const { duration, renderDuration } = durationFor(i)
    // v1.0.521 — plan-strict xfade tail: the physical clip renders longer than
    // its planned window; the window itself stays `duration` everywhere else.
    // v1.0.414 — a scene whose source is a video (materialized B-Roll clip)
    // is normalised to the canvas by crop-fill and plays for the same uniform
    // per-scene `duration` as a still; it does NOT get Ken Burns (it already
    // moves) and its own audio is dropped (narration carries the soundtrack).
    // Everything downstream (cycling, xfade transitions, effect gate,
    // subtitles, logo, overlays, export) is identical to a still scene.
    const isVideoScene = /\.(mp4|mov|webm|mkv|m4v)$/i.test(scene.image_path || '')
    const holdVideo = isVideoScene && scene.clip_shortfall_mode === 'hold'

    const pickedType = picks[i]
    const durLog = Math.abs(duration - defaultDuration) > 0.05 ? ` [dur=${duration.toFixed(2)}s]` : ''
    const tagLog = `${isVideoScene ? ' [video]' : (pickedType !== sceneAnimation.type ? ` [anim=${pickedType}]` : '')}${durLog}`

    // A revealed still does not go through the animation-filter path at all: the reveal engine owns
    // the whole graph (its own field, its own zoompan drift, its own micro-events), so its clip is
    // rendered first and this branch takes it as the scene's clip. A *video* scene never takes a
    // reveal — it already moves, and dressing footage in a wipe is not what "reveal effects" means
    // here — and a scene the plan does not cover keeps the shipped behaviour exactly.
    const reveal = isVideoScene ? undefined : plannedRevealForScene(animationOpts?.reveals, i)
    // 1.4.284 — this scene's living pictures / outlined effects.
    const planSceneId = (scene as { plan_scene_id?: string }).plan_scene_id
    const stageItems = planSceneId ? animationOpts?.sceneStage?.byScene.get(planSceneId) : undefined
    if (stageItems?.length && (isVideoScene || reveal)) {
      job.output_lines.push(`Scene ${i + 1}: living picture skipped: ${isVideoScene ? 'the scene is footage, not a still' : 'the scene uses a reveal, which draws its own picture'}.`)
    }
    // E2–E4 — the move as this scene can draw it (aimed, with depth, or its plain fallback).
    const sceneVision = planSceneId ? animationOpts?.vision?.get(planSceneId) : undefined
    const baseMotion = isVideoScene || reveal || !animationOpts?.vision
      ? null
      : resolveSceneMotionDocument({ type: pickedType, params: sceneAnimation, library: motionLibrary, sceneIndex: i })
    const visionMove = !baseMotion
      ? null
      : resolveVisionMotion(
          baseMotion,
          sceneVision,
          { depthAllowed: !!animationOpts?.native?.enabled, blurFocus: resolveSceneMotionDocument({ type: 'blur-focus', params: sceneAnimation, library: motionLibrary }) },
        )
    for (const note of visionMove?.notes || []) job.output_lines.push(`Scene ${i + 1}: ${note}.`)
    /** Draw the stage on the finished clip in place; the note for the progress line. */
    const drawSceneStage = async (renderMaskClip: (maskPng: string, outPath: string) => Promise<void>): Promise<string> => {
      if ((!stageItems?.length && !visionMove?.depth) || isVideoScene || reveal) return ''
      const staged = clipPath.replace(/\.mp4$/, '.living.mp4')
      const drawn = await applySceneStage({
        clipPath, outPath: staged, stillPath: scene.image_path, items: stageItems || [], depth: visionMove?.depth ?? null,
        episodeDir: animationOpts?.sceneStage?.episodeDir ?? null,
        w, h, fps: quality.fps, duration: renderDuration, workDir: tempDir,
        encodeArgs: sceneClipEncodeArgs(quality.crf, quality.fps, renderDuration),
        renderMaskClip, log: line => job.output_lines.push(`Scene ${i + 1}: ${line}`),
      })
      if (!drawn.length) return ''
      await fs.rename(staged, clipPath)
      return ` [living: ${drawn.join(', ')}]`
    }
    if (reveal && !reusable.has(i)) {
      const revealPath = revealClipPath(tempDir, i)
      const rendered = await renderRevealClip({
        ...(recovery?.runRevealClip ? { run: recovery.runRevealClip } : {}),
        imagePath: scene.image_path,
        outPath: revealPath,
        document: reveal.document,
        pace: animationOpts!.reveals!.pace,
        // The clip's own window: the plan already decided it, and the timeline was given the same
        // number, so a reveal that rendered to any other length would drift from the script.
        windowSeconds: duration,
        tailSeconds: renderDuration - duration,
        narrationSeconds: (scene as { __scene_plan_duration?: boolean }).__scene_plan_duration
          ? duration
          : undefined,
        width: w,
        height: h,
        fps: quality.fps,
        crf: animationOpts?.crf,
        ...(nativeOn
          ? {
              native: {
                driftPath: path.join(tempDir, `reveal_drift_${String(i).padStart(4, '0')}.mp4`),
                onFallback: (detail: string) => nativeFallback(i, `reveal drift: ${detail}`),
                ...(animationOpts?.native?.render ? { render: animationOpts.native.render } : {}),
              },
            }
          : {}),
      })
      if (rendered.renderer === 'native-drift') nativeTally.native++
      await fs.unlink(path.join(tempDir, `reveal_drift_${String(i).padStart(4, '0')}.mp4`)).catch(() => {})
      clipPaths[i] = revealPath
      preparedCount++
      job.output_lines.push(
        `Scene clips: ${preparedCount}/${scenes.length} done [reveal ${reveal.preset_id}${rendered.renderer === 'native-drift' ? ' native drift' : ''} `
        + `${rendered.plan.reveal_seconds.toFixed(2)}s + hold ${rendered.plan.hold_seconds.toFixed(2)}s`
        + `${rendered.plan.micro_event_offsets.length
          ? ` + ${rendered.plan.micro_event_offsets.length} micro-event(s)` : ''}]`,
      )
      return
    }

    // The completion bookkeeping every plain clip shares, whichever renderer made it.
    const completePlainClip = async (note: string): Promise<void> => {
      const completed = expectedRecoveryClips[i]!
      if (!(await validateVideoAssemblySceneClip(completed))) {
        throw new Error(`prepared clip failed media or duration validation: ${clipPath}`)
      }
      clipPaths[i] = clipPath
      if (recovery) {
        recovery.checkpoint.completed_scene_clips = [
          ...recovery.checkpoint.completed_scene_clips.filter(clip => clip.scene_index !== i),
          completed,
        ].sort((a, b) => a.scene_index - b.scene_index)
        await persistRecovery()
      }
      preparedCount++
      job.output_lines.push(`Scene clips: ${preparedCount}/${scenes.length} done${note}`)
    }

    // Native fast path: a still with a camera move, no chapter-title drawtext (that is an FFmpeg
    // filter), not footage. Anything else, and any failure, falls through to the FFmpeg chain below.
    const wantsChapterTitle = !!(canDrawtext && chapterTitles?.enabled && scene.title && scene.show_title)
    if (nativeOn && !isVideoScene && !wantsChapterTitle) {
      let detail = ''
      try {
        const nativeRender = animationOpts?.native?.render ?? renderNativeSceneClip
        const motionDocument = visionMove?.document ?? resolveSceneMotionDocument({ type: pickedType, params: sceneAnimation, library: motionLibrary, sceneIndex: i })
        const outcome = await nativeRender({
          imagePath: scene.image_path,
          outPath: clipPath,
          document: motionDocument,
          w, h, fps: quality.fps,
          duration: renderDuration,
        })
        if (outcome.rendered) {
          const problems = await (animationOpts?.native?.verify
            ?? (async (file: string, expected: { w: number; h: number; fps: number; duration: number }) =>
              sceneClipCompatibilityProblems(await probeVideoStream(file), expected)))(
            clipPath, { w, h, fps: quality.fps, duration: renderDuration })
          if (problems.length === 0) {
            // The outline rides the same Metal camera move as the picture.
            const living = await drawSceneStage(async (maskPng, maskOut) => {
              const mask = await nativeRender({ imagePath: maskPng, outPath: maskOut, document: motionDocument, w, h, fps: quality.fps, duration: renderDuration })
              if (!mask.rendered) throw new Error(`${mask.reason}: ${mask.detail}`)
            })
            await completePlainClip(`${tagLog} [native ${outcome.kind}]${living}`)
            nativeTally.native++
            return
          }
          detail = `output not concat-compatible: ${problems.join('; ')}`
        } else {
          detail = `${outcome.reason}: ${outcome.detail}`
        }
      } catch (error: any) {
        detail = `error: ${error?.message || error}`
      }
      await fs.unlink(clipPath).catch(() => {})
      nativeFallback(i, detail)
    }

    // E3 — FFmpeg cannot draw a guided tour: it aims at the tour's first stop (the subject).
    let ffmpegVisionDocument = visionMove && visionMove.document !== baseMotion ? visionMove.document : null
    if (ffmpegVisionDocument?.aim?.mode === 'tour') {
      ffmpegVisionDocument = { ...ffmpegVisionDocument, aim: { mode: 'subject', target: ffmpegVisionDocument.aim.target } }
      job.output_lines.push(`Scene ${i + 1}: Guided tour is drawn by the native renderer only; this scene rendered as Zoom to subject.`)
    }
    const vfParts = isVideoScene
      // crop-fill: scale up to cover the canvas, then centre-crop the overflow
      // (matches the B-Roll/Image-Pool fill behaviour). No Ken Burns.
      ? [`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`]
      : ffmpegVisionDocument
        ? compileSceneMotion(ffmpegVisionDocument, { w, h, fps: quality.fps, duration: renderDuration })
        : buildAnimationFilter({
          type: pickedType,
          params: sceneAnimation,
          library: motionLibrary,
          sceneIndex: i,
          w, h,
          fps: quality.fps,
          // Pace Ken Burns over the FULL rendered length (window + xfade
          // tail) so motion continues smoothly through a dissolve instead
          // of freezing on the overlap.
          duration: renderDuration,
        })

    // The camera move alone, for carrying a living picture's outline through it.
    const cameraVf = [...vfParts, 'format=yuv420p']
    // Follow narration plays once, then holds the last frame through its window and xfade tail.
    // Pad before overlays so their timing continues normally over the held frame.
    if (holdVideo) vfParts.push(`tpad=stop_mode=clone:stop_duration=${renderDuration}`)

    // Chapter title overlay. v1.0.56+ optionally animates entry via
    // drawtext's `alpha=` (fade) or `x=` / `y=` (slide) expressions.
    // The legacy `animation: 'none'` (or missing field) emits exactly
    // the same filtergraph string the pre-animation pipeline produced
    // so older projects render byte-identically. See
    // VideoChapterTitles.animation in types.ts for preset semantics.
    if (canDrawtext && chapterTitles?.enabled && scene.title && scene.show_title) {
      // Size against the SHORT edge (identical to `h` on any landscape canvas),
      // position against the height — a vertical fraction is still a vertical
      // fraction in portrait, but `h/18` is nearly twice too big there.
      const fontSize = getFontSize(chapterTitles.font_size, frameTextUnit(w, h))
      const yPos = getTextPosition(chapterTitles.position, h)
      const fontColor = getStyleColor(chapterTitles.style)
      const titleDur = chapterTitles.duration || 3
      const anim = chapterTitles.animation || 'none'
      // Cap the transition at duration/2 — a 1s fade-in plus 1s
      // fade-out can't fit inside a 1.5s title. Sane minimum 0.05s
      // avoids div-by-zero in the alpha/x/y expressions below.
      const animDur = Math.max(0.05, Math.min(
        chapterTitles.animation_duration ?? 0.5,
        titleDur / 2,
      ))
      const drawCommon = `text='${escapeDrawtext(scene.title)}':fontsize=${fontSize}:fontcolor=${fontColor}:enable='lt(t,${titleDur})':borderw=2:bordercolor=black@0.6`
      let drawXY = `x=(w-text_w)/2:y=${yPos}`
      let drawAlpha = ''
      switch (anim) {
        case 'fade-in-out': {
          // alpha 0→1 over animDur, hold, 1→0 over animDur. The
          // `enable=` gate above kills the drawtext past titleDur so
          // we don't have to worry about negative alpha clamping.
          drawAlpha = `:alpha='if(lt(t,${animDur.toFixed(3)}),t/${animDur.toFixed(3)},if(lt(t,${(titleDur - animDur).toFixed(3)}),1,(${titleDur.toFixed(3)}-t)/${animDur.toFixed(3)}))'`
          break
        }
        case 'slide-from-left': {
          // Start offscreen-left (x = -text_w), lerp to centered.
          // After animDur, hold at center until enable= hides it.
          drawXY = `x='if(lt(t,${animDur.toFixed(3)}),-text_w+((w+text_w)/2)*(t/${animDur.toFixed(3)}),(w-text_w)/2)':y=${yPos}`
          break
        }
        case 'slide-from-right': {
          // Start offscreen-right (x = w), lerp to centered.
          drawXY = `x='if(lt(t,${animDur.toFixed(3)}),w-((w+text_w)/2)*(t/${animDur.toFixed(3)}),(w-text_w)/2)':y=${yPos}`
          break
        }
        case 'slide-up': {
          // Start below the frame (y = h), lerp upward to yPos.
          // yPos may be a literal (e.g. '86') or an expression (e.g.
          // '(h-text_h)/2') — both substitute fine.
          drawXY = `x=(w-text_w)/2:y='if(lt(t,${animDur.toFixed(3)}),h-(h-(${yPos}))*(t/${animDur.toFixed(3)}),${yPos})'`
          break
        }
        case 'none':
        default:
          // No animation — leave drawXY at static center+yPos and
          // drawAlpha empty so the emitted string matches the
          // pre-v1.0.56 output exactly.
          break
      }
      vfParts.push(`drawtext=${drawCommon}:${drawXY}${drawAlpha}`)
    }

    vfParts.push('format=yuv420p')

    // Explicit bt709 color tagging to match prepareTitleClip, prepareOutroClip
    // and commonPostArgs. Without this, scene clips emit "unspecified" color
    // metadata while the post-audio / outro segments emit bt709 — the
    // stream-copy concat into intermediate_video.mp4 then carries a tag
    // switch mid-file, which libx265 rejects at final composition init with
    // exit code 183 / return code -22 (EINVAL).
    // Stills loop a single frame (`-loop 1`); video scenes stream-loop the
    // source so a clip shorter than `duration` repeats to fill it, and the
    // trailing `-t` trims a longer clip — either way the output is exactly
    // `duration` seconds, keeping it interchangeable with a still scene.
    //
    // v1.0.415+ — B-roll natural-length mode: when on, `duration` is already the
    // clip's own probed length, so we DON'T stream-loop (a probe that overshoots
    // the real length by a hair would otherwise wrap back to a stuttered
    // restart). The clip just plays once to its own end; the trailing `-t` is a
    // harmless safety cap.
    const naturalVideo = isVideoScene && !!recycling.broll_natural_duration
    // v1.0.515 — two wedge-killers for still scenes:
    //   1. Pin the REAL decoder from magic bytes (most scene "PNGs" are JPEG;
    //      FFmpeg 8 picks the decoder by extension and `-loop 1` then retries
    //      the failed decode FOREVER — the "stuck at 1/160" hang).
    //   2. zoompan-based animations get the image ONCE (no -loop): zoompan
    //      builds the whole clip from a single frame; looping made ffmpeg
    //      re-decode + supersample-upscale the same image ~25×duration times.
    const stillDecoder = isVideoScene ? [] : await stillDecoderArgs(scene.image_path)
    // v1.4.360 — ENCODE ONCE. A motion clip that already has this render's exact shape (canvas,
    // frame rate, pixel format, colour tags and duration) is copied, not decoded, rescaled and
    // re-encoded. That is what keeps a clips-heavy episode near a stills-only one. A clip that
    // does not match falls through to the FFmpeg chain below exactly as before, so the slow path
    // is still there for every shape a provider returns.
    if (isVideoScene && !wantsChapterTitle && !naturalVideo && !holdVideo) {
      const problems = sceneClipCompatibilityProblems(
        await probeVideoStream(scene.image_path), { w, h, fps: quality.fps, duration: renderDuration })
      if (problems.length === 0) {
        await fs.copyFile(scene.image_path, clipPath)
        await completePlainClip(`${tagLog} [copied: already in render shape]`)
        return
      }
    }
    const singleFrameStill = !isVideoScene && (ffmpegVisionDocument
      ? ffmpegVisionDocument.spin.rate_rad_per_sec === 0 && (ffmpegVisionDocument.zoom.mode !== 'none' || ffmpegVisionDocument.pan.mode !== 'none')
      : isZoompanAnimation(pickedType, motionLibrary))
    const inputArgs = isVideoScene
      ? (naturalVideo || holdVideo
          ? ['-i', scene.image_path]
          : ['-stream_loop', '-1', '-i', scene.image_path])
      : singleFrameStill
        ? [...stillDecoder, '-i', scene.image_path]
        : [...stillDecoder, '-loop', '1', '-t', renderDuration.toString(), '-i', scene.image_path]
    const args = [
      '-y', ...inputArgs,
      '-vf', vfParts.join(','),
      // Exact output duration (window + optional xfade tail), bt709 tags (see above).
      ...sceneClipEncodeArgs(quality.crf, quality.fps, renderDuration),
      clipPath,
    ]

    // Hard per-clip ceiling: a healthy clip renders in seconds; only a genuine
    // wedge (bad input, dead disk) trips this — fail THAT scene loudly instead
    // of hanging the whole job silently.
    await (recovery?.encodeSceneClip || runFfmpeg)(args, { timeoutMs: 10 * 60_000 })
    const living = await drawSceneStage(async (maskPng, maskOut) => {
      const maskInput = singleFrameStill ? ['-i', maskPng] : ['-loop', '1', '-t', renderDuration.toString(), '-i', maskPng]
      await runFfmpeg(['-y', ...maskInput, '-vf', cameraVf.join(','), ...sceneClipEncodeArgs(12, quality.fps, renderDuration), maskOut], { timeoutMs: 10 * 60_000 })
    })
    await completePlainClip(`${tagLog}${living}`)
  }

  // Worker pool over scene indices. An error in any scene aborts the pool and
  // surfaces WITH the scene number + file so the user knows what to fix.
  {
    let nextIndex = 0
    const workers = Array.from({ length: Math.min(PREP_CONCURRENCY, scenes.length) }, async () => {
      while (true) {
        const i = nextIndex++
        if (i >= scenes.length) return
        // Cancel kills the running clip encoders; the other workers must not pick up the next scene.
        if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
        try {
          await prepOne(i)
        } catch (e: any) {
          throw new Error(`Scene ${i + 1}/${scenes.length}: ${e?.message || e}`, { cause: e })
        }
      }
    })
    await Promise.all(workers)
  }

  if (nativeOn) {
    const reasons = [...nativeTally.reasons.entries()].map(([reason, count]) => `${count}x ${reason}`).join('; ')
    job.output_lines.push(
      `Scene clips: ${nativeTally.native} native, ${nativeTally.fallback} FFmpeg fallback`
      + `${reasons ? ` (${reasons})` : ''}.`,
    )
  }

  return clipPaths
}

// ── Prepare Title Clip ────────────────────────────────────────────────────

async function prepareTextCardClip(
  card: VideoTitleCard | VideoOutroCard,
  kind: 'title' | 'outro',
  w: number,
  h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, `${kind}_text_card.mp4`)
  const duration = Math.max(1, Number(card.duration) || (kind === 'title' ? 5 : 4))
  const mediaPath = String(card.background_media_path || '')
  const hasMedia = mediaPath && checkAssetAvailability(mediaPath, `${kind}_card.background_media_path`).status === 'available'
  const args: string[] = ['-y']
  const filters: string[] = []

  if (hasMedia) {
    args.push(...(await buildLoopingMediaInputArgs(mediaPath)))
    filters.push(...normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps=')))
  } else {
    const backgroundName = 'background' in card ? String(card.background || 'black') : 'black'
    const color = backgroundName === 'gradient' ? '#111827'
      : backgroundName === 'dark_blur' ? '#101014'
        : backgroundName === 'black' ? 'black' : backgroundName
    args.push('-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:r=${quality.fps}:d=${duration}`)
    filters.push('setsar=1')
    if (mediaPath) job.output_lines.push(`Text ${kind} card background is unavailable; using ${color}.`)
  }

  const textColor = getStyleColor(card.style || 'white')
  // v1.4.15 — sized against the frame's SHORT edge. `h` was the short edge on
  // every canvas that existed before this release, so 16:9 output is unchanged;
  // in portrait, `h` is the long edge and a title at 7.5% of it overflowed the
  // frame sideways.
  const mainSize = Math.max(32, Math.round(frameTextUnit(w, h) * (kind === 'title' ? 0.075 : 0.06)))
  // The gap between title and subtitle now scales with the type it separates.
  // It used to be a flat 40px above centre and 45px below, which was tuned at
  // 1080p and was already wrong at 4K — the type tripled and the gap did not.
  // At 1080p these still compute to 41 and 45, so the pinned look is preserved.
  const gapAbove = Math.round(mainSize * 0.5)
  const gapBelow = Math.round(mainSize * 0.55)
  const mainY = kind === 'title' && 'subtitle' in card && card.subtitle
    ? `(h-text_h)/2-${gapAbove}`
    : '(h-text_h)/2'
  filters.push(
    `drawtext=text='${escapeDrawtext(card.text || '')}':fontsize=${mainSize}:fontcolor=${textColor}:` +
    `borderw=2:bordercolor=black@0.65:x=(w-text_w)/2:y=${mainY}`,
  )
  if (kind === 'title' && 'subtitle' in card && card.subtitle?.trim()) {
    filters.push(
      `drawtext=text='${escapeDrawtext(card.subtitle)}':fontsize=${Math.max(22, Math.round(mainSize * 0.48))}:` +
      `fontcolor=white:borderw=1:bordercolor=black@0.65:x=(w-text_w)/2:y=(h/2)+${gapBelow}`,
    )
  }
  filters.push('format=yuv420p')
  args.push(
    '-vf', filters.join(','), '-t', duration.toString(),
    '-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast',
    '-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an', clipPath,
  )
  job.output_lines.push(
    `Preparing ${kind} text card (${duration}s${hasMedia ? ` · ${path.basename(mediaPath)}` : ''})`,
  )
  await runFfmpeg(args)
  return clipPath
}

async function prepareTitleClip(
  titleImage: VideoTitleImageConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'title_scene.mp4')
  const duration = typeof titleImage.duration === 'number' && titleImage.duration > 0 ? titleImage.duration : 5

  job.output_lines.push(`Preparing title image clip (${duration}s)`)

  // Use the shared `normalizeFrame` chain — same one every other clip in
  // the concat list uses (scene xfade chunks, intro, post-audio). Keeps
  // SAR / pixel-format / colour primaries in lockstep so `concat -c copy`
  // renders the title correctly. Historically this was a hand-rolled chain
  // that hit the FFmpeg 8.1 `pad=…:color=black,setsar=1` adjacency bug and
  // caused the title to silently drop from output. `-r quality.fps` handles output
  // frame rate, so we strip the `fps=` token from the chain (same trick
  // `prepareIntroClip` uses).
  const titleVf = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  const inputArgs = await buildTitleMediaInputArgs(titleImage.image_path)

  const args = [
    '-y', ...inputArgs,
    '-vf', titleVf.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-t', duration.toString(),
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

/**
 * Title assets normally come from still thumbnails, but B-Roll projects may
 * auto-seed this field from a materialized scene video. FFmpeg's `-loop 1` is
 * an image-demuxer option and fails with "Option loop not found" for MP4/MOV.
 */
export async function buildTitleMediaInputArgs(mediaPath: string): Promise<string[]> {
  return buildLoopingMediaInputArgs(mediaPath)
}

/**
 * Build a looping input for any visual asset that must fill a bounded output
 * duration. `-loop 1` belongs to still-image demuxers; video containers require
 * `-stream_loop -1`. The caller supplies the output `-t` safety cap.
 */
// v1.0.515 — async: sniffs the still's real decoder (JPEG-as-.png wedge fix).
export async function buildLoopingMediaInputArgs(mediaPath: string): Promise<string[]> {
  if (!isStaticImagePath(mediaPath)) return buildFinalInputArgs(mediaPath, { kind: 'loop_stream' })
  const decoderArgs = await stillDecoderArgs(mediaPath)
  return buildFinalInputArgs(mediaPath, { kind: 'loop_still', decoder: decoderArgs[1] ?? null })
}

export function isStaticImagePath(mediaPath: string): boolean {
  return isFinalRenderStaticImagePath(mediaPath)
}

export function computeXfadeTimelineDuration(
  durations: number[],
  transitionDuration: number,
  chunkSize: number,
): number {
  if (!durations.length) return 0
  const chunks = Math.ceil(durations.length / Math.max(2, chunkSize))
  const hardCuts = Math.max(0, chunks - 1)
  const xfades = Math.max(0, durations.length - 1 - hardCuts)
  return durations.reduce((sum, duration) => sum + duration, 0)
    - xfades * Math.max(0, transitionDuration)
}

export function extendDurationsForXfadeCoverage(
  initialDurations: number[],
  cycleDurations: number[],
  targetDuration: number,
  transitionDuration: number,
  chunkSize: number,
): number[] {
  const result = [...initialDurations]
  if (!cycleDurations.length || targetDuration <= 0) return result

  let added = 0
  while (computeXfadeTimelineDuration(result, transitionDuration, chunkSize) + 0.001 < targetDuration) {
    result.push(cycleDurations[added % cycleDurations.length]!)
    added++
    if (added > 10_000) throw new Error('Could not extend scene timeline to cover narration')
  }
  return result
}

export function fitSceneDurationsToTarget(
  inputDurations: number[],
  targetDuration: number,
  transitionDuration: number,
  chunkSize: number,
): number[] {
  const result = [...inputDurations]
  if (!result.length || targetDuration <= 0) return result

  while (
    result.length > 1
    && computeXfadeTimelineDuration(result.slice(0, -1), transitionDuration, chunkSize) >= targetDuration
  ) {
    result.pop()
  }

  const beforeLast = computeXfadeTimelineDuration(result.slice(0, -1), transitionDuration, chunkSize)
  const boundaryIsHardCut = result.length <= 1
    || Math.floor((result.length - 1) / Math.max(2, chunkSize)) > Math.floor((result.length - 2) / Math.max(2, chunkSize))
  const overlap = boundaryIsHardCut ? 0 : transitionDuration
  const requiredLastDuration = Math.max(
    overlap > 0 ? overlap + 0.1 : 0.5,
    targetDuration - beforeLast + overlap,
  )
  result[result.length - 1] = Math.min(result[result.length - 1]!, requiredLastDuration)
  return result
}

export type ScenePlayClip = { path: string; duration: number }

/**
 * v1.0.521 — pure scene-body planner, extracted from buildConcatList so the
 * ordering/duration/reuse contract is directly testable. Three modes:
 *
 *   1. PLAN-STRICT (scene-plan episodes): one entry per clip, plan order,
 *      exact per-scene durations. NO cycling and NO shuffle —
 *      the scene body mirrors scene_plan.json 1:1. If the plan total differs
 *      from the narration window by >2s a diagnostic line is emitted (a
 *      longer narration is covered by the post-audio fade/hold tail, never by
 *      repeating scenes).
 *   2. Legacy uniform cycling: the whole bag repeats until the narration
 *      window is filled; optional shuffle per cycle.
 *
 * `random` is injectable so shuffle behavior is deterministic under test.
 */
export function buildScenePlayOrder(opts: {
  availableClips: string[]
  availableDurations: number[]
  /** Uniform fallback seconds (recycling.seconds_per_scene). */
  sceneDuration: number
  /** Seconds of narration the scene body must cover (post-intro). */
  sceneFillDuration: number
  /** Sum of availableDurations — one full pass through the bag. */
  durationPerCycle: number
  shuffle: boolean
  planStrict: boolean
  random?: () => number
}): { scenePlayOrder: ScenePlayClip[]; logLines: string[] } {
  const {
    availableClips, availableDurations,
    sceneDuration, sceneFillDuration, durationPerCycle,
    shuffle, planStrict,
  } = opts
  const random = opts.random ?? Math.random
  const scenePlayOrder: ScenePlayClip[] = []
  const logLines: string[] = []

  // Mode 1 — plan-strict: the scene body IS the plan. Nothing cycles.
  if (planStrict) {
    for (let i = 0; i < availableClips.length; i++) {
      scenePlayOrder.push({ path: availableClips[i]!, duration: availableDurations[i] ?? sceneDuration })
    }
    const total = scenePlayOrder.reduce((sum, c) => sum + c.duration, 0)
    if (Math.abs(total - sceneFillDuration) > 2) {
      logLines.push(
        `Scene Plan strict: plan total ${total.toFixed(1)}s vs narration window ${sceneFillDuration.toFixed(1)}s — ` +
        (total < sceneFillDuration
          ? 'the post-audio tail (fade/hold) covers the remainder; scenes are NOT repeated.'
          : 'the video keeps every planned scene; any excess past the target is clipped at the end.'),
      )
    }
    return { scenePlayOrder, logLines }
  }

  const cyclesNeeded = Math.max(1, Math.ceil(sceneFillDuration / durationPerCycle))
  for (let cycle = 0; cycle < cyclesNeeded; cycle++) {
    let cycleClips = [...availableClips]
    if (shuffle) {
      for (let i = cycleClips.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [cycleClips[i], cycleClips[j]] = [cycleClips[j], cycleClips[i]]
      }
    }
    for (const clip of cycleClips) {
      const originalIdx = availableClips.indexOf(clip)
      scenePlayOrder.push({ path: clip, duration: availableDurations[originalIdx] || sceneDuration })
    }
  }

  return { scenePlayOrder, logLines }
}

// ── Prepare Intro Clip (re-encode to match resolution) ────────────────────

async function prepareOutroClip(
  outro: VideoOutroConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'outro.mp4')

  job.output_lines.push('Preparing outro video clip')

  // Same encode pipeline as prepareIntroClip — shared normalizeFrame so the
  // outro slots cleanly into the concat list without SAR / pixel-format
  // drift, and explicit colour tagging matching the post-audio clips.
  const outroFrame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  const args = [
    '-y',
    '-i', outro.video_path,
    '-vf', outroFrame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

/**
 * Normalise a user-supplied timeline clip to match the output resolution,
 * fps, and colour metadata so it can slot into the stream-copy concat list
 * alongside intro/outro/scene clips without SAR / pixel-format / colour
 * mismatches. Effectively the intro/outro prep path generalised for N
 * clips — the `idx` is only used to keep tempDir filenames unique.
 */
async function prepareTimelineClip(
  clip: VideoTimelineClip,
  idx: number,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  // Dispatch by source kind. Static = synthesised from a single image
  // (cheap to encode, ~1% the disk size of an equivalent pre-rendered
  // video). Video = re-encode the user's MP4 (the legacy path).
  if (clip.kind === 'static') {
    return prepareStaticTimelineClip(clip, idx, w, h, quality, tempDir, job)
  }

  const clipPath = path.join(tempDir, `timeline_${clip.anchor}_${idx}.mp4`)

  job.output_lines.push(`Preparing timeline clip [${clip.anchor}] #${idx + 1}`)

  const frame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  const args = [
    '-y',
    '-i', clip.video_path,
    '-vf', frame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

/**
 * Synthesise a timeline clip from a single still image + duration.
 * Replaces the workflow where users pre-rendered multi-hour static
 * MP4s in a video editor and dropped them into the timeline.
 *
 * Speed wins are dramatic for sleep-story-style tails:
 *   - `-loop 1 -i image.jpg -t <dur>` repeats the image at fps from
 *     the encoder's perspective (no per-frame decoding cost).
 *   - `-tune stillimage` tells libx264 to optimise rate-distortion
 *     for unchanging frames — the encoder emits one keyframe and
 *     effectively-empty P-frames.
 *   - The intermediate file ends up tiny (≈10-20 MB for 2 hours of
 *     1080p static, vs ≈2 GB for a re-encoded pre-rendered MP4).
 *   - Wall-clock prep is dominated by output muxing, not encoding.
 *
 * Audio is stripped (`-an`) like every other timeline clip — the
 * post-narration ambient/music tail comes from the separate `music`
 * config which already loops via `-stream_loop -1`.
 */
async function prepareStaticTimelineClip(
  clip: VideoTimelineClipStatic,
  idx: number,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, `timeline_static_${clip.anchor}_${idx}.mp4`)

  const minutes = (clip.duration_sec / 60).toFixed(1)
  job.output_lines.push(
    `Preparing static timeline clip [${clip.anchor}] #${idx + 1} (${minutes} min from single image)`,
  )

  const frame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  // -loop 1 + -t bracket the still image as a duration-bounded source.
  // Putting -t BEFORE -i sets the input duration limit; the muxer then
  // emits exactly that many seconds of frames at -r quality.fps.
  // -tune stillimage is libx264-only — we deliberately don't expose a
  // hardware path here because videotoolbox doesn't accept tune, and
  // libx264 ultrafast on a still image is already near-instant
  // (encoder-bound on output muxing, not ratecontrol).
  const args = [
    '-y',
    ...(await stillDecoderArgs(clip.image_path)), '-loop', '1', '-t', clip.duration_sec.toString(), '-i', clip.image_path,
    '-vf', frame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast',
    '-tune', 'stillimage',
    '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

async function prepareIntroClip(
  intro: VideoIntroConfig,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
  job: Job,
): Promise<string> {
  const clipPath = path.join(tempDir, 'intro.mp4')

  job.output_lines.push('Preparing intro video clip')

  // Strip audio — all concat clips must be video-only (audio comes from pre-mix).
  // normalizeFrame keeps this chain in lockstep with every other clip's frame
  // shape so concat/xfade don't hit size/SAR mismatches. Intro doesn't need
  // the fps token inside the -vf because `-r quality.fps` downstream sets output fps;
  // dropping the fps token keeps the chain short.
  const introFrame = normalizeFrame(w, h, quality.fps).filter(f => !f.startsWith('fps='))
  if (intro.duration && intro.duration > 0) {
    introFrame.push(`tpad=stop_mode=clone:stop_duration=${intro.duration}`)
  }
  // Same bt709 tagging rationale as prepareSceneClips: every segment in the
  // stream-copy concat must agree on colour metadata or libx265 rejects the
  // intermediate at final composition init (EINVAL). prepareTitleClip and
  // prepareOutroClip already emit these; intro is the remaining outlier.
  const args = [
    '-y',
    '-i', intro.video_path,
    '-vf', introFrame.join(','),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    ...(intro.duration && intro.duration > 0 ? ['-t', intro.duration.toFixed(3)] : []),
    '-an',
    clipPath,
  ]

  await runFfmpeg(args)
  return clipPath
}

// ── Prepare Music Track ───────────────────────────────────────────────────

async function prepareMusicTrack(
  music: VideoMusicConfig,
  tempDir: string,
  job: Job,
): Promise<string> {
  // Validate all music files exist
  const validFiles = music.files.filter(f => existsSync(f))
  if (validFiles.length === 0) {
    throw new Error('No valid music files found')
  }

  job.output_lines.push(`Preparing music track (${validFiles.length} file(s))`)

  if (validFiles.length === 1) {
    // Single file — just return it directly, will be looped in final pass
    return validFiles[0]
  }

  // Multiple files — concatenate them into one track with normalized sample rate
  const musicListPath = path.join(tempDir, 'music_list.txt')
  const { files: concatInputs, reencoded } = await homogenizeForConcat(validFiles, path.join(tempDir, 'music_norm'))
  if (reencoded) job.output_lines.push(`Music files differ in format; re-encoded ${reencoded} to one format so none are dropped`)
  const lines = concatInputs.map(f => formatConcatFileLine(f))
  await fs.writeFile(musicListPath, lines.join('\n') + '\n')

  const concatenatedPath = path.join(tempDir, 'music_concat.mp3')
  const args = [
    '-y',
    '-f', 'concat', '-safe', '0',
    '-i', musicListPath,
    '-af', 'aresample=44100',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    concatenatedPath,
  ]

  await runFfmpeg(args)
  return concatenatedPath
}

// ── Prepare Narration with Gaps Between Chapters ─────────────────────────

export async function prepareNarrationWithGaps(
  chapterPaths: string[],
  gapSeconds: number,
  tempDir: string,
  job: Job,
): Promise<string> {
  const validChapters = chapterPaths.filter(f => existsSync(f))
  if (validChapters.length === 0) {
    throw new Error('No valid narration chapter files found')
  }

  job.output_lines.push(`Preparing narration: ${validChapters.length} chapters with ${gapSeconds}s gaps`)

  if (validChapters.length === 1 && gapSeconds <= 0) {
    return validChapters[0]
  }

  // Create a silence audio file for the gap
  let silenceFile: string | undefined
  if (gapSeconds > 0) {
    silenceFile = path.join(tempDir, 'chapter_silence.mp3')
    await runFfmpeg([
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', gapSeconds.toString(),
      '-c:a', 'libmp3lame', '-b:a', '128k',
      silenceFile,
    ])
  }

  // Build concat list: chapter1 → silence → chapter2 → silence → chapter3 ...
  const listPath = path.join(tempDir, 'narration_list.txt')
  const items: string[] = []
  for (let i = 0; i < validChapters.length; i++) {
    items.push(validChapters[i])
    // Insert silence between chapters (not after the last one)
    if (i < validChapters.length - 1 && silenceFile) items.push(silenceFile)
  }
  // Imported chapters can be WAV/M4A bytes under an .mp3 name; the concat demuxer would read them
  // (and the MP3 silence) with the first file's codec and silently drop the rest.
  const { files: concatItems, reencoded } = await homogenizeForConcat(items, path.join(tempDir, 'narration_norm'))
  if (reencoded) job.output_lines.push(`Narration files differ in format; re-encoded ${reencoded} to one format so none are dropped`)
  const lines = concatItems.map(formatConcatFileLine)

  await fs.writeFile(listPath, lines.join('\n') + '\n')

  // Concatenate into single narration file
  const outputPath = path.join(tempDir, 'narration_with_gaps.mp3')
  await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0',
    '-i', listPath,
    '-af', 'aresample=44100',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    outputPath,
  ])

  job.output_lines.push(`Narration assembled: ${validChapters.length} chapters`)
  return outputPath
}

// ── Build Concat List ─────────────────────────────────────────────────────

async function buildConcatList(
  tempDir: string,
  introClipPath: string | undefined,
  titleClipPath: string | undefined,
  sceneClips: string[],
  targetDuration: number,
  narrationDuration: number,
  postAudio: VideoPostAudio,
  recycling: VideoSceneRecycling,
  w: number, h: number,
  quality: { crf: number; preset: string; fps: number },
  job: Job,
  sceneClipDurations?: number[],
  /** Optional scene-to-scene transition settings. When the primary id resolves
   * to a real xfade keyword, the scene clips are pre-xfaded into a single
   * intermediate MP4 (replacing N lines in the concat list with one). */
  transitionOpts?: {
    primaryId: string
    pool: string[]
    randomizeMode: 'off' | 'single' | 'per-scene'
    durationSec: number
    seed?: number
  },
  outroClipPath?: string,
  /** User-supplied clips bucketed by anchor. Each bucket is emitted in
   *  order at its named position. Buckets that are empty are no-ops, so
   *  callers that don't use timeline clips can pass `undefined`. */
  timelineClipsByAnchor?: Record<TimelineAnchor, Array<{ path: string; duration: number }>>,
  /** v1.0.521 — plan-strict mode (scene-plan episode with every scene
   *  matched to a plan id): plan-exact order + durations, no cycling /
   *  shuffle / chapter-align / fit-trim; xfades are window-anchored (the
   *  prepared clips carry a +transition tail) so transitions never eat
   *  into a scene's planned window. */
  planStrict?: boolean,
  minimumDurationSec = MIN_RENDERABLE_SCENE_SEC,
): Promise<{ listPath: string; sceneEndTime: number }> {
  const listPath = path.join(tempDir, 'concat_list.txt')
  const lines: string[] = []
  const esc = formatConcatFileLine

  let accumulatedDuration = 0
  const sceneDuration = recycling.seconds_per_scene || 10

  // Empty default buckets so downstream reads don't have to guard `undefined`.
  const buckets = timelineClipsByAnchor ?? {
    before_intro: [],
    after_intro: [],
    after_scenes: [],
    after_outro: [],
  }

  // Bucket 1 of 4 — before_intro: very start of the video.
  for (const c of buckets.before_intro) {
    lines.push(esc(c.path))
    accumulatedDuration += c.duration
  }

  // Add intro
  if (introClipPath) {
    lines.push(esc(introClipPath))
    const introDur = await getAudioDuration(introClipPath)
    accumulatedDuration += introDur || 5
  }

  // Add title image clip
  if (titleClipPath) {
    lines.push(esc(titleClipPath))
    // v1.0.423 — probe the title clip's REAL duration instead of assuming 5s.
    // The sleep-story intro hold can set a long title (e.g. 60s+); the old
    // hardcoded 5 mis-placed the effect gate (preSceneDuration tracker) for any
    // non-5s title. Mirrors how the intro clip's duration is probed above.
    const titleDur = await getAudioDuration(titleClipPath)
    accumulatedDuration += titleDur || 5
  }

  // Bucket 2 of 4 — after_intro: after intro/title, before the first scene.
  // Treated as "pre-scene" content that the effect gate must skip over,
  // which is why its duration is added to `accumulatedDuration` (the gate
  // start tracker) — matches how intro/title contribute above.
  for (const c of buckets.after_intro) {
    lines.push(esc(c.path))
    accumulatedDuration += c.duration
  }

  // Filter out excluded scenes — excluded_scenes contains 1-based scene numbers
  const excludedSet = new Set(planStrict ? [] : (recycling.excluded_scenes || []))
  const availableClips = sceneClips.filter((_, idx) => !excludedSet.has(idx + 1))
  const availableDurations = (sceneClipDurations || sceneClips.map(() => sceneDuration))
    .filter((_, idx) => !excludedSet.has(idx + 1))
    .map(d => (Number.isFinite(d) && d > 0 ? Math.max(minimumDurationSec, d) : sceneDuration))
  if (availableClips.length === 0) {
    throw new Error('No scene clips available after applying exclusions')
  }

  const behavior = postAudio.behavior || 'fade-to-black'
  const clipsPerCycle = availableClips.length
  const durationPerCycle = availableDurations.reduce((sum, d) => sum + d, 0)

  // Determine how long scenes should play:
  // - 'continue-cycling': scenes fill the entire target duration (original behavior)
  // - All others: scenes fill up to narration duration, then post-audio fills the rest
  const sceneFillDuration = behavior === 'continue-cycling'
    ? targetDuration - accumulatedDuration
    : Math.max(0, narrationDuration - accumulatedDuration)

  // Build the sequential list of scene clip paths.
  //
  // Scene Plan runs 1:1; classic pools retain uniform cycling.
  // v1.0.521 — the ordering/duration/reuse decision lives in the exported
  // pure planner (buildScenePlayOrder) so tests can pin the contract:
  // plan-strict = plan-exact 1:1; classic = uniform bag cycling.
  const planned = buildScenePlayOrder({
    availableClips,
    availableDurations,
    sceneDuration,
    sceneFillDuration,
    durationPerCycle,
    shuffle: !!recycling.shuffle,
    planStrict: !!planStrict,
  })
  const scenePlayOrder = planned.scenePlayOrder
  for (const line of planned.logLines) job.output_lines.push(line)

  // Decide whether to pre-xfade the scenes into a single fused MP4.
  // Pre-xfade runs only when: more than one clip, a primary transition was
  // picked, and that transition resolves to a known xfade keyword.
  const primaryTransition = transitionOpts ? getTransition(transitionOpts.primaryId) : null
  const xfadeEnabled = !!(transitionOpts && primaryTransition && primaryTransition.xfade && scenePlayOrder.length >= 2)

  // Hard limit on how many scene clips we pass to a single FFmpeg xfade
  // invocation. FFmpeg opens one decoder per input, and macOS's soft fd
  // limit caps the process around 256 simultaneous inputs. Long sleep
  // stories can need 300+ clips after cycling to fill narration duration,
  // so we split the xfade into chunks and stream-copy the chunks together.
  //
  // Trade-off: one hard cut per chunk boundary. For a 3h video that's
  // ≤8 hard cuts across 350+ scene boundaries — imperceptible in practice.
  // Tunable via env var for machines with raised ulimits.
  const XFADE_CHUNK_SIZE = Math.max(
    2,
    Math.min(
      parseInt(process.env.STORY_STUDIO_XFADE_CHUNK_SIZE || '48', 10) || 48,
      128,
    ),
  )

  // v1.0.521 — coverage-extension and fit-trim are RECYCLING mechanisms:
  // they add repeated clips (reuse!) or drop/trim clips to make a cycled bag
  // meet the narration window. In plan-strict mode the scene body is the plan
  // verbatim — never extended with repeats, never trimmed to fit — so both
  // blocks are skipped. Plan-mode xfades are window-anchored instead (the
  // prepared clips carry a +transition tail; see the chunk loop below).
  if (!planStrict && xfadeEnabled && transitionOpts) {
    const shortestClip = Math.min(...scenePlayOrder.map(c => c.duration))
    const effectiveTransitionDuration = Math.min(
      transitionOpts.durationSec,
      Math.max(0.1, shortestClip - 0.1),
    )
    const coveredDurations = extendDurationsForXfadeCoverage(
      scenePlayOrder.map(c => c.duration),
      availableDurations,
      sceneFillDuration,
      effectiveTransitionDuration,
      XFADE_CHUNK_SIZE,
    )
    const added = coveredDurations.length - scenePlayOrder.length
    for (let i = 0; i < added; i++) {
      const idx = i % availableClips.length
      scenePlayOrder.push({
        path: availableClips[idx]!,
        duration: availableDurations[idx] || sceneDuration,
      })
    }
    if (added > 0) {
      job.output_lines.push(
        `Transition coverage: added ${added} scene clip(s) so crossfade overlaps do not end visuals before narration.`,
      )
    }
  }

  const effectiveTransitionDuration = xfadeEnabled && transitionOpts
    ? Math.min(
        transitionOpts.durationSec,
        Math.max(0.1, Math.min(...scenePlayOrder.map(c => c.duration)) - 0.1),
      )
    : 0
  if (!planStrict) {
    const fittedDurations = fitSceneDurationsToTarget(
      scenePlayOrder.map(c => c.duration),
      sceneFillDuration,
      effectiveTransitionDuration,
      XFADE_CHUNK_SIZE,
    )
    if (fittedDurations.length < scenePlayOrder.length) {
      const removed = scenePlayOrder.length - fittedDurations.length
      scenePlayOrder.splice(fittedDurations.length)
      job.output_lines.push(`Timeline fit: removed ${removed} surplus repeated scene clip(s).`)
    }
    const finalIdx = fittedDurations.length - 1
    const fittedFinalDuration = fittedDurations[finalIdx]
    if (finalIdx >= 0 && fittedFinalDuration != null) {
      const finalClip = scenePlayOrder[finalIdx]!
      if (fittedFinalDuration + 0.01 < finalClip.duration) {
        finalClip.path = await trimPreparedSceneClip(
          finalClip.path,
          fittedFinalDuration,
          quality,
          tempDir,
        )
        finalClip.duration = fittedFinalDuration
        job.output_lines.push(
          `Timeline fit: trimmed final scene to ${fittedFinalDuration.toFixed(2)}s so the post-audio tail starts after narration.`,
        )
      }
    }
  }

  const totalClips = scenePlayOrder.length
  const totalScenePlayDuration = scenePlayOrder.reduce((sum, clip) => sum + clip.duration, 0)
  const lastPlayedSceneClip = scenePlayOrder[scenePlayOrder.length - 1]?.path

  let xfadeHardCuts = 0
  if (xfadeEnabled && transitionOpts) {
    const shortestClip = Math.min(...scenePlayOrder.map(c => c.duration))
    const effectiveTransitionDuration = Math.min(
      transitionOpts.durationSec,
      Math.max(0.1, shortestClip - 0.1),
    )
    const safeTransitionOpts = { ...transitionOpts, durationSec: effectiveTransitionDuration }
    if (Math.abs(effectiveTransitionDuration - transitionOpts.durationSec) > 0.001) {
      job.output_lines.push(
        `Transition duration clamped from ${transitionOpts.durationSec.toFixed(2)}s to ` +
        `${effectiveTransitionDuration.toFixed(2)}s for short timestamp scene clips.`,
      )
    }
    const plan = planTransitions({
      clipCount: totalClips,
      durationSec: safeTransitionOpts.durationSec,
      primaryId: safeTransitionOpts.primaryId,
      pool: safeTransitionOpts.pool,
      randomizeMode: safeTransitionOpts.randomizeMode,
      seed: safeTransitionOpts.seed,
    })

    // Split the play order into chunks of at most XFADE_CHUNK_SIZE clips.
    // Each chunk becomes one FFmpeg invocation with its own filter graph.
    const chunks: ScenePlayClip[][] = []
    for (let i = 0; i < scenePlayOrder.length; i += XFADE_CHUNK_SIZE) {
      chunks.push(scenePlayOrder.slice(i, i + XFADE_CHUNK_SIZE))
    }
    xfadeHardCuts = Math.max(0, chunks.length - 1)

    job.output_lines.push(
      `Xfading ${totalClips} scene clips with transition=${transitionOpts.primaryId} ` +
      `(${plan.durationSec}s)` +
      (transitionOpts.randomizeMode !== 'off' ? ` [randomize=${transitionOpts.randomizeMode}]` : '') +
      (chunks.length > 1 ? ` in ${chunks.length} chunks of ≤${XFADE_CHUNK_SIZE} (${xfadeHardCuts} hard cuts)` : '')
    )

    // E1 — ink / watercolour bleed mattes, baked once per episode at the transition length. A bake
    // that fails makes those boundaries plain crossfades (said once), never a failed render.
    const mattes = new Map<string, string | null>()
    for (const id of new Set(plan.ids ?? [])) {
      const bleed = getTransition(id)?.bleed
      if (!bleed || mattes.has(bleed)) continue
      try {
        mattes.set(bleed, await bakeTransitionMatte(bleed, w, h, quality.fps, plan.durationSec))
      } catch (error: any) {
        mattes.set(bleed, null)
        job.output_lines.push(`Transitions: the ${bleed} bleed could not be prepared (${String(error?.message || error).split('\n')[0]}); those scene changes are plain crossfades.`)
      }
    }
    if (plan.ids) {
      const used = [...new Set(plan.ids)].filter(id => getTransition(id)?.engine).map(id => getTransition(id)!.label)
      job.output_lines.push(`Transitions drawn by Story's own engine: ${used.join(', ')}.`)
    }

    // Walk the global plan, slicing out (chunk.length - 1) keywords per chunk.
    // The 1 keyword between each pair of chunks is consumed by the hard cut
    // at the chunk boundary — not rendered, just skipped in the pointer.
    let keywordCursor = 0
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c]
      const chunkPath = path.join(tempDir, `scenes_xfaded_${String(c).padStart(2, '0')}.mp4`)
      // v1.0.521 — plan-strict: each prepared clip physically carries a
      // +transition tail (rendered D_i + T long; see prepareSceneClips), so
      // feeding the EXTENDED lengths to the offset math anchors every
      // dissolve at the plan boundary (offset_i = ΣD_0..i) and no scene's
      // window is eaten. The chunk is then capped at ΣD (its window sum) to
      // trim the final clip's tail overshoot. Non-plan mode keeps the legacy
      // behavior (windows shrink by T per boundary, compensated upstream by
      // recycled coverage clips).
      const chunkWindowSum = chunk.reduce((sum, o) => sum + o.duration, 0)

      if (chunk.length === 1) {
        if (planStrict) {
          // Singleton clip still carries the +T tail — re-encode with a hard
          // -t cap so the chunk is exactly its planned window.
          await runFfmpeg([
            '-y', '-i', chunk[0]!.path,
            '-t', chunkWindowSum.toFixed(3),
            '-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast',
            '-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-an', chunkPath,
          ])
        } else {
          // A singleton chunk can't xfade anything. Stream-copy it so the
          // output has a stable filename and the concat list shape is uniform.
          await runFfmpeg(['-y', '-i', chunk[0]!.path, '-c:v', 'copy', '-an', chunkPath])
        }
      } else {
        const internalBoundaries = chunk.length - 1
        const keywordsForChunk = plan.xfadeKeywords.slice(keywordCursor, keywordCursor + internalBoundaries)
        const chunkDurations = planStrict
          ? chunk.map(o => o.duration + plan.durationSec)
          : chunk.map(o => o.duration)
        const variableDurations = planStrict || chunkDurations.some(d => Math.abs(d - sceneDuration) > 0.01)
        const idsForChunk = plan.ids?.slice(keywordCursor, keywordCursor + internalBoundaries)
        const plainFilter = (keywords: string[]) => variableDurations
          ? buildVariableXfadeFilterComplex({
              inputDurations: chunkDurations,
              transitionDuration: plan.durationSec,
              xfadeKeywords: keywords,
            })
          : buildXfadeFilterComplex({
              inputCount: chunk.length,
              clipDuration: sceneDuration,
              transitionDuration: plan.durationSec,
              xfadeKeywords: keywords,
            })
        const runChunk = async (filter: string, extraInputs: string[]) => {
          const args: string[] = ['-y']
          for (const clip of chunk) args.push('-i', clip.path)
          for (const extra of extraInputs) args.push('-i', extra)
          args.push('-filter_complex', filter)
          args.push('-map', '[vout]')
          if (planStrict) args.push('-t', chunkWindowSum.toFixed(3))
          args.push('-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast')
          args.push('-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-an', chunkPath)
          await runFfmpeg(args)
        }
        if (idsForChunk && hasTransitionEngine(idsForChunk)) {
          // E1 — soft blur dissolve, dip to black, ink / watercolour bleed. If FFmpeg refuses the
          // graph or the chunk does not validate, this chunk is drawn again with plain crossfades.
          const extra: string[] = []
          const matteInput = (b: number): string | null => {
            const file = mattes.get(getTransition(idsForChunk[b]!)?.bleed ?? '') ?? null
            if (!file) return null
            extra.push(file)
            return `[${chunk.length + extra.length - 1}:v]`
          }
          try {
            await runChunk(buildEngineTransitionFilterComplex({
              inputDurations: chunkDurations, transitionDuration: plan.durationSec, ids: idsForChunk,
              width: w, height: h, fps: quality.fps, matteInput,
            }), extra)
            await assertValidMedia(chunkPath, { label: path.basename(chunkPath), requireVideo: true, minDurationSec: 1 })
          } catch (error: any) {
            job.output_lines.push(`Transitions: chunk ${c + 1} could not be drawn with its ${[...new Set(idsForChunk.filter(id => getTransition(id)?.engine).map(id => getTransition(id)!.label))].join(' / ')} `
              + `(${String(error?.message || error).split('\n').slice(-1)[0]}); it uses plain crossfades instead.`)
            await runChunk(plainFilter(fallbackXfadeKeywords(idsForChunk)), [])
          }
        } else {
          await runChunk(plainFilter(keywordsForChunk), [])
        }
      }

      // Cheap pre-flight: if a chunk came out empty, fail loudly here
      // rather than letting the silent zero-frame chunk propagate into
      // the intermediate concat — where the failure is many minutes and
      // hundreds of log lines downstream.
      try {
        await assertValidMedia(chunkPath, {
          label: `scenes_xfaded_${String(c).padStart(2, '0')}.mp4`,
          requireVideo: true,
          minDurationSec: 1,
        })
      } catch (e: any) {
        job.output_lines.push(`Xfade chunk validation failed: ${e.message}`)
        throw e
      }

      lines.push(esc(chunkPath))
      // Skip past this chunk's internal boundaries AND the one cross-chunk
      // boundary that became a hard cut.
      keywordCursor += chunk.length
    }
  } else {
    for (const clip of scenePlayOrder) lines.push(esc(clip.path))
  }

  // With xfade, the total displayed duration shrinks by transitionDuration
  // at each xfade overlap. With chunking, chunk boundaries are hard cuts
  // (no overlap), so savings = (xfades actually performed) × t.
  // Actual xfades = (totalClips - 1) - hardCuts.
  //
  // v1.0.521 — plan-strict has NO savings: dissolves are window-anchored
  // (each prepared clip carries a +T tail), so the scene body's on-screen
  // length is exactly the plan total.
  const xfadeSavings = !planStrict && xfadeEnabled && transitionOpts
    ? Math.max(0, (totalClips - 1 - xfadeHardCuts)) * Math.min(transitionOpts.durationSec, Math.max(0.1, Math.min(...scenePlayOrder.map(c => c.duration)) - 0.1))
    : 0
  const sceneEndTime = accumulatedDuration + totalScenePlayDuration - xfadeSavings
  const reportedCycles = planStrict
    ? 'plan-strict (single pass, no recycling)'
    : `${Math.max(1, Math.ceil(sceneFillDuration / durationPerCycle))} cycle(s)`
  job.output_lines.push(`Scene clips: ${reportedCycles}, ${totalClips} clips (${sceneEndTime.toFixed(0)}s)`)

  // Bucket 3 of 4 — after_scenes: between the last scene cycle and the
  // post-audio fade/hold. These clips are beyond `sceneEndTime`, so the
  // effects gate already excludes them (same rule the outro relies on).
  // Their durations are NOT added to sceneEndTime because the effect gate
  // uses sceneEndTime as the *end* of effects — pushing it out would
  // extend effect playback past the last real scene.
  for (const c of buckets.after_scenes) {
    lines.push(esc(c.path))
  }

  // Handle post-audio tail (v1.0.354: an explicit fade/hold/black appended
  // after the narration). 'hard-cut' and legacy 'continue-cycling' carry no
  // tail — the video ends with the narration.
  if (behavior !== 'continue-cycling' && behavior !== 'hard-cut') {
    // Treat sub-frame remainders as zero. The fitted scene timeline often
    // equals targetDuration mathematically but differs by ~1e-13 in binary
    // floating point; passing that value to lavfi's color duration fails.
    const postDuration = clampVideoDurationToFrame(
      Math.max(0, targetDuration - sceneEndTime),
      quality.fps,
    )

    if (postDuration > 0) {
      // Pinning codec/colourspace on every post-audio clip so it can be
      // stream-copied into the same intermediate as the scene clips. The
      // original code would occasionally drift on SAR or color trc, which
      // is what the user reported as "problems with blank screen padding".
      const commonPostArgs = [
        '-c:v', 'libx264', '-crf', quality.crf.toString(), '-preset', 'ultrafast',
        '-r', quality.fps.toString(), '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
        '-color_range', 'tv', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-an',
      ]
      // Single source of truth for clip frame-shape — see animation-filters.ts.
      const normalizeVf = normalizeFrame(w, h, quality.fps).join(',')

      if (behavior === 'black-screen') {
        const blackClip = path.join(tempDir, 'post_black.mp4')
        await runFfmpeg([
          '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${quality.fps}:d=${postDuration}`,
          '-vf', `${normalizeVf}`,
          ...commonPostArgs, blackClip,
        ])
        lines.push(esc(blackClip))
        job.output_lines.push(`Post-audio: black screen for ${postDuration.toFixed(0)}s`)

      } else if (behavior === 'fade-to-black' && lastPlayedSceneClip && existsSync(lastPlayedSceneClip)) {
        const { fadeDuration: fadeDur, holdDuration: holdDur } = splitFadeToBlackDuration(
          postDuration,
          postAudio.fade_duration || 5,
          quality.fps,
        )
        const finalFrame = await extractFinalFrame(lastPlayedSceneClip, tempDir)

        const fadeClip = path.join(tempDir, 'post_fade.mp4')
        // Normalise via the shared helper, then splice `fade` in BEFORE the
        // final `format=yuv420p` so the fade curve runs on RGB-accurate data
        // and the last token still fixes the pixel format for x264.
        // Direct hand-rolled strings here are what caused the FFmpeg 8.1
        // crash on `post_fade.mp4` previously (see plans/you-are-a-senior-
        // federated-teapot.md for the post-mortem).
        const frame = normalizeFrame(w, h, quality.fps)
        const fadeVf = [
          ...frame.slice(0, -1),                  // everything up to (not incl) `format=yuv420p`
          `fade=t=out:st=0:d=${fadeDur}`,
          frame[frame.length - 1],                // `format=yuv420p`
        ].join(',')
        await runFfmpeg([
          '-y', ...(await buildLoopingMediaInputArgs(finalFrame)),
          '-vf', fadeVf,
          ...commonPostArgs, '-t', fadeDur.toString(), fadeClip,
        ])
        lines.push(esc(fadeClip))

        if (holdDur > 0) {
          const holdBlack = path.join(tempDir, 'post_hold_black.mp4')
          await runFfmpeg([
            '-y', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${quality.fps}:d=${holdDur}`,
            '-vf', `${normalizeVf}`,
            ...commonPostArgs, holdBlack,
          ])
          lines.push(esc(holdBlack))
        }
        job.output_lines.push(`Post-audio: ${fadeDur.toFixed(0)}s fade to black + ${holdDur.toFixed(0)}s hold`)

      } else if (behavior === 'hold-last-scene' && lastPlayedSceneClip && existsSync(lastPlayedSceneClip)) {
        const finalFrame = await extractFinalFrame(lastPlayedSceneClip, tempDir)
        const holdClip = path.join(tempDir, 'post_hold.mp4')
        await runFfmpeg([
          '-y', ...(await buildLoopingMediaInputArgs(finalFrame)),
          '-vf', `${normalizeVf}`,
          ...commonPostArgs, '-t', postDuration.toString(), holdClip,
        ])
        lines.push(esc(holdClip))
        job.output_lines.push(`Post-audio: hold last scene for ${postDuration.toFixed(0)}s`)
      }
    }
  }

  // Outro clip is appended last. It sits beyond `sceneEndTime` which is what
  // the final composition uses as the effects-gate `endSec` — so the outro
  // is automatically effect-free (branded content stays untouched).
  if (outroClipPath) {
    lines.push(esc(outroClipPath))
    job.output_lines.push('Outro: appended user-supplied clip')
  }

  // Bucket 4 of 4 — after_outro: very end of the video. Same effect-gate
  // story as the outro (beyond sceneEndTime → never graded/vignetted/etc).
  // This is where the user's multi-hour black screen for sleep stories
  // lives — previously hacked into the outro slot.
  for (const c of buckets.after_outro) {
    lines.push(esc(c.path))
  }

  await fs.writeFile(listPath, lines.join('\n') + '\n')
  return { listPath, sceneEndTime }
}

async function extractFinalFrame(sceneClipPath: string, tempDir: string): Promise<string> {
  const finalFramePath = path.join(tempDir, 'post_last_scene.png')
  await runFfmpeg([
    '-y', '-sseof', '-0.2', '-i', sceneClipPath,
    '-frames:v', '1', '-update', '1',
    finalFramePath,
  ])
  return finalFramePath
}

async function trimPreparedSceneClip(
  sceneClipPath: string,
  duration: number,
  quality: { crf: number; preset: string; fps: number },
  tempDir: string,
): Promise<string> {
  const trimmedPath = path.join(tempDir, 'scene_final_trimmed.mp4')
  await runFfmpeg([
    '-y', '-i', sceneClipPath,
    '-t', duration.toString(),
    '-c:v', 'libx264', '-crf', quality.crf.toString(),
    '-preset', 'ultrafast', '-r', quality.fps.toString(),
    '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709',
    '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-an',
    trimmedPath,
  ])
  return trimmedPath
}

// ── Pre-Mix Audio (Step 1 of 2) ──────────────────────────────────────────
// Combines narration + music + noise into a single audio file
// This avoids complex multi-input filter graphs in the final composition

interface PremixAudioOpts {
  narrationPath: string
  narrationDuration: number
  narrationVolume: number
  /** Seconds of silence before the narration (an unreserved title image leads in). */
  narrationDelaySec?: number
  musicFilePath?: string
  musicConfig?: VideoMusicConfig
  backgroundNoise?: VideoBackgroundNoise
  targetDuration: number
  tempDir: string
  job: Job
  /** The level the whole mix is brought to (lib/final-loudness.ts). */
  loudness: LoudnessTarget
  /** The final container: the level is checked on the audio as that encode ships it (AAC, Opus for webm). */
  format?: string
  /** 1.4.281: start from the level the loudness step at the start of Video Assembly settled on. */
  plan?: LevelPlan | null
  /** Told the plan this mix was levelled with (null = left as it was). */
  settled?: (plan: LevelPlan | null) => void
}

export async function premixAudio(opts: PremixAudioOpts): Promise<string> {
  const {
    narrationPath, narrationVolume,
    musicFilePath, musicConfig, backgroundNoise,
    targetDuration, tempDir, job, loudness,
  } = opts
  const narrationDelayMs = Math.max(0, Math.round((opts.narrationDelaySec || 0) * 1000))
  // Where the narration ENDS on the composed timeline (music swells after it).
  const narrationDuration = opts.narrationDuration + narrationDelayMs / 1000

  const outputPath = path.join(tempDir, 'premixed_audio.wav')
  const args: string[] = ['-y']
  const filterParts: string[] = []
  let nextIdx = 0

  // Input 0: narration
  args.push('-i', narrationPath)
  const narrIdx = nextIdx++

  // Input 1: music (optional, looped)
  let hasMusic = false
  let musicIdx = -1
  if (musicFilePath && musicConfig?.enabled) {
    args.push('-stream_loop', '-1', '-i', musicFilePath)
    musicIdx = nextIdx++
    hasMusic = true
  }

  // Input 2: noise (optional)
  let hasNoise = false
  let noiseIdx = -1
  if (backgroundNoise?.enabled) {
    if (backgroundNoise.mode === 'custom' && backgroundNoise.custom_file) {
      const avail = checkAssetAvailability(backgroundNoise.custom_file, 'background_noise.custom_file')
      if (avail.status === 'available') {
        args.push('-stream_loop', '-1', '-i', backgroundNoise.custom_file)
        noiseIdx = nextIdx++
        hasNoise = true
      } else {
        job.output_lines.push(`${avail.message} — ambient noise skipped`)
      }
    } else if (backgroundNoise.mode === 'preset') {
      const noiseType = backgroundNoise.preset === 'pink-noise' ? 'pink'
        : backgroundNoise.preset === 'brown-noise' ? 'brown' : 'white'
      args.push('-f', 'lavfi', '-i', `anoisesrc=color=${noiseType}:r=44100:d=${targetDuration}`)
      noiseIdx = nextIdx++
      hasNoise = true
    }
  }

  // Narration: resample, normalize, pad to target duration
  const narrVol = narrationVolume ?? 1.0
  filterParts.push(
    `[${narrIdx}:a]aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${narrVol}${narrationDelayMs > 0 ? `,adelay=delays=${narrationDelayMs}:all=1` : ''},apad=whole_dur=${targetDuration}[narr]`
  )

  const audioStreams: string[] = ['[narr]']

  // Music chain
  if (hasMusic && musicConfig) {
    const musicVol = musicConfig.volume || 0.3
    const postNarrVol = musicConfig.post_narration_volume || 0.6
    const fadeIn = musicConfig.fade_in || 0
    const fadeOut = musicConfig.fade_out || 0

    let mf = `[${musicIdx}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${musicVol}`
    if (fadeIn > 0) mf += `,afade=t=in:d=${fadeIn}`
    if (fadeOut > 0) {
      const fadeStart = Math.max(0, targetDuration - fadeOut)
      mf += `,afade=t=out:st=${fadeStart}:d=${fadeOut}`
    }
    mf += '[bgm]'
    filterParts.push(mf)

    // Boost music volume after narration ends
    const volRatio = postNarrVol / Math.max(musicVol, 0.01)
    filterParts.push(
      `[bgm]volume=enable='gt(t,${narrationDuration})':volume=${volRatio.toFixed(4)}[bgm2]`
    )
    audioStreams.push('[bgm2]')
  }

  // Noise chain
  if (hasNoise && backgroundNoise) {
    const noiseVol = backgroundNoise.volume ?? 0.15
    const noiseFadeIn = backgroundNoise.fade_in || 0
    const noiseFadeOut = backgroundNoise.fade_out || 0

    let nf = `[${noiseIdx}:a]atrim=0:${targetDuration},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo:sample_fmts=fltp,volume=${noiseVol}`
    if (noiseFadeIn > 0) nf += `,afade=t=in:d=${noiseFadeIn}`
    if (noiseFadeOut > 0) {
      const fadeStart = Math.max(0, targetDuration - noiseFadeOut)
      nf += `,afade=t=out:st=${fadeStart}:d=${noiseFadeOut}`
    }
    nf += '[amb]'
    filterParts.push(nf)
    audioStreams.push('[amb]')
  }

  // Mix all streams. normalize=0: amix otherwise divides every input by the number of inputs, so a
  // 150% voice came out at 75% under music and 50% under music and noise (1.4.270).
  filterParts.push(audioStreams.length > 1
    ? `${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=first:dropout_transition=2:normalize=0[mix]`
    : '[narr]anull[mix]')
  const graph = filterParts.join(';\n')
  const T = targetDuration.toString()

  job.output_lines.push(`Pre-mixing audio: ${audioStreams.length} stream(s) → ${Math.round(targetDuration)}s WAV`)

  // Loudness, pass 1: measure the whole mix once. The final render (segmented or not) muxes this
  // one file, so every segment shares the same level.
  const measured = parseEbur128Summary(await runFfmpeg([
    ...args, '-filter_complex', `${graph};\n[mix]${EBUR128_FILTER}[m]`, '-map', '[m]', '-t', T, '-f', 'null', '-',
  ]))
  // Pass 2: level it. The floating-point mix cannot clip before this; the plan holds the peak ceiling.
  const write = (level: string) => runFfmpeg([
    ...args,
    '-filter_complex', `${graph};\n[mix]${level}aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo:sample_rates=44100[aout]`,
    '-map', '[aout]', '-c:a', 'pcm_s16le', '-t', T, outputPath,  // uncompressed WAV for maximum compatibility
  ])
  const settled = await levelAndCheck({
    measured, write, output: outputPath, loudness, format: opts.format, tempDir, lines: job.output_lines, what: 'audio mix', plan: opts.plan,
  })
  opts.settled?.(settled)

  // Validate the premixed WAV before handing off to the final encode. A
  // 0-byte WAV here means the audio filter chain failed silently (rare,
  // but happens when narration is shorter than the music intro and the
  // amix `:duration=first` truncates everything).
  try {
    const info = await assertValidMedia(outputPath, {
      label: 'premixed_audio.wav',
      requireAudio: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Audio pre-mix complete · ${summarizeMedia(info)}`)
  } catch (e: any) {
    job.output_lines.push(`Premix validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

// ── Concat to Intermediate (stream-copy all clips into single MP4) ───────

/**
 * Preflight before the long encode: the final pass maps the intermediate video as-is (no padding),
 * so a video timeline shorter than the render cannot pass the output check on any encoder tier.
 * Stop here, once, without the automatic retries that would rebuild the same short timeline.
 */
export function assertIntermediateCoversRender(videoSec: number, expectedSec: number): void {
  if (videoSec >= expectedSec - 1) return
  throw nonRetryable(new Error(
    `The joined scene video is ${videoSec.toFixed(1)}s but this render needs ${expectedSec.toFixed(1)}s, `
    + 'so the scene clips did not join to full length. Stopped before encoding: running it again would '
    + 'stop at the same point. Send the job log to support.',
  ))
}

async function concatToIntermediate(
  concatListPath: string, tempDir: string, job: Job, expectedSec: number,
): Promise<string> {
  const outputPath = path.join(tempDir, 'intermediate_video.mp4')
  job.output_lines.push('Concatenating scene clips into intermediate video...')

  // `-fflags +genpts` synthesises monotonic PTS when chunked xfade outputs
  // each start at PTS=0 — without this the demuxer's stream-copy can emit
  // an MP4 whose PTS jumps backwards at every chunk boundary, making the
  // downstream filter graph drop frames silently. `-avoid_negative_ts
  // make_zero` shifts any negative timestamps so the muxer doesn't reject
  // them. Both flags are no-ops when timestamps are already clean.
  await runFfmpeg([
    '-y',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat', '-safe', '0', '-i', concatListPath,
    '-c:v', 'copy', '-an', outputPath,
  ])

  // Validate before handing this off — the next stage is the long final
  // encode, and a broken intermediate here is the dominant failure mode
  // for "Nothing was written into output file" errors at encode time.
  try {
    const info = await assertValidMedia(outputPath, {
      label: 'intermediate_video.mp4',
      requireVideo: true,
      minDurationSec: 1,
    })
    job.output_lines.push(`Intermediate video concat complete · ${summarizeMedia(info)}`)
    try {
      assertIntermediateCoversRender(info.videoDurationSec ?? info.durationSec, expectedSec)
    } catch (error: any) {
      await safetyGate(job.project_slug, 'final_video_whole', job, error?.message || String(error))
    }
  } catch (e: any) {
    // Re-throw with the concat list contents so the user can see which
    // input clips fed the broken intermediate. The temp dir is preserved
    // by the caller's try/finally only when DEBUG is on, but the error
    // message itself carries enough to diagnose.
    job.output_lines.push(`Intermediate concat validation failed: ${e.message}`)
    throw e
  }
  return outputPath
}

// ── Effects Library stack for one render ─────────────────────────────────

/**
 * Read this episode's `scene_effects.json`, add the project look's v1.5-kind
 * effects, and place everything on the composed timeline. Returns null when
 * there is nothing to add, so a render without the Effects Library builds the
 * exact filtergraph it always did.
 *
 * Fails loudly — never renders without — when the file cannot be read or a
 * Content Pack effect it names is gone (AGENTS.md §8).
 */
/**
 * Each scene's living pictures and outlined effects (1.4.284), plus what their
 * outlines are on disk for the render fingerprint. An unreadable effects file
 * is reported by the final pass (`resolveEpisodeStackForRender`), so here it is
 * simply "nothing per scene".
 */
async function readSceneStageForRender(
  episodeDir: string,
  library: Parameters<typeof resolveSceneStage>[1],
  job: Job,
  wide: Pick<NonNullable<Parameters<typeof resolveSceneStage>[2]>, 'scenes' | 'projectLook' | 'found'> = {},
): Promise<{ byScene: Map<string, SceneStageItem[]>; fingerprint: unknown[] }> {
  let file
  try { file = await readEpisodeEffects(episodeDir) } catch { file = emptyEpisodeEffects() }
  const notes: string[] = []
  const outlines = (await fs.readdir(path.join(episodeDir, OUTLINE_MASK_DIR)).catch(() => [] as string[])).filter(name => name.endsWith('.png'))
  const byScene = resolveSceneStage(file, library, { ...wide, outlines, notes })
  job.output_lines.push(...notes)
  const fingerprint: unknown[] = []
  for (const [sceneId, items] of byScene) {
    job.output_lines.push(`Living pictures: scene ${sceneId} draws ${items.map(item => item.name).join(', ')} inside its outline.`)
    for (const item of items) {
      const mask = item.document.region?.mask
      const auto = item.document.region?.auto
      const stat = mask ? await fs.stat(outlineMaskPath(episodeDir, mask)).catch(() => null)
        : auto ? await fs.stat(path.join(episodeDir, SCENE_ANALYSIS_DIR, auto)).catch(() => null) : null
      fingerprint.push({ scene_id: sceneId, document: item.document, ...(mask || auto ? { mask_bytes: stat?.size ?? null, mask_mtime: stat?.mtimeMs ?? null } : {}) })
    }
  }
  return { byScene, fingerprint }
}

/**
 * E2–E4 — each scene's saved analysis when this channel has scene analysis on (else null, and the
 * render is exactly what it was). Read only: a scene with no analysis falls back with a log line.
 */
async function readSceneVisionForRender(
  slug: string,
  episodeDir: string,
  scenes: GenerateVideoRequest['scenes'],
  job: Job,
): Promise<Map<string, SceneVision> | null> {
  const switches = sceneAnalysisSwitches(await pm.getConfig(slug).catch(() => null))
  if (!switches.depth && !switches.vision) return null
  const byScene = new Map<string, SceneVision>()
  let missing = 0
  for (const scene of scenes) {
    const id = (scene as { plan_scene_id?: string }).plan_scene_id
    if (!id || byScene.has(id) || /\.(mp4|mov|webm|mkv|m4v)$/i.test(scene.image_path || '')) continue
    const entry = await readSceneAnalysis(episodeDir, id, scene.image_path)
    if (entry) byScene.set(id, visionFromEntry(episodeDir, entry))
    else missing++
  }
  job.output_lines.push(`Scene analysis: ${byScene.size} scene picture(s) analysed${missing ? `, ${missing} not (yet) — those use their move's plain version` : ''}`
    + ` (depth ${switches.depth ? 'on' : 'off'}, subject and outlines ${switches.vision ? 'on' : 'off'}).`)
  return byScene
}

export async function resolveEpisodeStackForRender(opts: {
  episodeDir: string
  sceneEffects?: import('../models/types.js').SceneEffectsConfig
  windows: SceneWindow[]
  duration: number
  job: Job
}): Promise<ResolvedEpisodeStack | null> {
  const file = await readEpisodeEffects(opts.episodeDir)
  const projectLook = opts.sceneEffects?.enabled && Array.isArray(opts.sceneEffects.overlays) ? opts.sceneEffects.overlays : []
  const { overlays: library } = await listSceneEffectLibrary()
  const lookHasNewKinds = projectLook.some(item => item?.enabled !== false
    && LIBRARY_V1_5_KINDS.includes(library.find(entry => entry.id === item.id)?.document.kind as any))
  if (!episodeEffectsCount(file) && !lookHasNewKinds) return null
  const stack = resolveEpisodeEffectStack({ file, library, windows: opts.windows, projectLook, duration: opts.duration })
  assertNoUnavailablePackOverlays(stack.unavailable)
  for (const entry of stack.unavailable) {
    opts.job.output_lines.push(`Effect "${entry.id}" is not in this build's library and was skipped.`)
  }
  for (const note of stack.notes) opts.job.output_lines.push(note)
  opts.job.output_lines.push(
    `Effects Library: ${stack.entries.length} effect(s), ${stack.custom_order ? 'custom order' : 'in layer groups'}.`,
  )
  return stack.entries.length ? stack : null
}

// ── Run Final Composition (effects + audio on single MP4) ────────────────

export interface CompositionOpts {
  videoInputPath: string
  premixedAudioPath: string
  logo?: VideoLogoConfig
  targetDuration: number
  w: number; h: number
  quality: { crf: number; preset: string; fps: number }
  format: string
  outputFile: string
  colorGrading?: VideoColorGrading
  vignette?: VideoVignetteConfig
  chromaKey?: VideoChromaKeyConfig
  /** Multi-layer overlay system. When present, supersedes `chromaKey`. */
  overlays?: VideoOverlaysConfig
  filmGrain?: VideoFilmGrain
  agedArchiveFilm?: VideoAgedArchiveFilm
  letterbox?: VideoLetterbox
  frame?: VideoFrameConfig
  subtitles?: import('../models/types.js').VideoSubtitleConfig
  contextualCues?: ContextualCue[]
  /** v1.2.0 — overlays chosen from the declarative effect library. */
  sceneEffects?: import('../models/types.js').SceneEffectsConfig
  /**
   * v1.5 — the Effects Library stack for this episode, already placed on the
   * composed timeline: the project look's new-kind effects, the episode file's
   * whole-episode, theme and scene effects. Null/absent = nothing to add, and
   * the render is byte-identical to one without the Effects Library.
   */
  episodeStack?: ResolvedEpisodeStack | null
  excludeIntroFromEffects?: boolean
  /** Seconds of intro+title that should be left untouched by filters when
   *  `excludeIntroFromEffects` is on. Ignored when the flag is false. */
  preSceneDuration?: number
  /** Seconds to add to every Scene-Plan-timed overlay so it lands on the scene
   *  it annotates rather than on the branded opening. Derived from the real
   *  opening assets minus the plan's own first-scene start — never a setting.
   *  See the derivation at the `sceneTimelineOffsetSec` definition. Unlike
   *  `preSceneDuration` this applies unconditionally: it is about WHERE a
   *  reviewed window lands, not about opting out of an effect. */
  sceneTimelineOffsetSec?: number
  /** Time (seconds) at which the post-audio segment starts. Effects are
   *  cleared from this point forward so the black/fade tail + optional
   *  outro clip don't get noised/graded/vignetted — which used to blow
   *  up file size dramatically (random noise on flat black doesn't
   *  compress). `undefined` means "no tail gate" (e.g. continue-cycling
   *  mode where scenes fill the whole duration). */
  postAudioStart?: number
  /** Override for x264/x265 preset (ffmpeg's render-effort knob). Decoupled
   *  from `quality.preset` so users can pick a "fast" quality (CRF 28) but
   *  still get the smaller file size that comes from `slow` encoding.
   *  Falls back to `quality.preset` when not provided. */
  encodingEffort?: 'ultrafast' | 'medium' | 'slow' | 'hardware'
  /** Codec selection. `h264` is the universal default. `h265` (HEVC) emits
   *  roughly 30–40 % smaller files at equal visual quality but requires a
   *  modern player. Webm/VP9 stays under `format=webm` instead. */
  codec?: 'h264' | 'h265'
  /** Optional bitrate cap, kbit/s (see buildEncoderArgs). */
  videoBitrateKbps?: number
  /** Fully resolved local authority captured before optional private staging. */
  resolvedLoudness?: { lufs: number; true_peak_db: number; tolerance_pct: number; check: 'off' | 'warn' | 'block' }
  /**
   * The final-check expectation this render was made to satisfy. Staged with the remote intent so
   * an imported final is measured against the render's own plan, not today's settings.
   */
  finalCheckExpected?: FinalCheckExpectation
  /** Delay applied to the narration in this render's premixed audio. */
  narrationOffsetSec?: number
  /**
   * 1.4.265 — render in checkpointed segments that a restart keeps (lib/segmented-render.ts).
   * Absent (compilation layout, no checkpoint): one piece, exactly as before.
   */
  segmentation?: FinalSegmentation
  /** Where a still image that runs to the end of the video begins (a static after-outro clip). */
  stillTailFromSec?: number
  job: Job
}

/** Caller-owned destination facts used only by the optional private prepare seam. */
export interface CompositionDestinationFacts {
  code?: string
  titleHint?: string
  videoDir?: string
}

export { runFinalComposition as _runFinalCompositionForTesting }

type FinalCompositionHook = (opts: CompositionOpts & CompositionDestinationFacts) => Promise<VideoAssemblyDisposition>
let finalCompositionHook: FinalCompositionHook | null = null

/** Test-only: stand in for the final composition (staging and encode) so the real generateVideo can be observed there. */
export function _setFinalCompositionHookForTesting(hook: FinalCompositionHook | null): () => void {
  const previous = finalCompositionHook
  finalCompositionHook = hook
  return () => { finalCompositionHook = previous }
}

async function runFinalComposition(
  opts: CompositionOpts & CompositionDestinationFacts,
): Promise<VideoAssemblyDisposition> {
  if (finalCompositionHook) return finalCompositionHook(opts)
  const prepared = await preparePrivateFinalRenderDescriptor(opts)
  if (prepared) return prepared

  const {
    videoInputPath, premixedAudioPath, logo,
    targetDuration, w, h, quality, format, outputFile,
    colorGrading, vignette, chromaKey, overlays, filmGrain, agedArchiveFilm, letterbox, frame, subtitles, contextualCues,
    sceneEffects,
    episodeStack,
    excludeIntroFromEffects,
    preSceneDuration,
    sceneTimelineOffsetSec,
    postAudioStart,
    encodingEffort,
    codec,
    videoBitrateKbps,
    job,
  } = opts

  // Time-gate for effects that support FFmpeg's `enable=` expression.
  // Two independent bounds combined into a single `between(t,start,end)`:
  //   - start: intro+title when `excludeIntroFromEffects` is on (opt-in).
  //   - end:   where the post-audio tail begins (unconditional — nobody
  //            wants random noise layered on a black-screen tail).
  // Letterbox stays global below — it changes frame dimensions and must
  // apply to every frame for a consistent output size.
  const startSec = (excludeIntroFromEffects && preSceneDuration && preSceneDuration > 0)
    ? preSceneDuration
    : 0
  const endSec = (postAudioStart != null && postAudioStart > 0 && postAudioStart < targetDuration)
    ? postAudioStart
    : 0
  const gateEnable = buildGateEnable(startSec, endSec)
  if (startSec > 0 || endSec > 0) {
    const parts: string[] = []
    if (startSec > 0) parts.push(`after ${startSec.toFixed(1)}s (intro/title)`)
    if (endSec > 0)   parts.push(`before ${endSec.toFixed(1)}s (post-audio/outro)`)
    job.output_lines.push(`Effects gated: ${parts.join(' + ')}`)
  }

  const args: string[] = ['-y']
  const filterParts: string[] = []
  const generatedSubtitleFiles: string[] = []
  try {
  let nextInputIdx = 0

  // Input 0: intermediate video (pre-concatenated)
  args.push('-i', videoInputPath)
  nextInputIdx++

  // Input 1: pre-mixed audio (narration + music + noise already combined)
  args.push('-i', premixedAudioPath)
  const audioInputIdx = nextInputIdx++

  // Input: logo image (if enabled)
  let hasLogo = false
  let logoInputIdx = -1
  if (logo?.enabled && logo.image_path) {
    const avail = checkAssetAvailability(logo.image_path, 'logo.image_path')
    if (avail.status === 'available') {
      // A rounded or circle logo is cut once into a still PNG at its rendered size (lib/logo-shape.ts).
      let logoPath = logo.image_path
      const shape = logoShapeOf(logo.shape)
      if (shape !== 'none') {
        const shaped = path.join(path.dirname(videoInputPath), `logo-${shape}.png`)
        try {
          await writeShapedLogo(logo.image_path, shaped, Math.round(w * (logo.scale || 0.1)), shape, logo.corner_radius_pct)
          logoPath = shaped
          job.output_lines.push(`Logo shape: ${shape === 'circle' ? 'circle' : `rounded corners (${logoCornerRadiusPct(logo.corner_radius_pct)}%)`}`)
        } catch (error: any) {
          job.output_lines.push(`Logo shape could not be made (${error?.message || error}); the logo is shown as it is.`)
        }
      }
      args.push('-i', logoPath)
      logoInputIdx = nextInputIdx++
      hasLogo = true
    } else {
      job.output_lines.push(`${avail.message} — logo skipped`)
    }
  }

  // Overlay layers — back-compat: a legacy `chromaKey` synthesises into
  // a single-layer overlay so the rest of the pipeline only handles
  // one shape. New projects use `overlays.layers[]` directly.
  const overlayLayers: VideoOverlay[] = []
  if (overlays?.enabled && Array.isArray(overlays.layers)) {
    for (const l of overlays.layers) {
      if (l.enabled && l.source_path) overlayLayers.push(l)
    }
  } else if (chromaKey?.enabled && chromaKey.source_path) {
    overlayLayers.push({
      id: 'legacy-chromakey',
      enabled: true,
      source_path: chromaKey.source_path,
      chroma_key: {
        color: chromaKey.color || '#00FF00',
        similarity: chromaKey.similarity ?? 0.15,
        blend: chromaKey.blend ?? 0.1,
      },
    })
  }
  // Open one ffmpeg `-i` per layer in array order. -1 marker means the
  // file was missing at availability check time and the layer is dropped
  // from the filter graph below.
  const overlayInputIdxs: number[] = []
  for (const layer of overlayLayers) {
    const avail = checkAssetAvailability(layer.source_path, `overlays[${layer.id}].source_path`)
    if (avail.status !== 'available') {
      job.output_lines.push(`${avail.message} — overlay '${layer.id}' skipped`)
      overlayInputIdxs.push(-1)
      continue
    }
    if (layer.loop !== false) args.push(...(await buildLoopingMediaInputArgs(layer.source_path)))
    else args.push('-i', layer.source_path)
    overlayInputIdxs.push(nextInputIdx++)
  }

  // Optional presentation-frame board. Stills and videos both loop until the
  // final `-t`; the frame filter crops them to the output canvas behind the
  // bordered scene surface.
  let frameBackgroundInputIdx = -1
  if (frame?.enabled && frame.background_path) {
    const avail = checkAssetAvailability(frame.background_path, 'frame.background_path')
    if (avail.status === 'available') {
      args.push(...(await buildLoopingMediaInputArgs(frame.background_path)))
      frameBackgroundInputIdx = nextInputIdx++
    } else {
      job.output_lines.push(`${avail.message} — using the solid frame board color`)
    }
  }

  // Effects Library loops (rain, snow, fog…): baked once from the shared
  // particle program, then opened as endless looping inputs. A loop that will
  // not bake fails the job by name — the owner asked for that effect, and a
  // video quietly missing it is the outcome AGENTS.md §8 forbids.
  const stackEntries = episodeStack?.entries ?? []
  const loopInputs = new Map<string, string>()
  for (const entry of stackEntries) {
    for (const shape of overlayLoopShapes(entry.document)) {
      const key = loopShapeKey(shape)
      if (loopInputs.has(key)) continue
      let baked
      try {
        baked = await bakeEffectLoop(shape, w, h, quality.fps)
      } catch (error: any) {
        throw new Error(`The "${entry.name}" effect could not be prepared: ${error?.message || error}. `
          + 'Remove it from the Effects Library stack or try again — no completed work is repeated.')
      }
      args.push('-stream_loop', '-1', '-i', baked.path)
      loopInputs.set(key, `[${nextInputIdx++}:v]`)
      job.output_lines.push(`Effect loop for "${entry.name}": ${baked.baked ? `baked in ${(baked.bake_ms / 1000).toFixed(1)}s` : 'reused'} (${baked.width}×${baked.height}, ${baked.frames} frames)`)
    }
  }
  const stackGate = buildGateExpression(startSec, endSec)
  // E1 — bedtime dimming has a fixed place of its own (below), whatever the stack order.
  const dimming = stackEntries.filter(entry => entry.document.kind === 'bedtime-dimming')
  const lowerStack = stackEntries.filter(entry => !dimming.includes(entry) && (episodeStack!.custom_order || isLowerStackGroup(entry.group)))
  const upperStack = stackEntries.filter(entry => !dimming.includes(entry) && !lowerStack.includes(entry))

  // ═══════════════════════════════════════════════════════════════════════
  //  VIDEO FILTER CHAIN (video-only — audio is pre-mixed)
  // ═══════════════════════════════════════════════════════════════════════

  let vLabel = '[0:v]'
  let vIdx = 0
  const vn = () => `[v${vIdx++}]`

  // 1. Reset timestamps (intermediate video is already the correct duration)
  const v1 = vn()
  filterParts.push(`${vLabel}setpts=PTS-STARTPTS${v1}`)
  vLabel = v1

  // 2. Overlay layers (multi-layer; v1.0.53+).
  //    Each layer: scale → optional chroma-key → optional opacity →
  //    composite onto running base. Layers stack in array order — the
  //    first layer is drawn nearest the base, the last sits on top.
  //    The legacy single-slot `chroma_key` field is upgraded into a
  //    one-element `overlayLayers` array above so this loop is the
  //    sole composite path.
  for (let i = 0; i < overlayLayers.length; i++) {
    const layer = overlayLayers[i]!
    const inIdx = overlayInputIdxs[i]!
    if (inIdx < 0) continue   // file missing — skipped at availability check
    const part = buildFinalOverlayFilters({ input: vLabel, allocLabel: vn }, layer, inIdx, w, h, gateEnable)
    filterParts.push(...part.filters)
    vLabel = part.output
  }

  // 3. Color grading — the gate goes on the eq and on the warmth/tint lookup so both time-gate together.
  if (colorGrading?.enabled) {
    const cg = vn()
    const statements = buildColorGradingFilters(colorGrading, gateEnable, { input: vLabel, output: cg, allocLabel: vn })
    if (statements.length) {
      filterParts.push(...statements)
      vLabel = cg
    }
  }

  // 3b. Effects Library — grade, atmosphere, weather, particles and light,
  // drawn UNDER the classic vignette, grain and letterbox so lens effects
  // stay on top of the rain. (Custom order puts the whole stack here.)
  const compileStack = (entries: ResolvedStackEntry[]) => {
    for (const entry of entries) {
      const next = vn()
      const statements = compileSceneOverlay(entry.document, {
        input: vLabel, output: next, allocLabel: vn, w, h,
        duration: targetDuration, fps: quality.fps,
        gateExpression: stackGate,
        loopInput: shape => loopInputs.get(loopShapeKey(shape)) ?? null,
      })
      const where = entry.scope === 'scene' ? ` · scene ${entry.scope_label}`
        : entry.scope === 'theme' ? ` · theme "${entry.scope_label}"`
        : entry.scope === 'project' ? ' · project look' : ' · whole episode'
      if (!statements) {
        job.output_lines.push(`Effect "${entry.name}"${where} had nothing to draw and was skipped.`)
        continue
      }
      filterParts.push(...statements)
      vLabel = next
      const t = entry.document.timing
      job.output_lines.push(`Effect: ${entry.name}${where} (${t.start_sec.toFixed(1)}s–${t.end_sec === null ? 'end' : `${t.end_sec.toFixed(1)}s`})`
        + `${entry.approximation ? ' (approximation — see its note)' : ''}`)
    }
  }
  compileStack(lowerStack)

  // 4. Vignette
  //
  // FFmpeg's angle grows stronger as it approaches PI/2. Keep the calibrated
  // range below that extreme so darkness starts at the corners and expands
  // inward without dimming the center like a global exposure adjustment.
  if (vignette?.enabled) {
    const part = buildFinalVignetteFilters({ input: vLabel, allocLabel: vn }, vignette, gateEnable)
    filterParts.push(...part.filters)
    vLabel = part.output
  }

  // 5. Film grain
  if (filmGrain?.enabled) {
    const part = buildFinalFilmGrainFilters({ input: vLabel, allocLabel: vn }, filmGrain, gateEnable)
    filterParts.push(...part.filters)
    vLabel = part.output
  }

  // 6. Aged Archive Film is self-contained: it does not turn on or alter the
  // standalone colour-grade, vignette, or Film Grain controls above.
  if (agedArchiveFilm?.enabled) {
    const part = buildFinalArchiveFilters({ input: vLabel, allocLabel: vn }, agedArchiveFilm, w, h, gateEnable)
    filterParts.push(...part.filters)
    vLabel = part.output
  }

  // 7. Letterbox — global. 1.4.282: by default the whole picture shrinks
  // between the bars so nothing is hidden; `mode: 'cover'` draws them over it.
  if (letterbox?.enabled) {
    // v1.4.15 — cinematic bars are a landscape idea. Every ratio this effect
    // offers (2.35:1, 2.00:1, 1.85:1) is wider than any canvas, so on a
    // portrait frame the arithmetic is still valid and paints bars over most
    // of the picture. Rather than ship a Short that is 76% black, the effect
    // steps aside and says so — a skipped effect is recoverable, a ruined
    // render is not.
    const barHeight = letterboxBarHeight(w, h, letterbox.ratio)
    if (barHeight * 2 > h * 0.5) {
      job.output_lines.push(
        `Cinematic letterbox (${letterbox.ratio}) skipped: it would cover `
        + `${Math.round((barHeight * 2 / h) * 100)}% of a ${w}×${h} frame. `
        + 'Those bars are made for widescreen; this render is not.',
      )
    } else {
      const lb = vn()
      const filter = buildLetterboxFilter(vLabel, lb, w, h, letterbox.ratio, letterbox.color || 'black', letterbox.mode === 'cover' ? 'cover' : 'fit')
      if (filter) {
        filterParts.push(filter)
        vLabel = lb
      }
    }
  }

  // 7b. E1 — bedtime dimming: after the effects and the lens, before the frame, captions, cues and
  // logo, so rain and stars dim with the picture and the captions stay readable. It ramps across
  // the story (after the intro when the effects skip it) and holds through the outro and tail.
  for (const entry of dimming) {
    const story = { start: startSec, end: endSec > 0 ? endSec : targetDuration }
    if (story.end - story.start < 600) {
      job.output_lines.push(`Bedtime dimming skipped: the story runs ${Math.round(story.end - story.start)} s, too short for bedtime dimming (it needs 10 minutes).`)
      continue
    }
    const next = vn()
    const statements = compileSceneOverlay(entry.document, {
      input: vLabel, output: next, allocLabel: vn, w, h, duration: targetDuration, fps: quality.fps, timeline: story,
    })
    if (!statements) continue
    filterParts.push(...statements)
    vLabel = next
    const d = entry.document as Extract<typeof entry.document, { kind: 'bedtime-dimming' }>
    job.output_lines.push(`Bedtime dimming: ${d.darken_pct}% darker and ${d.warmth_pct}% warmer, from ${d.start_pct}% to ${d.full_pct}% of the story `
      + `(${(story.start + (story.end - story.start) * d.start_pct / 100).toFixed(0)}s–${(story.start + (story.end - story.start) * d.full_pct / 100).toFixed(0)}s).`)
  }

  // 6a. Presentation frame. Applied after grading/letterbox so the matte and
  // border retain their chosen colours; subtitles and logo remain inside the
  // framed composition and are added immediately below.
  if (frame?.enabled) {
    const framed = vn()
    filterParts.push(...buildVideoFrameFilter({
      inputLabel: vLabel,
      backgroundInputLabel: frameBackgroundInputIdx >= 0 ? `[${frameBackgroundInputIdx}:v]` : undefined,
      outputLabel: framed,
      prefix: `mainframe${vIdx}`,
      width: w,
      height: h,
      fps: quality.fps,
      config: frame,
    }))
    vLabel = framed
    job.output_lines.push(
      `Frame: ${frame.inset_pct ?? 4}% inset · ${frame.border_width ?? 12}px border · ${frame.corner_radius ?? 28}px corners`,
    )
  }

  // 6a-ii. Effect-library overlays (v1.2.0).
  //
  // Deliberately BEFORE subtitles. A gradient scrim exists so captions read
  // over a bright scene; drawn on top of them it would defeat its own purpose.
  // Lower thirds and corner logos occupy different bands from the caption line,
  // so nothing is lost by putting the whole stage here.
  //
  // Each overlay carries the same intro/outro gate the other effects use,
  // ANDed with its own window rather than replacing it.
  if (sceneEffects?.enabled) {
    // v1.2.1 — resolved against built-ins PLUS installed packs. The library is
    // read here rather than passed in because this is the only place in the
    // composition pass that needs it.
    const { overlays: overlayLibrary } = await listSceneEffectLibrary()
    const { resolved, unavailable } = resolveAppliedOverlays(sceneEffects, overlayLibrary)
    // A qualified id that no longer resolves came from a pack that has been
    // uninstalled, disabled or recalled. Carrying on would publish a video
    // missing a look the customer configured, so the job stops and says which
    // pack to reinstall — the Verified Completion Contract, applied to effects.
    assertNoUnavailablePackOverlays(unavailable)
    for (const overlay of resolved) {
      // v1.5 kinds from this list were placed in the Effects Library stack
      // above (in their layer group); older kinds keep their place here.
      if (LIBRARY_V1_5_KINDS.includes(overlay.document.kind)) continue
      // A living picture is drawn on each scene clip that has its outline (prepareSceneClips).
      if (overlay.document.kind === 'living-region') continue
      const next = vn()
      const statements = compileSceneOverlay(overlay.document, {
        input: vLabel,
        output: next,
        allocLabel: vn,
        w, h,
        duration: targetDuration,
        gateExpression: buildGateExpression(startSec, endSec),
      })
      if (!statements) {
        // Nothing to draw — an unset logo path, bars that round to zero. Say so
        // rather than leaving the customer to wonder where the effect went.
        job.output_lines.push(`Effect "${overlay.name}" had nothing to draw and was skipped.`)
        continue
      }
      filterParts.push(...statements)
      vLabel = next
      job.output_lines.push(
        `Effect: ${overlay.name}${overlay.approximation ? ' (approximation — see its note)' : ''}`,
      )
    }
    for (const entry of unavailable) {
      // Everything reaching here is a BARE id — a hand-edited or ancient
      // config. Not fatal: a project naming an effect this build does not have
      // must still render. It must not do so silently.
      job.output_lines.push(`Effect "${entry.id}" is not in this build's library and was skipped.`)
    }
  }

  // 6a-iii. Effects Library lens and overlay groups (vignette, grain, scrims,
  // titles from the library) — over everything above, under the captions.
  compileStack(upperStack)

  // 6b. Subtitles (libass burn-in). Placed after letterbox so subtitles
  //     sit inside the safe area; placed before the logo so the logo
  //     always renders on top.
  // When the last burned caption ends (a still tail is only looped after it). Unknown = never.
  let captionsEndSec = 0
  if (subtitles?.enabled && subtitles.srt_path && existsSync(subtitles.srt_path)) {
    captionsEndSec = Infinity
    const { buildSubtitleAssDocument, parseSrt } = await import('../lib/subtitle-builder.js')
    const { normalizeSubtitleStyle, assOnlySubtitleFeatures } = await import('../contracts/subtitle-style.js')
    // v1.1.0 — ONE renderer. Every style now burns through the full ASS
    // document, not just animated or precisely-placed ones. The `force_style`
    // path below survives only as the fallback for a subtitle file we cannot
    // parse, because it can express none of the word modes and — the reason
    // this changed — it silently ignores `max_chars_per_line` / `max_lines`,
    // so a caption previewed wrapped burned in unwrapped.
    const style = normalizeSubtitleStyle(subtitles.style)
    const st = vn()
    let wired = false
    let subtitleFallbackReason: string | null = null
    {
      try {
        const cues = parseSrt(await fs.readFile(subtitles.srt_path, 'utf-8'))
        captionsEndSec = cues.reduce((end, cue) => Math.max(end, cue.end_sec), 0)
        if (cues.length) {
          // Word timings are derived AFTER any intro offset is already baked
          // into the cue timestamps (see the note below) — the derivation reads
          // each cue's own window, so it inherits whatever shift was applied
          // upstream rather than re-deriving from an unshifted timeline.
          const rendered = buildSubtitleAssDocument(cues, style, { width: w, height: h })
          if (!rendered.events) throw new Error('subtitle document contained no events')
          // In the job's own work folder under a fixed name, so a resumed render sees the same command.
          const assPath = path.join(path.dirname(videoInputPath), 'subtitles-burn.ass')
          await fs.writeFile(assPath, rendered.ass, 'utf-8')
          generatedSubtitleFiles.push(assPath)
          // NOTE: do NOT append `gateEnable` here. FFmpeg's libass filters
          // (`ass` / `subtitles`) do NOT support the timeline `enable` option —
          // adding it makes the WHOLE filtergraph fail to initialise
          // ("Timeline ('enable' option) not supported with filter 'ass'"),
          // which drops the encode to the no-effects recovery tier (losing the
          // grade, vignette, grain, logo AND subtitles).
          //
          // Nor is a gate wanted. Captions answer to the WORDS, and the merged
          // narration is not delayed — it plays from the composed video's t=0,
          // under the (silent) opening clips — so a caption at its stitched-SRT
          // timestamp is already in sync with the voice by construction. This
          // comment previously claimed the SRT was "offset past the intro/title
          // lead-in", conflating two unrelated numbers: the stitcher's lead-in
          // is the non-narration AUDIO at the head of the merged track (music /
          // intro audio), while the intro/title clips are VIDEO. On a real
          // episode those are 16.07s and 10.00s — they are not the
          // same quantity and are not required to agree. Captions therefore
          // need no shift, while contextual cues (which answer to the PICTURE)
          // do — see `sceneTimelineOffsetSec`. Suppressing captions during a
          // spoken intro is a separate, deliberate feature:
          // `subtitles.hide_during_intro`, applied by trimming the burn copy.
          // `:fontsdir` makes the app's bundled faces resolvable by THIS burn.
          // Without it a CoreText libass resolves families against macOS's
          // installed fonts only, so a caption in a bundled face that is not
          // also installed system-wide was silently drawn in Helvetica. See
          // `lib/subtitle-font-dir.ts`; empty when the folder is absent, which
          // leaves the filter exactly as it was.
          filterParts.push(`${vLabel}ass=filename=${escapeFilterPath(assPath)}${bundledFontsFilterOption()}${st}`)
          const notes = [
            style.word.mode !== 'off' ? `word mode ${style.word.mode} (${rendered.wordPrecision} timing)` : null,
            style.animation.type !== 'none' ? `animation ${style.animation.type}` : null,
          ].filter(Boolean)
          job.output_lines.push(
            `Burning in subtitles: ${path.basename(subtitles.srt_path)}`
            + (notes.length ? ` — ${notes.join(', ')}` : '')
            + ` · ${rendered.events} caption event${rendered.events === 1 ? '' : 's'}`,
          )
          wired = true
        }
      } catch (e: any) {
        subtitleFallbackReason = e?.message || String(e)
        job.output_lines.push(`Subtitle document build failed (${e?.message || e}) — falling back to coarse static anchors, which cannot render word modes, animation or line wrapping.`)
      }
    }
    if (!wired) {
      const { buildSubtitleForceStyle } = await import('../lib/subtitle-builder.js')
      const ass = buildSubtitleForceStyle(style).replace(/'/g, "\\'")
      // No `gateEnable` — same FFmpeg libass limitation as the `ass` filter
      // above (timeline `enable` is unsupported and breaks the whole graph).
      // Intro suppression comes from the cue timestamps, not a filter gate.
      // v1.0.517 — "px at 1080" semantics live in buildAssStyle, which
      // pre-scales values into the SRT-default 384×288 PlayRes space that
      // force_style is interpreted in. (`original_size=` does NOT set that
      // reference — it only corrects aspect-ratio distortion; the v1.0.413
      // assumption that it pinned a 1080 reference is why rendered fonts
      // came out 3.75× larger than the preview.)
      // v1.4.15 — `original_size` is the render's own canvas, not a literal
      // 1920x1080. It corrects libass's aspect-ratio distortion, so pinning it
      // to 16:9 skewed every caption this fallback drew onto a portrait or
      // square frame.
      filterParts.push(`${vLabel}subtitles=filename=${escapeFilterPath(subtitles.srt_path)}:original_size=${w}x${h}${bundledFontsFilterOption()}:force_style='${ass}'${st}`)
      job.output_lines.push(`Burning in subtitles: ${path.basename(subtitles.srt_path)}`)
      // `force_style` can express none of the style's word modes, animation,
      // precise placement or line wrapping, so this fallback is a genuine
      // degradation of the requested captions. Logging it in `output_lines` is
      // not enough: the Jobs UI keys on `result.degraded`. AGENTS.md §8 says a
      // run may not report a clean success without naming what it dropped.
      const assOnlyFeatures = assOnlySubtitleFeatures(style)
      if (assOnlyFeatures.length) {
        declareJobDegraded(job, {
          tier: 'subtitles force_style fallback',
          reason: subtitleFallbackReason || 'the styled subtitle document could not be built',
          requested: assOnlyFeatures,
          survived: ['caption text and basic style'],
          dropped: assOnlyFeatures,
        })
      }
    }
    vLabel = st
  }

  // 6c. Contextual Cues. These are an approved, immutable editorial timeline
  // from the Contextual Cues workspace — never LLM-generated or re-timed by
  // Video Assembly. drawtext supports timeline enable expressions, unlike the
  // libass subtitle filters above, so each restrained label can appear only in
  // its exact reviewed window.
  //
  // The reviewed WINDOW is immutable; where that window lands on the composed
  // clock is not, because the branded opening pushes every scene later by its
  // own measured length. `sceneTimelineOffsetSec` carries that derived shift
  // (0 when nothing precedes the scenes), so the cue stays on the scene it
  // annotates without the user ever restating how long the intro is.
  if (contextualCues?.length) {
    const cueOffset = sceneTimelineOffsetSec || 0
    for (const cue of contextualCues) {
      // Image-backed designs: the words are fitted into the design's own box
      // and the finished PNG is overlaid. Everything is placed in output pixels,
      // so the preview and this render cannot disagree. A design that is not
      // installed fails the job by name rather than falling back to another
      // treatment the customer never picked (AGENTS.md §8).
      if (cue.template.startsWith('label:')) {
        const design = await findLabelDesign(cue.template)
        if (!design) {
          throw new Error(`Label design ${cue.template} is not installed on this Mac. Pick a different design for this label, or restore the pack it came from.`)
        }
        const rendered = await renderLabelDesign({
          design, title: cue.title, subtitle: cue.subtitle, frame_w: w, frame_h: h,
        })
        const renderCue = labelCueForRender(cue, !!design.pointing, message => job.output_lines.push(message))
        const geometry = labelOverlayGeometry(renderCue, rendered, w, h, cueOffset)
        const safeId = cue.id.replace(/[^a-zA-Z0-9-]/g, '-')
        const labelPath = cue.motion === 'wipe'
          ? await writeLabelRevealFrames(path.join(path.dirname(videoInputPath), `label-${safeId}-wipe`), quality.fps, generatedSubtitleFiles,
            progress => renderLabelWipe(rendered.png, rendered.width, rendered.height, progress))
          : path.join(path.dirname(videoInputPath), `label-${safeId}.png`)
        if (cue.motion !== 'wipe') {
          generatedSubtitleFiles.push(labelPath)
          await fs.writeFile(labelPath, rendered.png)
        }

        // A separate target point: the label can sit away from what it points at.
        // Old cues carry none and simply draw nothing extra.
        if (design.pointing && cue.target_x_pct != null && cue.target_y_pct != null) {
          const lineInput = {
            frame_w: w, frame_h: h,
            from: { x: geometry.anchor.x / w, y: geometry.anchor.y / h },
            to: { x: cue.target_x_pct / 100, y: cue.target_y_pct / 100 },
          }
          const linePath = cue.motion === 'line-draw'
            ? await writeLabelRevealFrames(path.join(path.dirname(videoInputPath), `label-line-${safeId}`), quality.fps, generatedSubtitleFiles,
              progress => renderLeaderLine({ ...lineInput, progress }))
            : path.join(path.dirname(videoInputPath), `label-line-${safeId}.png`)
          if (cue.motion !== 'line-draw') {
            generatedSubtitleFiles.push(linePath)
            await fs.writeFile(linePath, await renderLeaderLine(lineInput))
          }
          if (cue.motion === 'line-draw') args.push('-framerate', String(quality.fps))
          args.push('-i', linePath)
          const lineIdx = nextInputIdx++
          let lineLabel = `[${lineIdx}:v]`
          if (cue.motion === 'line-draw') {
            const shifted = vn()
            filterParts.push(`${lineLabel}setpts=PTS+${(cue.start_sec + cueOffset).toFixed(3)}/TB${shifted}`)
            lineLabel = shifted
          }
          const nextLine = vn()
          filterParts.push(`${vLabel}${lineLabel}overlay=x=0:y=0:eof_action=repeat:enable=${escapeFilterArgValue(geometry.enable)}${nextLine}`)
          vLabel = nextLine
        }

        const overlayPlan = buildLabelOverlayFilters(geometry, {
          base: vLabel, labelInputIdx: nextInputIdx, fps: quality.fps, allocLabel: vn,
        })
        args.push(...overlayPlan.input_args, '-i', labelPath)
        nextInputIdx++
        filterParts.push(...overlayPlan.filters)
        vLabel = overlayPlan.output
        continue
      }
      for (const filter of buildContextualCueDrawtextFilters(cue, cueOffset)) {
        const next = vn()
        filterParts.push(`${vLabel}${filter}${next}`)
        vLabel = next
      }
    }
    job.output_lines.push(`Burning ${contextualCues.length} approved contextual cue(s) exactly as reviewed.`)
  }

  // 7. Logo overlay
  //
  // Gate precedence: if `excludeIntroFromEffects` is on, the pre-scene gate
  // supersedes the legacy `hide_during_intro` toggle (both hide the logo
  // during intro/title). If only `hide_during_intro` is set, fall back to
  // the legacy 10s hardcode for back-compat with projects that pre-date
  // the exclude-intro feature.
  if (hasLogo && logo) {
    const part = buildFinalLogoFilters({ input: vLabel, allocLabel: vn }, logo, logoInputIdx, w, h, gateEnable)
    filterParts.push(...part.filters)
    vLabel = part.output
  }

  // Final video label
  filterParts.push(`${vLabel}null[vout]`)

  // Apply filter_complex (video-only filters)
  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';\n'))
    args.push('-map', '[vout]')
  } else {
    args.push('-map', '0:v')
  }

  // Map pre-mixed audio directly (no filter needed — already processed)
  args.push('-map', `${audioInputIdx}:a`)

  // Encoding settings. The `preset` (x264/x265) is the user's encoding-effort
  // override if provided; otherwise it falls back to the tier-default from
  // QUALITY_PRESETS (e.g. `compact` → ultrafast, `high` → slow). The `codec`
  // toggle picks between H.264 (libx264, universal) and H.265 (libx265, ~30 %
  // smaller but requires QuickTime 10.4+ / modern browsers). webm/VP9 stays
  // on its own branch because it doesn't share encoder flags.
  const effort = encodingEffort || quality.preset

  // Snapshot the args array BEFORE encoder args are appended so we can
  // rebuild a clean argv for the H.264 retry without dragging H.265 tokens
  // into it. Everything after this point (encoder + -t + outputFile) is
  // codec-dependent.
  const preEncoderArgs = [...args]

  // Helper for the argv-dump, called once per encode attempt. Shell-quoted +
  // chunked so a long filter_complex doesn't get truncated by any downstream
  // log viewer. On failure the user can paste from this line to reproduce.
  function logCmd(attemptArgs: string[], note?: string): void {
    const argvString = attemptArgs
      .map(a => /[\s'";]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)
      .join(' ')
    const fullCmd = `FFmpeg cmd${note ? ' ' + note : ''}: ffmpeg ${argvString}`
    const CHUNK = 1500
    if (fullCmd.length <= CHUNK) {
      job.output_lines.push(fullCmd)
    } else {
      job.output_lines.push(`FFmpeg cmd${note ? ' ' + note : ''} (${fullCmd.length} chars, split):`)
      for (let i = 0; i < fullCmd.length; i += CHUNK) {
        job.output_lines.push(fullCmd.slice(i, i + CHUNK))
      }
    }
  }

  const runEncode = (encodeArgs: string[], progress?: EncodeProgress) => spawnFinalEncode(job, targetDuration, encodeArgs, progress)

  // ── Recovery chain ─────────────────────────────────────────────────────
  //
  // Earlier this code had a single H.265 → H.264 retry, which only covered
  // one specific failure mode (libx265 EINVAL on colour-metadata drift). In
  // practice the final encode can fail for many other reasons:
  //   - filter graph emits zero packets (any filter rejecting input)
  //   - encoder rejects an odd-dimension scale/pad output
  //   - intermediate has bad PTS that confuses setpts/enable gates
  //   - exit 0 but a 0-byte output file (rare, but happens)
  //
  // The chain below runs each tier in order; the first tier whose output
  // ffprobe can validate wins. Each tier strips more "nice to have"
  // features so the user always ends up with *some* video, even if the
  // film grain or chroma key got dropped in the process. We log clearly
  // which tier ran so a successful render with degraded output isn't
  // silently mistaken for a clean run.
  //
  // The full filter chain is captured in `args` (with `[vout]` mapping)
  // and the audio map is `${audioInputIdx}:a`. Tiers 3+ use a minimal
  // re-build that bypasses filter_complex entirely.
  type Tier = EncodeTier

  // ── What the user actually asked to be burned in ────────────────────────
  //
  // A recovery tier that bypasses the filter graph produces a complete,
  // playable video with none of these in it. That is still the right
  // trade — a watchable file beats a failed render — but a job that
  // reports a bare `done` after discarding them is lying to the owner,
  // who would publish a video missing features he explicitly requested
  // with nothing on screen to suggest anything went wrong. So we inventory
  // the request up front and diff it against what the winning tier kept.
  const requestedBurnIns = describeFinalBurnIns({
    colorGrading: Boolean(colorGrading?.enabled),
    vignette: Boolean(vignette?.enabled),
    filmGrain: Boolean(filmGrain?.enabled),
    agedArchiveFilm: Boolean(agedArchiveFilm?.enabled),
    letterbox: Boolean(letterbox?.enabled),
    frame: Boolean(frame?.enabled),
    overlayLayers,
    hasLogo,
    subtitles: Boolean(subtitles?.enabled && subtitles.srt_path),
    contextualCueCount: contextualCues?.length ?? 0,
    stackEntryCount: stackEntries.length,
  })

  const tiers: Tier[] = buildFinalEncodeTiers({
    format,
    codec,
    effort,
    quality,
    bitrateKbps: videoBitrateKbps,
    preEncoderArgs,
    videoInputPath,
    premixedAudioPath,
    targetDuration,
    outputFile,
  })

  const validateEncodedOutput = () => validateFinalOutput(outputFile, targetDuration)

  // ── Segmented final render (1.4.265, lib/segmented-render.ts) ──────────
  //
  // A still tail (TerraNash: a 60-min image after the story) is rendered once for 30 s and
  // repeated, but only when nothing on it moves: every gated effect (grade, archive film, grain,
  // vignette, overlays, Effects Library, logo) has ended by the time it starts, no caption or cue
  // reaches it, and the frame board is a still. The loop is a whole number of output frames.
  const tailFrom = opts.stillTailFromSec
  const cuesEndSec = (contextualCues || []).reduce((end, cue) => Math.max(end, cue.end_sec + (sceneTimelineOffsetSec || 0)), 0)
  const stillTailFrom = tailFrom != null
    && endSec > 0 && endSec <= tailFrom
    && captionsEndSec <= tailFrom && cuesEndSec <= tailFrom
    && !(frame?.enabled && frame.background_path && !isStaticImagePath(frame.background_path))
    ? tailFrom
    : null

  const runFinal = (argv: string[]) => runSegmentedFinal({
    job, argv, targetDuration, format, stillTailFrom, segmentation: opts.segmentation, narrationOffsetSec: opts.narrationOffsetSec, runEncode,
  })

  job.output_lines.push('Running final composition...')
  job.output_lines.push(`Output: ${path.basename(outputFile)}`)

  const chain = await runEncodeTierChain(tiers, {
    run: runFinal,
    validate: validateEncodedOutput,
    log: line => job.output_lines.push(line),
    logCmd,
    isCancelled: () => isCancelled(job.job_id),
  })
  const { lastError, succeededTier } = chain

  if (chain.cancelled) {
    job.output_lines.push('Render cancelled — encoding stopped; no fallback encode was started.')
    throw new Error('Cancelled by user')
  }

  if (!succeededTier) {
    // All tiers failed — emit the full diagnostic trail so the user can
    // file a useful bug report or hand it to support.
    job.output_lines.push(`FFmpeg inputs: videoInputPath=${videoInputPath} premixedAudioPath=${premixedAudioPath}`)
    job.output_lines.push(`✗ All ${tiers.length} encode tiers failed. Last error: ${lastError?.message || 'unknown'}`)
    throw lastError || new Error('Final composition failed at all tiers')
  }

  // The owner asked "how do I know if it's using the hardware or just the software?"
  const encoderLine = describeEncoder(succeededTier.build(), effort === 'hardware', lastError)
  job.output_lines.push(encoderLine)
  job.result = { ...(job.result || {}), encoder: encoderLine.replace(/^Encoder: /, '') }
  if (succeededTier !== tiers[0]) {
    job.output_lines.push(`✓ Final video produced via recovery tier — ${succeededTier.degraded || succeededTier.label}`)
    // A recovery tier that bypassed the filter graph delivered a playable file
    // with none of the requested burn-ins in it. Say so in the job's result;
    // reporting a bare `done` here is what let a render ship missing both the
    // contextual cues and the subtitles with nothing to flag it.
    declareJobDegraded(job, {
      tier: succeededTier.label,
      reason: lastError?.message || 'the preferred encode failed',
      requested: requestedBurnIns,
      survived: succeededTier.dropsBurnedInFeatures ? [] : requestedBurnIns,
      dropped: succeededTier.dropsBurnedInFeatures ? requestedBurnIns : [],
    })
  }
  } finally {
    await Promise.all(generatedSubtitleFiles.map(file => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}

/**
 * The video's two clocks, from the merged master's real length and the closing
 * tail Audio Assembly baked into it.
 *
 * `narrationDurationSec` is where the SPEECH ends — the scenes stop there, and
 * every reader that asks "how long is the narration" (the coverage gate, the
 * burned captions, the Image Pool budget, the plan's clock) means this.
 * `targetDurationSec` is the video's real length: when the master already
 * carries the tail, it IS the master, so the tail is never added a second time
 * as a silent pad and the narration is never cut short by it.
 *
 * Pure and exported so that rule is testable without a render.
 */
export function resolveVideoLengths(opts: {
  /** The duration the source actually has: the merged master, the chapters, or the narration file. */
  sourceDurationSec: number
  /** Seconds of closing music already inside that source. 0 when there is none. */
  bakedClosingTailSec: number
  postAudio: VideoPostAudio | undefined
}): { narrationDurationSec: number; postRollSec: number; targetDurationSec: number } {
  const source = Number(opts.sourceDurationSec) || 0
  const baked = Math.max(0, Number(opts.bakedClosingTailSec) || 0)
  if (baked > 0) {
    const narrationDurationSec = narrationSecFromMaster(source, baked)
    return { narrationDurationSec, postRollSec: baked, targetDurationSec: narrationDurationSec + baked }
  }
  const postRollSec = postRollSeconds(opts.postAudio)
  return { narrationDurationSec: source, postRollSec, targetDurationSec: source + postRollSec }
}

/**
 * Seconds the narration should start after the composed opening.
 *
 * Only for a Scene Plan render whose opening the plan did not reserve, and
 * only when that opening is silent picture (title image / card / stills): an
 * intro VIDEO's sound already lives inside the merged audio (Audio Assembly),
 * so delaying the narration there would push the intro audio under scene 1 —
 * that case keeps the existing warning and the page warns before Generate.
 */
export function narrationLeadInForOpening(opts: {
  planStrict: boolean
  sceneTimelineOffsetSec: number
  introVideoInOpening: boolean
}): number {
  if (!opts.planStrict || opts.introVideoInOpening) return 0
  return opts.sceneTimelineOffsetSec >= 0.05 ? opts.sceneTimelineOffsetSec : 0
}

/**
 * Run the final-encode tiers in order until one produces a valid file.
 *
 * Cancellation is checked before every tier and after every failed attempt:
 * Cancel kills the running encoder, and that kill must end the chain — it is
 * not an encode failure to recover from. (Dreamlands E2E 2026-10-03: a cancelled
 * render's SIGKILLed encoder was read as a failure and tier 4 started a
 * subtitle-less "recovery" encode for a job already marked cancelled.)
 */
export async function runEncodeTierChain<T extends EncodeTier>(
  tiers: T[],
  io: {
    run: (args: string[]) => Promise<void>
    validate: () => Promise<void>
    log: (line: string) => void
    logCmd: (args: string[], note?: string) => void
    isCancelled: () => boolean
  },
): Promise<{ succeededTier: T | null; lastError: any; cancelled: boolean }> {
  let lastError: any = null
  for (let i = 0; i < tiers.length; i++) {
    if (io.isCancelled()) return { succeededTier: null, lastError, cancelled: true }
    const tier = tiers[i]
    if (i > 0 && tier.shouldRun && !tier.shouldRun(lastError)) continue

    const args = tier.build()
    if (i === 0) {
      io.log(`Codec: ${tier.label}`)
    } else {
      const stderrSnippet = (lastError?.stderr || '').split('\n').filter((l: string) => l.trim()).slice(-3).join(' | ')
      io.log(
        `⚠ Encode tier ${i} failed (${stderrSnippet || lastError?.message || 'unknown'}). ` +
        `Trying tier ${i + 1}: ${tier.label}` +
        (tier.degraded ? ` — ${tier.degraded}` : ''),
      )
    }
    io.logCmd(args, tier.note)
    try {
      await io.run(args)
    } catch (error) {
      lastError = error
      continue
    }
    if (io.isCancelled()) return { succeededTier: null, lastError, cancelled: true }
    try {
      await io.validate()
      return { succeededTier: tier, lastError, cancelled: false }
    } catch (validateErr) {
      lastError = validateErr
    }
  }
  return { succeededTier: null, lastError, cancelled: io.isCancelled() }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the episode folder by code, optionally disambiguated by title.
 *
 * Historical gotcha: users who rename an episode after accepting it can
 * end up with TWO folders that both start with the same `{code} - ` prefix
 * (the old title and the new one). Without a title hint, first-match
 * returns the alphabetically earlier one — which may be the stale folder,
 * causing video-assembly to report missing assets even though the real
 * folder has everything. When `titleHint` is provided we require an exact
 * "{code} - {titleHint}" match first, then fall back to any folder
 * starting with the code.
 */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

function extractSceneNumber(filename: string): number | null {
  const match = filename.match(/scene[_\s]*(\d+)/i)
  if (match) return parseInt(match[1], 10)
  const thumbMatch = filename.match(/thumb[_\s]*(\d+)/i)
  if (thumbMatch) return parseInt(thumbMatch[1], 10)
  return null
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
}

function getXfadeTransition(transition: string): string {
  const map: Record<string, string> = {
    'crossfade': 'fade',
    'fade-black': 'fadeblack',
    'dissolve': 'dissolve',
    'wipe-left': 'wipeleft',
    'wipe-right': 'wiperight',
    'none': 'fade',
  }
  return map[transition] || 'fade'
}

function getStyleColor(style: string): string {
  const map: Record<string, string> = {
    'gold': 'gold',
    'white': 'white',
    'neon': '00ffcc',
    'minimal': 'white@0.8',
  }
  return map[style] || 'white'
}

/**
 * `unit` is the frame's SHORT edge, not its height (v1.4.15). On every
 * landscape canvas the two are the same number, so nothing that shipped moves;
 * on a portrait canvas the height is the LONG edge and sizing text against it
 * produced captions nearly twice as wide as the frame could hold.
 */
function getFontSize(size: string, unit: number): number {
  const map: Record<string, number> = {
    'small': unit / 25,
    'medium': unit / 18,
    'large': unit / 12,
  }
  return Math.round(map[size] || map['medium'])
}

function getTextPosition(position: string, height: number): string {
  const map: Record<string, string> = {
    'top': `${Math.round(height * 0.08)}`,
    'center': '(h-text_h)/2',
    'bottom': `${Math.round(height * 0.85)}`,
  }
  return map[position] || map['center']
}
