/**
 * v1.4.348 — the CHARACTER CEILING for thumbnail prompts, and the refusal that
 * follows a prompt that breaks it.
 *
 * WHAT WENT WRONG
 * ---------------
 * Three episodes of one channel had their thumbnail prompts REFUSED by the
 * image model — three times each, with the identical stored bytes. Two causes
 * sat on top of each other:
 *
 *   1. The Pipeline's Thumbnail Prompts step forwarded the preset's SELECTION
 *      ('auto' — follow the selected model) where a NUMBER was expected, so
 *      the writer ran with NO ceiling at all and produced prompts longer than
 *      the model publishes.
 *   2. The published ceiling applies to the FINAL prompt — the stored prompt
 *      plus the aspect-ratio and title clauses the save step appends, plus the
 *      render guidance and the style keywords the render appends. Even a
 *      perfectly compliant body produced an over-length prompt, because
 *      nothing measured the parts that land on top of it.
 *
 * The refusal was a plain Error, so the OUTER job queue read it as a transient
 * gap and ran the whole batch three times over — three identical attempts,
 * 60 s and 300 s apart, learning nothing each time.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   - The accounting is EXACT: the characters the final assembly adds are
 *     measured from the very text that gets appended, and the writer is given
 *     the published ceiling MINUS them. No reserve constant, no truncation,
 *     no hardcoded ceiling.
 *   - The ceiling is the PUBLISHED one, read live, so it follows the model the
 *     customer selected.
 *   - A prompt that breaks the ceiling is refused BEFORE anything is
 *     submitted, so nothing is charged, and the refusal is TYPED so the outer
 *     queue does not make three identical attempts.
 *   - The eight missing targets (EP0016 1/2/3, EP0017 1/2/3, EP0022 1/3) are
 *     refused deterministically, and EP0022's Thumbnail 02 — the one that was
 *     already produced — is KEPT.
 *   - A targeted re-render is NOT preserved by `force: false` — it is
 *     attempted, and when it fails it is not reported as this run's output.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'

import {
  addAssemblyOverhead,
  assertPromptWithinCap,
  measureAssemblyOverhead,
  parsePromptCharCap,
  promptBodyCeiling,
  PromptAssemblyTooLargeError,
  PromptLengthExceededError,
} from '../services/prompt-char-cap.js'
import { isNonRetryableError } from '../services/job-retry-policy.js'
import { resolveLiveImagePromptCharCap } from '../services/image-prompt-cap.js'
import { waitForValue } from './_timing.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
// Register the provider before exercising the real render executor.
import '../providers/image/genstudio.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const imagesGenerator = source('../generators/images.ts')
const imagePromptsGenerator = source('../generators/image-prompts.ts')
const pipelineRoute = source('../routes/pipeline.ts')
const presetAuthority = source('../services/preset-authority.ts')

/** A 1×1 PNG — enough for "a file with content on disk". */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let cleanup: () => Promise<void>

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
})

after(async () => { await cleanup() })

// ── The exact accounting ─────────────────────────────────────────────────────

