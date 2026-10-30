/**
 * Preset field coverage — a new form field on a preset page must be CLASSIFIED.
 *
 * AGENTS.md §5. The owner's concern, 2026-10-27: *"we may have built and added new
 * settings, options and stuff. i don't know if you made them respective of the
 * preset save. those has always been an issue in the past. some new settings isn't
 * saved by the preset."*
 *
 * A page's preset is a hand-written `snapshot`/`apply` pair. Nothing about adding a
 * form field forces anyone to notice it: the field renders, the customer changes it,
 * and the preset quietly does not carry it. This test makes that impossible to do
 * silently — not by listing the fields (that list would drift the moment someone
 * adds one), but by DERIVING them from each page's template and requiring a verdict
 * for every one.
 *
 *   fields   ← parsed from the page's `<template>`: every `v-model` path, and every
 *              `x.y = …` assignment in a click/change handler.
 *   saved    ← the page's own preset code references it (the exact path, a spread of
 *              its root, a `root:` snapshot key, or its leaf as a key under a root
 *              the snapshot carries).
 *   excluded ← the page's own `excludeKeys` names it, or the shared default does.
 *   otherwise← must appear in `CLASSIFIED` below with a verdict AND a reason.
 *
 * Both directions that matter fail the build:
 *   - a NEW field appears and nobody classified it (the owner's complaint);
 *   - a classification lies (claims the preset carries a field it does not), or
 *     outlives its field (the template stopped binding it).
 *
 * WHAT THIS CANNOT CATCH, and must not be trusted for:
 *   - **Semantics.** It proves a field is *mentioned* by the preset code — not that
 *     `apply` restores it into the right place, nor that the value is reusable
 *     rather than one episode's. A snapshot that stores a per-episode path, or an
 *     apply that reads a key into the wrong field, both pass.
 *   - **Fields reached without `v-model` or an inline assignment.** A control edited
 *     only through a child component's `@update:model-value`, or through a handler
 *     that calls `toggle(x)` instead of assigning, is not in the derived list at
 *     all. `scene-review.vue`'s reference checkboxes are exactly that shape.
 *   - **Snapshot/apply asymmetry on a key the snapshot does carry.** If `snapshot`
 *     stores `scene_reveal` and `apply` forgets to restore it, this test sees the
 *     key mentioned once and calls the field covered. `presetExcludeKeys.test.ts`
 *     drives the real composable for the round trip; this file is the inventory.
 *   - **Roots the checker cannot see through.** A payload assembled behind a dynamic
 *     key reads as "not saved". The failure is loud, but it is a false positive to
 *     fix by making the preset code legible — not by widening the matcher.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { parse } from '@vue/compiler-sfc'

import { DEFAULT_EXCLUDE_KEYS } from '../composables/usePresets.js'
import { CONTINUITY_PRESET_EXCLUDE_KEYS } from '../composables/useContinuityConfig.js'

/**
 * Why a field is not carried by its page's preset.
 *
 * - `episode`         one episode's state; §5 forbids it travelling.
 * - `run-only`        a per-run switch that must never be restored.
 * - `transient`       dialog/UI state; not a setting at all.
 * - `saved-elsewhere` a real reusable setting persisted by another mechanism
 *                     (config.json, a channel doc, project settings). `reason`
 *                     names it.
 * - `saved-by-preset` the preset DOES carry it, through an alias or helper the
 *                     checker cannot follow. `via` names the path that must appear
 *                     in the preset code — that is what makes the claim checkable.
 * - `excluded`        the page's own `excludeKeys` names it. The entry exists to
 *                     record WHY, because the list itself cannot say; the honesty
 *                     check then proves the page really does exclude it, so a
 *                     reason cannot outlive the exclusion it describes.
 */
type Verdict = 'episode' | 'run-only' | 'transient' | 'saved-elsewhere' | 'saved-by-preset' | 'excluded'

interface Classification {
  verdict: Verdict
  reason: string
  /** Required by `saved-by-preset`: the snapshot path that carries this field. */
  via?: string
}

/** Pages that own a `usePresets` controller, in the order the audit lists them. */
const PRESET_PAGES = [
  'audio.vue',
  'audio-merge.vue',
  'broll.vue',
  'character-sheet.vue',
  'effects-library.vue',
  'episode-builder.vue',
  'ideas.vue',
  'image-prompts.vue',
  'images.vue',
  'introduction.vue',
  'metadata.vue',
  'motion-review.vue',
  'research.vue',
  'scene-plan.vue',
  'scene-review.vue',
  'scripts.vue',
  'sound-and-labels.vue',
  'subtitles.vue',
  'video-assembly.vue',
] as const

/**
 * Every field the preset does NOT carry, and why.
 *
 * A field belongs here when §5 says it must not travel (episode state), when it is a
 * per-run switch or dialog state, or when something other than the preset persists
 * it. Anything a preset *should* carry is added to the page's snapshot instead —
 * never to this table.
 */
