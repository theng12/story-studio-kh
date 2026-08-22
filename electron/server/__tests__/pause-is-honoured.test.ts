/**
 * v1.4.35 — does Pause actually stop anything?
 *
 * For three generators the honest answer was NO, and it was found three
 * separate times by three separate agents adding the fleet-busy retry — each
 * noticed it, each correctly refused to fix it inside a retry change, and it
 * would have been forgotten if the third had not written it down.
 *
 * What was actually true before this release:
 *
 *   images.ts               the worker pool read Cancel and nothing else, so a
 *                           paused batch went on buying every remaining scene
 *                           and thumbnail to the end of the run
 *   contextual-cues.ts      `waitWhileActive` read Cancel only, so a Pause
 *                           during a pacing delay or a backpressure cooldown
 *                           was ignored and the batch submitted anyway
 *   image-pool-generate.ts  the item loop read Cancel only
 *   subtitles.ts            the fleet-busy wait was a bare setTimeout, so a
 *                           Pause pressed mid-wait slept out up to five minutes
 *                           before anything looked at it
 *
 * This is the same defect class as the whole fleet-busy series: the app knows
 * something and does not act on it, and the only symptom is work the owner did
 * not ask for. A Pause button that silently does nothing is worse than no Pause
 * button, because he trusts it.
 *
 * These are SOURCE assertions rather than live runs. Driving a real pause
 * through four generators would need a paid fleet and a stopwatch; what has to
 * be guaranteed is structural — that each place which can start paid work, or
 * sit still for minutes, reads the pause signal at all.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { waitUnlessStopped } from '../lib/genstudio-fleet-busy.js'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFile(path.join(SERVER, rel), 'utf8')

describe('the shared wait stops when told to', () => {
  test('it returns early rather than sleeping out the full delay', async () => {
    let stop = false
    const started = Date.now()
    const wait = waitUnlessStopped(60_000, () => stop, 5)
    setTimeout(() => { stop = true }, 20)
    await wait
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `returned after ${elapsed}ms, so a Pause mid-wait is honoured`)
  })

  test('it still waits the whole time when nothing stops it', async () => {
    const started = Date.now()
    await waitUnlessStopped(120, () => false, 10)
    assert.ok(Date.now() - started >= 100, 'a wait that nobody interrupts is still a wait')
  })

  test('an already-stopped wait does not sleep at all', async () => {
    const started = Date.now()
    await waitUnlessStopped(60_000, () => true, 5)
    assert.ok(Date.now() - started < 1_000, 'stop is checked before the first sleep, not after it')
  })
})

describe('every place that can start paid work reads the pause signal', () => {
  test('the image worker pool stops starting new items on pause', async () => {
    const body = await read('generators/images.ts')
    assert.match(body, /const shouldStopStarting = \(\) =>[\s\S]{0,120}isPauseRequested/,
      'runPool must have one predicate meaning "start nothing new" that includes pause')
    // The three places the old cancel-only predicate was consulted.
    for (const site of [
      /while \(cursor < items\.length\) \{\s*\n\s*if \(shouldStopStarting\(\) \|\| fatalError\) return/,
      /if \(cursor >= items\.length \|\| shouldStopStarting\(\) \|\| fatalError\) return/,
      /if \(!settled && \(shouldStopStarting\(\)/,
    ]) assert.match(body, site, `runPool still consults a cancel-only check at ${site}`)
  })

  test('image chain mode — the serial path — stops on pause too', async () => {
    const body = await read('generators/images.ts')
    assert.match(body, /for \(const scene of filteredScenes\) \{[\s\S]{0,400}?isPauseRequested\(job\.job_id\)\) break/,
      'chain mode had the same gap as the pool and must break on pause')
  })

  test('the image pool generator reads pause before each item', async () => {
    const body = await read('generators/image-pool-generate.ts')
    assert.match(body, /for \(const item of remaining\) \{[\s\S]{0,700}?throwIfPauseRequested\(job\.job_id\)/,
      'the item loop must not start another paid submit after Pause')
  })

  test('contextual cues honours pause during its pacing and cooldown waits', async () => {
    const body = await read('generators/contextual-cues.ts')
    assert.match(body, /async function waitWhileActive[\s\S]{0,400}?throwIfPauseRequested\(jobId\)/,
      'waitWhileActive read Cancel only, so a Pause mid-cooldown submitted anyway')
  })
})

describe('a paused run reports as paused, not as failed', () => {
  test('images raises JobPausedError before the completion audit', async () => {
    const body = await read('generators/images.ts')
    // Match the CALLS, not the import or the comments that mention them —
    // `requireJobCompletion` is imported at the top of the file, so a naive
    // indexOf finds line 30 and this test fails on correct code.
    const pauseAt = body.search(/^\s*jq\.throwIfPauseRequested\(job\.job_id\)\s*$/m)
    const auditAt = body.search(/^\s*requireJobCompletion\(job, \{/m)
    assert.ok(pauseAt > 0, 'images must raise the pause rather than fall through')
    assert.ok(auditAt > 0, 'the completion audit is still there')
    assert.ok(pauseAt < auditAt,
      'the pause must be raised BEFORE requireJobCompletion — otherwise the images the owner '
      + 'deliberately did not buy are reported as missing and his Pause is punished as a failure')
  })

  test('the queue settles JobPausedError as paused and clears the request', async () => {
    // Guards the other half of the contract these generators now depend on.
    const body = await read('services/job-queue.ts')
    assert.match(body, /instanceof JobPausedError \|\| pauseRequested\.has\(job\.job_id\)\) \{\s*\n\s*job\.status = 'paused'/,
      'a JobPausedError must settle the job as paused, not error')
  })
})

describe('the fleet-busy waits themselves end on pause', () => {
  test('subtitles no longer sleeps out its wait', async () => {
    const body = await read('generators/subtitles.ts')
    assert.match(body, /await waitUnlessStopped\(\s*\n?\s*delay,[\s\S]{0,160}?isPauseRequested/,
      'this was a bare setTimeout — up to five minutes with nothing watching')
    assert.doesNotMatch(body, /await new Promise\(resolve => setTimeout\(resolve, delay\)\)/,
      'the un-interruptible sleep must be gone, not merely wrapped')
  })

  test('the image fleet-busy wait ends on pause, and the route wait is untouched', async () => {
    const body = await read('generators/images.ts')
    // The fleet branch waits on a pause-aware predicate...
    assert.match(body, /if \(fleetBusy\) \{[\s\S]{0,260}?waitUnlessStopped\([\s\S]{0,200}?isPauseRequested/,
      'the fleet-busy wait must end on pause')
    // ...and the pre-existing route-exhaustion branch still uses the
    // cancel-only controller. Waking THAT early would turn its deliberately
    // paced retry into an immediate one, which is a different change nobody
    // asked for.
    assert.match(body, /\} else \{\s*\n\s*await delayUnlessAborted\(waitMs, cancelController\.signal\)/,
      'the route-exhaustion wait must stay exactly as it was')
  })
})

describe('one refused clip no longer ends the episode', () => {
  test('the motion batch catches per scene and carries on', async () => {
    // v1.4.35. `generateSceneClipsBatchJob` looped every scene with NO
    // per-scene catch, so a single failure on scene 3 of 50 threw out of the
    // batch and the remaining 47 were never attempted — not failed, not
    // reported, never tried. 1.4.31's fleet-busy wait made it survive a BUSY
    // moment; any other refusal still killed the run.
    const body = await read('generators/scene-clip.ts')
    const batch = body.slice(body.indexOf('export async function generateSceneClipsBatchJob'))
    assert.match(batch, /try \{\s*\n\s*await generateSceneClipJob\(job\)\s*\n\s*\} catch \(error\) \{/,
      'each scene must be attempted inside its own try/catch')
    assert.match(batch, /clipFailures\.push/, 'a failed scene must be recorded, not swallowed')
    assert.match(batch, /Continuing with the remaining scene\(s\)/,
      'and the owner must be told the run continued')
  })

  test('but cancel, pause and no-credit still stop the whole run', async () => {
    const body = await read('generators/scene-clip.ts')
    const batch = body.slice(body.indexOf('export async function generateSceneClipsBatchJob'))
    for (const rethrow of [
      /if \(error instanceof jq\.JobPausedError \|\| jq\.isPauseRequested\(job\.job_id\)\) throw error/,
      /if \(jq\.isCancelled\(job\.job_id\)\) throw error/,
      /if \(isGenStudioInsufficientCredits\(error\)\) throw error/,
    ]) assert.match(batch, rethrow,
      'continuing past this would be wrong: the owner stopped it, or every later scene fails identically')
  })

  test('the batch stops discarding its own recovery checkpoint', async () => {
    // `checkpointGenStudioAsset` writes onto whatever object job.params points
    // at — the PER-SCENE object here. Restoring originalParams wholesale threw
    // every checkpoint away, so batch-mode crash recovery lost the hints it is
    // made of. It cost no money (the retry identity comes from the on-disk task
    // manifest) but it cost recovery quality.
    const body = await read('generators/scene-clip.ts')
    const batch = body.slice(body.indexOf('export async function generateSceneClipsBatchJob'))
    assert.match(batch, /job\.params = \{\s*\n\s*\.\.\.job\.params,/,
      'the per-scene params must build ON the current params so the checkpoint accumulates')
    assert.match(batch, /genstudio_recovery: carried/,
      'and the accumulated checkpoint must be handed back, not dropped by the restore')
  })
})