describe('the final assembly is measured exactly', () => {
  test('the characters the render adds are the characters the prompt gains', async () => {
    const { assembleThumbnailRenderPrompt, thumbnailRenderAssemblyOverhead } = await import('../generators/images.js')
    const stored = 'A sealed letter by lamplight, the wax still warm.'
    const assembly = {
      extraDetails: 'Keep the frame centred and the lamp on the left third.',
      referenceGuidance: 'Reference-guided generation: use the supplied reference only for broad composition.',
      styleKeywords: ['cel-shaded', 'grainy film'],
    }
    const assembled = assembleThumbnailRenderPrompt(stored, assembly)
    const overhead = thumbnailRenderAssemblyOverhead(assembly)
    // EXACT: no rounding, no reserve, no constant.
    assert.equal(assembled.length - stored.length, overhead.characters)
    // And the pieces are named, so a report can say WHICH piece was too long.
    assert.deepEqual(overhead.parts.map(part => part.label), ['render guidance', 'style keywords'])
    assert.equal(
      overhead.parts.reduce((sum, part) => sum + part.characters, 0),
      overhead.characters,
    )
  })

  test('an assembly that appends nothing measures nothing', async () => {
    const { assembleThumbnailRenderPrompt, thumbnailRenderAssemblyOverhead } = await import('../generators/images.js')
    const stored = 'A sealed letter by lamplight.'
    const assembly = { extraDetails: '', referenceGuidance: '', styleKeywords: [] }
    assert.equal(assembleThumbnailRenderPrompt(stored, assembly), stored)
    assert.equal(thumbnailRenderAssemblyOverhead(assembly).characters, 0)
  })

  test('the style-keyword clause is the same clause the render appends', async () => {
    const { assembleThumbnailRenderPrompt, styleKeywordClause, thumbnailRenderAssemblyOverhead } = await import('../generators/images.js')
    const stored = 'A queen at dusk'
    const keywords = ['cel-shaded', 'grainy film']
    const assembled = assembleThumbnailRenderPrompt(stored, { styleKeywords: keywords })
    assert.ok(assembled.endsWith(styleKeywordClause(keywords)), assembled)
    assert.equal(
      thumbnailRenderAssemblyOverhead({ styleKeywords: keywords }).characters,
      styleKeywordClause(keywords).length,
    )
  })

  test('the save step measures exactly what it appends', async () => {
    const { enforceThumbnailPromptElements, thumbnailPromptClauses, thumbnailSaveOverhead } = await import('../generators/image-prompts.js')
    const opts = {
      aspectRatio: '16:9',
      title: 'The Hidden System',
      headlineMode: 'episode-title',
    }
    const body = 'A sealed letter by lamplight, the wax still warm.'
    // The body states neither the ratio nor the title, so BOTH clauses apply:
    // the measured overhead and the saved text must agree exactly.
    assert.equal(thumbnailPromptClauses(body, opts).length, 2)
    const saved = enforceThumbnailPromptElements(body, opts)
    const overhead = thumbnailSaveOverhead(opts)
    assert.equal(saved.length - body.length, overhead.characters)
    assert.ok(saved.startsWith(body))
    // The overhead is a MEASUREMENT of clause texts, never a reserved constant.
    assert.match(overhead.parts[0]!.label, /clauses/)
    assert.ok(overhead.characters > 0)
  })

  test('a body that already states the title saves less than the measured maximum', async () => {
    const { enforceThumbnailPromptElements, thumbnailSaveOverhead } = await import('../generators/image-prompts.js')
    const opts = { aspectRatio: '16:9', title: 'The Hidden System', headlineMode: 'episode-title' }
    const body = 'A sealed letter by lamplight reading The Hidden System.'
    const saved = enforceThumbnailPromptElements(body, opts)
    const overhead = thumbnailSaveOverhead(opts)
    assert.ok(saved.length - body.length <= overhead.characters,
      'the reservation is the maximum; the applied saving is never larger')
  })

  test('the body ceiling is the published ceiling minus the measured assembly', () => {
    const overhead = measureAssemblyOverhead([{ label: 'render guidance', text: 'x'.repeat(300) }])
    assert.equal(promptBodyCeiling(4_800, overhead), 4_500)
    assert.equal(promptBodyCeiling(undefined, overhead), undefined,
      'an unpublished ceiling is not a number, and none is invented')
    assert.equal(promptBodyCeiling(4_800, { characters: 0, parts: [] }), 4_800)
  })

  test('a ceiling the assembly alone exceeds is REFUSED, not handed a one-character body', () => {
    // `Math.max(1, cap - overhead)` would hand the writer a body of ONE
    // character and call it a budget. That is a guess at what still fits, and
    // the model refuses the result anyway — so it is refused LOUDLY here,
    // with the published ceiling and the measured overhead.
    let thrown: any
    try {
      promptBodyCeiling(10, { characters: 9_999, parts: [] })
    } catch (error) { thrown = error }
    assert.ok(thrown instanceof PromptAssemblyTooLargeError, 'the refusal is typed')
    assert.equal(thrown.retryable, false, 'the same settings fail the same way every time')
    assert.equal(thrown.cap, 10, 'the refusal names the published ceiling')
    assert.equal(thrown.overhead, 9_999, 'the refusal names the measured overhead')
    assert.match(thrown.message, /10 prompt characters/)
    assert.match(thrown.message, /9,999/)
    assert.match(thrown.message, /no prompt was written/i)
    // And the queue never asks again about it.
    assert.equal(isNonRetryableError(thrown), true)
  })

  test('an assembly that exactly fills the ceiling still leaves no room for a body', () => {
    assert.throws(() => promptBodyCeiling(100, { characters: 100, parts: [] }), PromptAssemblyTooLargeError)
    // One character of room is enough for a body.
    assert.equal(promptBodyCeiling(101, { characters: 100, parts: [] }), 1)
  })

  test('two overheads spend against the same ceiling', () => {
    const save = measureAssemblyOverhead([{ label: 'clauses', text: 'a'.repeat(100) }])
    const render = measureAssemblyOverhead([{ label: 'style keywords', text: ', b'.repeat(50) }])
    const total = addAssemblyOverhead(save, render)
    assert.equal(total.characters, save.characters + render.characters)
    assert.equal(total.parts.length, 2)
  })
})

// ── The deterministic refusal ────────────────────────────────────────────────

