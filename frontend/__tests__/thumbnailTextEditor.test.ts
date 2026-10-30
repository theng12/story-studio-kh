/**
 * Thumbnail text layer — frontend tests.
 *
 * Covers the owner-specified invariants:
 *   1. Presets never store the headline text or the source filename (AGENTS §5).
 *   2. Font filtering by ISO 15924 script — a font is offered only when it
 *      covers every script-bearing character in the headline.
 *   3. Episode change replaces or blanks every episode-specific field, and the
 *      PREVIOUS episode's artwork can never be adopted (AGENTS §4).
 *   4. A suggestion click fills the headline field.
 *
 * The composable is driven through a stubbed $fetch, so no backend is needed.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('source artwork picker uses episode image previews and retains filenames', () => {
  const component = readFileSync(new URL('../components/ThumbnailTextEditor.vue', import.meta.url), 'utf8')
  const picker = component.slice(component.indexOf('<label for="thumbnail-source-picker">'), component.indexOf('<!-- Headline language'))
  assert.match(picker, /<VisualOptionPicker/)
  assert.match(picker, /value: image\.filename/)
  assert.match(picker, /image\.filename === option\.value\)\?\.url/)
  assert.match(picker, /@update:model-value="source = \$event"/)
  assert.doesNotMatch(picker, /<select/)
})
import { nextTick, ref } from 'vue'

const POLL_MS = 10
/** Wait for the debounced exact preview by its effect, not by a guessed delay (no-new-wallclock-sleeps). */
async function until(condition: () => boolean, deadlineMs = 10_000): Promise<void> {
  const end = Date.now() + deadlineMs
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for the exact preview')
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

// ── Stubbed $fetch ──────────────────────────────────────────────────────────
const calls: Array<{ url: string; method: string; body?: any }> = []
const configStore: Record<string, any> = {}
const cannedFonts = [
  { id: 'kantumruy-pro', label: 'Kantumruy Pro', scripts: ['khmr', 'latn'], weights: [400, 700], role: 'text', license: 'OFL', source: 'bundled' },
  { id: 'moul', label: 'Moul', scripts: ['khmr'], weights: [400], role: 'display', license: 'OFL', source: 'bundled' },
  { id: 'inter', label: 'Inter', scripts: ['latn', 'cyrl'], weights: [400, 600, 700], role: 'text', license: 'OFL', source: 'bundled' },
]
const cannedBuiltins = [
  {
    id: 'builtin-1', name: 'Khmer bold', builtin: true,
    style: {
      font_id: 'kantumruy-pro', weight: 700,
      size: { mode: 'fit', min_px: 60, max_px: 180 },
      max_lines: 3, align: 'center', line_height: 1.1, letter_spacing: 0, uppercase: false,
      fill: { type: 'solid', color: '#FFFFFF' }, opacity: 1,
      outline: { enabled: true, color: '#000000', width_px: 4 },
      shadow: { enabled: false, color: '#000000', opacity: 0.5, dx: 0, dy: 4, blur_px: 8 },
      background: { enabled: false, color: '#000000', opacity: 0.4, padding_px: 12, radius_px: 8 },
      placement: { anchor: 'center', x_pct: 50, y_pct: 50, width_pct: 80, height_pct: 40 },
    },
  },
]
let cannedVariants: any[] = []
/** Per-episode thumbnail-text language settings: `${slug}:${episode}` → { channel_language, override }. */
const languageStore: Record<string, { channel_language: string | null; override: string | null }> = {}

;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
  const method = options?.method || 'GET'
  // useApi hands over a plain object; a caller may hand a string. Accept both.
  const body = typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body
  calls.push({ url, method, body })
  if (url === '/api/thumbnail-text/fonts') return cannedFonts
  if (url === '/api/thumbnail-text/presets/builtin') return cannedBuiltins
  if (/\/thumbnail-text\/variants$/.test(url) && method === 'GET') return cannedVariants
  const languageMatch = url.match(/^\/api\/projects\/([^/]+)\/episodes\/([^/]+)\/thumbnail-text\/settings$/)
  if (languageMatch) {
    const key = `${languageMatch[1]}:${decodeURIComponent(languageMatch[2])}`
    if (!languageStore[key]) languageStore[key] = { channel_language: 'km', override: null }
    const entry = languageStore[key]
    if (method === 'PUT') entry.override = body?.language ?? null
    return { ...entry, effective: entry.override ?? entry.channel_language }
  }
  if (/\/thumbnail-text\/preview$/.test(url) && method === 'POST') {
    return { image_base64: 'iVBORw0KGgo=', report: { font_px: 120, lines: 1, glyphs_complete: true, missing_characters: [], overflow: false } }
  }
  if (/\/thumbnail-text\/suggestions$/.test(url) && method === 'POST') {
    return {
      language: 'km', language_source: 'channel',
      suggestions: [{ text: 'សួស្តីពិភពលោក', length: 'short' }, { text: 'រឿងរ៉ាវថ្មី', length: 'medium' }],
      model: 'test-model',
    }
  }
  const configMatch = url.match(/^\/api\/projects\/([^/]+)\/settings\/config$/)
  if (configMatch) {
    const slug = configMatch[1]
    if (!configStore[slug]) configStore[slug] = {}
    if (method === 'GET') return { ...configStore[slug] }
    if (method === 'PUT') {
      Object.assign(configStore[slug], JSON.parse(JSON.stringify(body)))
      return { ok: true }
    }
  }
  throw new Error(`unexpected fetch: ${method} ${url}`)
}

