/**
 * Regression tests for upload-store.addAccount channel-swap behaviour.
 *
 * The single-account-per-platform invariant must hold, but a channel
 * SWAP (different remote_id) has to mint a fresh local id — otherwise
 * old upload sidecars keep their stale account_id pointer and metadata
 * PATCH calls get routed to the new channel's tokens against a videoId
 * that lives on the old channel, which YouTube returns as an opaque
 * 404.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let store: typeof import('../services/upload-store.js')

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  store = await import('../services/upload-store.js')
})

after(async () => { await cleanup() })

beforeEach(async () => {
  const projectsDir = path.join(tempDir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

async function mkProject(name = 'Upload Store Test'): Promise<string> {
  const p = await pm.createProject({ name })
  return p.slug
}

describe('upload-store.addAccount channel-swap', () => {
  test('reconnecting the SAME channel keeps the same id (sidecars/playlists stay valid)', async () => {
    const slug = await mkProject()
    const a = await store.addAccount(slug, 'youtube', {
      label: 'My Channel',
      remote_id: 'UC_AAA',
      remote_title: 'My Channel',
    })
    const b = await store.addAccount(slug, 'youtube', {
      label: 'My Channel (refreshed)',
      remote_id: 'UC_AAA',
      remote_title: 'My Channel',
    })
    assert.equal(b.id, a.id, 'same remote_id must reuse the existing local id')
  })

  test('connecting a DIFFERENT channel mints a fresh id (so stale sidecars no longer resolve)', async () => {
    const slug = await mkProject()
    const a = await store.addAccount(slug, 'youtube', {
      label: 'Channel A',
      remote_id: 'UC_AAA',
      remote_title: 'Channel A',
    })
    const b = await store.addAccount(slug, 'youtube', {
      label: 'Channel B',
      remote_id: 'UC_BBB',
      remote_title: 'Channel B',
    })
    assert.notEqual(b.id, a.id, 'channel swap must produce a different local id')
    assert.equal(b.remote_id, 'UC_BBB')
  })

  test('channel swap preserves the single-account-per-platform invariant', async () => {
    const slug = await mkProject()
    await store.addAccount(slug, 'youtube', {
      label: 'Channel A',
      remote_id: 'UC_AAA',
      remote_title: 'Channel A',
    })
    const b = await store.addAccount(slug, 'youtube', {
      label: 'Channel B',
      remote_id: 'UC_BBB',
      remote_title: 'Channel B',
    })
    const list = await store.listAccounts(slug, 'youtube')
    assert.equal(list.length, 1, 'list still holds exactly one account')
    assert.equal(list[0].id, b.id)
    const def = await store.getDefaultAccountId(slug, 'youtube')
    assert.equal(def, b.id, 'default pointer follows the new account')
  })

  test('channel swap drops the previous account\'s tokens', async () => {
    const slug = await mkProject()
    const a = await store.addAccount(slug, 'youtube', {
      label: 'Channel A',
      remote_id: 'UC_AAA',
      remote_title: 'Channel A',
    })
    await store.writeTokens(slug, 'youtube', a.id, {
      access_token: 'at-old',
      refresh_token: 'rt-old',
      expires_at: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/youtube.upload',
    })
    const b = await store.addAccount(slug, 'youtube', {
      label: 'Channel B',
      remote_id: 'UC_BBB',
      remote_title: 'Channel B',
    })
    const oldTokens = await store.readTokens(slug, 'youtube', a.id)
    const newTokens = await store.readTokens(slug, 'youtube', b.id)
    assert.equal(oldTokens, null, 'old account tokens must be wiped')
    assert.equal(newTokens, null, 'new account starts with no tokens until oauth completes')
  })
})