describe('a prompt over the published ceiling is refused deterministically', () => {
  test('the refusal names the model, the ceiling, the length and the cost', () => {
    let thrown: any
    try {
      assertPromptWithinCap('x'.repeat(5_000), 4_800, {
        modelLabel: 'Mock Fleet Image',
        what: 'the assembled thumbnail prompt for Thumbnail 1',
      })
    } catch (error) { thrown = error }
    assert.ok(thrown instanceof PromptLengthExceededError, 'the refusal is typed')
    assert.equal(thrown.retryable, false, 'the same bytes fail the same way every time')
    assert.equal(thrown.cap, 4_800)
    assert.equal(thrown.characters, 5_000)
    assert.equal(thrown.overage, 200)
    assert.match(thrown.message, /Mock Fleet Image accepts up to 4,800 prompt characters/)
    assert.match(thrown.message, /assembled thumbnail prompt for Thumbnail 1/)
    // The wording is scoped to THIS prompt: a batch that refused one item says
    // nothing about the others, and nothing is claimed to be free.
    assert.match(thrown.message, /No request was made for this prompt, and no credits were charged for it\./)
    assert.doesNotMatch(thrown.message, /No request or credit charge was made/)
  })

  test('no published ceiling means no local check at all', () => {
    assert.doesNotThrow(() => assertPromptWithinCap('x'.repeat(50_000), undefined, {
      modelLabel: 'Mock Fleet Image', what: 'the assembled thumbnail prompt',
    }))
  })

  test('a prompt exactly on the ceiling is inside it', () => {
    assert.doesNotThrow(() => assertPromptWithinCap('x'.repeat(4_800), 4_800, {
      modelLabel: 'Mock Fleet Image', what: 'the assembled thumbnail prompt',
    }))
  })

  test('the ceiling is the PUBLISHED one, so it follows the selected model', () => {
    const prompt = 'x'.repeat(3_300)
    // A model publishing 3,200 refuses this prompt; one publishing 4,800 does not.
    assert.throws(() => assertPromptWithinCap(prompt, 3_200, {
      modelLabel: 'A Model With A Smaller Ceiling', what: 'the assembled thumbnail prompt',
    }))
    assert.doesNotThrow(() => assertPromptWithinCap(prompt, 4_800, {
      modelLabel: 'A Model With A Larger Ceiling', what: 'the assembled thumbnail prompt',
    }))
    // Nothing in the app hardcodes a ceiling: the number only ever arrives as
    // an argument, read from the live catalogue.
    for (const file of [imagesGenerator, imagePromptsGenerator, pipelineRoute, presetAuthority]) {
      assert.doesNotMatch(file, /max_prompt_characters\s*[:=]\s*\d/, 'no literal ceiling is written anywhere')
    }
    assert.equal(parsePromptCharCap('auto'), undefined, "'auto' is a selection, not a number")
  })
})

// ── The live cap resolver rejects malformed selections ────────────────────────

describe('the live cap resolver refuses malformed selections', () => {
  test('a boolean is refused rather than coerced to a ceiling', async () => {
    const result = await resolveLiveImagePromptCharCap({
      setting: true,
      label: 'The test selection',
      nothingHappened: 'Nothing was resolved.',
    })
    assert.ok(result.error, 'true is not a valid selection')
    assert.match(result.error, /must be "auto", "none", or a whole number/)
    assert.equal(result.cap, undefined)
  })

  test('an array is refused rather than coerced to a ceiling', async () => {
    const result = await resolveLiveImagePromptCharCap({
      setting: [5000],
      label: 'The test selection',
      nothingHappened: 'Nothing was resolved.',
    })
    assert.ok(result.error, '[5000] is not a valid selection')
    assert.match(result.error, /must be "auto", "none", or a whole number/)
    assert.equal(result.cap, undefined)
  })

  test('an object is refused rather than coerced to a ceiling', async () => {
    const result = await resolveLiveImagePromptCharCap({
      setting: { cap: 5000 },
      label: 'The test selection',
      nothingHappened: 'Nothing was resolved.',
    })
    assert.ok(result.error, '{} is not a valid selection')
    assert.match(result.error, /must be "auto", "none", or a whole number/)
    assert.equal(result.cap, undefined)
  })

  test('a numeric string is accepted for legacy preset compatibility', async () => {
    // Pipeline admission uses parsePromptCharCap which accepts numeric strings;
    // the executor must agree or it would kill jobs the Pipeline admitted.
    const result = await resolveLiveImagePromptCharCap({
      setting: '5000',
      label: 'The test selection',
      nothingHappened: 'Nothing was resolved.',
    })
    assert.equal(result.error, undefined, 'numeric string is a valid selection')
    assert.equal(result.cap, 5000)
  })

  test('auto with no intended model means no ceiling is in force', async () => {
    // When no image model is named, the customer's 'auto' choice has nothing
    // to follow. No catalogue lookup happens, and no ceiling is invented.
    const resultNoModel = await resolveLiveImagePromptCharCap({
      setting: 'auto',
      label: 'The test selection',
      nothingHappened: 'Nothing was resolved.',
    })
    assert.equal(resultNoModel.error, undefined, 'auto with no model means no ceiling')
    assert.equal(resultNoModel.cap, undefined, 'no ceiling is invented')
  })

  test('auto with a selected valid model that publishes no cap means no ceiling is in force', async () => {
    // A model that publishes no max_prompt_characters does not invent one.
    // The customer's 'auto' choice means "follow the model", and a model with
    // no published limit means no limit is in force.
    await withMockGateway(0, async () => {
      const result = await resolveLiveImagePromptCharCap({
        setting: 'auto',
        intendedImageModel: FREE_MODEL,
        label: 'The test selection',
        nothingHappened: 'Nothing was resolved.',
      })
      assert.equal(result.error, undefined, 'auto with a valid model publishing no cap means no ceiling')
      assert.equal(result.cap, undefined, 'no ceiling is invented')
    })
  })
})

// ── The queue must not ask again ────────────────────────────────────────────

