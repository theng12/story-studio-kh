import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.ts'

const models = [
  { id: 'genstudio-chat:fast', available: true },
  { id: 'genstudio-chat:quality', available: true, legacy_ids: ['old-quality'] },
  { id: 'genstudio-chat:paused', available: false },
]

test('stale saved GPT-4o is healed to a usable live GenStudio model', () => {
  assert.equal(selectLiveGenStudioModel('gpt-4o', models)?.id, 'genstudio-chat:fast')
})

test('a valid explicit selection wins and a published legacy alias migrates', () => {
  assert.equal(selectLiveGenStudioModel('genstudio-chat:quality', models)?.id, 'genstudio-chat:quality')
  assert.equal(selectLiveGenStudioModel('old-quality', models)?.id, 'genstudio-chat:quality')
})

test('no catalog model means no selection rather than reviving a retired id', () => {
  assert.equal(selectLiveGenStudioModel('gpt-4o', [{ id: 'paused', available: false }]), null)
})

test('Script Generator has no hardcoded GPT-4o default and waits for a live model', () => {
  const scriptPage = readFileSync(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url), 'utf8')
  assert.match(scriptPage, /model: '',/)
  assert.match(scriptPage, /@model-meta="onScriptModelMeta"/)
  assert.match(scriptPage, /!scriptModelReady/)
})
