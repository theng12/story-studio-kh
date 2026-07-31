/**
 * Tests for the helper functions that drive the Storage tab's
 * "Projects storage location" UI.
 *
 * The actual `PROJECTS_ROOT` resolution runs at module-import time
 * (it's a const). Testing the boot-time priority order properly
 * requires child-process isolation per case — high overhead for
 * small payoff because the resolver is 30 lines of straightforward
 * if/else. Manual verification covers it: change app-settings →
 * restart → check the dashboard.
 *
 * What we DO test here:
 *   - getProjectsRootDefaultPath returns the userData fallback
 *   - getProjectsRootAppSettingsPath returns the correct app-settings
 *     location (matches what app-settings.ts computes)
 *   - PROJECTS_ROOT itself reflects what STORY_STUDIO_DATA_DIR set at
 *     test boot (the env var path; tests don't exercise the user-
 *     override branch because that would require a restart)
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

describe('project-manager: storage-location helpers', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
  })

  after(async () => { await tmp.cleanup() })

  test('projectsRoot() resolves to the env-var data dir under STORY_STUDIO_DATA_DIR', () => {
    // The test harness sets STORY_STUDIO_DATA_DIR via useTempDataDir
    // BEFORE project-manager.js is imported, so the env-var branch
    // wins. Confirms test isolation works.
    assert.equal(pm.projectsRoot(), path.join(tmp.dir, 'projects'))
  })

  test('getProjectsRootAppSettingsPath returns {dataDir}/app-settings.json under env-var', () => {
    // Mirrors resolveAppSettingsPath in project-manager.ts. When the
    // env var is set, app-settings lives next to projects/. The Storage
    // tab UI surfaces this path so users can see where the override
    // setting actually lives.
    const got = pm.getProjectsRootAppSettingsPath()
    assert.equal(got, path.join(tmp.dir, 'app-settings.json'))
  })

  test('getProjectsRootDefaultPath returns a userData-style path', () => {
    // Returns the userData fallback regardless of env-var/override
    // state. The Storage tab uses this to label the default vs custom
    // setting and offer a Reset-to-default button. We can't predict
    // the exact userData path under test (depends on Electron presence
    // + platform), but it must be a non-empty absolute path that ends
    // in `projects`.
    const def = pm.getProjectsRootDefaultPath()
    assert.ok(typeof def === 'string' && def.length > 0, 'returns a non-empty string')
    assert.ok(path.isAbsolute(def), 'returns an absolute path')
    assert.ok(def.endsWith('projects') || def.endsWith(path.sep + 'projects'),
      `expected to end in 'projects', got: ${def}`)
  })

  test('projectsRoot() and default path may differ when env-var is set', () => {
    // In test mode, STORY_STUDIO_DATA_DIR overrides the userData
    // default → PROJECTS_ROOT and getProjectsRootDefaultPath should
    // diverge. Confirms the helpers expose enough info for the UI to
    // render "[CUSTOM]" badges accurately.
    assert.notEqual(pm.projectsRoot(), pm.getProjectsRootDefaultPath(),
      'env-var override should differ from userData default during tests')
  })
})
