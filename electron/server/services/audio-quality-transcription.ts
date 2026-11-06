import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { parseSrt, type SrtCue } from '../lib/subtitle-builder.js'
import { formatConcatFileLine, runFfmpeg } from '../lib/ffmpeg-utils.js'
import {
  buildGenStudioTranscriptionIdempotencyKey,
  recoverTranscriptionWithGenStudio,
  transcribeWithGenStudio,
  type GenStudioTranscriptionQuote,
} from '../lib/genstudio-client.js'
import { hashInput, readManifest, recordTaskStrict } from './task-manifest.js'
import type { Job } from '../models/types.js'

/**
 * Copy the current active source bytes into an action-private check directory.
 * Multi-part chapters are concatenated once locally because GenStudio quotes
 * and transcribes one file. The returned hash is the exact staged input, never
 * a reconstructed active subtitle or corrected transcript.
 */
export async function stageActiveAudioQualityCheck(input: {
  audioDir: string
  checkOutDir: string
  section: string
  sourceFiles: string[]
}): Promise<{ audioPath: string; audioHash: string }> {
  const files = input.sourceFiles.filter(file => path.basename(file) === file && !!file.trim())
  if (!files.length) throw new Error(`No active audio source is selected for ${input.section}.`)
  const root = path.resolve(input.checkOutDir)
  const label = input.section.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  if (!label) throw new Error('A non-empty section is required for an active audio quality check.')
  await fs.mkdir(root, { recursive: true })
  const audioPath = path.resolve(root, `${label}.mp3`)
  if (path.dirname(audioPath) !== root) throw new Error('Active audio check staging path escaped its directory.')
  const sources = files.map(file => path.resolve(input.audioDir, file))
  if (sources.some(source => path.dirname(source) !== path.resolve(input.audioDir))) {
    throw new Error('Active audio quality check source escaped its audio directory.')
  }
  for (const source of sources) {
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isFile() || stat.size <= 0) throw new Error(`Selected active audio is missing: ${path.basename(source)}.`)
  }
  if (sources.length === 1) {
    await fs.copyFile(sources[0]!, audioPath)
  } else {
    const listPath = path.resolve(root, `${label}.concat.txt`)
    if (path.dirname(listPath) !== root) throw new Error('Active audio quality concat path escaped its directory.')
    await fs.writeFile(listPath, sources.map(formatConcatFileLine).join('\n') + '\n', 'utf8')
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', '192k', audioPath])
    } finally {
      await fs.rm(listPath, { force: true })
    }
  }
  const audio = await fs.readFile(audioPath)
  if (!audio.length) throw new Error(`Active audio quality staging is empty for ${input.section}.`)
  return { audioPath, audioHash: `sha256:${createHash('sha256').update(audio).digest('hex')}` }
}

export interface VerifyAudioQualityCandidateRawTranscriptInput {
  job: Pick<Job, 'project_slug' | 'episode_id'>
  actionId: string
  section: string
  candidateAudioPath: string
  candidateOutDir: string
  apiKey: string
  transcription: { modelId: string; language?: string }
  /** Exact quote persisted by the active-audio check route for these bytes. */
  preparedQuote?: { id: string; quoted_credit_cost?: number; price_version?: string }
  /** Route-owned atomic action checkpoint: revalidates source facts and reserves the live quote before confirm. */
  authorizeQuote?: (quote: { id: string; quoted_credit_cost?: number; price_version?: string }) => void | Promise<void>
  signal?: AbortSignal
}

export interface AudioQualityCandidateRawTranscript {
  srt: string
  rawCues: SrtCue[]
  taskId: string
  modelId: string
  audioHash: string
  /** Basename inside candidateOutDir; never an active subtitle path. */
  outputFile: string
  /** Present only when this invocation obtained a live provider quote. */
  quote?: { id: string; quoted_credit_cost?: number; price_version?: string }
}

function safeOutputKey(section: string, actionId: string): string {
  const label = section.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  if (!label || !actionId.trim()) throw new Error('A non-empty section and action identity are required for candidate transcription.')
  return `candidate-${label}-${createHash('sha256').update(actionId).digest('hex').slice(0, 16)}.raw.srt`
}

