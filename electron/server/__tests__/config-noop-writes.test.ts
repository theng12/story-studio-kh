/**
 * A save that changes nothing must not rewrite config.json / project.json.
 *
 * Every episode-status row watches both files' mtimes, so on the owner's
 * 405-episode channel one no-op rewrite (the recency log re-saved after a
 * script that used nothing new, a page re-saving its last preset) staled the
 * whole Production Board and the next reads recomputed every episode.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const { recordUsage } = await import('../services/recency-tracker.js')
after(async () => { await temp.cleanup() })

const project = await pm.createProject({ name: 'No-op Writes' })
const dir = pm.getProjectDir(project.slug)!
const ino = async (file: string) => (await fs.stat(path.join(dir, file))).ino

test('an unchanged config or project save leaves the file untouched; a real change still writes', async () => {
  await pm.updateConfig(project.slug, { recency_lookback: 12 } as any)
  const config = await ino('config.json')
  await pm.updateConfig(project.slug, { recency_lookback: 12 } as any)
  assert.equal(await ino('config.json'), config, 'no-op config save must not replace config.json')
  await pm.updateConfig(project.slug, { recency_lookback: 13 } as any)
  assert.notEqual(await ino('config.json'), config, 'a real change is written')
  assert.equal((await pm.getConfig(project.slug) as any).recency_lookback, 13)

  await pm.updateProject(project.slug, { season_size: 30 } as any)
  const meta = await ino('project.json')
  const same = await pm.updateProject(project.slug, { season_size: 30 } as any)
  assert.equal(same?.season_size, 30)
  assert.equal(await ino('project.json'), meta, 'no-op project save must not replace project.json')
  await pm.updateProject(project.slug, { season_size: 31 } as any)
  assert.notEqual(await ino('project.json'), meta)
})

test('the recency log is not rewritten when a script used nothing new', async () => {
  const niche = { id: 'n', recencyAvoidance: { label: 'verses', extractPatterns: ['Psalm \\d+'] } } as any
  assert.deepEqual((await recordUsage(project.slug, 'EP0001', niche, 'Psalm 91 and Psalm 23'))?.added, ['Psalm 91', 'Psalm 23'])
  const config = await ino('config.json')
  assert.deepEqual((await recordUsage(project.slug, 'EP0001', niche, 'Psalm 91 again'))?.added, [])
  assert.equal(await ino('config.json'), config, 'nothing added, nothing written')
  assert.equal((await pm.getConfig(project.slug) as any).recency_log.length, 2)
})
