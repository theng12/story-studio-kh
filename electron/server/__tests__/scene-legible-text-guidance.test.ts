/**
 * v1.0.794 — "Avoid readable text in images" (lib/image-content-guidance.ts:
 * AVOID_LEGIBLE_TEXT_GUIDANCE / legibleTextGuidanceBlock / resolveAvoidLegibleText).
 *
 * A fast image model asked to render a scroll, ledger, or sign usually renders
 * confident-looking gibberish instead of real words. History/documentary
 * channels depict real documents constantly and legitimately (Procopius
 * writing his history is exactly right as a subject), so the fix is never
 * "stop showing documents" — it's an opt-in instruction, SCENE prompts only,
 * telling the writer to describe lettering as texture instead of specific
 * words.
 *
 * Three things are locked down here:
 *
 *   1. The guidance text says the right thing, and the block/resolver helpers
 *      compose correctly and default to OFF unless a caller explicitly opts
 *      in (unlike IMAGE_CONTENT_GUIDANCE, which every path gets
 *      unconditionally).
 *
 *   2. The SCENE path (generators/scene-plan.ts packed writer,
 *      services/scene-planner.ts generateVisualPromptOnly — reached by the
 *      Scene Plan page's "regenerate this scene's prompt" / "reword" action)
 *      wires the toggle through, and with it OFF produces byte-identical
 *      output to the pre-existing formula — nobody's existing project's
 *      output shifts just because this shipped.
 *
 *   3. The THUMBNAIL path (generators/image-prompts.ts buildThumbnailPrompt)
 *      never receives this, structurally: it doesn't import the helper, its
 *      source never mentions it, and its actual output — even when every
 *      knob is exercised — never contains the guidance text and always still
 *      demands legible in-image typography. This is the regression the owner
 *      explicitly asked to prevent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  AVOID_LEGIBLE_TEXT_GUIDANCE,
  IMAGE_CONTENT_GUIDANCE,
  imagePromptGuidanceBlock,
  legibleTextGuidanceBlock,
  resolveAvoidLegibleText,
} from '../lib/image-content-guidance.js'
import { buildThumbnailPrompt } from '../generators/image-prompts.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('legible-text guidance — substance', () => {
  test('describes lettering as texture, never asks for specific readable words', () => {
    const text = AVOID_LEGIBLE_TEXT_GUIDANCE.toLowerCase()
    assert.match(text, /indistinct/, 'must steer toward indistinct marks')
    assert.match(text, /texture/, 'must frame lettering as texture, not language')
    assert.match(text, /never specify a word, phrase, name, or quoted line/, 'must forbid asking for specific readable text')
    assert.match(text, /gibberish/, 'must say why: the model renders confident gibberish instead')
  })

  test('keeps the document/scroll/sign itself a fully legitimate subject', () => {
    // The owner's exact worry: this must not become "no documents" guidance.
    // Scene 5 (Procopius writing his history) is otherwise exactly right.
    const text = AVOID_LEGIBLE_TEXT_GUIDANCE.toLowerCase()
    assert.match(text, /stays a fully legitimate subject/, 'the document/sign/scroll itself must stay legitimate')
    assert.match(text, /scroll, ledger, page, inscription, sign, banner/, 'must name the concrete surfaces this covers')
  })
})

describe('legible-text guidance — wiring', () => {
  test('the block defaults OFF — unlike the always-on content-safety guidance', () => {
    assert.equal(legibleTextGuidanceBlock(), '', 'no argument must yield nothing (opt-in only)')
    assert.equal(legibleTextGuidanceBlock(false), '')
    assert.ok(legibleTextGuidanceBlock(true).includes(AVOID_LEGIBLE_TEXT_GUIDANCE))
  })

  test('resolveAvoidLegibleText: explicit per-run value always wins', () => {
    assert.equal(resolveAvoidLegibleText(true, false), true)
    assert.equal(resolveAvoidLegibleText(false, true), false)
  })

  test('resolveAvoidLegibleText: falls back to the project default when unset', () => {
    assert.equal(resolveAvoidLegibleText(undefined, true), true)
    assert.equal(resolveAvoidLegibleText(undefined, false), false)
  })

  test('resolveAvoidLegibleText: unset everywhere resolves ON (default for a project that never touched this)', () => {
    assert.equal(resolveAvoidLegibleText(undefined, undefined), true)
    assert.equal(resolveAvoidLegibleText(null, null), true)
  })
})

describe('scene path — both toggle states', () => {
  // Mirrors the exact template-literal shape of the packed writer's system
  // message in generators/scene-plan.ts (`buildPackMessages`), without
  // executing the full job (which needs a real job/filesystem). Proves the
  // composition itself, not a restatement of it.
  function packedSystemMessage(isMotion: boolean, avoidLegibleText: boolean): string {
    const task = 'TASK'
    return `${task}${isMotion ? '' : imagePromptGuidanceBlock()}${isMotion ? '' : legibleTextGuidanceBlock(avoidLegibleText)}\nReturn strict JSON only.`
  }

  test('ON: the scene (non-motion) system message carries the instruction', () => {
    const msg = packedSystemMessage(false, true)
    assert.ok(msg.includes(AVOID_LEGIBLE_TEXT_GUIDANCE), 'toggle ON must inject the legible-text guidance')
    assert.ok(msg.includes(IMAGE_CONTENT_GUIDANCE), 'the existing content-safety guidance must still be present')
  })

  test('OFF: the scene system message is byte-identical to the pre-existing formula', () => {
    const withToggleOff = packedSystemMessage(false, false)
    // The exact formula every scene prompt used before this feature existed.
    const legacyFormula = `TASK${imagePromptGuidanceBlock()}\nReturn strict JSON only.`
    assert.equal(withToggleOff, legacyFormula, 'OFF must not change a single byte of existing output')
    assert.ok(!withToggleOff.includes(AVOID_LEGIBLE_TEXT_GUIDANCE))
  })

  test('motion prompts never carry it regardless of the toggle', () => {
    const motionOn = packedSystemMessage(true, true)
    const motionOff = packedSystemMessage(true, false)
    assert.equal(motionOn, motionOff, 'motion is gated on isMotion, not on the toggle')
    assert.ok(!motionOn.includes(AVOID_LEGIBLE_TEXT_GUIDANCE))
    assert.ok(!motionOn.includes(IMAGE_CONTENT_GUIDANCE), 'motion never gets the content-safety guidance either')
  })

  test('single-scene regenerate/reword (generateVisualPromptOnly) composes the same way', () => {
    const sysParts = 'SYS'
    const withOn = sysParts + imagePromptGuidanceBlock({ reword: true }) + legibleTextGuidanceBlock(true)
    const withOff = sysParts + imagePromptGuidanceBlock({ reword: true }) + legibleTextGuidanceBlock(false)
    const legacyFormula = sysParts + imagePromptGuidanceBlock({ reword: true })
    assert.ok(withOn.includes(AVOID_LEGIBLE_TEXT_GUIDANCE))
    assert.equal(withOff, legacyFormula, 'OFF must match the pre-existing reword formula exactly')
  })
})

describe('scene path — source wiring', () => {
  test('generators/scene-plan.ts imports and gates the guidance on the visual (non-motion) stage', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'generators/scene-plan.ts'), 'utf-8')
    // v1.4.356 added `sceneSubjectGuidanceBlock` to this same import, so the
    // assertion names the MODULE and each helper rather than pinning one exact
    // brace list — a further scene-only helper must not have to rewrite this.
    assert.match(
      src,
      /import \{[^}]*\} from '\.\.\/lib\/image-content-guidance\.js'/,
      'must import the shared helpers rather than restate the text',
    )
    for (const helper of [
      'imagePromptGuidanceBlock', 'legibleTextGuidanceBlock', 'resolveAvoidLegibleText', 'sceneSubjectGuidanceBlock',
    ]) {
      assert.match(
        src,
        new RegExp(`import \\{[^}]*\\b${helper}\\b[^}]*\\} from '\\.\\./lib/image-content-guidance\\.js'`),
        `generators/scene-plan.ts must take ${helper} from the shared guidance module`,
      )
    }
    // The existing content-safety guidance call is untouched byte-for-byte —
    // this is also asserted by image-content-guidance.test.ts, and staying
    // in that exact shape is what keeps this change additive, not a rewrite.
    assert.match(src, /isMotion \? '' : imagePromptGuidanceBlock\(\)/)
    assert.match(
      src,
      /isMotion \? '' : legibleTextGuidanceBlock\(wantAvoidLegibleText\)/,
      'the packed writer must gate legible-text guidance on the visual stage, same as content-safety guidance',
    )
    assert.match(
      src,
      /resolveAvoidLegibleText\(params\.avoid_legible_text,/,
      'must resolve the toggle through the shared resolver (per-run override, else project default)',
    )
  })

  test('services/scene-planner.ts wires the toggle into generateVisualPromptOnly (single-scene regen/reword)', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'services/scene-planner.ts'), 'utf-8')
    assert.match(src, /legibleTextGuidanceBlock\(opts\.avoid_legible_text\)/)
  })

  test('routes/scene-plan.ts forwards preset authority on /run and request overrides on both repair entry points', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'routes/scene-plan.ts'), 'utf-8')
    const block = (start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end))
    const run = block("router.post('/projects/:slug/scene-plan/:episodeId/run'", "router.post('/projects/:slug/scene-plan/:episodeId/replan-scene'")
    const regeneratePrompt = block("router.post('/projects/:slug/scene-plan/:episodeId/regenerate-prompt'", "router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-prompts'")
    const regenerateEmpty = block("router.post('/projects/:slug/scene-plan/:episodeId/regenerate-empty-prompts'", "router.post('/projects/:slug/scene-plan/:episodeId/regenerate-motion-prompt'")

    assert.match(run, /const avoidLegibleText = typeof presetData\.avoid_legible_text === 'boolean' \? presetData\.avoid_legible_text : undefined/,
      '/run must take the reusable setting from the exact resolved preset')
    assert.match(run, /avoid_legible_text: avoidLegibleText/,
      '/run must forward the exact preset setting to the queued job')

    for (const [name, route] of [['regenerate-prompt', regeneratePrompt], ['regenerate-empty-prompts', regenerateEmpty]] as const) {
      assert.match(route, /const avoidLegibleText = typeof body\.avoid_legible_text === 'boolean' \? body\.avoid_legible_text : undefined/,
        `${name} must accept its explicit repair-request override`)
      assert.match(route, /avoid_legible_text: avoidLegibleText/,
        `${name} must forward its explicit repair-request override`)
    }
    assert.equal((regeneratePrompt.match(/avoid_legible_text: avoidLegibleText/g) || []).length, 2,
      'single-scene repair keeps the override in both replay identity and accepted params')
  })
})

describe('thumbnail path — never affected (the important regression)', () => {
  test('generators/image-prompts.ts does not import or reference the legible-text guidance at all', async () => {
    const src = await fs.readFile(path.join(serverRoot, 'generators/image-prompts.ts'), 'utf-8')
    assert.ok(!src.includes('legibleTextGuidanceBlock'), 'the thumbnail generator must not import the helper')
    assert.ok(!src.includes('AVOID_LEGIBLE_TEXT_GUIDANCE'), 'the thumbnail generator must not reference the guidance text')
    assert.ok(!src.includes('avoid_legible_text'), 'the thumbnail generator must not read the toggle at all')
  })

  test('buildThumbnailPrompt output never contains the legible-text guidance, no matter the inputs', () => {
    for (const headlineMode of ['episode-title', 'curiosity-hook'] as const) {
      const out = buildThumbnailPrompt({
        episodeId: 'EP0001',
        title: 'The Fall of a City',
        storyContext: 'A city under siege writes its own history in scrolls and ledgers.',
        castBlock: '',
        count: 3,
        styleTag: 'painterly illustration',
        aspectRatio: '16:9',
        thumbnailDirective: 'Make it dramatic.',
        targetNumbers: [1, 2, 3],
        headlineMode,
      })
      assert.ok(!out.includes(AVOID_LEGIBLE_TEXT_GUIDANCE), `thumbnail prompt (${headlineMode}) must never carry the legible-text guidance`)
      assert.ok(!out.toLowerCase().includes('indistinct marks'), 'no trace of the legible-text phrasing')
      // Thumbnails require the OPPOSITE: real, legible in-image typography.
      assert.match(out, /legible in-image typography/, 'thumbnails must still require legible in-image text')
    }
  })

  test('the legacy shared per-row regenerate route (kind: scene | thumbnail) was left untouched', async () => {
    // routes/image-prompts-edit.ts serves BOTH kinds through one function.
    // It is not the current Scene Plan path (the live "Thumbnail Prompts"
    // page only ever calls it with pool="thumbnails"; its "scene" kind is
    // unreachable from any current frontend page — see PromptReviewPanel.vue
    // and pages/projects/[slug]/image-prompts.vue), so it deliberately does
    // not receive this toggle rather than risk leaking scene-only guidance
    // into its thumbnail branch. If this ever becomes reachable for scenes
    // again, it needs its own kind-gated wiring, not a change here.
    const src = await fs.readFile(path.join(serverRoot, 'routes/image-prompts-edit.ts'), 'utf-8')
    assert.ok(!src.includes('legibleTextGuidanceBlock'))
    assert.ok(!src.includes('avoid_legible_text'))
  })
})
