/**
 * The prompt-character CEILING an image prompt is written under.
 *
 * The two properties worth defending here are (a) the number never comes from
 * Story Studio — no published cap means no instruction and no warning — and
 * (b) the instruction reads as a limit not to breach, never as a length to
 * fill. A model told it has "8,000 characters available" spends 8,000, which
 * is both a worse prompt and a larger completion-token bill on every scene.
 *
 * Nothing in this feature may shorten a prompt. The job succeeds, the prompt is
 * saved in full, and an overrun is reported for the user to act on.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  buildPromptCharCapInstruction,
  describeOverCapPrompts,
  parsePromptCharCap,
  promptCharacterCount,
  readPromptLength,
} from '../services/prompt-char-cap.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const scenePlanGenerator = source('../generators/scene-plan.ts')
const scenePlanner = source('../services/scene-planner.ts')
const scenePlanRoutes = source('../routes/scene-plan.ts')
const imagePromptsGenerator = source('../generators/image-prompts.ts')
const imagePromptsEditRoute = source('../routes/image-prompts-edit.ts')
const imageProvider = source('../providers/image/genstudio.ts')

describe('prompt character ceiling', () => {
  test('an unpublished ceiling produces no instruction and no warning', () => {
    assert.equal(buildPromptCharCapInstruction(undefined), '')
    assert.equal(buildPromptCharCapInstruction(0), '')
    assert.equal(describeOverCapPrompts([{ label: 'scene #1', text: 'x'.repeat(50_000) }], undefined), '')
    const reading = readPromptLength('x'.repeat(9_000), undefined)
    assert.equal(reading.over_cap, false)
    assert.equal(reading.cap, undefined)
    assert.equal(reading.overage, 0)
  })

  test('no number is ever invented — only positive whole values parse as a ceiling', () => {
    assert.equal(parsePromptCharCap(4_800), 4_800)
    assert.equal(parsePromptCharCap('4800'), 4_800)
    assert.equal(parsePromptCharCap(undefined), undefined)
    assert.equal(parsePromptCharCap(null), undefined)
    assert.equal(parsePromptCharCap(''), undefined)
    assert.equal(parsePromptCharCap(0), undefined)
    assert.equal(parsePromptCharCap(-10), undefined)
    assert.equal(parsePromptCharCap(4.5), undefined)
    assert.equal(parsePromptCharCap('auto'), undefined)
  })

  test('the instruction is a ceiling, never a budget to spend', () => {
    const instruction = buildPromptCharCapInstruction(8_000)
    // The number must be stated as a limit…
    assert.match(instruction, /must not exceed/)
    assert.match(instruction, /hard ceiling/)
    assert.match(instruction, /longer than 8,000 characters/)
    assert.match(instruction, /whatever length the scene genuinely needs/)
    // …and never as an allowance. A model handed a budget spends the budget.
    assert.doesNotMatch(instruction, /budget/i)
    assert.doesNotMatch(instruction, /allowance/i)
    assert.doesNotMatch(instruction, /\btarget\b/i)
    assert.doesNotMatch(instruction, /\bup to\b/i)
    assert.doesNotMatch(instruction, /characters available/i)
    assert.doesNotMatch(instruction, /as (long|much) as possible/i)
    assert.doesNotMatch(instruction, /aim for/i)
  })

  test('the instruction never asks for a truncated or self-describing prompt', () => {
    const instruction = buildPromptCharCapInstruction(4_800)
    assert.match(instruction, /Do not cut a prompt off mid-sentence/)
    assert.match(instruction, /do not mention this limit in the prompt text/)
  })

  test('characters are counted exactly the way the submit guard counts them', () => {
    // providers/image/genstudio.ts refuses on `request.prompt.trim().length`,
    // so anything that reports "fits" here must fit there too.
    assert.match(imageProvider, /const promptLength = request\.prompt\.trim\(\)\.length/)
    assert.equal(promptCharacterCount('  abc  '), 3)
    assert.equal(promptCharacterCount(undefined), 0)
    assert.equal(promptCharacterCount(42), 0)
  })

  test('a reading reports the overrun without changing the prompt', () => {
    const text = 'x'.repeat(5_000)
    const reading = readPromptLength(text, 4_800)
    assert.equal(reading.characters, 5_000)
    assert.equal(reading.cap, 4_800)
    assert.equal(reading.over_cap, true)
    assert.equal(reading.overage, 200)
    // The function is a reading, not a transform: the caller still holds the
    // full text, and nothing in the result is a shortened prompt.
    assert.equal(text.length, 5_000)
    assert.equal(Object.values(reading).includes(text as never), false)
  })

  test('a prompt exactly on the ceiling is inside it', () => {
    const reading = readPromptLength('x'.repeat(4_800), 4_800)
    assert.equal(reading.over_cap, false)
    assert.equal(reading.overage, 0)
  })

  test('the over-ceiling notice names offenders and states nothing was shortened', () => {
    const notice = describeOverCapPrompts([
      { label: 'scene #1', text: 'x'.repeat(5_000) },
      { label: 'scene #2', text: 'short' },
      { label: 'scene #3', text: 'x'.repeat(6_000) },
    ], 4_800)
    assert.match(notice, /2 prompt\(s\) exceed the 4,800-character limit/)
    assert.match(notice, /scene #1 \(5,000 chars\)/)
    assert.match(notice, /scene #3 \(6,000 chars\)/)
    assert.doesNotMatch(notice, /scene #2/)
    assert.match(notice, /Nothing was shortened/)
    // Advisory, not an error: the user can still render as-is.
    assert.match(notice, /render as-is/)
  })

  test('the notice stays readable on a large episode', () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({
      label: `scene #${index + 1}`, text: 'x'.repeat(9_000),
    }))
    const notice = describeOverCapPrompts(entries, 4_800)
    assert.match(notice, /40 prompt\(s\) exceed/)
    assert.match(notice, /\+35 more/)
  })
})

describe('scene plan wiring', () => {
  test('the ceiling reaches the packed visual-prompt instruction', () => {
    // A legacy job's number is kept as a saved allowance; a job with a
    // SELECTION resolves it live inside promptBudget().
    assert.match(scenePlanGenerator, /const legacyPromptCharCap = parsePromptCharCap\(params\.prompt_char_cap\)/)
    assert.match(scenePlanGenerator, /const visualBudget = isMotion \? undefined : await promptBudget\(\)/)
    // The writer is handed the BODY ceiling, not the assembled one.
    assert.match(scenePlanGenerator, /buildPromptCharCapInstruction\(visualBudget!\.bodyCeiling, \{/)
    assert.match(scenePlanGenerator, /reservedCharacters: visualBudget!\.reserved\.characters,/)
    assert.match(scenePlanGenerator, /\$\{task\}\$\{promptCharCapInstruction \? `\\n\$\{promptCharCapInstruction\}` : ''\}/)
  })

  test('the single-scene rewrite is written under the same ceiling', () => {
    assert.match(scenePlanGenerator, /prompt_char_cap: rewriteBudget\.bodyCeiling,/)
    assert.match(scenePlanGenerator, /readPromptLength\(newPrompt, rewriteBudget\.storedBodyCeiling\)/)
    assert.match(scenePlanner, /const charCapInstruction = buildPromptCharCapInstruction\(opts\.prompt_char_cap, \{/)
    assert.match(scenePlanner, /prompt_char_cap: ctx\.prompt_char_cap,/)
  })

  test('overruns are reported, never truncated', () => {
    assert.match(scenePlanGenerator, /const overCapNotice = describeOverCapPrompts\(/)
    // No path shortens a generated prompt to fit a ceiling.
    assert.doesNotMatch(scenePlanGenerator, /visual_prompt[^\n]*\.slice\(0, *promptCharCap/)
    assert.doesNotMatch(scenePlanGenerator, /substring\(0, *promptCharCap/)
    assert.doesNotMatch(scenePlanner, /\.slice\(0, *opts\.prompt_char_cap/)
  })

  test('every scene-prompt endpoint accepts the ceiling from its request authority', () => {
    assert.match(scenePlanRoutes, /import \{ measureAssemblyOverhead, parsePromptCharCap \} from '\.\.\/services\/prompt-char-cap\.js'/)
    // ONE parser for the regenerate endpoints: the replay fingerprint and the
    // stored job must read the same object, or a lost-response retry 409s.
    assert.match(scenePlanRoutes, /function scenePromptCapFields\(body: Record<string, unknown>\)/)
    assert.match(scenePlanRoutes, /prompt_char_cap: parsePromptCharCap\(body\.prompt_char_cap\)/)
    assert.equal(
      scenePlanRoutes.match(/const capFields = scenePromptCapFields\(body as Record<string, unknown>\)/g)?.length,
      2,
      'the prompt repair endpoints parse the ceiling once, for replay and storage',
    )
    assert.equal(scenePlanRoutes.match(/\.\.\.capFields,/g)?.length, 3,
      'both repair endpoints forward the exact parsed fields to the job (replay + storage)')
    assert.match(scenePlanRoutes, /prompt_char_cap: promptCharCap,/)
    assert.match(scenePlanRoutes, /prompt_char_cap_selection: presetData\.prompt_char_cap,/)
  })

  test('a token allowance is never reused as a character ceiling', () => {
    assert.doesNotMatch(scenePlanGenerator, /prompt_token_allowance/)
    assert.doesNotMatch(scenePlanner, /prompt_token_allowance/)
    // No characters-per-token ratio is reintroduced anywhere in this feature.
    const capModule = source('../services/prompt-char-cap.ts')
    assert.doesNotMatch(capModule, /chars?PerToken|CHARS_PER_TOKEN|\* *4\b/)
    assert.match(capModule, /never converted into characters/)
  })
})

describe('thumbnail prompt wiring', () => {
  test('the bulk thumbnail brief carries the ceiling', () => {
    // The ceiling is resolved LIVE, when the job RUNS, from the SELECTION the
    // request carries and the image model it was chosen for. A number the
    // client resolved earlier is never trusted: it freezes the ceiling at the
    // moment the page loaded.
    assert.match(imagePromptsGenerator, /const publishedCap = await requireLiveImagePromptCharCap\(\{/)
    assert.match(imagePromptsGenerator, /intendedImageModel: req\.intended_image_model,/)
    assert.match(imagePromptsGenerator, /setting: req\.prompt_char_cap,/)
    assert.doesNotMatch(imagePromptsGenerator, /const publishedCap = parsePromptCharCap\(req\.prompt_char_cap\)/)
    // The writer is then given the ceiling for the prompt BODY — the resolved
    // one minus the characters the final assembly adds on top of it (see
    // services/prompt-char-cap.ts).
    assert.match(imagePromptsGenerator, /const charCapInstruction = buildPromptCharCapInstruction\(args\.promptCharCap, \{/)
    assert.match(imagePromptsGenerator, /publishedCap: args\.promptCharCapTotal,/)
    assert.match(imagePromptsGenerator, /promptCharCap: bodyCeiling,/)
    assert.match(imagePromptsGenerator, /const overCapNotice = describeOverCapPrompts\(/)
  })

  test('a single-prompt rewrite is written under the ceiling too', () => {
    // The request carries the SELECTION and the model it is chosen for, so the
    // server resolves the ceiling against the live catalogue.
    assert.match(imagePromptsEditRoute, /prompt_char_cap: z\.union\(\[/)
    assert.match(imagePromptsEditRoute, /z\.literal\('auto'\)/)
    assert.match(imagePromptsEditRoute, /z\.literal\('none'\)/)
    assert.match(imagePromptsEditRoute, /z\.number\(\)\.int\(\)\.min\(1\),/)
    assert.match(imagePromptsEditRoute, /intended_image_model: z\.string\(\)\.max\(300\)\.optional\(\),/)
    assert.match(imagePromptsEditRoute, /const capRefusal = await resolveLiveImagePromptCharCap\(\{/)
    assert.match(imagePromptsEditRoute, /if \(capRefusal\.error\) \{/)
    // The rewrite is written under the BODY ceiling — the published one minus
    // the clauses the save step appends and the extras the render appends —
    // not under the published one, which is what used to produce an
    // over-length prompt from a compliant rewrite.
    assert.match(imagePromptsEditRoute, /promptCharCap: bodyCeiling,/)
    assert.doesNotMatch(imagePromptsEditRoute, /promptCharCap: parsePromptCharCap\(req\.body\.prompt_char_cap\)/)
    assert.match(imagePromptsEditRoute, /const charCapInstruction = buildPromptCharCapInstruction\(opts\.promptCharCap, \{/)
    assert.match(imagePromptsEditRoute, /publishedCap: opts\.promptCharCapTotal,/)
  })

  test('an existing thumbnail prompt is never trimmed to fit', () => {
    assert.doesNotMatch(imagePromptsGenerator, /\.slice\(0, *promptCharCap/)
    assert.doesNotMatch(imagePromptsGenerator, /substring\(0, *promptCharCap/)
  })
})