const { useThumbnailText } = await import('../composables/useThumbnailText.js')
const { fontsForText, thumbnailTextStyleOnly, thumbnailTextEnabled } = await import('../utils/thumbnail-text.js')
const { CONTENT_LANGUAGE_OPTIONS, contentLanguageLabel } = await import('../utils/content-language.js')

// The exact preview goes through raw `fetch` (it may answer with PNG bytes or
// JSON), so it is stubbed separately from `$fetch`. This is the JSON branch.
const previewCalls: string[] = []
let previewReport: any = { font_px: 120, lines: 1, glyphs_complete: true, missing_characters: [], overflow: false }
;(globalThis as any).fetch = async (url: string) => {
  previewCalls.push(String(url))
  if (!String(url).includes('/preview')) throw new Error(`unexpected fetch: ${url}`)
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ image_base64: 'iVBORw0KGgo=', report: previewReport }),
    blob: async () => ({}),
  }
}

beforeEach(() => {
  calls.length = 0
  previewCalls.length = 0
  for (const k of Object.keys(configStore)) delete configStore[k]
  for (const k of Object.keys(languageStore)) delete languageStore[k]
  cannedVariants = []
  previewReport = { font_px: 120, lines: 1, glyphs_complete: true, missing_characters: [], overflow: false }
})

const settle = () => new Promise(resolve => setTimeout(resolve, 25))

/** Build an editor the way the page does: this episode's own file list, the
 *  file the user pointed at, and a visibility flag. */
function makeEditor(slug: string, episodeCode = 'ep-01') {
  const state = {
    episode: ref(episodeCode),
    visible: ref(true),
    sources: ref<Array<{ filename: string }>>([{ filename: 'art-01.png' }]),
    initialSource: ref('art-01.png'),
  }
  const editor = useThumbnailText({ slug, ...state })
  return { editor, ...state }
}

