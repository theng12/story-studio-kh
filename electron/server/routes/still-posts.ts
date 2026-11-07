/**
 * Still Posts REST surface.
 *
 *   GET    /projects/:slug/still-posts                     → the workspace payload
 *   PUT    /projects/:slug/still-posts/config              → the channel's cast, handle and logo
 *   PUT    /projects/:slug/still-posts/presets             → presets (look and branding only)
 *   GET    /projects/:slug/still-posts/characters/:id/portrait
 *   GET    /projects/:slug/still-posts/posts/:id/file/:name
 *   PUT    /projects/:slug/still-posts/posts/:id           → edit words; re-render immediately
 *   DELETE /projects/:slug/still-posts/posts/:id           → to the project's _trash
 *   POST   /projects/:slug/still-posts/batches             → write a batch (queued)
 *   POST   /projects/:slug/still-posts/render              → draw + letter a batch (queued)
 *
 * Everything the page shows is resolved server-side from the post record and the files on disk.
 * The page never decides that a post is finished.
 */

import { Router } from 'express'
import { existsSync } from 'fs'
import sharp from 'sharp'
import path from 'path'
import { respondWithError } from '../lib/humanize-backend-error.js'
import { referenceImagePath } from '../services/character-manager.js'
import * as pm from '../services/project-manager.js'
import * as jq from '../services/job-queue.js'
import {
  allowedArtifactNames,
  approvalKey,
  artFilenameFor,
  artModeOf,
  assertFontPoolCoversScript,
  brandingFor,
  buildWorkspace,
  channelHandle,
  channelLogoPath,
  commitFinals,
  createSinglePost,
  listChannelCharacters,
  lookForPost,
  panelsForOption,
  postDir,
  postStateFor,
  presetFontPools,
  readFontPoolCursor,
  readPost,
  redrawFile,
  resolveLogoPath,
  renderPostFinals,
  resolveRoster,
  setPostApproval,
  stillPostsConfig,
  trashPost,
  validatePostId,
  writePost,
} from '../services/still-posts.js'
import { stillPostFormat, stillPostOption } from '../still-posts/catalog.js'
import {
  STILL_POST_ASPECTS,
  STILL_POST_LANGUAGE_LABELS,
  STILL_POST_LANGUAGE_SCRIPT,
  isStillPostAspect,
  isStillPostsLanguage,
  type StillPostAspect,
  type StillPost,
  type StillPostBranding,
  type StillPostPanel,
} from '../contracts/still-posts.js'
import type { JobType } from '../models/types.js'
import { SocialError } from '../contracts/social-publishing.js'
import { publishStillPost, readStillPostPublishes } from '../services/still-post-publish.js'

export const router = Router()

