import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const dashboard = source('../pages/projects/[slug]/index.vue')
const template = dashboard.slice(0, dashboard.indexOf('<script setup'))
const script = dashboard.slice(dashboard.indexOf('<script setup'), dashboard.indexOf('<style scoped>'))
const dialog = source('../components/MissingAssetsDialog.vue')

// Source assertions: they pin the wiring, but cannot see how the page actually
// renders or whether a real request race resolves the right way.
describe('project dashboard — truthful status', () => {
  test('the all-clear needs known status; unknown reads "Can\'t tell yet" with Retry', () => {
    assert.match(script, /const statusKnown = computed\(\(\) => episodesKnown\.value && !!visualSource\.value\)/)
    assert.match(script, /const episodesKnown = computed\(\(\) => !episodesError\.value && !outputRootMissing\.value && !initialLoading\.value\)/)
    assert.match(template, /v-else-if="statusPending"[\s\S]*Checking project status…/)
    assert.match(template, /v-else-if="!statusKnown"[\s\S]*Can't tell yet — status didn't load\.[\s\S]*@click="retryLoad"/)
    // the green all-clear is the LAST branch, after both unknown branches
    assert.ok(template.indexOf("Can't tell yet") < template.indexOf('Nothing is holding you up.'))
    assert.doesNotMatch(template, /No blockers detected/)
    // an unreadable episode list must not masquerade as "no accepted episodes"
    assert.match(script, /episodeCount\.value === 0 && episodesKnown\.value/)
  })

  test('hero and metric numbers show a dash while unknown instead of zero', () => {
    assert.match(template, /statusKnown \? readyCount : '—'/)
    assert.match(template, /statusKnown \? needsWorkCount : '—'/)
    assert.match(template, /statusKnown \? readyToRenderCount : '—'/)
    assert.match(template, /episodesKnown \? finalVideoCount : '—'/)
    assert.match(template, /overview\?\.ideas \? overview\.ideas\.total : '—'/)
    assert.doesNotMatch(template, /overview\?\.ideas\?\.total \|\| 0/)
  })

  test('refresh keeps the last known format and only blanks it for another project', () => {
    assert.match(script, /if \(visualSourceSlug !== requestSlug\) visualSource\.value = null/)
    assert.match(script, /visualSource\.value = source\s+visualSourceSlug = requestSlug/)
    // the old unconditional blanking is gone
    assert.doesNotMatch(script, /overviewLoading\.value = true\s+visualSource\.value = null/)
    // an unparseable format is a genuine unknown, not a stale known value
    assert.match(script, /if \(!source\) \{\s+visualSource\.value = null/)
  })

  test('ready-to-render excludes episodes whose Contextual Cues or Sound Design are unfinished', () => {
    const start = script.indexOf('const readyToRenderCount')
    const block = script.slice(start, script.indexOf('const activeJobCount'))
    assert.match(block, /ep\.status\?\.contextual_cues !== false/)
    assert.match(block, /ep\.status\?\.sound_design !== false/)
    assert.match(block, /requiredStatusFields\(visualSource\.value, episodeVisualSource\(ep\)\)/)
  })

  test('the workflow grid only lists steps with a status field and has no fake Ideas 100%', () => {
    assert.match(script, /steps\.value\.filter\(step => STATUS_FIELD\[step\.key\]\)\.map\(/)
    assert.doesNotMatch(script, /step\.key === 'ideas'/)
    assert.doesNotMatch(script, /: 0\n\s+const pct/)
  })

  test('every network write is guarded by the project captured before the await', () => {
    const load = script.slice(script.indexOf('async function loadOverview'), script.indexOf('const refreshing'))
    assert.match(load, /const requestSlug = slug\.value/)
    assert.doesNotMatch(load, /slug\.value\}/, 'request URLs must use the captured slug')
    assert.equal((load.match(/if \(!current\(\)\) return/g) || []).length >= 4, true)
    const audit = script.slice(script.indexOf('async function runAudit'), script.indexOf('let visualSourceSlug'))
    assert.match(audit, /const requestSlug = slug\.value/)
    assert.match(audit, /assets-audit-detail`/)
    assert.doesNotMatch(audit, /\$\{slug\.value\}/)
    assert.match(audit, /auditCache\.value\[requestSlug\] = \{ result, ts \}/)
    assert.match(audit, /if \(slug\.value === requestSlug\) \{\s+audit\.value = result/)
    assert.match(audit, /if \(slug\.value === requestSlug\) reportReadiness\(\)/)
  })

  test('the file check says how old its result is', () => {
    assert.match(script, /auditCheckedAt\.value = cached\.ts/)
    assert.match(script, /auditCheckedAt\.value = ts/)
    assert.match(script, /Checked \$\{minutes\} min ago\./)
    assert.match(template, /\{\{ auditAgeLabel \}\}/)
    assert.doesNotMatch(script, /setInterval/)
  })

  test('Publishing counts YouTube accounts only, and a missing list is unknown not zero', () => {
    assert.match(script, /const youtube = response\?\.accounts\?\.youtube/)
    assert.match(script, /Array\.isArray\(youtube\) \? youtube\.length : null/)
    assert.doesNotMatch(script, /Object\.values\(response\?\.accounts/)
    // and the upload route really does key the response by platform
    const upload = source('../../electron/server/routes/upload.ts')
    assert.match(upload, /accounts\.youtube = \[\]/)
    assert.match(upload, /res\.json\(\{ accounts, defaults \}\)/)
  })

  test('Retry and Refresh use the light re-read; Shift-click is the labelled full recompute', () => {
    assert.match(script, /revalidate: revalidateEpisodes/)
    assert.match(script, /async function retryLoad\(\) \{[\s\S]*revalidateEpisodes\(\)/)
    assert.match(script, /onClick: retryLoad/)
    assert.equal((template.match(/@click="retryLoad"/g) || []).length, 2)
    assert.match(template, /@click="refreshAll"/)
    assert.match(script, /event\?\.shiftKey \? refreshEpisodes\(\) : revalidateEpisodes\(\)/)
    assert.match(template, /Shift-click to re-check every episode from disk/)
    assert.match(template, /v-if="episodesRefreshing && episodes\.length"[^>]*>Updating…</)
    assert.doesNotMatch(template, />Refresh status</)
  })

  test('the job queue row says "Checking…" until the first job snapshot arrives', () => {
    assert.match(script, /isLoading: jobsLoading/)
    assert.match(template, /<p v-if="jobsLoading">Checking…<\/p>/)
    assert.ok(template.indexOf('v-if="jobsLoading"') < template.indexOf('No queued or recent jobs.'))
    assert.match(template, /v-if="jobsLoading" class="operation-state">checking/)
    // the composable really exposes it
    assert.match(source('../composables/useJobs.ts'), /isLoading: readonly\(isLoading\)/)
  })

  test('plain-English copy replaces the jargon', () => {
    for (const jargon of [
      'Project command center', 'verified production readiness', 'cached episode inventory',
      'completion contract', 'Verified coverage', 'Asset integrity', 'Production pulse',
      'tracked outputs', 'production sessions', 'against disk', 'Run audit', 'Re-scan',
    ]) {
      assert.ok(!dashboard.includes(jargon), `still contains "${jargon}"`)
    }
    assert.doesNotMatch(template, /data-tone="[a-z]+">[QPA]<\/span>/, 'single-letter badges are gone')
    for (const plain of ['Channel dashboard', 'Files check', 'Check Files', 'Check Again', 'Ready for final video', 'Recent activity', 'Progress by step']) {
      assert.ok(template.includes(plain), `missing "${plain}"`)
    }
  })
})

describe('missing files dialog', () => {
  test('jump links use the episode_id query the pages actually read', () => {
    assert.match(dialog, /audio\?episode_id=\$\{encodeURIComponent\(code\)\}/)
    assert.match(dialog, /images\?episode_id=/)
    assert.match(dialog, /scene-review\?episode_id=/)
    assert.match(dialog, /motion-review\?episode_id=/)
    assert.match(dialog, /audio-merge\?episode_id=/)
    assert.doesNotMatch(dialog, /\?episode=\$\{code\}/)
    assert.match(source('../pages/projects/[slug]/audio.vue'), /route\.query\.episode_id/)
  })

  test('says "files" in plain words, not "manifest"', () => {
    assert.doesNotMatch(dialog, /manifest/i)
    assert.match(dialog, /Every expected file is on disk\./)
    assert.match(dialog, /'Files check' : 'Missing files'/)
  })
})
