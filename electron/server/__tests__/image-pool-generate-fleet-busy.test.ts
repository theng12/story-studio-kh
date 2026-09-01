/**
 * Image Pool generation waits for a busy fleet (v1.4.34) — the eighth and last
 * generator to learn it.
 *
 * THE DEFECT. GenStudio places every job on a machine in the Mac-mini fleet, and
 * with none free it settles the job FAILED with `SITE_PLACEMENT_EXHAUSTED` after
 * a fifteen-minute placement window. Before this, `image-pool-generate.ts`
 * recorded that as an ordinary failure, added the filename to `failedFiles` and
 * moved on. The run does not die — which is precisely what makes it dangerous.
 * A pool grow of "40 images" quietly returns 31, and a pool has no script, no
 * scene list and no episode audit to notice by; only the final tally says how
 * many should have been there. The same code has already cost the owner 122 of
 * 353 transcription items in one burst on 22 August, and 5 TTS sections over
 * 13-15 August that nobody noticed for NINE DAYS.
 *
 * WHY RESUBMITTING IS SAFE, AND WHY NOTHING ELSE IS. GenStudio raises this code
 * from one place, having already held the job in that fifteen-minute window, and
 * states there what became of the money:
 *
 *   "The job never reached a worker, so there is nothing to settle: the
 *    reservation is returned whole."  — images/service.py, then billing.release()
 *
 * No provider was engaged and the credits came back, so another attempt is a
 * fresh charge for work that never happened — not a second charge for the same
 * work. The argument does not extend one inch further: a provider that WAS
 * engaged may already have rendered and billed the image, and resubmitting over
 * it charges the owner twice for one asset. A "Repair & Retry all" button was
 * removed in v1.0.114 for exactly that, which is why the refusals below matter
 * more than the single case that is allowed.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  IMAGE_POOL_GENSTUDIO_MODALITY,
  imagePoolFleetBusyRetryPlan,
} from '../generators/image-pool-generate.js'
import { FLEET_BUSY_RETRY_DELAYS_MS } from '../lib/genstudio-fleet-busy.js'
import {
  GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE,
  GenStudioImageTerminalFailureError,
  GenStudioTtsTerminalFailureError,
} from '../lib/genstudio-client.js'

const GENERATOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'image-pool-generate.ts')

/** A settled-failed GenStudio job with the reservation returned whole. */
const settled = (over: Record<string, unknown> = {}) => ({
  id: 'pool-job-dead-1', state: 'failed', cancelled: false,
  reserved_credits: 12, settled_credits: 0, released_credits: 12, ...over,
}) as any

const imageFailure = (over: Record<string, unknown> = {}) =>
  new GenStudioImageTerminalFailureError(settled(over))

/**
 * Assert on the generator's own text without printing 15KB of it on failure.
 *
 * The wiring below — where the retry sits relative to the per-item catch, that
 * both stop signals are re-read after the wait, that the next identity is
 * derived and not minted — has no return value to check: it is only observable
 * by driving a paid pool grow against a saturated fleet, which is exactly the
 * thing nobody will do before shipping. So it is pinned here instead.
 */
async function sourceProbe(): Promise<(needle: string, why: string) => void> {
  const source = await readFile(GENERATOR, 'utf8')
  return (needle, why) => assert.ok(source.includes(needle), `${why}\n  missing: ${needle}`)
}

