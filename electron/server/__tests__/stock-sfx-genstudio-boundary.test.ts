import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchBroll } from '../generators/broll-fetch.js'
import { runSfxDirector } from '../services/sfx-director.js'
import { runShotDirector } from '../services/broll-shot-director.js'

function source(relative: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('GenStudio-only stock and SFX boundary', () => {
  test('reachable routes and job executor cannot call legacy provider adapters', () => {
    const files = [
      '../routes/sfx.ts',
      '../routes/broll-fetch.ts',
      '../routes/broll-shots.ts',
      '../generators/broll-fetch.ts',
      '../services/sfx-autofetch.ts',
      '../services/broll-shot-resolver.ts',
    ]
    for (const file of files) {
      const text = source(file)
      assert.doesNotMatch(text, /getAdapter|ADAPTERS/)
      assert.doesNotMatch(text, /\.search\(|\.download\(/)
    }
    assert.match(source('../routes/sfx.ts'), /status\(501\)/)
    assert.match(source('../routes/broll-fetch.ts'), /status\(501\)/)
    assert.match(source('../routes/broll-shots.ts'), /status\(501\)/)
  })

  test('legacy automatic directors cannot invoke a direct or generic LLM client', () => {
    assert.doesNotMatch(source('../services/sfx-director.ts'), /callAi|app-secrets-store/)
    assert.doesNotMatch(source('../services/broll-shot-director.ts'), /callAi|app-secrets-store/)
    assert.doesNotMatch(source('../routes/sfx.ts'), /getApiKey|runSfxDirector/)
    assert.doesNotMatch(source('../routes/broll-shots.ts'), /getApiKey|runShotDirector|requeryBeat/)
  })

  test('historical executor and director entry points fail closed', async () => {
    const job = { params: {}, output_lines: [] } as any
    await assert.rejects(fetchBroll(job), /GENSTUDIO_CAPABILITY_UNAVAILABLE/)
    await assert.rejects(runSfxDirector({ cues: [], model: '', apiKeys: {} }), /GENSTUDIO_CAPABILITY_UNAVAILABLE/)
    await assert.rejects(runShotDirector({ cues: [], model: '', apiKeys: {} }), /GENSTUDIO_CAPABILITY_UNAVAILABLE/)
  })

  test('customer controls expose local/manual workflows without legacy submissions', () => {
    const library = source('../../../frontend/pages/broll-library.vue')
    const sfx = source('../../../frontend/components/SfxSoundSection.vue')
    const scripted = source('../../../frontend/components/ScriptedBrollSection.vue')

    assert.doesNotMatch(library, /\/broll-fetch\/search|\/broll-pools\/\$\{selectedPoolId\.value\}\/fetch/)
    assert.doesNotMatch(sfx, /api\.generate\(|auto_fetch:\s*true|ModelSelector/)
    assert.doesNotMatch(scripted, /api\.(generate|resolve|search|swapBeat|requeryBeat)\(|ModelSelector|ImageModelPicker/)
    assert.match(library, /Add files locally/)
    assert.match(sfx, /local SFX pools/)
    assert.match(scripted, /Existing resolved plans/)
  })
})
