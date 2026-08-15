/**
 * Modal's CSS contract — the specificity trap regression suite.
 *
 * History: Modal's cosmetic defaults used to live in its `<style scoped>`
 * block, so they compiled to `.modal-dialog[data-v-…]` — specificity (0,2,0).
 * A consumer that wrote the obvious `.my-dialog { padding: 0 }` (0,1,0) lost
 * silently: CSS reports nothing, the declaration simply does nothing.
 * AppSettingsModal shipped with a dead `padding: 0` for months, and
 * PickerDialog only worked because it reached for a (0,3,0)
 * `.modal-overlay > .modal-dialog.picker-dialog` workaround.
 *
 * The fix: cosmetic defaults live in an unscoped block wrapped in `:where()`
 * (zero specificity), structural ones stay scoped. These tests build the real
 * cascade in happy-dom and assert on computed styles, because reasoning about
 * scoped-style specificity by eye is exactly what went wrong the first time.
 *
 * The consumer CSS is deliberately injected BEFORE Modal's, so anything that
 * wins here wins on specificity, not on source order.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { before, describe, test } from 'node:test'

const SCOPE = 'data-v-modal'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

/** Top-level `<style>` blocks of an SFC, in order. */
function styleBlocks(sfc: string): { scoped: boolean; css: string }[] {
  const blocks: { scoped: boolean; css: string }[] = []
  const re = /^<style([^>]*)>$([\s\S]*?)^<\/style>$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(sfc))) blocks.push({ scoped: /\bscoped\b/.test(match[1]), css: match[2] })
  return blocks
}

/** Drop @keyframes blocks — the scope transform below must not walk into them. */
function stripKeyframes(css: string): string {
  let out = ''
  let cursor = 0
  for (;;) {
    const at = css.indexOf('@keyframes', cursor)
    if (at < 0) return out + css.slice(cursor)
    out += css.slice(cursor, at)
    let depth = 0
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (!depth) { cursor = i + 1; break }
      }
    }
  }
}

/**
 * Stand-in for Vue's scoped-style transform: append `[data-v-…]` to every
 * selector. That attribute is what pushes a scoped rule to (0,2,0).
 */
function applyScope(css: string, attr: string): string {
  return stripKeyframes(css).replace(/(^|[};])([^{};]+)\{/g, (whole, before: string, selector: string) => {
    if (selector.trim().startsWith('@')) return whole
    return `${before}${selector.split(',').map((s) => `${s.trim()}[${attr}]`).join(',')}{`
  })
}

function emittedCss(sfc: string): string {
  return styleBlocks(sfc)
    .map((block) => (block.scoped ? applyScope(block.css, SCOPE) : stripKeyframes(block.css)))
    .join('\n')
}

function unscopedCss(sfc: string): string {
  return styleBlocks(sfc)
    .filter((block) => !block.scoped)
    .map((block) => block.css)
    .join('\n')
}

const modalSfc = source('../components/Modal.vue')
const pickerSfc = source('../components/PickerDialog.vue')
const appSettingsSfc = source('../components/AppSettingsModal.vue')
const generationSfc = source('../components/GenerationConfirmationDialog.vue')

/** Renders overlay > dialog the way Modal does, and returns computed styles. */
function computedDialog(classes: string): CSSStyleDeclaration {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.setAttribute(SCOPE, '')
  const dialog = document.createElement('div')
  dialog.className = classes
  dialog.setAttribute(SCOPE, '')
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
  return getComputedStyle(dialog)
}

