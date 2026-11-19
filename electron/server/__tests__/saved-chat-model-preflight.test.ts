/**
 * A saved chat model the live catalogue no longer publishes is refused BEFORE
 * the work, not at the step (1.4.413).
 *
 * The failure this guards: SS0082's Scene Plan was replayed from an episode
 * recovery plan that still named a retired model. Scene Plan runs after Audio
 * Assembly and transcription in that order, so the episode spent hours and then
 * failed on a model the app could have checked in the first second.
 *
 * Wiring assertions only — the resolution rules themselves are proved against
 * the mock Gateway in `live-chat-model.test.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(HERE, '..')

test('pipeline preflight refuses a saved chat model the live catalogue does not publish', () => {
  const source = readFileSync(path.join(serverRoot, 'routes/pipeline.ts'), 'utf8')
  // The check reads the live catalogue through the shared resolver, once per
  // ticked chat step, and turns a missing product into a preflight issue.
  assert.match(source, /import \{ findLiveChatModel, savedChatModelGoneMessage \} from '\.\.\/services\/live-chat-model\.js'/)
  assert.match(source, /for \(const step of \['script-only', 'scene_plan', 'contextual_cues'\] as BatchStep\[\]\)[\s\S]{0,600}await findLiveChatModel\(saved\) !== null\) continue[\s\S]{0,300}savedChatModelGoneMessage\(saved\)/)
  // It runs inside preflightBatch, before anything is enqueued.
  const preflightStart = source.indexOf('async function preflightBatch(')
  const checkAt = source.indexOf("for (const step of ['script-only', 'scene_plan', 'contextual_cues'] as BatchStep[])")
  assert.ok(preflightStart >= 0 && checkAt > preflightStart, 'the check belongs to the preflight, not the run')
})

test('episode recovery refuses a gone saved chat model before dispatching any step', () => {
  const source = readFileSync(path.join(serverRoot, 'services/episode-recovery.ts'), 'utf8')
  const guard = source.indexOf('await findLiveChatModel(savedChatModel) === null')
  const decision = source.indexOf('const step = nextEpisodeRecoveryStep(plan, verified)')
  assert.ok(guard >= 0, 'recovery resolves the saved Scene Plan model against the live catalogue')
  assert.ok(decision > guard, 'the guard runs before the next step is chosen and dispatched')
  assert.match(source, /plan\.first_unresolved = 'scene_plan_run'[\s\S]{0,200}savedChatModelGoneMessage\(savedChatModel\)/)
  // An unreadable Gateway is an outage, not a missing product: the guard only
  // fires on a catalogue that WAS read and does not publish the id.
  assert.match(source, /findLiveChatModel\(savedChatModel\) === null/)
})