describe('Image Pool: a busy fleet is worth asking again', () => {
  test('the modality comes from a live error instance, not a hopeful string', () => {
    // Asserted against a REAL error rather than the literal 'image', so an
    // upstream rename fails here instead of quietly turning the retry off:
    // `isFleetBusyFailure` would then match nothing, every busy-fleet item
    // would go back to being dropped, and there would be no symptom to notice
    // it by until a pool came back short again.
    assert.equal(
      imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }).modality,
      IMAGE_POOL_GENSTUDIO_MODALITY,
      'pool images fail as GenStudioImageTerminalFailureError; its modality is what the guard must be pinned to')
  })

  test('(a) a busy fleet with the credits returned whole earns another attempt', () => {
    // Both codes mean the same thing — no machine was free — and neither means
    // the image is impossible. Dropping the item here is what silently shrinks
    // the pool the owner asked for.
    for (const failure_code of ['SITE_PLACEMENT_EXHAUSTED', 'SITE_CAPACITY_UNAVAILABLE']) {
      const plan = imagePoolFleetBusyRetryPlan(imageFailure({ failure_code }), 1)
      assert.ok(plan, `${failure_code} must earn another attempt`)
      assert.match(plan.reason, /high demand right now/i)
      // Minutes, not seconds. GenStudio only declares this AFTER a fifteen-minute
      // placement window, so a two-second retry rejoins the same jam.
      assert.ok(plan.waitMs >= 30_000, 'a fleet wait is never a couple of seconds')
    }
  })

  test('(b) the same code with credits SETTLED is never resubmitted', () => {
    // Settled credits mean a provider was paid and may already have rendered
    // the image. Resubmitting over that charges the owner twice for one asset —
    // the single worst outcome this change could have — so a guarantee that can
    // no longer be verified stops the retry, whatever the failure code claims.
    assert.equal(imagePoolFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', settled_credits: 12, released_credits: 0,
    }), 1), null)
    assert.equal(imagePoolFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_CAPACITY_UNAVAILABLE', settled_credits: 3, released_credits: 9,
    }), 1), null)
  })

  test('(c) an unrelated failure is never retried as if the fleet were merely busy', () => {
    // A real fault repeats. Three backoffs would turn a clear, immediate error
    // into ten minutes of silence followed by the same clear error — worse for
    // the owner than failing at once, and it teaches him to distrust the log.
    for (const failure_code of ['CLOUD_PROVIDER_FAILED', 'CONTENT_BLOCKED', 'CLOUD_SUBMISSION_UNCERTAIN', null, '']) {
      assert.equal(
        imagePoolFleetBusyRetryPlan(imageFailure({ failure_code }), 1), null,
        `${String(failure_code)} may describe work a provider already did and billed`)
    }
    // Not even a declined ROUTE, which `generators/images.ts` does retry on its
    // own seconds-long schedule. Pool generation has never had that retry, and
    // reusing that generator's `imageRetryPlan` to save four lines would have
    // smuggled a second, unasked-for behaviour change into a fix about a busy
    // fleet.
    assert.equal(
      imagePoolFleetBusyRetryPlan(imageFailure({ failure_code: GENSTUDIO_ROUTE_EXHAUSTED_FAILURE_CODE }), 1),
      null)
    // Nor anything that is not a settled GenStudio failure at all — a socket
    // hang-up says nothing about whether a worker took the job.
    assert.equal(imagePoolFleetBusyRetryPlan(new Error('socket hang up'), 1), null)
    assert.equal(imagePoolFleetBusyRetryPlan(null, 1), null)
    assert.equal(imagePoolFleetBusyRetryPlan(undefined, 1), null)
  })

  test('(d) a cancelled job is the owner speaking; retrying it would overrule him', () => {
    assert.equal(imagePoolFleetBusyRetryPlan(imageFailure({
      failure_code: 'SITE_PLACEMENT_EXHAUSTED', cancelled: true,
    }), 1), null)
  })

  test('(e) a busy fleet in another modality is not licence to resubmit a pool image', () => {
    // A saturated TTS queue says nothing about whether THIS image's credits
    // came back, which is why the modality is passed to the shared guard rather
    // than left to match anything.
    const tts = new GenStudioTtsTerminalFailureError(settled({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' }))
    assert.notEqual(tts.modality, IMAGE_POOL_GENSTUDIO_MODALITY)
    assert.equal(imagePoolFleetBusyRetryPlan(tts, 1), null)
  })

  test('the waits are the shared minutes-long schedule, in order, and they run out', () => {
    const busy = imageFailure({ failure_code: 'SITE_PLACEMENT_EXHAUSTED' })
    for (let attemptNum = 1; attemptNum <= FLEET_BUSY_RETRY_DELAYS_MS.length; attemptNum++) {
      const plan = imagePoolFleetBusyRetryPlan(busy, attemptNum)
      assert.ok(plan)
      assert.equal(plan.waitMs, FLEET_BUSY_RETRY_DELAYS_MS[attemptNum - 1])
      assert.equal(plan.maxAttempts, FLEET_BUSY_RETRY_DELAYS_MS.length + 1)
    }
    // Bounded by the shared schedule's own length. An unbounded wait would hold
    // one item — and therefore the whole pool grow — open against a wall
    // forever, which is a worse failure than the one being fixed.
    assert.equal(imagePoolFleetBusyRetryPlan(busy, FLEET_BUSY_RETRY_DELAYS_MS.length + 1), null)
    assert.equal(imagePoolFleetBusyRetryPlan(busy, 99), null)
  })
})

describe('Image Pool: the retry does not change the shape of the run', () => {
  test('(f) an item that spends its waits fails, and the loop still moves on', async () => {
    const source = await readFile(GENERATOR, 'utf8')
    const has = await sourceProbe()

    // This generator ALREADY continues past a failed item — that is what made
    // the defect quiet rather than loud, and it is behaviour the fix must not
    // disturb. The attempt loop is nested INSIDE the per-item try/catch's own
    // iteration, so when `imagePoolFleetBusyRetryPlan` finally returns null the
    // item takes the identical path it takes today.
    has('let retryItem = true', 'the retry is a per-item attempt loop')
    has(`        if (!retryItem) {
          failed++
          failedFiles.add(item.filename)
          job.output_lines.push(paidReplacement
            ? jq.PAID_IMAGE_REPLACEMENT_PUBLIC_MESSAGE
            : \`✗ item \${item.index + 1} failed: \${e?.message || e}\`)
        }`, 'an exhausted item is recorded failed exactly as before, and the run carries on')

    // No `throw` was introduced into the item catch beyond the pre-existing
    // insufficient-credits rethrow, so one busy-fleet item can never end the
    // run for the rest.
    const itemCatch = source.split('} catch (e: any) {')[1] || ''
    const throws = itemCatch.match(/\bthrow\b/g) || []
    assert.equal(throws.length, 1,
      'the only throw in the item catch is the insufficient-credits rethrow; a second one would end the run')

    // And `requireJobCompletion` still sees exactly what it saw before —
    // `failedFiles` plus the on-disk check — so the report of what is missing is
    // unchanged apart from the items the retry genuinely rescued.
    has('for (const filename of failedFiles) if (!missing.includes(filename)) missing.push(filename)',
      'the completion report is untouched')

    // Progress is only advanced once an item has actually settled. Counting a
    // waiting item as done would report more images finished than exist on
    // disk — the same quiet miscount this whole change exists to stop.
    has(`      if (!retryItem) {
        processed++
        job.progress = Math.round((processed / total) * 90)
      }`, 'an item still waiting on the fleet has not settled and must not count')
  })

  test('(g) insufficient credits still rethrows first and is never treated as a busy fleet', async () => {
    const source = await readFile(GENERATOR, 'utf8')
    // Running out of money is not a busy fleet: there is nothing to wait for,
    // and sitting out ten minutes of backoff before telling him would be worse
    // than the original bug. The rethrow must stay the FIRST statement in the
    // catch, ahead of any manifest write or retry decision.
    const catchBody = source.split('} catch (e: any) {')[1] || ''
    const firstStatement = catchBody.split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('//'))[0]
    assert.equal(firstStatement, 'if (isGenStudioInsufficientCredits(e)) throw e',
      'the insufficient-credits rethrow must run before anything else in the catch')
    // Belt and braces on the rule itself: the shared guard only ever answers
    // yes for a settled GenStudio terminal failure, so an insufficient-credits
    // error cannot reach a retry plan even if the ordering above were lost.
    assert.equal(imagePoolFleetBusyRetryPlan(new Error('Insufficient credits'), 1), null)
  })
})

