/**
 * 1.4.279 — the owner's 20% loudness allowance reaches every assembly. Jobs made outside run-batch
 * (retries of older jobs, resumed, conductor and recovery jobs) carried no `loudness_tolerance_pct`
 * and were checked at 10%: Night Atlas Science EP0002 (fb9be5b2) failed on a 0.4 dBTP peak.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
before(async () => { ({ cleanup } = await useTempDataDir()) })
after(async () => { await cleanup() })

async function channel(name: string, bundle?: Record<string, unknown>) {
  const pm = await import('../services/project-manager.js')
  const proj = await pm.createProject({ name })
  if (bundle) {
    const file = path.join(pm.getProjectDir(proj.slug)!, 'config.json')
    const config = JSON.parse(await fs.readFile(file, 'utf8'))
    config.video_bundle_presets = [{ id: 'va-1', name: 'Channel look', type: 'video_assembly', data: bundle }]
    config.video_bundle_last_preset = 'va-1'
    await fs.writeFile(file, JSON.stringify(config))
  }
  return proj.slug
}

test('a request without its own allowance takes the channel preset\'s, else the 20% default', async () => {
  const { channelLoudnessTolerancePct } = await import('../generators/video.js')
  const { loudnessTarget } = await import('../lib/final-loudness.js')
  assert.equal(await channelLoudnessTolerancePct(await channel('Loud Twenty', { fallback: { export: { loudness_tolerance_pct: 20 } } })), 20)
  assert.equal(await channelLoudnessTolerancePct(await channel('Loud Five', { fallback: { export: { loudness_tolerance_pct: 5 } } })), 5)
  const bare = await channel('Loud None')
  assert.equal(await channelLoudnessTolerancePct(bare), undefined)
  assert.equal(await channelLoudnessTolerancePct('no-such-channel'), undefined)
  assert.equal(loudnessTarget({ loudness_tolerance_pct: await channelLoudnessTolerancePct(bare) }).tolerance_pct, 20)
})

test('generateVideo resolves the allowance before the loudness target, and only when the request has none', async () => {
  const src = await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), '../generators/video.ts'), 'utf8')
  const at = src.indexOf("if (typeof req.loudness_tolerance_pct !== 'number') req.loudness_tolerance_pct = await channelLoudnessTolerancePct(project_slug)")
  assert.ok(at > 0 && at < src.indexOf('const loudness = { ...loudnessTarget(req)'))
})
