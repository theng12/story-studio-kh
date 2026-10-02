/**
 * Story Studio never picks a writing model on the owner's behalf (coordinator decision 2026-10-03).
 *
 * Every caller that used to fall back to "the first usable economy model" when nothing was chosen —
 * or heal a chosen-but-unavailable one to another — now runs only the owner's choice or stops with a
 * plain sentence saying where to choose. The gateway publishes every chat model as economy / 0
 * credits, so the old pick could silently land on a paid provider.
 *
 * The behavioural pins live beside each surface: `genstudio-default-model.test.ts` (the resolver),
 * `chapter-expansion-model-fallback.test.ts` (outline / chapter expansion), and the research case
 * below. This file pins that no caller still reaches for a picker.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { useTempDataDir } from './_helpers.js'

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir = SERVER_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

test('no server code can pick or heal a writing model any more', () => {
  const offenders = sources().filter(file => /resolveDefaultChatModel|describeHealedDefaultChatModel|model_heal_notice/
    .test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders.map(f => path.relative(SERVER_ROOT, f)), [])
  const resolver = readFileSync(path.join(SERVER_ROOT, 'services/genstudio-default-model.ts'), 'utf8')
  assert.doesNotMatch(resolver, /cost_tier|usable\[0\]|\.find\(model => model\.cost_tier/)
})

test('each writing caller names where the owner chooses the model', () => {
  const callers: Record<string, RegExp> = {
    'generators/metadata.ts': /resolveChosenChatModel\(apiKey, saved, 'the Metadata page/,
    'generators/image-prompts.ts': /resolveChosenChatModel\(apiKey, saved, 'the Thumbnail Prompts page'\)/,
    'routes/image-prompts-edit.ts': /resolveChosenChatModel\(apiKey, saved, 'the Image Prompts page'\)/,
    'routes/audio.ts': /resolveChosenChatModel\(apiKey, saved, 'the Audio Generator page/,
    'services/audio-expression.ts': /resolveChosenChatModel\(apiKey, saved, 'the Audio Generator page/,
    'services/research/genstudio.ts': /noWritingModelChosenMessage\('the Research page'\)/,
    'services/research/genstudio-web.ts': /if \(!requested && !policy\) throw new Error\(noWritingModelChosenMessage\('the Research page \(web research model\)'\)\)/,
    'routes/pipeline.ts': /has no writing model saved[\s\S]*does not pick one for you/,
  }
  for (const [file, pattern] of Object.entries(callers)) {
    assert.match(readFileSync(path.join(SERVER_ROOT, file), 'utf8'), pattern, file)
  }
})

test('research with no model chosen stops before any request', async () => {
  await useTempDataDir()
  const { genStudioResearch } = await import('../services/research/genstudio.js')
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('no request may be made') }
  try {
    await assert.rejects(
      genStudioResearch.run({ topic: 'Ancient bridges', model: '' } as never),
      /No writing model is chosen for this step\. Choose one on the Research page/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests, 0)
})
