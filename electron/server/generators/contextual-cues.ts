/**
 * Contextual Cues proposal job.
 *
 * This is intentionally a small number of structured GenStudio requests, not
 * one request per scene. It writes only proposed editorial data; rendering is
 * handled later by Video Assembly after a person resolves every proposal.
 */
import fs from 'fs/promises'
import { existsSync } from 'fs'
import { callAi, callAiWithModelPolicy, sanitizeJsonControlChars } from '../lib/ai-client.js'
import { freshGenerationRequestIdentity } from '../lib/fresh-generation-action.js'
import { resolveEpisodePathsByCodeWithSidecar, resolveScenePlanPath } from '../services/utils.js'
import { getConfig } from '../services/project-manager.js'
import { checkpointJobState, isCancelled, isPauseRequested, throwIfPauseRequested } from '../services/job-queue.js'
import { requireJobCompletion } from '../services/job-completion.js'
import {
  autoApproveEligibleCues,
  contextualCueProgressFingerprint,
  CUE_MIN_DURATION_SEC,
  normalizeCuePositionPair,
  isReleasedContextualCueBackpressure,
  normalizeContextualCueConfig,
  readContextualCueProgress,
  readContextualCueTimeline,
  removeContextualCueProgress,
  normalizeContextualCueProposalSettings,
  resolveContextualCueBatchSize,
  normalizeContextualCueTemplate,
  validateContextualCueTimeline,
  writeContextualCueProgress,
  writeContextualCueTimeline,
  type ContextualCueProgress,
} from '../services/contextual-cues.js'
import {
  DEFAULT_SOUND_DESIGN_SETTINGS,
  normalizeSoundDesignConfig,
  readSoundDesignTimeline,
  validateSoundDesignTimeline,
  writeSoundDesignTimeline,
} from '../services/sound-design.js'
import { anchorPhraseAt, reconcileAnchoredCues, type CueTiming } from '../contracts/cue-anchor.js'
import { readEpisodeCueTiming } from '../services/sound-cue-anchors.js'
import { stitchedSrtPath } from '../services/subtitle-correction.js'
import { readLabelDesigns } from '../lib/label-design-render.js'
import type { LabelDesign } from '../contracts/label-design.js'
import { applySound, selectSound, type SoundCandidate } from '../services/sound-resolver.js'
import { SCENE_PLAN_FILENAME } from './scene-plan.js'
import type {
  ContextualCue, ContextualCueAutoApprovalHold, ContextualCueKind, ContextualCueProposalSettings,
  ContextualCueTemplate, ContextualCueTimeline, ContextualCueTransition, Job, ScenePlan, SoundDesignCue, SoundDesignCueKind,
} from '../models/types.js'
import { CONTEXTUAL_CUES_OUTPUT_CONTRACT } from '../lib/story-output-contracts.js'
import {
  GenStudioChatCapabilityUnavailableError,
  GenStudioChatProductUnavailableError,
  GenStudioChatTerminalFailureError,
  GenStudioTerminalFailureError,
  genStudioAdmissionSnapshot,
  listChatModels,
  type GenStudioChatModel,
} from '../lib/genstudio-client.js'
import { fleetBusyRetryPlan, freeMacWaitLine, isFleetBusyFailure, type FleetBusyRetryPlan } from '../lib/genstudio-fleet-busy.js'
import { getApiKey } from '../services/app-secrets-store.js'
import { resolveGenStudioModelId } from '../services/genstudio-model-migration.js'
import { truncateChars } from '../lib/well-formed-text.js'
import { applyEmojiPolicy, noEmojiDirective } from '../lib/emoji-policy.js'
import { pipelinePolicyCheckpointStore, pipelinePolicyForJob } from '../lib/pipeline-model-policy.js'
import { resolveDefaultModel } from '../services/genstudio-default-model.js'

interface CueCandidate {
  scene_id: string
  title: string
  subtitle?: string
  kind?: ContextualCueKind
  template?: ContextualCueTemplate
  /** 2026-10-30 — what a POINTING design should point at, in a few plain words. */
  point_at?: string
  /** 2026-10-30 — the preset's motion for this cue, when its `label_motions` named any. */
  motion?: string
  /** v1.4.365 — the words the narration says as this label appears. */
  anchor_word?: string
  anchor_offset_sec?: number
  /** v1.4.365 — the sound this moment wants, chosen for the same moment. */
  sound?: { kind: SoundDesignCueKind; description: string; with_label?: boolean }
}

/** The four text templates a run with no `label_themes` uses, exactly as before. */
const LEGACY_CUE_TEMPLATES = ['documentary-label', 'map-pin', 'archival-caption', 'chapter-plate'] as const

/** The motions a cue can actually be drawn with; a name outside these cannot render. */
const LEGAL_CUE_MOTIONS = new Set(['fade', 'slide', 'dissolve', 'pop', 'wipe', 'line-draw', 'pulse', 'float'])

/**
 * What ONE run's preset lets the model name \u2014 real ids, resolved from the live
 * `label-designs` catalogue at run time. Nothing here is a catalogue copy: a
 * design added or renamed upstream is picked up by the next run on its own.
 */
export interface CueChoiceAllowlist {
  /** Template ids in play: the four text templates, or the designs the preset's themes select. */
  templates: Set<string>
  /** Motions the preset allowed; empty means today's fixed fade. */
  motions: Set<string>
  /** The selected designs, described for the prompt. Empty when no themes were named. */
  designs: Pick<LabelDesign, 'id' | 'name' | 'theme'>[]
}

/** No fields set: what every proposal has always done. */
const TEXT_ONLY_ALLOW: CueChoiceAllowlist = {
  templates: new Set(LEGACY_CUE_TEMPLATES),
  motions: new Set(),
  designs: [],
}

/**
 * What the model is told, for BOTH halves (v1.4.365).
 *
 * The sound is asked for in the same answer as the label on purpose. The label
 * says what the moment IS; a sound is then chosen for that moment. Asking a
 * second, separate request for "a sound for scene 37" loses that context and
 * costs a second paid batch to guess at what the first answer already knew.
 *
 * `anchor_word` is the phrase the narration speaks as the label appears. It is
 * what puts the label where the words are instead of on a fixed pad, and what
 * lets a Scene Plan re-run carry it along.
 */
const SYSTEM_PROMPT_HEAD = 'You are a restrained documentary editor. Return strict JSON only: '
  + '{"cues":[{"scene_id":"exact input id","title":"short label","subtitle":"optional second line",'
  + '"kind":"location_date|historical_context|person|chapter",'
  + '"template":"id of the treatment that should draw this label",'
  + '"point_at":"short plain phrase for what a pointing design points at",'
  + '"anchor_word":"the exact 2-5 words the narration says as this label appears",'
  + '"anchor_offset_sec":0.2,'
  + '"sound":{"kind":"bed|spot","description":"what we would hear, e.g. wind across dry grass"}}]}. '
  + 'Propose only genuinely useful on-screen context: location/date, historical event or era, '
  + 'important institution/person, or a short explanatory label. '

/**
 * What a label is FOR (2026-10-30, owner: a one-click run chooses labels with
 * nobody picking anything, and not every scene gets one).
 */
