/**
 * Plain sentences for what the Gateway and the Hubs behind it say when a job ends or waits.
 *
 * The Gateway relays the Hub's words, and the Hub writes for an operator: item codes
 * (`WORKER_TERMINAL_ERROR`), refusal JSON truncated mid-object, `tried 3 machines … studio-hub-9701…`
 * wrappers. Story shows `failure_reason` to the owner as "Provider reason: …", so every such shape is
 * turned into a sentence here, once, and the controller ids the Gateway still leaks are replaced by
 * "a Mac" (the Gateway substitutes the owner's machine labels where it knows them — see
 * `scrubControllerIds` in the gateway — and what remains is never shown as an id).
 *
 * Memory sentences are deliberately kept: "needs ~16 GB, this one has 8 GB" is exactly what the owner
 * needs to read, and it is passed through untouched (only "machine" is spelled "Mac").
 */

import { plainSectionFailure } from './tts-section-quality.js'

/** What each code the Hub or Gateway attaches to a refusal means, in words the owner can act on. */
const CODE_SENTENCES: Record<string, string> = {
  MACHINE_BUSY: 'That Mac is busy with other work.',
  MODEL_NOT_READY: 'This model is not ready on that Mac yet.',
  MODEL_NOT_PACKAGED: 'This model is not installed on that Mac.',
  MODEL_PAUSED: 'This model is paused on that Mac.',
  MACHINE_DISABLED: 'That Mac is switched off for customer work.',
  STUDIO_DISABLED: 'This studio is switched off on that Mac.',
  STUDIO_NOT_RUNNING: 'The studio is not running on that Mac.',
  MODEL_CATALOG_UNAVAILABLE: 'That Mac could not read its model list.',
  OUTPUT_STORAGE_BLOCKED: 'That Mac is almost out of disk space (it needs at least 5 GB free to take work).',
  MODEL_FILES_UNAVAILABLE: 'The model files are missing or unfinished on that Mac.',
  INSUFFICIENT_MEMORY: 'No Mac that can run this model has enough free memory right now.',
  JOB_PERSISTENCE_FAILED: 'The Mac could not save this job, so it was not started.',
  JOB_PERSISTENCE_UNCERTAIN: 'The Mac could not save this job\'s record; it is being checked rather than re-run.',
  WORKER_RESTART_UNCERTAIN: 'The Mac restarted while working, so the result is being checked.',
  EXECUTION_IDENTITY_LOST: 'The Mac lost track of this job while working, so the result is being checked.',
  VOICE_CANCEL_OUTCOME_UNCERTAIN: 'The cancel was sent, but the Mac has not confirmed it stopped.',
  IMAGE_OUTCOME_UNCERTAIN: 'The Mac stopped answering while rendering, so the result is being checked.',
  MUSIC_OUTCOME_UNCERTAIN: 'The Mac stopped answering while composing, so the result is being checked.',
  VIDEO_OUTCOME_UNCERTAIN: 'The Mac stopped answering while rendering, so the result is being checked.',
}

const ID = /\bstudio-hub-[0-9a-f]{6,}\b/gi
const BARE_CONTROLLER = /\b(?:controller|location)\s+[0-9a-f]{10,}\b/gi

/** `studio-hub-<hex>` ids never reach the owner; a label the Gateway already substituted is left alone. */
export function withoutControllerIds(text: string): string {
  return text.replace(ID, 'a Mac').replace(BARE_CONTROLLER, 'a Mac')
}

function sentence(code: string, detail?: string): string {
  const base = CODE_SENTENCES[code.toUpperCase()]
  const extra = (detail || '').trim().replace(/\bmachines\b/gi, 'Macs').replace(/\bmachine\b/gi, 'Mac')
  if (!base) return extra || `${code}.`
  // The Hub's own reason is the useful half for memory and disk ("needs ~16GB, this one has 8GB").
  return extra && !base.toLowerCase().includes(extra.toLowerCase().slice(0, 30)) ? `${base} ${extra}` : base
}

