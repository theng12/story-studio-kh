/**
 * Safety checks (1.4.300) — owner 2026-10-12: "Any other guard we have that doesn't have a UI control?
 * I may or may not want to enable it. So same application of control please." and, for loudness,
 * "Yes, turn it off".
 *
 * Every check that can stop, hold or skip an episode has one per-channel switch:
 *   off   — carry on (or fix it by itself) and write it in the job log;
 *   warn  — carry on and put a warning on the job;
 *   block — stop, as Story always did.
 * Defaults follow the owner's lenient rule: Off or Warn, except checks that stop genuinely broken output
 * (silent or missing audio, missing video, a non-private upload, the wrong channel), which default to
 * Block and can still be switched. A few checks are fixed (`locked`) — nothing can be made without them,
 * the money rule, or not switchable yet — and say why.
 *
 * Stored in the channel's config as `safety_checks: { [id]: mode }`; only changed rows are saved.
 * Inventory with sources: _orchestra/audit-20261012/safety-checks/CHECKS.md.
 */
import { nonRetryable } from './job-retry-policy.js'
import type { Job } from '../models/types.js'

export type SafetyMode = 'off' | 'warn' | 'block'
export const SAFETY_MODES: readonly SafetyMode[] = ['off', 'warn', 'block']

export interface SafetyCheckDef {
  id: string
  group: string
  name: string
  /** One plain-English line: what goes wrong without it. */
  protects: string
  default: SafetyMode
  /** Cannot be switched: this mode always applies, for `locked_reason`. */
  locked?: SafetyMode
  locked_reason?: string
}

const NOTHING_TO_MAKE = 'Cannot be switched: nothing can be made without it.'
const NOT_YET = 'Cannot be switched yet; this is how it works today.'
const LOCKED: Record<string, [SafetyMode, string]> = {
  gateway_key: ['block', NOTHING_TO_MAKE],
  model_available: ['block', NOTHING_TO_MAKE],
  narration_script: ['block', NOTHING_TO_MAKE],
  ffmpeg: ['block', NOTHING_TO_MAKE],
  upload_quota: ['block', 'Cannot be switched: YouTube sets this limit.'],
  paid_not_repeated: ['block', 'Cannot be switched: paid work is never repeated by itself (your money rule). Settings → Performance has the Paid replacements switch.'],
  model_limits: ['block', 'Cannot be switched: a broken model limit is caught when the Gateway catalogue is read, before any channel is known.'],
  narration_parts: ['block', 'Cannot be switched: without every part there is no narration to carry on with.'],
  merged_audio_made: ['block', 'Cannot be switched: an empty merged narration would only fail at Video Assembly.'],
  private_upload: ['block', 'Cannot be switched: Story only uploads private (or what you choose in Upload Center).'],
  not_on_youtube: ['block', 'Cannot be switched: a second copy would replace the first video\'s record.'],
  // Video Assembly and scene pictures: not switchable yet (1.4.300).
  scene_pictures: ['warn', NOT_YET + ' A missing free picture borrows a neighbour\'s, up to 1 in 10 scenes.'],
  scenes_approved: ['block', NOT_YET + ' Turn on "approve generated pictures" in the Scene Review preset to skip it.'],
  stale_picture: ['off', NOT_YET + ' Pictures from an older prompt are used and named in the log.'],
  picture_opens: ['block', NOT_YET],
  scene_overlap: ['off', NOT_YET + ' Overlaps are re-aligned by themselves.'],
  narration_covered: ['block', NOT_YET],
  scene_count: ['block', NOT_YET],
  merged_audio_exists: ['block', NOT_YET],
  subtitles_this_episode: ['block', NOT_YET],
  switched_on_inputs: ['block', NOT_YET],
  cues_approved: ['block', NOT_YET],
  opening_outro: ['block', NOT_YET],
  image_pool_covers: ['block', NOT_YET],
  final_video_whole: ['block', NOT_YET],
}

const c = (group: string, id: string, name: string, protects: string, def: SafetyMode): SafetyCheckDef => {
  const locked = LOCKED[id]
  return { id, group, name, protects, default: locked ? locked[0] : def, ...(locked ? { locked: locked[0], locked_reason: locked[1] } : {}) }
}