const LABEL_SELECTION_RULE = 'Label only what the viewer gains from: a named place, or a named person the '
  + 'first time they appear, a jump in time, a striking number, something in the picture worth pointing at, '
  + 'or a new chapter or question. Never a repeat, never an unnamed everyday thing, never words the narrator '
  + 'is saying with nothing added, and never anything uncertain. '

const SYSTEM_PROMPT_TAIL = 'point_at is optional: give it only when the design points, naming what in the '
  + 'frame it should point at. '
  + 'anchor_word must appear VERBATIM in that scene\u2019s narration \u2014 copy it, do not paraphrase. '
  + 'sound is optional: give one only when a specific sound genuinely serves the moment, name a '
  + '`bed` for continuous ambience that should sit under the scene or a `spot` for one brief effect. '
  + 'Do not repeat narration, do not label every scene, never use more than one cue per scene, '
  + 'and prefer no cue when uncertain.'

/**
 * The system prompt for one run: the same editorial rules always, plus the
 * choices THIS preset actually allows. Nothing in it is a stored catalogue \u2014
 * the design ids come from the read that `resolveCueChoiceAllowlist` just did.
 */
export function cueSystemPrompt(allow: CueChoiceAllowlist = TEXT_ONLY_ALLOW): string {
  const templateGuidance = allow.designs.length
    ? `template MUST be one of these label design ids, chosen for what the moment is: `
      + `${allow.designs.map(design => `${design.id} (${design.name}, ${design.theme})`).join(', ')}. `
    : `template MUST be one of: ${[...allow.templates].join(', ')}. `
  const motionGuidance = allow.motions.size
    ? `motion MUST be one of: ${[...allow.motions].join(', ')} \u2014 give it as "motion":"<id>" on each cue. `
    : ''
  return SYSTEM_PROMPT_HEAD + templateGuidance + LABEL_SELECTION_RULE + motionGuidance + SYSTEM_PROMPT_TAIL
}

/**
 * Resolve one run's allowed designs and motions from the preset, reading the
 * catalogue live. A choice this app cannot draw is refused HERE, by name and
 * before the first paid request, rather than silently narrowed to the subset it
 * happens to like \u2014 a customer who asked for a theme that no design carries
 * must be told so, not shown a run that quietly used something else.
 */
export async function resolveCueChoiceAllowlist(
  settings: ContextualCueProposalSettings,
  hiddenDesigns: string[] = [],
): Promise<CueChoiceAllowlist> {
  const hidden = new Set(hiddenDesigns)
  const themes = settings.label_themes ?? []
  const motions = settings.label_motions ?? []
  const illegal = motions.filter(motion => !LEGAL_CUE_MOTIONS.has(motion))
  if (illegal.length) {
    throw new Error(`label_motions names ${illegal.join(', ')}, which is not a cue motion supported by this app. Nothing was requested.`)
  }
  if (!themes.length) {
    const templates = new Set(LEGACY_CUE_TEMPLATES.filter(id => !hidden.has(id)))
    if (!templates.size) throw new Error('All classic label designs are hidden. Restore one to propose labels.')
    return { ...TEXT_ONLY_ALLOW, templates, motions: new Set(motions) }
  }
  let designs: LabelDesign[]
  try {
    designs = await readLabelDesigns()
  } catch (error) {
    throw new Error(`The label designs could not be read: ${error instanceof Error ? error.message : String(error)}. Nothing was requested.`, { cause: error })
  }
  const selected = designs.filter(design => themes.includes(design.theme) && !hidden.has(design.id))
  if (!selected.length) {
    throw new Error(`No visible label design carries any of this preset's label_themes (${themes.join(', ')}). Nothing was requested.`)
  }
  return { templates: new Set(selected.map(design => design.id)), motions: new Set(motions), designs: selected }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

const CONTEXTUAL_CUE_BACKPRESSURE_RETRIES = 2
const CONTEXTUAL_CUE_BACKPRESSURE_COOLDOWN_MS = 15_000

function assertContextualCueCapability(model: GenStudioChatModel, itemCount: number): void {
  if (model.structured_output_mode === 'none') {
    throw new GenStudioChatCapabilityUnavailableError(model.id, 'it publishes no structured-output support for contextual-cue JSON')
  }
  // AN UNPUBLISHED ITEM LIMIT IS NOT A LIMIT OF ZERO (fixed 2026-09-26, owner
  // ruling: we follow what a model publishes and invent no ceiling of our own).
  // This used to refuse whenever `max_structured_items_per_request` was null —
  // which is what every row publishes today, including the local lane — so an
  // absent number decided that the model could not do work it may well be able
  // to do, and the refusal read "above its published unpublished item limit".
  // Now only a PUBLISHED limit can refuse. When nothing is published the batch
  // goes out bounded by the token budget (`resolveContextualCueBatchSize` sizes
  // from the policy default rather than inventing a cap), and a provider
  // refusal is the answer if the lane disagrees.
  const published = model.max_structured_items_per_request
  const structuredItemLimit = typeof published === 'number' && Number.isInteger(published) && published > 0
    ? published
    : null
  if (structuredItemLimit === null) return
  if (structuredItemLimit < itemCount) {
    throw new GenStudioChatCapabilityUnavailableError(
      model.id,
      `this cue batch requires ${itemCount} structured items, above its published item limit of ${structuredItemLimit}`,
    )
  }
}

/**
 * The short wait used for request pacing and for the backpressure cooldown.
 *
 * v1.4.35 — it now honours Pause as well as Cancel. It had only ever checked
 * Cancel, so a Pause pressed during a pacing delay or a 15-second cooldown was
 * ignored and the batch went on to submit a paid request anyway. Pause raises
 * `JobPausedError`, which the job queue settles as `paused` — accepted provider
 * work is allowed to finish and save, and Resume submits only what is still
 * missing. Throwing a plain Error here instead would have marked the job
 * FAILED for doing exactly what the owner asked.
 */
async function waitWhileActive(jobId: string, delayMs: number): Promise<void> {
  const deadline = Date.now() + delayMs
  while (Date.now() < deadline) {
    if (isCancelled(jobId)) throw new Error('Cancelled by user')
    throwIfPauseRequested(jobId)
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())))
  }
}

/**
 * The modality every request in this generator belongs to.
 *
 * `callAi` reaches GenStudio's durable language endpoint, whose failures arrive
 * as `GenStudioChatTerminalFailureError` — and that class builds its base with
 * `super('chat', job, …)` in lib/genstudio-client.ts. Named here rather than
 * spelled inline at the call site so the test can assert it against a LIVE
 * error instance: if the string upstream is ever renamed, the test fails loudly
 * instead of the guard below silently matching nothing and quietly turning the
 * retry off again. A saturated image or TTS queue says nothing about whether
 * THIS batch's credits came back.
 */
export const CONTEXTUAL_CUE_GENSTUDIO_MODALITY = 'chat'