const CLASSIFIED: Record<string, Record<string, Classification>> = {
  'audio.vue': {
    qualityVerificationCreditCeiling: { verdict: 'run-only', reason: 'a spend ceiling for the quality approval on screen, quoted against one job' },
    heldQualityApprovalCeiling: { verdict: 'run-only', reason: 'a spend ceiling for the held approval, quoted against one job' },
    activeCheckApprovalCeiling: { verdict: 'run-only', reason: 'a spend ceiling for the active quality check, quoted against one job' },
    manualAudioRedoChecked: { verdict: 'run-only', reason: 'one-click acknowledgement before a manual redo' },
  },
  'audio-merge.vue': {
    writeMode: { verdict: 'run-only', reason: 'overwrite vs. save-as-new for THIS merge; restoring it could silently replace an accepted mix' },
    newMusicPath: { verdict: 'transient', reason: 'the file-picker scratch input; the chosen file is added to the episode\'s own `music.files`' },
    // Owner, 2026-10-27: a preset carries the music SETTINGS and never a FILE.
    // Every path here names one episode's own audio; a preset that stored them
    // restored EP0048's bed onto EP0047 (§4). Stripped on save AND on read, so a
    // preset written while this was allowed stops restoring them without a
    // single stored file being rewritten (§5 trap 2).
    'music.files': { verdict: 'excluded', reason: 'the episode\'s own music playlist — a file list, not a setting (§4/§5)' },
    'intro.file': { verdict: 'excluded', reason: 'the intro audio uploaded for one episode (§4/§5)' },
    'backgroundNoise.custom_file': { verdict: 'excluded', reason: 'the ambience file chosen for one episode (§4/§5)' },
    // `track.source_path` is not template-bound (a layer's clip is set by the
    // ambient picker), so it has no entry here — but it is still excluded by the
    // page, which is what keeps a stored preset from restoring it.

    'track.enabled': { verdict: 'saved-by-preset', reason: 'one ambient layer row', via: 'ambient_tracks' },
    'track.volume': { verdict: 'saved-by-preset', reason: 'one ambient layer row', via: 'ambient_tracks' },
    'track.fade_in': { verdict: 'saved-by-preset', reason: 'one ambient layer row', via: 'ambient_tracks' },
    'track.fade_out': { verdict: 'saved-by-preset', reason: 'one ambient layer row', via: 'ambient_tracks' },
  },
  'broll.vue': {
    brollWhisperForce: { verdict: 'run-only', reason: 're-transcribe an existing transcript — a per-run switch, never restored (the same call as `force` on Scripts)' },
    brollSubtitleUploadPath: { verdict: 'transient', reason: 'the upload field\'s scratch value; the chosen file is recorded in config.broll_subtitles' },
    manualPoolFilter: { verdict: 'transient', reason: 'a search filter over the pool picker' },
    subscribedPoolId: { verdict: 'saved-elsewhere', reason: 'a per-project setting in config.json, not a preset concept' },
    'm.target_duration': { verdict: 'episode', reason: 'a manual-mode pick for one clip on this episode' },
    'brollSubtitles.enabled': { verdict: 'saved-elsewhere', reason: 'persisted per project in config.broll_subtitles, which outlives every preset' },
    brollGenstudioModel: { verdict: 'saved-by-preset', reason: 'the channel\'s transcription model — a reusable choice, saved as `transcription_model`', via: 'transcription_model' },
  },
  'character-sheet.vue': {
    episodeAnchorEnabled: { verdict: 'episode', reason: 'whether THIS episode uses its uploaded anchor image — `use_episode_sheet` is excluded from the preset and this is its view (2026-08-03)' },
    compositionPrompt: { verdict: 'transient', reason: 'the composition-preview dialog\'s prompt; nothing generated from it enters the episode' },
    compositionModel: { verdict: 'transient', reason: 'the composition-preview dialog\'s model, remembered in this browser only' },
  },
  // v1.4.365 — ONE page, TWO preset types. The proposal setup (`form`) is the
  // Contextual Cues preset and the mix (`settings`) is the Sound Design preset;
  // both keys, both config keys and both preset types are unchanged, and no new
  // preset key exists. Everything else on the page is this episode's own state.
  'sound-and-labels.vue': {
    // The two project switches are `:checked` + `@change`, not `v-model`: each
    // writes ONLY its own config key through the route that names that key, so a
    // stale value on screen can never overwrite the other switch. That is
    // deliberate, and it is why the checker does not derive them — there is
    // nothing here for a preset to carry either way.
    'form.model': { verdict: 'saved-by-preset', reason: 'which model proposes labels — reusable, and the thing most presets exist for', via: 'model' },
    'form.density': { verdict: 'saved-by-preset', reason: 'how often labels appear — a reusable editorial choice', via: 'density' },
    'form.placement': { verdict: 'saved-by-preset', reason: 'the default corner for new labels — a reusable channel look', via: 'placement' },
    'form.auto_approve': { verdict: 'saved-by-preset', reason: 'AGENTS.md §5: decided 2026-08-18, kept and announced in both directions', via: 'auto_approve' },
    'settings.max_spots_per_minute': { verdict: 'saved-by-preset', reason: 'a pacing cap the mixer enforces — reusable mix policy', via: 'settings' },
    'settings.default_bed_gain_db': { verdict: 'saved-by-preset', reason: 'a default mix level — reusable', via: 'settings' },
    'settings.default_spot_gain_db': { verdict: 'saved-by-preset', reason: 'a default mix level — reusable', via: 'settings' },
    'settings.ducking_profile': { verdict: 'saved-by-preset', reason: 'a reusable mixing choice', via: 'settings' },
    'row.cue.title': { verdict: 'episode', reason: 'one label in this episode\'s timeline' },
    'row.cue.subtitle': { verdict: 'episode', reason: 'one label in this episode\'s timeline' },
    'row.cue.kind': { verdict: 'episode', reason: 'one item in this episode\'s timeline' },
    'row.cue.template': { verdict: 'episode', reason: 'one label in this episode\'s timeline' },
    'row.cue.start_sec': { verdict: 'episode', reason: 'one item\'s position in this episode' },
    'row.cue.end_sec': { verdict: 'episode', reason: 'one item\'s position in this episode' },
    'row.cue.label': { verdict: 'episode', reason: 'one sound in this episode\'s timeline' },
    'row.cue.gain_db': { verdict: 'episode', reason: 'one sound\'s level in this episode' },
  },
  'effects-library.vue': {
    'file.custom_order': { verdict: 'episode', reason: 'this episode\'s effect ordering, saved with the episode\'s effects file' },
    targetKey: { verdict: 'transient', reason: 'which scope (episode / scene / theme) the editor is adding to' },
    previewSceneId: { verdict: 'transient', reason: 'which scene the preview is showing' },
    search: { verdict: 'transient', reason: 'the effect library\'s search filter' },
    presetName: { verdict: 'transient', reason: 'the save-preset dialog\'s name field' },
  },
  'episode-builder.vue': {
    code: { verdict: 'episode', reason: 'which music episode is open' },
    newTitle: { verdict: 'episode', reason: 'the new music episode\'s title' },
    promptDraft: { verdict: 'episode', reason: 'one scene\'s prompt draft for this episode' },
    pickerQuery: { verdict: 'transient', reason: 'a search filter in the still picker' },
    stillPoolId: { verdict: 'transient', reason: 'the still picker\'s current pool' },
    'polishForm.model': { verdict: 'transient', reason: 'the polish dialog\'s model, remembered in this browser only and never assigned' },
    'settings.theme': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document, which outlives every preset' },
    'settings.scenes.count': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scenes.minutes': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scenes.min_seconds': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scenes.max_seconds': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scenes.mode': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scenes.title_on_scene': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scene_change.transition': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.scene_change.seconds': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.no_repeat_episodes': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.still_no_repeat_episodes': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.join.seconds': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.frame_rate': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.resolution': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.upscale_sharpen': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.loudness_lufs': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    'settings.true_peak_db': { verdict: 'saved-elsewhere', reason: 'saved with the music episode document' },
    targetMinutes: { verdict: 'saved-elsewhere', reason: 'a view of the episode\'s own `target_length_s`, saved with the episode' },
  },
  'ideas.vue': {
    'titleConfig.prefix': { verdict: 'saved-elsewhere', reason: 'a channel-wide branding setting (owner, 2026-10-03) — Metadata uses it too, so no Ideas preset may change it' },
    'titleConfig.suffix': { verdict: 'saved-elsewhere', reason: 'a channel-wide branding setting (owner, 2026-10-03)' },
    'editorForm.title': { verdict: 'episode', reason: 'one generated idea being edited' },
    'editorForm.logline': { verdict: 'episode', reason: 'one generated idea being edited' },
    'editorForm.mood': { verdict: 'episode', reason: 'one generated idea being edited' },
    'editorForm.themesList': { verdict: 'episode', reason: 'one generated idea being edited' },
    'editorForm.suggested_chapters': { verdict: 'episode', reason: 'one generated idea being edited' },
    'editorForm.suggested_length': { verdict: 'episode', reason: 'one generated idea being edited' },
    'row.selected': { verdict: 'episode', reason: 'which generated ideas are ticked for the next action' },
    'r.selected': { verdict: 'episode', reason: 'which generated ideas are ticked (row alias in a nested v-for)' },
    searchQuery: { verdict: 'transient', reason: 'the idea list\'s search filter' },
    setupExpanded: { verdict: 'transient', reason: 'a disclosure panel\'s open state' },
    ideaRefinementsOpen: { verdict: 'transient', reason: 'a disclosure panel\'s open state' },
    manualRedoChecked: { verdict: 'run-only', reason: 'one-click acknowledgement before a manual redo' },
    acceptCodeMode: { verdict: 'transient', reason: 'the accept dialog\'s code mode' },
    acceptCustomNumber: { verdict: 'transient', reason: 'the accept dialog\'s custom number' },
    renumberCodeMode: { verdict: 'transient', reason: 'the renumber dialog\'s mode' },
    renumberCustomNumber: { verdict: 'transient', reason: 'the renumber dialog\'s custom number' },
    importMode: { verdict: 'transient', reason: 'the import dialog\'s mode' },
    importPath: { verdict: 'transient', reason: 'the import dialog\'s path' },
    importCopy: { verdict: 'transient', reason: 'the import dialog\'s copy flag' },
    importCodeChoice: { verdict: 'transient', reason: 'the import dialog\'s code choice' },
    parentPath: { verdict: 'transient', reason: 'the import dialog\'s destination' },
    pasteInput: { verdict: 'transient', reason: 'the paste dialog\'s scratch text' },
  },
  'image-prompts.vue': {
    thumbnailVisionModel: { verdict: 'transient', reason: 'the model that analyses a reference image — a live catalogue pick, healed on every load and never a preset value' },
  },
  'images.vue': {
    'activeForm.model': { verdict: 'saved-by-preset', reason: '`activeForm` is a computed alias of `form.thumbnail`', via: 'form.thumbnail' },
    'activeForm.aspect_ratio': { verdict: 'saved-by-preset', reason: '`activeForm` is a computed alias of `form.thumbnail`', via: 'form.thumbnail' },
    'activeForm.generation_mode': { verdict: 'saved-by-preset', reason: '`activeForm` is a computed alias of `form.thumbnail`; the retired mode is healed on read', via: 'form.thumbnail' },
    'activeForm.render_scale': { verdict: 'saved-by-preset', reason: '`activeForm` is a computed alias of `form.thumbnail`', via: 'form.thumbnail' },
    'activeForm.seed': { verdict: 'saved-by-preset', reason: '`activeForm` is a computed alias of `form.thumbnail`', via: 'form.thumbnail' },
    outputOption: { verdict: 'saved-by-preset', reason: 'the published `(resolution, aspect_ratio)` row — a reusable render choice with its own price', via: 'output_option' },
    extraDetails: { verdict: 'episode', reason: 'render-time guidance for one episode; deliberately outside `form` so no preset can capture it' },
    lightboxOpen: { verdict: 'transient', reason: 'the preview lightbox\'s open flag' },
    lightboxIndex: { verdict: 'transient', reason: 'which thumbnail the lightbox is showing' },
  },
  'introduction.vue': {
    'segment.enabled': { verdict: 'saved-elsewhere', reason: 'the channel\'s own opening switch, saved with the segment document rather than in a preset' },
    'beat.choice': { verdict: 'saved-by-preset', reason: 'one beat inside `recipe.beats`', via: 'recipe' },
    'beat.custom_text': { verdict: 'saved-by-preset', reason: 'one beat inside `recipe.beats`', via: 'recipe' },
    'beat.enabled': { verdict: 'saved-by-preset', reason: 'one beat inside `recipe.beats`', via: 'recipe' },
    manualIntroductionChecked: { verdict: 'run-only', reason: 'one-click acknowledgement before a manual redo' },
    manualIntroductionSourceId: { verdict: 'episode', reason: 'which opening of this episode is being replaced' },
    newBeatLabel: { verdict: 'transient', reason: 'the add-beat dialog\'s name field' },
    restoreBeatId: { verdict: 'transient', reason: 'the restore-beat picker\'s current choice' },
  },
  'metadata.vue': {
    metadataFormulaSelection: { verdict: 'run-only', reason: 'a one-episode override; cleared on every episode change by design' },
    selectedVersion: { verdict: 'episode', reason: 'which saved version of this episode\'s package is on screen' },
    'preview.description': { verdict: 'episode', reason: 'this episode\'s generated description' },
    tagsAsString: { verdict: 'episode', reason: 'this episode\'s generated tags' },
  },
  'motion-review.vue': {
    clipRenderer: { verdict: 'saved-elsewhere', reason: 'a channel choice persisted at /motion-presentation, which outlives every preset' },
    penChoice: { verdict: 'episode', reason: 'the pen is per episode (channel default, episode override) — AGENTS.md §4' },
    holdChoice: { verdict: 'episode', reason: 'the closing hold is per episode (channel default, episode override)' },
    'holdDraft.fixed': { verdict: 'episode', reason: 'a draft of this episode\'s hold, written on Apply' },
    'holdDraft.min': { verdict: 'episode', reason: 'a draft of this episode\'s hold range' },
    'holdDraft.max': { verdict: 'episode', reason: 'a draft of this episode\'s hold range' },
    openingSeconds: { verdict: 'episode', reason: 'the length of THIS episode\'s opening motion window' },
    sharePercent: { verdict: 'episode', reason: 'THIS episode\'s video share, saved with its motion scope (channel default fills an unsaved episode)' },
    shareFormula: { verdict: 'episode', reason: 'how THIS episode\'s video share is filled, saved with its motion scope' },
  },
  'research.vue': {
    autoApproveClaims: { verdict: 'saved-elsewhere', reason: 'a project setting in config.research_auto_approve_claims, not a preset value' },
    'form.topic': { verdict: 'episode', reason: 'the episode\'s own title drives the topic; a preset must not carry it (Pipeline substitutes the idea title)' },
  },
  'scene-plan.vue': {
    defaultStyleBible: { verdict: 'saved-elsewhere', reason: 'the channel\'s own style bible in config.default_style_bible, which outlives every preset' },
    promptTokensPerScene: { verdict: 'saved-elsewhere', reason: 'a channel setting at /scene-prompt-defaults, shared by every episode' },
    promptSafetyFraction: { verdict: 'saved-elsewhere', reason: 'a channel setting at /scene-prompt-defaults' },
    promptBatchSizeDefault: { verdict: 'saved-elsewhere', reason: 'a channel setting at /scene-prompt-defaults' },
    promptPackPickerValue: { verdict: 'transient', reason: 'a computed view of `form.prompt_pack_size`, which IS saved' },
    promptCharCapPickerValue: { verdict: 'transient', reason: 'a computed view of `form.prompt_char_cap`, which IS saved' },
    'scene.transcript_segment': { verdict: 'episode', reason: 'one scene of this episode\'s plan' },
    'scene.visual_prompt': { verdict: 'episode', reason: 'one scene of this episode\'s plan' },
    'scene.motion_prompt': { verdict: 'episode', reason: 'one scene of this episode\'s plan' },
    'scene.video_prompt': { verdict: 'episode', reason: 'one scene of this episode\'s plan' },
  },
  'scene-review.vue': {
    editPrompt: { verdict: 'episode', reason: 'the prompt being edited for one scene of this episode' },
    outputOption: { verdict: 'saved-by-preset', reason: 'the published `(resolution, aspect_ratio)` row — a reusable render choice with its own price', via: 'output_option' },
  },
  'scripts.vue': {
    byoMode: { verdict: 'transient', reason: 'the bring-your-own dialog\'s mode' },
    byoText: { verdict: 'transient', reason: 'the bring-your-own dialog\'s pasted text' },
    manualOutlineChecked: { verdict: 'run-only', reason: 'one-click acknowledgement before an outline is replaced' },
    manualOutlineSourceId: { verdict: 'episode', reason: 'which outline of this episode is being replaced' },
    newStyleName: { verdict: 'transient', reason: 'the save-style dialog\'s name field' },
    recencyLookbackInput: { verdict: 'saved-elsewhere', reason: 'a project-level recency setting at /recency/lookback, not a preset value' },
    translateTargetSlug: { verdict: 'run-only', reason: 'the target channel for ONE translation job; the job, not a preset, records it' },
    useCharacters: { verdict: 'transient', reason: 'a disclosure toggle over `character_ids`, which IS saved' },
    // 1.4.369 — the Quote Shorts starting-length range. The "Episode length" card
    // is the CHANNEL's setting (`config.json` `episode_length`, written through
    // /settings/config and read by the idea generator for each new episode). A
    // script preset restores how one episode's script is written; letting it
    // rewrite the channel's range would re-decide a property of the channel,
    // which §5 forbids. Existing episodes keep their own length either way.
    episodeLengthRandom: { verdict: 'saved-elsewhere', reason: 'the channel\'s starting-length mode in config.json `episode_length`, saved via /settings/config — not script-preset content' },
    episodeLengthMin: { verdict: 'saved-elsewhere', reason: 'the channel\'s shortest starting length in config.json `episode_length`, saved via /settings/config' },
    episodeLengthMax: { verdict: 'saved-elsewhere', reason: 'the channel\'s longest starting length in config.json `episode_length`, saved via /settings/config' },
    episodeLengthFixed: { verdict: 'saved-elsewhere', reason: 'the channel\'s fixed starting length in config.json `episode_length`, saved via /settings/config' },
  },
  'subtitles.vue': {
    importPath: { verdict: 'transient', reason: 'the import dialog\'s scratch path' },
    selectedSubtitleSections: { verdict: 'episode', reason: 'chapter selection belongs to one episode' },
  },
  'video-assembly.vue': {
    visualSource: { verdict: 'saved-elsewhere', reason: 'saved per episode at /visual-source, not in a preset' },
    'clip.anchor': { verdict: 'saved-by-preset', reason: 'one row of `timeline_clips` in the Intro preset', via: 'timeline_clips' },
    'clip.enabled': { verdict: 'saved-by-preset', reason: 'one row of `timeline_clips`', via: 'timeline_clips' },
    'clip.video_path': { verdict: 'saved-by-preset', reason: 'one row of `timeline_clips`', via: 'timeline_clips' },
    'layer.enabled': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`, carried by `overlayLayersForPreset` (without its per-episode window)', via: 'overlays' },
    'layer.opacity': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    'layer.scale': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    'layer.chroma_key': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    'layer.chroma_key.color': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    'layer.chroma_key.similarity': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    'layer.chroma_key.blend': { verdict: 'saved-by-preset', reason: 'one row of `overlays.layers`', via: 'overlays' },
    assetPreviewOpen: { verdict: 'transient', reason: 'the asset preview modal\'s open flag' },
    assetPreviewIndex: { verdict: 'transient', reason: 'which asset the preview modal is showing' },
    previewTimeSec: { verdict: 'transient', reason: 'the player\'s current position' },
  },
}

// ── Derivation ──────────────────────────────────────────────────────────────

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EDIT_HANDLERS = new Set(['click', 'change', 'input', 'blur', 'update'])
const pageSource = (name: string) => readFileSync(new URL(`../pages/projects/[slug]/${name}`, import.meta.url), 'utf8')

interface TemplateNode {
  type?: number
  props?: Array<{ type?: number; name?: string; arg?: { content?: string }; exp?: { content?: string } }>
  children?: TemplateNode[]
  branches?: TemplateNode[] | TemplateNode
  elseBranch?: TemplateNode
}

/**
 * Every field the template binds or writes, as a dotted path.
 *
 * `v-model` is the point, but a control edited by a click handler
 * (`form.creative_mode = mode.id`) is just as much a form field, and several pages
 * have nothing else for it.
 */
function templateFields(source: string): string[] {
  const { descriptor } = parse(source, { filename: 'page.vue' })
  assert.ok(descriptor.template, 'the page must have a template')
  const fields = new Set<string>()
  const add = (path: string) => {
    const trimmed = path.trim()
    if (trimmed && !trimmed.startsWith('(') && !trimmed.startsWith('{')) fields.add(trimmed)
  }
  const walk = (node: TemplateNode | undefined) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 1) {
      for (const prop of node.props || []) {
        if (prop.type !== 7) continue
        if (prop.name === 'model' && prop.exp) add(prop.exp.content)
        else if (prop.name === 'on' && EDIT_HANDLERS.has(prop.arg?.content || '') && prop.exp) {
          for (const match of prop.exp.content.matchAll(/(?:^|[^.\w$])([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)\s*=(?!=)/g)) add(match[1]!)
          // A handler that MUTATES a bound list (`music.files.splice(i, 1)`)
          // edits a form value exactly as an assignment does. Only a list the
          // template already binds counts: a local array's own `.sort()` in a
          // handler is not a form field.
          for (const match of prop.exp.content.matchAll(/([a-zA-Z_$][\w$]*(?:\.[\w$]+)*)\.(?:splice|push|pop|shift|unshift|sort|reverse)\s*\(/g)) {
            const target = match[1]!
            const root = target.split('.')[0]!
            // The ROOT must be a form object the template already binds
            // (`music.enabled` is bound, so `music.files.splice(...)` is a form
            // edit). A local array's own `.sort()` is not.
            if ([...fields].some(bound => bound === root || bound.startsWith(`${root}.`))) add(target)
          }
        }
      }
    }
    for (const child of node.children || []) walk(child)
    const branches = node.branches
    if (Array.isArray(branches)) branches.forEach(walk)
    else if (branches) walk(branches)
    walk(node.elseBranch)
  }
  walk(descriptor.template.ast as TemplateNode)
  return [...fields].sort()
}

function scriptOf(source: string): string {
  const { descriptor } = parse(source, { filename: 'page.vue' })
  return `${descriptor.scriptSetup?.content || ''}\n${descriptor.script?.content || ''}`
}

/**
 * The text of every `usePresets(…)` call on the page, plus the bodies of the
 * page-local functions those calls name (two hops).
 *
 * Following the helpers is what makes the check useful: most pages snapshot through
 * `snapshotSomething()`, and a checker that read only the call site would call every
 * field on those pages missing. `.value` is normalised away so `form.value.model` in
 * a helper matches the template's `form.model`.
 */
function presetRegion(script: string): { calls: string; helpers: string } {
  const regions: string[] = []
  const calls: string[] = []
  const callPattern = /\busePresets\s*(?:<[^>]*>)?\s*\(/g
  let match: RegExpExecArray | null
  while ((match = callPattern.exec(script))) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let close = open
    for (; close < script.length; close++) {
      if (script[close] === '(') depth++
      else if (script[close] === ')' && --depth === 0) break
    }
    const call = script.slice(match.index, close + 1)
    calls.push(call)
    regions.push(call)
    callPattern.lastIndex = close + 1
  }

  const seen = new Set<string>()
  let queue = calls
  for (let hop = 0; hop < 2; hop++) {
    const names = new Set<string>()
    for (const region of queue) {
      for (const helper of region.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) names.add(helper[1]!)
    }
    queue = []
    for (const helper of names) {
      if (seen.has(helper)) continue
      seen.add(helper)
      const declaration = new RegExp(`function\\s+${escapeRegex(helper)}\\s*\\(`)
      const found = declaration.exec(script)
      if (!found) continue
      let depth = 0
      let end = script.indexOf('{', found.index)
      for (; end < script.length; end++) {
        if (script[end] === '{') depth++
        else if (script[end] === '}' && --depth === 0) break
      }
      // The parameter list is dropped: in a helper body `cue: Cue` is a type
      // annotation, and reading it as a snapshot key would claim the page saves
      // a `cue` object it does not.
      const body = script.slice(script.indexOf('{', found.index), end + 1)
      regions.push(body)
      queue.push(body)
    }
  }
  const normalise = (text: string) => text.replace(/\.value\./g, '.').replace(/\.value\b/g, '')
  // The call sites and the helper bodies are kept APART on purpose: a bare
  // `root:` key or `root,` list item counts only inside the preset call, because
  // ordinary page code is full of declarations (`const visualSource = ref(...)`)
  // that have nothing to do with the payload.
  const helperBodies = regions.filter(region => !calls.includes(region))
  return { calls: normalise(calls.join('\n')), helpers: normalise(helperBodies.join('\n')) }
}

/**
 * The page's own exclusion list, evaluated exactly as the composable reads it.
 *
 * A page may name its extra keys through a local constant (`AUDIO_MERGE_PATH_KEYS`)
 * rather than inline. Those are resolved from the page's own source, so the list
 * driven here is the list the page really passes — not a re-typed copy that could
 * disagree with it.
 */
function excludeKeysOf(source: string): string[] {
  const script = scriptOf(source)
  if (/CONTINUITY_PRESET_EXCLUDE_KEYS/.test(script)) return [...CONTINUITY_PRESET_EXCLUDE_KEYS]
  // EVERY controller on the page, not just the first: Video Assembly mounts nine
  // of them, and a key one of them excludes is a key this page never stores.
  const declared = [...script.matchAll(/excludeKeys:\s*(\[[^\]]*\])/g)].map(match => match[1]!)
  if (!declared.length) return [...DEFAULT_EXCLUDE_KEYS]

  const locals: string[] = []
  const keys = new Set<string>()
  for (const expression of declared) {
    // A page-local constant named in the expression: `...AUDIO_MERGE_PATH_KEYS`
    // or a bare `AUDIO_MERGE_PATH_KEYS` item. String literals are skipped.
    const referenced = new Set(
      [...expression.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)|(?:^|[[,])\s*([A-Za-z_$][\w$]*)\s*(?=[,\]])/g)]
        .map(m => (m[1] ?? m[2])!)
        .filter(name => name !== 'DEFAULT_EXCLUDE_KEYS'),
    )
    for (const name of referenced) {
      const local = script.match(new RegExp(`const\\s+${escapeRegex(name)}\\s*=\\s*(\\[[^\\]]*\\])`))
      if (local && !locals.includes(`const ${name} = ${local[1]};`)) locals.push(`const ${name} = ${local[1]};`)
    }
    const resolved = new Function('DEFAULT_EXCLUDE_KEYS', `${locals.join('\n')}
      return ${expression}`)(DEFAULT_EXCLUDE_KEYS) as string[]
    for (const key of resolved) keys.add(key)
  }
  return [...keys]
}

/**
 * Does the page's preset code reference this field at all?
 *
 * A leaf name only counts when the object it belongs to is itself part of the
 * payload — a leaf that happens to collide with an unrelated key is not evidence.
 */
function presetMentions(region: { calls: string; helpers: string }, path: string): boolean {
  const [root, ...rest] = path.split('.')
  const both = `${region.calls}\n${region.helpers}`
  // An exact path counts anywhere in the preset code — the call site OR a helper
  // it reaches, because most snapshots are built in a helper.
  if (both.includes(path)) return true
  // A parent path passed whole (`closing_music: snapshotClosingMusic(postAudio.closing_music)`)
  // carries every field under it, the same way a spread of the root does.
  for (let cut = rest.length - 1; cut >= 1; cut--) {
    const parent = [root, ...rest.slice(0, cut)].join('.')
    if (both.includes(parent)) return true
  }
  // A spread of the object (`...form`, `...form.value`) carries every field under
  // it, wherever it appears.
  if (new RegExp(`\\.\\.\\.${escapeRegex(root!)}(\\.value)?\\b`).test(both)) return true
  // `root: …` carries the whole object unless the value is an OBJECT LITERAL.
  //   form: { ...form }                              → whole
  //   recipe: JSON.parse(JSON.stringify(segment.recipe)) → whole
  //   form: { model: form.model }                    → only `model`
  // The last shape is the one to be strict about: treating a partial literal as
  // whole would hide a new field added beside it — exactly this file's defect.
  const keyed = new RegExp(`(^|[^.\\w$])${escapeRegex(root!)}\\s*:\\s*([\\s\\S]{0,80})`, 'g')
  for (const key of region.calls.matchAll(keyed)) {
    if (!key[2]!.trimStart().startsWith('{')) return true
  }
  // Shorthand (`{ form, model }`) is the object itself.
  if (new RegExp(`(^|[^.\\w$])${escapeRegex(root!)}\\s*[,}]`).test(region.calls)) return true
  const leaf = rest.length ? rest[rest.length - 1]! : null
  return !!leaf && new RegExp(`\\.\\.\\.${escapeRegex(leaf)}\\b`).test(both)
}

type FieldVerdict = Verdict | 'saved' | 'excluded' | 'UNCLASSIFIED'

function classify(
  source: string,
  table: Record<string, Classification>,
): Array<{ path: string; verdict: FieldVerdict }> {
  const region = presetRegion(scriptOf(source))
  const excluded = excludeKeysOf(source)
  return templateFields(source).map(path => {
    const leaf = path.split('.').pop()!
    if (presetMentions(region, path)) return { path, verdict: 'saved' as const }
    if (excluded.includes(leaf) || excluded.includes(path)) return { path, verdict: 'excluded' as const }
    return { path, verdict: (table[path]?.verdict ?? 'UNCLASSIFIED') as FieldVerdict }
  })
}

describe('every field on a preset page is classified', () => {
  for (const name of PRESET_PAGES) {
    test(name, () => {
      const unclassified = classify(pageSource(name), CLASSIFIED[name] ?? {}).filter(row => row.verdict === 'UNCLASSIFIED')
      assert.deepEqual(
        unclassified.map(row => row.path), [],
        `${name} has form fields the preset neither saves, excludes, nor accounts for: `
        + `${unclassified.map(row => row.path).join(', ')}.\n`
        + 'Either add it to the page\'s preset snapshot AND apply (carrying the live value across '
        + 'the apply — AGENTS.md §5, trap 1), or add it to CLASSIFIED in this file with the reason '
        + 'it must not travel (episode state, per-run switch, dialog state, or saved elsewhere).',
      )
    })
  }
})

/** An `excluded` entry is only true when the page's own list really names it. */
function excludedVerdictHolds(source: string, path: string): boolean {
  const excluded = excludeKeysOf(source)
  return excluded.includes(path.split('.').pop()!) || excluded.includes(path)
}

describe('the classification cannot lie or outlive its field', () => {
  for (const name of PRESET_PAGES) {
    test(`${name}: entries name real fields and their claims hold`, () => {
      const source = pageSource(name)
      const fields = new Set(templateFields(source))
      const region = presetRegion(scriptOf(source))
      const excluded = excludeKeysOf(source)
      const table = CLASSIFIED[name] ?? {}

      const stale = Object.keys(table).filter(path => !fields.has(path))
      assert.deepEqual(stale, [], `${name}: CLASSIFIED names fields the template no longer binds — remove them`)

      for (const [path, entry] of Object.entries(table)) {
        assert.ok(entry.reason.trim().length > 20, `${name}:${path} needs a real reason, not a bare verdict`)

        if (entry.verdict === 'excluded') {
          assert.ok(
            excludedVerdictHolds(source, path),
            `${name}:${path} is classified excluded, but the page's own excludeKeys does not name it. `
            + 'Add it to the page\'s excludeKeys — a reason here does not exclude anything.',
          )
          continue
        }

        if (entry.verdict === 'saved-by-preset') {
          // The claim is checkable: the alias target must really be in the payload.
          assert.ok(entry.via, `${name}:${path} claims the preset carries it — name the path in \`via\``)
          const viaRegion = presetRegion(scriptOf(source))
          const via = entry.via!
          const reachable = `${viaRegion.calls}\n${viaRegion.helpers}`.includes(via)
            || new RegExp(`\\.\\.\\.${escapeRegex(via.split('.')[0]!)}\\b`).test(viaRegion.calls)
          assert.ok(
            reachable,
            `${name}:${path} is classified saved-by-preset via "${via}", but the preset code does `
            + 'not reference that path. Either the snapshot lost it, or the claim is wrong.',
          )
          continue
        }

        // Every other verdict says "not in the preset". If the preset code now
        // mentions the field, the verdict is stale — the field became saved and
        // nobody removed the exception.
        const savedNow = presetMentions(region, path)
        assert.equal(
          savedNow, false,
          `${name}:${path} is classified "${entry.verdict}" but the preset now carries it. `
          + 'Remove the exception and let the preset own it, or stop saving it.',
        )
      }
    })
  }
})