describe('the refusal is never retried in place', () => {
  test('the typed refusal is non-retryable at the queue boundary', () => {
    const refusal = new PromptLengthExceededError({
      modelLabel: 'Mock Fleet Image', cap: 4_800, characters: 5_000, overage: 200,
    })
    assert.equal(isNonRetryableError(refusal), true)
  })

  test('the AGGREGATE completion error keeps the classification', async () => {
    // The queue classifies the error the generator throws, and that error is
    // the aggregate "0/3 required items verified" — the refusal's own wording
    // is gone by then. Without the typed marking, the queue reads it as a
    // transient gap and runs the batch three times.
    const { requireJobCompletion } = await import('../services/job-completion.js')
    const { nonRetryable } = await import('../services/job-retry-policy.js')
    const job: any = { job_id: 'j', output_lines: [] }
    let aggregate: any
    try {
      requireJobCompletion(job, {
        label: 'Thumbnail generation', expected: 3, completed: 0, missing: ['Thumbnail 1', 'Thumbnail 2', 'Thumbnail 3'],
      })
    } catch (error) { aggregate = error }
    assert.ok(aggregate instanceof Error)
    assert.match(aggregate.message, /0\/3 required item\(s\) verified/)
    // An unmarked aggregate is NOT classified — which is exactly why the
    // generator marks it when it knows a deterministic refusal happened.
    assert.equal(isNonRetryableError(aggregate), false)
    assert.equal(isNonRetryableError(nonRetryable(aggregate)), true)
  })

  test('an ordinary provider failure still retries', () => {
    assert.equal(isNonRetryableError(new Error('Gateway timed out')), false)
  })
})

// ── The source wiring ───────────────────────────────────────────────────────

