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
  assert.match(source, /if \(isSketchDraw\.value\) \{\s+if \(!presentationLoaded\.value\)/)
  assert.match(source, /return eligibleClipCount\.value \? .*Sketch Draw on this Mac/)
  // The only price text sits inside the image-to-video confirmation, which Sketch Draw skips.
  assert.equal(fn('generateMissing').match(/formatCredits/g)?.length, 1)
  assert.match(fn('generateMissing'), /if \(!isSketchDraw\.value && !await ask\([\s\S]*formatCredits/)
  assert.match(source, /return selectionReady\.value \? \{ renderer: 'sketch_draw' \} : null/)
})

test('the four pens reuse channel name and the channel-profile logo; unavailable logo is explained', () => {
  for (const label of ['No pen (default)', 'Plain pen', 'Pen with channel name', 'Pen with channel logo']) {
    assert.ok(source.includes(`>${label}</option>`), label)
  }
  assert.match(source, /:disabled="!channelHasLogo"/)
  assert.match(source, /Channel logo pen is unavailable\. Add a logo in Channel Profile to use it\./)
  assert.match(source, /channel_name: string; has_logo: boolean/)
  assert.match(source, /Pen name: \{\{ channelName \}\}/)
})

test('renderer and pen are channel selections, saved as a selection only and rolled back on failure', () => {
  assert.doesNotMatch(source, /renderer:.*presetType|motion_presentation.*snapshot/)
  assert.match(fn('saveMotionPresentation'), /acceptedPresentation = \{ renderer: clipRenderer\.value, pen: sketchPen\.value \}/)
  assert.match(fn('saveMotionPresentation'), /clipRenderer\.value = acceptedPresentation\.renderer/)
  assert.match(fn('saveMotionPresentation'), /sketchPen\.value = acceptedPresentation\.pen/)
  assert.match(source, /\/projects\/\$\{slug\.value\}\/motion-presentation/)
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
  assert.match(source, /Shorter than this channel's \$\{animateMinSeconds\}s animation minimum/)
  assert.match(source, /function sceneTooShort\(scene: MotionScene\)/)
})
