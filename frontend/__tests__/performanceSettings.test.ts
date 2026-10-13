/**
 * v1.4.249 — Performance & recovery, one table each and ONE Save.
 *
 * Owner: "the performance is ugly. make it nicer." The rules that made the old
 * cards safe still hold and are pinned here: a paid replacement stays Off until
 * a positive whole-number credit limit is saved; a setting whose saved state is
 * unknown cannot be changed; each kind saves to its own endpoint; the server's
 * echo (clamped values) is what is shown; nothing is saved while a row is invalid.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const PAID = {
  image: '/app-settings/paid-image-replacement',
  subtitle: '/app-settings/paid-subtitle-replacement',
  audio: '/app-settings/paid-audio-replacement',
  writing: '/app-settings/paid-writing-replacement',
}
const CONCURRENCY = '/app-settings/concurrency'
const MANUAL_REDO = '/app-settings/manual-generation-redo'

async function loadComponent(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/PerformanceSettings.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'performance-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content, filename, id: 'performance-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const utilUrl = new URL('../utils/performanceSettings.ts', import.meta.url).href
  const support = `const useApi = () => globalThis.__perfApi\n`
  const code = `${support}${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)).replaceAll('"~/utils/performanceSettings"', JSON.stringify(utilUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) { await nextTick(); await new Promise(r => setTimeout(r, 0)) }
}

async function mount(options: {
  paid?: Record<string, any>
  failPaid?: string[]
  manualRedo?: { enabled: boolean }
  failManualRedo?: boolean
  concurrency?: Record<string, any>
  echo?: (path: string, body: any) => any
} = {}) {
  const saves: Array<{ path: string; body: any }> = []
  const concurrency = options.concurrency ?? {
    subtitle_episode_concurrency: 2, llm_concurrency: 8, image_episode_concurrency: 3,
    image_fanout_per_episode: 'auto', thumbnail_episode_concurrency: 3, outline_chapter_headroom: 2,
    genstudio_language_timeout_minutes: 30, language_floor_tokens_per_second: 25, language_preferred_tokens_per_second: 50,
  }
  ;(globalThis as any).__perfApi = {
    get: async (path: string) => {
      if (path === CONCURRENCY) return concurrency
      if (path === MANUAL_REDO) {
        if (options.failManualRedo) throw new Error('offline')
        return options.manualRedo ?? { enabled: false }
      }
      const kind = Object.entries(PAID).find(([, p]) => p === path)?.[0]
      if (kind) {
        if (options.failPaid?.includes(kind)) throw new Error('offline')
        return options.paid?.[kind] ?? { enabled: false, additional_credit_ceiling: null }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    put: async (path: string, body: any) => {
      saves.push({ path, body })
      if (options.echo) return options.echo(path, body)
      if (path === CONCURRENCY) return body
      return body
    },
  }
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadComponent())
  app.component('AdvancedDisclosure', defineComponent({ props: ['label'], setup: (_, { slots }) => () => h('div', { class: 'adv' }, slots.default?.()) }))
  app.mount(host)
  await flush()
  const saveButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Save Changes')!
  const row = (kind: string) => host.querySelector<HTMLElement>(`tr[data-kind="${kind}"]`)!
  const turnOn = async (kind: string) => {
    const on = row(kind).querySelector<HTMLInputElement>(`input[name="paid-${kind}-replacement-enabled"][value="true"]`)!
    on.checked = true
    on.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  }
  const setCeiling = async (kind: string, value: string) => {
    const input = row(kind).querySelector<HTMLInputElement>(`input[name="paid-${kind}-replacement-ceiling"]`)!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  }
  const save = async () => { saveButton().click(); await flush() }
  const manualRedo = () => host.querySelector<HTMLInputElement>('input[name="manual-generation-redo-enabled"]')
  return { host, saves, row, turnOn, setCeiling, save, saveButton, manualRedo, unmount: () => app.unmount() }
}

describe('Performance & recovery', () => {
  test('one table of numbers with one-line hints; long help is behind More; recommended is a quiet marker', async () => {
    const m = await mount()
    try {
      const rows = [...m.host.querySelectorAll('tr.perf-row')]
      assert.equal(rows.length, 10, 'all ten numbers are reachable (three behind Advanced)')
      assert.match(m.host.querySelector<HTMLElement>('tr.perf-row[data-key="audioEpisodes"]')?.textContent || '', /Episodes making narration/)
      const scene = m.host.querySelector<HTMLElement>('tr.perf-row[data-key="imageEpisodes"]')!
      assert.match(scene.textContent || '', /Episodes making scene images/)
      assert.match(scene.textContent || '', /Recommended: 2/, 'off-recommended value offers the recommended one quietly')
      assert.doesNotMatch(m.host.textContent || '', /— recommended/, 'no option label says "recommended"')
      assert.doesNotMatch(m.host.textContent || '', /Thirty at once overwhelmed/, 'paragraph help starts hidden')
      const more = m.host.querySelector<HTMLButtonElement>('tr.perf-row[data-key="subtitleEpisodes"] .perf-more')!
      more.click()
      await flush()
      assert.match(m.host.textContent || '', /Thirty at once overwhelmed/)
      assert.equal(m.host.querySelectorAll('button').length > 0, true)
      const saves = [...m.host.querySelectorAll('button')].filter(b => /^Save/.test(b.textContent?.trim() || ''))
      assert.equal(saves.length, 1, 'ONE Save for the whole section')
      assert.equal(m.saveButton().disabled, true, 'nothing to save until something changes')
    } finally { m.unmount() }
  })

  test('changing a number saves it through the established endpoint and shows the clamped echo', async () => {
    const m = await mount({ echo: (path, body) => path === CONCURRENCY ? { ...body, image_episode_concurrency: 50 } : body })
    try {
      const input = m.host.querySelector<HTMLInputElement>('input.stepper-input[data-key="imageEpisodes"]')!
      input.value = '60'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      await m.save()
      assert.match(m.host.textContent || '', /choose a number from 1 to 50/, 'out-of-range is refused before saving')
      assert.equal(m.saves.length, 0)
      input.value = '49'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      await m.save()
      assert.equal(m.saves.length, 1)
      assert.equal(m.saves[0]!.path, CONCURRENCY)
      assert.equal(m.saves[0]!.body.image_episode_concurrency, 49)
      assert.equal(m.saves[0]!.body.image_fanout_per_episode, 'auto')
      assert.equal(m.host.querySelector<HTMLInputElement>('input.stepper-input[data-key="imageEpisodes"]')!.value, '50', 'the server echo is what shows')
      assert.match(m.host.textContent || '', /Saved and in effect now/)
    } finally { m.unmount() }
  })

  test('a paid replacement stays Off until a positive whole-number limit is saved, per kind, one Save', async () => {
    const m = await mount()
    try {
      for (const kind of Object.keys(PAID)) {
        const off = m.row(kind).querySelector<HTMLInputElement>(`input[name="paid-${kind}-replacement-enabled"][value="false"]`)!
        assert.equal(off.checked, true, `${kind} starts Off`)
        assert.equal(m.row(kind).querySelector(`input[name="paid-${kind}-replacement-ceiling"]`), null, 'Off has no limit field')
      }
      await m.turnOn('image')
      await m.turnOn('writing')
      await m.setCeiling('image', '37')
      await m.save()
      assert.equal(m.saves.length, 0, 'writing is On without a limit, so NOTHING is saved')
      assert.match(m.row('writing').textContent || '', /positive whole number/)
      await m.setCeiling('writing', '2.5')
      await m.save()
      assert.equal(m.saves.length, 0, 'a fraction is not a whole number')
      await m.setCeiling('writing', '12')
      await m.save()
      assert.deepEqual(m.saves, [
        { path: PAID.image, body: { enabled: true, additional_credit_ceiling: 37 } },
        { path: PAID.writing, body: { enabled: true, additional_credit_ceiling: 12 } },
      ], 'only the changed kinds save, each to its own endpoint')
    } finally { m.unmount() }
  })

  test('turning a saved replacement Off sends a null limit', async () => {
    const m = await mount({ paid: { audio: { enabled: true, additional_credit_ceiling: 20 } } })
    try {
      const off = m.row('audio').querySelector<HTMLInputElement>('input[name="paid-audio-replacement-enabled"][value="false"]')!
      off.checked = true
      off.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
      await m.save()
      assert.deepEqual(m.saves, [{ path: PAID.audio, body: { enabled: false, additional_credit_ceiling: null } }])
    } finally { m.unmount() }
  })

  test('a kind whose saved state is unknown cannot be changed or saved', async () => {
    const m = await mount({ failPaid: ['subtitle'] })
    try {
      const row = m.row('subtitle')
      assert.equal(row.querySelector('input[type="radio"]'), null, 'no switch for an unknown state')
      assert.match(row.textContent || '', /Saved state unavailable/)
      assert.match(row.textContent || '', /Could not load this setting/)
      await m.turnOn('image')
      await m.setCeiling('image', '5')
      await m.save()
      assert.deepEqual(m.saves.map(s => s.path), [PAID.image], 'the unknown kind is never written')
    } finally { m.unmount() }
  })

  test('manual fresh-attempt visibility is an independent saved switch, off by default', async () => {
    const m = await mount()
    try {
      assert.equal(m.manualRedo()?.checked, false)
      assert.match(m.host.textContent || '', /Show manual fresh-attempt controls/)
      assert.match(m.host.textContent || '', /explicit one-shot action/i)
      assert.match(m.host.textContent || '', /image, voice, subtitle, transcription, music, and video charges/i)
      m.manualRedo()!.checked = true
      m.manualRedo()!.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
      await m.save()
      assert.deepEqual(m.saves, [{ path: MANUAL_REDO, body: { enabled: true } }])
    } finally { m.unmount() }
  })

  test('manual fresh-attempt setting reloads independently and a load failure hides its switch', async () => {
    const enabled = await mount({ manualRedo: { enabled: true } })
    try {
      assert.equal(enabled.manualRedo()?.checked, true)
      assert.equal(enabled.saves.length, 0)
    } finally { enabled.unmount() }

    const unavailable = await mount({ failManualRedo: true })
    try {
      assert.equal(unavailable.manualRedo(), null)
      assert.match(unavailable.host.textContent || '', /Could not load this setting/)
    } finally { unavailable.unmount() }
  })

  test('unreadable job numbers are not shown and cannot be saved over the real ones', async () => {
    const failing = await (async () => {
      const saves: any[] = []
      ;(globalThis as any).__perfApi = {
        get: async (path: string) => {
          if (path === CONCURRENCY) throw new Error('offline')
          if (path === MANUAL_REDO) return { enabled: false }
          return { enabled: false, additional_credit_ceiling: null }
        },
        put: async (path: string, body: any) => { saves.push({ path, body }); return body },
      }
      document.body.innerHTML = ''
      const host = document.body.appendChild(document.createElement('div'))
      const app = createApp(await loadComponent())
      app.component('AdvancedDisclosure', defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }))
      app.mount(host)
      await flush()
      return { host, saves, app }
    })()
    try {
      assert.equal(failing.host.querySelectorAll('tr.perf-row').length, 0)
      assert.match(failing.host.textContent || '', /Could not read your saved numbers/)
      const use = [...failing.host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Use Recommended')!
      assert.equal(use.disabled, true)
    } finally { failing.app.unmount() }
  })
})