function jsonField(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)
  return match ? match[1]!.replace(/\\"/g, '"').replace(/\\n/g, ' ') : undefined
}

/**
 * Turn one Gateway/Hub failure or waiting sentence into plain words. Text that matches no known shape
 * is returned with controller ids removed and nothing else changed.
 */
export function humanGatewayText(raw: string): string {
  let text = raw.trim()
  if (!text) return text

  // The Hub's section quality gate (0.6.137): "Section 4 of 9 came out (nearly) silent or as a DC drift on all 4 attempts…"
  const section = plainSectionFailure(text)
  if (section) return section

  // Strip the gateway's "reconcile it yourself" suffix; Story and the gateway do that on their own.
  text = text.replace(/\s*Upstream outcome is unknown; reconcile the provider request before retrying; the gateway will not resubmit it automatically\.?/i,
    ' The result is being checked; nothing was run twice.')

  // `tried N machines and every one failed - <id> (CODE: detail); <id> (CODE: detail). This is the end of the retry policy…`
  const tried = /^tried (\d+) machines? and every one failed - ([\s\S]*?)\.? This is the end of the retry policy, not a queue wait\.?$/i.exec(text)
  if (tried) {
    const parts = tried[2]!.split(/;\s+(?=\S+ \()/).map(part => {
      const m = /^(.*?) \(([A-Z_]+)(?:: ([\s\S]*))?\)$/.exec(part.trim())
      if (!m) return humanGatewayText(part)
      // The attempt's own words are the useful half; the gateway's code (PROVIDER_FAILED,
      // LOCATION_NOT_READY …) only matters when there are none.
      const why = m[3] ? humanGatewayText(m[3]) : humanGatewayText(m[2]!)
      return `${withoutControllerIds(m[1]!)}: ${why.replace(/\.$/, '')}.`
    })
    return `${tried[1] === '1' ? 'The Mac' : `All ${tried[1]} Macs`} that could run this tried and failed. ${parts.join(' ')}`.trim()
  }

  // `the location cannot serve this model right now (CODE)[: reason]`
  const location = /^the location cannot serve this model right now \(([A-Z_]+)\)(?::\s*([\s\S]*))?$/i.exec(text)
  if (location) return sentence(location[1]!, location[2])

  // `hub item error: CODE: message` / `hub item cancelled: …`
  const item = /^hub item (error|failed|cancelled): (?:([A-Z][A-Z_]{3,}): )?([\s\S]*)$/.exec(text)
  if (item) {
    const code = item[2]
    const message = item[3]!.trim()
    if (code && code !== 'WORKER_TERMINAL_ERROR') return sentence(code, message === 'no detail' ? '' : message)
    if (item[1] === 'cancelled') return 'The Mac stopped this job because it was cancelled.'
    return message && message !== 'no detail' ? message : 'The Mac could not finish this job.'
  }

  // `hub (submit|chat|transcription|voice-reference) HTTP 409: {"detail":{"code":"X","detail":"…"` (often cut at 200 chars)
  const http = /^hub [a-z-]+ HTTP (\d{3}): ([\s\S]*)$/.exec(text)
  if (http) {
    const code = jsonField(http[2]!, 'code')
    const detail = jsonField(http[2]!, 'detail')
    if (code) return sentence(code, detail)
    return detail || `The Mac refused this job (HTTP ${http[1]}).`
  }

  // A writing pool walked every member: `Pool 'x' had no member that could answer — <600 chars of
  // member ids and provider errors>`. The job's own code already says why (quota, busy …).
  const pool = /^Pool '([^']+)' had no member that could answer\b/.exec(text)
  if (pool) return `None of the models in the "${pool[1]}" pool could answer.`

  // `hub submit failed: timed out` (httpx's words): the Mac took the request but did not answer.
  const submit = /^hub submit failed: ([\s\S]*?)(\s+The result is being checked; nothing was run twice\.)?$/i.exec(text)
  if (submit) {
    return (/timed? ?out/i.test(submit[1]!) ? 'The Mac didn\'t answer in time.' : 'The Mac could not take the request.')
      + (submit[2] || '')
  }

  const finishing = /^hub job did not finish within (\d+)s of running/i.exec(text)
  if (finishing) {
    const minutes = Math.max(1, Math.round(Number(finishing[1]) / 60))
    return `The Mac did not finish within ${minutes} minute${minutes === 1 ? '' : 's'} of working, so the job was stopped.`
  }
  const queued = /^the Hub kept this queued for (\d+)s with no machine free/i.exec(text)
  if (queued) return `No Mac was free for ${Math.round(Number(queued[1]) / 3600)} hours, so the job was withdrawn from the queue before anything ran.`
  if (/^lost contact with .*while polling batch/i.test(text)) {
    return 'Lost contact with the Mac while it was working; the Gateway is checking whether it finished.'
  }

  return withoutControllerIds(text).replace(/\bthe Hub\b/g, 'the Mac')
}

