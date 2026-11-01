/**
 * The assembled scene prompt is fitted to the selected model's PUBLISHED
 * `max_prompt_characters`, by shortening the Style Bible at a sentence end.
 *
 * WHAT THIS IS FOR. Curious Why EP0006 sends about 3,300 characters per image —
 * roughly 550 of scene text and the rest Style Bible. The renderer's order is
 * scene, then character details, then `Style:` (`scene-prompt-assembly.ts`),
 * and the models the owner actually renders with publish a few hundred tokens:
 * FLUX.2 Klein and Z-Image silently cut the end, and Studio Hub REFUSES
 * anything past the figure it publishes (about 1,900–2,000, and already 4,000
 * today). Without this change, every Z-Image job on that channel fails.
 *
 * The scene text and the character details are the picture. The Style Bible is
 * the LOOK. So the look is what gives, at a sentence end — never mid-word and
 * never mid-clause — and when no whole sentence fits, none is sent at all.
 *
 * ZERO paid calls. The integration half drives the real generator against the
 * in-process mock GenStudio service and reads the HTTP traffic the mock
 * actually received.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const {
  composeSceneRenderPrompt,
  fitRenderedStyleBible,
  sceneRenderAssemblyParts,
  splitStyleSentences,
} = await import('../services/scene-prompt-assembly.js')
const { publishedSceneRenderPromptCap } = await import('../services/image-prompt-cap.js')
const { measureAssemblyOverhead, promptCharacterCount } = await import('../services/prompt-char-cap.js')

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A scene body in the band a planner actually writes. */
const SCENE = 'The archivist climbs the last flight of the observatory stairs, '
  + 'a brass lantern in one hand, while the storm outside turns the narrow windows pale.'
const CHARACTERS = [
  { name: 'Sokha', description: 'an elderly Cambodian archivist in a faded indigo shirt, silver hair pinned back, wire spectacles' },
  { name: 'The lantern', description: 'a dented brass hurricane lamp with a chipped glass chimney' },
]

/** Four whole sentences, the length a real Style Bible runs to. */
const STYLE = 'Painted in the manner of a hand-inked picture book, with warm ochre and deep indigo. '
  + 'Linework is fine and slightly uneven, as if drawn with a real nib on textured paper. '
  + 'Light falls from one side only, so every figure casts a single soft shadow. '
  + 'Faces are simplified to a few confident strokes, and nothing in the frame is photographic.'

const sceneRenderAssemblyOverhead = (styleBible: string, includeCharacter = true): number =>
  measureAssemblyOverhead(sceneRenderAssemblyParts(CHARACTERS, styleBible, includeCharacter)).characters

/** The prompt as the renderer composes it, with and without the Style Bible. */
function assembled(styleBible = STYLE, includeCharacter = true) {
  return {
    full: composeSceneRenderPrompt(SCENE, CHARACTERS, styleBible, includeCharacter),
    head: composeSceneRenderPrompt(SCENE, CHARACTERS, '', includeCharacter),
    styleBible,
  }
}

/** A ceiling that leaves room for `room` characters of Style Bible text. */
const capFor = (room: number, includeCharacter = true): number =>
  promptCharacterCount(composeSceneRenderPrompt(SCENE, CHARACTERS, '', includeCharacter))
  + '\n\nStyle: '.length
  + room

// ── Sentence splitting ───────────────────────────────────────────────────

test('a sentence ends at its terminator, and a terminator inside a number ends nothing', () => {
  const text = 'Version 2.5 is fine. Version 3.0 is not! Is it? Yes.'
  const sentences = splitStyleSentences(text)
  assert.equal(sentences.length, 4)
  assert.deepEqual(sentences.map(s => s.text), [
    'Version 2.5 is fine.', 'Version 3.0 is not!', 'Is it?', 'Yes.',
  ])
  // Each carries the index it ends at, so the caller keeps the ORIGINAL bytes
  // rather than rejoining the sentences with invented spacing.
  assert.equal(text.slice(0, sentences[0]!.end), 'Version 2.5 is fine.')
  assert.equal(text.slice(0, sentences[2]!.end), 'Version 2.5 is fine. Version 3.0 is not! Is it?')
})

