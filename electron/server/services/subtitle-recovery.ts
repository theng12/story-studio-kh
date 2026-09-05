/** One durable subtitle recovery boundary, shared by merged and section transcription. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import {
  buildGenStudioTranscriptionIdempotencyKey, GenStudioApiError,
  GenStudioTerminalFailureError, GenStudioArtifactUnavailableError,
  GenStudioTranscriptionQuoteExpiredError, getGenStudioJobByIdempotencyKey,
  recoverTranscriptionWithGenStudio, transcribeWithGenStudio,
  type GenStudioTranscriptionRequest, type GenStudioTranscriptionQuote,
} from '../lib/genstudio-client.js'
import { isFleetBusyFailure, FLEET_BUSY_FAILURE_CODES, FLEET_BUSY_RETRY_DELAYS_MS, waitUnlessStopped } from '../lib/genstudio-fleet-busy.js'
import { getAppSetting, getGenStudioUrl, PAID_SUBTITLE_REPLACEMENT_KEY, withPaidSubtitleConfirmation } from './app-settings.js'
import { readManifestStrict, recordTaskStrict } from './task-manifest.js'
import { checkpointGenStudioAsset, type GenStudioRecoveryState } from './genstudio-recovery.js'
import * as jq from './job-queue.js'
import { classifySubtitleFailure, decideSubtitleReplacement, type SubtitleReplacementAttempt, type SubtitleReplacementInput } from './subtitle-paid-replacement.js'
import type { Job } from '../models/types.js'

interface Commitment extends SubtitleReplacementAttempt {
  taskId?: string
  quoteId: string
  committedAt: string
  ceiling: number
  authorization: 'automatic' | 'manual'
}
interface Section {
  section: string
  planId: string
  ownerJobId: string
  inputHash: string
  outputPath: string
  idempotencyKey: string
  taskId: string
  submittedAt: string
  state: string
  identityVerified: boolean
  confirmStarted?: boolean
  freeRetries: number
  /** A confirmed fully refunded attempt may replay its authorization for free. */
  freeRetryFromKey?: string
  replacement?: {
    originalTaskId: string
    originalIdempotencyKey: string
    failure: SubtitleReplacementInput['failure']
  }
}
interface Ledger {
  version: 1
  activePlanId?: string
  sections: Record<string, Section>
  plans: Record<string, { attempts: Commitment[] }>
}
type ManualAction = false | 'buy_missing_subtitles' | 'rerun_subtitle_section'

function subtitleFailure(error: GenStudioTerminalFailureError): SubtitleReplacementInput['failure'] {
  return {
    transient: error.failureClass === 'provider_transient' || isFleetBusyFailure(error, 'transcription'),
    cancelled: error.cancelled, reservedCredits: error.reservedCredits,
    settledCredits: error.settledCredits, releasedCredits: error.releasedCredits,
  }
}