// ── 1. Presets never store text/source (AGENTS §5) ────────────────────────
describe('thumbnail text presets — reusable look only', () => {
  test('a saved preset carries the look and never the headline or the source', async () => {
    const slug = 'proj-preset'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'សួស្តី'
    editor.source.value = 'art-01.png'
    await nextTick()
    await editor.presets.saveAs('My Khmer look')

    const stored = configStore[slug].thumbnail_text_presets
    assert.ok(Array.isArray(stored), 'presets array must be persisted')
    const saved = stored.find((p: any) => p.name === 'My Khmer look')
    assert.ok(saved, 'the new preset must be in the saved list')
    assert.equal('text' in saved.data, false, 'preset must NOT carry the headline text')
    assert.equal('source' in saved.data, false, 'preset must NOT carry the source')
    assert.equal('source_filename' in saved.data, false, 'preset must NOT carry source_filename')
    assert.equal(saved.data.font_id, 'kantumruy-pro', 'preset must carry the look')
    assert.ok(saved.data.placement, 'preset must carry the placement')
    // The pointer the channel reopens with uses the owner's key name.
    assert.equal(configStore[slug].thumbnail_text_last_preset, saved.id)
  })

  test('applying a preset restores the look and leaves the headline untouched', async () => {
    const slug = 'proj-preset-apply'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'my headline'
    await nextTick()
    // A stored preset that (wrongly) carries text must still not restore it.
    configStore[slug] = {
      thumbnail_text_presets: [{
        id: 'p-old', name: 'Legacy', type: 'thumbnail-text',
        data: { ...JSON.parse(JSON.stringify(editor.style.value)), text: 'stale words', source: 'old.png' },
      }],
      thumbnail_text_last_preset: 'p-old',
    }
    await editor.presets.load()
    await nextTick()
    assert.equal(editor.text.value, 'my headline', 'applying a preset must never move the headline')
    assert.notEqual(editor.source.value, 'old.png', 'applying a preset must never move the source')
  })

  test('thumbnailTextStyleOnly allowlists the look and drops stray keys', () => {
    const dirty = {
      font_id: 'inter', weight: 700,
      size: { mode: 'fit', min_px: 40, max_px: 160 },
      max_lines: 2, align: 'center', line_height: 1.1, letter_spacing: 0, uppercase: false,
      fill: { type: 'solid', color: '#FFFFFF' }, opacity: 1,
      outline: { enabled: false, color: '#000000', width_px: 0 },
      shadow: { enabled: false, color: '#000000', opacity: 0.5, dx: 0, dy: 4, blur_px: 8 },
      background: { enabled: false, color: '#000000', opacity: 0.4, padding_px: 12, radius_px: 8 },
      placement: { anchor: 'center', x_pct: 50, y_pct: 50, width_pct: 80, height_pct: 40 },
      text: 'stale headline', source: 'stale.png', episode_id: 'ep-99', extra: 'noise',
    }
    const clean = thumbnailTextStyleOnly(dirty as any)
    assert.equal('text' in clean, false)
    assert.equal('source' in clean, false)
    assert.equal('episode_id' in clean, false)
    assert.equal('extra' in clean, false)
    assert.equal(clean.font_id, 'inter')
  })
})

// ── 2. Font filtering by script ────────────────────────────────────────────
describe('fontsForText — script coverage', () => {
  test('Khmer headline returns only Khmer-covering fonts', () => {
    assert.deepEqual(fontsForText(cannedFonts as any, 'សួស្តីពិភពលោក').map(f => f.id).sort(), ['kantumruy-pro', 'moul'])
  })

  test('Latin headline returns Latin-covering fonts, excludes Khmer-only', () => {
    assert.deepEqual(fontsForText(cannedFonts as any, 'Hello world').map(f => f.id).sort(), ['inter', 'kantumruy-pro'])
  })

  test('Cyrillic headline returns only Cyrillic-covering fonts', () => {
    assert.deepEqual(fontsForText(cannedFonts as any, 'Привет').map(f => f.id), ['inter'])
  })

  test('mixed Khmer + Latin returns fonts covering BOTH scripts', () => {
    assert.deepEqual(fontsForText(cannedFonts as any, 'សួស្តី Hello').map(f => f.id), ['kantumruy-pro'])
  })

  test('digits and punctuation need no script coverage', () => {
    assert.equal(fontsForText(cannedFonts as any, '123 !@#').length, cannedFonts.length)
  })

  test('no font at all is reported as no available fonts, not as everything', () => {
    assert.equal(fontsForText(cannedFonts as any, 'ᚠᚢᚦ').length, 0)
  })
})

