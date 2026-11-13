/**
 * v1.4.237 — the titlebar strip stays reserved, and no rule declares a property twice.
 *
 * **The defect the owner saw.** Two screenshots of the channels page, before and after scrolling:
 * the first shows the 38px titlebar strip with the Page guide and the version chip above the page
 * header; the second shows the page header at the very top with the window's **traffic lights drawn
 * over the logo** — *"the 3 traffic light is blocking the logo and stuff… basically when i
 * scrolled."*
 *
 * The cause was one duplicated declaration. `layouts/default.vue`'s `.top-bar` said
 * `position: sticky` and then, sixty lines of comment later in the same rule, `position: relative`
 * — added when the version chip was layered on top of the drag region. **A later declaration in the
 * same rule silently overwrites the earlier one**, so the bar was `relative`, scrolled away with the
 * page, and the content slid up under OS chrome that cannot move.
 *
 * **Found in the built CSS, not the source**, which is this repo's own rule for exactly this shape
 * (§3.2: *"CSS that silently does nothing… check specificity in the built CSS rather than reasoning
 * from source"*). The minifier had kept the loser and thrown the intended value away:
 *
 *     .top-bar[data-v-99d8964a]{…;flex-shrink:0;position:relative;top:0}
 *
 * Reading the source alone would have shown `position: sticky` sitting right there, looking like it
 * worked. That is why these tests assert the *rule*, not the spelling.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import path from 'node:path'

const FRONTEND = fileURLToPath(new URL('..', import.meta.url))

function source(relative: string): string {
  return readFileSync(path.join(FRONTEND, relative), 'utf8')
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every `selector { … }` body in a stylesheet, as `[selector, body]`. */
function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const pattern = /\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    if (match[1].includes('{')) continue
    const head = css.slice(0, match.index)
    const open = head.lastIndexOf('}')
    out.push([head.slice(open + 1).trim(), match[1]])
  }
  return out
}

function vueFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.output', '.nuxt', 'dist'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...vueFiles(full))
    else if (entry.name.endsWith('.vue') || entry.name.endsWith('.css')) found.push(full)
  }
  return found
}

describe('the titlebar strip reserves the traffic lights', () => {
  // v1.4.371 — the strip and the version chip moved into ONE shared header
  // (components/AppHeader.vue) that every non-channel page renders. The rule
  // under test is unchanged; only the file that owns it changed.
  const header = source('components/AppHeader.vue')
  const css = stripComments(header)

  test('the top bar is sticky, because that is what keeps the strip at the top', () => {
    // The first rule in the style block carries the tag before it, so match on the end.
    const bar = rules(css).find(([selector]) => selector.endsWith('.app-header'))
    assert.ok(bar, '.app-header has no style rule in components/AppHeader.vue')
    assert.match(bar![1], /position:\s*sticky/,
      'the top bar must be sticky: it is the strip that keeps the page content clear of the '
      + "window's traffic lights, which are OS chrome and cannot move")
  })

  test('the top bar does not also declare a position that would override it', () => {
    // The exact defect: a second `position` in the same rule wins, and the minifier drops the
    // first — so the reserved strip scrolls away and the logo lands under the traffic lights.
    const bar = rules(css).find(([selector]) => selector.endsWith('.app-header'))!
    const declared = [...bar[1].matchAll(/position:\s*([a-z-]+)/g)].map(m => m[1])
    assert.equal(declared.length, 1,
      `.app-header declares position ${declared.length} times (${declared.join(', ')}); only the last `
      + 'one takes effect, so the others are dead code that reads as if it works')
    assert.equal(declared[0], 'sticky')
  })

  test('the version chip is inside that sticky bar', () => {
    // The chip needs no absolute positioning any more: it sits in the bar's
    // right-hand cluster, so it scrolls with the bar and cannot outlive it.
    assert.match(header, /class="app-header-tools"[\s\S]{0,600}<AppVersionInfo/,
      'the version chip lives in the header bar itself')
    assert.match(css, /\.app-header\s*\{[^}]*position:\s*sticky/)
  })

  test('the bar keeps clear of the traffic lights', () => {
    assert.match(css, /\.app-header-bar\s*\{[^}]*padding:[^;]*84px/,
      'the left padding is the reserved strip the hidden-inset traffic lights sit in')
  })
})

describe('no stylesheet declares a property twice in one rule', () => {
  test('every rule sets each property at most once', () => {
    // Generalised on purpose: one instance was the traffic-light bug, and the shape is invisible
    // — the losing declaration is still there to read, it simply has no effect.
    const offenders: string[] = []
    for (const file of vueFiles(FRONTEND)) {
      const text = stripComments(readFileSync(file, 'utf8'))
      for (const [selector, body] of rules(text)) {
        const seen = new Set<string>()
        for (const match of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
          const property = match[1]
          if (seen.has(property)) {
            offenders.push(`${path.relative(FRONTEND, file)} → ${selector || '(root)'} → ${property}`)
          }
          seen.add(property)
        }
      }
    }
    assert.deepEqual(offenders, [],
      'a property declared twice in one rule means the earlier declaration silently loses')
  })
})
