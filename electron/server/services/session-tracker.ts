/**
 * Session tracker — saves generation activity per session.
 * Auto-saves snapshots on each generation event.
 * Persists to projects/{slug}/sessions.json
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { PROJECTS_ROOT, getProjectDir } from './project-manager.js'
import { writeJsonAtomic, withLock } from '../lib/atomic-store.js'

interface SessionEntry {
  session_id: string
  started_at: string
  last_active: string
  scripts_generated: number
  prompts_generated: number
  images_generated: number
  audio_generated: number
  descriptions_generated: number
  ideas_generated: number
  api_calls: number
  api_cost: number
  time_saved_min: number
}

interface SessionsStore {
  sessions: SessionEntry[]
  current_session_id: string
}

// Time saved estimates (minutes per asset)
const TIME_PER = {
  script: 120,
  prompts: 45,
  image: 10,
  audio: 15,
  description: 20,
  ideas: 5,
}

// Current session state (in-memory)
const currentSessions = new Map<string, SessionEntry>()
const SESSION_ID = `session-${Date.now()}`

function sessionsPath(slug: string): string {
  // Honour linked-project locations so sessions land alongside the
  // project rather than a phantom default-location dir.
  const dir = getProjectDir(slug) || path.join(PROJECTS_ROOT, slug)
  return path.join(dir, 'sessions.json')
}

async function loadSessions(slug: string): Promise<SessionsStore> {
  const p = sessionsPath(slug)
  if (existsSync(p)) {
    try {
      return JSON.parse(await fs.readFile(p, 'utf-8'))
    } catch {}
  }
  return { sessions: [], current_session_id: '' }
}

async function saveSessions(slug: string, store: SessionsStore): Promise<void> {
  await writeJsonAtomic(sessionsPath(slug), store)
}

function getOrCreateCurrentSession(slug: string): SessionEntry {
  if (!currentSessions.has(slug)) {
    currentSessions.set(slug, {
      session_id: SESSION_ID,
      started_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      scripts_generated: 0,
      prompts_generated: 0,
      images_generated: 0,
      audio_generated: 0,
      descriptions_generated: 0,
      ideas_generated: 0,
      api_calls: 0,
      api_cost: 0,
      time_saved_min: 0,
    })
  }
  return currentSessions.get(slug)!
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function trackGeneration(
  slug: string,
  type: 'script' | 'prompts' | 'image' | 'audio' | 'description' | 'ideas',
  count: number = 1,
  apiCost: number = 0,
): Promise<void> {
  const session = getOrCreateCurrentSession(slug)
  session.last_active = new Date().toISOString()
  session.api_calls += 1
  session.api_cost += apiCost

  switch (type) {
    case 'script': session.scripts_generated += count; session.time_saved_min += TIME_PER.script * count; break
    case 'prompts': session.prompts_generated += count; session.time_saved_min += TIME_PER.prompts * count; break
    case 'image': session.images_generated += count; session.time_saved_min += TIME_PER.image * count; break
    case 'audio': session.audio_generated += count; session.time_saved_min += TIME_PER.audio * count; break
    case 'description': session.descriptions_generated += count; session.time_saved_min += TIME_PER.description * count; break
    case 'ideas': session.ideas_generated += count; session.time_saved_min += TIME_PER.ideas * count; break
  }

  // Persist current session — serialize the read-modify-write so concurrent
  // generations (e.g. multi-image batches) can't clobber each other.
  await withLock(sessionsPath(slug), async () => {
    const store = await loadSessions(slug)
    const idx = store.sessions.findIndex(s => s.session_id === SESSION_ID)
    if (idx >= 0) {
      store.sessions[idx] = session
    } else {
      store.sessions.push(session)
    }
    store.current_session_id = SESSION_ID

    // Keep last 50 sessions
    if (store.sessions.length > 50) {
      store.sessions = store.sessions.slice(-50)
    }

    await saveSessions(slug, store)
  })
}

export async function getSessionStats(slug: string): Promise<{
  current: SessionEntry
  previous: SessionEntry | null
  all_time: { total_sessions: number; total_time_saved_min: number; total_api_cost: number; total_assets: number }
}> {
  const store = await loadSessions(slug)
  const current = getOrCreateCurrentSession(slug)

  // Find previous session (last one that isn't current)
  const previous = store.sessions
    .filter(s => s.session_id !== SESSION_ID)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0] || null

  // All time totals
  const allSessions = [...store.sessions.filter(s => s.session_id !== SESSION_ID), current]
  const allTime = {
    total_sessions: allSessions.length,
    total_time_saved_min: allSessions.reduce((sum, s) => sum + s.time_saved_min, 0),
    total_api_cost: allSessions.reduce((sum, s) => sum + s.api_cost, 0),
    total_assets: allSessions.reduce((sum, s) =>
      sum + s.scripts_generated + s.prompts_generated + s.images_generated +
      s.audio_generated + s.descriptions_generated + s.ideas_generated, 0),
  }

  return { current, previous, all_time: allTime }
}