// ── 3. Episode change: episode state must not survive (AGENTS §4) ─────────
describe('episode change — episode state must not survive', () => {
  test('the previous episode’s artwork is never adopted by the next episode', async () => {
    const slug = 'proj-ep'
    const { editor, episode, sources, initialSource } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'ep-01 headline'
    editor.source.value = 'art-01.png'
    cannedVariants = [{ filename: 'art-01-text.png', source_filename: 'art-01.png', text: 'ep-01 headline', stale: false, stale_reason: null }]
    await editor.initialize()
    await settle()
    await nextTick()
    assert.equal(editor.variants.value.length, 1, 'ep-01 variant loaded')

    // The page's own episode watcher clears the file list and re-points the
    // editor, exactly as images.vue does.
    episode.value = 'ep-02'
    sources.value = []
    initialSource.value = 'art-09.png'
    await nextTick()
    assert.equal(editor.text.value, '', 'headline blanked on episode change')
    assert.notEqual(editor.source.value, 'art-01.png', 'the previous episode’s artwork must never survive')
    assert.equal(editor.source.value, '', 'no source until this episode’s own files arrive')
    assert.equal(editor.variants.value.length, 0, 'variants cleared on episode change')
    assert.equal(editor.exactUrl.value, '', 'preview cleared on episode change')
    assert.equal(editor.report.value, null, 'report cleared on episode change')
    assert.equal(editor.suggestions.value, null, 'suggestions cleared on episode change')
    assert.equal(editor.saved.value, null, 'saved-variant pointer cleared')
    assert.match(editor.notice.value, /cleared/i, 'the reader must be told what was cleared')

    // A file that belongs to the PREVIOUS episode is still refused even if the
    // page points at it: ownership is membership in this episode's own list.
    initialSource.value = 'art-01.png'
    await nextTick()
    assert.equal(editor.source.value, '', 'a foreign filename is refused, not adopted')

    // This episode's own artwork is adopted once it arrives — losing the
    // selection on every switch would be its own defect.
    sources.value = [{ filename: 'art-09.png' }]
    initialSource.value = 'art-09.png'
    await nextTick()
    assert.equal(editor.source.value, 'art-09.png', 'this episode’s own artwork is adopted')
  })

  test('a source that leaves this episode clears the source and the preview', async () => {
    const slug = 'proj-ep-drop'
    const { editor, sources } = makeEditor(slug)
    await settle()
    await nextTick()
    assert.equal(editor.source.value, 'art-01.png')
    sources.value = [{ filename: 'art-02.png' }]
    await nextTick()
    assert.equal(editor.source.value, '', 'source cleared when it is no longer in the episode')
    assert.match(editor.notice.value, /cleared/i)
  })

  test('hiding the editor blanks the headline so a reopen cannot inherit it', async () => {
    const slug = 'proj-vis'
    const { editor, visible } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'headline'
    editor.source.value = 'art-01.png'
    visible.value = false
    await nextTick()
    assert.equal(editor.text.value, '', 'headline blanked when the editor closes')
    assert.equal(editor.source.value, '', 'source blanked when the editor closes')
  })
})