describe('the ceiling is wired where it belongs', () => {
  test('the render measures the ASSEMBLED prompt, not the stored one', () => {
    // 1.4.405 — the assembly takes the copy the MODEL receives: `thumb.prompt` when branded
    // typography is off (byte-identical), the same prompt minus its drawing directive when it is on.
    assert.match(imagesGenerator, /const promptForModel = brandingOn \? stripTitleTextDirective\(thumb\.prompt\) : thumb\.prompt/)
    assert.match(imagesGenerator, /const finalPrompt = assembleThumbnailRenderPrompt\(promptForModel, \{/)
    assert.match(imagesGenerator, /assertPromptWithinCap\(finalPrompt, resolvedModelConfig\.prompt_char_cap, \{/)
    // The scene path measures the same way.
    assert.equal(imagesGenerator.match(/assertPromptWithinCap\(finalPrompt, resolvedModelConfig\.prompt_char_cap/g)?.length, 2)
  })

  test('the writer is given the ceiling MINUS the measured assembly', () => {
    assert.match(imagePromptsGenerator, /const bodyCeiling = promptBodyCeiling\(publishedCap, assemblyOverhead\)/)
    assert.match(imagePromptsGenerator, /const assemblyOverhead = addAssemblyOverhead\(/)
    assert.match(imagePromptsGenerator, /promptCharCap: bodyCeiling,/)
    // The advisory measures the assembled prompt too, so the report and the
    // boundary describe the same text.
    assert.match(imagePromptsGenerator, /text: assembleThumbnailRenderPrompt\(String\(item\.prompt \|\| ''\), \{/)
  })

  test('the Pipeline resolves the THUMBNAIL ceiling live, like the scene one', () => {
    // The admission check uses the SAME live resolver the executor uses, so
    // malformed shapes are refused preflight and no job is enqueued.
    assert.match(pipelineRoute, /const capRefusal = await resolveLiveImagePromptCharCap\(\{/)
    assert.match(pipelineRoute, /intendedImageModel: thumbnailCapInputs\.intended_image_model,/)
    assert.match(pipelineRoute, /setting: thumbnailCapInputs\.prompt_char_cap,/)
    assert.doesNotMatch(pipelineRoute, /resolveScenePlanPromptCharCap\(\s*thumbnailCapInputs,/,
      'Pipeline thumbnail admission must use the live cap resolver, not the scene plan resolver')
    // The JOB carries the SELECTION and the model it was chosen for; the
    // executor resolves the ceiling when the job runs, so the ceiling follows
    // the catalogue and the model — on this run and on every retry.
    assert.match(pipelineRoute, /if \(step === 'image_prompts'\) \{[\s\S]{0,240}params\.prompt_char_cap = thumbnailCapInputs\.prompt_char_cap[\s\S]{0,160}params\.intended_image_model = thumbnailCapInputs\.intended_image_model/)
    assert.doesNotMatch(pipelineRoute, /params\.prompt_char_cap = pipelineThumbnailPromptCap/,
      'a number resolved at admission must not be frozen into the job')
    // The thumbnail preset keeps its settings under `form`, the scene preset at
    // the top level: the reader knows both shapes and reads only the two
    // fields the ceiling needs.
    assert.match(presetAuthority, /export function thumbnailPromptPresetCapInputs/)
  })

  test('the executor resolves the ceiling when the job runs, not before it was queued', () => {
    assert.match(imagePromptsGenerator, /const publishedCap = await requireLiveImagePromptCharCap\(\{/)
    assert.match(imagePromptsGenerator, /intendedImageModel: req\.intended_image_model,/)
    assert.match(imagePromptsGenerator, /setting: req\.prompt_char_cap,/)
    // A refusal is TYPED, so the queue refuses to burn three attempts on it.
    assert.match(imagePromptsGenerator, /requireLiveImagePromptCharCap/)
  })

  test('nothing shortens a prompt to fit a ceiling', () => {
    assert.doesNotMatch(imagePromptsGenerator, /\.slice\(0, *publishedCap/)
    assert.doesNotMatch(imagePromptsGenerator, /substring\(0, *publishedCap/)
    assert.doesNotMatch(imagesGenerator, /\.slice\(0, *prompt_char_cap/)
  })
})

// ── The retired intended model, and the single-row regeneration ─────────────

describe('a configuration that cannot work is refused before anything is started', () => {
  test('the Pipeline FAILS CLOSED when the thumbnail preset names a retired model', () => {
    // The Scene Plan step already refuses a retired intended image model
    // before anything is started. The Thumbnail Prompts step now does the
    // same: continuing would write prompts with NO ceiling for a model that
    // does not exist, and the run would only fail later — at render time,
    // with credits already spent. No fallback model, no fallback number.
    assert.match(pipelineRoute, /const capRefusal = await resolveLiveImagePromptCharCap\(\{/)
    assert.match(pipelineRoute, /label: 'The Thumbnail Prompts preset',/)
    assert.match(pipelineRoute, /if \(capRefusal\.error\) \{[\s\S]{0,200}res\.status\(400\)/,
      'a refusal from the live resolver returns 400 with the detail')
  })

  test('the single-row regeneration reserves the clauses the save step appends', () => {
    const route = source('../routes/image-prompts-edit.ts')
    // The reserve is measured with the SAME helper the save step uses, over
    // the SAME options the row is saved with.
    assert.match(route, /thumbnailSaveOverhead\(elementOptions\)/)
    assert.match(route, /const assemblyOverhead = addAssemblyOverhead\(/)
    assert.match(route, /bodyCeiling = promptBodyCeiling\(publishedCap, assemblyOverhead\)/)
    // The catalogue's lettering phrases go into BOTH the clause text and the
    // reserve, so the clause the row receives is the clause that was measured.
    assert.match(route, /fontPhrases: letteringPhrases\.font,/)
    assert.match(route, /textPhrases: letteringPhrases\.text,/)
    // And the render's own extras are reserved too, not just the save clauses.
    assert.match(route, /thumbnailRenderAssemblyOverhead\(\{/)
    assert.match(route, /styleKeywords: castStyleKeywordBound\(cast\),/)
    assert.match(route, /referenceGuidance,/)
  })

  test('a reserve that does not fit is refused, and the writer is given no budget', () => {
    const route = source('../routes/image-prompts-edit.ts')
    assert.match(route, /if \(error instanceof PromptAssemblyTooLargeError\) \{[\s\S]{0,160}res\.status\(400\)/)
    // And the ceiling the writer receives is the BODY ceiling, never the
    // published one — that is the whole point of the reserve.
    assert.match(route, /promptCharCap: bodyCeiling,/)
    assert.doesNotMatch(route, /promptCharCap: parsePromptCharCap\(req\.body\.prompt_char_cap\)/)
  })
})

// ── The render, end to end, against the mock Gateway ────────────────────────

const FREE_MODEL = 'studio-hub::mock-image-v1'

/** The catalogue row the mock Gateway publishes. The ceiling is a parameter so
 *  a test can prove the refusal follows the PUBLISHED number. */
function freeCatalogRow(maxPromptCharacters: number) {
  return {
    id: FREE_MODEL, display_name: 'Mock Fleet Image', description: 'In-process PNG fixture.',
    available: true, qualification_only: false, chargeable: false,
    aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', default_resolution: '1K',
    output_options: [{ resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: true, credits_per_image: 0, price_version: 'free' }],
    max_prompt_characters: maxPromptCharacters, prompt_token_allowance: 1200,
    min_reference_images: 0, max_reference_images: 0,
  }
}

interface EpisodeFixture {
  episodeId: string
  thumbDir: string
  promptPath: string
}

/** One episode with a thumbnail prompt file, optionally with thumbnails that
 *  are already rendered on disk (the "kept" case). */
async function makeEpisode(
  projectSlug: string,
  options: { code: string; prompts: string[]; alreadyRendered?: number[] },
): Promise<EpisodeFixture> {
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const { toMdPath } = await import('../lib/episode-artifacts.js')
  const { writePromptCompletionManifest } = await import('../services/prompt-completion.js')
  const { resolveImageDirs } = await import('../generators/images.js')

  const [idea] = await ideas.addIdeas(projectSlug, [{
    title: `The Hidden System (${options.code})`,
    logline: 'Fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  const episodeId = (await ideas.acceptIdea(projectSlug, idea!.id, false, { override_code: options.code })).episode_code
  const paths = await resolveEpisodePathsByCode(projectSlug, episodeId)
  const promptPath = toMdPath(paths.thumb_prompts_docx)
  await fs.mkdir(path.dirname(promptPath), { recursive: true })
  const lines = ['# Thumbnail Prompts', '']
  options.prompts.forEach((prompt, index) => {
    lines.push(`## Thumbnail ${index + 1}: Variant ${index + 1}`, '', prompt, '')
  })
  await fs.writeFile(promptPath, lines.join('\n'))
  await writePromptCompletionManifest(path.dirname(promptPath), episodeId, 'thumbnail', options.prompts.length)
  const { thumbDir } = await resolveImageDirs(projectSlug, promptPath, episodeId)
  await fs.mkdir(thumbDir, { recursive: true })
  for (const number of options.alreadyRendered || []) {
    const name = `${episodeId.toUpperCase()}_Thumb${String(number).padStart(2, '0')}_v1.png`
    await fs.writeFile(path.join(thumbDir, name), ONE_PIXEL_PNG)
  }
  return { episodeId, thumbDir, promptPath }
}

let jobCounter = 0

function thumbJob(params: Record<string, unknown>): any {
  const now = new Date().toISOString()
  jobCounter += 1
  return {
    job_id: `thumb-ceiling-${jobCounter}`,
    project_slug: '', type: 'thumb_images', episode_id: '', title: 'Thumbnails',
    status: 'running', created_at: now, started_at: now, finished_at: null,
    local_execution_complete: false, error: null, output_lines: [],
    params,
  }
}

/** The mock Gateway, the catalogue it publishes, and the project's key. */
async function withMockGateway(
  publishedCeiling: number,
  body: (context: { service: Awaited<ReturnType<typeof startMockGenStudioService>> }) => Promise<void>,
  catalogueOverrides: Record<string, unknown> = {},
): Promise<void> {
  const service = await startMockGenStudioService()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input: any, init: any) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([{ ...freeCatalogRow(publishedCeiling), ...catalogueOverrides }])
      return originalFetch(input, init)
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    await body({ service })
  } finally {
    globalThis.fetch = originalFetch
    await service.close()
  }
}

describe('Shell rendering follows live reference support', () => {
  for (const supported of [false, true]) {
    test(`saved layout reaches the provider with reference support ${supported}`, async () => {
      await withMockGateway(10_000, async ({ service }) => {
        const pm = await import('../services/project-manager.js')
        const { generateImages } = await import('../generators/images.js')
        const project = await pm.createProject({ name: `Shell dispatch ${supported}`, episode_prefix: 'EP', episode_digits: 4 })
        const referenceDir = path.join(pm.getProjectDir(project.slug)!, 'thumbnail-reference-assets')
        await fs.mkdir(referenceDir, { recursive: true })
        await fs.writeFile(path.join(referenceDir, 'shell.png'), ONE_PIXEL_PNG)
        const fixture = await makeEpisode(project.slug, { code: 'EP0001', prompts: ['A new episode subject with generous clear space.'] })
        const job = thumbJob({
          episode_id: fixture.episodeId, mode: 'thumbs', model: FREE_MODEL,
          aspect_ratio: '16:9', resolution: '1K',
          thumbnail_shell_id: `channel-reference:${project.slug}`,
          thumbnail_reference_asset: { id: 'shell', filename: 'shell.png', reframing_prompt: 'Leave the left third empty; place the focal shape on the right.' },
        })
        job.project_slug = project.slug
        job.episode_id = fixture.episodeId
        await generateImages(job)
        const submissions = service.submissions.filter(item => item.operation === 'image' && !item.replay)
        assert.equal(submissions.length, 1, 'one original image submission')
        assert.match(String(submissions[0]!.parsedBody?.prompt), /Leave the left third empty/)
        const body = submissions[0]!.parsedBody!
        const sources = body.reference_asset_ids
        assert.equal(Boolean(Array.isArray(sources) ? sources.length : sources), supported, JSON.stringify(body))
        if (!supported) assert.match(job.output_lines.join('\n'), /written layout only; no Shell image will be sent/)
      }, { supports_reference_images: supported, max_reference_images: supported ? 1 : 0 })
    })
  }
})

describe('the render refuses an over-length prompt before anything is submitted', () => {
  test('the eight missing targets are refused and the finished one is kept', async () => {
    const PUBLISHED = 3_200
    await withMockGateway(PUBLISHED, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const { generateImages } = await import('../generators/images.js')
      const project = await pm.createProject({ name: 'Ceiling Episodes', episode_prefix: 'EP', episode_digits: 4 })

      // The over-length stored prompt: longer than the ceiling the model
      // publishes, which the app only ever learns from the catalogue.
      const long = 'A'.repeat(PUBLISHED + 400)

      // EP0016 and EP0017: all three thumbnails missing — every one refused,
      // deterministically, with nothing submitted.
      for (const code of ['EP0016', 'EP0017']) {
        const fixture = await makeEpisode(project.slug, { code, prompts: [long, long, long] })
        const job = thumbJob({
          episode_id: fixture.episodeId, mode: 'thumbs', model: FREE_MODEL,
          aspect_ratio: '16:9', resolution: '1K',
          intended_image_model: FREE_MODEL, prompt_char_cap: 'auto',
        })
        job.project_slug = project.slug
        job.episode_id = fixture.episodeId
        let thrown: any
        try { await generateImages(job) } catch (error) { thrown = error }
        const log = job.output_lines.join('\n')
        assert.ok(thrown, `${code}: the batch fails loudly`)
        assert.match(log, /assembled thumbnail prompt for Thumbnail 1/, code)
        assert.match(log, /assembled thumbnail prompt for Thumbnail 3/, code)
        assert.match(log, /3,200/, `${code}: the refusal names the published ceiling`)
        assert.equal(service.providerSubmissionCount('image'), 0, `${code}: nothing submitted, nothing charged`)
      }

      // EP0022: Thumbnail 02 was already produced and is KEPT; 01 and 03 are
      // refused. The kept file survives the failed run.
      const kept = await makeEpisode(project.slug, { code: 'EP0022', prompts: [long, long, long], alreadyRendered: [2] })
      const keptJob = thumbJob({
        episode_id: kept.episodeId, mode: 'thumbs', model: FREE_MODEL,
        aspect_ratio: '16:9', resolution: '1K',
        intended_image_model: FREE_MODEL, prompt_char_cap: 'auto',
      })
      keptJob.project_slug = project.slug
      keptJob.episode_id = kept.episodeId
      let keptError: any
      try { await generateImages(keptJob) } catch (error) { keptError = error }
      const keptLog = keptJob.output_lines.join('\n')
      assert.ok(keptError, 'the missing targets still fail the job')
      assert.match(keptLog, /Skipping .*Thumb02 \(exists\)/, 'the finished thumbnail is kept, not re-rendered')
      assert.match(keptLog, /assembled thumbnail prompt for Thumbnail 1/)
      assert.match(keptLog, /assembled thumbnail prompt for Thumbnail 3/)
      assert.doesNotMatch(keptLog, /assembled thumbnail prompt for Thumbnail 2/, 'the kept thumbnail was never refused')
      await fs.access(path.join(kept.thumbDir, `${kept.episodeId.toUpperCase()}_Thumb02_v1.png`))
      assert.equal(service.providerSubmissionCount('image'), 0)
    })
  })

  test('a targeted thumbnail is attempted even with force false, and its refusal is not a success', async () => {
    const PUBLISHED = 3_200
    await withMockGateway(PUBLISHED, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const { generateImages } = await import('../generators/images.js')
      const project = await pm.createProject({ name: 'Targeted Thumbnail', episode_prefix: 'EP', episode_digits: 4 })
      const fixture = await makeEpisode(project.slug, {
        code: 'EP0023',
        prompts: ['A'.repeat(PUBLISHED + 400)],
        alreadyRendered: [1],
      })
      const job = thumbJob({
        episode_id: fixture.episodeId, mode: 'thumbs', model: FREE_MODEL,
        aspect_ratio: '16:9', resolution: '1K',
        thumb_number: 1, force: false,
        intended_image_model: FREE_MODEL, prompt_char_cap: 'auto',
      })
      job.project_slug = project.slug
      job.episode_id = fixture.episodeId
      let thrown: any
      try { await generateImages(job) } catch (error) { thrown = error }
      const log = job.output_lines.join('\n')
      // `force: false` does NOT preserve a TARGETED thumbnail: the render is
      // attempted. The preserve predicate is
      //   paidArtifactIsDecodable || (!req.thumb_number && !force && !submitPermission)
      // — the `!req.thumb_number` clause is what keeps a batch's finished
      // thumbnail, and it is false here.
      assert.doesNotMatch(log, /Skipping .*Thumb01 \(exists\)/, 'a targeted thumbnail is re-rendered, not silently kept')
      assert.match(log, /assembled thumbnail prompt for Thumbnail 1/)
      // And the refusal is not dressed up as this run's output: the item is
      // missing even though the earlier file is still on disk.
      assert.ok(thrown, 'the refused targeted render fails the job')
      assert.match(thrown.message, /Thumbnail generation incomplete/)
      assert.match(thrown.message, /Thumbnail 1/)
      assert.equal(service.providerSubmissionCount('image'), 0)
    })
  })

  test('the ASSEMBLED prompt is measured, not the stored one', async () => {
    const PUBLISHED = 3_200
    await withMockGateway(PUBLISHED, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const { generateImages } = await import('../generators/images.js')
      const project = await pm.createProject({ name: 'Assembled Measurement', episode_prefix: 'EP', episode_digits: 4 })
      // The STORED prompt fits the published ceiling...
      const stored = 'A'.repeat(PUBLISHED - 100)
      const fixture = await makeEpisode(project.slug, { code: 'EP0024', prompts: [stored] })
      // ...and the render's own guidance pushes the ASSEMBLED prompt over it.
      const job = thumbJob({
        episode_id: fixture.episodeId, mode: 'thumbs', model: FREE_MODEL,
        aspect_ratio: '16:9', resolution: '1K',
        extra_details: 'B'.repeat(300),
        intended_image_model: FREE_MODEL, prompt_char_cap: 'auto',
      })
      job.project_slug = project.slug
      job.episode_id = fixture.episodeId
      let thrown: any
      try { await generateImages(job) } catch (error) { thrown = error }
      const log = job.output_lines.join('\n')
      assert.ok(thrown)
      assert.match(log, /assembled thumbnail prompt for Thumbnail 1/)
      assert.equal(service.providerSubmissionCount('image'), 0)
    })
  })
})

// ── The OUTER job-queue auto-retry ──────────────────────────────────────────

describe('the outer job queue does not make three identical attempts', () => {
  test('a length refusal settles the job after ONE attempt', async () => {
    const PUBLISHED = 3_200
    await withMockGateway(PUBLISHED, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const jq = await import('../services/job-queue.js')
      const { generateImages } = await import('../generators/images.js')
      const project = await pm.createProject({ name: 'Outer Retry', episode_prefix: 'EP', episode_digits: 4 })
      const fixture = await makeEpisode(project.slug, { code: 'EP0025', prompts: ['A'.repeat(PUBLISHED + 400)] })

      // The production executor, wrapped so the attempts can be counted.
      let attempts = 0
      jq.registerExecutor('thumb_images', async (job: any) => {
        attempts++
        await generateImages(job)
      })

      const queued = jq.enqueuePreparedForTest({
        project_slug: project.slug, type: 'thumb_images', episode_id: fixture.episodeId,
        title: 'Thumbnails',
        params: {
          episode_id: fixture.episodeId, mode: 'thumbs', model: FREE_MODEL,
          aspect_ratio: '16:9', resolution: '1K',
          intended_image_model: FREE_MODEL, prompt_char_cap: 'auto',
        },
      })
      // Wait for the job to SETTLE, not for a fixed period: the claim under
      // test is what the QUEUE did, and a fixed sleep would be asserting that
      // this machine scheduled the queue promptly. The wait carries a budget
      // of scheduled time, so a busy machine stretches it instead of failing.
      //
      // A broken classification would send the job into its retry schedule
      // (60 s, then 300 s) and it would not settle inside that budget — which
      // is a failure, and the right one: three identical attempts are exactly
      // what must not happen.
      const settled = await waitForValue(() => {
        const job = jq.getJob(queued.job_id)
        if (!job) return undefined
        return job.status === 'error' || job.status === 'done' ? job : undefined
      }, { label: 'the thumbnail job to settle' })
      assert.equal(settled.status, 'error')
      assert.equal(attempts, 1, 'one attempt, not three identical ones')
      assert.match(settled.output_lines.join('\n'), /Automatic retry skipped/)
      assert.equal(service.providerSubmissionCount('image'), 0, 'nothing was submitted, so nothing was charged')
      await jq._waitForJobPersistenceForTesting()
    })
  })
})

// ── The free measurement endpoint ────────────────────────────────────────────

/**
 * The Image Prompts page asks the server how long each thumbnail prompt will
 * be, so it can place the prompt against the model's published ceiling BEFORE
 * a render is queued.
 *
 * The endpoint is free and local: it reads the prompt file, assembles the
 * prompt with the SAME helpers the render uses, and returns counts. It must
 * measure the prompt the render SUBMITS — a different file, a different
 * parser or a second copy of the assembly would describe a prompt the render
 * never sends, and the page would then refuse a healthy render.
 */
describe('the length endpoint measures the prompt the render submits', () => {
  test('the counts are the assembled lengths, and nothing is submitted', async () => {
    await withMockGateway(3_200, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const { parseImagePromptsDocx } = await import('../lib/docx-parser.js')
      const { assembleThumbnailRenderPrompt, matchedStyleKeywords } = await import('../generators/images.js')
      const { episodeCast } = await import('../generators/image-prompts.js')
      const { promptCharacterCount } = await import('../services/prompt-char-cap.js')
      const { router } = await import('../routes/image-prompts-edit.js')

      const project = await pm.createProject({ name: 'Length Endpoint', episode_prefix: 'EP', episode_digits: 4 })
      const stored = 'A sealed letter by lamplight, the wax still warm.'
      const fixture = await makeEpisode(project.slug, { code: 'EP0031', prompts: [stored, stored] })

      const app = express()
      app.use(express.json())
      app.use('/api', router)

      const extraDetails = 'Keep the frame centred and the lamp on the left third.'
      const response = await request(app)
        .post(`/api/projects/${project.slug}/episodes/${fixture.episodeId}/thumbnail-prompt-lengths`)
        .send({
          model: FREE_MODEL,
          episode_title: 'The Hidden System (EP0031)',
          extra_details: extraDetails,
          thumbnail_reference_asset: null,
          image_mode: 'text2img',
        })
        .expect(200)

      // The expected number is computed from the SAME prompt the render reads,
      // with the SAME helpers the render assembles it with.
      const parsed = await parseImagePromptsDocx(fixture.promptPath)
      const cast = await episodeCast(project.slug, fixture.episodeId)
      const expected = parsed.thumbnails.map(item => ({
        number: Number(item.number),
        characters: promptCharacterCount(assembleThumbnailRenderPrompt(item.prompt, {
          extraDetails,
          // No saved thumbnail reference is configured, so the render appends
          // no reference guidance — and the endpoint must not invent any.
          referenceGuidance: '',
          styleKeywords: matchedStyleKeywords(item.prompt, cast),
        })),
      }))
      assert.deepEqual(response.body.thumbnails, expected)
      assert.equal(expected.length, 2, 'both prompts are measured')
      assert.ok(expected.every(item => item.characters > stored.length),
        'the extras are counted, not just the stored text')
      assert.equal(service.providerSubmissionCount('image'), 0, 'measuring a prompt submits nothing')
    })
  })

  test('an episode with no thumbnail prompts answers 404 with a detail', async () => {
    await withMockGateway(3_200, async ({ service }) => {
      const pm = await import('../services/project-manager.js')
      const ideas = await import('../services/idea-manager.js')
      const { router } = await import('../routes/image-prompts-edit.js')
      const project = await pm.createProject({ name: 'Length Endpoint 404', episode_prefix: 'EP', episode_digits: 4 })
      const [idea] = await ideas.addIdeas(project.slug, [{
        title: 'No Prompts Here (EP0032)',
        logline: 'Fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
      }], 'mock-chat-v1')
      const episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0032' })).episode_code

      const app = express()
      app.use(express.json())
      app.use('/api', router)

      const response = await request(app)
        .post(`/api/projects/${project.slug}/episodes/${episodeId}/thumbnail-prompt-lengths`)
        .send({
          model: FREE_MODEL,
          episode_title: 'No Prompts Here (EP0032)',
          extra_details: '',
          thumbnail_reference_asset: null,
          image_mode: 'text2img',
        })
        .expect(404)
      assert.match(response.body.detail, /EP0032/)
      assert.equal(service.providerSubmissionCount('image'), 0)
    })
  })
})
