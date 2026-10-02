/** Gateway 0.2.100 publishes `chargeable` on chat rows; Story carries it to the picker's "Paid" badge. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

test('chat rows keep the published chargeable flag, and leave it absent when unpublished', async () => {
  await useTempDataDir()
  const { listChatModels } = await import('../lib/genstudio-client.js')
  const original = globalThis.fetch
  const row = { display_name: 'M', available: true, qualification_only: false, context_window_tokens: 1000, max_output_tokens: 100 }
  globalThis.fetch = async () => Response.json([
    { ...row, id: 'pool::gemini-free-all', chargeable: false },
    { ...row, id: 'openai-direct::gpt', chargeable: true },
    { ...row, id: 'old::model' },
  ])
  try {
    const models = await listChatModels('chargeable-test-key')
    const flag = (id: string) => models.find(m => m.id === id)?.chargeable
    assert.equal(flag('pool::gemini-free-all'), false)
    assert.equal(flag('openai-direct::gpt'), true)
    assert.equal(flag('old::model'), undefined)
  } finally {
    globalThis.fetch = original
  }
})
