/**
 * Small owner-facing fixes from the 2026-10-03 shell audit that live in page templates, where a
 * source check is the proportionate guard. Behaviour with logic has its own runtime tests
 * (useNetworkStatus, useCredits, useApiAuth, GenerationCompressionPanel, MediaCleanupPanel,
 * contentStoreBatchPurchase, contentStoreInstallAllProgress, useEpisodes, settingsProjectLoadRuntime).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { featureGuideKeyForPath } from '../composables/useFeatureGuide.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Remote page asks before running every episode or stopping every job, and says when force pays again', () => {
  const remote = read('../pages/remote.vue')
  assert.match(remote, /async function run\(\)[\s\S]*?await ask\(\{[\s\S]*?paid steps are paid for again/)
  assert.match(remote, /async function requestEligibleControls\(\)[\s\S]*?await ask\(\{/)
  assert.match(remote, /v-if="job\.status === 'error' && job\.episode_id"/, 'Retry only where it can act')
  assert.match(remote, /projectsLoadError[\s\S]*?Try Again/)
  assert.doesNotMatch(remote, /reconciling the cancellation result|before provider submission|Manage eligible/)
})

test('sign-in errors with no answer read as one plain sentence', () => {
  const login = read('../pages/login.vue')
  assert.match(login, /Can’t reach the Story Studio Mac/)
})

test('Settings: no native alert()/confirm(), and destructive per-row actions ask first', () => {
  const settings = read('../pages/projects/[slug]/settings.vue')
  const script = settings.slice(settings.indexOf('<script'))
  assert.doesNotMatch(script, /(?<![.\w])alert\(/)
  assert.doesNotMatch(script, /(?<![.\w])confirm\(/)
  for (const fn of ['runBulkCleanup', 'clearMediaRoot', 'cleanupOneSidecar', 'cleanupAllChunkedSidecars', 'deletePreset']) {
    assert.match(script, new RegExp(`async function ${fn}\\([^)]*\\) \\{[\\s\\S]{0,400}?await ask\\(`), fn)
  }
  assert.doesNotMatch(settings, /\{'\{code\}'\}|Define it under Named Roots|e\.g\. \$\{MEDIA\}/)
  // v1.4.249: the storage map (and its "Space recovery" card) is gone; per-episode
  // space is the read-only "What's using space" view inside the Free up Space card.
  assert.match(settings, /data-setting="episode-storage"/)
})

test('Server Mode button text has no raw HTML entity inside an interpolation', () => {
  assert.doesNotMatch(read('../components/ServerModeSettingsPanel.vue'), /\{\{[^}]*&amp;[^}]*\}\}/)
})

test('the Content Store has its own page guide', () => {
  assert.equal(featureGuideKeyForPath('/content-store'), 'content-store')
  assert.equal(featureGuideKeyForPath('/content-store/cprod_a'), 'content-store')
})

test('with no key the header says "Gateway · Connect", not the paid service\'s name', () => {
  const strip = read('../components/GenStudioStandingStrip.vue')
  assert.match(strip, /aria-label="Connect Your Gateway"[\s\S]*?<span>Gateway<\/span>/)
  assert.match(strip, /if \(!genstudioConfigured\.value\) return 'Connect'/)
  assert.doesNotMatch(strip, /Set up the Gateway/)
})