export const SAFETY_CHECKS: readonly SafetyCheckDef[] = [
  c('Pipeline start', 'accepted_idea', 'Episode is an accepted idea', 'Running work on an idea that is not an episode yet.', 'block'),
  c('Pipeline start', 'earlier_step_done', 'Earlier step is done', 'A step running before what it needs exists (for example Video before Scene Review).', 'warn'),
  c('Pipeline start', 'step_preset', 'A saved preset for each ticked step', 'Running a step with no saved settings.', 'warn'),
  c('Pipeline start', 'preset_files', 'Preset files are reachable', 'A preset pointing at a file on a drive that is not connected.', 'warn'),
  c('Pipeline start', 'audio_voice', 'Audio preset has a voice', 'Narration with no voice chosen (no audio would be made).', 'block'),
  c('Pipeline start', 'step_fits_channel', 'Step fits this channel type', 'Music steps on a story channel, and the reverse.', 'warn'),
  c('Pipeline start', 'cues_feature_on', 'Contextual Cues step needs the feature on', 'Running cues on a channel with cues switched off.', 'warn'),
  c('Pipeline start', 'retired_media', 'Media removed on purpose is not rebuilt', 'Remaking files Free Up Space removed from uploaded episodes.', 'block'),
  c('Pipeline start', 'disk_space', 'Enough free disk space', 'Running out of space in the middle of a run.', 'warn'),
  c('Pipeline start', 'captions_missing', 'Captions on but no subtitles', 'A video without the captions you expected.', 'warn'),
  c('Script and research', 'research_approved', 'Research claims approved', 'Unchecked facts going into a script.', 'block'),
  c('Script and research', 'outline_approved', 'Outline approved before chapters', 'Writing chapters from an outline you have not seen.', 'off'),
  c('Script and research', 'all_chapters_written', 'Every outline chapter written', 'A script with a missing chapter (a hole in the narration).', 'block'),
  c('Script and research', 'chapter_once', 'Each chapter used only once', 'A chapter read twice in the narration.', 'off'),
  c('Script and research', 'lost_writing_request', 'Lost writing request', 'A writing answer the Gateway lost after it was sent (resent once).', 'off'),
  c('Models, keys and money', 'gateway_key', 'Gateway key and credits', 'Sending work with no key or no credits.', 'block'),
  c('Models, keys and money', 'model_available', 'Model is available', 'Using a model that is gone, locked or switched off.', 'block'),
  c('Models, keys and money', 'paid_not_repeated', 'Paid work is not repeated by itself', 'Being charged twice for paid pictures, voice or transcription.', 'warn'),
  c('Models, keys and money', 'saved_request_matches', 'Saved request still matches', 'Collecting or resending the wrong earlier request.', 'warn'),
  c('Models, keys and money', 'model_limits', 'Malformed model limits', 'A writing model that publishes a broken output limit.', 'warn'),
  c('Narration', 'narration_script', 'Narration script exists', 'Making audio with no script.', 'block'),
  c('Narration', 'narration_parts', 'Every narration part made', 'An episode with missing narration parts.', 'block'),
  c('Narration', 'narration_switch_in', 'New narration can be switched in', 'Switching to new audio that is missing, broken or from another voice.', 'block'),
  c('Narration', 'narration_says_script', 'Narration says every script sentence', 'The voice skipping a sentence.', 'warn'),
  c('Audio Assembly', 'chapter_audio_present', 'All chapter audio present', 'Joining a narration with a chapter missing or chosen twice.', 'block'),
  c('Audio Assembly', 'intro_audio', 'Intro audio file found', 'An intro sound that is missing.', 'warn'),
  c('Audio Assembly', 'merged_audio_made', 'Merged narration made and measurable', 'An empty or unreadable merged file.', 'block'),
  c('Audio Assembly', 'silent_narration', 'Merged narration is not silent', 'A whole episode rendered over a silent narration.', 'block'),
  c('Audio Assembly', 'loudness', 'Loudness within your allowance', 'A video quieter or louder than the target (it is always levelled and never clips).', 'off'),
  c('Subtitles', 'chapters_transcribed', 'Every chapter transcribed', 'Scene timing with chapters missing.', 'block'),
  c('Subtitles', 'caption_gap', 'No caption gap over 30 seconds', 'A stretch of speech that was not transcribed.', 'warn'),
  c('Subtitles', 'subtitles_match_audio', 'Subtitles match today\'s audio', 'Captions made from an older recording of a chapter.', 'warn'),
  c('Subtitles', 'stitched_subtitles', 'Joined subtitle file checks out', 'A joined caption file that was cut short or edited.', 'warn'),
  c('Scene Plan', 'plan_in_step', 'Scene Plan in step with narration', 'Pictures shown under the wrong words (re-aligned by itself).', 'off'),
  c('Scene Plan', 'plan_reaches_end', 'Scene Plan reaches the end of the narration', 'A plan built from an older, shorter narration.', 'warn'),
  c('Scene Plan', 'plan_can_continue', 'Saved Scene Plan can safely continue', 'Continuing a plan whose rhythm or opening has changed.', 'warn'),
  c('Scene Plan', 'scene_prompts', 'Every scene has a picture prompt', 'A scene with no picture prompt.', 'warn'),
  c('Cues and Sound Design', 'cue_review', 'Cue review before Scene Review', 'Pictures made before you decided on cues.', 'off'),
  c('Cues and Sound Design', 'cues_approved', 'Cues / Sound Design on but nothing approved', 'A video missing an effect you switched on.', 'warn'),
  c('Scene pictures', 'scene_pictures', 'Every scene picture made', 'Missing pictures (a neighbour\'s picture can stand in).', 'warn'),
  c('Scene pictures', 'scenes_approved', 'Every scene approved', 'Unreviewed pictures in a video.', 'off'),
  c('Scene pictures', 'stale_picture', 'Picture drawn from an older prompt', 'A picture that no longer matches its edited prompt.', 'off'),
  c('Scene pictures', 'picture_opens', 'Picture file opens', 'A corrupt picture reaching the encoder.', 'warn'),
  c('Video Assembly', 'scene_overlap', 'Scene times do not overlap', 'Two scenes claiming the same seconds (re-aligned by itself).', 'off'),
  c('Video Assembly', 'narration_covered', 'Every second of narration has a scene', 'Black or frozen frames.', 'warn'),
  c('Video Assembly', 'scene_count', 'Scene count matches the plan', 'A video built from a partial set of pictures.', 'warn'),
  c('Video Assembly', 'merged_audio_exists', 'Merged narration exists', 'A video with no sound.', 'block'),
  c('Video Assembly', 'subtitles_this_episode', 'Subtitle file belongs to this episode', 'Another episode\'s words burned into this video.', 'block'),
  c('Video Assembly', 'switched_on_inputs', 'Everything switched on has its file', 'A video missing a switched-on intro, outro, logo or overlay.', 'warn'),
  c('Video Assembly', 'opening_outro', 'Opening and outro add up', 'A plan that reserves an opening the video no longer plays.', 'warn'),
  c('Video Assembly', 'image_pool_covers', 'Image Pool covers the narration', 'Image Pool episodes with too few pictures.', 'warn'),
  c('Video Assembly', 'final_video_whole', 'Final video is whole', 'A video that stopped early or is the wrong length.', 'block'),
  c('Video Assembly', 'ffmpeg', 'FFmpeg present and complete', 'Rendering with no video engine.', 'block'),
  c('Metadata', 'chapter_marks', 'Chapter marks before the description', 'A YouTube description with no chapter times.', 'warn'),
  c('Upload', 'right_channel', 'Right channel and account', 'Uploading to the wrong channel.', 'block'),
  c('Upload', 'private_upload', 'Upload stays private unless you choose', 'A public or unlisted upload you did not choose.', 'block'),
  c('Upload', 'not_on_youtube', 'Not already on YouTube', 'A second copy of the same episode on YouTube.', 'block'),
  c('Upload', 'episode_number_claim', 'Episode number used by another project', 'Two videos with the same episode number on one channel.', 'warn'),
  c('Upload', 'reviewed_unchanged', 'Reviewed video and details unchanged', 'Uploading a file or title that changed after you reviewed it.', 'block'),
  c('Upload', 'thumbnail_present', 'Thumbnail present', 'A video going up with YouTube\'s own frame grab.', 'warn'),
  c('Upload', 'valid_video', 'File is a valid YouTube video', 'Uploading a file with no picture, no sound, no length, or over 11 hours.', 'block'),
  c('Upload', 'upload_quota', 'Daily upload allowance left', 'Running out of YouTube\'s daily allowance mid-upload.', 'block'),
  c('Queue', 'same_step_queued', 'Same step not already queued', 'Two copies of the same step for one episode (the second waits instead).', 'off'),
  c('Music and ideas', 'lyrics_listen_back', 'Sung lyrics listen-back', 'A sung take that does not sing the lyrics.', 'block'),
  c('Music and ideas', 'idea_repeat', 'Idea repeat check by meaning', 'A new idea that repeats an old one.', 'block'),
]

