/**
 * PromptReviewPanel's per-option metadata UI.
 *
 * Two halves:
 *  1. PromptReviewOptionEditor — drafts, and the rule that saving sends ONLY
 *     the fields the customer moved (an episode with no sidecar is never
 *     backfilled), plus the approval button's honest states.
 *  2. PromptReviewPanel wiring — a load READS options and never writes them,
 *     an episode swap drops another episode's settings (AGENTS §4), a
 *     regenerate carries this option's five saved choices, approving and
 *     editing follow the server's verdict, and Duplicate refreshes from disk.
 *
 * No network, no backend: component sources are compiled here with their
 * children stubbed, the way thumbnailRecipeCatalog.test.ts does it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction.js'

const STUBS_KEY = '__promptReviewStubs'

/**
 * Compile one SFC. Nuxt auto-imports are shimmed through `support`; local
 * child components come from `globalThis[STUBS_KEY]` so a data-URL module
 * never has to resolve a relative .vue import.
 */
async function loadComponent(name: string, support: string): Promise<Component> {
  const filename = fileURLToPath(new URL(`../components/${name}`, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: `prompt-review-${name}`, inlineTemplate: true })
  const vueUrl = await import.meta.resolve('vue')
  const rewritten = script.content.replace(
    /^import (\w+) from '(\.\/[^']+\.vue)'$/gm,
    `const $1 = globalThis.${STUBS_KEY}.$1`,
  )
  const code = `${support}\n${rewritten.replace('export default', 'const __sfc__ = ')}\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
}

// ── Stubs ──────────────────────────────────────────────────────────────────

/** Picker stubs for the option editor: each offers one button that behaves
 *  like the real control's emit. */
const RecipeStub = defineComponent({
  props: { selectedRecipeId: String },
  setup(_props, { attrs }) {
    return () => h('button', { class: 'stub-recipe', onClick: () => (attrs as any).onSelect?.({ id: 'recipe-9' }) }, 'pick recipe')
  },
})
const StyleStub = defineComponent({
  props: { slug: String, activeStyleBible: String, showCustomStyles: Boolean },
  setup(_props, { attrs }) {
    return () => h('button', { class: 'stub-style', onClick: () => (attrs as any).onApply?.({ style_bible: 'Style from the library', negative_prompt: '' }) }, 'apply style')
  },
})
const SwatchStub = defineComponent({
  props: { kind: String, modelValue: String, title: String, caption: String },
  setup(props, { attrs }) {
    return () => h('button', {
      class: `stub-swatch stub-swatch-${props.kind}`,
      onClick: () => (attrs as any)['onUpdate:modelValue']?.(`${props.kind}-chosen`),
    }, `swatch:${props.modelValue}`)
  },
})
const SpinnerStub = defineComponent({ render: () => h('span', { class: 'stub-spinner' }) })

/** Panel children: emit-shaped buttons, so the panel's own handlers run. */
const RowStub = defineComponent({
  props: { row: Object, prefix: String, titleLabel: String, busy: Boolean, saving: Boolean, error: String, cap: Number, modelLabel: String },
  setup(_props, { attrs }) {
    return () => h('div', { class: 'stub-row' }, [
      h('button', {
        class: 'stub-regen',
        onClick: () => (attrs as any).onRegenerate?.({ title: 'Alpha', prompt: 'A prompt long enough to save.', notes: 'nudge' }),
      }, 'regen'),
      h('button', {
        class: 'stub-save-prompt',
        onClick: () => (attrs as any).onSave?.({ title: 'Alpha', prompt: 'An edited prompt long enough to save.' }),
      }, 'save prompt'),
    ])
  },
})
const EditorStub = defineComponent({
  props: {
    number: Number, entry: Object, projectSlug: String, pageFontStyle: String, pageTextStyle: String,
    autoApprove: Boolean, approved: Boolean, saving: Boolean, duplicating: Boolean, error: String,
  },
  setup(props, { attrs }) {
    return () => h('div', { class: 'stub-editor' }, [
      h('button', { class: 'stub-approve', onClick: () => (attrs as any).onApprove?.(!props.approved) }, 'approve'),
      h('button', { class: 'stub-save-fields', onClick: () => (attrs as any).onSave?.({ thumb_text_position: 'top' }) }, 'save fields'),
      h('button', { class: 'stub-duplicate', onClick: () => (attrs as any).onDuplicate?.() }, 'duplicate'),
      h('span', { class: 'stub-entry' }, JSON.stringify(props.entry)),
    ])
  },
})

// ── Option editor (child) ──────────────────────────────────────────────────

async function mountEditor(overrides: Record<string, unknown>) {
  ;(globalThis as any)[STUBS_KEY] = { ThumbnailRecipePicker: RecipeStub, StylePicker: StyleStub, LetteringSwatchPicker: SwatchStub }
  const Editor = await loadComponent('PromptReviewOptionEditor.vue', '')
  const entry = ref(overrides.entry ?? null)
  const saves: Array<Record<string, string>> = []
  const approvals: boolean[] = []
  const Root = defineComponent({
    setup() {
      return () => h(Editor as any, {
        projectSlug: 'story',
        pageFontStyle: 'page-font',
        pageTextStyle: 'page-text',
        autoApprove: false,
        approved: false,
        saving: false,
        duplicating: false,
        error: null,
        ...overrides,
        number: 1,
        entry: entry.value,
        onSave: (fields: Record<string, string>) => saves.push(fields),
        onApprove: (value: boolean) => approvals.push(value),
      })
    },
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Root)
  app.component('LoadingSpinner', SpinnerStub)
  app.mount(host)
  await flush()
  return { host, entry, saves, approvals, unmount: () => { app.unmount(); host.remove() } }
}

function buttonByText(host: HTMLElement, pattern: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(button => pattern.test(button.textContent || ''))
  assert.ok(found, `expected a button matching ${pattern}`)
  return found as HTMLButtonElement
}

test('option editor saves only the fields that moved — a sidecar-free option is never backfilled', async () => {
  const mounted = await mountEditor({ entry: null })
  try {
    const save = () => buttonByText(mounted.host, /Save Selections/)
    assert.equal(save().disabled, true, 'nothing moved yet, so nothing to save')

    mounted.host.querySelector<HTMLButtonElement>('.stub-recipe')!.click()
    await flush()
    assert.equal(save().disabled, false)
    save().click()
    await flush()

    assert.equal(mounted.saves.length, 1)
    assert.deepEqual(mounted.saves[0], { thumbnail_template_id: 'recipe-9' },
      'the page font shown as a fallback must NOT ride along — only the recipe moved')
    assert.match(mounted.host.textContent!, /Page setting/, 'fallback vs saved stays visible')
    assert.match(mounted.host.textContent!, /Unsaved changes/)
  } finally { mounted.unmount() }
})

test('approving emits the verdict, and automatic approval locks the per-prompt control', async () => {
  const mounted = await mountEditor({ entry: { approved: false } })
  try {
    buttonByText(mounted.host, /Approve Prompt/).click()
    await flush()
    assert.deepEqual(mounted.approvals, [true])
  } finally { mounted.unmount() }

  // Under the episode switch the verdict is the server's: the button reads
  // approved, is disabled, and the panel explains why (the real panel passes
  // approved=true whenever auto-approve is on).
  const locked = await mountEditor({ entry: { approved: false }, autoApprove: true, approved: true })
  try {
    assert.match(locked.host.textContent!, /Automatic approval is on/)
    assert.match(locked.host.textContent!, /✓ Approved/)
    assert.equal(buttonByText(locked.host, /✓ Approved/).disabled, true,
      'the gate is the episode switch, not this button')
  } finally { locked.unmount() }
})

test('a replaced entry (another episode) discards drafts in progress', async () => {
  const mounted = await mountEditor({ entry: { thumb_font_style: 'font-a' } })
  try {
    buttonByText(mounted.host, /^Top$/m).click()
    await flush()
    assert.match(mounted.host.textContent!, /Unsaved changes/)

    // The server answers with a DIFFERENT episode's option: drafts are
    // replaced wholesale, never merged over the work in progress.
    mounted.entry.value = { thumb_font_style: 'font-b' }
    await flush()
    assert.doesNotMatch(mounted.host.textContent!, /Unsaved changes/,
      'the previous selection must not survive the swap')
    assert.match(mounted.host.textContent!, /font-b/)
  } finally { mounted.unmount() }
})

// ── PromptReviewPanel wiring ───────────────────────────────────────────────

interface ApiCall { url: string; body?: any }

const PROMPTS = [
  { number: 1, title: 'Alpha', prompt: 'A prompt long enough to save and to hash.' },
  { number: 2, title: 'Beta', prompt: 'Another prompt long enough to save and hash.' },
]

function panelSupport(): string {
  return `