// ── 4. Suggestions ─────────────────────────────────────────────────────────
describe('suggestions', () => {
  test('asking for ideas populates the list from the backend', async () => {
    const slug = 'proj-sug'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    assert.equal(editor.suggestions.value, null, 'no suggestions before asking')
    await editor.moreSuggestions()
    assert.ok(editor.suggestions.value, 'suggestions populated')
    assert.equal(editor.suggestions.value!.suggestions.length, 2)
    assert.equal(editor.suggestions.value!.language, 'km')
  })

  test('clicking a suggestion fills the headline field', async () => {
    const slug = 'proj-sug2'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    await editor.moreSuggestions()
    const idea = editor.suggestions.value!.suggestions[0].text
    editor.chooseSuggestion(idea)
    assert.equal(editor.text.value, idea)
  })

  test('a refused suggestion request shows the reason plainly and keeps the editor usable', async () => {
    const slug = 'proj-sug3'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    const failing = async () => { throw Object.assign(new Error('x'), { data: { detail: 'No writing model is set in this channel’s Thumbnail Prompts preset.' } }) }
    const original = (globalThis as any).$fetch
    ;(globalThis as any).$fetch = failing
    await editor.moreSuggestions()
    ;(globalThis as any).$fetch = original
    assert.match(editor.suggestionError.value, /No writing model is set/)
    assert.equal(editor.suggestions.value, null)
    assert.equal(editor.text.value, '', 'the headline field is untouched by a refusal')
  })
})

// ── 5. Apply gating ────────────────────────────────────────────────────────
describe('apply gate', () => {
  test('apply unlocks only once the exact preview reports no overflow and no missing glyphs', async () => {
    const slug = 'proj-apply'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    assert.equal(editor.canApply.value, false, 'nothing requested yet')

    editor.text.value = 'headline'
    await nextTick()
    assert.equal(editor.canApply.value, false, 'no preview report yet')

    // Let the debounced exact preview run. Its report — not the editor's own
    // guess — is what unlocks Apply.
    await until(() => editor.canApply.value)
    assert.ok(previewCalls.some(url => url.includes('/preview')), 'an exact preview was requested')
    assert.equal(editor.report.value?.font_px, 120, 'the report came from the preview response')
    assert.equal(editor.canApply.value, true, 'a clean report unlocks apply')

    editor.report.value = { font_px: 120, lines: 4, glyphs_complete: true, missing_characters: [], overflow: true }
    assert.equal(editor.canApply.value, false, 'overflow must disable apply')

    editor.report.value = { font_px: 120, lines: 1, glyphs_complete: false, missing_characters: ['ៗ'], overflow: false }
    assert.equal(editor.canApply.value, false, 'missing glyphs must disable apply')

    editor.report.value = { font_px: 0, lines: 0, glyphs_complete: true, missing_characters: [], overflow: false }
    assert.equal(editor.canApply.value, false, 'a report that measured nothing is not a pass')
  })

  test('editing the headline after a clean preview takes apply away again', async () => {
    const slug = 'proj-apply-stale'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'headline'
    await until(() => editor.canApply.value)
    assert.equal(editor.canApply.value, true)
    editor.text.value = 'headline with more words'
    await nextTick()
    assert.equal(editor.report.value, null, 'the old report is dropped with the old text')
    assert.equal(editor.canApply.value, false, 'apply is off while a fresh preview is pending')
  })

  test('apply is unavailable when no installed font covers the headline', async () => {
    const slug = 'proj-apply-font'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    editor.text.value = 'ᚠᚢᚦ'
    await nextTick()
    assert.equal(editor.availableFonts.value.length, 0)
    assert.equal(editor.canApply.value, false, 'no covering font means no apply')
  })
})

// ── 6. The settings switch ─────────────────────────────────────────────────
describe('the channel switch gates the feature', () => {
  test('thumbnailTextEnabled is false unless the channel switched it on', () => {
    assert.equal(thumbnailTextEnabled({}), false, 'absent means off')
    assert.equal(thumbnailTextEnabled({ thumbnail_text_layer_enabled: false }), false)
    assert.equal(thumbnailTextEnabled({ thumbnail_text_layer_enabled: true }), true)
    assert.equal(thumbnailTextEnabled(null), false, 'an unloaded config is off, not on')
    // A truthy non-boolean must not open the feature.
    assert.equal(thumbnailTextEnabled({ thumbnail_text_layer_enabled: 'yes' }), false)
  })
})