const BY_ID = new Map(SAFETY_CHECKS.map(check => [check.id, check]))

export function isSafetyMode(value: unknown): value is SafetyMode {
  return SAFETY_MODES.includes(value as SafetyMode)
}

/** The mode of `id` in a channel config (its saved choice, else the default). An unknown id is Block. */
export function safetyModeFromConfig(config: { safety_checks?: Record<string, unknown> } | null | undefined, id: string): SafetyMode {
  const def = BY_ID.get(id)
  if (!def) return 'block'
  if (def.locked) return def.locked
  const saved = config?.safety_checks?.[id]
  return isSafetyMode(saved) ? saved : def.default
}

export async function safetyMode(slug: string, id: string): Promise<SafetyMode> {
  const pm = await import('./project-manager.js')
  return safetyModeFromConfig(await pm.getConfig(slug).catch(() => null), id)
}

/**
 * Apply a check that failed. Block throws `message` as a stop that retrying will not fix (Story's
 * behaviour before 1.4.300); Off and Warn log it and return so the caller carries on. Warn also lists
 * it on the job (`result.safety_warnings`), which the job page shows.
 */
export async function safetyGate(
  slug: string,
  id: string,
  job: Pick<Job, 'output_lines'> & { result?: Job['result'] } | undefined,
  message: string,
): Promise<SafetyMode> {
  const mode = await safetyMode(slug, id)
  if (mode === 'block') throw nonRetryable(new Error(message))
  const name = BY_ID.get(id)?.name || id
  if (job) {
    job.output_lines.push(`${mode === 'warn' ? '⚠ ' : ''}${message} The safety check "${name}" is set to `
      + `${mode === 'warn' ? 'Warn' : 'Off'} for this channel, so this carries on.`)
    if (mode === 'warn') {
      const result = (job.result || {}) as Record<string, unknown>
      const warnings = Array.isArray(result.safety_warnings) ? result.safety_warnings as unknown[] : []
      job.result = { ...result, safety_warnings: [...warnings, { check: id, message }] } as Job['result']
    }
  }
  return mode
}
