import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  fallbackFeatureGuide,
  featureGuides,
  resolveFeatureGuide,
} from '../composables/useFeatureGuide'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const helpCenter = source('../components/FeatureHelpCenter.vue')
const dashboardLayout = source('../layouts/dashboard.vue')
const defaultLayout = source('../layouts/default.vue')

const reachableRoutes = [
  '/',
  '/login',
  '/remote',
  '/usage',
  '/character-library',
  '/broll-library',
  '/projects/example',
  '/projects/example/ideas',
  '/projects/example/pipeline',
  '/projects/example/board',
  '/projects/example/research',
  // The Introduction became its own stage in v1.4.73 and was the one workspace
  // in the app with no guide at all — the page whose whole complaint was that
  // nobody could tell what it produced.
  '/projects/example/introduction',
  '/projects/example/scripts',
  '/projects/example/metadata',
  '/projects/example/metadata-template',
  '/projects/example/image-prompts',
  '/projects/example/thumbnail-templates',
  '/projects/example/images',
  '/projects/example/audio',
  '/projects/example/audio-merge',
  '/projects/example/subtitles',
  '/projects/example/character-sheet',
  '/projects/example/scene-plan',
  // v1.4.365 — the two old addresses redirect to /sound-and-labels, which must
  // carry its own guide rather than falling back to the generic one.
  '/projects/example/sound-and-labels',
  '/projects/example/scene-review',
  '/projects/example/motion-review',
  '/projects/example/video-assembly',
  '/projects/example/upload',
  '/projects/example/upload/publish',
  '/projects/example/upload/library',
  '/projects/example/upload/reconcile',
  '/projects/example/upload/comments',
  '/projects/example/upload/analytics',
  '/projects/example/jobs',
  '/projects/example/presets',
  '/projects/example/settings',
  '/projects/example/image-pool',
  '/projects/example/broll',
  '/projects/example/recency',
]

describe('feature help center', () => {
  test('is available in project and project-selection layouts', () => {
    assert.match(dashboardLayout, /<FeatureHelpCenter\s*\/>/)
    assert.match(defaultLayout, /<FeatureHelpCenter\s*\/>/)
  })

  test('provides an accessible searchable page guide', () => {
    assert.match(helpCenter, /aria-haspopup="dialog"/)
    assert.match(helpCenter, /aria-label="Close page guide"/)
    assert.match(helpCenter, /type="search"/)
    assert.match(helpCenter, /Recommended flow/)
    assert.match(helpCenter, /What each feature does/)
    assert.match(helpCenter, /Good defaults and safeguards/)
  })

  test('every reachable workspace has a specific guide', () => {
    for (const route of reachableRoutes) {
      assert.notEqual(
        resolveFeatureGuide(route),
        fallbackFeatureGuide,
        `${route} must not use the generic fallback guide`,
      )
    }
  })

  test('every guide contains workflow, feature detail, and practical guidance', () => {
    for (const [key, guide] of Object.entries(featureGuides)) {
      assert.ok(guide.summary.trim().length >= 24, `${key} needs a useful summary`)
      assert.ok(guide.workflow.length >= 2, `${key} needs a recommended flow`)
      assert.ok(guide.topics.length >= 2, `${key} needs feature details`)
      assert.ok(guide.tips.length >= 2, `${key} needs practical safeguards`)
      for (const topic of guide.topics) {
        assert.ok(topic.title.trim(), `${key} has a topic without a title`)
        assert.ok(topic.purpose.trim().length >= 12, `${key}/${topic.title} needs a useful purpose`)
      }
    }
  })

  test('unknown future routes fail safely with the generic guide', () => {
    assert.equal(resolveFeatureGuide('/projects/example/future-workspace'), fallbackFeatureGuide)
  })
})