const useApi = () => globalThis.__promptReviewApi
const useToast = () => globalThis.__promptReviewToast
const useFreshGenerationAction = () => globalThis.__promptReviewFresh
const secureOperationId = () => globalThis.__promptReviewOperationId
`
}

let panelPromise: Promise<Component> | null = null
function compiledPanel(): Promise<Component> {
  if (!panelPromise) panelPromise = loadComponent('PromptReviewPanel.vue', panelSupport())
  return panelPromise
}

async function mountPanel(
  options: { episodeId?: string; optionsReply?: any; getHandler?: (url: string) => any; postHandler?: (url: string, body: any) => any } = {},
) {
  const gets: ApiCall[] = []
  const puts: ApiCall[] = []
  const posts: ApiCall[] = []
  let optionsReply: any = options.optionsReply ?? { schema: 1, auto_approve: false, options: {} }
  const defaultGet = (url: string): any => {
    if (url.includes('/image-prompts/options')) return Promise.resolve(structuredClone(optionsReply))
    if (url.includes('/image-prompts')) return Promise.resolve({ thumbnails: PROMPTS })
    throw new Error(`unexpected GET ${url}`)
  }
  const getHandler = options.getHandler ?? defaultGet
  const api = {
    get: (url: string) => { gets.push({ url }); return Promise.resolve(getHandler(url)) },
    put: async (url: string, body: any) => {
      puts.push({ url, body })
      if (url.includes('/image-prompts/options')) {
        const reply = structuredClone(optionsReply)
        if (body?.auto_approve !== undefined) reply.auto_approve = body.auto_approve
        if (body?.approve !== undefined) {
          reply.options[String(body.number)] = { ...reply.options[String(body.number)], approved: body.approve }
        }
        optionsReply = reply
        return structuredClone(reply)
      }
      if (url.includes('/image-prompts/item')) return { number: body.number, title: body.title, prompt: body.prompt }
      throw new Error(`unexpected PUT ${url}`)
    },
    post: async (url: string, body: any) => {
      posts.push({ url, body })
      if (options.postHandler) return options.postHandler(url, body)
      if (url.includes('/options/duplicate')) return { number: 3, title: 'Alpha copy', prompt: PROMPTS[0]!.prompt }
      if (url.includes('/image-prompts/regenerate')) {
        return { number: body.number, title: body.title || 'Alpha', prompt: 'A regenerated prompt long enough to save.' }
      }
      throw new Error(`unexpected POST ${url}`)
    },
  }
  ;(globalThis as any).__promptReviewApi = api
  ;(globalThis as any).__promptReviewToast = { success: () => {}, error: () => {} }
  ;(globalThis as any).__promptReviewFresh = useFreshGenerationAction()
  ;(globalThis as any).__promptReviewOperationId = '22222222-2222-4222-8222-222222222222'
  ;(globalThis as any)[STUBS_KEY] = { PromptRow: RowStub, PromptReviewOptionEditor: EditorStub }

  const Panel = await compiledPanel()
  const current = ref(options.episodeId ?? 'EP-A')
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(Panel as any, {
      projectSlug: 'story',
      episodeId: current.value,
      title: 'Alpha Episode',
      model: 'story-llm',
      thumbnailFontStyle: 'page-font',
      thumbnailTextStyle: 'page-text',
      thumbnailFontStyleCustom: 'Custom face',
      thumbnailTextStyleCustom: 'Custom finish',
      thumbnailHeadlineMode: 'episode-title',
    }),
  }))
  app.component('LoadingSpinner', SpinnerStub)
  app.mount(host)
  return {
    host, gets, puts, posts,
    setEpisode: (id: string) => { current.value = id },
    setOptionsReply: (reply: any) => { optionsReply = reply },
    unmount: () => { app.unmount(); host.remove() },
  }
}

/** The nth row's option editor: open the row's details so it mounts. */
async function openEditor(host: HTMLElement, row = 1): Promise<void> {
  const details = [...host.querySelectorAll('details')][row - 1]
  assert.ok(details, `expected option details for row ${row}`)
  details.open = true
  details.dispatchEvent(new Event('toggle'))
  await flush()
  assert.ok(host.querySelector('.stub-editor'), 'the editor mounted for the open row')
}

test('loading reads option settings and writes nothing — legacy episodes stay sidecar-free', async () => {
  const panel = await mountPanel()
  try {
    await flush()
    const optionGets = panel.gets.filter(call => call.url.includes('/image-prompts/options'))
    assert.equal(optionGets.length, 1, 'exactly one settings read for the episode')
    assert.equal(panel.puts.length, 0, 'a read never PUTs — no backfill on load')
    assert.equal(panel.posts.length, 0)
    assert.match(panel.host.textContent!, /○ Not approved/)
    assert.match(panel.host.textContent!, /Option settings/)
  } finally { panel.unmount() }
})

test('an episode switch clears the old settings and drops its late answer', async () => {
  const gate: { resolve: (value: any) => void } = { resolve: () => {} }
  const panel = await mountPanel({
    episodeId: 'EP-A',
    getHandler: (url) => {
      if (url.includes('EP-A') && url.includes('/image-prompts/options')) {
        return new Promise(resolve => { gate.resolve = resolve })
      }
      if (url.includes('/image-prompts/options')) return Promise.resolve({ schema: 1, auto_approve: false, options: {} })
      if (url.includes('/image-prompts')) return Promise.resolve({ thumbnails: PROMPTS })
      throw new Error(`unexpected GET ${url}`)
    },
  })
  try {
    await flush() // EP-A prompts land; EP-A settings are still pending.

    panel.setEpisode('EP-B')
    await flush()

    // EP-A answers now — after the switch. It must not land anywhere.
    gate.resolve({ schema: 1, auto_approve: true, options: { '1': { approved: true, thumb_font_style: 'ep-a-font' } } })
    await flush()

    const toggle = panel.host.querySelector<HTMLInputElement>('.prp-auto input')!
    assert.equal(toggle.checked, false, "the previous episode's auto-approve must not survive the switch")
    assert.doesNotMatch(panel.host.textContent!, /✓ Approved/,
      "the previous episode's approval must not stand for this one")
  } finally { panel.unmount() }
})

test('regenerating a row sends that option’s five saved choices', async () => {
  const panel = await mountPanel({
    optionsReply: {
      schema: 1,
      auto_approve: false,
      options: {
        '1': {
          thumbnail_template_id: 'recipe-7',
          style_tag: 'Ink-wash dusk',
          thumb_font_style: 'option-font',
          thumb_text_style: 'option-text',
          thumb_text_position: 'bottom-left',
          approved: false,
        },
      },
    },
  })
  try {
    await flush()
    panel.host.querySelector<HTMLButtonElement>('.stub-regen')!.click()
    await flush()

    const regenerate = panel.posts.find(call => call.url.includes('/image-prompts/regenerate'))
    assert.ok(regenerate, 'the row asked for a regeneration')
    assert.equal(regenerate!.body.thumbnail_template_id, 'recipe-7')
    assert.equal(regenerate!.body.style_tag, 'Ink-wash dusk')
    assert.equal(regenerate!.body.thumb_font_style, 'option-font', "the option's own font beats the page's")
    assert.equal(regenerate!.body.thumb_text_style, 'option-text')
    assert.equal(regenerate!.body.thumb_text_position, 'bottom-left')
    assert.equal(regenerate!.body.thumb_font_style_custom, undefined,
      "the page's custom lettering does not belong to an option that chose its own font")
    assert.match(regenerate!.body.operation_id, /^[0-9a-f-]{36}$/)
  } finally { panel.unmount() }
})

test('approval follows the server, editing the prompt clears it, and the episode toggle PUTs deliberately', async () => {
  const panel = await mountPanel({
    optionsReply: { schema: 1, auto_approve: false, options: { '1': { approved: false }, '2': { approved: false } } },
  })
  try {
    await flush()
    await openEditor(panel.host)
    assert.match(panel.host.textContent!, /○ Not approved/)

    // Approve row 1 — only the verdict travels, and what shows is the answer.
    panel.host.querySelector<HTMLButtonElement>('.stub-approve')!.click()
    await flush()
    const approvePut = panel.puts.find(call => call.body?.approve !== undefined)
    assert.ok(approvePut, 'approval is a PUT')
    assert.deepEqual(approvePut!.body, { number: 1, approve: true })
    assert.match(panel.host.textContent!, /✓ Approved/)

    // Editing the prompt text invalidates the approval: the chip drops again.
    panel.host.querySelector<HTMLButtonElement>('.stub-save-prompt')!.click()
    await flush()
    assert.match(panel.host.textContent!, /○ Not approved/, 'a changed prompt is no longer approved')
    assert.equal(panel.puts.filter(call => call.body?.approve !== undefined).length, 1,
      'clearing follows the hash — no phantom withdraw PUT')

    // Episode toggle: deliberate, one PUT carrying auto_approve on the first
    // option's number (the contract edits one option per PUT).
    const toggle = panel.host.querySelector<HTMLInputElement>('.prp-auto input')!
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await flush()
    const autoPut = panel.puts.find(call => call.body?.auto_approve !== undefined)
    assert.ok(autoPut, 'the switch writes when the customer flips it')
    assert.equal(autoPut!.body.auto_approve, true)
    assert.equal(autoPut!.body.number, 1)
    assert.equal(toggle.checked, true, 'the saved state is what shows')
    assert.match(panel.host.textContent!, /✓ Approved · automatic/)
  } finally { panel.unmount() }
})

test('a duplicate retry reuses its identity after a lost response', async () => {
  const panel = await mountPanel({ postHandler: () => { throw new Error('response lost') } })
  try {
    await flush()
    await openEditor(panel.host)
    panel.host.querySelector<HTMLButtonElement>('.stub-duplicate')!.click()
    await flush()
    panel.host.querySelector<HTMLButtonElement>('.stub-duplicate')!.click()
    await flush()
    assert.equal(panel.posts.length, 2)
    assert.equal(panel.posts[1]!.body.operation_id, panel.posts[0]!.body.operation_id)
  } finally { panel.unmount() }
})

test('duplicate posts its operation id, then refreshes prompts and settings from disk', async () => {
  const panel = await mountPanel()
  try {
    await flush()
    await openEditor(panel.host)
    const getsBefore = panel.gets.length
    panel.host.querySelector<HTMLButtonElement>('.stub-duplicate')!.click()
    await flush()

    const duplicate = panel.posts.find(call => call.url.includes('/image-prompts/options/duplicate'))
    assert.ok(duplicate, 'the duplicate action calls its endpoint')
    assert.equal(duplicate!.body.number, 1)
    assert.match(String(duplicate!.body.operation_id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(panel.gets.length, getsBefore + 2,
      'both the prompt list and the settings re-read after duplicating')
  } finally { panel.unmount() }
})
