/**
 * STORY-2 — acceptance run on the LOCAL Studio Hub chat model, through gateway-kh.
 *
 * GatewayKH asked for four flows produced by the local model — an outline, a
 * chapter, a thumbnail prompt set and metadata — with receipts, and for a note
 * of "what the row did not tell us". This driver produces exactly that.
 *
 * It drives the app's OWN routes (never the database or the filesystem), the
 * same way `accept-01-driver.ts` does, and it never talks to the provider
 * directly: every artifact below was written by the real pipeline, and the
 * provider-side evidence is read afterwards from the gateway's own job table
 * (see docs/handoffs/deepseek-reports/STORY-2.md).
 *
 * Prerequisites:
 *   1. the dev app running on a disposable Library (STORY_STUDIO_DATA_DIR and
 *      --user-data-dir both under the run directory)
 *   2. the app pointed at the live gateway with its key:
 *        PUT /app-settings/genstudio          {url}
 *        PUT /app-settings/api-keys/genstudio {apiKey}
 *   3. `PUT /library {path}` happens below — a fresh data dir has no Library.
 *
 * Usage: npx tsx scripts/developer/story-2-local-model-run.ts
 *
 * Env overrides: STORY2_APP_URL, STORY2_LIBRARY, STORY2_SLUG, STORY2_MODEL,
 * STORY2_RECEIPTS, STORY2_CHAPTERS, STORY2_LENGTH.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const APP = process.env.STORY2_APP_URL || 'http://127.0.0.1:8791/api'
const LIBRARY = process.env.STORY2_LIBRARY || '/tmp/ssk-live/data'
const REQUESTED_SLUG = process.env.STORY2_SLUG || 'story-2-local-model-run-2026-09-26'
/** Set from the create response: the API slugifies the project NAME, so the
 *  slug it returns is the only one that identifies the project afterwards. */
let SLUG = REQUESTED_SLUG
const MODEL = process.env.STORY2_MODEL || 'studio-hub::mlx-community/Qwen3.5-9B-4bit'
const RECEIPTS = process.env.STORY2_RECEIPTS || '/tmp/ssk-live/receipts.json'
const CHAPTERS = Number(process.env.STORY2_CHAPTERS || 3)
const LENGTH = Number(process.env.STORY2_LENGTH || 8)

const TITLES = [
  'The Lighthouse That Kept Its Own Time',
  'The Cartographer of Sleeping Streets',
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const receipts: Record<string, any> = {
  started_at: new Date().toISOString(),
  app: APP,
  library: LIBRARY,
  slug: REQUESTED_SLUG,
  model: MODEL,
  chapters: CHAPTERS,
  length_minutes: LENGTH,
  steps: [] as any[],
}

/** One section of evidence, echoed as it happens and kept for the receipt file. */
function record(step: string, data: Record<string, any> = {}) {
  const entry = { step, at: new Date().toISOString(), ...data }
  receipts.steps.push(entry)
  console.log(`\n### ${step}`)
  for (const [k, v] of Object.entries(data)) {
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    console.log(`    ${k}: ${text.length > 2000 ? text.slice(0, 2000) + '…' : text}`)
  }
}

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* non-JSON error page */ }
  return { status: res.status, body: parsed, text }
}

/** Poll the app's own job list until the job reaches a terminal state. */
async function waitForJob(jobId: string, timeoutMs = 900_000) {
  const terminal = new Set(['done', 'error', 'cancelled'])
  const started = Date.now()
  let job: any = null
  while (Date.now() - started < timeoutMs) {
    await sleep(2000)
    const res = await call('GET', `/projects/${SLUG}/jobs`)
    const rows: any[] = res.body?.jobs || res.body || []
    const found = rows.find(r => r.job_id === jobId)
    if (found) job = found
    if (job && terminal.has(job.status)) {
      job.wall_ms = Date.now() - started
      return job
    }
  }
  if (job) job.wall_ms = Date.now() - started
  return job
}

const projectDir = () => path.join(LIBRARY, 'projects', SLUG)

function episodeDir(code: string): string | null {
  const season = path.join(projectDir(), 'episodes')
  if (!fs.existsSync(season)) return null
  for (const seasonName of fs.readdirSync(season)) {
    const dir = path.join(season, seasonName)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(code)) return path.join(dir, entry)
    }
  }
  return null
}

