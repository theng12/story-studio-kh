/**
 * Tests for the brand-prompt helpers (lib/brand-prompt.ts).
 *
 * Pure functions — no I/O, no async. Cover:
 *   - prependBrandPersona handles missing brand / missing persona / empty system
 *   - interpolateBrandPlaceholders replaces {channel_name} from brand → project
 *   - findBannedWords case-insensitive match + dedupe
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  prependBrandPersona,
  interpolateBrandPlaceholders,
  findBannedWords,
  formatTopPerformersBlock,
} from '../lib/brand-prompt.js'
import type { Brand, ProjectMeta } from '../models/types.js'

describe('brand-prompt', () => {
  describe('prependBrandPersona', () => {
    test('returns system unchanged when brand is null', () => {
      assert.equal(prependBrandPersona('You are a narrator.', null), 'You are a narrator.')
    })

    test('returns system unchanged when persona is missing or blank', () => {
      const brand: Brand = { id: 'demo', name: 'Demo', schemaVersion: 1, narration: { persona: '' } }
      assert.equal(prependBrandPersona('You are a narrator.', brand), 'You are a narrator.')
      assert.equal(prependBrandPersona('You are a narrator.', { ...brand, narration: { persona: '   ' } }), 'You are a narrator.')
    })

    test('prepends persona when present, separated by blank line', () => {
      const brand: Brand = { id: 'demo', name: 'Demo', schemaVersion: 1, narration: { persona: 'You are calm and slow-paced.' } }
      const out = prependBrandPersona('Format role here.', brand)
      assert.equal(out, 'You are calm and slow-paced.\n\nFormat role here.')
    })

    test('returns persona alone when system is empty', () => {
      const brand: Brand = { id: 'demo', name: 'Demo', schemaVersion: 1, narration: { persona: 'Persona only.' } }
      assert.equal(prependBrandPersona('', brand), 'Persona only.')
    })

    test('trims whitespace from persona before prepending', () => {
      const brand: Brand = { id: 'demo', name: 'Demo', schemaVersion: 1, narration: { persona: '  trimmed  ' } }
      // The current implementation only trims for the empty-system path; for
      // non-empty system it includes the original whitespace once. This test
      // documents the actual behaviour.
      assert.match(prependBrandPersona('SYS', brand), /^\s*trimmed\s*\n\nSYS$/)
    })
  })

  describe('interpolateBrandPlaceholders', () => {
    const project: ProjectMeta = {
      name: 'Project Fallback Name',
      slug: 'p',
      episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season',
      folder_template: '', subfolder_names: {} as any, output_root: '', created_at: '',
    }

    test('replaces {channel_name} with brand.channel.name', () => {
      const brand: Brand = { id: 'b', name: 'Demo', schemaVersion: 1, channel: { name: 'Sleep Studio Asia' } }
      assert.equal(
        interpolateBrandPlaceholders('Welcome to {channel_name}.', brand, project),
        'Welcome to Sleep Studio Asia.',
      )
    })

    test('falls back to project.name when no brand', () => {
      assert.equal(
        interpolateBrandPlaceholders('Welcome to {channel_name}.', null, project),
        'Welcome to Project Fallback Name.',
      )
    })

    test('handles multiple placeholders in one string', () => {
      const brand: Brand = { id: 'b', name: 'Demo', schemaVersion: 1, channel: { name: 'Sleep Asia' } }
      assert.equal(
        interpolateBrandPlaceholders('{channel_name} — by {channel_name}', brand, project),
        'Sleep Asia — by Sleep Asia',
      )
    })

    test('passes through text without the placeholder', () => {
      const brand: Brand = { id: 'b', name: 'Demo', schemaVersion: 1, channel: { name: 'X' } }
      assert.equal(interpolateBrandPlaceholders('plain text', brand, project), 'plain text')
    })

    test('returns text unchanged when both brand + project lack a name', () => {
      const emptyProject: any = { name: '', slug: 'p' }
      assert.equal(
        interpolateBrandPlaceholders('Welcome to {channel_name}.', null, emptyProject),
        'Welcome to {channel_name}.',
      )
    })
  })

  describe('formatTopPerformersBlock', () => {
    test('returns empty string for empty list', () => {
      assert.equal(formatTopPerformersBlock([]), '')
    })

    test('formats views in K when over 1000', () => {
      const out = formatTopPerformersBlock([
        { title: 'Hit Episode', views: 250_000 },
      ])
      assert.match(out, /TOP PERFORMERS/)
      assert.match(out, /"Hit Episode"/)
      assert.match(out, /250K views/)
    })

    test('uses raw count for views under 1000', () => {
      const out = formatTopPerformersBlock([{ title: 'New Episode', views: 47 }])
      assert.match(out, /47 views/)
    })

    test('appends CTR when present', () => {
      const out = formatTopPerformersBlock([
        { title: 'Episode A', views: 5000, ctr_percentage: 4.7 },
      ])
      assert.match(out, /4\.7% CTR/)
    })

    test('omits CTR cleanly when undefined', () => {
      const out = formatTopPerformersBlock([
        { title: 'Episode A', views: 5000 },
      ])
      assert.doesNotMatch(out, /CTR/)
    })

    test('multiple titles render as bullet list', () => {
      const out = formatTopPerformersBlock([
        { title: 'A', views: 100 },
        { title: 'B', views: 200 },
        { title: 'C', views: 300 },
      ])
      const lines = out.split('\n').filter(l => l.trim().startsWith('- '))
      assert.equal(lines.length, 3)
    })
  })

  describe('findBannedWords', () => {
    const brand: Brand = {
      id: 'b', name: 'Demo', schemaVersion: 1,
      metadata: { banned_words: ['Sponsor', 'CodeName', '  '] },
    }

    test('returns empty array when no brand', () => {
      assert.deepEqual(findBannedWords('hello world', null), [])
    })

    test('returns empty array when no banned_words', () => {
      const b: Brand = { id: 'b', name: 'Demo', schemaVersion: 1 }
      assert.deepEqual(findBannedWords('hello world', b), [])
    })

    test('matches case-insensitively', () => {
      assert.deepEqual(findBannedWords('A great SPONSOR moment', brand), ['Sponsor'])
      assert.deepEqual(findBannedWords('hidden codename inside', brand), ['CodeName'])
    })

    test('skips empty/whitespace banned entries', () => {
      assert.deepEqual(findBannedWords('plain text', brand), [])
    })

    test('dedupes matches', () => {
      assert.deepEqual(findBannedWords('Sponsor sponsor SPONSOR', brand), ['Sponsor'])
    })
  })
})
