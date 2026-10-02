/**
 * Ideas page audit, 2026-10-03. Source-shape checks — mounting the full page
 * would need the whole Nuxt app. The backend halves are pinned in
 * electron/server/__tests__/idea-accept-safety.test.ts and
 * idea-campaign-plain-failure.test.ts.
 *
 * Cannot catch: layout (a hint that wraps badly, a button pushed off-screen).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ideas = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/ideas.vue', import.meta.url)),
  'utf8',
)
const fn = (name: string) => ideas.match(new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1] || ''

test('Accept is single-flight and always reloads the real idea state', () => {
  const body = fn('doAccept')
  assert.ok(body, 'doAccept missing')
  assert.match(body, /accepting\.value\) return/)
  assert.match(body, /catch[\s\S]*await loadIdeas\(\)/)
  assert.match(body, /finally \{\s*accepting\.value = false/)
  assert.equal((ideas.match(/:disabled="!acceptCodeValid \|\| accepting"/g) || []).length, 2,
    'both Accept dialog buttons are disabled while running')
})

test('batch Accept reports each idea in one toast and keeps failures selected', () => {
  const body = fn('batchAccept')
  assert.match(body, /bulkIdeasRunning\.value\) return/)
  assert.match(body, /selectedIds\.value = new Set\(failed\.map\(f => f\.id\)\)/)
  assert.match(body, /Accepted \$\{accepted\} of \$\{requested\} — \$\{failed\.length\} need/)
  assert.match(body, /finally \{[\s\S]*await loadIdeas\(\)/)
  assert.match(ideas, /:disabled="bulkIdeasRunning" @click="batchAccept"/)
  assert.match(ideas, /@click="dismissSelected">Dismiss Selected/)
})

test('editing an accepted title tells the truth about the folder', () => {
  assert.doesNotMatch(ideas, /editing won't rename the episode folder/)
  assert.match(ideas, /changing the title also renames its episode folder/)
  assert.match(fn('saveEditor'), /Title saved, but the folder could not be renamed: \$\{reason\}\. Your files are still in the old folder\./)
})

test('campaign results load on every ending and while running; Jobs is one click away', () => {
  assert.match(ideas, /\['done', 'error', 'cancelled'\]\.includes\(status\)/)
  assert.match(ideas, /ideaCampaignJob\.value\?\.progress/)
  assert.match(ideas, /v-if="ideaCampaignActive" :to="`\/projects\/\$\{slug\}\/jobs`"[^>]*>View in Jobs/)
})

test('"Use next available" shows the code Accept will really assign', () => {
  assert.match(ideas, /nextEpisodeNum\.value = data\.next_accept_number \|\| data\.next_episode_number/)
})

test('optimistic delete survives reloads, ignores a 404, and is bound to its project', () => {
  const remove = ideas.match(/async function remove\(id: string\) \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(ideas, /data\.ideas\.filter\(\(idea: any\) => !pendingDeleteIds\.has\(idea\.id\)\)/)
  assert.match(remove, /const slugAtDelete = slug\.value/)
  assert.match(remove, /del\(`\/projects\/\$\{slugAtDelete\}\/ideas\/\$\{id\}`\)/)
  assert.match(remove, /!== 404\) throw e/)
  assert.doesNotMatch(remove, /ideas\.json/, 'no file names in the confirm text')
})

test('pagination clamps and empty states are not chained to it', () => {
  assert.match(ideas, /watch\(totalPages, \(pages\) => \{ if \(page\.value > pages\) page\.value = pages \}\)/)
  assert.match(ideas, /<EmptyState\s+v-if="allIdeas\.length === 0 && !generating"/)
})

test('shared LLM lineup replaces the model picker with plain read-only text', () => {
  assert.match(ideas, /<div v-if="ideasLineupModelCount" class="form-group lineup-model-readonly">/)
  assert.match(ideas, /<ModelSelector v-else-if="modelPreferenceReady"/)
  assert.match(ideas, /lineup\?\.enabled === true && Array\.isArray\(lineup\.models\)/)
})

test('controls carry a visible one-line hint and there is one Formula picker button', () => {
  assert.match(ideas, /<strong>Surprise me<\/strong> fills them and queues \{\{ form\.count \}\} ideas right away/)
  assert.match(ideas, /“Unmark” goes back to checking their files/)
  assert.match(ideas, /Closes gaps in episode numbers/)
  assert.match(fn('surpriseMe') + ideas.match(/function randomizeForm\(\) \{([\s\S]*?)\n\}/)?.[1], /ideaRefinementsOpen\.value = true/)
  assert.equal((ideas.match(/>Choose Formula &amp; Topics</g) || []).length, 1)
  assert.match(ideas, /const selectableOnPage = computed/)
})

test('Un-accept moves files to _trash and says so', () => {
  assert.match(ideas, /confirmLabel: 'Move to _trash and un-accept'/)
  assert.doesNotMatch(ideas, /Cannot be undone\./)
  assert.match(ideas, /title="Move this episode's files to the project's _trash and un-accept"/)
})

test('presets announce the channel-wide title change; preferences save after a pause', () => {
  assert.match(ideas, /It also changed the channel-wide title prefix\/suffix, which Metadata uses too/)
  assert.match(ideas, /Channel-wide — also used for metadata\./)
  assert.match(ideas, /setTimeout\(\(\) => \{\s*savePreferencesTimer = null\s*void saveIdeaPreferences\(savePreferencesSlug\)\s*\}, 500\)/)
  assert.doesNotMatch(ideas, /watch\(\(\) => titleConfig\.prefix, saveIdeaPreferences\)/)
})

test('visible text drops file names and engine jargon; renumber warnings are one toast', () => {
  for (const jargon of [/<code>episode_info\.json<\/code>/, /ideas\.json<\/code> atomically/, /YouTube sidecar/, /Continuity Engine default/, /\.renumber-undo\.json/]) {
    assert.doesNotMatch(ideas, jargon)
  }
  assert.doesNotMatch(ideas, /forEach\(\(w: string\) => showError/)
})

test('a parent-folder import opens the file-mapping step for each episode that needs it', () => {
  assert.match(ideas, /assetMapQueue\.push\(\{/)
  assert.match(ideas, /@close="openNextAssetMap"/)
  assert.match(ideas, /:key="assetMapEpisode\.episode_code"/)
})