function failSocial(res: import('express').Response, error: unknown, fallback: string): void {
  if (error instanceof SocialError) {
    res.status(error.statusCode).json(error.toPublic())
    return
  }
  respondWithError(res, error, fallback)
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function aspectsFrom(value: unknown): StillPostAspect[] {
  const list = Array.isArray(value) ? value.filter(isStillPostAspect) : []
  return list.length ? [...new Set(list)] : [...STILL_POST_ASPECTS]
}

/** The mark a preset gets when it saved none, so a stored preset always carries a complete object. */
const DEFAULT_BRANDING: StillPostBranding = {
  handle_enabled: true,
  handle_text: null,
  logo_enabled: true,
  position: 'bottom',
  handle_size_px: 30,
  logo_width_pct: 12,
  margin_pct: 4,
  opacity: 0.9,
}

function brandingFrom(value: unknown, fallback: StillPostBranding | null = null): StillPostBranding | null {
  const raw = asRecord(value)
  if (!raw || !Object.keys(raw).length) return fallback
  const position = typeof raw.position === 'string' ? raw.position : 'bottom'
  const allowed = new Set(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'])
  return {
    handle_enabled: raw.handle_enabled !== false,
    handle_text: typeof raw.handle_text === 'string' && raw.handle_text.trim() ? raw.handle_text.trim().replace(/^@/, '') : null,
    logo_enabled: raw.logo_enabled !== false,
    position: (allowed.has(position) ? position : 'bottom') as StillPostBranding['position'],
    handle_size_px: Math.max(10, Math.min(200, Number(raw.handle_size_px) || 30)),
    logo_width_pct: Math.max(2, Math.min(60, Number(raw.logo_width_pct) || 12)),
    margin_pct: Math.max(0, Math.min(20, Number(raw.margin_pct) || 4)),
    opacity: Math.max(0, Math.min(1, Number(raw.opacity ?? 0.9))),
  }
}

/** "Khmer (khmr)" — what a customer needs to act on a refusal about a pool entry. */
function scriptLabel(script: string): string {
  for (const [language, code] of Object.entries(STILL_POST_LANGUAGE_SCRIPT)) {
    if (code === script) return `${STILL_POST_LANGUAGE_LABELS[language as keyof typeof STILL_POST_LANGUAGE_LABELS]} (${script})`
  }
  return script
}

// ── The workspace ──────────────────────────────────────────────────────────

router.get('/projects/:slug/still-posts', async (req, res) => {
  try {
    if (!await pm.getProject(req.params.slug)) return res.status(404).json({ detail: 'Project not found' })
    const script = typeof req.query.script === 'string' ? req.query.script.trim() : ''
    res.json({
      ...(await buildWorkspace(req.params.slug)),
      publishes: await readStillPostPublishes(req.params.slug),
      // The standing rotation for one writing system, so a preview can show the
      // face the render would actually bind. Absent script = no cursor asked for;
      // an unassigned channel answers null, never an invented first face.
      ...(script ? { font_pool_cursor: await readFontPoolCursor(req.params.slug, script) } : {}),
    })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to load Still Posts')
  }
})

router.put('/projects/:slug/still-posts/config', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    const patch: Record<string, any> = {}

    if (Object.prototype.hasOwnProperty.call(body, 'character_ids')) {
      const characters = await listChannelCharacters(slug)
      const roster = resolveRoster(Array.isArray(body.character_ids) ? body.character_ids : [], characters)
      if (roster.unknown.length) {
        return res.status(400).json({
          detail: `These characters are not part of this channel: ${roster.unknown.join(', ')}. `
            + 'Add them on the Channel Characters page first, then choose them here.',
        })
      }
      if ((Array.isArray(body.character_ids) ? body.character_ids.length : 0) > 10) {
        return res.status(400).json({ detail: 'A channel can have at most 10 Still Posts characters.' })
      }
      patch.character_ids = roster.ids
    }

    if (Object.prototype.hasOwnProperty.call(body, 'handle')) {
      const handle = typeof body.handle === 'string' ? body.handle.trim().replace(/^@/, '') : ''
      if (handle.length > 60) return res.status(400).json({ detail: 'A handle can be at most 60 characters.' })
      patch.handle = handle || null
    }

    if (Object.prototype.hasOwnProperty.call(body, 'logo_path')) {
      const value = typeof body.logo_path === 'string' ? body.logo_path.trim() : ''
      // A portable path (`${CHANNEL}/assets/…`) is what the app's file picker writes now that typed
      // paths are retired; it is stored as given and resolved wherever the logo is drawn.
      if (value && !resolveLogoPath(value, pm.getProjectDir(slug))) {
        return res.status(400).json({ detail: `There is no logo file at ${value}.` })
      }
      patch.logo_path = value || null
    }

    const current = await pm.getConfig(slug)
    if (!current) return res.status(404).json({ detail: 'Project not found' })
    const merged = { ...(current as any).still_posts, ...patch }
    await pm.updateConfig(slug, { still_posts: merged })
    res.json({ ok: true, config: stillPostsConfig({ still_posts: merged }) })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to save the Still Posts channel settings')
  }
})

