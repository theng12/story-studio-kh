/**
 * v1.4.356 — a scene image prompt never loses the episode's subject.
 *
 * Owner-reported: WI0004 (a zipper episode) rendered HUMAN TEETH. Evidence
 * (`WI4-ZIPPER-TEETH-TRACE-20261025.json`): 46 saved visual prompts describe the
 * zipper's teeth, 29 of them never say "zipper" anywhere — scene 12, for
 * instance, asked for "two parallel rows of teeth, emphasizing their deliberate
 * vertical offset". Each of those prompts reaches the image model VERBATIM and
 * ALONE, so nothing in the request told the model what the episode was about.
 *
 * The fix has two halves, and this file locks down both:
 *
 *   1. the RULE — `SCENE_SUBJECT_GUIDANCE` in lib/image-content-guidance.ts,
 *      a scene-only sibling of the legible-text block: name the real subject,
 *      and disambiguate a word that also means something else in everyday
 *      speech. It carries NO per-subject code and no term list — a "zipper"
 *      rule would be one episode's fix wearing a general rule's coat.
 *
 *   2. the CONTEXT — the episode's own title and a bounded passage of its own
 *      opening narration, threaded into every scene prompt writer, plus the
 *      narration AROUND the scene rather than only the frames before it.
 *
 * Two properties are as important as the fix itself:
 *
 *   - The THUMBNAIL path never gets any of it. A thumbnail's subject is always
 *     the episode itself and its headline is typography, exactly as
 *     `scene-legible-text-guidance.test.ts` argues for its own block.
 *   - The episode context is read PER CALL and never held in state, so one
 *     episode's title cannot reach another episode's prompts.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { useTempDataDir } from './_helpers.js'
import {
  SCENE_SUBJECT_GUIDANCE,
  IMAGE_CONTENT_GUIDANCE,
  sceneSubjectGuidanceBlock,
} from '../lib/image-content-guidance.js'
import { buildPromptCharCapInstruction } from '../services/prompt-char-cap.js'
import { buildThumbnailPrompt } from '../generators/image-prompts.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type Planner = typeof import('../services/scene-planner.js')
let planner: Planner

before(async () => {
  planner = await import('../services/scene-planner.js')
})

/** A four-cue SRT whose second half is where the collision lives. */
const SRT = `1
00:00:00,000 --> 00:00:04,000
Pull the tab on a jacket and you hear it before you think about it.

2
00:00:04,000 --> 00:00:08,000
A quick, rising zip as two sides of fabric become one.

3
00:00:08,000 --> 00:00:12,000
The teeth are tiny hooks moulded to catch their opposite number.

4
00:00:12,000 --> 00:00:16,000
Two parallel rows meet so the join holds under load.
`

const EPISODE = {
  title: 'How a Zipper Works',
  subject: 'Pull the tab on a jacket and you hear it before you think about it: a quick, rising zip as two sides of fabric become one.',
}

/** The planner's single JSON answer for the fixture SRT above. */
const PLAN_JSON = JSON.stringify({
  scenes: [
    { start_sec: 0, end_sec: 6, transcript_segment: 'x', visual_prompt: 'A drafted diagram of two fabric tapes.', boundary_reason: 'beat' },
    { start_sec: 6, end_sec: 12, transcript_segment: 'y', visual_prompt: 'A close view of a slider body.', boundary_reason: 'beat' },
    { start_sec: 12, end_sec: 16, transcript_segment: 'z', visual_prompt: 'A joined chain under load.', boundary_reason: 'beat' },
  ],
})