function filesUnder(dir: string | null): string[] {
  if (!dir || !fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${path.relative(dir, full)} (${fs.statSync(full).size}B)`)
    }
  }
  walk(dir)
  return out.sort()
}

/** What the job itself said, minus the noise every job carries. */
function jobSummary(job: any) {
  if (!job) return { status: 'missing' }
  return {
    job_id: job.job_id,
    type: job.type,
    status: job.status,
    error: job.error ?? null,
    wall_ms: job.wall_ms ?? null,
    output_lines: job.output_lines ?? [],
  }
}

async function ensureProjectAndEpisodes(): Promise<Array<{ code: string; title: string }>> {
  const existing = await call('GET', `/projects/${SLUG}`)
  if (existing.status !== 200) {
    const created = await call('POST', '/projects', {
      name: 'STORY-2 Local Model Run 2026-09-26',
      episode_prefix: 'EP',
      episode_digits: 4,
    })
    if (created.status !== 201) throw new Error(`project creation failed: ${created.status} ${created.text.slice(0, 300)}`)
    SLUG = created.body?.slug || SLUG
    record('project.create', { status: created.status, slug: SLUG, detail: created.body?.detail ?? null })
  } else {
    SLUG = existing.body?.slug || SLUG
    record('project.existing', { status: existing.status, slug: SLUG })
  }

  let episodes = (await call('GET', `/projects/${SLUG}/episodes`)).body || []
  for (const title of TITLES) {
    if (episodes.length >= TITLES.length) break
    const idea = await call('POST', `/projects/${SLUG}/ideas`, {
      title,
      logline: `A quiet, atmospheric short about ${title.toLowerCase()}.`,
      themes: ['memory', 'place', 'time'],
      suggested_chapters: CHAPTERS,
      suggested_length: `${LENGTH} min`,
      mood: 'contemplative',
    })
    const ideaId = idea.body?.id ?? idea.body?.[0]?.id
    record('idea.create', { title, status: idea.status, idea_id: ideaId ?? null })
    if (!ideaId) throw new Error(`idea creation returned no id: ${idea.text.slice(0, 300)}`)
    const accepted = await call('POST', `/projects/${SLUG}/ideas/${ideaId}/accept`, {})
    record('idea.accept', { title, status: accepted.status, episode_code: accepted.body?.episode_code ?? null, detail: accepted.body?.detail ?? null })
    episodes = (await call('GET', `/projects/${SLUG}/episodes`)).body || []
  }
  return episodes.map((e: any) => ({ code: e.episode_code, title: e.title }))
}

async function main() {
  record('app.health', { status: (await call('GET', '/health')).status })

  // ── the row, as the app itself ingested it ────────────────────────────────
  const overview = await call('GET', '/app-settings/genstudio/overview')
  record('gateway.overview', {
    status: overview.status,
    credit_balance: overview.body?.overview?.credit_balance ?? null,
    freshness: overview.body?.overview_freshness?.freshness ?? null,
  })
  const models = await call('GET', '/app-settings/genstudio/chat-models')
  const rows: any[] = models.body?.models || models.body || []
  const row = rows.find((m: any) => m.id === MODEL)
  record('gateway.model-row', {
    status: models.status,
    rows: rows.length,
    found: !!row,
    row_published: row ? {
      id: row.id,
      display_name: row.display_name,
      provider_name: row.provider_name,
      context_window_tokens: row.context_window_tokens,
      max_output_tokens: row.max_output_tokens,
      max_structured_items_per_request: row.max_structured_items_per_request,
      supports_structured_output: row.supports_structured_output,
      structured_output_mode: row.structured_output_mode,
      available: row.available,
      minimum_credits: row.minimum_credits,
      input_credits_per_million_tokens: row.input_credits_per_million_tokens,
      output_credits_per_million_tokens: row.output_credits_per_million_tokens,
      legacy_ids: row.legacy_ids,
      // Deliberately listed: these are the fields STORY-4 asks for, and their
      // ABSENCE here is the finding — the app drops provenance at the boundary.
      max_output_tokens_source: row.max_output_tokens_source ?? null,
      max_output_tokens_source_detail: row.max_output_tokens_source_detail ?? null,
    } : null,
  })
  if (!row) throw new Error(`${MODEL} is not in the catalogue the app receives`)

  // ── a disposable Library ─────────────────────────────────────────────────
  const library = await call('PUT', '/library', { path: LIBRARY })
  record('library.set', { status: library.status, detail: library.body?.detail ?? library.body?.path ?? library.text.slice(0, 200) })

  const episodes = await ensureProjectAndEpisodes()
  record('episodes', { episodes })

  for (const ep of episodes) {
    const { code, title } = ep
    console.log(`\n================ ${code} — ${title}`)

    // ── flow 1: outline ────────────────────────────────────────────────────
    const outlineEnqueue = await call('POST', `/projects/${SLUG}/generate/outline-only`, {
      episode_id: code, title, model: MODEL, length: LENGTH, chapters: CHAPTERS, style: 'auto',
    })
    let detail: any = { status: outlineEnqueue.status }
    if (outlineEnqueue.status === 201) {
      detail.job = jobSummary(await waitForJob(outlineEnqueue.body.job_id))
      const read = await call('GET', `/projects/${SLUG}/episodes/${code}/outline?title=${encodeURIComponent(title)}`)
      const slots = Array.isArray(read.body?.outline) ? read.body.outline.length : 0
      detail.outline_slots = slots
      detail.outline_disk = filesUnder(episodeDir(code)).filter(f => /outline/i.test(f))
      if (slots) {
        const approve = await call('PUT', `/projects/${SLUG}/episodes/${code}/outline?title=${encodeURIComponent(title)}`,
          { outline: read.body.outline, approved: true })
        detail.approved = approve.status === 200
      }
      receipts.outline = receipts.outline || {}
      receipts.outline[code] = detail
    } else {
      detail.body = outlineEnqueue.text.slice(0, 400)
    }
    record(`flow-1 outline (${code})`, detail)

    // ── flow 2: chapter ────────────────────────────────────────────────────
    const expandEnqueue = await call('POST', `/projects/${SLUG}/generate/expand-chapters`, { episode_id: code, title })
    detail = { status: expandEnqueue.status }
    if (expandEnqueue.status === 201) {
      detail.job = jobSummary(await waitForJob(expandEnqueue.body.job_id))
      detail.files = filesUnder(episodeDir(code)).filter(f => /chapter|narration|script/i.test(f))
      receipts.chapter = receipts.chapter || {}
      receipts.chapter[code] = detail
    } else {
      detail.body = expandEnqueue.text.slice(0, 400)
    }
    record(`flow-2 chapter (${code})`, detail)

    // ── flow 3: thumbnail prompt set ───────────────────────────────────────
    const thumbsEnqueue = await call('POST', `/projects/${SLUG}/generate/image-prompts`, {
      episode_id: code, title, model: MODEL, mode: 'thumbnails', fill_gaps: true,
    })
    detail = { status: thumbsEnqueue.status }
    if (thumbsEnqueue.status === 201) {
      detail.job = jobSummary(await waitForJob(thumbsEnqueue.body.job_id))
      detail.files = filesUnder(episodeDir(code)).filter(f => /thumb/i.test(f))
      receipts.thumbnail_prompts = receipts.thumbnail_prompts || {}
      receipts.thumbnail_prompts[code] = detail
    } else {
      detail.body = thumbsEnqueue.text.slice(0, 400)
    }
    record(`flow-3 thumbnail prompt set (${code})`, detail)

    // ── flow 4: metadata ───────────────────────────────────────────────────
    const pre = await call('GET', `/projects/${SLUG}/episodes/${code}/youtube-finalization-status`)
    const metaEnqueue = await call('POST', `/projects/${SLUG}/generate/metadata`, {
      episode_id: code, title, model: MODEL,
      // The Finalizer page stamps a fresh action id on every run; without one an
      // identical request is replayed by the provider (NEW-14).
      operation_id: crypto.randomUUID(),
    })
    detail = { status: metaEnqueue.status, preflight: pre.body ?? pre.text.slice(0, 200) }
    if (metaEnqueue.status === 201) {
      detail.job = jobSummary(await waitForJob(metaEnqueue.body.job_id))
      detail.postflight = (await call('GET', `/projects/${SLUG}/episodes/${code}/youtube-finalization-status`)).body ?? null
      detail.files = filesUnder(episodeDir(code)).filter(f => /metadata|youtube|desc|tag/i.test(f))
      receipts.metadata = receipts.metadata || {}
      receipts.metadata[code] = detail
    } else {
      detail.body = metaEnqueue.text.slice(0, 400)
    }
    record(`flow-4 metadata (${code})`, detail)

    record(`artifacts (${code})`, { files: filesUnder(episodeDir(code)) })
  }

  receipts.finished_at = new Date().toISOString()
  fs.mkdirSync(path.dirname(RECEIPTS), { recursive: true })
  fs.writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 2))
  console.log(`\nreceipts written to ${RECEIPTS}`)
}

main().catch(err => {
  receipts.failed_at = new Date().toISOString()
  receipts.failure = String(err?.stack || err)
  try { fs.writeFileSync(RECEIPTS, JSON.stringify(receipts, null, 2)) } catch { /* best effort */ }
  console.error('\nDRIVER FAILED:', err)
  process.exit(1)
})