router.put('/projects/:slug/still-posts/presets', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    const list = Array.isArray(body.presets) ? body.presets : []
    const presets = list.map((entry: any) => {
      const data = asRecord(entry?.data)
      return {
        id: String(entry?.id || '').trim(),
        name: String(entry?.name || '').trim(),
        data: {
          ...data,
          // A reusable drawing choice (§5). Normalised so a preset always stores a real boolean.
          fresh_drawing_per_size: data.fresh_drawing_per_size === true,
          // The lettering pool is a reusable LOOK (§5), so the preset carries it. Normalised here so
          // a malformed or duplicated entry never reaches the writer.
          font_pools: presetFontPools(data.font_pools),
          branding: brandingFrom(data.branding, DEFAULT_BRANDING),
        },
      }
    }).filter(entry => entry.id && entry.name)
    // A face this build does not ship, or one whose manifest does not list the script, is refused by
    // name (AGENTS §1/§6) — never stored and later found unable to letter a post.
    for (const entry of presets) {
      for (const [script, pool] of Object.entries(entry.data.font_pools || {})) {
        try {
          await assertFontPoolCoversScript(pool, script, scriptLabel(script))
        } catch (error: any) {
          return res.status(400).json({ detail: `Preset "${entry.name}": ${error?.message || String(error)}` })
        }
      }
    }
    const current = await pm.getConfig(slug)
    if (!current) return res.status(404).json({ detail: 'Project not found' })
    await pm.updateConfig(slug, {
      still_post_presets: presets,
      ...(typeof body.last_preset_id === 'string' && body.last_preset_id.trim()
        ? { still_post_last_preset: body.last_preset_id.trim() }
        : {}),
    })
    res.json({ ok: true, presets: (await buildWorkspace(slug)).presets })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to save Still Posts presets')
  }
})

// ── Character portrait ─────────────────────────────────────────────────────

router.get('/projects/:slug/still-posts/characters/:characterId/portrait', async (req, res) => {
  try {
    const slug = req.params.slug
    const rows = await listChannelCharacters(slug)
    const row = rows.find(character => character.id === req.params.characterId)
    if (!row) return res.status(404).json({ detail: 'That character is not part of this channel.' })
    const character = row.portrait_path
    if (!character || !existsSync(character)) {
      return res.status(404).json({ detail: `'${row.name}' has no reference image yet.` })
    }
    // `allow` like every other file route here: the projects root can legitimately sit under a
    // dot-directory (and the test harness always does), and the path is built from an id we validate.
    res.sendFile(path.resolve(character), { dotfiles: 'allow' })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to load the character portrait')
  }
})

// ── Artifacts ──────────────────────────────────────────────────────────────

router.get('/projects/:slug/still-posts/posts/:postId/file/:name', async (req, res) => {
  try {
    const slug = req.params.slug
    const postId = validatePostId(req.params.postId)
    const post = await readPost(slug, postId)
    if (!post) return res.status(404).json({ detail: 'No such post in this channel.' })
    const name = String(req.params.name || '')
    if (!allowedArtifactNames(post.panels.length).has(name) || path.basename(name) !== name) {
      return res.status(400).json({ detail: 'That file is not part of this post.' })
    }
    const file = path.join(postDir(slug, postId), name)
    if (!existsSync(file)) return res.status(404).json({ detail: 'That image has not been made yet.' })
    const download = String(req.query.download || '') === '1'
    const filenameAsDownload = `still-${postId}-${name}`
    res.sendFile(path.resolve(file), {
      dotfiles: 'allow',
      headers: download ? { 'Content-Disposition': `attachment; filename="${filenameAsDownload}"` } : undefined,
    })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to load the image')
  }
})

// ── Editing a post ─────────────────────────────────────────────────────────

/**
 * Save the words (and look choices) of one post, then re-render its finals IMMEDIATELY.
 *
 * A render that refuses — the words do not fit the chosen box, or the sign has no glyph for them —
 * is reported beside the saved post rather than thrown away: the edit is real, and the sentence
 * says what to change. Nothing is silently drawn at a substituted size or in a substituted face.
 */