test('Khmer sentence end `។` closes a sentence just as `.` does', () => {
  // The owner's Khmer channels write their Style Bibles in Khmer, and `។`
  // (U+17D4 KHMER SIGN PAVISAN) is what closes a sentence there. A splitter
  // that only knew `.` would treat a whole Khmer bible as ONE sentence and
  // could only ever send all of it or none of it.
  const khmer = 'គំនិតសិល្បៈបែបសៀវភៅគូរដោយដៃ ដែលប្រើពណ៌លឿងក្រហម។ '
    + 'បន្ទាត់គូរស្តើង និងមិនស្មើគ្នាទាំងស្រុង។ '
    + 'ពន្លឺធ្លាក់មកតែម្ខាងប៉ុណ្ណោះ។'
  const sentences = splitStyleSentences(khmer)
  assert.equal(sentences.length, 3, 'each `។` closes one sentence')
  assert.ok(sentences[0]!.text.endsWith('។'), `got ${JSON.stringify(sentences[0]!.text)}`)

  const body = composeSceneRenderPrompt(SCENE, CHARACTERS, '', true)
  // Room for two of the three Khmer sentences.
  const fit = fitRenderedStyleBible({
    ...assembled(khmer),
    head: body,
    limit: body.length + '\n\nStyle: '.length + sentences[1]!.end,
  })
  assert.equal(fit.kind, 'trimmed')
  assert.ok(fit.kind === 'trimmed' && fit.styleText.endsWith('។'), 'a Khmer cut lands on `។`')
  assert.ok(fit.kind === 'trimmed' && !fit.styleText.includes(sentences[2]!.text.slice(0, 10)))
  assert.ok(fit.kind === 'trimmed' && fit.prompt.length <= body.length + '\n\nStyle: '.length + sentences[1]!.end)
})

// ── The fit ──────────────────────────────────────────────────────────────

test('a prompt already inside the limit is returned byte for byte unchanged', () => {
  const parts = assembled()
  const atTheLimit = fitRenderedStyleBible({ ...parts, limit: promptCharacterCount(parts.full) })
  assert.equal(atTheLimit.kind, 'fits')
  assert.equal(atTheLimit.prompt, parts.full, 'exactly at the ceiling is not over it')

  const roomy = fitRenderedStyleBible({ ...parts, limit: promptCharacterCount(parts.full) + 500 })
  assert.equal(roomy.kind, 'fits')
  assert.equal(roomy.prompt, parts.full)
})