/**
 * v1.4.33 — "every machine was busy", the second failure this generator asks
 * about again, and the last one it will.
 *
 * WHY. GenStudio places every job on a fleet machine, and with none free it
 * settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after a fifteen-minute
 * placement window. A generator that does not recognise that DROPS the item and
 * tells the owner to re-run it by hand. It has already happened twice:
 * transcription lost 122 of 353 items in one burst, and TTS lost 5 over three
 * days that nobody noticed for nine, because the only symptom is a missing
 * asset a later manual retry quietly fills in. Here a refusal does not lose one
 * cue — it throws out of the batch loop and ends the episode's whole proposal
 * pass, discarding every batch not yet written to the progress file.
 *
 * WHY RESUBMITTING IS FREE. GenStudio raises this code from one place and says
 * there what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further: a provider that WAS
 * engaged may already have done and billed the work, which is why a "Repair &
 * Retry all" button was removed from this app in v1.0.114.
 *
 * WHY ITS OWN LADDER, SEPARATE FROM BACKPRESSURE. This generator already
 * retried one capacity failure — `LANGUAGE_PROVIDER_BACKPRESSURE`, two attempts
 * fifteen seconds apart. That is the right shape for a provider shedding load
 * for a moment and the wrong shape for a saturated fleet, which GenStudio has
 * ALREADY waited fifteen minutes on before saying so: a fifteen-second retry
 * rejoins the same jam and burns the attempt. The two ladders therefore stay
 * separate and neither spends the other's budget, which also leaves the
 * backpressure path behaving exactly as it did before this existed.
 *
 * This deliberately does NOT reuse `generators/images.ts`'s `imageRetryPlan`,
 * which ALSO retries a declined route (`CLOUD_PROVIDER_EXHAUSTED`) on a
 * seconds-long schedule and hardcodes the image modality; nor
 * `sceneClipFleetBusyRetryPlan`, pinned to `'video'`. Borrowing either to save
 * a few lines would smuggle a second, unasked-for behaviour change into a fix
 * about a busy fleet.
 *
 * Exported as a pure function so the decision is testable on its own, without
 * driving a real episode of paid batches against a saturated fleet to watch it.
 *
 * @param retriesUsed fleet-busy retries already granted for THIS batch.
 */
export function contextualCueFleetBusyRetryPlan(
  error: unknown,
  retriesUsed: number,
): FleetBusyRetryPlan | null {
  if (!isFleetBusyFailure(error, CONTEXTUAL_CUE_GENSTUDIO_MODALITY)) return null
  return fleetBusyRetryPlan(error, CONTEXTUAL_CUE_GENSTUDIO_MODALITY, retriesUsed)
}

/**
 * Sleep before re-asking a busy fleet — in short slices, so a Cancel or a Pause
 * pressed during a five-minute wait is honoured within seconds rather than at
 * the end of it.
 *
 * Separate from `waitWhileActive` above on purpose. That one sleeps in 250ms
 * slices and THROWS on cancel, which is right for a fifteen-second backpressure
 * cooldown, but it does not look at Pause at all — so on its own it would carry
 * a resubmission straight through the owner pressing Pause. This one returns
 * instead of throwing, leaving the caller to re-read both signals and rethrow
 * the original GenStudio failure, so a paused run fails the batch exactly as it
 * does today rather than buying another job.
 *
 * Nothing external can interrupt this wait either. The job queue's stall
 * circuit breaker — which a fleet wait is precisely the thing to trip — has
 * exactly one caller in the app, continuity-render.ts, which had to suppress
 * its own 10-minute pause while waiting. There is no such timer here, and this
 * generator must not grow one without suppressing it around this wait.
 */
async function waitForFleetCapacity(jobId: string, delayMs: number): Promise<void> {
  const deadline = Date.now() + delayMs
  while (Date.now() < deadline) {
    if (isCancelled(jobId) || isPauseRequested(jobId)) return
    await new Promise(resolve => setTimeout(resolve, Math.min(2_000, deadline - Date.now())))
  }
}