router.put('/projects/:slug/still-posts/posts/:postId', async (req, res) => {
  try {
    const slug = req.params.slug
    const postId = validatePostId(req.params.postId)
    const existing = await readPost(slug, postId)
    if (!existing) return res.status(404).json({ detail: 'No such post in this channel.' })

    const body = asRecord(req.body)
    const formatId = typeof body.format_id === 'string' ? body.format_id : existing.format_id
    const optionId = typeof body.option_id === 'string' ? body.option_id : existing.option_id
    const format = stillPostFormat(formatId)
    if (!format) return res.status(400).json({ detail: `Unknown format "${formatId}".` })
    const option = stillPostOption(optionId)
    if (!option) return res.status(400).json({ detail: `Unknown option "${optionId}".` })

    const language = isStillPostsLanguage(body.language) ? body.language : existing.language
    // §4: a recorded face belongs to one writing system. Changing the post's language to another
    // script REPLACES nothing and BLANKS the recorded face — carrying a Latin face onto a Khmer line
    // would draw the wrong letters. The customer is told, not quietly switched.
    const scriptChanged = STILL_POST_LANGUAGE_SCRIPT[language] !== STILL_POST_LANGUAGE_SCRIPT[existing.language]
    const fontNote = scriptChanged && existing.font_id
      ? `The language changed to ${STILL_POST_LANGUAGE_LABELS[language]}, so this post's recorded lettering `
        + `face was cleared and it now uses the format's own ${scriptLabel(STILL_POST_LANGUAGE_SCRIPT[language])} face. `
        + 'Draw it again to see the new face.'
      : null
    if (Array.isArray(body.aspects) && body.aspects.length === 0) {
      return res.status(400).json({ detail: 'Choose at least one export frame: 1:1, 9:16 or 16:9.' })
    }
    const aspects = aspectsFrom(body.aspects ?? existing.aspects)

    const rawCharacters = Array.isArray(body.character_ids) ? body.character_ids : existing.character_ids
    const characters = await listChannelCharacters(slug)
    const roster = resolveRoster(stillPostsConfig(await pm.getConfig(slug)).character_ids, characters)
    const foreign = [...new Set<string>(rawCharacters.filter((id: unknown): id is string => typeof id === 'string' && !!id))]
      .filter(id => !roster.ids.includes(id))
    if (foreign.length) {
      return res.status(400).json({
        detail: `These characters are not in this channel's Still Posts cast: ${foreign.join(', ')}. `
          + 'Add them to the channel first. Nothing was changed.',
      })
    }

    // Panels are rebuilt from the option, keeping each panel's own words by position.
    const incoming = Array.isArray(body.panels) ? body.panels : []
    const panels: StillPostPanel[] = panelsForOption(option, existing.panels).map((panel, index) => {
      const row = asRecord(incoming[index])
      const text = Object.prototype.hasOwnProperty.call(row, 'text') ? String(row.text ?? '') : panel.text
      const scene = Object.prototype.hasOwnProperty.call(row, 'scene_prompt') ? String(row.scene_prompt ?? '') : panel.scene_prompt
      return { ...panel, text: text.trim(), scene_prompt: scene.trim() }
    })
    for (const [index, panel] of panels.entries()) {
      if (!panel.text) {
        return res.status(400).json({
          detail: option.panels === 2
            ? `Panel ${index + 1} has no words. Every panel of this option needs a line.`
            : 'This post has no words. Type the line that should be burned in.',
        })
      }
    }

    const draft: StillPost = {
      ...existing,
      format_id: format.id,
      option_id: option.id,
      language,
      aspects,
      // BLANKED, never carried: see `scriptChanged` above.
      ...(scriptChanged ? { font_id: undefined } : {}),
      character_ids: [...new Set<string>(rawCharacters.filter((id: unknown): id is string => typeof id === 'string' && !!id))],
      caption: typeof body.caption === 'string' ? body.caption.slice(0, 2000) : existing.caption,
      panels,
    }
    // Approval belongs to the exact words and look that were approved: a change to any of them clears
    // it, so the post goes back to review. A caption-only edit keeps it.
    const post = await writePost(slug, approvalKey(draft) !== approvalKey(existing) ? { ...draft, approved_at: null } : draft)

    // Re-render now, with the branding the page is showing.
    const raw = (await pm.getConfig(slug)) || {}
    const config = stillPostsConfig(raw)
    const preset = asRecord(body.preset)
    const branding = brandingFrom(preset.branding, DEFAULT_BRANDING)
    const mark = brandingFor(branding!, {
      handle: channelHandle(raw, config),
      logoPath: channelLogoPath(raw, config, pm.getProjectDir(slug)),
      language: post.language,
      format,
    })
    const textScale = Number(preset.text_scale) > 0 ? Number(preset.text_scale) : 1
    const look = lookForPost(post, mark, textScale)

    let saved = post
    let renderError: string | null = null
    const mode = artModeOf(post)
    const dir = postDir(slug, post.id)
    // Per-size posts letter each frame from its OWN drawing, so every requested frame needs one.
    const artReady = post.panels.every((_, index) => mode === 'per-size'
      ? aspects.every(aspect => existsSync(path.join(dir, artFilenameFor(index, mode, aspect))))
      : existsSync(path.join(dir, artFilenameFor(index, mode, aspects[0]!))))
    if (artReady) {
      try {
        const rendered = await renderPostFinals(slug, saved, look, aspects)
        saved = await commitFinals(slug, saved, rendered)
      } catch (error: any) {
        renderError = error?.message || String(error)
      }
    } else {
      renderError = mode === 'per-size'
        ? 'This post is set to a fresh drawing per size and one of its frames has no artwork yet. Draw this post to see it.'
        : 'The artwork has not been drawn yet, so there is nothing to letter. Draw this post to see it.'
    }

    res.json({ post: saved, state: await postStateFor(slug, saved), render_error: renderError, font_note: fontNote })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to save the post')
  }
})