describe('Image Pool: the wait itself', () => {
  test('Cancel and Pause are honoured before, during and after the wait', async () => {
    const has = await sourceProbe()
    // Before: never commit to minutes of waiting on a run the owner has stopped.
    has('if (retryPlan && failedTaskId && !jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {',
      'a wait must not begin after Cancel or Pause')
    // During: the wait sleeps in slices and returns on either signal, so a stop
    // pressed four minutes into a five-minute wait is honoured in seconds.
    has('if (jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)) return',
      'a five-minute wait must notice Cancel or Pause within seconds')
    has('Math.min(2_000, deadline - Date.now())', 'and it must sleep in short slices to do so')
    // At the top of every attempt, not merely every item.
    has('Cancel is re-read at the top of EVERY attempt',
      'a resubmission must never start after the run was stopped')
    // After: re-read, because minutes passed and his last word wins.
    const source = await readFile(GENERATOR, 'utf8')
    const afterWait = source.split('await waitForFleetCapacity(retryPlan.waitMs)')[1] || ''
    assert.ok(
      afterWait.slice(0, 400).includes('if (!jq.isCancelled(job.job_id) && !jq.isPauseRequested(job.job_id)) {'),
      'the signals must be re-read after the wait, before another job is bought')
  })

  test('the resubmission uses a DERIVED identity, read back from disk', async () => {
    const has = await sourceProbe()
    const source = await readFile(GENERATOR, 'utf8')

    // A settled-failed GenStudio job can never be reopened — replaying its
    // idempotency key returns the same failure forever — so every attempt needs
    // a new one. It is DERIVED, not minted: the failed entry is written to the
    // manifest first, and the next attempt re-READS the manifest from disk and
    // promotes the scope through the same deterministic `resolveImageRetryScope`
    // a manual Retry uses. A crash mid-wait therefore replays the identical
    // request instead of buying a second image.
    has("}, 'failed', true)", 'the settled failure reaches disk strictly before the retry is decided')
    has('const manifest = await readManifest(pool.folder_path)',
      'and the next attempt reads it back from disk, not from a stale in-memory copy')
    has('let logicalScope = resolveImageRetryScope(retryEntry, baseScope).scope',
      'the promoted scope is derived from the dead job id')
    assert.doesNotMatch(source, /randomUUID/)
    assert.doesNotMatch(source, /Math\.random/)

    // Without a dead job id the scope cannot move, and the retry would replay a
    // settled-failed key against GenStudio for as long as the ladder allows.
    has('retryPlan && failedTaskId', 'no dead job id means no promotable scope, so no retry')

    // The rule is the shared one, not a local copy that can drift away from the
    // seven other generators that must agree about what is free to retry.
    assert.match(source, /from '\.\.\/lib\/genstudio-fleet-busy\.js'/)
    has('isFleetBusyFailure(e, IMAGE_POOL_GENSTUDIO_MODALITY)', 'and it is asked with this generator\'s modality')

    // Said in words the owner can read in the job output, because "nothing was
    // charged" is the one part he would otherwise have to take on faith.
    has('nothing was charged', 'the log must say plainly that this cost him nothing')
  })

  test('nothing external can cancel this generator\'s own wait', async () => {
    // The job queue's stall circuit breaker — which a fleet wait is exactly the
    // thing to trip — has one caller in the app, continuity-render.ts, which had
    // to suppress its own. This generator owns no such timer and nothing
    // external watches it, so there is nothing to suppress. This test fails the
    // day one is added without teaching it about the wait.
    const source = await readFile(GENERATOR, 'utf8')
    assert.ok(!/pauseJobForStall|setInterval/.test(source),
      'a stall watchdog here would cancel the very wait this fix depends on')
  })
})
