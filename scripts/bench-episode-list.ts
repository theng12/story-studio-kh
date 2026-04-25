/**
 * Benchmark for the /projects/:slug/episodes route's hot path.
 *
 * Calls the same logic the route runs (computeEpisodeStatus per accepted
 * idea, with concurrency 8) against the largest real project on disk and
 * reports cold + warm timings.
 *
 * Usage:
 *   npx tsx scripts/bench-episode-list.ts [slug] [runs=5]
 *
 * If slug omitted, picks the project with the most accepted ideas.
 *
 * Run BEFORE and AFTER each phase to measure improvement.
 */

import * as im from '../electron/server/services/idea-manager.js'
import * as pm from '../electron/server/services/project-manager.js'
import { episodeStatusCache } from '../electron/server/services/episode-status-cache.js'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs/promises'
import path from 'node:path'

async function pickLargestProject(): Promise<{ slug: string; accepted: number }> {
  const entries = await fs.readdir(pm.PROJECTS_ROOT, { withFileTypes: true })
  let best: { slug: string; accepted: number } | null = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const slug = e.name
    try {
      const ideas = await im.getIdeas(slug, 'accepted')
      const count = ideas.length
      if (!best || count > best.accepted) best = { slug, accepted: count }
    } catch { /* skip */ }
  }
  if (!best) throw new Error('no projects with accepted ideas found')
  return best
}

async function timeOne(slug: string): Promise<number> {
  const t0 = performance.now()
  const ideas = await im.getIdeas(slug, 'accepted')
  const CONCURRENCY = 8
  const results = new Array(ideas.length)
  let cursor = 0
  async function worker() {
    while (cursor < ideas.length) {
      const i = cursor++
      const idea = ideas[i]
      if (!idea.episode_code) { results[i] = null; continue }
      results[i] = await episodeStatusCache.get(slug, idea.episode_code, ideas)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ideas.length) }, worker))
  return performance.now() - t0
}

function summarise(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const median = sorted[Math.floor(sorted.length / 2)]
  const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length
  return `min=${min.toFixed(0)}  median=${median.toFixed(0)}  avg=${avg.toFixed(0)}  max=${max.toFixed(0)}  (ms)`
}

async function main() {
  const argSlug = process.argv[2]
  const runs = parseInt(process.argv[3] || '5', 10)

  let slug: string
  let accepted: number
  if (argSlug) {
    slug = argSlug
    accepted = (await im.getIdeas(slug, 'accepted')).length
  } else {
    const picked = await pickLargestProject()
    slug = picked.slug
    accepted = picked.accepted
  }

  console.log(`bench-episode-list  project="${slug}"  accepted=${accepted}  runs=${runs}`)
  console.log('')

  // ── COLD: clear in-memory + disk cache before each run, simulating a
  // truly fresh install (no .cache/episode-status.json exists yet).
  console.log('COLD (in-memory + disk cache cleared before each run):')
  const cold: number[] = []
  for (let i = 0; i < runs; i++) {
    episodeStatusCache.clear()
    const cachePath = path.join(pm.PROJECTS_ROOT, slug, '.cache', 'episode-status.json')
    await fs.rm(cachePath, { force: true })
    const ms = await timeOne(slug)
    cold.push(ms)
    console.log(`  run ${i + 1}: ${ms.toFixed(0)} ms`)
  }
  console.log(`  ${summarise(cold)}`)
  console.log('')

  // ── WARM: keep cache; subsequent runs should hit ──
  console.log('WARM (cache retained; subsequent runs should HIT):')
  const warm: number[] = []
  for (let i = 0; i < runs; i++) {
    const ms = await timeOne(slug)
    warm.push(ms)
    console.log(`  run ${i + 1}: ${ms.toFixed(0)} ms`)
  }
  console.log(`  ${summarise(warm)}`)
  console.log('')

  // ── HYDRATED: simulates app restart — flush to disk, clear in-memory,
  // then read should rehydrate from disk and serve cached.
  console.log('HYDRATED (in-memory cleared after flush; reads come from disk):')
  await episodeStatusCache.flushProjectNow(slug)
  episodeStatusCache.clear()
  const hyd: number[] = []
  for (let i = 0; i < runs; i++) {
    const ms = await timeOne(slug)
    hyd.push(ms)
    console.log(`  run ${i + 1}: ${ms.toFixed(0)} ms`)
  }
  console.log(`  ${summarise(hyd)}`)
  console.log(`  final cache stats: ${JSON.stringify(episodeStatusCache.getStats())}`)
}

main().catch(e => { console.error(e); process.exit(1) })
