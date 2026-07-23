import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('direct paid SDK retries are retired because GenStudio owns submission and idempotency', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (const relative of ['providers/text/openai.ts', 'providers/text/openrouter.ts', 'providers/text/deepseek.ts']) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} must stay retired`)
  }
})
