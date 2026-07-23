/**
 * Tests for `usePresets` — per-tab preset storage backed by project config.
 *
 * The composable is a thin wrapper over two endpoints:
 *   - GET  /projects/:slug/settings/config  → read `{configKey}_presets` + `{configKey}_last_preset`
 *   - PUT  /projects/:slug/settings/config  → write both
 *
 * These tests pin the five user-facing actions (load, saveAs, overwrite,
 * remove, setActive) and one subtle behaviour: `load()` auto-applies the
 * active preset on mount so the form doesn't silently revert to defaults
 * when a user returns to a tab.
 *
 * `$fetch` is stubbed with an in-memory store so the test models the real
 * backend's round-trip without a network.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ── In-memory config store driving the stubbed $fetch ───────────────────────

const configStore: Record<string, any> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const match = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (!match) throw new Error(`unexpected fetch: ${url}`)
  const slug = match[1]
  if (!configStore[slug]) configStore[slug] = {}
  if (!options.method || options.method === 'GET') return { ...configStore[slug] }
  if (options.method === 'PUT') {
    Object.assign(configStore[slug], options.body)
    return { ok: true }
  }
  throw new Error(`unexpected method: ${options.method}`)
}

const { usePresets } = await import('../composables/usePresets.js')

beforeEach(() => {
  for (const k of Object.keys(configStore)) delete configStore[k]
})

// Helper: construct a presets composable keyed to a snapshot/apply pair
// that just reads/writes a plain object so tests can assert on apply() calls.
function makeController(slug: string) {
  const form: Record<string, any> = { value: 0 }
  const applied: Array<Record<string, any>> = []
  const presets = usePresets<Record<string, any>>({
    slug,
    configKey: 'script',
    snapshot: () => ({ ...form }),
    apply: (data) => { Object.assign(form, data); applied.push({ ...data }) },
  })
  return { presets, form, applied }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('usePresets.load()', () => {
  test('populates presets + activeId from config and auto-applies active preset', async () => {
    configStore['proj'] = {
      script_presets: [
        { id: 'p1', name: 'Fast', data: { value: 42 } },
        { id: 'p2', name: 'Slow', data: { value: 7 } },
      ],
      script_last_preset: 'p1',
    }
    const { presets, form, applied } = makeController('proj')
    await presets.load()

    assert.equal(presets.presets.value.length, 2)
    assert.equal(presets.activeId.value, 'p1')
    assert.equal(form.value, 42, 'form must be auto-populated from the active preset')
    assert.equal(applied.length, 1, 'apply() fired exactly once for the active preset')
  })

  test('handles an empty / missing config gracefully', async () => {
    const { presets } = makeController('fresh-project')
    await presets.load()
    assert.deepEqual(presets.presets.value, [])
    assert.equal(presets.activeId.value, '')
  })

  test('merges legacy device-scoped presets into one local list and retires origin labels', async () => {
    configStore['legacy-devices'] = {
      script_presets: [
        { id: 'mac-a', name: 'Calm narration', data: { value: 1 }, machine_label: 'studio-a' },
        { id: 'mac-b', name: 'Fast narration', data: { value: 2 }, machine_label: 'studio-b' },
      ],
      script_last_preset: 'mac-a',
    }

    const { presets, form } = makeController('legacy-devices')
    await presets.load()

    assert.deepEqual(presets.presets.value.map(p => p.id), ['mac-a', 'mac-b'])
    assert.equal(form.value, 1, 'the remembered preset still applies after migration')
    assert.ok(presets.presets.value.every(p => !('machine_label' in p)))

    form.value = 3
    await presets.saveAs('New local preset')
    const stored = configStore['legacy-devices'].script_presets
    assert.equal(stored.length, 3)
    assert.ok(stored.every((p: Record<string, unknown>) => !('machine_label' in p)))
  })

  test('skips apply when activeId points to a preset that no longer exists', async () => {
    configStore['stale-pointer'] = {
      script_presets: [{ id: 'p1', name: 'Fast', data: { value: 1 } }],
      script_last_preset: 'missing-id',
    }
    const { presets, applied } = makeController('stale-pointer')
    await presets.load()
    assert.equal(presets.activeId.value, 'missing-id')
    assert.equal(applied.length, 0, 'apply() not called when active preset is missing')
  })

  test('custom exclusions strip stale nested fields before apply', async () => {
    configStore['audio-project'] = {
      audio_generator_presets: [{
        id: 'audio-1',
        name: 'Voice preset',
        data: {
          form: {
            model: 'tts-model',
            voice: 'voice-1',
            sections: 'Chapter_01,Chapter_02',
            max_chunk_chars: 500,
          },
        },
      }],
      audio_generator_last_preset: 'audio-1',
    }
    const form: Record<string, any> = { model: '', voice: '', sections: 'Introduction' }
    const presets = usePresets<any>({
      slug: 'audio-project',
      configKey: 'audio_generator',
      snapshot: () => ({ form: { ...form } }),
      apply: data => Object.assign(form, data.form),
      excludeKeys: ['episode_id', 'episodeId', 'episode', 'title', 'sections', 'max_chunk_chars'],
    })

    await presets.load()
    assert.equal(form.model, 'tts-model')
    assert.equal(form.voice, 'voice-1')
    assert.equal(form.sections, 'Introduction', 'legacy preset cannot overwrite the episode selection')
    assert.equal('max_chunk_chars' in form, false, 'legacy preset cannot restore retired TTS chunking')

    await presets.overwrite()
    const stored = configStore['audio-project'].audio_generator_presets[0]
    assert.equal('max_chunk_chars' in stored.data.form, false, 'next preset save permanently removes the retired field')
  })
})

describe('usePresets.saveAs() / overwrite() / remove() / setActive()', () => {
  test('saveAs() appends a new preset, flips activeId to it, persists', async () => {
    const { presets, form } = makeController('s1')
    await presets.load()
    form.value = 99
    const created = await presets.saveAs('My Preset')

    assert.ok(created)
    assert.equal(presets.presets.value.length, 1)
    assert.equal(presets.activeId.value, created.id)
    assert.equal(presets.presets.value[0].data.value, 99)

    // Persisted to the store: reload a fresh controller and assert.
    const fresh = makeController('s1')
    await fresh.presets.load()
    assert.equal(fresh.presets.presets.value.length, 1)
    assert.equal(fresh.presets.activeId.value, created.id)
    assert.equal(fresh.form.value, 99)
  })

  test('overwrite() updates the active preset\'s data', async () => {
    const { presets, form } = makeController('s2')
    await presets.load()
    form.value = 1
    await presets.saveAs('Initial')
    form.value = 2
    const updated = await presets.overwrite()

    assert.ok(updated)
    assert.equal(updated.data.value, 2)
    assert.equal(presets.presets.value.length, 1, 'no extra preset created')
  })

  test('overwrite() is a no-op when no preset is active', async () => {
    const { presets } = makeController('s3')
    await presets.load()
    const result = await presets.overwrite()
    assert.equal(result, null, 'returns null without mutating state')
    assert.equal(presets.presets.value.length, 0)
  })

  test('remove() deletes the active preset and clears activeId', async () => {
    const { presets, form } = makeController('s4')
    await presets.load()
    form.value = 5
    const created = await presets.saveAs('Doomed')
    assert.ok(created)
    assert.equal(presets.presets.value.length, 1)

    const removed = await presets.remove()
    assert.ok(removed)
    assert.equal(presets.presets.value.length, 0)
    assert.equal(presets.activeId.value, '', 'activeId cleared after removing the active preset')
  })

  test('rename() changes only the active preset name and preserves its saved settings', async () => {
    const { presets, form } = makeController('rename-active')
    await presets.load()
    form.value = 47
    const created = await presets.saveAs('Original name')
    assert.ok(created)

    const renamed = await presets.rename('  Refined name  ')
    assert.ok(renamed)
    assert.equal(renamed.name, 'Refined name')
    assert.equal(renamed.data.value, 47)
    assert.equal(presets.activeId.value, created.id, 'renaming must not change the active preset')

    const fresh = makeController('rename-active')
    await fresh.presets.load()
    assert.equal(fresh.presets.presets.value[0].name, 'Refined name')
    assert.equal(fresh.form.value, 47, 'renaming must not alter the stored form snapshot')
  })

  test('setActive() switches activeId and persists', async () => {
    const { presets, form } = makeController('s5')
    await presets.load()
    form.value = 1
    const a = await presets.saveAs('A')
    form.value = 2
    const b = await presets.saveAs('B') // saveAs flips active to b
    assert.equal(presets.activeId.value, b.id)

    await presets.setActive(a.id)
    assert.equal(presets.activeId.value, a.id)

    // Verify persistence
    const fresh = makeController('s5')
    await fresh.presets.load()
    assert.equal(fresh.presets.activeId.value, a.id)
    assert.equal(fresh.form.value, 1, 'loading auto-applies the newly-active preset')
  })

  test('separate typed controllers preserve presets saved after their initial load', async () => {
    const scriptForm = { value: 'script-v1' }
    const introForm = { value: 'intro-v1' }
    const script = usePresets({
      slug: 'shared-pool',
      configKey: 'script',
      presetType: 'script',
      snapshot: () => ({ ...scriptForm }),
      apply: data => Object.assign(scriptForm, data),
    })
    const intro = usePresets({
      slug: 'shared-pool',
      configKey: 'script',
      presetType: 'introduction',
      snapshot: () => ({ ...introForm }),
      apply: data => Object.assign(introForm, data),
    })

    // Both controllers capture the same initially-empty server state.
    await Promise.all([script.load(), intro.load()])
    const scriptPreset = await script.saveAs('Script setup')
    const introPreset = await intro.saveAs('Opening setup')

    const stored = configStore['shared-pool'].script_presets
    assert.deepEqual(
      stored.map((preset: any) => preset.id).sort(),
      [scriptPreset.id, introPreset.id].sort(),
      'the second stale controller must merge rather than erase the first save',
    )
    assert.equal(configStore['shared-pool'].script_last_preset_script, scriptPreset.id)
    assert.equal(configStore['shared-pool'].script_last_preset_introduction, introPreset.id)
  })
})
