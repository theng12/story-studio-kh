import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { motionBatchEligible, sketchSelectionReady } from '../utils/motion-review-sketch'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

const baseScene = {
  approved: true,
  image_filename: 'scene-1.png',
  motion_prompt: 'slow push',
  clip_exists: false,
  clip_stale: false,
  motion_choice: 'pending' as const,
  start_sec: 0,
  end_sec: 4,
}

test('batch eligibility is behavioural: sketch retries stale clips, provider only fills gaps', () => {
  const context = { isSketchDraw: true, scoped: true, animateMinSeconds: 1, imagePool: false }
  assert.equal(motionBatchEligible(baseScene, context), true)
  assert.equal(motionBatchEligible({ ...baseScene, clip_exists: true, clip_stale: true }, context), true)
  assert.equal(motionBatchEligible({ ...baseScene, clip_exists: true, clip_stale: false }, context), false)
  assert.equal(motionBatchEligible({ ...baseScene, start_sec: 0, end_sec: 0.5 }, context), false, 'below the animate floor')
  assert.equal(motionBatchEligible({ ...baseScene, motion_choice: 'still' }, context), false)
  assert.equal(motionBatchEligible({ ...baseScene, approved: false }, context), false)
  assert.equal(motionBatchEligible({ ...baseScene, image_filename: null }, context), false)
  assert.equal(motionBatchEligible(baseScene, { ...context, scoped: false }), false)
  assert.equal(motionBatchEligible(baseScene, { ...context, imagePool: true }), false)
  // Provider mode still requires a motion prompt and does not batch over an existing clip.
  const provider = { ...context, isSketchDraw: false }
  assert.equal(motionBatchEligible({ ...baseScene, motion_prompt: '' }, provider), false)
  assert.equal(motionBatchEligible({ ...baseScene, clip_exists: true, clip_stale: true }, provider), false)
})

test('Sketch Draw readiness is behavioural: a logo pen needs the channel logo', () => {
  const ready = { loaded: true, saving: false, pen: 'none' as const, hasLogo: false }
  assert.equal(sketchSelectionReady(ready), true)
  assert.equal(sketchSelectionReady({ ...ready, pen: 'logo' }), false)
  assert.equal(sketchSelectionReady({ ...ready, pen: 'logo', hasLogo: true }), true)
  assert.equal(sketchSelectionReady({ ...ready, loaded: false }), false)
  assert.equal(sketchSelectionReady({ ...ready, saving: true }), false)
})

test('a text-to-video scene batches without an approved still, but needs its video prompt', () => {
  const context = { isSketchDraw: false, scoped: true, animateMinSeconds: 1, imagePool: false }
  const t2v = { ...baseScene, image_filename: null, approved: false, visual_lane: 'text_to_video' as const, video_prompt: 'slow dolly' }
  assert.equal(motionBatchEligible(t2v, context), true, 'a T2V scene has no still by design')
  assert.equal(motionBatchEligible({ ...t2v, video_prompt: '' }, context), true, 'a T2V scene may fall back to its motion prompt')
  assert.equal(motionBatchEligible({ ...t2v, video_prompt: '', motion_prompt: '' }, context), false, 'no prompt means nothing to render')
  assert.equal(motionBatchEligible({ ...t2v, clip_exists: true }, context), false, 'an existing clip is never re-bought in a batch')
  // An image lane still requires its own approved still.
  assert.equal(motionBatchEligible({ ...baseScene, image_filename: null, visual_lane: 'image_to_video' }, context), false)
})

function fn(name: string): string {
  const marker = `function ${name}(`
  const asyncStart = source.indexOf(`async ${marker}`)
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(marker)
  assert.ok(start >= 0, `expected ${name}`)
  const nextAsync = source.indexOf('\nasync function ', start + 10)
  const nextSync = source.indexOf('\nfunction ', start + 10)
  return source.slice(start, Math.min(...[nextAsync, nextSync].filter(index => index > 0)))
}

