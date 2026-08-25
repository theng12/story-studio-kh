/**
 * A scene prompt pack must not be all-or-nothing.
 *
 * THE INCIDENT (EP0067, 333 scenes, 9 packs of 40)
 * ------------------------------------------------
 * Two independent defects, one visible symptom: "0/333 required item(s)
 * verified", nine times "saved 0/40".
 *
 *   1. THE CAUSE. `POST /v1/chat/responses` answers 202 but runs the model
 *      inline, so the POST lasts as long as the generation. Story Studio bound
 *      it to the 30-second CONTROL timeout. Every pack took 33–86 seconds, so
 *      every pack was aborted mid-generation while GenStudio finished it and
 *      charged for it. Covered by `genstudio-language-submit.test.ts`.
 *
 *   2. THE AMPLIFIER, covered here. Even had the answers arrived, one pack of
 *      the nine (scenes 0281–0320) carried 39 perfect rows and one row that
 *      wrote `"scene"` where the contract says `"scene_id"`. The local schema
 *      demanded exactly 40 items, each with `scene_id` drawn from an enum and
 *      no additional properties, so that ONE row rejected the whole object:
 *      39 correct, already-paid-for prompts discarded — and because the
 *      rejection surfaced as a thrown request error rather than a partial
 *      result, the generator's automatic repair pass was gated off too.
 *
 * WHAT MUST NOT REGRESS: the contract still ASKS for exactly the right shape
 * (the instruction is built from `schema`), and a scene id can still only ever
 * map to the moment it names. Those are asserted here alongside the recovery.
 *
 * ZERO paid calls. The malformed row below is the real one, reproduced from
 * GenStudio's stored `chat_requests.output_text` for that pack.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  explainJsonSchemaMismatch,
  jsonValueMatchesSchema,
  validateStructuredOutput,
} from '../lib/json-output-contract.js'
import {
  CONTEXTUAL_CUES_OUTPUT_CONTRACT,
  scenePromptPackOutputContract,
} from '../lib/story-output-contracts.js'
import { buildGenStudioChatIdempotencyKey } from '../lib/genstudio-client.js'
import { checkpointPackPromptResults, parseDirectPackResults } from '../generators/scene-plan.js'

const PACK_IDS = Array.from({ length: 40 }, (_, index) => `ep0067-scene-${String(281 + index).padStart(4, '0')}`)

/** The pack as it actually came back: 40 rows, one of them keyed `scene`. */
function storedPackResponse(): string {
  return JSON.stringify({
    results: PACK_IDS.map((sceneId, index) => (
      index === 36
        // Verbatim defect shape: the id is right, the KEY is wrong.
        ? { scene: sceneId, visual_prompt: `A narrow Byzantine street, plate ${index}.` }
        : { scene_id: sceneId, visual_prompt: `A narrow Byzantine street, plate ${index}.` }
    )),
  })
}

/** Run the pack through the exact path `scene-plan.ts` runs it through. */
async function runPack(raw: string, ids: readonly string[]) {
  const contract = scenePromptPackOutputContract(ids, 'visual')
  validateStructuredOutput(raw, contract)
  const disk = new Map<string, string>()
  const checkpointErrors = await checkpointPackPromptResults(
    parseDirectPackResults(raw, [...ids], 'visual'),
    new Set(ids),
    new Set<string>(),
    async (sceneId, text) => {
      // The generator's own last guard: an id outside the run's targets throws.
      if (!ids.includes(sceneId)) throw new Error(`Provider returned unexpected scene ID ${sceneId}`)
      disk.set(sceneId, text)
    },
  )
  return { disk, checkpointErrors }
}

test('a pack with one malformed row keeps its 39 good prompts', async () => {
  const { disk } = await runPack(storedPackResponse(), PACK_IDS)

  assert.equal(disk.size, 39, 'the 39 correct, already-paid-for prompts must survive')
  const missing = PACK_IDS.filter(id => !disk.has(id))
  assert.deepEqual(missing, ['ep0067-scene-0317'], 'only the malformed row is outstanding')
  // …and it is outstanding as a MISSING ID, which is what the bounded repair
  // request and the durable completion audit both consume.
})

test('an empty pack is still refused, loudly', () => {
  assert.throws(
    () => validateStructuredOutput(JSON.stringify({ results: [] }), scenePromptPackOutputContract(PACK_IDS, 'visual')),
    /minimum 1/,
    'a response with nothing usable in it is a failure, not a partial success',
  )
})

