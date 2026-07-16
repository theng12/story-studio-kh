import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PAID_SDK_SOURCES = [
  'providers/text/openai.ts',
  'providers/text/openrouter.ts',
  'providers/text/deepseek.ts',
  'services/research/perplexity.ts',
  'lib/whisper-client.ts',
  'lib/image-edit-client.ts',
  'lib/vision-client.ts',
]

describe('paid SDK retry policy', () => {
  it('keeps every paid OpenAI-compatible or Anthropic client one-shot', async () => {
    for (const relative of PAID_SDK_SOURCES) {
      const source = await fs.readFile(path.join(SERVER_ROOT, relative), 'utf-8')
      const constructors = source.match(/new (?:OpenAI|Anthropic)\s*\(\s*\{[\s\S]*?\}\s*\)/g) || []
      assert.ok(constructors.length > 0, `${relative} should contain a paid SDK client`)
      for (const constructor of constructors) {
        assert.match(constructor, /maxRetries\s*:\s*0/, `${relative} must disable SDK resubmission`)
      }
    }
  })
})