async function readLedger(file: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Ledger
    const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0
    const credits = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
    if (parsed.version !== 1 || !parsed.sections || !parsed.plans || Array.isArray(parsed.sections) || Array.isArray(parsed.plans)
      || Object.values(parsed.plans).some(plan => !Array.isArray(plan.attempts) || plan.attempts.some(a =>
        !a || ![a.section, a.originalTaskId, a.originalIdempotencyKey, a.inputHash, a.outputPath,
          a.idempotencyKey, a.priceVersion, a.quoteId, a.committedAt].every(text)
        || a.replacementOrdinal !== 1 || !credits(a.quotedCredits) || !Number.isSafeInteger(a.ceiling) || a.ceiling < 1))
      || Object.values(parsed.sections).some(s => !s || ![s.section, s.planId, s.ownerJobId, s.inputHash,
        s.outputPath, s.idempotencyKey, s.submittedAt, s.state].every(text)
        || !parsed.plans[s.planId] || typeof s.taskId !== 'string' || typeof s.identityVerified !== 'boolean'
        || !Number.isSafeInteger(s.freeRetries) || s.freeRetries < 0
        || (s.confirmStarted !== undefined && typeof s.confirmStarted !== 'boolean')
        || (s.freeRetryFromKey !== undefined && (!text(s.freeRetryFromKey) || !s.replacement))
        || (s.replacement !== undefined && (!s.replacement || s.identityVerified !== true
          || ![s.replacement.originalTaskId, s.replacement.originalIdempotencyKey].every(text)
          || !s.replacement.failure || typeof s.replacement.failure.transient !== 'boolean'
          || typeof s.replacement.failure.cancelled !== 'boolean'
          || classifySubtitleFailure(s.replacement.failure) !== 'paid'
          || !validReplacementKey(s)
          || parsed.plans[s.planId]!.attempts.some(a => a.section === s.section
            && (a.originalTaskId !== s.replacement!.originalTaskId
              || a.originalIdempotencyKey !== s.replacement!.originalIdempotencyKey
              || a.inputHash !== s.inputHash || a.outputPath !== s.outputPath)))))) {
      throw new Error('Invalid subtitle recovery ledger; repair its saved identity before buying work.')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sections: {}, plans: {} }
    throw error // Corrupt authority is never an empty budget.
  }
}

/** A saved replacement key must descend from its original, not arbitrary authority. */
function validReplacementKey(section: Section): boolean {
  let key = `story-stt-${createHash('sha256').update(`${section.replacement!.originalIdempotencyKey}:subtitle-replacement:1`).digest('hex')}`
  // freeRetries includes retries before replacement; it is an upper bound here.
  for (let retry = 0; retry <= section.freeRetries; retry++) {
    if (key === section.idempotencyKey) return true
    key = `story-stt-${createHash('sha256').update(`${key}:free-retry`).digest('hex')}`
  }
  return false
}

export interface SubtitleRecoveryInput {
  job: Job
  outDir: string
  section: string
  manifestKey: string
  inputHash: string
  audioHash: string
  apiKey: string
  force: boolean
  /** Only the explicit manual purchase route supplies this, never pipeline defaults. */
  manualCreditCeiling?: number
  request: GenStudioTranscriptionRequest
}

/** The purchase button cannot widen a failed job to the whole episode. */
export function subtitlePurchaseParams(job: Job, ceiling: unknown): Job['params'] {
  if (job.type !== 'subtitles_transcribe' || !['error', 'needs_attention'].includes(job.status)) {
    throw new Error('Buy missing subtitles requires a failed subtitle job.')
  }
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) {
    throw new Error('Review and supply a positive whole-number subtitle credit ceiling.')
  }
  const missing = job.result?.missing_sections
  if (!Array.isArray(missing) || !missing.length || missing.some(s => typeof s !== 'string' || !s.trim())) {
    throw new Error('No exact missing subtitle sections are recorded; recover the failed job first.')
  }
  return { ...job.params, force: false, sections: [...missing], subtitle_purchase: { additional_credit_ceiling: ceiling } }
}

