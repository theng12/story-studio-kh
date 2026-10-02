import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GENSTUDIO_RESEARCH_PROVIDER,
  GENSTUDIO_WEB_RESEARCH_PROVIDER,
  RESEARCH_ADAPTERS,
  getResearchAdapter,
  getResearchAdapterForMode,
  normalizeResearchSourceProvider,
} from '../services/research/index.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('Gateway Research boundary', () => {
  it('publishes exactly two adapters, both GenStudio-backed', () => {
    // These are the two research MODES, not a provider choice: both run
    // through the same GenStudio boundary on the same API key. No third entry
    // may appear here without it being a new direct-provider route.
    assert.equal(GENSTUDIO_RESEARCH_PROVIDER, 'llm-only')
    assert.equal(GENSTUDIO_WEB_RESEARCH_PROVIDER, 'genstudio-web')
    assert.deepEqual(Object.keys(RESEARCH_ADAPTERS).sort(), ['genstudio-web', 'llm-only'])
    assert.equal(RESEARCH_ADAPTERS['llm-only'].displayName, 'Gateway LLM')
    assert.equal(RESEARCH_ADAPTERS['genstudio-web'].displayName, 'Gateway web search')
  })

  it('accepts only the two Gateway research identities', () => {
    for (const savedValue of [undefined, '', 'llm-only']) {
      assert.equal(normalizeResearchSourceProvider(savedValue), 'llm-only')
      assert.equal(getResearchAdapter(savedValue), RESEARCH_ADAPTERS['llm-only'])
    }
    assert.equal(normalizeResearchSourceProvider('genstudio-web'), 'genstudio-web')
    assert.equal(getResearchAdapter('genstudio-web'), RESEARCH_ADAPTERS['genstudio-web'])
    assert.throws(
      () => normalizeResearchSourceProvider('perplexity'),
      /Unknown research source: perplexity/,
    )
  })

  it('routes by mode, defaulting anything unrecognised to model knowledge', () => {
    assert.equal(getResearchAdapterForMode('web-search'), RESEARCH_ADAPTERS['genstudio-web'])
    for (const mode of [undefined, null, '', 'model-knowledge', 'something-else']) {
      assert.equal(getResearchAdapterForMode(mode), RESEARCH_ADAPTERS['llm-only'])
    }
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
    // Web search is a GenStudio capability, not a second vendor: the web
    // adapter goes through the same client and the same key.
    assert.match(source, /callChatWithGenStudio/)
    assert.doesNotMatch(source, /https?:\/\/api\.(openai|anthropic|tavily|serper|exa)\./)
  })

  it('selects web-research models by capability only — never by name', async () => {
    const source = await fs.readFile(
      path.join(SERVER_ROOT, 'services/research/web-capability.ts'),
      'utf-8',
    )
    // Any literal vendor/model name in the selector would silently break the
    // moment GenStudio renames or re-routes a product.
    assert.doesNotMatch(source, /['"](?:sonar|perplexity|gpt-|claude-|gemini|grok)/i)
    for (const flag of [
      'available',
      'supports_web_search',
      'returns_citations',
      'citation_format',
      'research_qualified',
    ]) {
      assert.ok(source.includes(flag), `capability filter must test ${flag}`)
    }
  })
})
