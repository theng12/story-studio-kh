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

const deliveryPages = {
  videoAssembly: source('../pages/projects/[slug]/video-assembly.vue'),
  upload: source('../pages/projects/[slug]/upload.vue'),
}

const creationPages = {
  ideas: source('../pages/projects/[slug]/ideas.vue'),
  research: source('../pages/projects/[slug]/research.vue'),
  scripts: source('../pages/projects/[slug]/scripts.vue'),
  metadata: source('../pages/projects/[slug]/metadata.vue'),
  thumbnailPrompts: source('../pages/projects/[slug]/image-prompts.vue'),
  thumbnails: source('../pages/projects/[slug]/images.vue'),
}

const libraryPages = {
  audioAssembly: source('../pages/projects/[slug]/audio-merge.vue'),
  characterSheet: source('../pages/projects/[slug]/character-sheet.vue'),
  channelCharacters: source('../pages/character-library.vue'),
  presets: source('../pages/projects/[slug]/presets.vue'),
  thumbnailTemplates: source('../pages/projects/[slug]/thumbnail-templates.vue'),
  metadataTemplate: source('../pages/projects/[slug]/metadata-template.vue'),
  assetsLibrary: source('../pages/broll-library.vue'),
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

  test('assembly and publishing pages share the delivery workspace hierarchy', () => {
    for (const [pageName, page] of Object.entries(deliveryPages)) {
      assert.match(page, /class="[^"]*workspace-page/, `${pageName} must use workspace-page`)
      assert.match(page, /<WorkspaceHero/, `${pageName} must use WorkspaceHero`)
      assert.match(page, /workspace-command-surface/, `${pageName} must use a command surface`)
    }

    assert.match(deliveryPages.videoAssembly, /assembly-step-panel/)
    assert.match(deliveryPages.upload, /upload-tab-panel/)
    assert.doesNotMatch(deliveryPages.videoAssembly, /class="page-header"/)
    assert.doesNotMatch(deliveryPages.upload, /class="upload-command-hero"/)
  })

  test('core creation pages share one creative workspace hierarchy', () => {
    for (const [pageName, page] of Object.entries(creationPages)) {
      assert.match(page, /class="[^"]*workspace-page/, `${pageName} must use workspace-page`)
      assert.match(page, /<WorkspaceHero/, `${pageName} must use WorkspaceHero`)
      assert.match(page, /workspace-command-surface/, `${pageName} must use a command surface`)
      assert.match(page, /workspace-section/, `${pageName} must use workspace sections`)
      assert.doesNotMatch(page, /class="page-header"/, `${pageName} must not restore a one-off header`)
    }

    for (const pattern of [
      '.creation-command-surface',
      '.workspace-command-copy',
      '.workspace-stage-tabs',
    ]) {
      assert.ok(designSystem.includes(pattern), `missing creation workspace pattern: ${pattern}`)
    }
  })

  test('phase five assembly and library pages use the shared workspace shell', () => {
    for (const [pageName, page] of Object.entries(libraryPages)) {
      assert.match(page, /class="[^"]*workspace-page/, `${pageName} must use workspace-page`)
      assert.match(page, /<WorkspaceHero/, `${pageName} must use WorkspaceHero`)
      assert.doesNotMatch(page, /class="page-header"/, `${pageName} must not restore a one-off header`)
    }
    assert.match(libraryPages.channelCharacters, /Channel voice profiles/)
    assert.match(libraryPages.channelCharacters, /Channel labels/)
  })

  test('the shared action bar uses named regions and accessible control sizing', () => {
    assert.match(actionBar, />Preset<\/span>/)
    assert.match(actionBar, />Episode<\/span>/)
    assert.doesNotMatch(actionBar, /region-label" aria-hidden="true">[⚙📺]/)
    assert.match(actionBar, /min-height: var\(--control-height-md\)/)
  })
})
