#!/usr/bin/env node
/**
 * Convert pinned, reviewed generated artwork into the preview contract for the
 * Illustrated History collection.
 *
 * This is the media step, not an authoring pass: it never generates an image and
 * never accepts a source it does not already know. Two kinds of pin exist:
 *
 * - `thumbnail-1` is the owner's 2026-10-21 Z-Image ROME sample, approved by the
 *   owner directly. Its provenance is preserved exactly as recorded.
 * - `thumbnail-2`, `thumbnail-3` and `style-1` are Qwen 2.1 Turbo renders the
 *   owner approved directly on 2026-10-21 after reviewing them: "i've check the
 *   generated images just now. they are all good quality and accepted."
 *
 * A slot with no pin refuses until the coordinator pins a reviewed render. The
 * earlier Qwen 2.1 Turbo sample with the misspelled subject line is not an input
 * to any slot and stays rejected.
 *
 * Run only in an authorised media lane:
 *   node content-packs/illustrated-history/prepare-previews.mjs --status
 *   node content-packs/illustrated-history/prepare-previews.mjs \
 *     --slot thumbnail-1 \
 *     --source ~/Developer/_orchestra/illustrated-sleep-history-20261021/sample/rome-thumbnail-sample.png
 *
 * Contract: whole-image resize(1672x941, cover, lanczos3) then WebP quality 90
 * effort 6. No crop, mask, overlay, composite or repair. Paired encodes must be
 * byte-identical.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const ROOT = dirname(fileURLToPath(import.meta.url))
const WIDTH = 1672
const HEIGHT = 941
const MIN_BYTES = 20 * 1024
const CONVERSION = Object.freeze({
  resize: { width: WIDTH, height: HEIGHT, fit: 'cover', kernel: 'lanczos3' },
  webp: { quality: 90, effort: 6 },
})

export const SLOTS = Object.freeze({
  'thumbnail-1': {
    output: 'thumbnail/illustrated-subject-sleep-badge/assets/illustrated-subject-sleep-badge-1.webp',
    subject: 'ROME',
    approved: {
      label: 'owner-approved Z-Image ROME sample, 2026-10-21',
      sha256: '749859235ae960661177e61effe98cfb97ff9510d3199f572dcd41eb9d828db3',
      bytes: 1428338,
      format: 'png',
      width: 1280,
      height: 720,
    },
  },
  'thumbnail-2': {
    output: 'thumbnail/illustrated-subject-sleep-badge/assets/illustrated-subject-sleep-badge-2.webp',
    subject: 'THE SILK ROAD',
    approved: {
      label: 'owner-approved Qwen 2.1 Turbo image, 2026-10-21',
      sha256: '9d538c4a660908168542ddd895c9b58e7d3c45d0ebafd6e6c3788af722db1912',
      bytes: 1243894,
      format: 'png',
      width: 1280,
      height: 720,
    },
  },
  'thumbnail-3': {
    output: 'thumbnail/illustrated-subject-sleep-badge/assets/illustrated-subject-sleep-badge-3.webp',
    subject: 'THE FALL OF CARTHAGE',
    approved: {
      label: 'owner-approved Qwen 2.1 Turbo image, 2026-10-21',
      sha256: 'f5a28b9cb767887224779d88975b37f233209e79b0029999b59b13a4d6ea6c1c',
      bytes: 1156789,
      format: 'png',
      width: 1280,
      height: 720,
    },
  },
  'style-1': {
    output: 'style/bold-illustrated-history/assets/bold-illustrated-history-hero.webp',
    subject: 'text-free style scene',
    approved: {
      label: 'owner-approved Qwen 2.1 Turbo image, 2026-10-21',
      sha256: '663d22b2730ba6f79e28753a18d47899377bde2afd44f9635e601fc8b44c1902',
      bytes: 1244646,
      format: 'png',
      width: 1280,
      height: 720,
    },
  },
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--status') {
      options.status = true
      continue
    }
    if (argument !== '--slot' && argument !== '--source') throw new Error(`unknown option: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`option requires a value: ${argument}`)
    options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function statusText() {
  return Object.entries(SLOTS).map(([slot, spec]) => {
    const state = !spec.approved
      ? 'pending (no pinned source; do not generate)'
      : spec.approved.label.startsWith('owner-approved ')
        ? 'ready (owner-approved source named)'
        : 'ready (coordinator-reviewed source named)'
    return `${slot}\t${state}\t${spec.output}`
  }).join('\n')
}

export async function convertPreview(slotId, sourcePath) {
  const slot = SLOTS[slotId]
  if (!slot) throw new Error(`unknown slot: ${slotId}`)
  if (!slot.approved) {
    throw new Error(`${slotId} has no pinned source; it stays pending until the coordinator pins a reviewed render`)
  }
  if (!sourcePath) throw new Error('--source is required')

  const source = await readFile(resolve(sourcePath))
  const sourceMeta = await sharp(source, { failOn: 'error' }).metadata()
  const observed = {
    sha256: sha256(source),
    bytes: source.byteLength,
    format: sourceMeta.format,
    width: sourceMeta.width,
    height: sourceMeta.height,
  }
  for (const field of ['sha256', 'bytes', 'format', 'width', 'height']) {
    if (observed[field] !== slot.approved[field]) {
      throw new Error(`source ${field} mismatch: expected ${slot.approved[field]}, got ${observed[field]}`)
    }
  }

  const encode = () => sharp(source, { failOn: 'error' })
    .resize(CONVERSION.resize)
    .webp(CONVERSION.webp)
    .toBuffer()

  const first = await encode()
  const second = await encode()
  if (!first.equals(second)) throw new Error('paired encodes differ; refusing a non-deterministic preview')

  const outputMeta = await sharp(first, { failOn: 'error' }).metadata()
  if (outputMeta.format !== 'webp' || outputMeta.width !== WIDTH || outputMeta.height !== HEIGHT) {
    throw new Error(`converted preview does not meet the contract: ${outputMeta.format} ${outputMeta.width}x${outputMeta.height}`)
  }
  if (first.byteLength <= MIN_BYTES) throw new Error(`converted preview is under the ${MIN_BYTES}-byte floor`)

  const output = join(ROOT, slot.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, first, { flag: 'wx' })

  return {
    slot: slotId,
    subject: slot.subject,
    source: { path: resolve(sourcePath), ...observed },
    conversion: CONVERSION,
    paired_output_byte_identity: 'PASS',
    output: { path: output, ...outputMeta, sha256: sha256(first), bytes: first.byteLength },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.status || (!options.slot && !options.source)) {
    process.stdout.write(`${statusText()}\n`)
    return
  }
  if (!options.slot) throw new Error('--slot is required')
  const result = await convertPreview(options.slot, options.source)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
