import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * v1.4.82 — infrastructure shape is internal.
 *
 * The owner opened a job card and read: "Scene 296: every machine was busy —
 * nothing was charged. Waiting 30s and trying again (attempt 2 of 4)." His
 * ruling: a customer must not be able to infer how many machines, workers or
 * sites we run, nor how saturated they are, from anything we show them.
 *
 * The honest half of that sentence stays — what happened to their money, and
 * that we are retrying. Only the capacity framing goes. "High demand right now"
 * says the same operational thing without describing an estate.
 *
 * This file guards the SOURCE of those strings: the retry `reason` values that
 * reach the card as `item_progress.active[].reason`, and the log lines the
 * capacity-refusal paths push into `output_lines`. It is deliberately scoped to
 * those paths — a blanket repo scan would accuse "on this machine" (the
 * customer's own Mac, which they should be told about) and the internal code
 * comments that quote GenStudio's own documentation.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(HERE, '..')

/** Terms that describe our estate. None may reach a customer-visible string. */
const FORBIDDEN = /\b(machine|machines|worker|workers|fleet|site|sites|placement window)\b/i

/** Every generator that surfaces a capacity refusal to the customer. */
const CAPACITY_SOURCES = [
  'generators/scene-clip.ts',
  'generators/audio.ts',
  'generators/music-generate.ts',
  'generators/images.ts',
  'generators/image-pool-generate.ts',
  'generators/continuity-render.ts',
  'generators/contextual-cues.ts',
  'generators/subtitles.ts',
  'generators/scene-plan.ts',
  'services/job-retry-policy.ts',
]

/**
 * The string literals a customer can actually read: retry `reason:` values and
 * anything pushed into a job's `output_lines`. Comments are excluded — they are
 * for us, and several of them quote GenStudio's own wording on purpose.
 */
function customerVisibleStrings(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const found: string[] = []
  const reasons = withoutComments.matchAll(/reason:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)
  for (const m of reasons) found.push(m[2]!)
  const pushes = withoutComments.matchAll(/output_lines\.push\(([\s\S]*?)\n\s*\)/g)
  for (const m of pushes) {
    for (const lit of m[1]!.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) found.push(lit[2]!)
  }
  const policies = withoutComments.matchAll(/localPolicy\((['"`])((?:\\.|(?!\1)[\s\S])*?)\1\)/g)
  for (const m of policies) found.push(m[2]!)
  return found
}

describe('customer-facing capacity wording (v1.4.82)', () => {
  test('no customer-visible string describes our machines, workers, sites or fleet', async () => {
    const offenders: string[] = []
    for (const relative of CAPACITY_SOURCES) {
      const source = await readFile(path.join(SERVER_ROOT, relative), 'utf-8')
      for (const value of customerVisibleStrings(source)) {
        // The customer's OWN Mac is a thing they must be told about — that is
        // not our infrastructure, and saying so is the whole point of the line.
        if (/\bon this machine\b|\bthis machine\b/i.test(value)) continue
        if (FORBIDDEN.test(value)) offenders.push(`${relative}: ${value}`)
      }
    }
    assert.deepEqual(offenders, [], `customer-visible strings leaking infrastructure shape:\n${offenders.join('\n')}`)
  })

  test('the extractor actually finds the strings it is meant to guard', async () => {
    // Calibration: a checker that matches nothing would pass the test above
    // while protecting nothing at all.
    const source = await readFile(path.join(SERVER_ROOT, 'generators/scene-clip.ts'), 'utf-8')
    const values = customerVisibleStrings(source)
    assert.ok(values.length >= 3, `expected several customer-visible strings, found ${values.length}`)
    assert.ok(
      values.some(v => /high demand right now/i.test(v)),
      'the rephrased capacity reason must be among the strings the guard inspects',
    )
  })

  test('remote prose describing our estate is replaced, not word-substituted', async () => {
    const { customerSafeRemoteDetail } = await import('../lib/genstudio-client.js')
    // The exact shape the owner saw on a card.
    assert.equal(
      customerSafeRemoteDetail('waiting for a worker; no site has accepted this job yet; placement window closes at 14:32'),
      'Queued — waiting for capacity; automatic escalation at 14:32.',
    )
    // No time in the original → no invented time in the replacement.
    assert.equal(
      customerSafeRemoteDetail('All machines in the fleet are busy.'),
      'Queued — waiting for capacity. Nothing failed and nothing was charged.',
    )
    // A single-digit hour is normalised rather than printed as "9:05".
    assert.match(customerSafeRemoteDetail('no site free; window closes 9:05'), /at 09:05\.$/)
  })

  test('detail that says nothing about our estate is left exactly as written', async () => {
    const { customerSafeRemoteDetail } = await import('../lib/genstudio-client.js')
    for (const passthrough of [
      'No eligible route accepted this request.',
      'The provider returned an empty response.',
      'Your account is already running as many jobs at once as its plan allows.',
      '',
    ]) {
      assert.equal(customerSafeRemoteDetail(passthrough), passthrough)
    }
  })

  test('the capacity refusal still tells the customer about their money and the retry', async () => {
    // Rephrasing must not quietly drop the two facts that matter to them.
    const clip = await readFile(path.join(SERVER_ROOT, 'generators/scene-clip.ts'), 'utf-8')
    assert.match(clip, /nothing was charged and the credits were returned/)
    assert.match(clip, /trying again/)
    const subtitles = await readFile(path.join(SERVER_ROOT, 'generators/subtitles.ts'), 'utf-8')
    assert.match(subtitles, /so no charge was made/)
    assert.match(subtitles, /attempt \$\{fleetBusyAttempt\} of/)
  })
})
