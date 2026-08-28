/**
 * A `model_notice` that reaches the API response and stops there is not
 * surfaced — it is half-done.
 *
 * The three SYNCHRONOUS routes that resolve a default chat model have no job
 * log to announce a heal on, so they return the sentence beside their result.
 * That is only worth anything if the surface that made the call renders it.
 * The first cut of this change shipped the field with no consumer, which is
 * the same "authored is not connected" shape as the selection-gap helper that
 * sat unimported for a release.
 *
 * These are WIRING assertions over source, not component mounts. The seam
 * under test is one guarded line per surface (`if (r.model_notice) …`), and
 * one of the three surfaces is a ~5000-line page that is not tractable to
 * mount; the behavioural risk here is "is it read and routed", which is
 * exactly what these pin. The gap-message components, whose logic is real
 * computed state, are mounted for real in `modelSelectionGapVisible.test.ts`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ROOT = path.resolve(FRONTEND_ROOT, '..', 'electron', 'server')

/** Each synchronous route, and the surface that must show what it returns. */
const SURFACES = [
  {
    what: 'regenerating one image prompt',
    surface: 'components/PromptReviewPanel.vue',
    route: 'image-prompts/regenerate',
    /** The response binding the guard reads off. */
    binding: 'data',
  },
  {
    what: 'generating a playlist description',
    surface: 'pages/projects/[slug]/upload.vue',
    route: 'playlists/generate-description',
    binding: 'r',
  },
  {
    what: 'tagging one narration section',
    surface: 'components/FishExpressionPanel.vue',
    route: 'expression/generate',
    binding: 'r',
  },
] as const

describe('a healed default model is shown on the surface that asked for it', () => {
  for (const { what, surface, route, binding } of SURFACES) {
    describe(surface, () => {
      const source = readFileSync(path.join(FRONTEND_ROOT, surface), 'utf8')

      test(`calls the route it is the surface for (${what})`, () => {
        assert.ok(source.includes(route), `${surface} should still call ${route}`)
      })

      test('declares model_notice on the response it awaits', () => {
        // Without this the field is invisible to TypeScript and the guard
        // below would be dead code the compiler cannot vouch for.
        assert.match(
          source,
          /model_notice\?: string/,
          `${surface} must type the field it reads`,
        )
      })

      test('renders it through this surface\'s own non-blocking mechanism', () => {
        assert.match(
          source,
          new RegExp(`showToast\\(${binding}\\.model_notice, 'info', \\d+\\)`),
          `${surface} must show the notice as an informational toast`,
        )
      })

      test('a heal never blocks — no modal, no error channel, no thrown flow', () => {
        // A substitution is informational: the work the user asked for DID
        // happen. Routing it to an error or a modal would misreport that.
        const noticeLine = source.split('\n').find(l => l.includes('model_notice') && l.includes('showToast')) || ''
        assert.doesNotMatch(noticeLine, /'error'/, 'a heal is not an error')
        assert.doesNotMatch(noticeLine, /showError|loadError|confirm\(|alert\(/, 'a heal must not block or alarm')
      })

      test('an absent notice changes nothing', () => {
        // The guard is what makes "no model_notice" byte-identical to before.
        assert.match(
          source,
          new RegExp(`if \\(${binding}\\.model_notice\\) showToast\\(`),
          `${surface} must only show the notice when the server sent one`,
        )
      })
    })
  }
})

/**
 * The coupling guard — the reason this follow-up existed at all.
 *
 * A route may only return `model_notice` if some surface consumes it. This is
 * cheap and it pins exactly the defect class that shipped half-done: a field
 * added server-side with no reader.
 */
describe('no route returns a notice nobody reads', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.nuxt') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  test('every route returning model_notice has a frontend consumer', () => {
    const producing = walk(SERVER_ROOT)
      .filter(f => readFileSync(f, 'utf8').includes('model_notice'))
      .map(f => path.relative(SERVER_ROOT, f))
      // The job path carries the notice in params to announce on output_lines
      // instead — it is surfaced, just not through a response body.
      .filter(f => f !== 'services/audio-expression.ts')

    assert.ok(producing.length >= 3, 'expected the three synchronous routes to return the notice')

    const consumed = walk(FRONTEND_ROOT).some(f => readFileSync(f, 'utf8').includes('model_notice'))
    assert.ok(consumed, 'a route returns model_notice but no frontend file mentions it')

    // Each producing route's surface is named above, so a NEW producer that
    // nobody wired lands here rather than shipping invisible.
    const surfacedRoutes = new Set(SURFACES.map(s => s.route))
    for (const routeFile of producing) {
      const routeSource = readFileSync(path.join(SERVER_ROOT, routeFile), 'utf8')
      const hasNamedSurface = [...surfacedRoutes].some(r => routeSource.includes(r.split('/').pop()!))
      assert.ok(
        hasNamedSurface,
        `${routeFile} returns model_notice but matches no surface in SURFACES — wire it, then add it here`,
      )
    }
  })
})
