/**
 * Studio Library browsable view — the page and its components.
 *
 * The page used to list the Gateway archive bank as one text row per ARCHIVE:
 * a package id, a size and "Gateway verified", with the same pack repeated once
 * per version (Academic Classical Oil 1.0.0 and 1.0.1) and no picture anywhere.
 * Owner, 2026-10-30: "the studio library packs are all text and no images, so
 * it's hard to know which one is which. can we have it as a browse-able view
 * too?"
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, test } from 'node:test'
import { nextTick } from 'vue'

import { useViewMode } from '../composables/useViewMode'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const page = read('../pages/library.vue')
const browser = read('../components/content-store/ContentPackBrowser.vue')
const card = read('../components/content-store/ContentPackCard.vue')
const detail = read('../components/content-store/ContentPackDetail.vue')
const toggle = read('../components/ViewModeToggle.vue')

describe('the Studio Library lists packs, not archive rows', () => {
  test('the archive bank renders the browsable view and the text rows are gone', () => {
    assert.match(page, /<ContentPackBrowser/)
    assert.doesNotMatch(page, /gateway-archive-list/)
    assert.doesNotMatch(page, /class="gateway-archive-row"/)
    // The identifiers moved into the detail view, not deleted.
    assert.doesNotMatch(page, /function gatewayArchiveIdentity/)
  })

  test('the browser gets the catalogue for pictures and the installed list for state', () => {
    assert.match(page, /:archives="gatewayArchives"/)
    assert.match(page, /:products="discoverProducts"/)
    assert.match(page, /:installed="installed"/)
    assert.match(page, /:installs-resolved="installsResolved"/)
    assert.match(page, /@install="installFromGatewayArchive"/)
  })

  test('the archive bank has its own tab, so two grids of the same packs never stack', () => {
    assert.match(page, /\{ id: 'archives', label: 'Gateway archives' \}/)
    assert.match(page, /activeTab === 'archives'/)
    // The bank is a local read: a catalogue failure must not hide it.
    assert.match(page, /activeTab !== 'installed' && activeTab !== 'archives'/)
  })

  test('the archives tab counts packs, and an unread bank is an em dash', () => {
    assert.match(page, /new Set\(gatewayArchives\.value\.map\(archive => archive\.packId/)
    assert.match(page, /if \(tab === 'archives'\) return gatewayArchivesLoaded\.value \? String\(archivePackCount\.value\) : '—'/)
  })

  test('installing from the archive bank refreshes what this Mac reports', () => {
    assert.match(page, /await store\.installGatewayArchive/)
    assert.match(page, /store\.refresh\(\{ background: true \}\)/)
  })
})

describe('cards show a picture or say there is none', () => {
  test('a real cover is rendered and a broken one falls back in place', () => {
    assert.match(card, /:src="card\.cover\.src"/)
    assert.match(card, /@error="coverBroken = true"/)
  })

  test('no cover reads "No preview yet" — no invented art', () => {
    assert.match(card, /No preview yet/)
    assert.match(card, /card\.title\.slice\(0, 1\)/)
  })

  test('package ids, sizes and hashes stay out of the card', () => {
    assert.doesNotMatch(card, /archiveSha256/)
    assert.doesNotMatch(card, /card\.packId/)
    assert.doesNotMatch(card, /sizeBytes/)
  })

  test('one component serves both views, so the picture and the action cannot drift', () => {
    assert.match(browser, /:mode="viewMode"/)
    assert.match(card, /\[data-mode='list'\]/)
  })

  test('the card names its install state and offers Update, never a second copy', () => {
    assert.match(card, /Update available/)
    assert.match(card, /Install update/)
    assert.match(card, /installed_current/)
    // No install button while the local read is unresolved, and never a second
    // copy of a pack that is already current.
    assert.match(card, /installState !== 'unchecked'/)
    assert.match(card, /installState !== 'installed_current'/)
  })
})

describe('the detail view carries what the card left out', () => {
  test('shows larger art, contents, what it works with, versions and identity', () => {
    assert.match(detail, /No preview yet/)
    assert.match(detail, /What it contains/)
    assert.match(detail, /What it works with/)
    assert.match(detail, /Versions on the Gateway/)
    assert.match(detail, /Package ID/)
    assert.match(detail, /archiveSha256/)
    assert.match(detail, /Remove from this Mac/)
  })

  test('a missing compatibility fact is said plainly, not left blank', () => {
    assert.match(detail, /does not publish which packs this one works with/)
  })

  test('the dialog is the app modal, so focus and Escape behave like every other one', () => {
    assert.match(detail, /import Modal from '~\/components\/Modal\.vue'/)
    assert.match(detail, /<Modal :visible="visible" size="xl"/)
  })
})

describe('the view choice is remembered', () => {
  beforeEach(() => { localStorage.clear() })

  test('a stored List choice is restored before the first render', () => {
    localStorage.setItem('story-studio:studio-library:view', 'list')
    assert.equal(useViewMode('story-studio:studio-library:view').value, 'list')
  })

  test('an unusable stored value falls back to cards instead of throwing', () => {
    localStorage.setItem('story-studio:studio-library:view', 'gallery')
    assert.equal(useViewMode('story-studio:studio-library:view').value, 'cards')
  })

  test('changing the choice is written back for the next visit', async () => {
    const mode = useViewMode('story-studio:studio-library:view')
    mode.value = 'list'
    await nextTick()
    assert.equal(localStorage.getItem('story-studio:studio-library:view'), 'list')
  })

  test('the switch is one shared control with readable labels and pressed states', () => {
    assert.match(toggle, /aria-pressed="modelValue === option.value"/)
    assert.match(toggle, /label: 'Cards'/)
    assert.match(toggle, /label: 'List'/)
  })
})