test('one renderer choice sits inside the existing Motion controls; no extra action was added', () => {
  assert.match(source, /<strong>Motion controls<\/strong>/)
  assert.match(source, /aria-label="Motion renderer"/)
  assert.match(source, /<option value="image_to_video">Image to video<\/option>/)
  assert.match(source, /<option value="sketch_draw">Sketch Draw<\/option>/)
  assert.equal((source.match(/Generate Missing Clips/g) || []).length, 1)
  assert.doesNotMatch(source, /Sketch Draw Clip<\/button>|Generate Sketch/)
})

test('Sketch Draw hides provider model, cost and switches and shows no invented price', () => {
  assert.match(source, /<template v-if="!isSketchDraw">[\s\S]*Image-to-video model[\s\S]*<\/template>\s*<button v-if="motionScope.mode === 'all'"/)
  assert.match(source, /if \(isSketchDraw\.value\) \{\s+if \(!presentationLoaded\.value \|\| !penLoaded\.value\)/)
  assert.match(source, /return eligibleClipCount\.value \? .*Sketch Draw on this Mac/)
  // The only price text sits inside the image-to-video confirmation, which Sketch Draw skips.
  assert.equal(fn('generateMissing').match(/formatCredits/g)?.length, 1)
  assert.match(fn('generateMissing'), /if \(!isSketchDraw\.value && !await ask\([\s\S]*formatCredits/)
  assert.match(source, /return selectionReady\.value \? \{ renderer: 'sketch_draw' \} : null/)
})

test('the pens reuse channel name and the channel-profile logo; unavailable logo is explained', () => {
  for (const label of ['No pen', 'Plain pen', 'Pen with channel name', 'Pen with channel logo']) {
    assert.ok(source.includes(`>${label}</option>`), label)
  }
  assert.match(source, /:disabled="!channelHasLogo"/)
  assert.match(source, /Channel logo pen is unavailable\. Add a logo in Channel Profile to use it\./)
  assert.match(source, /channel_name: string; has_logo: boolean/)
  assert.match(source, /Pen name: \{\{ channelName \}\}/)
})

test('the pen control edits THIS episode, is labelled so, and can return to the channel default', () => {
  assert.match(source, /<span>Pen for \{\{ episodeId \}\}<\/span>/)
  assert.match(source, /<option value="channel">Channel default \(\{\{ penLabel\(channelPen\) \}\}\)<\/option>/)
  assert.match(source, /v-model="penChoice"[^>]*@change="saveEpisodePen"/)
  // It says whose pen is in force, in both directions.
  assert.match(source, /\{\{ episodeId \}\} uses its own pen: \{\{ penLabel\(episodePen\) \}\}\. Other episodes are not affected\./)
  assert.match(source, /\{\{ episodeId \}\} follows the channel default pen: \{\{ penLabel\(channelPen\) \}\}/)
  // The effective pen is the episode's, else the channel's; the server resolves it the same way.
  assert.match(source, /const sketchPen = computed<PenMode>\(\(\) => episodePen\.value \?\? channelPen\.value\)/)
  const save = fn('saveEpisodePen')
  assert.match(save, /penChoice\.value === 'channel' \? null : penChoice\.value/)
  assert.match(save, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-pen`, \{ pen: next \}/)
  assert.match(save, /penChoice\.value = penUnreadable\.value \? '' : episodePen\.value \?\? 'channel'/, 'a failed save rolls the control back')
  assert.match(save, /if \(ep !== episodeId\.value\) return/, 'a late answer never lands on the next episode')
})

test('the renderer is a channel choice that never moves a pen; the channel default is moved only on purpose', () => {
  assert.doesNotMatch(source, /renderer:.*presetType|motion_presentation.*snapshot|pen:.*presetType/)
  const save = fn('saveMotionPresentation')
  assert.match(save, /\{ renderer: clipRenderer\.value \}\)/)
  assert.doesNotMatch(save, /\b(pen|sketchPen|episodePen|penChoice)\b\s*[:.]/, 'saving the renderer sends no pen')
  assert.match(save, /clipRenderer\.value = acceptedRenderer/)
  assert.match(source, /\/projects\/\$\{slug\.value\}\/motion-presentation/)
  assert.match(source, /Make this the channel default/)
  assert.match(fn('setChannelPenDefault'), /\{ renderer: clipRenderer\.value, pen \}/)
})

test('presets never carry a pen: the preset snapshot is built without it', () => {
  const start = source.indexOf('const motionPresets = usePresets(')
  const snapshot = source.slice(start, source.indexOf('\n  apply:', start))
  assert.ok(snapshot.includes('duration_mode'), 'found the snapshot')
  assert.doesNotMatch(snapshot, /\b(sketchPen|episodePen|channelPen|penChoice|clipRenderer)\b/)
})

test('an episode change blanks the pen, disables the control until the new answer, and reloads it', () => {
  const reset = fn('resetEpisodeScopedMotionState')
  assert.match(reset, /episodePen\.value = null/)
  assert.match(reset, /penChoice\.value = 'channel'/)
  assert.match(reset, /penLoaded\.value = false/)
  assert.match(reset, /penSaving\.value = false/)
  assert.match(source, /watch\(episodeId, \(\) => \{[\s\S]*resetEpisodeScopedMotionState\(\)[\s\S]*void loadEpisodePen\(\)/)
  assert.match(source, /:disabled="!penLoaded \|\| penSaving"/)
  // Generation waits for this episode's pen, never the previous episode's.
  assert.match(source, /loaded: presentationLoaded\.value && penLoaded\.value/)
  const load = fn('loadEpisodePen')
  assert.match(load, /if \(ep !== episodeId\.value\) return/)
  assert.match(load, /episodePen\.value = result\.episode_pen/)
  assert.match(load, /penChoice\.value = result\.error \? '' : result\.episode_pen \?\? 'channel'/)
})

test('moving the channel default asks first, names the effect, and announces the result', () => {
  const move = fn('setChannelPenDefault')
  assert.match(move, /await ask\(\{[\s\S]*Episodes without their own pen will use \$\{penLabel\(pen\)\}; their existing Sketch Draw clips will need re-generating\./)
  assert.ok(move.indexOf('await ask(') < move.indexOf("put(`/projects/"), 'nothing is saved before the answer')
  assert.match(move, /\) return\n  presentationSaving\.value = true/, 'declining stops before any save')
  assert.match(move, /success\(`Channel default pen is now \$\{penLabel\(pen\)\}\./)
})

test('an unreadable saved pen keeps the control enabled, says so, and blocks Sketch Draw until a pen is chosen', () => {
  const load = fn('loadEpisodePen')
  assert.match(load, /penUnreadable\.value = result\.error \|\| ''/)
  assert.match(load, /penChoice\.value = result\.error \? '' : result\.episode_pen \?\? 'channel'/)
  assert.match(load, /penLoaded\.value = true/, 'loaded, so the select is not disabled')
  assert.match(source, /<option v-if="penUnreadable" value="" disabled>Choose a pen…<\/option>/)
  assert.match(source, /\{\{ penUnreadable \}\} Choose a pen to replace it; Sketch Draw waits until you do\./)
  assert.match(source, /loaded: presentationLoaded\.value && penLoaded\.value && !penUnreadable\.value/)
  assert.match(fn('saveEpisodePen'), /penUnreadable\.value = ''/, 'a successful save clears it')
  assert.match(fn('resetEpisodeScopedMotionState'), /penUnreadable\.value = ''/)
})

test('the logo choice is disabled with no logo and a logo pen is not ready without one', () => {
  assert.match(source, /<option value="logo" :disabled="!channelHasLogo">/)
  // The readiness rule is fed the EFFECTIVE pen, so an episode (or a channel default) on logo is blocked too.
  assert.match(source, /pen: sketchPen\.value, hasLogo: channelHasLogo\.value/)
  assert.equal(sketchSelectionReady({ loaded: true, saving: false, pen: 'logo', hasLogo: false }), false)
})

test('episode changes blank in-flight controls and late queue dialogs cannot act on the next episode', () => {
  const reset = fn('resetEpisodeScopedMotionState')
  for (const ref of ['queuing', 'savingAll', 'savingId', 'animatingId', 'uploadingId']) assert.match(reset, new RegExp(`${ref}\\.value =`))
  assert.match(fn('generateOne'), /const ep = episodeId\.value[\s\S]*ep !== episodeId\.value\) return[\s\S]*generate-clip`, \{/)
  assert.match(fn('generateMissing'), /if \(ep !== episodeId\.value\) return/)
})

test('one Use Clip expression and stale reason are shared with the approval rule', () => {
  assert.match(source, /clip_stale_reason/)
  assert.match(source, /:disabled="!scene\.clip_exists \|\| scene\.clip_stale \|\| savingId === scene\.id"/)
  assert.match(source, /Re-generate before approval/)
})

test('skip reasons are named and the per-scene Generate action respects the animate floor', () => {
  assert.match(source, /skipped_reasons/)
  assert.match(source, /sceneTooShort\(scene\)/)
  // The floor is the disabled button's stated reason (1.4.354: every disabled Generate Clip says why).
  assert.match(source, /if \(sceneTooShort\(scene\)\) return `shorter than this channel's \$\{animateMinSeconds\.value\}s animation minimum`/)
  assert.match(source, /:disabled="!!generateBlocked\(scene\)/)
  assert.match(source, /:title="generateBlocked\(scene\) \|\| undefined"/)
  assert.match(source, /function sceneTooShort\(scene: MotionScene\)/)
})

test('the reveal style control edits THIS episode, offers the channel default, and a Mix waits for Apply', () => {
  // The select is scoped to Sketch Draw and labelled as this episode's own setting.
  assert.match(source, /<span>Reveal style for \{\{ episodeId \}\}<\/span>/)
  assert.match(source, /<select v-model="revealChoice"[^>]*aria-label="Sketch Draw reveal style for this episode"/)
  // Following the channel again is its own option, as for the pen and hold. There is no separate
  // "not chosen" episode value: an episode with no style of its own IS following the channel.
  assert.match(source, /<option value="channel">Channel default \(\{\{ revealLabel\(channelReveal\) \}\}\)<\/option>/)
  assert.doesNotMatch(source, /<option value="none">Not chosen/)
  // Each of the five styles is offered by name through a v-for loop.
  assert.match(source, /<option v-for="type in REVEAL_TYPES" :key="type" :value="type">\{\{ REVEAL_LABELS\[type\] \}\}<\/option>/)
  assert.match(source, /<option value="mix">Mix — a different style per scene<\/option>/)
  // The Mix expands into checkboxes and an Apply button; a single style saves at once.
  assert.match(source, /<div v-if="isSketchDraw && revealChoice === 'mix'" class="hold-inputs">/)
  assert.match(source, /<label v-for="type in REVEAL_TYPES"[^>]*class="reveal-mix-item">/)
  assert.match(source, /<input v-model="revealMixDraft" type="checkbox" :value="type"/)
  assert.match(source, /@click="applyReveal">Apply mix<\/button>/)
  // A single style and "follow the channel" save at once; a Mix waits for Apply.
  const onChoice = fn('onRevealChoice')
  assert.match(onChoice, /if \(revealChoice\.value === 'mix'\)/)
  assert.match(onChoice, /if \(revealChoice\.value === 'channel'\) \{ void saveReveal\(null\); return \}/)
  assert.match(onChoice, /const parsed = revealFromDraft\(revealChoice\.value, \[\]\)/)
  assert.match(onChoice, /if \(parsed\.ok\) void saveReveal\(parsed\.reveal\)/)
  const apply = fn('applyReveal')
  assert.match(apply, /const parsed = revealFromDraft\('mix', revealMixDraft\.value\)/)
  assert.match(apply, /void saveReveal\(/)
  // A Mix edit keeps this episode's own per-scene pins.
  assert.match(apply, /const overrides = episodeReveal\.value\?\.overrides/)
  // The save is THIS episode's, never the channel's.
  const save = fn('saveReveal')
  assert.match(save, /const ep = episodeId\.value/)
  assert.match(save, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-reveal`, \{ reveal: next \}/)
  assert.match(save, /if \(ep !== episodeId\.value\) return/, 'a late answer never lands on the next episode')
  assert.match(save, /episodeReveal\.value = next/)
  assert.match(save, /revealChoice\.value = acceptedRevealChoice\(\)/)
  // The state is episode-scoped: an episode change blanks it.
  const reset = fn('resetEpisodeScopedMotionState')
  assert.match(reset, /episodeReveal\.value = null/)
  assert.match(reset, /revealChoice\.value = 'channel'/)
  assert.match(reset, /revealMixDraft\.value = revealMixFor\(null\)/)
  assert.match(reset, /revealLoaded\.value = false/)
  assert.match(reset, /revealSaving\.value = false/)
  assert.match(reset, /revealUnreadable\.value = ''/)
  assert.match(source, /watch\(episodeId, \(\) => \{[\s\S]*resetEpisodeScopedMotionState\(\)[\s\S]*void loadEpisodeReveal\(\)/)
  const load = fn('loadEpisodeReveal')
  assert.match(load, /if \(ep !== episodeId\.value\) return/)
  assert.match(load, /scene-review\/\$\{encodeURIComponent\(ep\)\}\/motion-reveal`/)
  assert.match(load, /episodeReveal\.value = result\.episode_reveal/)
  assert.match(load, /channelReveal\.value = result\.channel_reveal/)
  assert.match(load, /revealUnreadable\.value = result\.error \|\| ''/)
  // It says whose reveal is in force, in both directions.
  assert.match(source, /\{\{ episodeId \}\} uses its own reveal: \{\{ revealLabel\(episodeReveal\) \}\}\. Other episodes are not affected\./)
  assert.match(source, /\{\{ episodeId \}\} follows the channel default reveal: \{\{ revealLabel\(channelReveal\) \}\}/)
  assert.match(source, /No reveal style chosen, so clips keep the reveal they were made with\./)
  assert.match(source, /Clips made before this setting keep their reveal until you re-generate them\./)
  // Each scene row shows the style it will draw with, and offers a pin of its own.
  assert.match(source, /<span>Reveal for this scene<\/span>/)
  assert.match(source, /:aria-label="`Reveal style for scene \$\{scene\.scene_index\}`"/)
  assert.match(source, /@change="setScenePin\(scene, \(\$event\.target as HTMLSelectElement\)\.value\)"/)
})

test('the reveal look travels in the preset and the per-scene pins never do', () => {
  const start = source.indexOf('const motionPresets = usePresets(')
  const snapshot = source.slice(start, source.indexOf('\n  apply:', start))
  // `overrides` holds this episode's per-scene pins; the default identity keys are spread back in
  // because `excludeKeys` REPLACES the default list rather than extending it.
  assert.match(source, /excludeKeys: \[\.\.\.DEFAULT_EXCLUDE_KEYS, 'overrides'\]/)
  assert.ok(snapshot.includes('revealForPreset(episodeReveal.value)'), 'the look is captured')
  const apply = source.slice(source.indexOf('\n  apply:', start))
  // The live pins are carried across the apply explicitly, and only once this episode is known.
  assert.match(apply, /if \(revealLoaded\.value\) \{[\s\S]*applyRevealPreset\(data\?\.reveal, episodeReveal\.value\)/)
  assert.match(apply, /void saveReveal\(nextReveal\)/)
})
