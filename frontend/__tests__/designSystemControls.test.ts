/**
 * Shared controls from the ux/design-system round (2026-10-03).
 *
 * The owner's complaints were visual: a disclosure ▶ that sat outside the card
 * edge, native-looking selects with a misaligned arrow, folder paths he had to
 * type by hand. A test cannot see geometry, so the renders in
 * `_orchestra/audit-20261001/ux-round/ux-design-system/` are the proof of the
 * look. What IS pinned here is the behaviour (folder picking, its fallback,
 * collapsing, remembered state) and the CSS contracts that silently stop
 * working when someone "simplifies" them — e.g. dropping `!important` from the
 * select chevron lets every scoped `background:` shorthand wipe the arrow out.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test, beforeEach } from 'node:test'
import { createApp, h, nextTick, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { friendlyPath } from '../utils/friendly-path.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

/** Compile a production SFC in-process (no component-test dependency). */
async function loadSfc(relative: string): Promise<Component> {
  const filename = fileURLToPath(new URL(relative, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const id = relative.replace(/\W+/g, '-')
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id, compilerOptions: { bindingMetadata: script.bindings } })
  const code = `${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = import.meta.resolve('vue')
  const rewritten = transformed.code
    .replaceAll('"vue"', JSON.stringify(vueUrl))
    .replace(/"(\.\.\/(?:utils|composables)\/[\w-]+)"/g, (_m, spec: string) => JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href))
  return (await import(`data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`)).default
}

function mount(component: Component, props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(component, props, slots) })
  app.mount(host)
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

const settle = async () => { for (let i = 0; i < 4; i += 1) { await nextTick(); await new Promise(r => setTimeout(r, 0)) } }

describe('friendlyPath', () => {
  test('home becomes ~ and short paths are untouched', () => {
    assert.equal(friendlyPath('/Users/theng/Movies'), '~/Movies')
    assert.equal(friendlyPath('/Users/theng'), '~')
    assert.equal(friendlyPath('/Volumes/Archive/Finished'), '/Volumes/Archive/Finished')
    assert.equal(friendlyPath(''), '')
    assert.equal(friendlyPath(null), '')
  })

  test('long paths keep where they live and the folder name, collapsing the middle', () => {
    const full = '/Users/theng/Documents/Story Studio KH/Library/kh-boundless/episodes/EP0101'
    const short = friendlyPath(full, 40)
    assert.ok(short.length <= 40, short)
    assert.match(short, /^~\/Documents\/…\//)
    assert.match(short, /\/EP0101$/)
    assert.equal(friendlyPath('/Volumes/Big Drive/a/b/c/d/e/f/g/Finished videos', 36), '/Volumes/Big Drive/…/Finished videos')
  })

  test('a single over-long folder name is shortened in its middle, never dropped', () => {
    const short = friendlyPath(`/Users/theng/${'x'.repeat(30)}END`, 20)
    assert.ok(short.length <= 20)
    assert.match(short, /…/)
    assert.match(short, /END$/)
  })
})

describe('shared CSS contracts', () => {
  const ds = source('../assets/css/design-system.css')
  const main = source('../assets/css/main.css')

  test('every single-line select gets the same chevron, and scoped background shorthands cannot erase it', () => {
    assert.match(ds, /select:not\(\[multiple\]\):not\(\[size\]\) \{[^}]*appearance: none;[^}]*background-image: var\(--select-chevron\) !important;[^}]*background-position: right 10px center !important;[^}]*padding-right: 32px !important;/)
    assert.doesNotMatch(main, /\.select \{\s*appearance: none;\s*background-image/, 'the old .select-only triangle must not come back beside the shared one')
  })

  test('hint text, muted text and the quiet button are defined app-wide, not only in scoped blocks', () => {
    assert.match(ds, /\.hint,\s*\.field-hint,\s*\.help-text \{[^}]*color: var\(--text-muted\);[^}]*font-size: var\(--font-xs\);/)
    assert.match(ds, /\.muted \{ color: var\(--text-muted\); \}/)
    assert.match(main, /\.btn-quiet \{/)
    assert.doesNotMatch(main, /\.btn-primary:hover:not\(:disabled\) \{[^}]*translateY/)
  })

  test('disclosures draw the chevron inside the summary, never as an outside list marker', () => {
    assert.match(ds, /details\.disclosure > summary \{[^}]*list-style: none;/)
    assert.match(ds, /details\.disclosure > summary::-webkit-details-marker \{ display: none; \}/)
    assert.match(ds, /\.ds-collapsible-header \{[^}]*display: flex;[^}]*list-style: none;/)
    assert.doesNotMatch(ds, /list-style-position: outside/)
  })

  test('text triangles in toggles were replaced by the shared chevron (outside Settings, which ux/settings owns)', () => {
    for (const file of ['../components/ModelMenu.vue', '../components/VoicePicker.vue', '../components/ComboInput.vue', '../components/AdvancedDisclosure.vue', '../pages/projects/[slug]/ideas.vue', '../pages/projects/[slug]/scripts.vue']) {
      const text = source(file)
      assert.doesNotMatch(text, /'▾' : '▸'|>▾<\/span>/, file)
      assert.match(text, /ds-chevron/, file)
    }
  })
})

describe('CollapsibleCard', () => {
  beforeEach(() => localStorage.clear())

  test('the chevron is inside the clickable header and the body is native <details> content', async () => {
    const Card = await loadSfc('../components/CollapsibleCard.vue')
    const { host, unmount } = mount(Card, { title: 'Writing instructions', description: 'Project guidance' }, { default: () => h('p', { class: 'body' }, 'Body') })
    await settle()
    const details = host.querySelector('details.ds-collapsible') as HTMLDetailsElement
    const summary = details.querySelector(':scope > summary.ds-collapsible-header')!
    assert.ok(summary.querySelector('.ds-collapsible-chevron'), 'chevron lives inside the summary')
    assert.match(summary.textContent || '', /Writing instructions[\s\S]*Project guidance/)
    assert.equal(details.open, false)
    assert.ok(details.querySelector('.ds-collapsible-body .body'))
    unmount()
  })

  test('opening is remembered under persistKey and reported through update:open', async () => {
    const Card = await loadSfc('../components/CollapsibleCard.vue')
    const seen: boolean[] = []
    const first = mount(Card, { title: 'Advanced', persistKey: 'cc-test', 'onUpdate:open': (v: boolean) => seen.push(v) })
    await settle()
    const details = first.host.querySelector('details') as HTMLDetailsElement
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    await settle()
    assert.deepEqual(seen, [true])
    assert.equal(localStorage.getItem('cc-test'), '1')
    first.unmount()

    const second = mount(Card, { title: 'Advanced', persistKey: 'cc-test' })
    await settle()
    assert.equal((second.host.querySelector('details') as HTMLDetailsElement).open, true)
    second.unmount()
  })
})

describe('FolderField', () => {
  type Call = { url: string, body: any }
  let calls: Call[]
  let respond: (url: string) => any

  beforeEach(() => {
    calls = []
    respond = () => ({})
    // Desktop app: the picker goes to the native dialog route, not the in-app browser.
    ;(window as any).electron = { isElectron: true }
    ;(globalThis as any).$fetch = async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body })
      const out = respond(url)
      if (out instanceof Error) throw out
      return out
    }
  })

  test('shows a short path with the full path on hover, and saves the full path the picker returns', async () => {
    const Field = await loadSfc('../components/FolderField.vue')
    const emitted: string[] = []
    const changes: string[] = []
    respond = url => url.endsWith('/system/pick-folder') ? { path: '/Users/theng/Movies/Finished' } : {}
    const { host, unmount } = mount(Field, {
      modelValue: '/Users/theng/Documents/Story Studio KH/Library/kh-boundless/exports/finished',
      label: 'Where finished videos go',
      pickerTitle: 'Where should finished videos go?',
      'onUpdate:modelValue': (v: string) => emitted.push(v),
      onChange: (v: string) => changes.push(v),
    })
    await settle()
    const shown = host.querySelector('.folder-field-path') as HTMLElement
    assert.match(shown.textContent || '', /^~\/Documents\/…\/.*finished$/)
    assert.equal(shown.getAttribute('title'), '/Users/theng/Documents/Story Studio KH/Library/kh-boundless/exports/finished')

    const choose = [...host.querySelectorAll('button')].find(b => /Choose…/.test(b.textContent || ''))!
    choose.click()
    await settle()
    assert.equal(calls[0].url, '/api/system/pick-folder')
    assert.equal(calls[0].body.title, 'Where should finished videos go?')
    assert.deepEqual(emitted, ['/Users/theng/Movies/Finished'])
    assert.deepEqual(changes, ['/Users/theng/Movies/Finished'])
    unmount()
  })

  test('with no native picker (dev server / browser) it says so and opens the typed-path field', async () => {
    const Field = await loadSfc('../components/FolderField.vue')
    const emitted: string[] = []
    respond = () => Object.assign(new Error('503'), { status: 503, data: { detail: 'Folder picker not available — Electron main process not detected (are you running the server standalone?).' } })
    const { host, unmount } = mount(Field, { modelValue: '', 'onUpdate:modelValue': (v: string) => emitted.push(v) })
    await settle()
    assert.match(host.querySelector('.folder-field-path')?.textContent || '', /No folder chosen/)
    ;[...host.querySelectorAll('button')].find(b => /Choose…/.test(b.textContent || ''))!.click()
    await settle()
    assert.match(host.querySelector('.folder-field-message')?.textContent || '', /only opens inside the Story Studio app\. Type or paste/)
    const input = host.querySelector('input.folder-field-input') as HTMLInputElement
    assert.ok(input, 'typed-path field is open')
    input.value = '  /Volumes/Archive/Finished  '
    input.dispatchEvent(new Event('input'))
    await settle()
    ;[...host.querySelectorAll('button')].find(b => /Use This Path/.test(b.textContent || ''))!.click()
    await settle()
    assert.deepEqual(emitted, ['/Volumes/Archive/Finished'])
    unmount()
  })

  test('Show in Finder reveals the full path and shows the server sentence when it cannot', async () => {
    const Field = await loadSfc('../components/FolderField.vue')
    respond = () => Object.assign(new Error('404'), { status: 404, data: { detail: 'Path does not exist: /Volumes/Gone' } })
    const { host, unmount } = mount(Field, { modelValue: '/Volumes/Gone' })
    await settle()
    ;[...host.querySelectorAll('button')].find(b => /Show in Finder/.test(b.textContent || ''))!.click()
    await settle()
    assert.deepEqual(calls[0], { url: '/api/system/reveal-folder', body: { path: '/Volumes/Gone' } })
    assert.equal(host.querySelector('.folder-field-message')?.textContent, 'Path does not exist: /Volumes/Gone')
    unmount()
  })
})

describe('HelpText', () => {
  test('one sentence is visible; the rest waits behind More', async () => {
    const Help = await loadSfc('../components/HelpText.vue')
    const { host, unmount } = mount(Help, { text: 'Retries a failed image once.', more: 'It never runs twice for the same scene.' })
    await settle()
    assert.match(host.textContent || '', /Retries a failed image once\./)
    assert.doesNotMatch(host.textContent || '', /never runs twice/)
    const toggle = host.querySelector('button.ds-help-toggle') as HTMLButtonElement
    assert.equal(toggle.textContent, 'More')
    toggle.click()
    await settle()
    assert.match(host.textContent || '', /never runs twice/)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    unmount()
  })
})
