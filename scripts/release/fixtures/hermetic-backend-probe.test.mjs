import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('backend test harness redirects every per-machine root into its sandbox', async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'the backend test harness must publish its sandbox root')

  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME']) {
    const value = process.env[key]
    assert.ok(value, `${key} must be defined by the backend test harness`)
    const relative = path.relative(harnessRoot, value)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${key} must stay inside the harness sandbox`)
  }

  const settingsPath = process.platform === 'darwin'
    ? path.join(process.env.HOME, 'Library', 'Application Support', 'Story Studio KH', 'app-settings.json')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA, 'Story Studio KH', 'app-settings.json')
      : path.join(process.env.XDG_CONFIG_HOME, 'Story Studio KH', 'app-settings.json')
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
  const relativeProjectsRoot = path.relative(harnessRoot, settings.projects_root_override)
  assert.ok(
    relativeProjectsRoot && !relativeProjectsRoot.startsWith('..') && !path.isAbsolute(relativeProjectsRoot),
    'the configured projects root must stay inside the harness sandbox',
  )
  assert.equal(process.env.STORY_STUDIO_DATA_DIR, undefined, 'individual suites must remain free to claim and release their own data dir')
})