// ── The checker's own failure modes ─────────────────────────────────────────
//
// The suite above is only worth having if it FAILS on the shape it exists for.
// These drive the real extractor over synthetic pages, so a future "fix" that
// quietly made `presetMentions` always true (or `templateFields` always empty)
// breaks here rather than passing everything downstream.

const PAGE = (template: string, script: string) => `
<template>
  <div>${template}</div>
</template>
<script setup lang="ts">
${script}
</script>
`

describe('the checker fails the shapes it exists for', () => {
  test('a new field the preset does not carry is reported', () => {
    const source = PAGE(
      '<input v-model="form.model" /><input v-model="form.brand_new_knob" />',
      `const presets = usePresets({ snapshot: () => ({ form: { model: form.model } }), apply: () => {} })`,
    )
    const rows = classify(source, {})
    assert.deepEqual(rows.filter(row => row.verdict === 'UNCLASSIFIED').map(row => row.path), ['form.brand_new_knob'])
  })

  test('a whole-object snapshot covers its fields', () => {
    const source = PAGE(
      '<input v-model="form.model" /><input v-model="form.speed" />',
      `const presets = usePresets({ snapshot: () => ({ form: { ...form } }), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.verdict), ['saved', 'saved'])
  })

  test('a snapshot built in a helper still counts', () => {
    const source = PAGE(
      '<input v-model="form.speed" />',
      `function snapshotForm() { return { form: { speed: form.speed } } }
       const presets = usePresets({ snapshot: () => snapshotForm(), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.verdict), ['saved'])
  })

  test('an excluded field reads as excluded, not as missing', () => {
    const source = PAGE(
      '<input v-model="form.episode_id" />',
      `const presets = usePresets({ snapshot: () => ({}), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.verdict), ['excluded'])
  })

  test('a handler that mutates a bound list is a field too', () => {
    const source = PAGE(
      '<input v-model="music.enabled" /><button @click="music.files.splice(i, 1)">Remove</button>',
      `const presets = usePresets({ snapshot: () => ({ music: { enabled: music.enabled } }), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.path).sort(), ['music.enabled', 'music.files'])
  })

  test('every controller\'s excludeKeys counts, not just the first', () => {
    // Video Assembly mounts nine controllers over five config keys; a key one of
    // them excludes is a key the page never stores.
    const source = PAGE(
      '<input v-model="form.episode_picture" /><input v-model="form.model" />',
      `const first = usePresets({ snapshot: () => ({ model: form.model }), apply: () => {} })
       const second = usePresets({ excludeKeys: ['episode_picture'], snapshot: () => ({}), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.verdict), ['excluded', 'saved'])
  })

  test('an `excluded` claim is checked against the page\'s own excludeKeys', () => {
    const template = '<input v-model="form.model" /><input v-model="form.episode_file" />'
    const withExclusion = PAGE(template,
      `const presets = usePresets({ excludeKeys: ['episode_file'], snapshot: () => ({ model: form.model }), apply: () => {} })`)
    const without = PAGE(template,
      `const presets = usePresets({ snapshot: () => ({ model: form.model }), apply: () => {} })`)

    // With the page's exclusion in place the field reads as excluded; the table
    // entry only supplies the REASON.
    const classified = { 'form.episode_file': { verdict: 'excluded' as const, reason: 'one episode\'s own file' } }
    assert.deepEqual(classify(withExclusion, classified).map(row => row.verdict), ['excluded', 'saved'])
    // Without the page's own exclusion the claim is empty, and the honesty check
    // is what refuses it — that is the half this control exists for.
    assert.equal(
      excludedVerdictHolds(without, 'form.episode_file'),
      false,
      'a reason in the table must not stand in for an actual exclusion',
    )
  })

  test('a click-handler assignment is a field too', () => {
    const source = PAGE(
      '<button @click="form.mode = \'guided\'">Guided</button>',
      `const presets = usePresets({ snapshot: () => ({}), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.path), ['form.mode'])
  })

  test('a helper that merely mentions a field is not evidence the preset stores it', () => {
    // `editorForm.title = from?.title` in ordinary page code must not read as a
    // snapshot key — the bug this rule exists for.
    const source = PAGE(
      '<input v-model="editorForm.logline" />',
      `function hydrate(from: any) { editorForm.logline = from?.logline || '' }
       const presets = usePresets({ snapshot: () => ({ form: { ...form } }), apply: () => {} })`,
    )
    assert.deepEqual(classify(source, {}).map(row => row.verdict), ['UNCLASSIFIED'])
  })
})
