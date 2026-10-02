import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tryRecoverImageFromManifest } from '../lib/manifest-recovery.js'
import type { ImageModelConfig } from '../models/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(here, '..')
const generationFiles = [
  'generators/images.ts',
  'generators/scene-image.ts',
  'generators/continuity-render.ts',
  'generators/image-pool-generate.ts',
  'generators/composition-template.ts',
]

test('every reachable Story image generator is pinned to the Gateway boundary', async () => {
  for (const relative of generationFiles) {
    const source = await fs.readFile(path.join(serverRoot, relative), 'utf8')
    assert.match(source, /getApiKey\('genstudio'\)/, `${relative} must use the scoped Gateway key`)
    assert.match(source, /getImageProvider\('genstudio-image'\)/, `${relative} must use the Gateway adapter`)
    assert.doesNotMatch(source, /resolveApiKeyForProvider|getHubBackend|renderImageBatchViaHub|runOnPool\s*\(/)
    assert.doesNotMatch(source, /getApiKey\(['"](?:kie|fal|openai|imagestudio)['"]\)/)
  }
})

test('image recovery cannot poll a legacy provider or silently resubmit', async () => {
  const legacyEntry = {
    provider: 'kie',
    task_id: 'legacy-task-123',
    submitted_at: '2026-07-23T00:00:00.000Z',
    input_hash: 'legacy-evidence',
  }
  const modelConfig = { provider: 'genstudio-image' } as ImageModelConfig

  await assert.rejects(
    tryRecoverImageFromManifest(legacyEntry, 'scoped-genstudio-key', modelConfig),
    /predates GenStudio-only operation/i,
  )
  assert.equal(await tryRecoverImageFromManifest(null, 'scoped-genstudio-key', modelConfig), null)
})

test('manual image repair only reconnects Gateway job identities', async () => {
  const source = await fs.readFile(path.join(serverRoot, 'services/image-reconciler.ts'), 'utf8')
  assert.match(source, /recoverImageWithGenStudio/)
  assert.doesNotMatch(source, /fetchImageUrlsByTaskId|fetch\s*\(|getApiKey\(['"]kie['"]\)/)
})

test('Scene Review batches recover accepted work and leave scheduling to the Gateway', async () => {
  const generator = await fs.readFile(path.join(serverRoot, 'generators/continuity-render.ts'), 'utf8')
  const route = await fs.readFile(path.join(serverRoot, 'routes/scene-review.ts'), 'utf8')

  // The keyed burst only stages local workers. GenStudio's admission permit
  // is the sole authority for remote image placement.
  assert.match(generator, /resolveGenStudioLocalFanout\(\s*\n?\s*scenes\.length,\s*\n?\s*admission\.burst_concurrency_ceiling,/)
  assert.match(generator, /refreshGenStudioAdmission\(/)
  assert.match(generator, /tryRecoverImageFromManifest[\s\S]*imageProvider\.generateImage/)
  assert.match(generator, /manifestEntry\?\.input_hash === expectedInputHash/)
  assert.match(generator, /render_attempt_id/)
  assert.match(generator, /GenStudio controls account concurrency and execution/)
  assert.doesNotMatch(route, /repair-image|body\.concurrency|body\.prompt_only|body\.from_scene_id/)
  assert.doesNotMatch(route, /resolveApiKeyForProvider|getImageProvider\(providerId\)/)
})