function quoteFacts(quote: GenStudioTranscriptionQuote) {
  return {
    id: quote.id,
    ...(typeof quote.quoted_credit_cost === 'number' ? { quoted_credit_cost: quote.quoted_credit_cost } : {}),
    ...(typeof quote.price_version === 'string' ? { price_version: quote.price_version } : {}),
  }
}

/**
 * Verify staged candidate audio with an alternate ASR model. This is deliberately
 * separate from subtitle repair: it stores only raw ASR evidence under the
 * candidate directory and never reads or writes active subtitle artifacts.
 */
export async function verifyAudioQualityCandidateRawTranscript(
  input: VerifyAudioQualityCandidateRawTranscriptInput,
): Promise<AudioQualityCandidateRawTranscript> {
  const candidateRoot = path.resolve(input.candidateOutDir)
  const key = safeOutputKey(input.section, input.actionId)
  const outputPath = path.resolve(candidateRoot, key)
  if (path.dirname(outputPath) !== candidateRoot) throw new Error('Candidate transcript path escaped its staging directory.')
  const audio = await fs.readFile(input.candidateAudioPath)
  if (!audio.length) throw new Error('Candidate audio is empty.')
  const audioHash = `sha256:${createHash('sha256').update(audio).digest('hex')}`
  const requestIdentity = `${input.job.project_slug}:${input.job.episode_id}:audio-quality:${input.actionId}:${input.section}`
  const idempotencyKey = buildGenStudioTranscriptionIdempotencyKey({
    requestIdentity, fileSha256: audioHash.slice('sha256:'.length), modelId: input.transcription.modelId,
    language: input.transcription.language, wordTimestamps: true,
  })
  const inputHash = hashInput(JSON.stringify({ requestIdentity, audioHash, modelId: input.transcription.modelId,
    language: input.transcription.language, wordTimestamps: true }))
  await fs.mkdir(candidateRoot, { recursive: true })
  const prior = await readManifest(candidateRoot)
  const priorEntry = prior.tasks[key]
  let quote: ReturnType<typeof quoteFacts> | undefined
  const beforeConfirm = async (liveQuote: GenStudioTranscriptionQuote) => {
    quote = quoteFacts(liveQuote)
    // The action owner records the live quote under its lock, so concurrent
    // selected chapters cannot each confirm against the same evidence.
    if (input.authorizeQuote) await input.authorizeQuote(quote)
  }
  const record = async (taskId: string, state: string) => recordTaskStrict(candidateRoot, key, {
    provider: 'genstudio', task_id: taskId, submitted_at: priorEntry?.submitted_at || new Date().toISOString(),
    input_hash: inputHash, idempotency_key: idempotencyKey, operation: 'transcription', word_timestamps: true,
    last_state: state, request_scope: input.actionId,
  })
  if (!priorEntry || priorEntry.input_hash !== inputHash || priorEntry.idempotency_key !== idempotencyKey) {
    await record('', 'prepared')
  }
  const current = priorEntry?.input_hash === inputHash && priorEntry.idempotency_key === idempotencyKey
    ? priorEntry : undefined
  const request = {
    audioPath: input.candidateAudioPath, modelId: input.transcription.modelId, requestIdentity,
    idempotencyKey, language: input.transcription.language, wordTimestamps: true, signal: input.signal,
    beforeConfirm,
    onJobAccepted: async (taskId: string) => record(taskId, 'accepted'),
    onState: async (state: string, taskId: string) => record(taskId, state),
  }
  const result = current?.task_id
    ? await recoverTranscriptionWithGenStudio(input.apiKey, current.task_id, request)
    : await transcribeWithGenStudio(input.apiKey, { ...request, ...(input.preparedQuote ? { preparedQuote: input.preparedQuote } : {}) })
  const rawCues = parseSrt(result.srt).filter(cue => cue.text.trim() && cue.end_sec > cue.start_sec)
  if (!rawCues.length) throw new Error('Candidate ASR returned no usable raw cues.')
  await fs.writeFile(outputPath, result.srt, 'utf8')
  await record(result.jobId, 'succeeded')
  return { srt: result.srt, rawCues, taskId: result.jobId, modelId: result.modelId, audioHash, outputFile: key, quote }
}
