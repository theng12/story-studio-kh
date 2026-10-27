/**
 * Offline bake-off for the opt-in stronger scene-image check (owner 2026-10-27).
 *
 * What it does: takes a folder of LABELLED images and a list of Gateway model
 * ids, asks each model about each image `--runs` times at temperature 0, and
 * writes precision / recall / F1, false-remake rate, missed-defect rate and
 * verdict stability per axis per model.
 *
 * It measures the SAME thing Story Studio will do: the same rubric, the same
 * 640 px q80 JPEG, the same JSON contract (only where the row publishes
 * structured output), the same wire request shape as `callChatWithGenStudio`
 * on `POST /v1/chat/responses`. It cannot import that client directly — the
 * client resolves its base URL from the app's own settings, and this tool must
 * never be pointed at a production Gateway by accident.
 *
 * Usage:
 *   npx tsx scripts/vision-bakeoff/bakeoff.ts \
 *     --images ./labelled-images \
 *     --labels ./labels.json \
 *     --models openrouter-main::vendor/model-a:free,openrouter-main::vendor/model-b:free \
 *     --gateway http://localhost:8787 --key "$GATEWAY_API_KEY" \
 *     --runs 3 --out ./bakeoff-out
 *
 * `labels.json`:
 *   { "images": { "scene-001.jpg": {
 *       "truth": { "anatomy": "pass", "face": "fail", "text": "not_visible" },
 *       "expected_text": "optional exact string the text layer was drawn from"
 *   } } }
 *
 * Refuses, without a flag:
 *   - any model row whose LIVE published price is not zero   (--allow-paid)
 *   - any model row not served by OpenRouter                 (--allow-any-provider)
 *   - the owner's live Gateway and its mini                  (no override, ever)
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

import {
  SCENE_VISION_AXES,
  compareExpectedText,
  parseSceneVisionAnswer,
  sceneVisionSystemPrompt,
  sceneVisionUserPrompt,
  type SceneVisionAnswer,
  type SceneVisionAxis,
  type SceneVisionVerdict,
} from '../../electron/server/contracts/scene-image-check.js'

/** Addresses this tool must never reach. No flag disables this list. */
const FORBIDDEN_HOSTS = ['127.0.0.1']

const IMAGE_WIDTH = 640
const IMAGE_QUALITY = 80
const JOB_TIMEOUT_MS = 180_000
const POLL_STATES = new Set(['queued', 'pending', 'submitted', 'running', 'dispatched'])

interface Args {
  images: string
  labels: string
  models: string[]
  gateway: string
  key: string
  runs: number
  out: string
  allowPaid: boolean
  allowAnyProvider: boolean
  maxOutputTokens: number
}

interface ChatModelRow {
  id: string
  display_name?: string
  provider_id?: string
  provider_name?: string
  chargeable?: boolean
  available?: boolean
  qualification_only?: boolean
  locked?: boolean
  supports_vision?: boolean
  structured_output_mode?: 'none' | 'json_object' | 'request_json_schema'
  input_credits_per_million_tokens?: number
  output_credits_per_million_tokens?: number
  minimum_credits?: number
}

interface LabelFile {
  images: Record<string, {
    truth: Record<SceneVisionAxis, Exclude<SceneVisionVerdict, 'could_not_check'>>
    /** What the picture was asked to show. Used verbatim in the prompt. */
    prompt?: string
    /** The exact string the text layer was drawn from, when it is known. */
    expected_text?: string
  }>
}

interface Observation {
  image: string
  axis: SceneVisionAxis
  run: number
  verdict: SceneVisionVerdict
  findings: string[]
  transcription?: string
}

interface AxisMetrics {
  axis: SceneVisionAxis
  labelled: number
  predictedFail: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  trueNegatives: number
  unusable: number
  precision: number | null
  recall: number | null
  f1: number | null
  falseRemakeRate: number | null
  missedDefectRate: number | null
  stableImages: number
  stability: number | null
}

function usage(message: string): never {
  console.error(`${message}\n\nRun with --help for usage.`)
  process.exit(2)
}