// ── The channel's logo ─────────────────────────────────────────────────────

/** The channel's logo art, so the picker can show the file it stored instead of naming a path. */
router.get('/projects/:slug/still-posts/logo', async (req, res) => {
  try {
    const slug = req.params.slug
    const raw = (await pm.getConfig(slug)) || {}
    const file = channelLogoPath(raw, stillPostsConfig(raw), pm.getProjectDir(slug))
    if (!file) return res.status(404).json({ detail: 'This channel has no logo file in place.' })
    res.sendFile(path.resolve(file), { dotfiles: 'allow' })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to load the logo')
  }
})

// ── Font samples ───────────────────────────────────────────────────────────

/**
 * One line of text drawn by the REAL lettering renderer in a bundled face, so the font picker shows
 * the face itself and not a label. No image model is involved: this is our own text renderer.
 *
 * A face that cannot draw the line is refused in words (AGENTS §1) — the picker then says so for that
 * face instead of showing a sample in a substituted font.
 */
router.get('/projects/:slug/still-posts/font-sample', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const fontId = String(req.query.font_id || '').trim()
    if (!fontId) return res.status(400).json({ detail: 'Choose a font to sample.' })
    const language = isStillPostsLanguage(req.query.language) ? req.query.language : 'en'
    const text = String(req.query.text || '').slice(0, 120) || 'Your words sit here'
    const scale = Math.max(0.5, Math.min(2, Number(req.query.scale) || 1))
    const canvas = { width: 900, height: 180 }
    const base = canvas.height / 180
    const { renderThumbnailText } = await import('../lib/thumbnail-text-render.js')
    const rendered = await renderThumbnailText({
      sourceBytes: await sharp({ create: { width: canvas.width, height: canvas.height, channels: 3, background: '#14161d' } }).png().toBuffer(),
      text,
      canvas,
      style: {
        font_id: fontId,
        weight: 600,
        size: { mode: 'fit', min_px: Math.round(22 * scale * base), max_px: Math.round(64 * scale * base) },
        max_lines: 1,
        align: 'center',
        line_height: 1.15,
        letter_spacing: 0,
        uppercase: false,
        fill: { type: 'solid', color: '#F4EFE6' },
        opacity: 1,
        outline: { enabled: false, color: '#000000', width_px: 0 },
        shadow: { enabled: false, color: '#000000', opacity: 0, dx: 0, dy: 0, blur_px: 0 },
        background: { enabled: false, color: '#000000', opacity: 0, padding_px: 0, radius_px: 0 },
        placement: { anchor: 'center', x_pct: 50, y_pct: 50, width_pct: 92, height_pct: 70 },
      },
    })
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.type('png').send(rendered.png)
  } catch (error: any) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 400
    res.status(status).json({ detail: error?.message || 'Could not draw this font sample.' })
  }
})

/**
 * Add one post by hand, before anything is drawn — so the batch can be read, edited, added to and
 * trimmed before a single picture is paid for.
 */