describe('Modal style contract', () => {
  before(() => {
    // Consumers first: whatever wins below wins on specificity, not order.
    const consumers = document.createElement('style')
    consumers.textContent = [
      unscopedCss(pickerSfc),
      unscopedCss(appSettingsSfc),
      // A brand-new consumer writing the most obvious thing possible.
      '.probe-dialog { padding: 3px; background: rgb(1, 2, 3); border-radius: 0px; max-height: 100px; min-width: 400px; }',
      '.probe-flush-override { padding: 7px; }',
    ].join('\n')
    document.head.appendChild(consumers)

    const pickerChrome = document.createElement('style')
    pickerChrome.textContent = styleBlocks(pickerSfc)
      .filter((block) => block.scoped)
      .map((block) => applyScope(block.css, SCOPE))
      .join('\n')
    document.head.appendChild(pickerChrome)

    const modal = document.createElement('style')
    modal.textContent = emittedCss(modalSfc)
    document.head.appendChild(modal)
  })

  test('a plain-class consumer override beats every cosmetic default', () => {
    const styles = computedDialog('modal-dialog size-sm probe-dialog')
    assert.equal(styles.padding, '3px')
    assert.equal(styles.backgroundColor, 'rgb(1, 2, 3)')
    assert.equal(styles.borderRadius, '0px')
    assert.equal(styles.maxHeight, '100px')
  })

  test('an untouched dialog still gets the house style', () => {
    const styles = computedDialog('modal-dialog size-md')
    assert.equal(styles.padding, '24px')
    assert.equal(styles.maxWidth, '560px')
    assert.equal(styles.overflowY, 'auto')
    assert.equal(styles.maxHeight, 'calc(100dvh - 48px)')
  })

  test('structural rules stay at full specificity and cannot be lost', () => {
    // min-width: 0 is the flex-shrink guard; a consumer must not undo it by
    // accident, so it stays in the scoped block at (0,2,0).
    assert.match(computedDialog('modal-dialog probe-dialog').minWidth, /^0(px)?$/)
    const scoped = styleBlocks(modalSfc).filter((block) => block.scoped).map((b) => b.css).join('\n')
    assert.match(scoped, /\.modal-overlay\s*{[\s\S]*position:\s*fixed/)
    assert.match(scoped, /\.modal-dialog\s*{[\s\S]*min-width:\s*0/)
    assert.doesNotMatch(scoped, /:where\(/)
  })

  test('cosmetic defaults live in the unscoped :where() block, never the scoped one', () => {
    const scoped = styleBlocks(modalSfc).filter((block) => block.scoped).map((b) => b.css).join('\n')
    const dialogRule = /\.modal-dialog\s*{([^}]*)}/.exec(scoped)?.[1] ?? ''
    assert.doesNotMatch(
      dialogRule,
      /(^|;)\s*(padding|width|max-width|max-height|background|border|border-radius|box-shadow|overflow[\w-]*)\s*:/,
    )
    const unscoped = unscopedCss(modalSfc)
    for (const rule of ['padding: 24px', 'width: calc(100% - 48px)', 'max-height: calc(100dvh - 48px)']) {
      assert.ok(unscoped.includes(rule), `expected the unscoped block to own \`${rule}\``)
    }
    const selectors = [...unscoped.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[};])([^{};]+)\{/g)]
      .map((match) => match[1].trim())
      .filter((selector) => selector && !selector.startsWith('@'))
    assert.ok(selectors.length >= 7, 'expected Modal to declare its cosmetic defaults unscoped')
    for (const selector of selectors) {
      assert.match(selector, /^:where\(/, `unscoped Modal selector must be :where()-wrapped: ${selector}`)
    }
  })

  test('modal-flush is the supported no-padding API, and is itself overridable', () => {
    assert.equal(computedDialog('modal-dialog size-md modal-flush').padding, '0px')
    assert.equal(computedDialog('modal-dialog size-md modal-flush probe-flush-override').padding, '7px')
    assert.match(appSettingsSfc, /dialog-class="app-settings-dialog modal-flush"/)
    assert.match(generationSfc, /dialog-class="generation-dialog modal-flush"/)
  })

  test('PickerDialog gets its size and flush body from a plain class', () => {
    const styles = computedDialog('modal-dialog size-lg picker-dialog')
    assert.equal(styles.padding, '0px')
    assert.equal(styles.width, 'calc(100% - 40px)')
    assert.equal(styles.maxHeight, 'min(760px, calc(100dvh - 40px))')
    // Modal still supplies the size cap the picker did not override.
    assert.equal(styles.maxWidth, '720px')
  })

  test('PickerDialog close control keeps a 44px minimum target at 320px', () => {
    const priorWidth = window.innerWidth
    const close = document.createElement('button')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    try {
      close.className = 'pd-close'
      close.setAttribute(SCOPE, '')
      document.body.appendChild(close)
      const styles = getComputedStyle(close)
      assert.ok(Number.parseFloat(styles.width) >= 44, `expected width >= 44px, got ${styles.width}`)
      assert.ok(Number.parseFloat(styles.height) >= 44, `expected height >= 44px, got ${styles.height}`)
    } finally {
      close.remove()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: priorWidth })
    }
  })

  test('AppSettingsModal keeps its own frame and takes padding from the API', () => {
    const styles = computedDialog('modal-dialog size-xxl app-settings-dialog modal-flush')
    assert.equal(styles.padding, '0px')
    assert.equal(styles.maxHeight, 'calc(100dvh - 32px)')
    assert.equal(styles.display, 'flex')
    assert.equal(styles.maxWidth, '1120px')
  })

  test('no consumer needs the old descendant-selector workaround', () => {
    for (const [name, sfc] of Object.entries({
      PickerDialog: pickerSfc,
      AppSettingsModal: appSettingsSfc,
      WhatsNewModal: source('../components/WhatsNewModal.vue'),
      GenerationConfirmationDialog: generationSfc,
    })) {
      // Comments stripped: these files explain the trap in prose.
      const css = styleBlocks(sfc).map((block) => block.css).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
      assert.doesNotMatch(css, /\.modal-overlay\s*>\s*\.modal-dialog/, `${name} should not need to outrank Modal`)
      // The dialog is teleported to <body>, so it never carries a consumer's
      // scope id: `:deep()` at a dialog class matches nothing at all.
      assert.doesNotMatch(css, /:deep\(\s*\.[\w-]*dialog/, `${name} cannot reach the dialog with :deep()`)
    }
  })
})
