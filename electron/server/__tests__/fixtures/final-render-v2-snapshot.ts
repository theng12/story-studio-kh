// A real V2 intent_staged receipt with its durable private snapshot (manifest + staged sources) on disk.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { canonicalRenderValue, renderHash } from '../../lib/render-hash-v1.js'
import type { FinalRenderIntentStagedReceiptV2, Job } from '../../models/types.js'

const BASE_BYTES = Buffer.from('base-video\n')
const AUDIO_BYTES = Buffer.from('premixed-audio\n')
const BASE_SHA = '6c4b95afb685f756a1246a9cc09cd921cff0316ed14d084a669fb300ea9c016f'
const AUDIO_SHA = '01aceef8ed46964df52e9ca0ee4592016f755f6354df750a16f83cc82e8f1697'
export const STORY_ID = '33333333-3333-4333-8333-333333333333'
export const COMMITTED_AT = '2026-10-15T02:00:00.000Z'

export function intentId(identity = 1): string {
  return `render_${identity.toString(16).padStart(32, '4').slice(-32)}`
}

export function attemptId(identity = 1): string {
  const suffix = identity.toString(16).padStart(12, '5').slice(-12)
  return `55555555-5555-4555-8555-${suffix}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function localFence(prefix: string, value: unknown): string {
  return sha256(Buffer.concat([Buffer.from(`${prefix}\0`), Buffer.from(canonicalRenderValue(value))]))
}

export async function writeV2PrivateSnapshot(
  root: string,
  value: Job,
  identity = 1,
): Promise<FinalRenderIntentStagedReceiptV2> {
  const id = intentId(identity)
  const intentDir = path.join(root, 'private-render', 'intents', id)
  const sourceDir = path.join(root, 'work', value.project_slug, id)
  await fs.mkdir(intentDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  const originalBase = path.join(sourceDir, 'base.mp4')
  const originalAudio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(originalBase, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(originalAudio, AUDIO_BYTES, { mode: 0o600 })
  await fs.writeFile(path.join(intentDir, 'base.mp4'), BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(path.join(intentDir, 'audio.wav'), AUDIO_BYTES, { mode: 0o600 })

  const recipe = {
    namespace: 'studio.render.final.v1',
    profile_digest: '1'.repeat(64),
    base_video: { type: 'asset_ref', logical_id: 'base' },
    premixed_audio: { type: 'asset_ref', logical_id: 'audio' },
    canvas: { width: 128, height: 96, working_fps: 5 },
    target_duration_sec: 2,
    effects_gate: { start_sec: null, end_sec: null },
    operations: [],
    encode: {
      container: 'mp4', requested_codec: 'h264', requested_effort: 'ultrafast',
      crf: 23, quality_cpu_preset: 'ultrafast', bitrate_kbps: null,
    },
  }
  const packetManifest = [
    { logical_id: 'audio', safe_name: 'audio.wav', role: 'premixed_audio', sha256: AUDIO_SHA, size_bytes: 15 },
    { logical_id: 'base', safe_name: 'base.mp4', role: 'base_video', sha256: BASE_SHA, size_bytes: 11 },
  ]
  const recipeDigest = renderHash('recipe', recipe)
  const manifestDigest = renderHash('manifest', packetManifest)
  const packet = {
    recipe,
    manifest: packetManifest,
    recipe_digest: recipeDigest,
    manifest_digest: manifestDigest,
    packet_digest: renderHash('packet', { recipe_digest: recipeDigest, manifest_digest: manifestDigest }),
  }
  const sources = [
    { logical_id: 'base', role: 'base_video', safe_name: 'base.mp4', canonical_source_path: originalBase, size_bytes: 11, sha256: BASE_SHA },
    { logical_id: 'audio', role: 'premixed_audio', safe_name: 'audio.wav', canonical_source_path: originalAudio, size_bytes: 15, sha256: AUDIO_SHA },
  ]
  const composition = {
    execution_strategy: 'whole_video',
    local_segmentation_offered: false,
    still_tail_from_sec: null,
    recipe_sha256: recipeDigest,
  }
  const scope = {
    origin: 'https://private-render.invalid',
    owner_scope: '11111111-1111-4111-8111-111111111111',
    gateway_instance_id: '22222222-2222-4222-8222-222222222222',
    story_instance_id: STORY_ID,
  }
  const destination = {
    pathname: path.join(sourceDir, 'EP1_final_video.mp4'),
    route: { code: 'EP1', title: 'Intent staged', format: 'mp4', external: false },
    state: { kind: 'absent' },
    recovery_root: null,
  }
  const manifest = {
    format: 'studio.render.story-intent.v1',
    job_id: value.job_id,
    project_slug: value.project_slug,
    episode_id: value.episode_id,
    intent_id: id,
    story_instance_id: STORY_ID,
    story_attempt: 1,
    gateway_attempt_key: attemptId(identity),
    committed_at: COMMITTED_AT,
    scope,
    packet,
    sources,
    composition,
    destination,
    loudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
    descriptors: {
      profile: { utf8: '{"profile":1}', sha256: sha256('{"profile":1}') },
      tools: { utf8: '{"tools":1}', sha256: sha256('{"tools":1}') },
      compiler: { utf8: '{"compiler":1}', sha256: sha256('{"compiler":1}') },
    },
  }
  canonicalRenderValue(manifest)
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  await fs.writeFile(path.join(intentDir, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
  return {
    version: 2,
    phase: 'intent_staged',
    revision: 1,
    job_id: value.job_id,
    intent_id: id,
    story_instance_id: STORY_ID,
    story_attempt: 1,
    gateway_attempt_key: attemptId(identity),
    packet_sha256: packet.packet_digest,
    staging_manifest_sha256: sha256(manifestBytes),
    submission_scope_sha256: localFence('studio.render.story.scope.v1', scope),
    destination_fence_sha256: localFence('studio.render.story.destination.v1', destination),
    source_generation_fence_sha256: localFence('studio.render.story.sources.v1', { sources, composition }),
    committed_at: COMMITTED_AT,
    cancel_requested_at: null,
  }
}