router.post('/projects/:slug/still-posts/posts', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    const text = String(body.text || '').trim()
    if (!text) return res.status(400).json({ detail: 'Type the line this post should carry.' })
    const format = stillPostFormat(String(body.format_id || ''))
    if (!format) return res.status(400).json({ detail: 'Choose a format for this post.' })
    const option = stillPostOption(String(body.option_id || ''))
    if (!option) return res.status(400).json({ detail: 'Choose a layout for this post.' })
    const language = isStillPostsLanguage(body.language) ? body.language : 'en'
    const aspects = aspectsFrom(body.aspects)

    const characters = await listChannelCharacters(slug)
    const roster = resolveRoster(stillPostsConfig(await pm.getConfig(slug)).character_ids, characters)
    const chosen = Array.isArray(body.character_ids)
      ? [...new Set<string>(body.character_ids.filter((id: unknown): id is string => typeof id === 'string' && !!id))]
      : [...roster.ids]
    const foreign = chosen.filter(id => !roster.ids.includes(id))
    if (foreign.length) {
      return res.status(400).json({
        detail: `These characters are not in this channel's Still Posts cast: ${foreign.join(', ')}. Add them on the channel first.`,
      })
    }

    const batchId = typeof body.batch_id === 'string' && /^batch-[a-z0-9][a-z0-9-]{0,79}$/.test(body.batch_id.trim())
      ? body.batch_id.trim()
      : `batch-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
    const post = await createSinglePost(slug, {
      text,
      scenePrompt: typeof body.scene_prompt === 'string' ? body.scene_prompt : '',
      caption: typeof body.caption === 'string' ? body.caption : '',
      batchId,
      format,
      option,
      language,
      aspects,
      characterIds: chosen,
    })
    res.status(201).json({ post, state: await postStateFor(slug, post) })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to add the post')
  }
})

// ── Review ─────────────────────────────────────────────────────────────────

/**
 * Approve (or clear the approval of) several posts at once. A post is approved only when it is complete
 * in every frame it asks for; each one that is not comes back with the sentence that says why.
 */
router.put('/projects/:slug/still-posts/approvals', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    if (!Array.isArray(body.post_ids) || !body.post_ids.length) {
      return res.status(400).json({ detail: 'Choose at least one post to approve or clear.' })
    }
    if (typeof body.approved !== 'boolean') {
      return res.status(400).json({ detail: 'Say whether these posts are approved (true) or not (false).' })
    }
    const ids = [...new Set<string>(body.post_ids.map((id: unknown) => validatePostId(String(id))))]
    res.json({ ok: true, ...(await setPostApproval(slug, ids, body.approved)) })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to update the approval')
  }
})

/**
 * One drawing a redo replaced, read from Trash so the old and the new can be compared. The record
 * decides which file; a path that is not this post's own is refused, never read.
 */
router.get('/projects/:slug/still-posts/posts/:postId/redraws/:index', async (req, res) => {
  try {
    const slug = req.params.slug
    const postId = validatePostId(req.params.postId)
    const post = await readPost(slug, postId)
    if (!post) return res.status(404).json({ detail: 'No such post in this channel.' })
    const index = Number(req.params.index)
    const record = Number.isInteger(index) ? post.redraws?.[index] : undefined
    const file = record ? redrawFile(slug, postId, record) : null
    if (!file) return res.status(404).json({ detail: 'That earlier drawing is no longer in the Trash.' })
    res.sendFile(path.resolve(file), { dotfiles: 'allow' })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to load the earlier drawing')
  }
})

router.delete('/projects/:slug/still-posts/posts/:postId', async (req, res) => {
  try {
    const postId = validatePostId(req.params.postId)
    const existing = await readPost(req.params.slug, postId)
    if (!existing) return res.status(404).json({ detail: 'No such post in this channel.' })
    await trashPost(req.params.slug, postId)
    res.json({ ok: true, moved_to_trash: `_trash/still-posts/${postId}` })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to remove the post')
  }
})

// ── Jobs ───────────────────────────────────────────────────────────────────

router.post('/projects/:slug/still-posts/batches', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    const count = Math.max(1, Math.min(40, Math.round(Number(body.count) || 0)))
    if (count < 1) return res.status(400).json({ detail: 'A batch needs at least one post.' })
    const format = stillPostFormat(String(body.format_id || ''))
    if (!format) return res.status(400).json({ detail: 'Choose a format for this batch.' })
    const option = stillPostOption(String(body.option_id || ''))
    if (!option) return res.status(400).json({ detail: 'Choose a post option for this batch.' })
    const language = isStillPostsLanguage(body.language) ? body.language : 'en'
    const aspects = aspectsFrom(body.aspects)
    const brief = String(body.brief || '').trim()
    if (!brief) return res.status(400).json({ detail: 'Write a brief so the batch knows what it is about.' })

    // The lettering pool is checked before a job is even queued: a face that cannot draw this
    // batch's script is refused here, by name, instead of failing inside the writer.
    const fontPools = presetFontPools(body.font_pools)
    const script = STILL_POST_LANGUAGE_SCRIPT[language]
    try {
      await assertFontPoolCoversScript(fontPools[script], script, scriptLabel(script))
    } catch (error: any) {
      return res.status(400).json({ detail: error?.message || String(error) })
    }

    const characters = await listChannelCharacters(slug)
    const roster = resolveRoster(stillPostsConfig(await pm.getConfig(slug)).character_ids, characters)
    const chosen = Array.isArray(body.character_ids)
      ? [...new Set<string>(body.character_ids.filter((id: unknown): id is string => typeof id === 'string' && !!id))]
      : [...roster.ids]
    const foreign = chosen.filter(id => !roster.ids.includes(id))
    if (foreign.length) {
      return res.status(400).json({
        detail: `These characters are not in this channel's Still Posts cast: ${foreign.join(', ')}. `
          + 'Add them on the channel first.',
      })
    }

    const batchId = `batch-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'still_post_write' as JobType,
      episode_id: '',
      title: `Still Posts — write ${count} (${format.name})`,
      params: {
        batch_id: batchId,
        brief,
        count,
        format_id: format.id,
        option_id: option.id,
        language,
        aspects,
        fresh_drawing_per_size: body.fresh_drawing_per_size === true,
        ...(Object.keys(fontPools).length ? { font_pools: fontPools } : {}),
        character_ids: chosen,
        writing_model: typeof body.writing_model === 'string' && body.writing_model.trim() ? body.writing_model.trim() : null,
      },
    })
    res.status(202).json({ job, batch_id: batchId })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to start writing the batch')
  }
})

router.post('/projects/:slug/still-posts/render', async (req, res) => {
  try {
    const slug = req.params.slug
    const body = asRecord(req.body)
    const imageModel = String(body.image_model || '').trim()
    if (!imageModel) {
      return res.status(400).json({ detail: 'Choose an image model before drawing. The model list is live — nothing is chosen for you.' })
    }
    const job = await jq.enqueue({
      project_slug: slug,
      type: 'still_post_render' as JobType,
      episode_id: '',
      title: body.batch_id ? `Still Posts — draw ${body.batch_id}` : 'Still Posts — draw posts',
      params: {
        ...(typeof body.batch_id === 'string' && body.batch_id.trim() ? { batch_id: body.batch_id.trim() } : {}),
        ...(Array.isArray(body.post_ids) && body.post_ids.length ? { post_ids: body.post_ids.map((id: string) => validatePostId(String(id))) } : {}),
        image_model: imageModel,
        redraw: body.redraw === true,
        ...(typeof body.fresh_drawing_per_size === 'boolean'
          ? { fresh_drawing_per_size: body.fresh_drawing_per_size }
          : {}),
        ...(brandingFrom(asRecord(body.preset).branding) ? { branding: brandingFrom(asRecord(body.preset).branding) } : {}),
        ...(Number(asRecord(body.preset).text_scale) > 0 ? { text_scale: Number(asRecord(body.preset).text_scale) } : {}),
      },
    })
    res.status(202).json({ job })
  } catch (error: any) {
    respondWithError(res, error, 'Failed to start drawing the batch')
  }
})

/**
 * Post one rendered Still Post to a platform the channel has turned on.
 *
 * Nothing posts by itself: the channel's own `social_platforms` list is the
 * switch, and an empty list refuses here in words. The answer says exactly
 * what happened — posted, already posted from this exact image, or why not.
 */
router.post('/projects/:slug/still-posts/posts/:id/publish', async (req, res) => {
  try {
    const slug = req.params.slug
    if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })
    const result = await publishStillPost(slug, req.params.id, asRecord(req.body).platform)
    res.json(result)
  } catch (error: any) {
    failSocial(res, error, 'Failed to post this image')
  }
})
