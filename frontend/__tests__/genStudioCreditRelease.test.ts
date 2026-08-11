/**
 * Behavioural cover for the "on hold 13 credits" bug.
 *
 * GenStudio had already released those reservations; the UI kept claiming they
 * were held because every "held" calculation fell back to `credit_cost` when no
 * authoritative reservation was published — and for image jobs one never is
 * (`ImageJobResponse` exposes only `credit_cost` and `remaining_credits`; the
 * reserved/settled/released triad lives on `GET /v1/account/jobs`).
 *
 * These tests execute the REAL functions shipped inside the SFC / page rather
 * than a copy of them: the named declarations are lifted out of the source file
 * and evaluated, so re-introducing the `credit_cost` fallback fails here.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const root = resolve(process.cwd(), '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

/** Lift a `function name(...) { ... }` declaration out of a source file verbatim. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `expected to find function ${name}`)
  const bodyStart = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated function ${name}`)
}

/** Lift a queue-label object literal so assertions execute the shipped map. */
function extractObject(source: string, name: string): string {
  const start = source.indexOf(`const ${name}:`)
  assert.notEqual(start, -1, `expected to find ${name}`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated ${name}`)
}

let moduleSeq = 0

/** Evaluate lifted declarations as a real TS module (tsx transpiles it). */
async function loadLifted(prelude: string, declarations: string[], exports: string[]): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), 'story-credit-'))
  const file = join(dir, `lifted-${moduleSeq++}.ts`)
  writeFileSync(file, `${prelude}\n${declarations.join('\n\n')}\nexport { ${exports.join(', ')} }\n`, 'utf8')
  return import(pathToFileURL(file).href)
}

const FAILED_IMAGE_JOB = {
  id: 'gs-image-1',
  operation: 'image.generation',
  state: 'failed',
  queue_state: 'failed',
  // Exactly what a real terminal image job carries: a quote, and nothing else.
  credit_cost: 13,
  failure_code: 'provider_error',
}

describe('GenStudio released reservations are never shown as held', () => {
  it('keeps a reserved job with a transient diagnostic code active and on hold', async () => {
    const source = read('frontend/components/GenStudioBatchLedger.vue')
    const ledger = await loadLifted(
      'type RemoteJob = any',
      ['numeric', 'effectiveState', 'stateBucket', 'chargedFor', 'returnedFor', 'isReleased', 'heldFor']
        .map(name => extractFunction(source, name)),
      ['stateBucket', 'isReleased', 'heldFor'],
    )
    const transientVoiceReference = {
      id: 'gs-voice-reference-1',
      operation: 'voice.tts',
      state: 'RESERVED',
      reserved_credits: 13,
      failure_code: 'VOICE_REFERENCE_ASSET_MISSING',
    }

    assert.equal(ledger.stateBucket(transientVoiceReference), 'active')
    assert.equal(ledger.isReleased(transientVoiceReference), false)
    assert.equal(ledger.heldFor(transientVoiceReference), 13)

    const hintSource = read('frontend/components/GenStudioCreditSettlementHint.vue')
    const hint = await loadLifted(
      'type RemoteJob = any',
      [extractFunction(hintSource, 'stateBucket')],
      ['stateBucket'],
    )
    assert.equal(hint.stateBucket(transientVoiceReference), 'active')
  })

  it('does not mark a reserved voice-reference job as failed in compact job views', async () => {
    const transientVoiceReference = {
      id: 'gs-voice-reference-compact',
      operation: 'voice.tts',
      state: 'RESERVED',
      reserved_credits: 13,
      failure_code: 'VOICE_REFERENCE_ASSET_MISSING',
    }

    const previewSource = read('frontend/components/GenStudioRequestPreview.vue')
    const preview = await loadLifted(
      'type RemoteJob = any',
      [extractFunction(previewSource, 'effectiveState'), extractFunction(previewSource, 'stateClass')],
      ['stateClass'],
    )
    assert.equal(preview.stateClass(transientVoiceReference), 'is-active')

    const jobsSource = read('frontend/pages/projects/[slug]/jobs.vue')
    const declarations = [
      'genStudioNumeric',
      'genStudioCreditState',
      'genStudioSettled',
      'genStudioTerminalFailure',
      'genStudioChargedCredits',
      'genStudioReturnedCredits',
      'genStudioHeldCredits',
      'genStudioReservationReleased',
    ]
      .map(name => extractFunction(jobsSource, name))
      .map(text => text.replace(/NonNullable<RJob\['genstudio_jobs'\]>\[number\]/g, 'any'))
    const jobs = await loadLifted(
      [
        'type GenStudioSettlement = { reserved_credits?: number; settled_credits?: number; released_credits?: number }',
        'const genStudioSettlement: { value: Record<string, GenStudioSettlement> } = { value: {} }',
      ].join('\n'),
      declarations,
      ['genStudioTerminalFailure', 'genStudioHeldCredits', 'genStudioReservationReleased'],
    )
    assert.equal(jobs.genStudioTerminalFailure(transientVoiceReference), false)
    assert.equal(jobs.genStudioHeldCredits(transientVoiceReference), 13)
    assert.equal(jobs.genStudioReservationReleased(transientVoiceReference), false)
  })

  it('shows provider states in product English when Story has not assigned a local queue state', async () => {
    const cases = [
      ['reserved', 'Reserved'],
      ['dispatched', 'Dispatched'],
      ['validating', 'Validating'],
      ['reconciling', 'Reconciling'],
    ] as const

    const previewSource = read('frontend/components/GenStudioRequestPreview.vue')
    const preview = await loadLifted(
      'type RemoteJob = any',
      [
        extractObject(previewSource, 'QUEUE_LABELS'),
        extractFunction(previewSource, 'effectiveState'),
        extractFunction(previewSource, 'displayState'),
      ],
      ['displayState'],
    )

    const ledgerSource = read('frontend/components/GenStudioBatchLedger.vue')
    const ledger = await loadLifted(
      'type RemoteJob = any',
      [
        extractObject(ledgerSource, 'QUEUE_LABELS'),
        extractFunction(ledgerSource, 'effectiveState'),
        extractFunction(ledgerSource, 'displayState'),
      ],
      ['displayState'],
    )

    const jobsSource = read('frontend/pages/projects/[slug]/jobs.vue')
    const jobs = await loadLifted(
      'type RJob = any',
      [
        extractObject(jobsSource, 'GENSTUDIO_QUEUE_LABELS'),
        extractFunction(jobsSource, 'genStudioQueueLabel'),
      ],
      ['genStudioQueueLabel'],
    )

    for (const [state, label] of cases) {
      assert.equal(preview.displayState({ state }), label)
      assert.equal(ledger.displayState({ state }), label)
      assert.equal(jobs.genStudioQueueLabel({ state: state.toUpperCase() }), label)
    }
  })

  it('keeps Story-owned queue_state ahead of a provider state', async () => {
    const remote = { state: 'reserved', queue_state: 'accepted' }
    const previewSource = read('frontend/components/GenStudioRequestPreview.vue')
    const preview = await loadLifted(
      'type RemoteJob = any',
      [
        extractObject(previewSource, 'QUEUE_LABELS'),
        extractFunction(previewSource, 'effectiveState'),
        extractFunction(previewSource, 'displayState'),
      ],
      ['displayState'],
    )
    const ledgerSource = read('frontend/components/GenStudioBatchLedger.vue')
    const ledger = await loadLifted(
      'type RemoteJob = any',
      [
        extractObject(ledgerSource, 'QUEUE_LABELS'),
        extractFunction(ledgerSource, 'effectiveState'),
        extractFunction(ledgerSource, 'displayState'),
      ],
      ['displayState'],
    )
    const jobsSource = read('frontend/pages/projects/[slug]/jobs.vue')
    const jobs = await loadLifted(
      'type RJob = any',
      [
        extractObject(jobsSource, 'GENSTUDIO_QUEUE_LABELS'),
        extractFunction(jobsSource, 'genStudioQueueLabel'),
      ],
      ['genStudioQueueLabel'],
    )

    assert.equal(preview.displayState(remote), 'Accepted')
    assert.equal(ledger.displayState(remote), 'Accepted')
    assert.equal(jobs.genStudioQueueLabel(remote), 'Accepted')
  })

  it('offers Reword guidance only for GenStudio\'s exact terminal image-refusal code', async () => {
    const source = read('frontend/components/GenStudioBatchLedger.vue')
    const ledger = await loadLifted(
      'type RemoteJob = any',
      ['effectiveState', 'stateBucket', 'isImageContentRefused']
        .map(name => extractFunction(source, name)),
      ['isImageContentRefused'],
    )

    assert.match(source, /remote\.failure_code === 'IMAGE_CONTENT_REFUSED'/)
    assert.match(source, /use Reword/i)
    assert.doesNotMatch(source, /failure_code\s*&&/)
    assert.equal(ledger.isImageContentRefused({
      operation: 'image.generation', state: 'failed', failure_code: 'IMAGE_CONTENT_REFUSED',
    }), true)
    assert.equal(ledger.isImageContentRefused({
      operation: 'image.generation', state: 'failed', failure_code: 'image_content_refused',
    }), false, 'a provider-text variation must not become refusal guidance')
    assert.equal(ledger.isImageContentRefused({
      operation: 'image.generation', state: 'reserved', failure_code: 'IMAGE_CONTENT_REFUSED',
    }), false, 'a diagnostic code does not override a non-terminal state')
  })

  it('batch ledger: a terminal failed image job reads as released, not on hold', async () => {
    const source = read('frontend/components/GenStudioBatchLedger.vue')
    const ledger = await loadLifted(
      'type RemoteJob = any',
      ['numeric', 'effectiveState', 'stateBucket', 'chargedFor', 'returnedFor', 'isReleased', 'heldFor']
        .map(name => extractFunction(source, name)),
      ['chargedFor', 'returnedFor', 'isReleased', 'heldFor'],
    )

    assert.equal(ledger.heldFor(FAILED_IMAGE_JOB), 0, 'a failed job holds nothing')
    assert.equal(ledger.chargedFor(FAILED_IMAGE_JOB), 0, 'a failed job is not charged')
    assert.equal(ledger.isReleased(FAILED_IMAGE_JOB), true)

    // An in-flight job with no published reservation is unknown, not held.
    assert.equal(ledger.heldFor({ ...FAILED_IMAGE_JOB, state: 'running', queue_state: 'running', failure_code: null }), 0)
    // …and a published reservation still shows, because that one is authoritative.
    assert.equal(
      ledger.heldFor({ state: 'running', queue_state: 'running', credit_cost: 13, reserved_credits: 13 }),
      13,
    )
    // Authoritative released credits from the account snapshot are surfaced.
    assert.equal(ledger.returnedFor({ ...FAILED_IMAGE_JOB, released_credits: 13 }), 13)
    assert.equal(ledger.returnedFor({ ...FAILED_IMAGE_JOB, returned_credits: 11 }), 11)
  })

  it('batch ledger template offers a released state instead of a fabricated hold', () => {
    const source = read('frontend/components/GenStudioBatchLedger.vue')

    assert.match(source, /reservation.{0,3}released|reservations.{0,3}released/i)
    // The credit_cost fallback is what invented the hold — it must stay gone.
    assert.doesNotMatch(source, /held > 0 \? held : numeric\(remote\.credit_cost\)/)
  })

  it('jobs page: held credits require a published reservation', async () => {
    const source = read('frontend/pages/projects/[slug]/jobs.vue')
    const names = [
      'genStudioNumeric',
      'genStudioCreditState',
      'genStudioSettled',
      'genStudioTerminalFailure',
      'genStudioChargedCredits',
      'genStudioReturnedCredits',
      'genStudioHeldCredits',
      'genStudioReservationReleased',
    ]
    const declarations = names
      .map(name => extractFunction(source, name))
      // The lifted helpers only need the runtime shape, not the page's types.
      .map(text => text.replace(/NonNullable<RJob\['genstudio_jobs'\]>\[number\]/g, 'any'))
    const page = await loadLifted(
      [
        'type GenStudioSettlement = { reserved_credits?: number; settled_credits?: number; released_credits?: number }',
        // The lifted helpers only ever read `.value`, so a plain box stands in
        // for the page's ref without dragging Vue into a temp module.
        'const genStudioSettlement: { value: Record<string, GenStudioSettlement> } = { value: {} }',
      ].join('\n'),
      declarations,
      [...names, 'genStudioSettlement'],
    )

    assert.equal(page.genStudioHeldCredits(FAILED_IMAGE_JOB), 0, 'the reported bug: 13 credits shown on hold')
    assert.equal(page.genStudioReservationReleased(FAILED_IMAGE_JOB), true)
    assert.equal(page.genStudioChargedCredits(FAILED_IMAGE_JOB), 0)

    // No authoritative reservation ⇒ nothing is claimed to be on hold.
    const running = { id: 'gs-image-2', state: 'running', queue_state: 'running', credit_cost: 13 }
    assert.equal(page.genStudioHeldCredits(running), 0)
    assert.equal(page.genStudioHeldCredits({ ...running, reserved_credits: 13 }), 13)

    // The account-jobs snapshot is authoritative when present; direct Image and
    // Video released credits are the fallback when no account entry exists.
    page.genStudioSettlement.value = { 'gs-image-1': { reserved_credits: 13, settled_credits: 0, released_credits: 13 } }
    assert.equal(page.genStudioReturnedCredits(FAILED_IMAGE_JOB), 13)
    assert.equal(page.genStudioHeldCredits(FAILED_IMAGE_JOB), 0)
    assert.equal(page.genStudioReservationReleased(FAILED_IMAGE_JOB), false, 'a published amount replaces the generic label')
  })

  it('jobs page: provider-published Image and Video releases take priority without an account snapshot', async () => {
    const source = read('frontend/pages/projects/[slug]/jobs.vue')
    const names = [
      'genStudioNumeric',
      'genStudioCreditState',
      'genStudioSettled',
      'genStudioTerminalFailure',
      'genStudioChargedCredits',
      'genStudioReturnedCredits',
      'genStudioHeldCredits',
      'genStudioReservationReleased',
    ]
    const declarations = names
      .map(name => extractFunction(source, name))
      .map(text => text.replace(/NonNullable<RJob\['genstudio_jobs'\]>\[number\]/g, 'any'))
    const page = await loadLifted(
      [
        'type GenStudioSettlement = { reserved_credits?: number; settled_credits?: number; released_credits?: number }',
        'const genStudioSettlement: { value: Record<string, GenStudioSettlement> } = { value: {} }',
      ].join('\n'),
      declarations,
      ['genStudioReturnedCredits', 'genStudioHeldCredits', 'genStudioReservationReleased'],
    )

    const cases = [
      { id: 'gs-image-direct-release', operation: 'image.generation', released_credits: 13 },
      { id: 'gs-video-direct-release', operation: 'video.generation', released_credits: 8 },
    ]
    for (const remote of cases) {
      assert.equal(page.genStudioReturnedCredits({ ...remote, state: 'failed', queue_state: 'failed' }), remote.released_credits)
      assert.equal(page.genStudioHeldCredits({ ...remote, state: 'failed', queue_state: 'failed' }), 0)
      assert.equal(page.genStudioReservationReleased({ ...remote, state: 'failed', queue_state: 'failed' }), false)
    }

    const omitted = { id: 'gs-image-no-release', operation: 'image.generation', state: 'failed', queue_state: 'failed' }
    assert.equal(page.genStudioReturnedCredits(omitted), 0)
    assert.equal(page.genStudioReservationReleased(omitted), true)
  })

  it('settlement hint stops calling an unpublished quote a hold', () => {
    const source = read('frontend/components/GenStudioCreditSettlementHint.vue')

    assert.doesNotMatch(source, /numeric\(remote\.credit_cost\) > 0/)
    assert.match(source, /releases their reservation/)
    assert.match(source, /Failed items are not charged a second time/)
  })
})