describe('subject guidance — substance', () => {
  test('says the image model sees the prompt alone', () => {
    assert.match(SCENE_SUBJECT_GUIDANCE, /read by the image model ALONE/)
    assert.match(SCENE_SUBJECT_GUIDANCE, /never sees the narration, the episode title, or any other scene/)
  })

  test('asks for the real subject, not only one of its parts', () => {
    assert.match(SCENE_SUBJECT_GUIDANCE, /Name the real physical subject in every prompt/)
    assert.match(SCENE_SUBJECT_GUIDANCE, /not only a part of it/)
  })

  test('covers the word that means two things, and names the literal thing instead', () => {
    const text = SCENE_SUBJECT_GUIDANCE
    assert.match(text, /also means something else in everyday speech/)
    assert.match(text, /a part named like a body part, an animal, or another object/)
    for (const word of ['teeth', 'head', 'arm', 'mouth', 'spine', 'eye', 'tongue']) {
      assert.ok(text.includes(word), `must illustrate the shape with "${word}"`)
    }
    assert.match(text, /describe the literal thing in this episode's subject matter/)
    assert.match(text, /so the prompt cannot be read the other way/)
    // The illustration is the point: a bare part name is the defect.
    assert.match(text, /"teeth" on its own is not/)
  })

  test('the subject is the last thing to give up under a length limit', () => {
    assert.match(SCENE_SUBJECT_GUIDANCE, /The named subject is the LAST thing to give up/)
    assert.match(SCENE_SUBJECT_GUIDANCE, /never the noun that says what the image shows/)
  })

  test('carries illustrative wording only — no per-subject code and no term table', () => {
    // "zipper" appears ONCE, inside the illustrative example sentence. A rule
    // keyed on one product's vocabulary would be this episode's fix rather than
    // a general one, and would miss the next episode's collision entirely.
    assert.equal((SCENE_SUBJECT_GUIDANCE.match(/zipper/gi) || []).length, 1)
    assert.match(SCENE_SUBJECT_GUIDANCE, /The interlocking metal teeth of a zipper sewn to fabric tape/)
    // No mapping / lookup shape anywhere in the text.
    assert.doesNotMatch(SCENE_SUBJECT_GUIDANCE, /=>|:\s*"[^"]+"\s*,/)
    assert.doesNotMatch(SCENE_SUBJECT_GUIDANCE, /\b(if|when)\s+\w+\s*===/)
  })
})

describe('subject guidance — placement helper', () => {
  test('defaults ON, unlike the per-project legible-text block', () => {
    assert.ok(sceneSubjectGuidanceBlock().includes(SCENE_SUBJECT_GUIDANCE))
    assert.ok(sceneSubjectGuidanceBlock(true).includes(SCENE_SUBJECT_GUIDANCE))
    assert.equal(sceneSubjectGuidanceBlock(false), '')
  })

  test('is its own block, not part of the always-on content-safety guidance', () => {
    // Every path — thumbnails included — gets IMAGE_CONTENT_GUIDANCE. Folding
    // this in would hand the Thumbnail writer a rule about naming a scene's
    // subject, which is not what a thumbnail is for.
    assert.ok(!IMAGE_CONTENT_GUIDANCE.includes(SCENE_SUBJECT_GUIDANCE))
    assert.ok(!IMAGE_CONTENT_GUIDANCE.includes('NAME THE ACTUAL SUBJECT'))
  })
})

describe('the length ceiling protects the subject', () => {
  test('scene writers are told the subject survives a shortening', () => {
    const instruction = buildPromptCharCapInstruction(8_000, { keepNamedSubject: true })
    assert.match(instruction, /The SUBJECT is the last thing to go/)
    assert.match(instruction, /never the noun that names what the image actually shows/)
    // Still a ceiling, still never a budget.
    assert.match(instruction, /must not exceed/)
    assert.doesNotMatch(instruction, /budget/i)
  })

  test('the thumbnail paths keep the exact instruction they had before', () => {
    // No caller in generators/image-prompts.ts or routes/image-prompts-edit.ts
    // passes this, so their bytes are unchanged — asserted structurally below.
    const withoutOption = buildPromptCharCapInstruction(8_000)
    assert.equal(buildPromptCharCapInstruction(8_000, {}), withoutOption)
    assert.ok(!withoutOption.includes('The SUBJECT is the last thing to go'))
  })
})

describe('building the episode context', () => {
  const cues = [
    { index: 1, start_sec: 0, end_sec: 4, text: '  Pull the tab on a jacket  ' },
    { index: 2, start_sec: 4, end_sec: 8, text: 'and you hear it before you think about it.' },
    { index: 3, start_sec: 8, end_sec: 12, text: 'A quick, rising zip.' },
  ] as any

  test('takes the title and the opening narration alike', () => {
    const ctx = planner.buildEpisodePromptContext({ episodeTitle: ' How a Zipper Works ', cues })
    assert.equal(ctx.title, 'How a Zipper Works')
    assert.equal(ctx.subject, 'Pull the tab on a jacket and you hear it before you think about it. A quick, rising zip.')
  })

  test('an absent input stays absent — never a guessed value', () => {
    assert.deepEqual(planner.buildEpisodePromptContext({ episodeTitle: '', cues: [] }), {})
    assert.deepEqual(planner.buildEpisodePromptContext({ episodeTitle: null, cues: [] }), {})
    const titleOnly = planner.buildEpisodePromptContext({ episodeTitle: 'Only a title', cues: [] })
    assert.deepEqual(titleOnly, { title: 'Only a title' })
    assert.equal((titleOnly as { subject?: string }).subject, undefined, 'no cues must not become an empty subject')
  })

  test('is bounded — a long episode contributes a short passage, not the script', () => {
    const long = Array.from({ length: 400 }, (_, i) => ({
      index: i + 1, start_sec: i * 4, end_sec: i * 4 + 4, text: `Line number ${i + 1} of a very long narration.`,
    })) as any
    const ctx = planner.buildEpisodePromptContext({ episodeTitle: 'Long one', cues: long, subjectCharCap: 200 })
    assert.ok(ctx.subject && ctx.subject.length <= 200, 'the passage is capped')
    assert.match(ctx.subject!, /Line number 1 /, 'it is the OPENING narration')
    assert.ok(!/Line number 300 /.test(ctx.subject!), 'far cues are not pulled in')
  })

  test('reads per call — two episodes never share a context', () => {
    const a = planner.buildEpisodePromptContext({ episodeTitle: 'Episode A', cues })
    const b = planner.buildEpisodePromptContext({
      episodeTitle: 'Episode B',
      cues: [{ index: 1, start_sec: 0, end_sec: 3, text: 'A different subject entirely.' }] as any,
    })
    assert.equal(a.title, 'Episode A')
    assert.equal(b.title, 'Episode B')
    assert.notEqual(a.subject, b.subject)
  })

  test('the block is empty when nothing is known, and never invents a subject line', () => {
    assert.equal(planner.episodePromptContextBlock(undefined), '')
    assert.equal(planner.episodePromptContextBlock(null), '')
    assert.equal(planner.episodePromptContextBlock({}), '')
    assert.equal(planner.episodePromptContextBlock({ title: '   ' }), '')
  })

  test('the block says out loud that the image model never sees it', () => {
    const block = planner.episodePromptContextBlock(EPISODE)
    assert.ok(block.includes(JSON.stringify(EPISODE.title)))
    assert.ok(block.includes(EPISODE.subject))
    assert.match(block, /the image model never sees this text, so name this subject in the prompt/)
  })
})

describe('the per-scene writer (generateVisualPromptOnly)', () => {
  /** Capture every request the writer submits. */
  function capture(reply: string) {
    const requests: Array<{ system: string; user: string }> = []
    const callAi = (async (_model: string, system: string, user: string) => {
      requests.push({ system, user })
      return reply
    }) as any
    return { requests, callAi }
  }

  test('names the episode and carries the rule, before the length ceiling', async () => {
    const { requests, callAi } = capture('A drafted diagram of two fabric tapes meeting a slider body.')
    await planner.generateVisualPromptOnly({
      transcript_segment: 'The teeth are tiny hooks moulded to catch their opposite number.',
      model: 'test-model',
      apiKeys: {},
      callAi,
      episode_context: EPISODE,
      prompt_char_cap: 8_000,
      prompt_char_cap_published: 8_000,
    })
    assert.equal(requests.length, 1)
    const system = requests[0]!.system
    assert.ok(system.includes(EPISODE.title), 'the episode title reaches the writer')
    assert.ok(system.includes(EPISODE.subject), 'the episode subject reaches the writer')
    assert.ok(system.includes(SCENE_SUBJECT_GUIDANCE), 'the subject-naming rule reaches the writer')
    assert.ok(system.includes(IMAGE_CONTENT_GUIDANCE), 'the content-safety guidance is untouched')
    assert.match(system, /The SUBJECT is the last thing to go/, 'the ceiling protects the subject')
    // Order matters: the rule must be read BEFORE a writer trims to fit.
    assert.ok(
      system.indexOf(SCENE_SUBJECT_GUIDANCE) < system.indexOf('PROMPT LENGTH LIMIT'),
      'the subject rule is placed before the cap instruction, so it is never the part dropped',
    )
  })

  test('carries the narration AROUND the scene, not just the frames before it', async () => {
    const { requests, callAi } = capture('A close view of a slider body.')
    await planner.generateVisualPromptOnly({
      transcript_segment: 'The teeth are tiny hooks.',
      model: 'test-model',
      apiKeys: {},
      callAi,
      prev_visual_prompts: ['A drafted diagram of two fabric tapes.'],
      prev_transcript_segments: ['A quick, rising zip as two sides of fabric become one.'],
      next_transcript_segments: ['Two parallel rows meet so the join holds under load.'],
    })
    const user = requests[0]!.user
    assert.match(user, /Narration just before this scene/)
    assert.ok(user.includes('A quick, rising zip as two sides of fabric become one.'))
    assert.match(user, /Upcoming scene transcript\(s\)/)
    assert.ok(user.includes('Two parallel rows meet so the join holds under load.'))
    // THIS scene's narration stays last, so it keeps the freshest attention.
    assert.ok(user.lastIndexOf('The teeth are tiny hooks.') > user.indexOf('Two parallel rows meet'))
  })

  test('a fixture that answers with a prompt is returned as-is — nothing rewrites it', async () => {
    const reply = 'A drafted diagram of two fabric tapes feeding a slider body, drawn in crisp line art.'
    const { callAi } = capture(reply)
    const out = await planner.generateVisualPromptOnly({
      transcript_segment: 'The teeth are tiny hooks.',
      model: 'test-model',
      apiKeys: {},
      callAi,
      episode_context: EPISODE,
    })
    assert.equal(out, reply, 'the model answer is not re-written, annotated, or repaired after the fact')
  })

  test('an episode change cannot carry the previous episode’s title (AGENTS §4)', async () => {
    const { requests, callAi } = capture('A drafted diagram.')
    const ask = (episode_context: typeof EPISODE) => planner.generateVisualPromptOnly({
      transcript_segment: 'The teeth are tiny hooks.',
      model: 'test-model',
      apiKeys: {},
      callAi,
      episode_context,
    })
    await ask(EPISODE)
    await ask({ title: 'A Completely Different Episode', subject: 'Insects of the rainforest.' })
    assert.equal(requests.length, 2)
    assert.ok(requests[0]!.system.includes(EPISODE.title))
    assert.ok(!requests[0]!.system.includes('A Completely Different Episode'))
    assert.ok(requests[1]!.system.includes('A Completely Different Episode'))
    assert.ok(
      !requests[1]!.system.includes(EPISODE.title),
      'the second call must not inherit the first episode’s title — it is read per call, never cached',
    )
    assert.ok(!requests[1]!.system.includes(EPISODE.subject))
  })

  test('with no episode context the rule still applies, and nothing is invented', async () => {
    const { requests, callAi } = capture('A drafted diagram.')
    await planner.generateVisualPromptOnly({
      transcript_segment: 'The teeth are tiny hooks.',
      model: 'test-model',
      apiKeys: {},
      callAi,
    })
    const system = requests[0]!.system
    assert.ok(system.includes(SCENE_SUBJECT_GUIDANCE))
    assert.ok(!/EPISODE:/.test(system), 'no title is manufactured when none was resolved')
    assert.ok(!/WHAT THIS EPISODE IS ABOUT/.test(system))
  })
})

describe('the single-pass planner (buildScenePlannerPrompt)', () => {
  let temp: Awaited<ReturnType<typeof useTempDataDir>> | null = null
  let srtPath = ''

  before(async () => {
    temp = await useTempDataDir()
    srtPath = path.join(temp.dir, 'stitched.srt')
    await fs.writeFile(srtPath, SRT)
  })
  after(async () => {
    if (temp) await temp.cleanup()
  })

  /** Capture the window request(s) the single-pass planner submits. */
  function capturePlan() {
    const requests: Array<{ system: string; user: string }> = []
    const callAi = (async (_model: string, system: string, user: string) => {
      requests.push({ system, user })
      return PLAN_JSON
    }) as any
    return { requests, callAi }
  }

  test('the window instruction names the episode and carries the rule', async () => {
    const { requests, callAi } = capturePlan()
    const plan = await planner.planScenes({
      stitched_srt_path: srtPath,
      model: 'test-model',
      window_size: 'small',
      episode_context: EPISODE,
      prompt_char_cap: 8_000,
      prompt_char_cap_published: 8_000,
      callAi,
    })
    assert.ok(plan.scenes.length > 0)
    const system = requests[0]!.system
    assert.ok(system.includes(EPISODE.title))
    assert.ok(system.includes(EPISODE.subject))
    assert.ok(system.includes(SCENE_SUBJECT_GUIDANCE))
    assert.ok(
      system.indexOf(SCENE_SUBJECT_GUIDANCE) < system.indexOf('PROMPT LENGTH LIMIT'),
      'the single-pass planner is told the subject before it is told the ceiling',
    )
  })

  test('each window reads the context it was given — no carry-over between episodes', async () => {
    const first = capturePlan()
    await planner.planScenes({
      stitched_srt_path: srtPath, model: 'test-model', window_size: 'small',
      episode_context: EPISODE, callAi: first.callAi,
    })
    const second = capturePlan()
    await planner.planScenes({
      stitched_srt_path: srtPath, model: 'test-model', window_size: 'small',
      episode_context: { title: 'Another Episode', subject: 'Fungi of the forest floor.' },
      callAi: second.callAi,
    })
    assert.ok(first.requests[0]!.system.includes(EPISODE.title))
    assert.ok(second.requests[0]!.system.includes('Another Episode'))
    assert.ok(second.requests[0]!.system.includes('Fungi of the forest floor.'))
    assert.ok(!second.requests[0]!.system.includes(EPISODE.title))
  })

  test('a window that does not fit is split, and the halves keep range, coverage and recap', async () => {
    const longSrtPath = path.join(temp!.dir, 'long-stitched.srt')
    const stamp = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`
    const cues = Array.from({ length: 8 }, (_, index) => {
      return `${index + 1}\n${stamp(index * 10)} --> ${stamp((index + 1) * 10)}\n${'The zipper holds two rows of tiny teeth in line under load. '.repeat(5)}`
    }).join('\n\n') + '\n'
    await fs.writeFile(longSrtPath, cues)

    const rangeOf = (user: string) => {
      const match = /time range ([\d.]+)s – ([\d.]+)s/.exec(user)
      assert.ok(match, 'the request names its segment range')
      return { start: Number(match[1]), end: Number(match[2]) }
    }
    const answerFor = (user: string) => {
      const { start, end } = rangeOf(user)
      const scenes: Array<Record<string, unknown>> = []
      // The right half answers six seconds late so it snaps to the NEXT cue
      // boundary: the split seam must still leave no narration without a scene.
      for (let from = start >= 40 ? start + 6 : start; from < end; from += 10) {
        scenes.push({
          start_sec: from,
          end_sec: Math.min(end, from + 10),
          transcript_segment: 'x',
          visual_prompt: `A cinematic zipper scene at ${from} seconds.`,
          boundary_reason: 'beat',
        })
      }
      return JSON.stringify({ scenes })
    }

    const whole: Array<{ system: string; user: string }> = []
    const wholeCall = (async (_model: string, system: string, user: string) => {
      whole.push({ system, user })
      return answerFor(user)
    }) as any
    await planner.planScenes({
      stitched_srt_path: longSrtPath, model: 'test-model', window_size: 'full', callAi: wholeCall,
    })
    assert.equal(whole.length, 1, 'the whole episode is one window when nothing is published')

    const requests: Array<{ system: string; user: string }> = []
    const callAi = (async (_model: string, system: string, user: string) => {
      requests.push({ system, user })
      // The split child of the seam-extended scene is filled per scene.
      if (!user.includes('time range')) return 'A cinematic zipper scene at the seam.'
      return answerFor(user)
    }) as any
    const fullPromptTokens = Math.ceil((whole[0]!.system.length + 2 + whole[0]!.user.length) / 4)
    const warnings: string[] = []
    const plan = await planner.planScenes({
      stitched_srt_path: longSrtPath, model: 'test-model', window_size: 'full',
      max_request_tokens: fullPromptTokens - 50,
      callAi, onWarn: message => warnings.push(message),
    })

    const plannerRequests = requests.filter(request => request.user.includes('time range'))
    assert.equal(plannerRequests.length, 2, 'one request per half')
    assert.ok(warnings.some(message => message.includes('was split into')))
    for (const request of plannerRequests) assert.match(request.user, /SEGMENT 1 of 1/)
    const right = plannerRequests.find(request => rangeOf(request.user).start >= 40)!
    assert.match(right.user, /Most recent scenes already planned/)
    assert.match(right.user, /A cinematic zipper scene at 0 seconds/)

    assert.ok(plan.scenes.length > 0)
    assert.ok(plan.scenes[0]!.start_sec <= 0.001)
    for (let index = 1; index < plan.scenes.length; index++) {
      assert.ok(
        Math.abs(plan.scenes[index]!.start_sec - plan.scenes[index - 1]!.end_sec) < 0.001,
        `scene ${index + 1} starts where scene ${index} ends`,
      )
    }
    assert.ok(plan.scenes[plan.scenes.length - 1]!.end_sec >= 80 - 0.001)
  })

  test('the two-pass planner hands the same context to every per-scene writer', async () => {
    const { requests, callAi } = capturePlan()
    const plan = await planner.planScenesTwoPass({
      stitched_srt_path: srtPath,
      model: 'test-model',
      episode_context: EPISODE,
      callAi,
    })
    assert.ok(plan.scenes.length > 0)
    assert.ok(requests.length >= plan.scenes.length, 'one prose call per scene, at least')
    for (const request of requests) {
      assert.ok(request.system.includes(EPISODE.title), 'every per-scene writer gets the episode title')
      assert.ok(request.system.includes(SCENE_SUBJECT_GUIDANCE))
    }
  })
})

describe('the thumbnail path never gets any of it', () => {
  test('neither thumbnail writer imports or references the subject guidance', async () => {
    for (const rel of ['generators/image-prompts.ts', 'routes/image-prompts-edit.ts']) {
      const src = await fs.readFile(path.join(serverRoot, rel), 'utf-8')
      assert.ok(!src.includes('sceneSubjectGuidanceBlock'), `${rel} must not import the helper`)
      assert.ok(!src.includes('SCENE_SUBJECT_GUIDANCE'), `${rel} must not reference the guidance text`)
      assert.ok(!src.includes('episode_context'), `${rel} must not read the episode context`)
    }
  })

  test('a real thumbnail prompt carries neither the rule nor the episode block', () => {
    for (const headlineMode of ['episode-title', 'curiosity-hook'] as const) {
      const out = buildThumbnailPrompt({
        episodeId: 'WI0004',
        title: 'How a Zipper Works',
        storyContext: 'Pull the tab on a jacket and you hear a quick, rising zip.',
        castBlock: '',
        count: 3,
        styleTag: 'painterly illustration',
        aspectRatio: '16:9',
        thumbnailDirective: 'Make it dramatic.',
        targetNumbers: [1, 2, 3],
        headlineMode,
      })
      assert.ok(!out.includes(SCENE_SUBJECT_GUIDANCE), `thumbnail prompt (${headlineMode}) must never carry the subject rule`)
      assert.ok(!out.includes('NAME THE ACTUAL SUBJECT'), 'no trace of the subject-naming phrasing')
      assert.ok(!out.includes('WHAT THIS EPISODE IS ABOUT'), 'no episode block on the thumbnail path either')
    }
  })
})
