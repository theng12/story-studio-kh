/**
 * Production inventory reads for settings export (release 383).
 *
 * Three read-only GETs. Deliberately NOT built on GET /settings/config:
 * that handler runs the one-time llm-lineup migration before answering,
 * and an export loop must never trigger migrations. These handlers only
 * read — null/absent is reported as null/absent ("never recorded"), never
 * invented as a default, and corrupt files surface loudly instead of
 * being flattened into empty values.
 */

import { Router } from 'express'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import { resolveEpisodePathsByCodeWithSidecar } from '../services/utils.js'
import {
  readThumbnailOptionSettings,
  THUMBNAIL_OPTIONS_FILENAME,
} from '../services/thumbnail-option-settings.js'
import { resolveSubtitlesDir } from '../generators/subtitles.js'
import { SELECTED_SUBTITLE_SIDECAR } from '../lib/subtitle-selection.js'

export const router = Router()

// The image-prompts lettering scalars. thumbnail_template_id / style_tag are
// art-style state (exported elsewhere) and *_custom fields are request-time
// only — the server never persists them, so their absence here is honest.
const LETTERING_SCALAR_KEYS = ['thumb_font_style', 'thumb_text_style', 'thumb_text_position'] as const

/**
 * Every preset-pattern key config.json carries, keyed by its original config
 * name: `*_last_preset…` pointers keep their stored value exactly as written
 * (typed and legacy pointers both — no winner-take-all collapse), `*_presets`
 * lists keep their arrays. Served by the narrow pure reader
 * (pm.readPresetState), not getSafeConfig — an export GET must never reach
 * app secrets or readSettings' first-read chmod. isPresetConfigKey is the
 * only filter, so families the pipeline table doesn't know (video_subtitles,
 * video_effects, custom_…) are never hidden, while non-preset config and
 * masked secrets stay unexposed. A list that is not a list is corrupt, loud,
 * and a 500 rather than a quietly emptied export.
 */
router.get('/projects/:slug/settings/preset-state', async (req, res) => {
  const state = await pm.readPresetState(req.params.slug)
  if (!state) return res.status(404).json({ detail: 'Project not found' })
  for (const [key, value] of Object.entries(state.presets)) {
    if (value != null && !Array.isArray(value)) {
      return res.status(500).json({
        detail: `Preset list '${key}' in config.json is corrupt (expected a list, got ${typeof value}) — restore it before exporting.`,
      })
    }
  }
  res.json(state)
})

/**
 * Every accepted episode's stored image-prompts lettering scalars, keyed by
 * episode code. No sidecar → null (never recorded); a malformed sidecar is
 * EpisodeSettingFileUnreadable and propagates loudly.
 */
router.get('/projects/:slug/lettering-selections', async (req, res) => {
  const slug = String(req.params.slug)
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const ideas = await im.getIdeas(slug, 'accepted')
  const episodes: Record<string, unknown> = {}
  for (const idea of ideas) {
    const code = typeof idea.episode_code === 'string' ? idea.episode_code : ''
    if (!code) continue
    const dir = (await resolveEpisodePathsByCodeWithSidecar(slug, code, THUMBNAIL_OPTIONS_FILENAME)).episode_dir
    // Presence via stat with an ENOENT-only miss. readThumbnailOptionSettings
    // answers an absent file with empty defaults (indistinguishable from
    // "never recorded"), but existsSync() also reports EACCES/EISDIR on a
    // parent as "missing" — unreadable must stay loud, never export as null.
    let present = true
    try { await stat(path.join(dir, THUMBNAIL_OPTIONS_FILENAME)) }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      present = false
    }
    if (!present) { episodes[code] = null; continue }
    const settings = await readThumbnailOptionSettings(slug, code)
    const options: Record<string, Record<string, string>> = {}
    for (const [number, option] of Object.entries(settings.options ?? {})) {
      const row: Record<string, string> = {}
      for (const key of LETTERING_SCALAR_KEYS) {
        const value = (option as Record<string, unknown>)[key]
        if (typeof value === 'string' && value) row[key] = value
      }
      options[number] = row
    }
    episodes[code] = options
  }
  res.json({ episodes })
})

/**
 * Every accepted episode's pinned subtitle file, keyed by episode code.
 * Absent or empty sidecar → null (never recorded); an unreadable sidecar is
 * a loud 500 — deliberately NOT readSelectedSubtitle(), which swallows every
 * fs error into null and would misread corruption as "not recorded".
 */
router.get('/projects/:slug/subtitle-selections', async (req, res) => {
  const slug = String(req.params.slug)
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const ideas = await im.getIdeas(slug, 'accepted')
  const episodes: Record<string, string | null> = {}
  for (const idea of ideas) {
    const code = typeof idea.episode_code === 'string' ? idea.episode_code : ''
    if (!code) continue
    const sidecar = path.join(await resolveSubtitlesDir(slug, code), SELECTED_SUBTITLE_SIDECAR)
    // Read directly with an ENOENT-only miss: existsSync() calls EACCES on a
    // parent "absent", which would export an unreadable pin as never-recorded.
    let name: string
    try { name = (await readFile(sidecar, 'utf8')).trim() }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      episodes[code] = null
      continue
    }
    episodes[code] = name || null
  }
  res.json({ episodes })
})