test('a scene id can still only ever map to the moment it names', async () => {
  const forged = JSON.stringify({
    results: [
      { scene_id: 'ep0067-scene-0281', visual_prompt: 'legitimate' },
      // A different episode entirely.
      { scene_id: 'ep0099-scene-9999', visual_prompt: 'wrong episode' },
      // A real scene of this episode, but not one asked for in this pack.
      { scene_id: 'ep0067-scene-0041', visual_prompt: 'outside this pack' },
      // No usable id at all.
      { scene: 'ep0067-scene-0282', visual_prompt: 'malformed key' },
      // Valid, with a key the model volunteered.
      { scene_id: 'ep0067-scene-0283', visual_prompt: 'legitimate too', notes: 'volunteered' },
    ],
  })
  const { disk } = await runPack(forged, PACK_IDS)

  assert.deepEqual(
    [...disk.keys()].sort(),
    ['ep0067-scene-0281', 'ep0067-scene-0283'],
    'only ids requested in this pack may become prompts',
  )
  assert.equal(disk.get('ep0067-scene-0283'), 'legitimate too', 'a volunteered extra key is ignored, not fatal')
  for (const id of disk.keys()) assert.ok(PACK_IDS.includes(id))
})

test('the pack still ASKS for the exact shape, so the instruction is not weakened', () => {
  const contract = scenePromptPackOutputContract(PACK_IDS, 'visual')
  assert.equal(contract.mode, 'json_object')
  if (contract.mode !== 'json_object') return
  const schema = contract.schema as any
  const results = schema.properties.results

  assert.equal(results.minItems, PACK_IDS.length, 'the model is still told exactly how many rows to return')
  assert.equal(results.maxItems, PACK_IDS.length)
  assert.deepEqual(results.items.properties.scene_id.enum, PACK_IDS, 'the model is still told the exact ids')
  assert.equal(results.items.additionalProperties, false)
  assert.deepEqual(results.items.required, ['scene_id', 'visual_prompt'])

  // And the strict shape still rejects the malformed pack — it is simply no
  // longer the thing that decides whether paid work is kept.
  assert.equal(jsonValueMatchesSchema(JSON.parse(storedPackResponse()), schema), false)
})

test('a local rejection names which item failed and why', () => {
  const contract = scenePromptPackOutputContract(PACK_IDS, 'visual')
  if (contract.mode !== 'json_object') return

  const reason = explainJsonSchemaMismatch(JSON.parse(storedPackResponse()), contract.schema!)
  assert.ok(reason, 'a mismatch must be explainable, not merely detectable')
  assert.match(reason!, /\$\.results\[36\]/, 'the failing item is identified by path')
  assert.match(reason!, /scene_id/, 'the reason names the offending key')

  // The same detail reaches the thrown message a workflow actually reads.
  assert.throws(
    () => validateStructuredOutput(JSON.stringify({ results: 'not an array' }), contract),
    /\$\.results: expected array, got string/,
  )
})

test('what Story Studio accepts locally never changes the replay key', () => {
  const contract = scenePromptPackOutputContract(PACK_IDS, 'visual')
  if (contract.mode !== 'json_object') return
  const { accept, ...asked } = contract
  assert.ok(accept, 'the pack declares a local-only acceptance envelope')

  const request = {
    modelId: 'deepseek-v4-flash',
    system: 'system',
    userMessage: 'user',
    maxOutputTokens: 16_384,
    requestIdentity: 'my-channel:EP0067:scene-plan:visual:visual-0008',
  }
  assert.equal(
    buildGenStudioChatIdempotencyKey({ ...request, outputContract: contract }),
    buildGenStudioChatIdempotencyKey({ ...request, outputContract: asked }),
    'a local-only field must not mint a new key — a new key abandons in-flight work and pays twice',
  )
})

test('one volunteered key no longer voids a whole batch of contextual cues', () => {
  const raw = JSON.stringify({
    cues: [
      { scene_id: 'scene-1', title: 'Constantinople, 542' },
      { scene_id: 'scene-2', title: 'The Golden Horn', confidence: 'high' },
    ],
  })
  const value = validateStructuredOutput(raw, CONTEXTUAL_CUES_OUTPUT_CONTRACT) as { cues: unknown[] }
  assert.equal(value.cues.length, 2)

  // An empty proposal list stays valid here: "prefer no cue when uncertain".
  assert.doesNotThrow(() => validateStructuredOutput(JSON.stringify({ cues: [] }), CONTEXTUAL_CUES_OUTPUT_CONTRACT))
  // A missing list is still a malformed answer.
  assert.throws(() => validateStructuredOutput(JSON.stringify({}), CONTEXTUAL_CUES_OUTPUT_CONTRACT), /cues/)
})

test('an array schema that declares no items constrains nothing', () => {
  // Previously this rejected every array, so a schema omission read as the
  // model's mistake.
  assert.equal(jsonValueMatchesSchema({ items: [1, 'two', null] }, {
    type: 'object',
    properties: { items: { type: 'array' } },
    required: ['items'],
  }), true)
})
