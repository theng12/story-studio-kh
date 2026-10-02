/**
 * v1.4.37 — do not send a JSON contract to a model that cannot be held to one.
 *
 * WHAT HAPPENED. On 2026-08-23 four Scene Plan batches failed on "DeepSeek V4
 * Flash 0731", which publishes `structured_output_mode: none`. GenStudio cannot
 * force such a model to return JSON — it asks in the prompt and rejects what
 * comes back — so it complied for two packs of forty scenes and wrote prose for
 * the third. Two episodes stopped at exactly 80/111 and 80/113. That is not a
 * size limit; it is where the luck ran out.
 *
 * Each run burned 13 to 30 minutes before reporting, and the automatic repair
 * then asked the same model the same question twice more.
 *
 * GenStudio had diagnosed it exactly — "another model may answer this contract
 * more reliably" — and Story Studio could not act on it, because its own
 * catalogue parser collapsed `'none'` into `'json_object'`. The app was blind
 * to the distinction by construction.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { assertModelCanHoldAJsonContract } from '../generators/scene-plan.js'
import type { GenStudioChatModel } from '../lib/genstudio-client.js'

const model = (over: Partial<GenStudioChatModel>): GenStudioChatModel => ({
  id: 'genstudio-chat-test-v1',
  display_name: 'Test Model',
  supports_structured_output: true,
  structured_output_mode: 'json_object',
  ...over,
} as GenStudioChatModel)

describe('a model that cannot return structured output is refused up front', () => {
  test('structured_output_mode "none" is refused before anything is charged', () => {
    assert.throws(
      () => assertModelCanHoldAJsonContract(model({
        display_name: 'DeepSeek V4 Flash 0731',
        structured_output_mode: 'none',
      })),
      /cannot be held to a JSON contract/,
    )
  })

  test('the refusal names the model, so two same-named products are told apart', () => {
    // The catalogue really does contain two near-identically named products
    // where only one supports structured output. Refusing without naming which
    // one is in play would be useless. The name comes from the LIVE catalogue
    // row, never from a literal in this app — see check:model-drift.
    const chosen = 'Some Model 0731'
    assert.throws(
      () => assertModelCanHoldAJsonContract(model({
        display_name: chosen, structured_output_mode: 'none',
      })),
      new RegExp(chosen),
    )
  })

  test('the refusal states the remedy and that nothing was charged', () => {
    try {
      assertModelCanHoldAJsonContract(model({ structured_output_mode: 'none' }))
      assert.fail('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      assert.match(message, /Choose a model that the Gateway publishes structured-output support for/)
      assert.match(message, /Nothing was charged/,
        'a refusal before any request must say so, or it reads like a failed paid run')
    }
  })

  test('it falls back to the id when a product publishes no display name', () => {
    assert.throws(
      () => assertModelCanHoldAJsonContract(model({
        display_name: '', id: 'genstudio-chat-abc-v1', structured_output_mode: 'none',
      })),
      /genstudio-chat-abc-v1/,
    )
  })
})

describe('models that CAN hold a contract are untouched', () => {
  test('json_object passes', () => {
    assert.doesNotThrow(() => assertModelCanHoldAJsonContract(model({ structured_output_mode: 'json_object' })))
  })

  test('request_json_schema passes', () => {
    assert.doesNotThrow(() => assertModelCanHoldAJsonContract(model({ structured_output_mode: 'request_json_schema' })))
  })
})

describe('the catalogue parser can finally see the difference', () => {
  test('"none" and "absent" are no longer the same claim', async () => {
    // The parser previously collapsed everything that was not
    // `request_json_schema` into `json_object`, which is precisely why the app
    // believed a none-model could return JSON objects.
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const client = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'genstudio-client.ts'),
      'utf8',
    )
    assert.match(client, /value\?\.structured_output_mode === 'none'\s*\n?\s*\?\s*'none'/,
      'an explicit none must survive parsing')
    assert.match(client, /structured_output_mode: 'none' \| 'json_object' \| 'request_json_schema'/,
      'and the type must be able to represent it')
  })

  test('an absent field still reads as json_object, so an older catalogue is not refused', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const client = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'genstudio-client.ts'),
      'utf8',
    )
    assert.match(client, /Absent and\s*\n?\s*\/\/ none are different claims/,
      'the distinction between absent and none must be recorded, not just coded')
  })
})
