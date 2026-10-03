import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const dashboard = source('../pages/projects/[slug]/index.vue')
const healthRoutes = source('../../electron/server/routes/health.ts')

describe('project dashboard workspace', () => {
  test('uses the shared workspace shell and exception-first command hierarchy', () => {
    assert.match(dashboard, /class="workspace-page dashboard-workspace"/)
    assert.match(dashboard, /<WorkspaceHero/)
    assert.match(dashboard, /title="Focus now"/)
    assert.match(dashboard, /title="Production workflow"/)
    assert.match(dashboard, /title="Queue and delivery"/)
    assert.match(dashboard, /title="Recent activity"/)
  })

  test('derives readiness from the shared verified episode inventory and current flow', () => {
    assert.match(dashboard, /useEpisodes\(slug\)/)
    assert.match(dashboard, /unionFlowForEpisodeSources\(visualSource\.value, episodes\.value\.map\(episodeVisualSource\)\)/)
    assert.match(dashboard, /isFlowStepApplicable\(step, episodeVisualSource\(ep\)\)/)
    assert.match(dashboard, /requiredStatusFields\(visualSource\.value, episodeVisualSource\(ep\)\)/)
    assert.match(dashboard, /statusDone\(ep, field\)/)
    assert.doesNotMatch(dashboard, /stats\?\.episodes\?\.ready/)
  })

  test('does not restore retired dashboard workflow or misleading headline metrics', () => {
    assert.doesNotMatch(dashboard, /workflowSteps/)
    assert.doesNotMatch(dashboard, /\/youtube/)
    assert.doesNotMatch(dashboard, />Description</)
    assert.doesNotMatch(dashboard, /Time Saved/)
    assert.doesNotMatch(dashboard, /scene_prompts|total_image_files|Descriptions Generated/)
  })

  test('does not repaint a loading timer or recursively rescan assets on normal visits', () => {
    assert.doesNotMatch(dashboard, /statsElapsed|setInterval/)
    const routeStart = healthRoutes.indexOf("router.get('/projects/:slug/dashboard-stats'")
    const route = healthRoutes.slice(routeStart)
    assert.match(route, /getSessionStats/)
    assert.doesNotMatch(route, /scanEpisodes|readdir|SCAN_TIMEOUT_MS|timeSavedMin/)
  })

  test('keeps summary card labels and supporting copy responsive', () => {
    assert.match(dashboard, /dashboard-metric-top/)
    assert.match(dashboard, /dashboard-metric-detail/)
    assert.match(dashboard, /repeat\(auto-fit, minmax\(220px, 1fr\)\)/)
    assert.match(dashboard, /overflow-wrap: anywhere/)
    assert.match(dashboard, /\.dashboard-metrics[\s\S]*margin-top: var\(--workspace-section-gap\)/)
  })
})