// ── 7. Headline language (owner, 2026-10-25) ───────────────────────────────
describe('headline language — follows the channel unless overridden', () => {
  test('the shared option list is the app’s own two languages', () => {
    assert.deepEqual(CONTENT_LANGUAGE_OPTIONS.map(option => option.value), ['en', 'km'])
    assert.equal(contentLanguageLabel('km'), 'Khmer')
    assert.equal(contentLanguageLabel('en'), 'English')
    assert.equal(contentLanguageLabel('th'), '', 'an unsupported code has no label')
    assert.equal(contentLanguageLabel(null), '')
  })

  test('defaults to the channel language and reports that it is following', async () => {
    const { editor } = makeEditor('proj-lang')
    await settle()
    await nextTick()
    assert.equal(editor.channelLanguage.value, 'km')
    assert.equal(editor.languageOverride.value, null)
    assert.equal(editor.followsChannel.value, true)
    assert.equal(editor.effectiveLanguage.value, 'km')
  })

  test('a language the episode saved is loaded and used', async () => {
    languageStore['proj-lang-load:ep-01'] = { channel_language: 'km', override: 'en' }
    const { editor } = makeEditor('proj-lang-load')
    await settle()
    await nextTick()
    assert.equal(editor.languageOverride.value, 'en')
    assert.equal(editor.effectiveLanguage.value, 'en')
    assert.equal(editor.followsChannel.value, false)
    assert.equal(editor.channelLanguage.value, 'km')
  })

  test('choosing another language persists it for this episode and never touches the channel', async () => {
    const slug = 'proj-lang-set'
    const { editor } = makeEditor(slug)
    await settle()
    await nextTick()
    await editor.setLanguageOverride('en')
    assert.equal(editor.languageOverride.value, 'en')
    assert.equal(editor.followsChannel.value, false)
    assert.equal(editor.effectiveLanguage.value, 'en')
    assert.equal(editor.channelLanguage.value, 'km', 'the channel language is unchanged')
    // The choice was PUT to this episode's settings, and the channel's own config was never written.
    const put = calls.find(call => call.method === 'PUT' && /thumbnail-text\/settings$/.test(call.url))
    assert.deepEqual(put?.body, { language: 'en' })
    assert.equal(languageStore[`${slug}:ep-01`].override, 'en', 'the override persisted for the episode')
    assert.equal(configStore[slug]?.content_language, undefined)
  })

  test('clearing the override returns to following the channel language', async () => {
    const { editor } = makeEditor('proj-lang-clear')
    await settle()
    await nextTick()
    await editor.setLanguageOverride('en')
    assert.equal(editor.followsChannel.value, false)
    await editor.setLanguageOverride(null)
    assert.equal(editor.languageOverride.value, null)
    assert.equal(editor.followsChannel.value, true)
    assert.equal(editor.effectiveLanguage.value, 'km')
    const put = calls.filter(call => call.method === 'PUT' && /thumbnail-text\/settings$/.test(call.url)).pop()
    assert.deepEqual(put?.body, { language: null })
  })

  test('an episode change drops the previous episode’s language choice', async () => {
    const { editor, episode } = makeEditor('proj-lang-ep')
    await settle()
    await nextTick()
    await editor.setLanguageOverride('en')
    // The next episode has no override of its own and a different channel language.
    languageStore['proj-lang-ep:ep-02'] = { channel_language: 'en', override: null }
    episode.value = 'ep-02'
    await nextTick()
    assert.equal(editor.languageOverride.value, null, 'the previous episode’s override must not survive')
    await settle()
    await nextTick()
    assert.equal(editor.channelLanguage.value, 'en', 'ep-02’s own state is loaded')
    assert.equal(editor.followsChannel.value, true)
  })
})
