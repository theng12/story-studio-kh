import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Job } from '../models/types.js'
import {
  assertJobDidNotDeclareIncomplete,
  completionErrorMessage,
  requireJobCompletion,
} from '../services/job-completion.js'
import {
  inspectPromptCompletion,
  writePromptCompletionManifest,
} from '../services/prompt-completion.js'
import { _clearImagePromptsParseCache } from '../lib/docx-parser.js'
import { normalizeGeneratedPromptItems } from '../generators/image-prompts.js'
import {
  inspectMetadataCompletion,
  writeMetadataCompletionManifest,
} from '../services/metadata-completion.js'

function job(): Job {
  return {
    job_id: 'audit01', project_slug: 'test', type: 'image_prompts', episode_id: 'EP0001', title: '',
    status: 'running', created_at: '', started_at: '', finished_at: null, error: null,
    output_lines: [], params: {},
  }
}

describe('verified job completion contract', () => {
  test('partial output is declared and throws with exact missing items', () => {
    const target = job()
    assert.throws(() => requireJobCompletion(target, {
      label: 'Scene generation', expected: 3, completed: 2, missing: ['scene-003'],
      retry_hint: 'Retry fills the gap.',
    }), /scene-003/)
    assert.equal(target.result?.complete, false)
    assert.match(target.output_lines.at(-1) || '', /INCOMPLETE/)
  })

  test('queue backstop rejects an executor that returns after declaring incomplete', () => {
    const target = job()
    target.result = { complete: false, completion_error: 'one output is missing' }
    assert.throws(() => assertJobDidNotDeclareIncomplete(target), /one output is missing/)
  })

  test('complete batches are declared without throwing', () => {
    const target = job()
    assert.doesNotThrow(() => requireJobCompletion(target, {
      label: 'Scene generation', expected: 3, completed: 3,
    }))
    assert.equal(target.result?.complete, true)
  })

  test('completion error summaries stay actionable', () => {
    assert.match(completionErrorMessage({
      label: 'Audio', expected: 2, completed: 1, missing: ['Introduction'], retry_hint: 'Retry it.',
    }), /1\/2.*Introduction.*Retry it/)
  })
})

describe('prompt completion manifest', () => {
  test('prompt normalization cannot turn a short model response into a full batch', () => {
    const normalized = normalizeGeneratedPromptItems([
      { number: 7, prompt: 'one' },
      { number: 7, prompt: 'two' },
      { number: 8, prompt: '   ' },
    ], 3)
    assert.deepEqual(normalized.map(item => item.number), [1, 2])
    assert.equal(normalized.length, 2)
  })

  test('an existing but partial prompt document is not complete', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-completion-'))
    try {
      await fs.writeFile(path.join(dir, 'EP0001_Scene_Prompts.md'), [
        '# Scene Prompts', '',
        '## Scene 1: One', '', 'first prompt', '',
        '## Scene 2: Two', '', 'second prompt', '',
      ].join('\n'))
      await writePromptCompletionManifest(dir, 'EP0001', 'scene', 3)
      _clearImagePromptsParseCache()
      const result = await inspectPromptCompletion(dir, 'EP0001', 'scene')
      assert.equal(result.authoritative, true)
      assert.equal(result.complete, false)
      assert.equal(result.present, 2)
      assert.deepEqual(result.missing, [3])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('legacy prompt documents without a manifest remain identifiable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-completion-legacy-'))
    try {
      const result = await inspectPromptCompletion(dir, 'EP0001', 'thumbnail')
      assert.equal(result.authoritative, false)
      assert.equal(result.complete, false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('metadata completion manifest', () => {
  test('a saved partial metadata file remains incomplete', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-completion-'))
    try {
      await fs.writeFile(path.join(dir, 'EP0001_Metadata.json'), JSON.stringify({
        title: 'One', title_options: ['One'], description: 'Useful description', tags: ['tag one'],
      }))
      await writeMetadataCompletionManifest(dir, 'EP0001', 'EP0001_Metadata.json', 3, 2)
      const result = await inspectMetadataCompletion(dir, 'EP0001')
      assert.equal(result.authoritative, true)
      assert.equal(result.complete, false)
      assert.deepEqual(result.missing, ['title option 2', 'title option 3', 'tag 2'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('all requested metadata fields verify complete', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-completion-full-'))
    try {
      await fs.writeFile(path.join(dir, 'EP0001_Metadata.json'), JSON.stringify({
        title: 'One', title_options: ['One', 'Two'], description: 'Useful description', tags: ['tag one', 'tag two'],
      }))
      await writeMetadataCompletionManifest(dir, 'EP0001', 'EP0001_Metadata.json', 2, 2)
      const result = await inspectMetadataCompletion(dir, 'EP0001')
      assert.equal(result.complete, true)
      assert.deepEqual(result.missing, [])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
