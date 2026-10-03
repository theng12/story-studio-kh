// Dreamlands E2E (2026-10-03): prompts are written as "## Thumbnail N: <title>",
// but the reader dropped everything after the number, so every row came back as
// "Thumbnail N" — and a Reprompt in a hook mode then lettered "Thumbnail 1".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseImagePromptsDocx } from '../lib/docx-parser.js'

test('a written thumbnail title survives a read-back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-heading-'))
  const file = path.join(dir, 'EP0001_Thumbnail_Prompts.md')
  await fs.writeFile(file, '# T — Image Prompts\n\n# Thumbnail Prompts\n\n## Thumbnail 1: STARLIT LINEN\n\nA weaver at dusk.\n\n## Thumbnail 2\n\nA loom.\n')
  const parsed = await parseImagePromptsDocx(file)
  assert.deepEqual(parsed.thumbnails.map(t => [t.number, t.title]), [[1, 'STARLIT LINEN'], [2, 'Thumbnail 2']])
  assert.equal(parsed.thumbnails[0]!.prompt, 'A weaver at dusk.')
})
