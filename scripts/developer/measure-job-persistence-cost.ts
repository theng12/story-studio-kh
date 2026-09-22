/**
 * DS-13 — job persistence + SSE cost measurement (measurement only; no caps,
 * no caching, no production change).
 *
 * WHY THIS EXISTS. The queue keeps every live job and up to
 * `MAX_PERSISTED_TERMINAL_HISTORY` terminal jobs, and a persistence pass
 * serializes the project's WHOLE retained history into `jobs.json`. History
 * depth is therefore a real input to two costs the customer can feel:
 *
 *   1. the atomic write on every dirty pass (bytes + elapsed), and
 *   2. the SSE frame sent to each subscriber whenever a running job's output
 *      fingerprint changes (the live log).
 *
 * This script measures those costs at 100 / 1,000 / 10,000 output lines and on
 * a full 750-job terminal history, records the machine/runtime, and proves the
 * mutation-burst coalescing that keeps a batch from becoming one write per
 * record. It is deliberately NOT a gate: timings vary by machine, and the
 * point is the recorded evidence, not a threshold.
 *
 * USAGE
 *   npx tsx scripts/developer/measure-job-persistence-cost.ts
 *
 * SAFETY. All work happens in a fresh temp dir pointed at by
 * STORY_STUDIO_DATA_DIR before the service modules are imported, so the
 * customer's real Library is never touched.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import type { Job } from '../../electron/server/models/types.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'story-studio-cost-'))
process.env.STORY_STUDIO_DATA_DIR = root

const pm = await import('../../electron/server/services/project-manager.js')
const jq = await import('../../electron/server/services/job-queue.js')

const LINES = [100, 1_000, 10_000]
const REALISTIC_TERMINAL_JOBS = jq.MAX_PERSISTED_TERMINAL_HISTORY
const REALISTIC_LINES_PER_JOB = 20
const BURST_MUTATIONS = 200
const REPEATS = 3

function makeJob(
  projectSlug: string,
  index: number,
  status: Job['status'],
  overrides: Partial<Job> = {},
): Job {
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString()
  const terminal = status === 'done' || status === 'error' || status === 'cancelled'
  return {
    job_id: `cost-${projectSlug}-${index}`,
    project_slug: projectSlug,
    type: 'script-only',
    episode_id: `EP${String(index % 10_000).padStart(4, '0')}`,
    title: `Cost probe ${index}`,
    status,
    created_at: created,
    started_at: status === 'queued' ? null : created,
    finished_at: terminal ? created : null,
    error: status === 'error' ? `Failure ${index}` : null,
    output_lines: [],
    params: {},
    ...overrides,
  }
}

function logLines(count: number, seed: string): string[] {
  return Array.from({ length: count }, (_, i) => `[${String(i).padStart(6, '0')}] ${seed} — line ${i} of ${count}`)
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

async function seedJobsFile(projectSlug: string, jobs: Job[]): Promise<string> {
  const file = path.join(root, 'projects', projectSlug, 'jobs.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ jobs }, null, 2))
  return file
}

async function fileBytes(file: string): Promise<number> {
  return (await fs.stat(file)).size
}

/** One real persistence pass: hydrate + retain + serialize + atomic write. */
async function measurePersistencePass(label: string, projectSlug: string, jobs: Job[], trigger: Job) {
  const file = await seedJobsFile(projectSlug, jobs)
  const beforeBytes = await fileBytes(file)
  const heapBefore = process.memoryUsage().heapUsed
  const countersBefore = jq._getJobPersistenceCountersForTesting()

  const started = performance.now()
  await jq.checkpointJobState(trigger)
  await jq._waitForJobPersistenceForTesting()
  const elapsedMs = performance.now() - started

  const afterBytes = await fileBytes(file)
  const heapAfter = process.memoryUsage().heapUsed
  const countersAfter = jq._getJobPersistenceCountersForTesting()

  console.log(`\n### ${label}`)
  console.log(`- seeded jobs.json (pretty-printed): ${mb(beforeBytes)}`)
  console.log(`- written jobs.json  (compact):      ${mb(afterBytes)}`)
  console.log(`- one persistence pass:             ${elapsedMs.toFixed(1)} ms`)
  console.log(`- heapUsed delta:                   ${mb(heapAfter - heapBefore)}`)
  console.log(`- atomic writes:                    ${countersAfter.atomic_writes - countersBefore.atomic_writes}`)
  return { beforeBytes, afterBytes, elapsedMs, heapDelta: heapAfter - heapBefore }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Seed + one pass, repeated on a fresh project so the number is not a warm-cache fluke. */
async function repeatedPersistencePass(
  label: string,
  projectName: string,
  buildJobs: (projectSlug: string) => { jobs: Job[]; trigger: Job },
  repeats = REPEATS,
) {
  const passes: number[] = []
  let last: Awaited<ReturnType<typeof measurePersistencePass>> | null = null
  for (let attempt = 0; attempt < repeats; attempt++) {
    const project = await pm.createProject({ name: attempt === 0 ? projectName : `${projectName} ${attempt + 1}` })
    const { jobs, trigger } = buildJobs(project.slug)
    last = await measurePersistencePass(
      attempt === 0 ? label : `${label} (repeat ${attempt + 1})`,
      project.slug,
      jobs,
      trigger,
    )
    passes.push(last.elapsedMs)
  }
  const medianMs = median(passes)
  console.log(`- **median of ${repeats} passes: ${medianMs.toFixed(1)} ms** (all: ${passes.map(v => v.toFixed(1)).join(', ')})`)
  return { ...last!, passes, medianMs }
}

console.log('# DS-13 — job persistence + SSE cost')
console.log(`\n- runtime: Node ${process.version} on ${process.platform}/${process.arch}`)
console.log(`- cpu: ${os.cpus()[0]?.model || 'unknown'} (${os.cpus().length} logical cores)`)
console.log(`- total memory: ${mb(os.totalmem())}`)
console.log(`- temp data dir: ${root}`)
console.log(`- MAX_PERSISTED_TERMINAL_HISTORY: ${jq.MAX_PERSISTED_TERMINAL_HISTORY}`)

// ── A. One terminal job whose log is N lines deep ──────────────────────────
const lineResults: Array<{ lines: number; bytes: number; medianMs: number; passes: number[]; heap: number }> = []
for (const lineCount of LINES) {
  const measured = await repeatedPersistencePass(
    `A. one terminal job with ${lineCount.toLocaleString()} output lines`,
    `Cost ${lineCount}`,
    slug => {
      const trigger = makeJob(slug, 2, 'cancelled')
      return {
        jobs: [makeJob(slug, 1, 'done', { output_lines: logLines(lineCount, 'ffmpeg progress') }), trigger],
        trigger,
      }
    },
  )
  lineResults.push({
    lines: lineCount,
    bytes: measured.afterBytes,
    medianMs: measured.medianMs,
    passes: measured.passes,
    heap: measured.heapDelta,
  })
}

// ── B. SSE frame cost for the live log ─────────────────────────────────────
// The routes write `event: update\ndata: ${JSON.stringify(job)}\n\n` per
// subscriber. `checkpointJobState` runs the same public serialization the
// stream sends, so a listener measures the real per-frame payload — and every
// changed frame carries the job's WHOLE `output_lines` array.
console.log('\n### B. SSE update frame bytes (one subscriber)')
for (const lineCount of LINES) {
  const project = await pm.createProject({ name: `Sse ${lineCount}` })
  const running = makeJob(project.slug, 1, 'running', { output_lines: logLines(lineCount, 'render') })
  let frames = 0
  let bytes = 0
  const onUpdate = (job: Job) => {
    frames++
    bytes += Buffer.byteLength(`event: update\ndata: ${JSON.stringify(job)}\n\n`)
  }
  jq.jobEvents.on('update', onUpdate)
  try {
    await jq.checkpointJobState(running)
  } finally {
    jq.jobEvents.off('update', onUpdate)
  }
  const frameBytes = frames > 0 ? bytes / frames : 0
  console.log(`- ${String(lineCount).padStart(6)} lines: ${frames} frame(s), ${kb(frameBytes)} per frame`)
  console.log(`  - one flush at 1 / 2 / 4 subscribers: `
    + [1, 2, 4].map(n => `${n}× ${kb(frameBytes * n)}`).join('  '))
}

// ── C. A realistic full terminal history ───────────────────────────────────
{
  await repeatedPersistencePass(
    `C. full terminal history: ${REALISTIC_TERMINAL_JOBS} jobs × ${REALISTIC_LINES_PER_JOB} lines`,
    'Cost realistic',
    slug => {
      const history = Array.from({ length: REALISTIC_TERMINAL_JOBS }, (_, index) => makeJob(
        slug,
        index,
        index % 2 === 0 ? 'done' : 'error',
        { output_lines: logLines(REALISTIC_LINES_PER_JOB, 'chapter') },
      ))
      const trigger = makeJob(slug, 99_999, 'cancelled')
      return { jobs: [...history, trigger], trigger }
    },
  )
}

// ── D. Mutation burst coalescing ───────────────────────────────────────────
{
  const project = await pm.createProject({ name: 'Cost burst' })
  const base = makeJob(project.slug, 1, 'done', { output_lines: logLines(200, 'burst') })
  await seedJobsFile(project.slug, [base])
  jq._waitForJobPersistenceForTesting()
  jq._resetJobPersistenceCountersForTesting()

  const started = performance.now()
  const burst = Array.from({ length: BURST_MUTATIONS }, (_, index) => {
    const next = { ...base, output_lines: [...base.output_lines, `burst line ${index}`] }
    return jq.checkpointJobState(next as Job)
  })
  await Promise.all(burst)
  await jq._waitForJobPersistenceForTesting()
  const elapsedMs = performance.now() - started
  const counters = jq._getJobPersistenceCountersForTesting()
  console.log(`\n### D. ${BURST_MUTATIONS} mutations issued as one burst`)
  console.log(`- atomic writes:            ${counters.atomic_writes}`)
  console.log(`- public serializations:    ${counters.public_serializations}`)
  console.log(`- project snapshot reads:   ${counters.project_snapshot_reads}`)
  console.log(`- elapsed:                  ${elapsedMs.toFixed(1)} ms`)
  console.log(`- writes per mutation:      ${(counters.atomic_writes / BURST_MUTATIONS).toFixed(3)}`)
}

await fs.rm(root, { recursive: true, force: true })

console.log('\n## Summary')
console.log('| case | jobs.json bytes | one pass, median of 3 (ms) | all passes (ms) |')
console.log('|---|---|---|---|')
for (const row of lineResults) {
  console.log(`| 1 terminal job, ${row.lines.toLocaleString()} lines | ${mb(row.bytes)} | ${row.medianMs.toFixed(1)} | ${row.passes.map(v => v.toFixed(1)).join(', ')} |`)
}