function parseCandidates(raw: string): CueCandidate[] {
  const object = JSON.parse(sanitizeJsonControlChars(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')))
  if (!object || !Array.isArray(object.cues)) throw new Error('The Gateway returned no contextual cue list.')
  return object.cues.filter((cue: any): cue is CueCandidate => (
    cue && typeof cue.scene_id === 'string' && typeof cue.title === 'string'
  ))
}

/** The kind this candidate earns; anything unrecognised is the neutral default. */
function candidateKind(candidate: CueCandidate): ContextualCueKind {
  return candidate.kind === 'location_date' || candidate.kind === 'person' || candidate.kind === 'chapter'
    ? candidate.kind
    : 'historical_context'
}

/**
 * The treatment this candidate asks for, or the editorial default for its kind.
 * The model may propose one, but a missing answer still gets a predictable
 * default — and whichever it is, it has to be on this run's allowlist before
 * the cue is kept.
 */
function candidateTemplate(candidate: CueCandidate, kind: ContextualCueKind = candidateKind(candidate)): ContextualCueTemplate {
  const inferred: ContextualCueTemplate = kind === 'location_date'
    ? 'map-pin'
    : kind === 'chapter'
      ? 'chapter-plate'
      : kind === 'person' ? 'archival-caption' : 'documentary-label'
  return candidate.template ? normalizeContextualCueTemplate(candidate.template) : inferred
}

/**
 * The entrance this candidate earns, or null when it named a motion this run's
 * preset does not allow.
 *
 * With no `label_motions` the answer is today's fixed fade and any volunteered
 * motion is ignored — exactly as it was before the field existed. With a list,
 * a motion outside it is refused rather than quietly coerced, and a candidate
 * that named none takes a motion from the list (fade when the list has it), so
 * the cue never lands on a motion the preset ruled out.
 */
function candidateMotion(candidate: CueCandidate, allow: CueChoiceAllowlist): string | null {
  if (!allow.motions.size) return 'fade'
  const asked = String(candidate.motion || '').replace(/\s+/g, ' ').trim()
  if (asked) return allow.motions.has(asked) ? asked as ContextualCueTransition : null
  return (allow.motions.has('fade') ? 'fade' : [...allow.motions][0]!) as ContextualCueTransition
}

function safeCandidate(
  candidate: CueCandidate,
  plan: ScenePlan,
  density: 'restrained' | 'standard' | 'editorial',
  /**
   * The reviewer's saved default placement, stamped onto every proposal
   * exactly as the corner always has been — which is how "keep labels off my
   * logo" is said once for a whole project instead of dragged cue by cue.
   */
  defaults: Pick<ContextualCueProposalSettings, 'placement' | 'position_x_pct' | 'position_y_pct'>,
  now: string,
  /** This run's allowed designs and motions. Defaults to no preset fields set. */
  allow: CueChoiceAllowlist = TEXT_ONLY_ALLOW,
): ContextualCue | null {
  const scene = plan.scenes.find(row => row.id === candidate.scene_id)
  if (!scene) return null
  const title = truncateChars(candidate.title.trim().replace(/\s+/g, ' '), 80)
  const subtitle = truncateChars(candidate.subtitle?.trim().replace(/\s+/g, ' ') || '', 100) || undefined
  if (!title) return null
  const sceneDuration = scene.end_sec - scene.start_sec
  if (sceneDuration < CUE_MIN_DURATION_SEC) return null
  // A cue now hangs on the words being spoken, not on a fixed 0.15s pad
  // (v1.4.365). The model names the phrase; `contracts/cue-anchor.ts` finds it
  // in this episode's own subtitle cues and the absolute seconds follow. The
  // offset is a fallback for a phrase that normalisation made unfindable, and
  // it is what a v1 proposal always used.
  const anchorWord = truncateChars(
    (candidate.anchor_word || '').replace(/\s+/g, ' ').trim()
      || anchorPhraseAt(String(candidate.subtitle || candidate.title || '')),
    80,
  ) || undefined
  // An editorial default for a freshly proposed cue, not a limit. The
  // validator's own ceiling is advisory and far higher; a reviewer is free to
  // stretch any of these afterwards.
  const dwell = Math.min(density === 'editorial' ? 4 : 3.5, sceneDuration)
  const offset = Math.max(0, Math.min(sceneDuration - dwell, Number(candidate.anchor_offset_sec) || 0.15))
  const start = Number((scene.start_sec + offset).toFixed(3))
  const end = Number((start + dwell).toFixed(3))
  const kind = candidateKind(candidate)
  // A treatment outside this run's allowlist is refused here, not coerced:
  // substituting one would give the customer a design he never chose (and a
  // run whose preset named themes would silently draw something else).
  const template = candidateTemplate(candidate, kind)
  if (!allow.templates.has(template)) return null
  const motion = candidateMotion(candidate, allow)
  if (motion === null) return null
  // What a POINTING design should aim at. Stored, not placed: nothing locates
  // it in the frame yet, and inventing a position here would be an editorial
  // decision made by the machine.
  const pointAt = truncateChars((candidate.point_at || '').replace(/\s+/g, ' ').trim(), 80) || undefined
  return {
    id: `cue-${scene.id}`,
    scene_id: scene.id,
    ...(anchorWord ? { anchor_word: anchorWord } : {}),
    anchor_offset_sec: Number(offset.toFixed(3)),
    start_sec: start,
    end_sec: end,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(pointAt ? { point_at: pointAt } : {}),
    kind,
    placement: defaults.placement,
    ...normalizeCuePositionPair(defaults.position_x_pct, defaults.position_y_pct),
    template,
    entrance: (motion === 'fade' || motion === 'dissolve' || motion === 'slide') ? motion : 'fade',
    ...(template.startsWith('label:') && ['pop', 'slide', 'wipe', 'line-draw', 'pulse', 'float'].includes(motion)
      ? { motion: motion as NonNullable<ContextualCue['motion']> } : {}),
    exit: 'dissolve',
    status: 'proposed',
    created_at: now,
    updated_at: now,
  }
}

/** Keep a conservative, non-overlapping proposal set before it reaches review. */
function applySafePacing(cues: ContextualCue[], density: 'restrained' | 'standard' | 'editorial', totalDuration: number, minGap: number): ContextualCue[] {
  const targetSpacing = density === 'editorial' ? 35 : density === 'standard' ? 60 : 90
  const maximum = Math.max(1, Math.ceil(totalDuration / targetSpacing))
  const out: ContextualCue[] = []
  for (const cue of cues.sort((a, b) => a.start_sec - b.start_sec)) {
    if (out.length >= maximum) break
    const previous = out[out.length - 1]
    if (previous && cue.start_sec < previous.end_sec + minGap) continue
    out.push(cue)
  }
  return out
}

export interface DroppedCueCandidate { scene_id: string; title: string; reason: string }

/**
 * Why `safeCandidate` refused this candidate, mirroring its checks in the same
 * order so the reason the customer reads names the check that actually fired —
 * including the two new ones, an unknown design id and a motion the preset
 * never allowed.
 */
function cueDropReason(candidate: CueCandidate, plan: ScenePlan, allow: CueChoiceAllowlist): string {
  const scene = plan.scenes.find(row => row.id === candidate.scene_id)
  if (!scene) return 'its scene is not in the Scene Plan'
  if (!String(candidate.title || '').trim()) return 'it has no title'
  if (scene.end_sec - scene.start_sec < CUE_MIN_DURATION_SEC) return `its scene is shorter than ${CUE_MIN_DURATION_SEC}s`
  const template = candidateTemplate(candidate)
  if (!allow.templates.has(template)) return `its label design "${template}" is not one of this run's allowed label designs`
  if (candidateMotion(candidate, allow) === null) {
    return `its motion "${String(candidate.motion || '').replace(/\s+/g, ' ').trim()}" is not one of this run's allowed motions`
  }
  return 'it did not pass the proposal rules'
}

/**
 * Every candidate the model returned, split into the cues that will be saved
 * and the ones dropped — each with its reason (2026-10-07). This used to drop
 * silently, and the job certified a constant 1/1 whatever happened.
 */
export function accountCueCandidates(
  candidates: CueCandidate[],
  plan: ScenePlan,
  settings: ContextualCueProposalSettings,
  now: string,
  resolvedIds: Set<string>,
  allow: CueChoiceAllowlist = TEXT_ONLY_ALLOW,
  subtitles: readonly CueTiming[] = [],
): { proposed: ContextualCue[]; dropped: DroppedCueCandidate[] } {
  const dropped: DroppedCueCandidate[] = []
  const safe: ContextualCue[] = []
  for (const candidate of candidates) {
    const cue = safeCandidate(candidate, plan, settings.density, settings, now, allow)
    if (cue) { safe.push(cue); continue }
    dropped.push({
      scene_id: String(candidate.scene_id || ''),
      title: String(candidate.title || ''),
      reason: cueDropReason(candidate, plan, allow),
    })
  }
  const anchored = reconcileAnchoredCues(safe, plan, subtitles).cues
  const minGap = normalizeContextualCueProposalSettings(settings).min_gap_sec!
  const paced = applySafePacing(anchored, settings.density, plan.total_duration_sec || plan.scenes[plan.scenes.length - 1]?.end_sec || 0, minGap)
  for (const cue of anchored) {
    if (!paced.includes(cue)) {
      const previous = paced.filter(row => row.start_sec <= cue.start_sec).at(-1)
      const reason = previous && cue.start_sec < previous.end_sec + minGap
        ? `less than ${minGap}s after the previous kept label`
        : `exceeds the "${settings.density}" density limit`
      dropped.push({ scene_id: cue.scene_id, title: cue.title, reason })
    }
  }
  // One cue per scene: a scene the reviewer already resolved keeps that cue.
  return { proposed: paced.filter(cue => !resolvedIds.has(cue.id)), dropped }
}

/**
 * The saved partial proposal this run may continue from, or null.
 *
 * Same run (crash replay, Retry): used as is. A different action for the SAME
 * plan and settings (another "Propose cues" click): carried over under this
 * action's fingerprint, so finished batches are not bought again. Anything
 * whose base fingerprint differs — another Scene Plan, model, density — is
 * never reused.
 */
export function carryOverContextualCueProgress(
  existing: ContextualCueProgress | null,
  baseFingerprint: string,
  fingerprint: string,
): ContextualCueProgress | null {
  if (!existing) return null
  if (existing.fingerprint === fingerprint) return existing
  if (existing.fingerprint.split(':fresh:')[0] !== baseFingerprint) return null
  return { ...existing, fingerprint }
}

export async function generateContextualCues(job: Job): Promise<void> {
  const episodeId = job.episode_id
  if (!episodeId) throw new Error('Contextual Cues needs an episode.')
  const paths = await resolveEpisodePathsByCodeWithSidecar(job.project_slug, episodeId, SCENE_PLAN_FILENAME)
  const planPath = await resolveScenePlanPath(job.project_slug, episodeId, paths.episode_dir)
  if (!existsSync(planPath)) throw new Error('Build Scene Plan before proposing contextual cues.')
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as ScenePlan
  const subtitles = await readEpisodeCueTiming(stitchedSrtPath(paths.subtitles_dir, episodeId))
  if (!plan.scenes?.length) throw new Error('Scene Plan has no scenes to annotate.')
  const config = normalizeContextualCueConfig((await getConfig(job.project_slug))?.contextual_cues)
  if (!config.enabled) throw new Error('Contextual Cues are disabled for this project. Enable them first.')
  const settings = normalizeContextualCueProposalSettings(job.params)
  // Resolved BEFORE the first request: the designs are read live from the
  // catalogue, and a preset naming a theme or motion this app cannot draw is
  // refused here by name rather than after paying for batches it must reject.
  const allow = await resolveCueChoiceAllowlist(settings, config.hidden_label_designs)
  let model = settings.model
  // Last of all, this Mac's app-wide writing default (Settings → Default models). Read only: it is
  // not written into the preset or the channel.
  if (!model) model = await resolveDefaultModel(await getApiKey('genstudio').catch(() => ''), 'writing') || ''
  if (!model) throw new Error('Choose a live Gateway model in Contextual Cues before proposing cues.')

  const apiKey = await getApiKey('genstudio').catch(() => '')
  if (!apiKey) throw new Error('Contextual Cues needs a configured Gateway API Key.')
  const cuesPolicy = pipelinePolicyForJob(job.params, 'contextual_cues')
  const cuesCheckpoint = pipelinePolicyCheckpointStore(job.params, () => checkpointJobState(job))
  const baseFingerprint = contextualCueProgressFingerprint(plan, settings)
  const actionId = job.params?.generation_action?.kind === 'fresh'
    ? job.params.generation_action.id
    : ''
  const fingerprint = actionId ? `${baseFingerprint}:fresh:${actionId}` : baseFingerprint
  // A new "Propose cues" click is a new action id, but batches an earlier
  // click already PAID for are still good for the same plan and settings.
  // They are carried over (under this action's identity, so only the missing
  // batches are requested); anything for a different plan or settings is not.
  const saved = carryOverContextualCueProgress(await readContextualCueProgress(planPath), baseFingerprint, fingerprint)
  if (!saved) await removeContextualCueProgress(planPath)
  // A saved policy run may contain an accepted request. Its batch shape is a
  // historical request fact, so recover it before reading today's catalogue;
  // every still-pending batch revalidates in beforeModelAttempt below.
  let catalogModel: GenStudioChatModel | null = null
  const batchSize = saved && cuesPolicy ? saved.batch_size : 0
  if (!saved || !cuesPolicy) {
    const catalog = await listChatModels(apiKey)
    const planningCandidates = cuesPolicy
      ? [cuesPolicy.assigned_model, ...cuesPolicy.models.filter(candidate => candidate !== cuesPolicy.assigned_model)]
      : [resolveGenStudioModelId('chat', model) || '']
    for (const candidateId of planningCandidates) {
      const candidate = catalog.find(item => item.id === candidateId && item.available)
      if (!candidate) continue
      try { assertContextualCueCapability(candidate, 1); catalogModel = candidate; model = candidate.id; break } catch (error) {
        if (!(error instanceof GenStudioChatCapabilityUnavailableError)) throw error
      }
    }
    if (!catalogModel) throw new Error('None of the selected Contextual Cues products currently publishes structured-output support. No request or credit charge was made.')
  } else {
    model = saved.model
  }
  const resolvedBatchSize = catalogModel
    ? resolveContextualCueBatchSize(catalogModel.max_structured_items_per_request, saved?.batch_size)
    : batchSize
  if (saved && catalogModel && saved.batch_size !== resolvedBatchSize) {
    // The saved batches no longer line up with what GenStudio accepts. Drop
    // them, or every later click would hit this same refusal forever.
    await removeContextualCueProgress(planPath)
    throw new Error('The Gateway now accepts a different number of scenes per request, so the saved partial proposal cannot be reused. Press Propose cues again to start over.')
  }
  const batches = chunk(plan.scenes, resolvedBatchSize)
  const completed = new Map((saved?.completed_batches || []).map(batch => [batch.index, batch]))
  const candidates: CueCandidate[] = [...completed.values()].flatMap(batch => batch.candidates as CueCandidate[])
  const snapshot = genStudioAdmissionSnapshot(apiKey)
  const submissionSpacingMs = Math.ceil(60_000 / Math.max(1, snapshot.generation_submissions_per_minute))
  let progress: ContextualCueProgress = saved || {
    schema_version: 1,
    fingerprint,
    source_scene_plan_generated_at: plan.generated_at,
    model,
    batch_size: resolvedBatchSize,
    total_scenes: plan.scenes.length,
    total_batches: batches.length,
    completed_batches: [],
    updated_at: new Date().toISOString(),
  }
  let lastSubmissionAt = 0
  job.item_progress = {
    total: batches.length,
    completed: completed.size,
    failed: 0,
    concurrency: 1,
    active: [],
  }
  job.output_lines.push(
    `Proposing contextual cues in ${batches.length} paced Gateway batch(es); ${completed.size} saved batch(es) will be reused. Existing approved or disabled cues stay untouched.`,
  )
  for (const [index, scenes] of batches.entries()) {
    if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
    if (completed.has(index)) continue
    const pacingDelay = Math.max(0, lastSubmissionAt + submissionSpacingMs - Date.now())
    if (pacingDelay > 0) {
      job.item_progress.active = [{ label: `Batch ${index + 1}`, key: `batch-${index}`, state: 'waiting_retry', attempt: 1, max_attempts: CONTEXTUAL_CUE_BACKPRESSURE_RETRIES + 1, retry_at: new Date(Date.now() + pacingDelay).toISOString(), reason: 'pacing requests' }]
      await waitWhileActive(job.job_id, pacingDelay)
    }
    let batchCandidates: CueCandidate[] | null = null
    // v1.4.33 — TWO independent retry ladders for this batch, deliberately not
    // one. Provider backpressure keeps its own budget (2 retries, 15s apart)
    // and a busy fleet gets its own (FLEET_BUSY_RETRY_DELAYS_MS, 30s/2m/5m),
    // and neither spends the other's. Sharing a counter would have meant a
    // fleet wait silently eating a backpressure retry — a change to the
    // backpressure path, which must behave exactly as it did before. A batch
    // that alternates between the two codes therefore makes at most
    // 1 + 2 + 3 = 6 submissions and waits at most 30s + 7m30s in total, all of
    // it bounded, and every one of those submissions is for work no provider
    // ever did.
    let attemptNum = 1
    let backpressureRetries = 0
    let fleetBusyRetries = 0
    // The ceiling shown to the owner. It starts at exactly the number this
    // generator has always displayed, so a run that only ever meets
    // backpressure looks identical; a busy fleet raises it to cover the
    // attempts that ladder actually buys, and never lowers it.
    let maxAttempts = CONTEXTUAL_CUE_BACKPRESSURE_RETRIES + 1
    for (;;) {
      // Re-read at the top of EVERY attempt, not just once per batch: a
      // resubmission must never start after the owner has already stopped the
      // run, and a fleet wait runs into minutes.
      if (isCancelled(job.job_id)) throw new Error('Cancelled by user')
      job.item_progress.active = [{ label: `Batch ${index + 1}`, key: `batch-${index}`, state: 'running', attempt: attemptNum, max_attempts: maxAttempts }]
      // Hoisted so it can be handed to the emoji policy as the source text:
      // it carries his narration, and an emoji he wrote into the script means
      // the cues proposed from it are left alone.
      const cueUserPrompt = `PACING: ${settings.density}. Leave at least ${settings.min_gap_sec} seconds between one label ending and the next starting. Cues are small corner labels, shown for 2.25–4.5 seconds and reviewed by an editor. Return only candidates that add real orientation.\n\nSCENES:\n${JSON.stringify(scenes.map(scene => ({ scene_id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec, narration: truncateChars(scene.transcript_segment, 420) })) )}`
      const cueRequestIdentity = freshGenerationRequestIdentity(job, `contextual-cues-${fingerprint}-batch-${index}-scope-${progress.retry_scopes?.[String(index)] || 'initial'}`)
        ?? `${job.project_slug}:${episodeId}:contextual-cues:${fingerprint}:batch-${index}:scope-${progress.retry_scopes?.[String(index)] || 'initial'}`
      try {
        lastSubmissionAt = Date.now()
        const raw = await (cuesPolicy ? callAiWithModelPolicy(cuesPolicy,
          cueSystemPrompt(allow) + await noEmojiDirective(),
          cueUserPrompt, {}, false,
          {
            slug: job.project_slug,
            jobId: job.job_id,
            requestIdentity: cueRequestIdentity,
            pipelinePolicyCheckpoint: cuesCheckpoint,
            pipelinePolicyCheckpointKey: cueRequestIdentity,
            beforeModelAttempt: async selected => {
              const live = (await listChatModels(apiKey)).find(candidate => candidate.id === selected)
              if (!live || !live.available) throw new GenStudioChatProductUnavailableError(selected)
              assertContextualCueCapability(live, scenes.length)
            },
            onModelSelected: selected => { job.output_lines.push(`[pipeline] contextual cues using Gateway product "${selected}".`) },
            outputBudget: 'standard',
            outputContract: CONTEXTUAL_CUES_OUTPUT_CONTRACT,
            disableReasoning: true,
            temperature: 0.2,
          },
        ) : callAi(
          model,
          cueSystemPrompt(allow) + await noEmojiDirective(),
          cueUserPrompt,
          {}, false,
          { slug: job.project_slug, jobId: job.job_id, requestIdentity: cueRequestIdentity, outputBudget: 'standard', outputContract: CONTEXTUAL_CUES_OUTPUT_CONTRACT, disableReasoning: true, temperature: 0.2 },
        ))
        // Cleaned HERE, at the proposal, and never in the cue-save route: by
        // the time a cue comes back from the review screen it may be something
        // the editor typed, and that is his.
        batchCandidates = await Promise.all(parseCandidates(raw).map(async candidate => ({
          ...candidate,
          title: await applyEmojiPolicy(candidate.title, [cueUserPrompt]),
          subtitle: candidate.subtitle
            ? await applyEmojiPolicy(candidate.subtitle, [cueUserPrompt])
            : candidate.subtitle,
        })))
        break
      } catch (error) {
        // ── "Every machine was busy" — wait, then ask again ──
        // The only OTHER failure this generator resubmits; see
        // `contextualCueFleetBusyRetryPlan` for why it costs nothing and why
        // nothing else qualifies. A dead job id is REQUIRED, because the next
        // identity is derived from it: without one the scope cannot be
        // promoted, and the retry would replay a settled-failed key, which
        // returns the same failure forever. Pause is honoured alongside Cancel
        // here — a five-minute wait is long enough for the owner to change his
        // mind mid-way, and buying a fresh job after he pressed Pause would
        // overrule him.
        const fleetBusyPlan = contextualCueFleetBusyRetryPlan(error, fleetBusyRetries)
        const deadJobId = error instanceof GenStudioTerminalFailureError ? error.jobId : ''
        if (fleetBusyPlan && deadJobId && !isCancelled(job.job_id) && !isPauseRequested(job.job_id)) {
          // The SAME object that goes to disk, so an in-process retry and a
          // crash-replay derive one identity for one retry, never two.
          progress = {
            ...progress,
            retry_scopes: { ...(progress.retry_scopes || {}), [String(index)]: deadJobId },
            updated_at: new Date().toISOString(),
          }
          await writeContextualCueProgress(planPath, progress)
          fleetBusyRetries++
          maxAttempts = Math.max(maxAttempts, attemptNum + 1 + (fleetBusyPlan.maxAttempts - 1 - fleetBusyRetries))
          job.output_lines.push(fleetBusyPlan.free ? freeMacWaitLine(`Batch ${index + 1}`, error, fleetBusyPlan.waitMs) :
            `Batch ${index + 1}: ${fleetBusyPlan.reason.toLowerCase()} — the request never reached one, `
            + 'so nothing was charged and the credits were returned whole. '
            + `Waiting ${Math.round(fleetBusyPlan.waitMs / 1000)}s and asking again `
            + `(attempt ${attemptNum + 1} of ${maxAttempts}).`,
          )
          job.item_progress.active = [{ label: `Batch ${index + 1}`, key: `batch-${index}`, state: 'waiting_retry', attempt: attemptNum, max_attempts: maxAttempts, retry_at: new Date(Date.now() + fleetBusyPlan.waitMs).toISOString(), reason: fleetBusyPlan.reason }]
          await waitForFleetCapacity(job.job_id, fleetBusyPlan.waitMs)
          // Re-read after the wait. Minutes passed, and a Cancel or a Pause
          // pressed during them is the owner's last word — the batch then fails
          // exactly as it does today rather than being resubmitted.
          if (!isCancelled(job.job_id) && !isPauseRequested(job.job_id)) {
            attemptNum++
            continue
          }
          throw error
        }
        const releasedBackpressure = error instanceof GenStudioChatTerminalFailureError
          && isReleasedContextualCueBackpressure(error)
        if (!releasedBackpressure) throw error
        progress = {
          ...progress,
          retry_scopes: { ...(progress.retry_scopes || {}), [String(index)]: error.jobId },
          updated_at: new Date().toISOString(),
        }
        await writeContextualCueProgress(planPath, progress)
        if (backpressureRetries >= CONTEXTUAL_CUE_BACKPRESSURE_RETRIES) throw error
        backpressureRetries++
        // Same widening as the fleet branch, and a no-op when only this ladder
        // ever fires: 1+1+1 and 2+1+0 are both 3, today's number exactly. It
        // only matters after a fleet wait has already raised the count, where
        // without it the label could read "5 of 4".
        maxAttempts = Math.max(maxAttempts, attemptNum + 1 + (CONTEXTUAL_CUE_BACKPRESSURE_RETRIES - backpressureRetries))
        job.output_lines.push(
          `Batch ${index + 1} met confirmed provider backpressure. The Gateway settled 0 credits and released the full reservation; retrying only this batch after a bounded cooldown.`,
        )
        job.item_progress.active = [{ label: `Batch ${index + 1}`, key: `batch-${index}`, state: 'waiting_retry', attempt: attemptNum, max_attempts: maxAttempts, retry_at: new Date(Date.now() + CONTEXTUAL_CUE_BACKPRESSURE_COOLDOWN_MS).toISOString(), reason: 'provider backpressure' }]
        await waitWhileActive(job.job_id, CONTEXTUAL_CUE_BACKPRESSURE_COOLDOWN_MS)
        attemptNum++
      }
    }
    if (!batchCandidates) throw new Error(`Contextual cue batch ${index + 1} produced no result.`)
    candidates.push(...batchCandidates)
    const completedBatch = { index, scene_ids: scenes.map(scene => scene.id), candidates: batchCandidates }
    completed.set(index, completedBatch)
    progress = {
      ...progress,
      completed_batches: [...completed.values()].sort((a, b) => a.index - b.index),
      provisional_cues: applySafePacing(
        reconcileAnchoredCues(candidates.map(candidate => safeCandidate(candidate, plan, settings.density, settings, new Date().toISOString(), allow)).filter((cue): cue is ContextualCue => !!cue), plan, subtitles).cues,
        settings.density,
        plan.total_duration_sec || plan.scenes[plan.scenes.length - 1]?.end_sec || 0,
        settings.min_gap_sec!,
      ),
      updated_at: new Date().toISOString(),
    }
    await writeContextualCueProgress(planPath, progress)
    job.item_progress.completed = completed.size
    job.item_progress.active = []
    job.progress = Math.round((completed.size / Math.max(1, batches.length)) * 80)
    await checkpointJobState(job)
  }
  const now = new Date().toISOString()
  // v1.4.365 — the PRESET's `auto_approve` is the only auto-approve there is
  // (owner, 2026-10-28). The project-level `config.auto_approve_cues` switch was
  // deleted: there were two switches, the page offered both, and one disabled
  // the other. The preset wins because it travels with the model and density it
  // shares a preset with, and AGENTS.md §5 already settled that it is preset
  // data and is announced when a preset sets it. A channel config that still
  // stores the old key is read safely and ignored — nothing rewrites the file.
  //
  // Either way a cue only becomes 'approved' if it clears every structural rule
  // validateContextualCueTimeline enforces for a human reviewer; anything that
  // doesn't stays 'proposed' and is recorded in auto_approval_holds, never
  // silently dropped.
  //
  // The timeline is re-read HERE, not at the start: a run takes minutes, and
  // approvals or edits made on the review page meanwhile must survive it.
  const latest = await readContextualCueTimeline(planPath)
  const protectedCues = latest?.cues.filter(cue => cue.status !== 'proposed') || []
  const resolvedIds = new Set(protectedCues.map(cue => cue.id))
  const accounted = accountCueCandidates(candidates, plan, settings, now, resolvedIds, allow, subtitles)
  let proposed = accounted.proposed
  const dropped = accounted.dropped
  let autoApprovalHolds: ContextualCueAutoApprovalHold[] = []
  if (settings.auto_approve) {
    const result = autoApproveEligibleCues(proposed, protectedCues, plan)
    proposed = result.cues
    autoApprovalHolds = result.holds
  }
  const timeline: ContextualCueTimeline = {
    // v2: cues carry `scene_id` + a spoken `anchor_word`, and their absolute
    // seconds follow the narration. A v1 file still reads unchanged.
    schema_version: 2 as const,
    generated_at: now,
    source_scene_plan_generated_at: plan.generated_at,
    cues: [...protectedCues, ...proposed],
    ...(autoApprovalHolds.length ? { auto_approval_holds: autoApprovalHolds } : {}),
  }
  // Cues already recorded in auto_approval_holds were deliberately left
  // 'proposed' after failing a structural check; their issue is already
  // captured and shown to the reviewer, so it must not re-trip this
  // safety net and abort the whole save. Every other issue still aborts,
  // exactly as before this setting existed.
  const heldIds = new Set(autoApprovalHolds.map(hold => hold.cue_id))
  const issues = validateContextualCueTimeline(timeline, plan).filter(issue => !issue.cue_id || !heldIds.has(issue.cue_id))
  if (issues.length) throw new Error(`Generated cues did not pass safe pacing validation: ${issues.slice(0, 3).map(issue => issue.detail).join('; ')}`)
  await writeContextualCueTimeline(planPath, timeline)
  await removeContextualCueProgress(planPath)
  job.output_dir = paths.episode_dir
  job.progress = 100
  const approvedNow = proposed.filter(cue => cue.status === 'approved').length
  job.result = {
    proposed: proposed.length - approvedNow,
    approved: approvedNow,
    preserved: protectedCues.length,
    held_back: autoApprovalHolds.length,
    candidates: candidates.length,
    saved: proposed.length,
    dropped,
  }
  job.output_lines.push(`Saved ${proposed.length} of ${candidates.length} candidate cue(s) the model proposed.`)
  for (const drop of dropped.slice(0, 20)) {
    job.output_lines.push(`  dropped: scene ${drop.scene_id}${drop.title ? ` "${drop.title}"` : ''} — ${drop.reason}`)
  }
  if (dropped.length > 20) job.output_lines.push(`  …and ${dropped.length - 20} more dropped (listed in the job result).`)
  job.output_lines.push(settings.auto_approve
    ? `Saved ${proposed.length} contextual cue(s) using this trusted preset: ${approvedNow} auto-approved, ${autoApprovalHolds.length} held back for review (failed a structural check — see the timeline for why).`
    : `Saved ${proposed.length} proposed contextual cue(s). Approved labels render; anything left unreviewed is simply not drawn.`)
  // ── The SOUND half (v1.4.365) ──────────────────────────────────────────────
  //
  // Same pass, same paid batch: a candidate's `sound` names the moment the
  // label describes, and this picks a clip for it. Two rules:
  //
  //   * A sound is only proposed when Sound is switched on for the channel.
  //     Proposing sounds for a channel that does not use them would fill a
  //     review list with rows nobody asked for.
  //   * A proposed sound is ALWAYS `proposed`. Auto-approving a label is an
  //     editorial judgement about words; auto-approving a CLIP would put a file
  //     the customer has never heard into the final mix, and the licence/credit
  //     for it into the publish record. That is not a judgement the app makes.
  const soundConfig = normalizeSoundDesignConfig((await getConfig(job.project_slug))?.sound_design)
  let proposedSounds: SoundDesignCue[] = []
  let soundCandidatesSeen = 0
  if (soundConfig.enabled) {
    const candidatesForSounds = await loadSoundCandidates()
    const latestSounds = await readSoundDesignTimeline(planPath)
    // EVERY existing cue is kept except the ones this pass is about to replace:
    // a reviewed cue is the customer's decision, and a v1 cue has no `scene_id`
    // at all and must not vanish from the file just because it predates the
    // anchor (AGENTS.md §5, trap 2 — nothing rewrites stored data).
    const existingSounds = latestSounds?.cues || []
    const resolvedSoundIds = new Set(existingSounds.filter(cue => cue.status !== 'proposed').map(cue => cue.id))
    for (const candidate of candidates) {
      if (!candidate.sound?.description) continue
      soundCandidatesSeen++
      const cue = safeCandidate(candidate, plan, settings.density, settings, now, allow)
      if (!cue) continue
      const id = `sound-${cue.scene_id}`
      if (resolvedSoundIds.has(id) || proposedSounds.some(row => row.id === id)) continue
      const chosen = selectSound(candidate.sound.description, candidate.sound.kind === 'bed' ? 'bed' : 'spot', candidatesForSounds)
      const base: SoundDesignCue = {
        id,
        kind: candidate.sound.kind === 'bed' ? 'bed' : 'spot',
        label: truncateChars(candidate.sound.description.replace(/\s+/g, ' ').trim(), 120),
        scene_id: cue.scene_id,
        ...(cue.anchor_word ? { anchor_word: cue.anchor_word } : {}),
        anchor_offset_sec: cue.anchor_offset_sec,
        start_sec: cue.start_sec,
        ...(candidate.sound.kind === 'bed' ? { end_sec: Number((cue.start_sec + Math.min(20, Math.max(0, cue.end_sec - cue.start_sec))).toFixed(3)) } : {}),
        source: 'pool',
        clip: '',
        gain_db: candidate.sound.kind === 'bed'
          ? latestSounds?.settings.default_bed_gain_db ?? DEFAULT_SOUND_DESIGN_SETTINGS.default_bed_gain_db
          : latestSounds?.settings.default_spot_gain_db ?? DEFAULT_SOUND_DESIGN_SETTINGS.default_spot_gain_db,
        status: 'proposed',
        created_at: now,
        updated_at: now,
      }
      proposedSounds.push(chosen ? applySound(base, chosen.candidate) : base)
    }
    for (const row of proposedSounds) {
      const credit = row.credit ? ` (${row.credit.licence.toUpperCase()}${row.credit.author ? `, ${row.credit.author}` : ''})` : ''
      job.output_lines.push(row.clip
        ? `  sound for scene ${row.scene_id}: "${row.label}" → ${row.clip}${credit}`
        : `  sound for scene ${row.scene_id}: "${row.label}" → no matching clip; left for you to choose.`)
    }
    if (proposedSounds.length || existingSounds.length) {
      const soundTimeline: import('../models/types.js').SoundDesignTimeline = {
        schema_version: 2 as const,
        generated_at: now,
        source_scene_plan_generated_at: plan.generated_at,
        settings: latestSounds?.settings || DEFAULT_SOUND_DESIGN_SETTINGS,
        // Filled below, after anything the mixing rules refuse is removed.
        cues: [],
      }
      // A generated sound that would break the mix is dropped WITH ITS REASON
      // rather than failing a run whose labels are already paid for. Sounds are
      // optional (AGENTS.md §9's shape): silence plus a stated note, never a
      // lost batch of work.
      const refused = new Map<string, string[]>()
      // Validate against the WHOLE result, so a new sound that overlaps an
      // existing approved bed is caught — not just the new rows against each
      // other.
      soundTimeline.cues = [...existingSounds.filter(cue => !proposedSounds.some(row => row.id === cue.id)), ...proposedSounds]
      for (const issue of validateSoundDesignTimeline(soundTimeline, plan, soundTimeline.settings)) {
        if (!issue.cue_id || issue.severity === 'warning') continue
        refused.set(issue.cue_id, [...(refused.get(issue.cue_id) || []), issue.detail])
      }
      if (refused.size) {
        for (const [id, reasons] of refused) {
          const row = proposedSounds.find(cue => cue.id === id)
          job.output_lines.push(`  not placed: scene ${row?.scene_id || id} "${row?.label || ''}" — ${reasons.join(' ')}`)
        }
        proposedSounds = proposedSounds.filter(cue => !refused.has(cue.id))
      }
      soundTimeline.cues = [...existingSounds.filter(cue => !proposedSounds.some(row => row.id === cue.id)), ...proposedSounds]
      await writeSoundDesignTimeline(planPath, soundTimeline)
      job.output_lines.push(`Saved ${proposedSounds.length} proposed sound(s); ${existingSounds.length} already on this episode and left untouched.`)
    }
    // Say plainly when nothing could be picked, because silence where a sound
    // was asked for is exactly the state the customer needs to know about.
    const unplaced = proposedSounds.filter(row => !row.clip).length
    if (unplaced) {
      job.output_lines.push(`${unplaced} sound(s) got no automatic match. They stay proposed with no clip — choose one in Sound & Labels.`)
    }
    job.result = {
      ...(job.result || {}),
      sounds_proposed: proposedSounds.length,
      sounds_unplaced: unplaced,
      sounds_preserved: Math.max(0, existingSounds.length - proposedSounds.length),
      sound_candidates: soundCandidatesSeen,
    }
  }

  // Real counts: every scene batch must have returned an answer. (Dropped
  // candidates are editorial — reported above, not a failure.)
  requireJobCompletion(job, {
    label: 'Contextual cue proposal',
    expected: batches.length,
    completed: batches.filter((_, index) => completed.has(index)).length,
    missing: batches.map((_, index) => index).filter(index => !completed.has(index)).map(index => `batch ${index + 1}`),
    retry_hint: 'Retry asks again only for the missing batches.',
  })
}

/**
 * Everything a sound could be picked from, right now.
 *
 * Local pools first (they are the customer's own files and cost nothing), then
 * the Gateway library — read soft, because a Gateway that cannot answer must
 * not fail a proposal that already paid for its labels.
 */
async function loadSoundCandidates(): Promise<SoundCandidate[]> {
  const out: SoundCandidate[] = []
  try {
    const pools = await import('../services/broll-pool-manager.js')
    for (const pool of await pools.listPools()) {
      if (pools.poolMedia(pool) !== 'audio') continue
      if (!(await pools.isPoolOnline(pool.id))) continue
      for (const clip of await pools.listClips(pool.id, { includeMissing: false })) {
        out.push({
          source: 'pool', key: pool.id, label: clip.filename,
          description: [clip.filename, ...(clip.tags || [])].join(' '),
        })
      }
    }
  } catch {
    // A pool registry that cannot be read is not a reason to lose the labels.
  }
  try {
    const { listKeptSounds } = await import('../lib/gateway-sound-library.js')
    for (const clip of await listKeptSounds()) {
      // Cut sounds are their own pool: a cue never picks one as a sound effect.
      if ((clip.tags || []).some(tag => tag.toLowerCase() === 'transition')) continue
      out.push({
        source: 'gateway', key: clip.sha256, label: clip.credit.title || clip.sha256.slice(0, 12),
        // The clip's own tags describe what it IS, which is what a picker ranks on
        // (a title alone often says nothing about the sound).
        description: [clip.credit.title, clip.credit.author, clip.credit.source, ...(clip.tags || [])].filter(Boolean).join(' '),
        duration_sec: clip.duration_sec,
        kind: clip.kind,
        credit: clip.credit,
      })
    }
  } catch {
    // The Gateway library being unreachable leaves the local pools usable.
  }
  return out
}
