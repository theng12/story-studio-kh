import assert from 'node:assert/strict'
import test from 'node:test'

import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import { aiDisclosureText, hasCompletedAiMedia } from '../lib/ai-disclosure.js'
import { cleanGeneratedEmoji } from '../lib/emoji-policy.js'
import { METADATA_SECTIONS } from '../lib/metadata-sections.js'

test('AI disclosure names only the processes the episode proves, never a review', () => {
  assert.equal(aiDisclosureText({ narration_voiced_by_ai: false, images_generated_by_ai: false }, 'en'), '')
  assert.equal(
    aiDisclosureText({ narration_voiced_by_ai: true, images_generated_by_ai: false }, 'en'),
    'The narration voice was generated with AI.',
  )
  const both = aiDisclosureText({ narration_voiced_by_ai: true, images_generated_by_ai: true }, 'en')
  assert.equal(both, 'The narration voice was generated with AI. The images were generated with AI tools.')
  assert.doesNotMatch(both, /review/i)
  assert.doesNotMatch(both, /\p{Emoji_Presentation}/u)
  assert.match(aiDisclosureText({ narration_voiced_by_ai: false, images_generated_by_ai: true }, 'km'), /AI/)
})

test('the shared section has no unverified fallback and requests the channel language', () => {
  const section = METADATA_SECTIONS['ai-disclosure']!
  assert.equal(section.defaultConfig.text, '')
  assert.equal(section.buildInstruction({}, {}, { id: 'ai-disclosure', label: 'AI Disclosure' }), '')
  const instruction = section.buildInstruction({ text: 'Synthesized narration.' }, {}, { id: 'ai-disclosure', label: 'AI Disclosure' })
  assert.match(instruction, /video's language/)
  assert.doesNotMatch(instruction, /reviewed before publishing|🤖/)
})

test('only a succeeded request with a present output proves generation', async t => {
  const temp = await useTempDataDir()
  t.after(temp.cleanup)
  const file = 'part.mp3'
  const manifest = path.join(temp.dir, '.task-manifest.json')
  const save = async (last_state: string) => fs.writeFile(manifest, JSON.stringify({
    schema_version: 1, tasks: { [file]: { provider: 'test', task_id: 'task', submitted_at: '2026-11-05', operation: 'tts', last_state } },
  }))
  await fs.writeFile(path.join(temp.dir, file), 'recorded bytes')
  for (const state of ['prepared', 'accepted', 'failed']) {
    await save(state)
    assert.equal(await hasCompletedAiMedia(temp.dir, 'tts', [file]), false, state)
  }
  await save('succeeded')
  assert.equal(await hasCompletedAiMedia(temp.dir, 'tts', [file]), true)
  assert.equal(await hasCompletedAiMedia(temp.dir, 'tts', []), false, 'inactive narration does not count')
  assert.equal(await hasCompletedAiMedia(temp.dir, 'image'), false, 'another operation does not count')
  await fs.writeFile(path.join(temp.dir, file), '')
  assert.equal(await hasCompletedAiMedia(temp.dir, 'tts', [file]), false, 'empty output does not count')
})

test('generated emoji are removed unless the owner typed that same emoji', () => {
  assert.equal(cleanGeneratedEmoji('Great 🔥 video 🤖', ['title with 🔥 in it']), 'Great 🔥 video')
  assert.equal(cleanGeneratedEmoji('Hello 🤖 AI DISCLOSURE:', ['📚 Sources label']), 'Hello AI DISCLOSURE:')
  assert.equal(cleanGeneratedEmoji('plain text', ['🔥']), 'plain text')
})
