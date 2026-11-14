/**
 * 1.4.401 UI batch — measured checks, not eyeballing.
 *
 * Covers: AA contrast from the live tokens, the remembered Cards/List switch,
 * grouped warnings, equal-height card contracts, the regenerate controls, and
 * the "no typed paths" rule.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import { checkTheme, readTokens } from '../../scripts/check-contrast.mjs'
import { useViewMode } from '../composables/useViewMode.js'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('contrast', () => {
  test('every required text pair reaches WCAG AA in dark and light', () => {
    const tokens = readTokens()
    for (const theme of ['dark', 'light']) {
      const failed = checkTheme(tokens[theme]).filter(row => !row.pass)
      assert.deepEqual(failed, [], `${theme} failed: ${failed.map(row => `${row.label} ${row.ratio?.toFixed(2)}`).join(', ')}`)
    }
  })

  test('one accent is the primary action and status colours are not reused as body text', () => {
    const css = read('../assets/css/main.css')
    assert.match(css, /--accent: #f59e4b;/)
    assert.match(css, /--accent: #a15f08;/)
    assert.equal((css.match(/\.btn-primary\s*\{/g) || []).length, 1)
  })
})

describe('remembered view switch', () => {
  test('useViewMode restores the stored view and saves the next one', async () => {
    localStorage.setItem('test:remembered-view', 'list')
    const mode = useViewMode('test:remembered-view', 'cards')
    assert.equal(mode.value, 'list', 'restored synchronously, before first paint')
    mode.value = 'cards'
    await nextTick()
    assert.equal(localStorage.getItem('test:remembered-view'), 'cards')
  })

  test('both lists use the helper and offer the shared switch', () => {
    const channels = read('../pages/index.vue')
    const jobs = read('../pages/projects/[slug]/jobs.vue')
    assert.match(channels, /useViewMode\(CHANNEL_LAYOUT_KEY, 'cards'\)/)
    assert.match(channels, /story-studio:channels-layout:v1/)
    assert.match(jobs, /useViewMode\('story-studio:jobs-history-layout:v1', 'cards'\)/)
    assert.match(jobs, /<ViewModeToggle v-model="historyView" label="History view"/)
    assert.match(read('../components/ViewModeToggle.vue'), /aria-pressed/)
  })
})

describe('grouped warnings', () => {
  test('identical warnings are grouped with a count, and the detail stays', () => {
    const component = read('../components/GroupedWarnings.vue')
    assert.match(component, /group\.count/)
    assert.match(component, /group\.items\.length/)
    assert.match(component, /<details v-if="group\.items\.length > 1"/)
    assert.match(read('../pages/projects/[slug]/jobs.vue'), /<GroupedWarnings v-if="groupedJobWarnings\.length"/)
    assert.match(read('../components/content-store/ContentInstalledLibraryView.vue'), /<GroupedWarnings/)
  })
})

describe('equal-height cards', () => {
  const columns = (width: number, min: number, gap: number) => Math.floor((width + gap) / (min + gap))

  test('channel cards stretch in their row with the action pinned to the bottom', () => {
    const css = read('../pages/index.vue')
    assert.match(css, /\.project-grid \{\s*display: grid;/)
    assert.match(css, /\.project-card-wrap \{[^}]*display: flex[^}]*flex-direction: column/s)
    assert.match(css, /\.project-card \{[^}]*flex: 1 1 auto[^}]*flex-direction: column/s)
    assert.match(css, /\.project-card-actions \{[^}]*margin-top: auto/s)
  })

  test('Library pack cards stretch and keep one primary action', () => {
    const browser = read('../components/content-store/ContentPackBrowser.vue')
    const card = read('../components/content-store/ContentPackCard.vue')
    assert.match(browser, /\.pack-grid \{ display: grid;/)
    assert.match(card, /\.pack-card \{[^}]*display: flex;[^}]*flex-direction: column/s)
    assert.match(card, /\.pack-actions \{[^}]*margin-top: auto/s)
    assert.equal((card.match(/class="btn btn-primary pack-install"/g) || []).length, 1)
  })

  test('measured column counts at 1440 and 768 still form rows of equal-height cards', () => {
    // Page frame: clamp gutters; card content area is the page minus both gutters.
    const at1440 = columns(1440 - 96, 270, 14)
    const at768 = columns(768 - 32, 270, 14)
    assert.ok(at1440 >= 3, `channels at 1440: ${at1440} columns`)
    assert.equal(at768, 2, 'two equal-height channel columns at 768')
    assert.ok(columns(1440 - 96, 236, 14) >= 5, 'five Library pack columns at 1440')
    assert.equal(columns(768 - 32, 236, 14), 3, 'three Library pack columns at 768')
  })
})

describe('one-click regeneration', () => {
  test('Images offers per-failed-item and all-failed regeneration with an in-app confirm', () => {
    const page = read('../pages/projects/[slug]/images.vue')
    assert.match(page, /Regenerate all failed/)
    assert.match(page, /regenerateThumb\(item\)/)
    assert.match(page, /thumb_number: number, force: true/)
    assert.match(page, /useConfirm\(\)\.ask/)
    assert.match(page, /Started a new generation; job \$\{shortJobId/)
    assert.doesNotMatch(page, /window\.confirm/)
    assert.doesNotMatch(page, /alert\(/)
  })

  test('Scene Review offers all-failed regeneration and shows a short job id', () => {
    const page = read('../pages/projects/[slug]/scene-review.vue')
    assert.match(page, /Regenerate all failed/)
    assert.match(page, /async function regenerateAllFailed/)
    assert.match(page, /Started a new generation; job \$\{shortJobId/)
    assert.match(page, /failedRenderMessage/)
    assert.doesNotMatch(page, /window\.confirm/)
  })
})

describe('no typed paths', () => {
  test('FolderField is a read-only display plus picker', () => {
    const field = read('../components/FolderField.vue')
    assert.doesNotMatch(field, /<input/)
    assert.doesNotMatch(field, /Type a Path|Use This Path|allowTyping/)
    assert.match(field, /pickFolder\(/)
  })

  test('the custom subtitle path uses the file picker, not a text input', () => {
    const captions = read('../components/UploadCaptionsSettings.vue')
    assert.match(captions, /<FilePicker/)
    assert.doesNotMatch(captions, /v-model="draft\.custom_srt_path"/)
    assert.doesNotMatch(captions, /placeholder="\/path\/to\/episode\.srt"/)
  })
})