export async function runSubtitleTranscription(input: SubtitleRecoveryInput): Promise<{ srt: string; jobId: string; modelId: string }> {
  const { job, outDir, section, manifestKey } = input
  const file = path.resolve(outDir, '.subtitle-recovery.json')
  // ponytail: one in-process owner per output; the desktop backend is single-instance.
  return withLock(`${file}:${manifestKey}`, async () => {
    const manifestAtStart = await readManifestStrict(outDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: {} } as Awaited<ReturnType<typeof readManifestStrict>>
      throw error
    })
    const change = <T>(fn: (ledger: Ledger) => T): Promise<T> => withLock(file, async () => {
      const ledger = await readLedger(file)
      const result = fn(ledger)
      await fs.mkdir(outDir, { recursive: true })
      await writeJsonAtomic(file, ledger)
      return result
    })
    let prior: Section | undefined
    let current = await change(ledger => {
      const saved = ledger.sections[manifestKey]
      prior = saved
      ledger.activePlanId ||= String(job.params.subtitle_recovery_plan_id || job.job_id)
      if (input.force && saved && saved.ownerJobId !== job.job_id) ledger.activePlanId = job.job_id
      if (saved && saved.inputHash === input.inputHash
        && (!input.force || saved.ownerJobId === job.job_id)) return saved
      return null
    })
    let freshCurrent = false
    if (!current) {
      const saved = manifestAtStart.tasks[manifestKey]
      const reuse = !input.force && saved?.provider === 'genstudio'
        && (saved.input_hash === input.inputHash || saved.input_hash === input.audioHash) ? saved : null
      freshCurrent = !reuse
      const key = reuse?.idempotency_key || buildGenStudioTranscriptionIdempotencyKey({
        requestIdentity: input.force && (saved || prior) ? `${input.request.requestIdentity}:manual-rerun:${job.job_id}` : input.request.requestIdentity,
        fileSha256: input.audioHash.replace(/^sha256:/, ''), modelId: input.request.modelId,
        language: input.request.language, wordTimestamps: input.request.wordTimestamps,
      })
      current = {
        section, planId: await change(ledger => ledger.activePlanId!), ownerJobId: job.job_id,
        inputHash: input.inputHash, outputPath: path.join(outDir, manifestKey),
        idempotencyKey: key, taskId: reuse?.task_id || '', submittedAt: reuse?.submitted_at || new Date().toISOString(),
        state: reuse?.last_state || 'prepared', freeRetries: 0,
        identityVerified: !reuse || (!!reuse.idempotency_key && reuse.input_hash === input.inputHash),
        // A legacy key with no task is an ambiguous submission, not fresh authority.
        confirmStarted: !!reuse?.idempotency_key && !reuse.task_id,
      }
      await change(ledger => {
        ledger.sections[manifestKey] = current!
        ledger.plans[current!.planId] ||= { attempts: [] }
      })
    }
    const savedAtStart = manifestAtStart.tasks[manifestKey]
    // Never let a persisted ledger rewrite the independent manifest binding.
    let mayWriteManifest = freshCurrent || (savedAtStart?.provider === 'genstudio'
      && savedAtStart.input_hash === input.inputHash && savedAtStart.idempotency_key === current.idempotencyKey
      && (!savedAtStart.task_id || savedAtStart.task_id === current.taskId))
    const stopped = () => input.request.signal?.aborted || jq.isCancelled(job.job_id) || jq.isPauseRequested(job.job_id)
    const state = async (code: string, message: string, manual: ManualAction = false) => {
      job.params.subtitle_recovery_plan_id = current!.planId
      const projection = job.params.subtitle_recovery ||= { sections: {} }
      projection.sections[section] = { state: code, message, ...(manual ? { manual_action: manual } : {}) }
      job.output_lines.push(`${section}: ${message}`)
      await jq.checkpointJobState(job)
    }
    const block = async (reason: string, manual: ManualAction = false, code = 'paid_blocked'): Promise<never> => {
      job.result = { ...job.result, complete: false, recovery_state: 'needs_attention',
        missing_sections: [...new Set([...(job.result?.missing_sections || []), section])] }
      await state(code, reason, manual)
      throw new Error(`${section}: ${reason}`)
    }
    const persist = async (providerState = current!.state) => {
      current!.state = providerState
      await change(ledger => {
        ledger.sections[manifestKey] = current!
        const attempt = ledger.plans[current!.planId]?.attempts.find(a => a.section === section)
        if (attempt && current!.replacement) {
          if (current!.taskId) attempt.taskId = current!.taskId
          if (providerState === 'succeeded' || providerState === 'failed') attempt.state = providerState
          else if (current!.taskId) attempt.state = 'submitted'
        }
      })
      if (mayWriteManifest) await recordTaskStrict(outDir, manifestKey, {
        provider: 'genstudio', task_id: current!.taskId, submitted_at: current!.submittedAt,
        input_hash: input.inputHash, idempotency_key: current!.idempotencyKey,
        operation: 'transcription', word_timestamps: input.request.wordTimestamps, last_state: providerState,
        replacement_of_task_id: current!.replacement?.originalTaskId
          || (savedAtStart?.idempotency_key === current!.idempotencyKey ? savedAtStart.replacement_of_task_id : undefined),
      })
      await checkpointGenStudioAsset(job, manifestKey, {
        operation: 'transcription', idempotency_key: current!.idempotencyKey,
        ...(current!.taskId ? { job_id: current!.taskId } : {}),
        output_path: current!.outputPath, input_hash: input.inputHash,
        state: providerState as GenStudioRecoveryState,
      })
    }
    const policy = async () => {
      const setting = await getAppSetting(PAID_SUBTITLE_REPLACEMENT_KEY)
      return {
        enabled: input.manualCreditCeiling !== undefined || setting.enabled === true,
        ceiling: input.manualCreditCeiling ?? setting.additional_credit_ceiling,
      }
    }
    // Deliberately invocation-local: a saved ledger flag is never spending authority.
    let originalAuthorityVerified = false
    const rebindOriginalAuthority = async (initial = false) => {
      try {
        const manifest = await readManifestStrict(outDir)
        const entry = manifest.tasks[manifestKey]
        if (entry?.provider !== 'genstudio' || current!.section !== section
          || current!.outputPath !== path.join(outDir, manifestKey)) throw new Error('Section identity mismatch')
        const provenance = initial
          ? { originalTaskId: current!.taskId, originalIdempotencyKey: current!.idempotencyKey }
          : current!.replacement!
        if (initial) {
          if (entry.replacement_of_task_id || entry.input_hash !== input.inputHash || entry.idempotency_key !== current!.idempotencyKey
            || (entry.task_id && entry.task_id !== current!.taskId)) throw new Error('Current manifest identity mismatch')
        } else {
          const original = entry.subtitle_originals?.[provenance.originalIdempotencyKey]
          if (!original || original.task_id !== provenance.originalTaskId
            || original.idempotency_key !== provenance.originalIdempotencyKey
            || original.input_hash !== input.inputHash) throw new Error('Immutable original manifest identity mismatch')
        }
        const original = await getGenStudioJobByIdempotencyKey('audio.transcription', await getGenStudioUrl(), input.apiKey,
          `${provenance.originalIdempotencyKey}-confirm`, input.request, Date.now() + 30_000)
        if (original.id !== provenance.originalTaskId || original.state !== 'failed') throw new Error('Original task mismatch')
        const failure = subtitleFailure(new GenStudioTerminalFailureError('transcription', original, 'Original transcription failed'))
        if (classifySubtitleFailure(failure) !== 'paid') throw new Error('Original settlement is not eligible')
        if (initial) {
          // Strict writer appends only while the independently read current binding
          // still matches; later task/current-key writes preserve this original.
          await recordTaskStrict(outDir, manifestKey, { ...entry, task_id: original.id,
            subtitle_originals: { [provenance.originalIdempotencyKey]: {
              task_id: original.id, idempotency_key: provenance.originalIdempotencyKey, input_hash: input.inputHash,
            } },
          })
        } else current!.replacement!.failure = failure
        mayWriteManifest = true
        originalAuthorityVerified = true
      } catch {
        return block('The original transcription identity and authority could not be verified; no replacement was bought. Recover the original task or explicitly re-run this section.',
          'rerun_subtitle_section')
      }
    }
    const beforeConfirm = async (quote: GenStudioTranscriptionQuote) => {
      if (stopped()) throw new Error('Subtitle submission stopped by owner')
      if (current!.replacement) {
        await rebindOriginalAuthority()
        const authority = await policy()
        const reason = await change(ledger => {
          const attempts = ledger.plans[current!.planId]!.attempts
          const existing = attempts.find(a => a.section === section)
          const freeRenewal = !!existing && !!current!.freeRetryFromKey
            && [current!.freeRetryFromKey, current!.idempotencyKey].includes(existing.idempotencyKey)
          const effectiveAuthority = freeRenewal ? { enabled: true, ceiling: existing.ceiling } : authority
          const decision = decideSubtitleReplacement({
            ...effectiveAuthority, attempts: attempts.filter(a => a !== existing), section,
            ...current!.replacement!, inputHash: input.inputHash, outputPath: current!.outputPath,
            livePrice: typeof quote.quoted_credit_cost === 'number' && typeof quote.price_version === 'string'
              ? { credits: quote.quoted_credit_cost, priceVersion: quote.price_version } : null,
          })
          if (decision.action !== 'commit') return decision.reason
          if (existing && !freeRenewal && (existing.idempotencyKey !== current!.idempotencyKey
            || existing.quoteId !== quote.id || existing.quotedCredits !== quote.quoted_credit_cost
            || existing.priceVersion !== quote.price_version)) return 'the committed transcription quote changed; reconcile before buying again'
          const committed: Commitment = {
            ...decision.attempt, idempotencyKey: current!.idempotencyKey, quoteId: quote.id,
            taskId: undefined,
            committedAt: new Date().toISOString(), ceiling: effectiveAuthority.ceiling,
            authorization: input.manualCreditCeiling !== undefined ? 'manual' : 'automatic',
          }
          if (!existing) attempts.push(committed)
          else if (freeRenewal) Object.assign(existing, committed)
          return null
        })
        if (reason) return block(reason, 'buy_missing_subtitles')
        await state(current!.freeRetryFromKey ? 'free_retry' : 'paid_commitment', current!.freeRetryFromKey
          ? 'Reusing the fully refunded replacement authorization for free; no additional paid allowance.'
          : `Buying replacement for ${section}; ${quote.quoted_credit_cost} credits within the shared subtitle ceiling.`)
      }
      // This write precedes EVERY physical confirm POST, including transport retries.
      current!.confirmStarted = true
      await persist()
      if (stopped()) throw new Error('Subtitle submission stopped by owner')
      if (current!.replacement && !current!.freeRetryFromKey && !(await policy()).enabled) return block('automatic paid subtitle replacement is Off', 'buy_missing_subtitles')
    }
    const reclaimKey = async (request: GenStudioTranscriptionRequest): Promise<boolean> => {
      await state('free_recovery', 'Recovering existing subtitle task (free) by its saved idempotency key.')
      try {
        const existing = await getGenStudioJobByIdempotencyKey('audio.transcription', await getGenStudioUrl(), input.apiKey,
          `${current!.idempotencyKey}-confirm`, request, Date.now() + 30_000)
        current!.taskId = existing.id
        await persist(String(existing.state))
        return true
      } catch (error) {
        // Only authoritative absence permits replay of this SAME committed key.
        if (error instanceof GenStudioApiError && error.status === 404) return false
        throw error
      }
    }
    await persist()
    let freeRetriesThisRun = 0
    for (;;) {
      if (stopped()) throw new Error('Subtitle recovery stopped by owner')
      const request: GenStudioTranscriptionRequest = {
        ...input.request, idempotencyKey: current.idempotencyKey, beforeConfirm,
        withConfirm: confirm => current!.replacement ? withPaidSubtitleConfirmation(confirm) : confirm(),
        beforePost: async () => { if (stopped()) throw new Error('Subtitle submission stopped by owner') },
        onJobAccepted: async id => { current!.taskId = id; await persist('accepted') },
        onState: async (value, id) => { current!.taskId = id; await persist(value) },
      }
      try {
        if (!current.taskId && current.confirmStarted) {
          await reclaimKey(request)
        }
        // Reclaim accepted replacement tasks first for free. Only a new POST
        // requires binding the claimed original key/task to provider settlement.
        if (!current.taskId && current.replacement && !originalAuthorityVerified) await rebindOriginalAuthority()
        if (current.taskId) await state('free_recovery', 'Recovering existing subtitle task (free).')
        const result = current.taskId
          ? await recoverTranscriptionWithGenStudio(input.apiKey, current.taskId, request)
          : await transcribeWithGenStudio(input.apiKey, request)
        await state('artifact_recovered', 'Subtitle task recovered; verifying its artifact and stitch next.')
        return result
      } catch (error) {
        if (error instanceof GenStudioTranscriptionQuoteExpiredError) {
          // A confirm response can be lost behind an expiry/conflict. Never
          // retire its commitment until a read-only lookup proves no job exists.
          if (current.confirmStarted && await reclaimKey(request)) continue
          // No provider job was created. Retire this quote, not a paid allowance.
          await change(ledger => {
            const plan = ledger.plans[current!.planId]!
            plan.attempts = plan.attempts.filter(a => a.idempotencyKey !== current!.idempotencyKey)
          })
        } else if (error instanceof GenStudioTerminalFailureError && error.modality === 'transcription') {
          current.taskId = error.jobId
          await persist('failed')
          const failure = subtitleFailure(error)
          const classification = classifySubtitleFailure(failure)
          if (classification === 'blocked') {
            const unsettled = failure.reservedCredits == null || failure.settledCredits == null || failure.releasedCredits == null
              || failure.settledCredits + failure.releasedCredits !== failure.reservedCredits
            return block(unsettled ? 'Waiting for credit settlement; no replacement was bought.' : 'This provider failure is not eligible for automatic subtitle replacement.',
              !unsettled && !failure.cancelled ? 'rerun_subtitle_section' : false, unsettled ? 'waiting_settlement' : 'needs_attention')
          }
          if (classification === 'paid') {
            if (current.replacement) return block('The one paid replacement failed; needs attention. Review the failure before explicitly re-running this section.', 'rerun_subtitle_section', 'needs_attention')
            if (!(await policy()).enabled) return block('automatic paid subtitle replacement is Off', 'buy_missing_subtitles')
            await rebindOriginalAuthority(true)
            current.replacement = { originalTaskId: error.jobId, originalIdempotencyKey: current.idempotencyKey, failure }
            current.idempotencyKey = `story-stt-${createHash('sha256').update(`${current.idempotencyKey}:subtitle-replacement:1`).digest('hex')}`
            current.taskId = ''; current.confirmStarted = false; current.submittedAt = new Date().toISOString()
            await persist('prepared')
            await state('paid_wait', `Preparing one replacement quote for ${section}.`)
            continue
          }
          // Fully balanced zero settlement remains free, even after a paid quote.
          if (current.replacement) current.freeRetryFromKey = current.idempotencyKey
        } else if (error instanceof GenStudioArtifactUnavailableError) {
          return block('The successful subtitle artifact expired; it may already have been charged. Review it before explicitly re-running this section.', 'rerun_subtitle_section', 'needs_attention')
        } else {
          if (!(error instanceof Error && error.message.startsWith(`${section}:`))) {
            await state('needs_attention', 'Subtitle recovery interrupted; its saved task/key is retained. No fresh replacement was authorized.')
          }
          throw error
        }
        const delay = FLEET_BUSY_RETRY_DELAYS_MS[freeRetriesThisRun++]
        if (delay === undefined) return block('Free subtitle retries exhausted; retry recovery later.', false, 'needs_attention')
        current.freeRetries++
        await state(
          'free_retry',
          `No charge was settled. Retrying transcription for free (attempt ${freeRetriesThisRun} of ${FLEET_BUSY_RETRY_DELAYS_MS.length}) without consuming a replacement allowance.`,
        )
        if (error instanceof GenStudioTerminalFailureError && FLEET_BUSY_FAILURE_CODES.has(error.failureCode || '')) {
          await waitUnlessStopped(delay, () => !!stopped())
        }
        current.idempotencyKey = `story-stt-${createHash('sha256').update(`${current.idempotencyKey}:free-retry`).digest('hex')}`
        current.taskId = ''; current.confirmStarted = false; current.submittedAt = new Date().toISOString()
        await persist('prepared')
      }
    }
  })
}