/** Does this text already carry a memory/disk figure the owner should keep reading? */
export function carriesCapacityFacts(raw: string): boolean {
  return /\bneeds? (?:a )?~?\d+(?:\.\d+)?\s?GB\b|\bGB (?:free|available)\b|\bfree memory\b|\bout of disk\b|\binsufficient (?:free )?(?:memory|space)\b/i.test(raw)
}

export const DISPATCH_NO_ELIGIBLE_MACHINE_CODE = 'DISPATCH_NO_ELIGIBLE_MACHINE'

function scrubDispatchText(raw: string): string {
  return withoutControllerIds(humanGatewayText(raw))
    .replace(/\bmachines\b/gi, 'Macs')
    .replace(/\bmachine\b/gi, 'Mac')
    .replace(/file:\/\/\S+/gi, 'a local file')
    .replace(/(?:^|\s)(?:~\/|\/Users\/|\/Volumes\/|\/private\/|\/var\/|\/tmp\/)\S*/g, ' a local path')
    .replace(/\b(?:sk|gsk|ghp|hf|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, 'a key')
    .replace(/((?:api[_-]?key|token|secret|bearer)[^:=]{0,20}[:=])\s*\S+/gi, '$1 [hidden]')
    .replace(/\s+/g, ' ')
    .trim()
}

function dispatchCandidateReason(value: unknown): string {
  if (typeof value === 'string') return scrubDispatchText(value)
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  const reason = row.reason ?? row.detail ?? row.why ?? row.message ?? row.gate
  return typeof reason === 'string' ? scrubDispatchText(reason) : ''
}

/**
 * A Gateway dispatch refusal, in the owner's words: what happened, and every
 * per-candidate reason the Gateway published. Machine ids, local paths and
 * keys are scrubbed — the reasons are useful, the estate behind them is not.
 */
export function formatDispatchRefusal(input: {
  detail?: string
  candidates?: unknown[]
}): string {
  const lead = scrubDispatchText((input.detail || '').trim())
    || 'No Mac able to run this model could take the job right now.'
  const reasons = [...new Set((input.candidates || []).map(dispatchCandidateReason).filter(Boolean))]
  return `The Gateway could not dispatch this job (${DISPATCH_NO_ELIGIBLE_MACHINE_CODE}). ${lead}`
    + (reasons.length ? ` ${reasons.join('; ')}.` : '')
}

/** Read a dispatch refusal out of a Gateway error body, when it is one. */
export function dispatchRefusalFromBody(body: unknown): { detail?: string; candidates?: unknown[] } | null {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null
  if (!record) return null
  const nested = [record.detail, record.error]
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
  const sources = [record, ...nested]
  const codes = sources.map(source => (typeof source.code === 'string' ? source.code.trim().toUpperCase() : ''))
  if (!codes.includes(DISPATCH_NO_ELIGIBLE_MACHINE_CODE)) return null
  const detail = sources
    .map(source => (typeof source.detail === 'string' ? source.detail : typeof source.message === 'string' ? source.message : ''))
    .find(text => text.trim()) || ''
  const candidates = sources
    .map(source => source.candidates)
    .find((value): value is unknown[] => Array.isArray(value)) || []
  return { detail, candidates }
}
