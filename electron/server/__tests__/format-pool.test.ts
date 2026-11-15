import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { FORMAT_POOL_MAX_MEMBERS } from '../contracts/format-pool.js'
import { normaliseFormatPool } from '../contracts/format-pool-schema.js'
import { EpisodeSettingFileUnreadable } from '../services/episode-sketch-pen.js'
import {
  formatMemberIndex,
  overlayThumbnailRequest,
  overlayTitleRequest,
  readEpisodeFormatAssignment,
  resolveEpisodeFormatAssignment,
  writeEpisodeFormatAssignment,
  EPISODE_FORMAT_ASSIGNMENT_FILENAME,
} from '../services/format-pool.js'
import { resolveThumbnailShell } from '../services/thumbnail-shell.js'

/**
 * The format pool (owner 2026-11-15) — "randomize from a pool of 1-10
 * formats ... default off ... applied to both metadata's title and thumbnail".
 *
 * Pins, in order: off means byte-identical today; the assignment is
 * deterministic and stable across reloads; a one-member pool equals today;
 * the SAME member drives the thumbnail fields and the metadata title style;
 * and the per-episode sidecar's read-never-creates contract.
 */

let cleanup: () => Promise<void>
let app: express.Express
let slug = ''
let episodeDir: string
const code = 'EP0001'
const freshCode = 'EP0002'
const assignmentEndpoint = (episode: string) => `/api/projects/${slug}/episodes/${episode}/format-assignment`
// Lazy: `slug` is only known after `before()` creates the project.
const configEndpoint = () => `/api/projects/${slug}/settings/config`

const MEMBER_A = { id: 'bold', label: 'Bold red', thumbnail_shell_id: '', thumb_font_style: 'chunky', title_mode: 'paraphrase', title_prefix: 'Ep ' }
const MEMBER_B = { id: 'calm', label: 'Calm blue', thumbnail_template_id: 'tpl-calm', thumb_text_style: 'none', title_mode: 'use_idea_title' }

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Format pool' })
  slug = project.slug
  episodeDir = (await resolveEpisodePaths(slug, code, '')).episode_dir
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.writeFile(path.join(episodeDir, 'scene_plan.json'), '{}', 'utf8')
  const freshDir = (await resolveEpisodePaths(slug, freshCode, '')).episode_dir
  await fs.mkdir(freshDir, { recursive: true })
  await fs.writeFile(path.join(freshDir, 'scene_plan.json'), '{}', 'utf8')
  const { router } = await import('../routes/settings.js')
  app = express().use(express.json()).use('/api', router)
})
after(async () => { await cleanup?.() })

describe('format pool contract', () => {
  test('absent, disabled or empty is OFF — null, never half-on', () => {
    assert.equal(normaliseFormatPool(undefined), null)
    assert.equal(normaliseFormatPool(null), null)
    assert.equal(normaliseFormatPool({}), null)
    assert.equal(normaliseFormatPool({ enabled: false, members: [MEMBER_A] }), null)
    assert.equal(normaliseFormatPool({ enabled: true, members: [] }), null)
    assert.equal(normaliseFormatPool({ enabled: true }), null)
    assert.equal(normaliseFormatPool('nope'), null)
  })

  test('a valid pool of 1..10 parses; 11 does not (the owner’s stated range)', () => {
    const one = normaliseFormatPool({ enabled: true, members: [MEMBER_A] })
    assert.ok(one)
    assert.equal(one.members.length, 1)
    const ten = normaliseFormatPool({ enabled: true, members: Array.from({ length: FORMAT_POOL_MAX_MEMBERS }, (_, i) => ({ id: `m${i}` })) })
    assert.ok(ten)
    assert.equal(ten.members.length, FORMAT_POOL_MAX_MEMBERS)
    const eleven = normaliseFormatPool({ enabled: true, members: Array.from({ length: FORMAT_POOL_MAX_MEMBERS + 1 }, (_, i) => ({ id: `m${i}` })) })
    assert.equal(eleven, null)
  })
})

