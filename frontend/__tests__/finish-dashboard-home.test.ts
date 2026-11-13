import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const home = source('../pages/index.vue')
const template = home.slice(0, home.indexOf('<script setup'))
const script = home.slice(home.indexOf('<script setup'), home.indexOf('<style scoped>'))
// The pill wording lives in the shared helper now (commit bb577bd3), so the
// tri-state contract is pinned there and its wiring is pinned in the template.
const view = source('../utils/channel-view.ts')

// Source assertions: they pin the wiring but cannot render the card or run a
// restore against a real backend.
describe('channel list cards', () => {
  test('the key pill says what it knows, not "Ready"', () => {
    // Three states, never two: the helper says "unknown" for anything that is
    // not an explicit boolean, so a store it could not read never claims
    // "needs key" (AGENTS §6). Pin the unknown case AND both non-null cases.
    assert.match(view, /if \(typeof hasApiKeys !== 'boolean'\) return 'Key status unknown'/)
    assert.match(view, /return hasApiKeys \? 'Key connected' : 'Needs Gateway API Key'/)
    // The template routes through the helper and marks unknown separately.
    assert.match(template, /v-else-if="project\.has_api_keys == null"[^>]*data-ready="unknown"/)
    assert.match(template, /credentialBadgeText\(project\.has_api_keys\)/)
    assert.doesNotMatch(template, /project\.has_api_keys \? 'Key connected' : 'Needs Gateway API Key'/)
    assert.doesNotMatch(template, /'Ready' : 'Setup needed'/)
  })

  test('a folder that did not answer reads as unreadable, not as a missing key', () => {
    assert.match(script, /return !!project\.status && project\.status !== 'ready'/)
    assert.match(template, /v-if="isFolderUnreadable\(project\)"[\s\S]*Can't read this channel's folder/)
    // unreadable is tested before the credential pill
    assert.ok(template.indexOf('isFolderUnreadable(project)') < template.indexOf('credentialBadgeText(project.has_api_keys)'))
    // and the server really does answer 'downloading' with has_api_keys null —
    // unknown, because the credential store was never read on that path
    const manager = source('../../electron/server/services/project-manager.ts')
    assert.match(manager, /has_api_keys: null,[\s\S]{0,400}status: 'downloading'/)
    assert.doesNotMatch(manager, /has_api_keys: false,[\s\S]{0,400}status: 'downloading'/)
  })

  test('the episode prefix is labelled as codes, not rendered as a count noun', () => {
    assert.match(template, /Episode codes: \{\{ project\.episode_prefix \|\| 'EP' \}\}0001\+/)
    assert.doesNotMatch(template, /\}\} episodes · Created/)
  })
})

describe('hidden channel restore', () => {
  test('shows the restore error and disables the button while restoring', () => {
    assert.match(template, /hiddenProjects\.lastError\.value" class="notice-error" role="alert"/)
    assert.match(template, /:disabled="row\.exists === false \|\| !!restoringSlug"/)
    assert.match(template, /restoringSlug === row\.slug \? 'Restoring…' : 'Restore'/)
    assert.match(script, /if \(restoringSlug\.value\) return/)
    assert.match(script, /finally \{\s+restoringSlug\.value = ''/)
  })

  test('the error stays visible even when the hidden list itself failed to load', () => {
    assert.match(template, /v-if="hiddenProjects\.items\.value\.length \|\| hiddenProjects\.lastError\.value" class="hidden-projects"/)
  })
})

