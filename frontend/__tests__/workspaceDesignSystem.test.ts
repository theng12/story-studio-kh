import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const nuxtConfig = source('../nuxt.config.ts')
const designSystem = source('../assets/css/design-system.css')
const hero = source('../components/WorkspaceHero.vue')
const section = source('../components/WorkspaceSection.vue')
const notice = source('../components/WorkspaceNotice.vue')
const actionBar = source('../components/TopActionBar.vue')

const familyPages = {
  generator: source('../pages/projects/[slug]/audio.vue'),
  review: source('../pages/projects/[slug]/scene-review.vue'),
  assembly: source('../pages/projects/[slug]/subtitles.vue'),
  management: source('../pages/projects/[slug]/jobs.vue'),
}

const orchestrationPages = {
  pipeline: source('../pages/projects/[slug]/pipeline.vue'),
  board: source('../pages/projects/[slug]/board.vue'),
  scenePlan: source('../pages/projects/[slug]/scene-plan.vue'),
  motionReview: source('../pages/projects/[slug]/motion-review.vue'),
}

describe('workspace design system', () => {
  test('loads after the compatibility stylesheet', () => {
    assert.match(
      nuxtConfig,
      /'~\/assets\/css\/main\.css',[\s\S]*'~\/assets\/css\/design-system\.css'/,
    )
  })

  test('provides semantic page, section, notice, metric, and responsive patterns', () => {
    for (const pattern of [
      '.workspace-page',
      '.workspace-hero',
      '.workspace-section',
      '.workspace-notice',
      '.workspace-metric',
      '@media (max-width: 680px)',
      '@media (prefers-reduced-motion: reduce)',
    ]) {
      assert.ok(designSystem.includes(pattern), `missing shared pattern: ${pattern}`)
    }
  })

  test('shared components own the repeated workspace structure', () => {
    assert.match(hero, /class="workspace-hero"/)
    assert.match(hero, /<slot name="aside"/)
    assert.match(section, /class="card workspace-section"/)
    assert.match(section, /<slot name="actions"/)
    assert.match(notice, /data-tone="tone"/)
    assert.match(notice, /role="status"/)
  })

  test('each workflow family starts from the same page shell', () => {
    for (const [family, page] of Object.entries(familyPages)) {
      assert.match(page, /class="[^"]*workspace-page/, `${family} page must use workspace-page`)
      assert.match(page, /<WorkspaceHero/, `${family} page must use WorkspaceHero`)
    }
  })

  test('orchestration and review pages share the same hero and command hierarchy', () => {
    for (const [pageName, page] of Object.entries(orchestrationPages)) {
      assert.match(page, /class="[^"]*workspace-page/, `${pageName} must use workspace-page`)
      assert.match(page, /<WorkspaceHero/, `${pageName} must use WorkspaceHero`)
      assert.match(page, /workspace-command-surface/, `${pageName} must use a command surface`)
    }

    assert.match(orchestrationPages.pipeline, /<WorkspaceSection/)
    assert.match(orchestrationPages.scenePlan, /<WorkspaceSection/)
    assert.match(orchestrationPages.motionReview, /<WorkspaceNotice/)
    assert.doesNotMatch(orchestrationPages.pipeline, /class="page-header"/)
    assert.doesNotMatch(orchestrationPages.scenePlan, /class="page-header"/)
    assert.doesNotMatch(orchestrationPages.motionReview, /class="motion-hero"/)
    assert.doesNotMatch(orchestrationPages.board, /class="board-head"/)
  })

  test('the shared action bar uses named regions and accessible control sizing', () => {
    assert.match(actionBar, />Preset<\/span>/)
    assert.match(actionBar, />Episode<\/span>/)
    assert.doesNotMatch(actionBar, /region-label" aria-hidden="true">[⚙📺]/)
    assert.match(actionBar, /min-height: var\(--control-height-md\)/)
  })
})
