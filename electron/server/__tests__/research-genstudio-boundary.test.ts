import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GENSTUDIO_RESEARCH_PROVIDER,
  RESEARCH_ADAPTERS,
  getResearchAdapter,
  normalizeResearchSourceProvider,
} from '../services/research/index.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('GenStudio Research boundary', () => {
  it('publishes exactly one GenStudio-backed research adapter', () => {
    assert.equal(GENSTUDIO_RESEARCH_PROVIDER, 'llm-only')
    assert.deepEqual(Object.keys(RESEARCH_ADAPTERS), ['llm-only'])
    assert.equal(RESEARCH_ADAPTERS['llm-only'].displayName, 'GenStudio LLM')
  })

  it('migrates known legacy provider values without restoring a direct provider', () => {
    for (const savedValue of [undefined, '', 'llm-only', 'perplexity', 'genstudio', 'genstudio-llm']) {
      assert.equal(normalizeResearchSourceProvider(savedValue), 'llm-only')
      assert.equal(getResearchAdapter(savedValue), RESEARCH_ADAPTERS['llm-only'])
    }
    assert.throws(
      () => normalizeResearchSourceProvider('openai-direct'),
      /Unknown research source: openai-direct/,
    )
  })

  it('contains no direct Perplexity transport or provider secret lookup', async () => {
    const researchDir = path.join(SERVER_ROOT, 'services/research')
    const sourceFiles = (await fs.readdir(researchDir)).filter(name => name.endsWith('.ts'))
    const source = (await Promise.all(
      sourceFiles.map(name => fs.readFile(path.join(researchDir, name), 'utf-8')),
    )).join('\n')

    assert.doesNotMatch(source, /api\.perplexity\.ai/)
    assert.doesNotMatch(source, /getApiKey\(['"]perplexity['"]\)/)
    assert.doesNotMatch(source, /new OpenAI\s*\(/)
    assert.match(source, /getApiKey\(['"]genstudio['"]\)/)
    assert.match(source, /callAiWithRetry/)
  })
})
