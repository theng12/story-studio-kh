/**
 * SettingsBaselinePanel — snapshot, dry run preview, apply with explicit confirm, readback, and restore.
 *
 * Checks:
 * - panel renders baseline selector, channel checkboxes, and safety notice;
 * - preview sends dry run payload and displays diffs with protected keys;
 * - apply button requires explicit user confirmation;
 * - readback results display honest mismatch vs verified statuses;
 * - restore requires window confirmation.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

interface ApiCall {
  method: string
  path: string
  body?: any
}

interface HarnessState {
  calls: ApiCall[]
  projects: any[]
  baselines: any[]
  snapshots: any[]
  previewRes: any
  applyRes: any
  restoreRes: any
}

const mockProjects = [
  { slug: 'dreamlands', name: 'Dreamlands' },
  { slug: 'night-atlas', name: 'Night Atlas' },
]

const mockBaselines = [
  {
    id: 'base_abc',
    name: 'Owner Standard Baseline',
    version: 1,
    created_at: '2026-11-07T10:00:00.000Z',
    updated_at: '2026-11-07T10:00:00.000Z',
    payload: {
      audio_quality: { mode: 'flag_issues' },
      default_scene_pacing: { phases: [{ end: 180, min: 5, max: 10 }] },
    },
    payload_sha256: '{{HASH_a45wz3g8}}',
  },
]

const mockSnapshots = [
  {
    id: 'snp_xyz',
    channel_slug: 'dreamlands',
    created_at: '2026-11-07T10:05:00.000Z',
    reason: 'pre_apply',
    baseline_id: 'base_abc',
  },
]

const mockPreview = [
  {
    channel_slug: 'dreamlands',
    channel_name: 'Dreamlands',
    baseline_id: 'base_abc',
    has_changes: true,
    diffs: [
      { key: 'audio_quality', current_value: { mode: 'off' }, proposed_value: { mode: 'flag_issues' }, status: 'modified' },
      { key: 'default_scene_pacing', current_value: undefined, proposed_value: { phases: [{ end: 180, min: 5, max: 10 }] }, status: 'added' },
    ],
    protected_keys_preserved: ['thumbnail_prompts_presets', 'pacing'],
    warnings: ['Scene rhythm stays per-episode (AGENTS.md §5).'],
  },
]

const mockApplyRes = {
  baseline_id: 'base_abc',
  applied_at: '2026-11-07T10:10:00.000Z',
  dry_run: false,
  total_channels: 1,
  success_count: 1,
  failure_count: 0,
  channels: {
    dreamlands: {
      channel_slug: 'dreamlands',
      status: 'applied',
      restore_point_id: 'snp_new',
      changed_keys: ['audio_quality', 'default_scene_pacing'],
      readback: {
        status: 'verified',
        channel_slug: 'dreamlands',
        verified_at: '2026-11-07T10:10:01.000Z',
        checked_keys: ['audio_quality', 'default_scene_pacing'],
        matched_keys: ['audio_quality', 'default_scene_pacing'],
        mismatches: [],
        config_sha256: '{{HASH_9q0xw2r1}}',
      },
    },
  },
}

const mockRestoreRes = {
  success: true,
  restore_point_id: 'snp_xyz',
  channel_slug: 'dreamlands',
  restored_at: '2026-11-07T10:15:00.000Z',
  restored_keys: ['audio_quality', 'pacing', 'thumbnail_prompts_presets'],
  readback: {
    status: 'verified',
    channel_slug: 'dreamlands',
    verified_at: '2026-11-07T10:15:00.000Z',
    checked_keys: ['audio_quality', 'pacing', 'thumbnail_prompts_presets'],
    matched_keys: ['audio_quality', 'pacing', 'thumbnail_prompts_presets'],
    mismatches: [],
    config_sha256: '{{HASH_k9w1z0q4}}',
  },
}

let panelComponent: Promise<Component> | undefined

async function loadPanel(): Promise<Component> {
  if (panelComponent) return panelComponent
  panelComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/SettingsBaselinePanel.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'settings-baseline-panel-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'settings-baseline-panel-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    const support = `
      import { computed, onMounted, ref } from ${JSON.stringify(vueUrl)}
      const useApi = () => globalThis.__settingsBaselineHarness.api()
    `
    const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  })()
  return panelComponent
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountPanel(overrides: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    calls: [],
    projects: mockProjects,
    baselines: mockBaselines,
    snapshots: mockSnapshots,
    previewRes: mockPreview,
    applyRes: mockApplyRes,
    restoreRes: mockRestoreRes,
    ...overrides,
  }

  const api = {
    get: async (path: string) => {
      state.calls.push({ method: 'GET', path })
      if (path === '/projects') return state.projects
      if (path === '/settings-baselines') return state.baselines
      if (path === '/settings-baselines/snapshots') return state.snapshots
      throw new Error(`Unhandled GET ${path}`)
    },
    post: async (path: string, body?: any) => {
      state.calls.push({ method: 'POST', path, body })
      if (path === '/settings-baselines/preview') return state.previewRes
      if (path === '/settings-baselines/apply') return state.applyRes
      if (path === '/settings-baselines/restore') return state.restoreRes
      if (path === '/settings-baselines/snapshot-channel') {
        return {
          id: 'base_new',
          name: body?.name || 'New Baseline',
          version: 1,
          updated_at: new Date().toISOString(),
          payload: {},
          payload_sha256: '{{HASH_new01abc}}',
        }
      }
      throw new Error(`Unhandled POST ${path}`)
    },
  }
  ;(globalThis as any).__settingsBaselineHarness = { api: () => api }

  const comp = await loadPanel()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      render: () => h(comp as any),
    }),
  )
  app.mount(host)
  await flush()

  return {
    state,
    host,
    app,
    async cleanup() {
      app.unmount()
      host.remove()
    },
  }
}

// ── Render Checks ────────────────────────────────────────────────────────────

test('panel renders baseline selector, target channels, safety notice, and restore list', async () => {
  const panel = await mountPanel()
  try {
    const text = panel.host.textContent || ''

    // Baseline selector
    assert.match(text, /Configuration Baseline/)
    assert.match(text, /Owner Standard Baseline/)

    // Explicit operation badge & safety notice
    assert.match(text, /Explicit User Operation/)
    assert.match(text, /never rewrite stored disk presets/)
    assert.match(text, /Scene rhythm stays per-episode/)

    // Target channels section
    assert.match(text, /Target Channels & Dry Run Preview/)
    assert.match(text, /Dreamlands/)
    assert.match(text, /Night Atlas/)

    // Restore snapshots section
    assert.match(text, /Restorable Snapshots/)
    assert.match(text, /snp_xyz/)
  } finally {
    await panel.cleanup()
  }
})

// ── Preview (Dry Run) Interaction ────────────────────────────────────────────

test('preview button triggers dry run POST and renders diff table with protected keys', async () => {
  const panel = await mountPanel()
  try {
    // Select channels
    const checkboxes = Array.from(panel.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    const channelChecks = checkboxes.slice(0, 2)
    for (const cb of channelChecks) {
      cb.checked = true
      await cb.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    }

    // Find preview button and click
    const buttons = Array.from(panel.host.querySelectorAll<HTMLButtonElement>('button'))
    const previewBtn = buttons.find(b => b.textContent?.includes('Preview Diff'))
    assert.ok(previewBtn, 'Preview button must exist')
    assert.equal(previewBtn.disabled, false, 'Preview button enabled when channels selected')

    previewBtn.click()
    await flush()
    await flush()

    const previewCall = panel.state.calls.find(c => c.method === 'POST' && c.path === '/settings-baselines/preview')
    assert.ok(previewCall, 'Preview POST sent to /settings-baselines/preview')
    assert.ok(previewCall.body.baseline_id)
    assert.ok(Array.isArray(previewCall.body.channel_slugs))

    const text = panel.host.textContent || ''
    assert.match(text, /Dry Run Diff Results/)
    assert.match(text, /Dreamlands/)
    assert.match(text, /audio_quality/)
    assert.match(text, /default_scene_pacing/)
    assert.match(text, /Changes Detected/)
    assert.match(text, /Preserved protected keys/)
    assert.match(text, /Scene rhythm stays per-episode/)
  } finally {
    await panel.cleanup()
  }
})

// ── Apply with Explicit Confirmation ─────────────────────────────────────────

test('apply button requires explicit confirmation before enabling application', async () => {
  const panel = await mountPanel()
  try {
    // Select channels
    const checkboxes = Array.from(panel.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    checkboxes[0].checked = true
    await checkboxes[0].dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    const buttons = Array.from(panel.host.querySelectorAll<HTMLButtonElement>('button'))
    const applyBtn = buttons.find(b => b.textContent?.includes('Apply Baseline to'))
    assert.ok(applyBtn, 'Apply button must exist')
    assert.equal(applyBtn.disabled, true, 'Apply button disabled before explicit confirmation')

    // Check the explicit confirmation checkbox
    const confirmCb = Array.from(panel.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      cb => (cb.parentElement?.textContent || '').includes('explicitly confirm'),
    )
    assert.ok(confirmCb, 'Explicit confirm checkbox exists')
    confirmCb.checked = true
    await confirmCb.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()

    assert.equal(applyBtn.disabled, false, 'Apply button enabled after explicit confirmation')

    // Click apply
    applyBtn.click()
    await flush()
    await flush()

    const applyCall = panel.state.calls.find(c => c.method === 'POST' && c.path === '/settings-baselines/apply')
    assert.ok(applyCall, 'Apply POST sent')
    assert.equal(applyCall.body.explicit_confirm, true)
    assert.equal(applyCall.body.create_restore_point, true)
    assert.ok(Array.isArray(applyCall.body.channel_slugs))

    const text = panel.host.textContent || ''
    assert.match(text, /Apply & Readback Verification Results/)
    assert.match(text, /Verified/)
    assert.match(text, /Pre-apply snapshot: snp_new/)
    assert.match(text, /Verified on Disk/)
  } finally {
    await panel.cleanup()
  }
})

// ── Restore Snapshot Confirmation ────────────────────────────────────────────

test('restore snapshot triggers window confirm and POST restore with explicit confirmation', async () => {
  const originalConfirm = globalThis.window.confirm
  let confirmArg: string | null = null
  let confirmResult = true
  ;(globalThis.window as any).confirm = (msg: string) => {
    confirmArg = msg
    return confirmResult
  }

  const panel = await mountPanel()
  try {
    const buttons = Array.from(panel.host.querySelectorAll<HTMLButtonElement>('button'))
    const restoreBtn = buttons.find(b => b.textContent?.includes('Restore Config'))
    assert.ok(restoreBtn, 'Restore button must exist')

    restoreBtn.click()
    await flush()
    await flush()

    assert.ok(confirmArg && confirmArg.includes('snp_xyz'), 'window.confirm invoked with snapshot ID')

    const restoreCall = panel.state.calls.find(c => c.method === 'POST' && c.path === '/settings-baselines/restore')
    assert.ok(restoreCall, 'Restore POST sent')
    assert.equal(restoreCall.body.restore_point_id, 'snp_xyz')
    assert.equal(restoreCall.body.explicit_confirm, true)

    const text = panel.host.textContent || ''
    assert.match(text, /successfully restored to snapshot and verified on disk/)
  } finally {
    ;(globalThis.window as any).confirm = originalConfirm
    await panel.cleanup()
  }
})