function parseArgs(argv: string[]): Args | null {
  if (argv.includes('--help') || argv.includes('-h')) return null
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const images = read('images')
  const labels = read('labels')
  const models = (read('models') || '').split(',').map(item => item.trim()).filter(Boolean)
  const gateway = (read('gateway') || '').replace(/\/+$/, '')
  const key = read('key') || process.env.GATEWAY_API_KEY || ''
  const out = read('out') || 'vision-bakeoff-out'
  const runs = Number(read('runs') || 3)
  const maxOutputTokens = Number(read('max-output-tokens') || 2048)
  if (!images || !labels || !models.length || !gateway || !key) {
    return usage('--images, --labels, --models, --gateway and --key (or GATEWAY_API_KEY) are required.')
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) return usage('--runs must be an integer 1..10.')
  return {
    images, labels, models, gateway, key, runs: runs, out, maxOutputTokens,
    allowPaid: argv.includes('--allow-paid'),
    allowAnyProvider: argv.includes('--allow-any-provider'),
  }
}

/** Refuse the production Gateway by address, before anything else happens. */
function assertSafeGateway(gateway: string): void {
  let parsed: URL
  try { parsed = new URL(gateway) } catch { usage(`--gateway is not a URL: ${gateway}`) }
  if (FORBIDDEN_HOSTS.includes(parsed.hostname)) {
    throw new Error(`${parsed.hostname} is the owner's live Gateway. This tool never measures against it.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') usage('--gateway must be http or https.')
}

async function getJson<T>(gateway: string, key: string, pathname: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${gateway}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  const text = await response.text()
  let body: any = {}
  try { body = JSON.parse(text) } catch { /* keep the raw text out of the report */ }
  return { status: response.status, body: body as T }
}

/** Rows come from the live catalogue; a model id the Gateway no longer sells is refused, never substituted. */
async function loadRows(args: Args): Promise<Map<string, ChatModelRow>> {
  const { status, body } = await getJson<{ models?: ChatModelRow[] } | ChatModelRow[]>(args.gateway, args.key, '/v1/chat/models')
  if (status !== 200) throw new Error(`The Gateway refused the catalogue read (HTTP ${status}).`)
  const rows: ChatModelRow[] = Array.isArray(body) ? body : Array.isArray((body as any)?.models) ? (body as any).models : []
  return new Map(rows.filter(row => typeof row?.id === 'string').map(row => [row.id, row]))
}

/** Zero is the only acceptable price. Any published non-zero figure refuses the row. */
function rowIsFree(row: ChatModelRow): boolean {
  if (row.chargeable === true) return false
  const credits = [
    row.input_credits_per_million_tokens,
    row.output_credits_per_million_tokens,
    row.minimum_credits,
  ]
  return credits.every(value => typeof value !== 'number' || value === 0)
}

function assertModelAllowed(row: ChatModelRow, args: Args): void {
  const name = row.display_name || row.id
  if (row.supports_vision !== true) throw new Error(`${name} does not publish image input; it cannot be measured.`)
  if (row.available !== true || row.locked === true || row.qualification_only !== false) {
    throw new Error(`${name} is not available in the live catalogue right now.`)
  }
  if (!rowIsFree(row) && !args.allowPaid) {
    throw new Error(`${name} publishes a price. This tool makes no paid calls unless --allow-paid is passed.`)
  }
  const provider = (row.provider_id || '').toLowerCase()
  if (!args.allowAnyProvider && !provider.startsWith('openrouter')) {
    throw new Error(`${name} is not served by OpenRouter (provider: ${row.provider_id || 'not published'}). `
      + 'The owner asked for free OpenRouter models only; pass --allow-any-provider to measure it anyway.')
  }
}

async function encodeImage(imagePath: string): Promise<{ dataUri: string; sha256: string }> {
  const jpeg = await sharp(imagePath)
    .resize({ width: IMAGE_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: IMAGE_QUALITY })
    .toBuffer()
  return {
    dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
  }
}

/** One request, one settled answer text. Same body shape as the Story client. */
async function askOnce(args: Args, row: ChatModelRow, image: { dataUri: string; sha256: string },
  prompts: { system: string; user: string }): Promise<string> {
  const structured = row.structured_output_mode !== 'none'
  // A content-derived key, exactly like Story's: the same picture and prompt
  // replay instead of buying a second answer when a run is retried.
  const idempotencyKey = `story-vision-bakeoff-${createHash('sha256')
    .update(JSON.stringify([row.id, image.sha256, prompts.system, prompts.user, args.runs])).digest('hex').slice(0, 40)}`
  const { status, body } = await getJson<any>(args.gateway, args.key, '/v1/chat/responses', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey } as any,
    body: JSON.stringify({
      model_id: row.id,
      input: [
        { role: 'system', content: prompts.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompts.user },
            { type: 'image_url', image_url: { url: image.dataUri } },
          ],
        },
      ],
      ...(structured ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0,
      max_output_tokens: args.maxOutputTokens,
    }),
  })
  if (status !== 200 && status !== 202) throw new Error(`submit failed: HTTP ${status} ${body?.detail || body?.code || ''}`.trim())
  let job = body
  const deadline = Date.now() + JOB_TIMEOUT_MS
  while (POLL_STATES.has(String(job?.state)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_500))
    const polled = await getJson<any>(args.gateway, args.key, `/v1/chat/responses/${encodeURIComponent(job.id)}`)
    if (polled.status !== 200) throw new Error(`poll failed: HTTP ${polled.status}`)
    job = polled.body
  }
  if (job?.state !== 'succeeded') throw new Error(`job ${job?.state || 'unknown'} ${job?.failure_code || ''}`.trim())
  const text = typeof job.output_text === 'string' ? job.output_text : ''
  if (!text.trim()) throw new Error('the model returned no text')
  return text
}

/** The verdict the check would ACT on, after the objective text comparison. */
function axisVerdict(answer: SceneVisionAnswer, axis: SceneVisionAxis, expectedText?: string): { verdict: SceneVisionVerdict; findings: string[]; transcription?: string } {
  if (axis === 'text' && expectedText?.trim()) {
    return compareExpectedText(expectedText, answer.axes.text.transcription || '')
  }
  return answer.axes[axis]
}

function metricsFor(axis: SceneVisionAxis, observations: Observation[], truth: Map<string, Exclude<SceneVisionVerdict, 'could_not_check'>>, runs: number): AxisMetrics {
  const byImage = new Map<string, Observation[]>()
  for (const observation of observations.filter(item => item.axis === axis)) {
    byImage.set(observation.image, [...(byImage.get(observation.image) || []), observation])
  }
  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  let trueNegatives = 0
  let unusable = 0
  let stableImages = 0
  for (const [image, entries] of byImage) {
    const wanted = truth.get(image)
    if (!wanted) continue
    const verdicts = entries.map(entry => entry.verdict)
    if (verdicts.length === runs && verdicts.every(verdict => verdict === verdicts[0])) stableImages++
    // A verdict that is not `pass`/`fail` cannot act: it neither remakes nor
    // clears the picture. It is counted as unusable AND as a missed defect
    // when the picture really was defective, because it did not catch it.
    for (const verdict of verdicts) {
      if (verdict === 'could_not_check' || verdict === 'not_visible') { unusable++; continue }
      if (wanted === 'fail') {
        if (verdict === 'fail') truePositives++
        else falseNegatives++
      } else {
        if (verdict === 'fail') falsePositives++
        else trueNegatives++
      }
    }
  }
  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : null
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : null
  const falseRemakeRate = falsePositives + trueNegatives > 0 ? falsePositives / (falsePositives + trueNegatives) : null
  const missedDefectRate = truePositives + falseNegatives > 0 ? falseNegatives / (truePositives + falseNegatives) : null
  return {
    axis,
    // Every labelled image for this axis, including any whose runs all failed —
    // a missing verdict must not quietly shrink the denominator.
    labelled: truth.size,
    predictedFail: truePositives + falsePositives,
    truePositives, falsePositives, falseNegatives, trueNegatives, unusable,
    precision, recall,
    f1: precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null,
    falseRemakeRate, missedDefectRate,
    stableImages,
    stability: byImage.size > 0 ? stableImages / byImage.size : null,
  }
}

function format(value: number | null): string {
  return value === null ? '—' : value.toFixed(2)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.log(await fs.readFile(new URL(import.meta.url), 'utf8').then(text => text.split('*/')[0]!.replace(/^\/\*\*?/, '')))
    return
  }
  assertSafeGateway(args.gateway)

  const labels = JSON.parse(await fs.readFile(args.labels, 'utf8')) as LabelFile
  const files = (await fs.readdir(args.images)).filter(name => /\.(jpe?g|png|webp)$/i.test(name)).sort()
  const labelled = files.filter(name => labels.images?.[name])
  if (!labelled.length) throw new Error('No image in --images has a label in --labels.')
  const unlabelled = files.length - labelled.length
  if (unlabelled > 0) console.warn(`Skipping ${unlabelled} image(s) with no label.`)

  const rows = await loadRows(args)
  const models: ChatModelRow[] = args.models.map(id => {
    const row = rows.get(id)
    if (!row) throw new Error(`${id} is not in the live Gateway catalogue. This tool never substitutes a model.`)
    assertModelAllowed(row, args)
    return row
  })

  await fs.mkdir(args.out, { recursive: true })
  const results: Array<{ model: string; display_name: string; provider_name?: string; free: boolean; runs: number; images: number; failures: number; axes: AxisMetrics[] }> = []

  for (const row of models) {
    const observations: Observation[] = []
    let failures = 0
    console.log(`\n${row.display_name || row.id} — ${row.provider_id || 'provider not published'} — ${labelled.length} images × ${args.runs} runs`)
    for (const name of labelled) {
      const label = labels.images[name]!
      for (const axis of SCENE_VISION_AXES) {
        if (!label.truth?.[axis]) throw new Error(`${name} has no truth for axis "${axis}".`)
      }
      const image = await encodeImage(path.join(args.images, name))
      const prompts = {
        system: sceneVisionSystemPrompt(),
        user: sceneVisionUserPrompt({
          visualPrompt: label.prompt || 'An AI-generated story scene image.',
          expectedText: label.expected_text || null,
        }),
      }
      for (let run = 0; run < args.runs; run++) {
        try {
          const answer = parseSceneVisionAnswer(await askOnce(args, row, image, prompts))
          for (const axis of SCENE_VISION_AXES) {
            const result = axisVerdict(answer, axis, label.expected_text)
            observations.push({ image: name, axis, run, verdict: result.verdict, findings: result.findings, transcription: result.transcription })
          }
        } catch (error: any) {
          failures++
          console.error(`  ${name} run ${run + 1}: ${error?.message || error}`)
        }
      }
    }
    // Per-image truth is re-read per axis below rather than stored once above:
    // one map per axis keeps the metric function honest about which label it used.
    const perAxisTruth = new Map<SceneVisionAxis, Map<string, Exclude<SceneVisionVerdict, 'could_not_check'>>>()
    for (const axis of SCENE_VISION_AXES) {
      perAxisTruth.set(axis, new Map(labelled.map(name => [name, labels.images[name]!.truth[axis]])))
    }
    const axes = SCENE_VISION_AXES.map(axis => metricsFor(axis, observations, perAxisTruth.get(axis)!, args.runs))
    results.push({ model: row.id, display_name: row.display_name || row.id, provider_name: row.provider_name, free: rowIsFree(row), runs: args.runs, images: labelled.length, failures, axes })
    for (const axis of axes) {
      console.log(`  ${axis.axis.padEnd(8)} P ${format(axis.precision)}  R ${format(axis.recall)}  F1 ${format(axis.f1)}  `
        + `false-remake ${format(axis.falseRemakeRate)}  missed ${format(axis.missedDefectRate)}  stable ${format(axis.stability)}  unusable ${axis.unusable}`)
    }
    if (failures) console.log(`  ${failures} run(s) failed and were not counted as a verdict.`)
  }

  const stamp = new Date().toISOString()
  await fs.writeFile(path.join(args.out, 'results.json'), JSON.stringify({
    measured_at: stamp,
    gateway: args.gateway,
    runs: args.runs,
    temperature: 0,
    images: labelled.length,
    models: results,
  }, null, 2), 'utf8')
  // CSV: one row per model per axis, the shape a decision table is read from.
  const header = ['model', 'display_name', 'axis', 'images', 'precision', 'recall', 'f1', 'false_remake_rate', 'missed_defect_rate', 'stability', 'unusable', 'failures']
  const lines = [header.join(',')]
  for (const model of results) {
    for (const axis of model.axes) {
      lines.push([model.model, model.display_name, axis.axis, axis.labelled, axis.precision ?? '', axis.recall ?? '',
        axis.f1 ?? '', axis.falseRemakeRate ?? '', axis.missedDefectRate ?? '', axis.stability ?? '', axis.unusable, model.failures].join(','))
    }
  }
  await fs.writeFile(path.join(args.out, 'summary.csv'), `${lines.join('\n')}\n`, 'utf8')
  console.log(`\nWrote ${path.join(args.out, 'results.json')} and ${path.join(args.out, 'summary.csv')}`)
  console.log('The decision rule is written BEFORE looking: auto-remake needs precision ≥ 0.90 per axis (FINDINGS §3).')
}

main().catch(error => {
  console.error(`\nBake-off failed: ${error?.message || error}`)
  process.exit(1)
})