test('over the limit, the Style Bible is cut at a sentence end and the result fits', () => {
  const parts = assembled()
  const sentences = splitStyleSentences(STYLE)
  assert.equal(sentences.length, 4)
  const roomForThree = sentences[2]!.end
  const limit = capFor(roomForThree)
  assert.ok(promptCharacterCount(parts.full) > limit, 'the fixture must actually be over the ceiling')

  const fit = fitRenderedStyleBible({ ...parts, limit })
  assert.equal(fit.kind, 'trimmed')
  assert.ok(fit.kind === 'trimmed')
  assert.equal(fit.styleText, STYLE.slice(0, roomForThree).trim(), 'whole sentences only, original bytes')
  assert.equal(fit.droppedStyleCharacters, promptCharacterCount(STYLE) - promptCharacterCount(fit.styleText))
  assert.ok(fit.droppedStyleCharacters > 0, 'non-zero: something really was dropped')
  assert.equal(fit.prompt, `${parts.head}\n\nStyle: ${fit.styleText}`)
  assert.equal(
    promptCharacterCount(fit.prompt),
    promptCharacterCount(parts.head) + '\n\nStyle: '.length + promptCharacterCount(fit.styleText),
  )
  assert.ok(
    promptCharacterCount(fit.prompt) <= limit,
    `fitted prompt is ${promptCharacterCount(fit.prompt)} against a ${limit} ceiling`,
  )
  // The cut is at a sentence end: the kept text ends with a terminator, and
  // the sentence that follows it is nowhere in what was sent.
  assert.ok(/[.!?។]["'”’»)\]]?$/.test(fit.styleText), `cut mid-sentence: ${JSON.stringify(fit.styleText.slice(-20))}`)
  assert.equal(fit.styleText.includes('nothing in the frame is photographic'), false)
  // The scene text and the character details are whole — that is the point.
  assert.equal(fit.prompt.startsWith(parts.head), true)
  assert.equal(promptCharacterCount(fit.prompt) > promptCharacterCount(SCENE), true)
  assert.ok(fit.prompt.includes('an elderly Cambodian archivist'), 'character details must survive the cut')
})

test('no room for a whole style sentence sends no style layer at all', () => {
  const parts = assembled()
  const headCharacters = promptCharacterCount(parts.head)

  // Room for the label but not one whole sentence.
  const tooTight = capFor(10)
  assert.ok(tooTight > headCharacters)
  const fit = fitRenderedStyleBible({ ...parts, limit: tooTight })
  assert.equal(fit.kind, 'trimmed')
  assert.ok(fit.kind === 'trimmed')
  assert.equal(fit.styleText, '', 'one lonely clause is a worse steer than none')
  assert.equal(fit.prompt, parts.head, 'no bare "Style:" label is sent with nothing after it')
  assert.equal(fit.droppedStyleCharacters, promptCharacterCount(STYLE), 'everything of the bible was dropped')

  // No room even for the label.
  const noLabelRoom = fitRenderedStyleBible({ ...parts, limit: headCharacters })
  assert.equal(noLabelRoom.kind, 'trimmed')
  assert.ok(noLabelRoom.kind === 'trimmed')
  assert.equal(noLabelRoom.styleText, '')
  assert.equal(noLabelRoom.prompt, parts.head)
})

test('a single sentence longer than the whole allowance sends no style layer', () => {
  const oneLongSentence = `Painted in the manner of a hand-inked picture book ${'and filled with detail '.repeat(30)}.`
  const parts = assembled(oneLongSentence)
  const fit = fitRenderedStyleBible({ ...parts, limit: capFor(10) })
  assert.equal(fit.kind, 'trimmed')
  assert.ok(fit.kind === 'trimmed')
  assert.equal(fit.styleText, '')
  assert.equal(fit.prompt, parts.head)
})

test('a scene and its character details alone over the ceiling is NOT trimmed', () => {
  // Dropping the scene's own text would be deciding what the picture shows.
  // The caller is handed both figures and refuses, naming them.
  const parts = assembled()
  const headCharacters = promptCharacterCount(parts.head)
  const limit = headCharacters - 40
  assert.ok(limit > 0)

  const fit = fitRenderedStyleBible({ ...parts, limit })
  assert.equal(fit.kind, 'scene-too-long')
  assert.ok(fit.kind === 'scene-too-long')
  assert.equal(fit.headCharacters, headCharacters, 'a real, non-zero figure')
  assert.equal(fit.limit, limit)
  assert.ok(fit.headCharacters > fit.limit)
  assert.equal('prompt' in fit, false, 'no prompt is produced — the caller refuses instead')
})

test('a project with no Style Bible is never "trimmed" — an over-ceiling scene is refused as before', () => {
  const parts = assembled('')
  assert.equal(parts.full, parts.head)
  const fit = fitRenderedStyleBible({ ...parts, limit: promptCharacterCount(parts.head) - 30 })
  assert.equal(fit.kind, 'scene-too-long')
})

test('an unpublished or malformed ceiling produces no trimming and no invented figure', () => {
  const parts = assembled()
  for (const limit of [0, -1, Number.NaN, 1.5]) {
    const fit = fitRenderedStyleBible({ ...parts, limit })
    assert.equal(fit.kind, 'fits', `limit ${limit} must not trim`)
    assert.equal(fit.prompt, parts.full, 'byte for byte what was composed')
  }
})

test('the fit is deterministic: the same inputs and the same ceiling produce the same prompt', () => {
  const parts = assembled()
  const limit = capFor(splitStyleSentences(STYLE)[2]!.end)
  const first = fitRenderedStyleBible({ ...parts, limit })
  const second = fitRenderedStyleBible({ ...parts, limit })
  assert.equal(first.kind, 'trimmed')
  assert.equal(second.kind, 'trimmed')
  assert.equal(first.prompt, second.prompt)
})

// ── The live ceiling ─────────────────────────────────────────────────────

test('the ceiling is read live from the catalogue and is absent when the model publishes none', async () => {
  const temp = await useTempDataDir()
  try {
    const service = await startMockGenStudioService()
    try {
      await withCatalog(service.baseUrl, {}, async () => {
        await configureMockGenStudio(service.baseUrl)
        // The stock fixture publishes no `max_prompt_characters`, so there is
        // no figure to trim against and none is invented (§1).
        const published = await publishedSceneRenderPromptCap(MOCK_GENSTUDIO_FULL_KEY, 'mock-image-v1')
        assert.equal(published, undefined)

        await withCatalog(service.baseUrl, { max_prompt_characters: 1_900 }, async () => {
          assert.equal(
            await publishedSceneRenderPromptCap(MOCK_GENSTUDIO_FULL_KEY, 'mock-image-v1'),
            1_900,
            'a model that publishes a figure supplies it live',
          )
        })

        // A saved id the catalogue does not answer to yields nothing, not a guess.
        assert.equal(
          await publishedSceneRenderPromptCap(MOCK_GENSTUDIO_FULL_KEY, 'model-that-was-retired'),
          undefined,
        )
        assert.equal(await publishedSceneRenderPromptCap('', 'mock-image-v1'), undefined)
      })
    } finally {
      await service.close()
    }
  } finally {
    await temp.cleanup()
  }
})

// ── The render, on the wire ──────────────────────────────────────────────

/** Republish the mock image catalogue with the given published fields. */
async function withCatalog<T>(
  baseUrl: string,
  overrides: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  globalThis.fetch = async (input: any, init: any) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== baseUrl || !['/v1/image/models', '/v1/images/models'].includes(url.pathname)) return response
    const models = await response.json() as Array<Record<string, unknown>>
    return new Response(JSON.stringify(models.map(model => {
      const next = { ...model, ...overrides }
      // An unpublished figure means the key is ABSENT, not null or zero.
      if (!('max_prompt_characters' in overrides)) delete next.max_prompt_characters
      return next
    })), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  }
  clearGenStudioCatalogCache()
  try { return await run() } finally {
    globalThis.fetch = originalFetch
    clearGenStudioCatalogCache()
  }
}

async function configureMockGenStudio(baseUrl: string): Promise<void> {
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
}

async function createEpisode(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Prompt fit', logline: 'A deterministic mock episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    episodeId: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

async function writeScenePrerequisites(
  paths: { scene_prompts_dir: string; subtitles_dir: string },
  episodeId: string,
  scenes: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
}

function renderJob(projectSlug: string, episodeId: string): any {
  return {
    job_id: `prompt-fit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project_slug: projectSlug,
    type: 'continuity_render',
    episode_id: episodeId,
    title: 'Prompt fit test',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: { episode_id: episodeId, model: 'mock-image-v1', aspect_ratio: '16:9', resolution: '1K', force: true },
  }
}

/** Every generation POST body the mock actually received. */
function generationPrompts(service: { requests: Array<{ method: string; path: string; bodyText: string }> }): string[] {
  return service.requests
    .filter(r => r.method === 'POST' && r.path === '/v1/images/generations')
    .map(r => JSON.parse(r.bodyText).prompt)
}

const LONG_STYLE_BIBLE = 'Painted like a hand-inked picture book, warm ochre and deep indigo. '
  + 'The linework is fine and slightly uneven, as if drawn with a real nib on textured paper. '
  + 'Light falls from one side only, so every figure casts a single soft shadow. '
  + 'Faces are simplified to a few confident strokes, and nothing here is photographic. '
  + 'Edges are never hard, and the paper grain shows through every wash of colour.'

test('a render under the published ceiling sends the assembled prompt unchanged', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    await withCatalog(service.baseUrl, { max_prompt_characters: 4_000 }, async () => {
      const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
      const { project, episodeId, paths } = await createEpisode('Under the ceiling')
      await writeScenePrerequisites(paths, episodeId, [
        { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
      ])
      await fs.writeFile(
        path.join(paths.episode_dir, 'continuity.json'),
        JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
      )
      const job = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(job)

      const sent = generationPrompts(service)
      assert.equal(sent.length, 1)
      assert.equal(sent[0], composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE, false),
        'byte for byte the assembled prompt, Style Bible whole')
      assert.equal(job.output_lines.some((line: string) => line.includes('Prompt fit:')), false,
        'a run that trimmed nothing says nothing')
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a render over the published ceiling sends a shorter prompt, and the run says so once', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const sentences = splitStyleSentences(LONG_STYLE_BIBLE)
    assert.equal(sentences.length, 5)
    // Room for three of the five sentences — a real, non-zero ceiling.
    const limit = promptCharacterCount(composeSceneRenderPrompt(SCENE, [], '', false))
      + '\n\nStyle: '.length + sentences[2]!.end

    await withCatalog(service.baseUrl, { max_prompt_characters: limit }, async () => {
      const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
      const { project, episodeId, paths } = await createEpisode('Over the ceiling')
      const scenes = [
        { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
        { id: 'scene-002', scene_index: 2, visual_prompt: `${SCENE} A second, longer scene with more to describe.` },
      ]
      await writeScenePrerequisites(paths, episodeId, scenes)
      await fs.writeFile(
        path.join(paths.episode_dir, 'continuity.json'),
        JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
      )
      const job = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(job)

      const sent = generationPrompts(service)
      assert.equal(sent.length, 2, 'both scenes were submitted')
      for (const prompt of sent) {
        assert.ok(promptCharacterCount(prompt) <= limit, `${promptCharacterCount(prompt)} > ${limit}`)
        assert.ok(prompt.startsWith(SCENE.slice(0, 40)), 'the scene text reached the model whole')
        assert.equal(prompt.includes('nothing here is photographic'), false, 'the dropped sentence is gone')
        assert.equal(/[.!?។]["'”’»)\]]?\s*$/.test(prompt), true, 'the cut landed on a sentence end')
      }

      const fitLines = job.output_lines.filter((line: string) => line.includes('Prompt fit:'))
      assert.equal(fitLines.length, 1, 'one line for the run, not one per scene')
      assert.match(fitLines[0]!, /2 of 2 scene/)
      assert.match(fitLines[0]!, /mock-image-v1/)
      assert.match(fitLines[0]!, new RegExp(limit.toLocaleString().replace(/,/g, '[,\\s]*')))
      assert.match(fitLines[0]!, /at most [\d,]+ style characters were dropped/)
      assert.match(fitLines[0]!, /scene text and character details were kept whole/i)
      assert.match(fitLines[0]!, /unchanged on disk/)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a scene whose own text will not fit is refused, naming the model limit and the prompt length', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const body = composeSceneRenderPrompt(SCENE, [], '', false)
    const limit = Math.max(1, promptCharacterCount(body) - 60)

    await withCatalog(service.baseUrl, { max_prompt_characters: limit }, async () => {
      const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
      const { project, episodeId, paths } = await createEpisode('Scene alone too long')
      await writeScenePrerequisites(paths, episodeId, [
        { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
      ])
      await fs.writeFile(
        path.join(paths.episode_dir, 'continuity.json'),
        JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
      )
      const job = renderJob(project.slug, episodeId)
      // The job refuses rather than returning: a scene that cannot fit at all
      // is a failed job, and its message is what the owner reads.
      const refusal = await runContinuityRenderJob(job).then(() => null, (error: Error) => error)
      assert.ok(refusal, 'the run must refuse, not quietly send a prompt the model will reject')
      assert.match(refusal.message, /accepts up to [\d,]+ prompt characters/i, 'the model limit is named')
      assert.match(refusal.message, new RegExp(limit.toLocaleString().replace(/,/g, '[,\\s]*')))
      // The refusal measures what would have been SENT — the whole assembly —
      // which is larger than the head alone, because nothing was trimmed.
      const wouldHaveSent = promptCharacterCount(composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE, false))
      assert.ok(wouldHaveSent > promptCharacterCount(body), 'the fixture really is over')
      assert.match(
        refusal.message,
        new RegExp(wouldHaveSent.toLocaleString().replace(/,/g, '[,\\s]*')),
        'the prompt length is named',
      )
      assert.match(refusal.message, /Scene 1/, 'the scene is named')
      assert.equal(generationPrompts(service).length, 0, 'no request was made')
      // The Style Bible is not blamed for a scene that could never have fit.
      assert.equal(job.output_lines.some((line: string) => line.includes('Prompt fit:')), false)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('no published ceiling means no trimming and no invented figure', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    // The whole assembly, Style Bible and all, is far past any figure Studio
    // Hub is about to publish — and with nothing published, it is sent whole.
    await withCatalog(service.baseUrl, {}, async () => {
      const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
      const { project, episodeId, paths } = await createEpisode('Nothing published')
      await writeScenePrerequisites(paths, episodeId, [
        { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
      ])
      await fs.writeFile(
        path.join(paths.episode_dir, 'continuity.json'),
        JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
      )
      const job = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(job)

      const sent = generationPrompts(service)
      assert.equal(sent.length, 1)
      assert.equal(sent[0], composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE, false),
        'unpublished means unsent-limit, not a guessed one')
      assert.equal(job.output_lines.some((line: string) => line.includes('Prompt fit:')), false)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a ceiling that changes between two renders takes effect on the next render', async () => {
  // §1: the figure is read live and never stored. A Hub that republishes a
  // lower ceiling must bite on the NEXT render, with nothing cached from the
  // first one and no reload.
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { project, episodeId, paths } = await createEpisode('The ceiling moved')
    await writeScenePrerequisites(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
    ])
    await fs.writeFile(
      path.join(paths.episode_dir, 'continuity.json'),
      JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
    )
    const whole = composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE, false)
    const sentences = splitStyleSentences(LONG_STYLE_BIBLE)
    const lowLimit = promptCharacterCount(composeSceneRenderPrompt(SCENE, [], '', false))
      + '\n\nStyle: '.length + sentences[1]!.end

    await withCatalog(service.baseUrl, { max_prompt_characters: 8_000 }, async () => {
      const first = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(first)
      assert.equal(generationPrompts(service)[0], whole, 'a generous ceiling trims nothing')
    })

    await withCatalog(service.baseUrl, { max_prompt_characters: lowLimit }, async () => {
      const second = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(second)
      const sent = generationPrompts(service)
      assert.equal(sent.length, 2, 'the second render did submit')
      assert.notEqual(sent[1], whole, 'the lower figure bit on the very next render')
      assert.ok(promptCharacterCount(sent[1]!) <= lowLimit)
      assert.ok(sent[1]!.startsWith(SCENE.slice(0, 40)))
      assert.match(second.output_lines.join('\n'), /Prompt fit:/)
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('a trimmed prompt does not make its scene read stale, and does not redraw a finished one', async () => {
  // The stale rule compares `scene_plan.json`'s `rendered_prompt` — the stored
  // BODY the owner edits — with that body as it stands now
  // (`services/scene-media-checkpoint.ts`). The fit never touches either: it
  // changes only the text submitted on top of them. If that comparison ever
  // started seeing the assembled prompt, every trimmed scene would report
  // "image was rendered from an outdated prompt" forever and could never
  // complete.
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { auditSceneImageCompletion } = await import('../services/scene-media-checkpoint.js')
    const { project, episodeId, paths } = await createEpisode('Not stale')
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    await writeScenePrerequisites(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
    ])
    await fs.writeFile(
      path.join(paths.episode_dir, 'continuity.json'),
      JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }),
    )
    const sentences = splitStyleSentences(LONG_STYLE_BIBLE)
    const limit = promptCharacterCount(composeSceneRenderPrompt(SCENE, [], '', false))
      + '\n\nStyle: '.length + sentences[1]!.end

    await withCatalog(service.baseUrl, { max_prompt_characters: limit }, async () => {
      const job = renderJob(project.slug, episodeId)
      await runContinuityRenderJob(job)
      assert.match(job.output_lines.join('\n'), /Prompt fit:/, 'this render really did trim')

      const plan = JSON.parse(await fs.readFile(planPath, 'utf-8'))
      assert.equal(plan.scenes[0].rendered_prompt, SCENE,
        'the plan records the BODY, not the shortened text that was submitted')
      assert.equal(plan.scenes[0].visual_prompt, SCENE, 'the stored plan is not rewritten')

      const audit = await auditSceneImageCompletion(planPath, ['scene-001'], [job.output_dir!])
      assert.deepEqual(audit.invalid, [], 'the image is not stale')
      assert.equal(audit.completed, 1)

      // And a re-run reconnects to the same request instead of paying twice:
      // same inputs and same ceiling produce the same prompt and the same key.
      const before = service.requests.filter(r => r.path === '/v1/images/generations').length
      service.queueScenario('image', { states: ['accepted', 'succeeded'] })
      const again = renderJob(project.slug, episodeId)
      again.params.force = false
      await runContinuityRenderJob(again)
      assert.equal(
        service.requests.filter(r => r.path === '/v1/images/generations').length,
        before,
        'a finished scene is reclaimed, not re-bought',
      )
    })
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

test('the Style Bible on disk is never rewritten to match what was trimmed', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGenStudio(service.baseUrl)
    await import('../providers/image/genstudio.js')
    service.queueScenario('image', { states: ['accepted', 'succeeded'] })
    const { runContinuityRenderJob } = await import('../generators/continuity-render.js')
    const { project, episodeId, paths } = await createEpisode('The bible is untouched')
    await writeScenePrerequisites(paths, episodeId, [
      { id: 'scene-001', scene_index: 1, visual_prompt: SCENE },
    ])
    const continuityPath = path.join(paths.episode_dir, 'continuity.json')
    await fs.writeFile(continuityPath, JSON.stringify({ schema_version: 1, style_bible: LONG_STYLE_BIBLE }))
    const planPath = path.join(paths.scene_prompts_dir, 'scene_plan.json')
    const planBefore = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    // Room for exactly the first sentence of the bible.
    const sentences = splitStyleSentences(LONG_STYLE_BIBLE)
    const limit = promptCharacterCount(composeSceneRenderPrompt(SCENE, [], '', false))
      + '\n\nStyle: '.length + sentences[0]!.end

    await withCatalog(service.baseUrl, { max_prompt_characters: limit }, async () => {
      await runContinuityRenderJob(renderJob(project.slug, episodeId))
      const sent = generationPrompts(service)
      assert.equal(sent.length, 1)
      assert.equal(
        sent[0],
        composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE.slice(0, sentences[0]!.end).trim(), false),
        'one sentence went, and it went whole',
      )
      assert.ok(promptCharacterCount(sent[0]!) <= limit)
      assert.ok(
        promptCharacterCount(sent[0]!) < promptCharacterCount(composeSceneRenderPrompt(SCENE, [], LONG_STYLE_BIBLE, false)),
        'this render really did send less than the whole bible',
      )
    })

    const continuity = JSON.parse(await fs.readFile(continuityPath, 'utf-8'))
    assert.equal(continuity.style_bible, LONG_STYLE_BIBLE, 'the stored Style Bible is whole')
    // The render registers its own image in the plan — that is its job and
    // unrelated to the fit. What the fit must never touch is the prompt text.
    const planAfter = JSON.parse(await fs.readFile(planPath, 'utf-8'))
    assert.equal(planAfter.scenes[0].visual_prompt, planBefore.scenes[0].visual_prompt,
      'the stored scene prompt is byte-identical')
    assert.equal(planAfter.scenes[0].id, planBefore.scenes[0].id)
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