describe('format pool config', () => {
  test('a channel saved before this feature reads back OFF', async () => {
    const res = await request(app).get(configEndpoint()).expect(200)
    assert.equal(res.body.format_pool, undefined)
  })

  test('the pool round-trips through settings config', async () => {
    const pool = { enabled: true, members: [MEMBER_A, MEMBER_B] }
    await request(app).put(configEndpoint()).send({ format_pool: pool }).expect(200)
    const res = await request(app).get(configEndpoint()).expect(200)
    assert.deepEqual(res.body.format_pool, pool)
  })

  test('the schema refuses a pool outside 1..10 at the trust boundary', async () => {
    const eleven = { enabled: true, members: Array.from({ length: FORMAT_POOL_MAX_MEMBERS + 1 }, (_, i) => ({ id: `m${i}` })) }
    await request(app).put(configEndpoint()).send({ format_pool: eleven }).expect(400)
    await request(app).put(configEndpoint()).send({ format_pool: { enabled: true, members: [] } }).expect(400)
  })
})

describe('per-episode assignment', () => {
  test('the pick is deterministic from the episode id and stable across reloads', async () => {
    const pool = normaliseFormatPool({ enabled: true, members: [MEMBER_A, MEMBER_B] })!
    assert.equal(formatMemberIndex(code, pool.members.length), formatMemberIndex(code, pool.members.length))

    // First resolve pins it (generation context); a later resolve — a fresh
    // read from disk, as after an app reload — returns the same member.
    const first = await resolveEpisodeFormatAssignment(slug, code, pool, { persist: true })
    assert.ok(first)
    const stored = await readEpisodeFormatAssignment(slug, code)
    assert.equal(stored, first.member.id)
    const second = await resolveEpisodeFormatAssignment(slug, code, pool)
    assert.equal(second!.member.id, first.member.id)
    assert.equal(second!.source, 'stored')
  })

  test('a read never creates the assignment file', async () => {
    const pool = normaliseFormatPool({ enabled: true, members: [MEMBER_A, MEMBER_B] })!
    const file = path.join(episodeDir.replace(code, freshCode), EPISODE_FORMAT_ASSIGNMENT_FILENAME)
    await fs.rm(file, { force: true })
    const read = await readEpisodeFormatAssignment(slug, freshCode)
    assert.equal(read, null)
    await assert.rejects(fs.stat(file), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    // …and resolving without persist (the display read) still creates nothing.
    await resolveEpisodeFormatAssignment(slug, freshCode, pool)
    await assert.rejects(fs.stat(file), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  })

  test('a one-member pool equals today: every episode gets that member, fields untouched', async () => {
    const pool = normaliseFormatPool({ enabled: true, members: [{ id: 'only', label: 'Only' }] })!
    const assignment = await resolveEpisodeFormatAssignment(slug, freshCode, pool)
    assert.equal(assignment!.member.id, 'only')
    assert.equal(assignment!.index, 0)
    // A member that defines nothing leaves the request byte-identical.
    const req = { thumb_font_style: 'auto', title_mode: 'use_idea_title' }
    assert.deepEqual(overlayThumbnailRequest(req, assignment!.member), req)
    assert.deepEqual(overlayTitleRequest(req, assignment!.member), req)
  })

  test('the SAME member drives the thumbnail fields and the metadata title style', async () => {
    const pool = normaliseFormatPool({ enabled: true, members: [MEMBER_A, MEMBER_B] })!
    const assignment = await resolveEpisodeFormatAssignment(slug, freshCode, pool, { persist: true })
    const member = assignment!.member
    const thumbReq = overlayThumbnailRequest({ thumb_font_style: 'auto', thumb_text_style: 'auto' }, member)
    const titleReq = overlayTitleRequest({ title_mode: 'use_idea_title', title_prefix: '' }, member)
    // Both overlays come from ONE resolved member — picture and title cannot disagree.
    assert.equal(thumbReq.thumb_font_style, member.thumb_font_style ?? 'auto')
    assert.equal(thumbReq.thumb_text_style, member.thumb_text_style ?? 'auto')
    assert.equal(titleReq.title_mode, member.title_mode ?? 'use_idea_title')
    assert.equal(titleReq.title_prefix, member.title_prefix ?? '')
  })

  test('an override wins, is editable back to the pool pick, and rejects unknown ids', async () => {
    const pool = { enabled: true, members: [MEMBER_A, MEMBER_B] }
    await request(app).put(configEndpoint()).send({ format_pool: pool }).expect(200)

    const other = MEMBER_A.id === (await readEpisodeFormatAssignment(slug, code)) ? MEMBER_B.id : MEMBER_A.id
    const pinned = await request(app).put(assignmentEndpoint(code)).send({ member_id: other }).expect(200)
    assert.equal(pinned.body.member.id, other)
    assert.equal(pinned.body.source, 'stored')

    const readBack = await request(app).get(assignmentEndpoint(code)).expect(200)
    assert.equal(readBack.body.member.id, other)
    assert.equal(readBack.body.source, 'stored')

    await request(app).put(assignmentEndpoint(code)).send({ member_id: 'not-in-pool' }).expect(400)
    await request(app).put(assignmentEndpoint(code)).send({ member_id: 7 }).expect(400)

    const released = await request(app).put(assignmentEndpoint(code)).send({ member_id: null }).expect(200)
    assert.equal(released.body.source, 'pooled')
    assert.ok(released.body.member)
  })

  test('with the pool off the assignment endpoint says so instead of inventing a member', async () => {
    const pm = await import('../services/project-manager.js')
    await pm.updateConfig(slug, { format_pool: { enabled: false, members: [MEMBER_A] } } as any)
    const res = await request(app).get(assignmentEndpoint(code)).expect(200)
    assert.equal(res.body.enabled, false)
    assert.equal(res.body.member, null)
    await request(app).put(assignmentEndpoint(code)).send({ member_id: MEMBER_A.id }).expect(400)
    await pm.updateConfig(slug, { format_pool: { enabled: true, members: [MEMBER_A, MEMBER_B] } } as any)
  })

  test('a malformed assignment file is loud, never silently “no assignment”', async () => {
    const file = path.join(episodeDir, EPISODE_FORMAT_ASSIGNMENT_FILENAME)
    const previous = await fs.readFile(file, 'utf8').catch(() => null)
    await fs.writeFile(file, '{ not json', 'utf8')
    await assert.rejects(readEpisodeFormatAssignment(slug, code), EpisodeSettingFileUnreadable)
    if (previous !== null) await fs.writeFile(file, previous, 'utf8')
  })
})

describe('the resolver in front of the shell choice', () => {
  test('off: the request and config choose the shell exactly as today', async () => {
    const resolved = await resolveThumbnailShell(slug, { thumbnail_shell_id: '' }, { thumbnail_shell_id: 'ignored' })
    assert.equal(resolved.id, '')
    assert.equal(resolved.name, 'No Shell')
  })

  test('on: the assigned member’s shell wins over the page’s picker', async () => {
    const config: any = { thumbnail_shell_id: 'page-would-lose', format_pool: { enabled: true, members: [{ id: 'only', thumbnail_shell_id: '' }] } }
    const resolved = await resolveThumbnailShell(slug, { episode_id: code, thumbnail_shell_id: 'page-choice' }, config)
    // Member says “No Shell” — the page's explicit picker does not disagree with the pool.
    assert.equal(resolved.id, '')
    assert.equal(resolved.name, 'No Shell')
  })

  test('on: a member’s shell id reaches the loader (a wrong id fails loudly, naming itself)', async () => {
    const config: any = { format_pool: { enabled: true, members: [{ id: 'only', thumbnail_shell_id: 'missing-tpl-xyz' }] } }
    await assert.rejects(
      resolveThumbnailShell(slug, { episode_id: code }, config),
      (error: Error) => error.message.includes('missing-tpl-xyz'),
    )
  })
})
