/**
 * Episode Visual Setup (the Character Sheet page) — what an episode change may
 * and may not carry over (AGENTS.md §4).
 *
 * The two halves of the pacing contract live elsewhere and this file does not
 * restate them: the save boundary (only Scene Plan claims `claim_pacing`) is
 * pinned in electron/server/__tests__/continuity-pacing-ownership.test.ts, and
 * the preset exclusion of `pacing` plus the "no timing UI here" rules are
 * pinned in continuityPresetPacing.test.ts.
 *
 * What this file pins is the page's own state management, the gap the 386 item
 * was scoped to:
 *   - every episode-owned draft field is replaced or blanked synchronously on
 *     the change, before any awaited read can answer for the episode just left;
 *   - customer-written composition-prompt text that gets cleared is announced,
 *     never dropped silently, and the announcement retires once new text is
 *     written;
 *   - ownership is resolved from this episode's own file list (its characters,
 *     its img2img-references), never parsed from a path or carried over.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/character-sheet.vue', import.meta.url)),
  'utf8',
)

function episodeChangeWatcher(): string {
  const match = page.match(/watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/)
  assert.ok(match, 'the episode-change watcher must exist')
  return match![0]
}

test('an episode change blanks every episode-owned draft field before the reloads', () => {
  const watcher = episodeChangeWatcher()

  // The config itself: blanked before the new read, not inside it.
  const blankAt = watcher.indexOf('config.value = continuityDefaults()')
  const loadAt = watcher.indexOf('loadConfig()')
  assert.ok(blankAt >= 0 && loadAt >= 0 && blankAt < loadAt, 'the config must be blanked before the reload')

  // Every other episode-owned draft field, blanked in the same synchronous
  // pass — a failed or slow load must never leave the previous episode's
  // values standing on screen.
  assert.match(watcher, /characters\.value = \[\]/, "the previous episode's character list must not stand")
  assert.match(watcher, /compositionPrompt\.value = ''/, "the previous episode's composition prompt must not stand")
  assert.match(watcher, /generatingComposition\.value = false/, "the previous episode's generate flag must not stand")
  assert.match(watcher, /charactersLoaded\.value = false/, 'ownership must not resolve against the previous roster')
  assert.match(watcher, /configLoaded\.value = false/, 'Save stays disabled until this episode has answered')

  // All blanks happen before any reload starts.
  const firstLoad = watcher.indexOf('void loadCharacters()')
  assert.ok(firstLoad >= 0, 'the watcher must start the reloads')
  for (const pattern of [
    /characters\.value = \[\]/,
    /compositionPrompt\.value = ''/,
    /generatingComposition\.value = false/,
  ]) {
    const at = watcher.search(pattern)
    assert.ok(at >= 0 && at < firstLoad, `${pattern} must be blanked before the reloads begin`)
  }
})

test('clearing written composition-prompt text on an episode change is announced', () => {
  const watcher = episodeChangeWatcher()

  const noticeAt = watcher.indexOf('compositionPromptNotice.value =')
  const clearAt = watcher.indexOf("compositionPrompt.value = ''")
  assert.ok(noticeAt >= 0, 'the clear must be announced (AGENTS.md §4)')
  assert.ok(clearAt >= 0 && noticeAt < clearAt, 'the announcement must read the previous text before blanking it')

  // An empty prompt produces no announcement — there is nothing to say.
  assert.match(
    watcher,
    /compositionPromptNotice\.value = compositionPrompt\.value\.trim\(\)/,
    'the announcement must be conditional on text actually being dropped',
  )
  // The notice renders on the page…
  assert.match(page, /v-if="compositionPromptNotice"/, 'the announcement must be visible to the customer')
  assert.match(page, /title="Composition prompt cleared"/)
  // …and retires once the customer writes a new prompt for the episode now on
  // screen, exactly like Scene Plan's episode-guidance notice.
  assert.match(
    page,
    /watch\(compositionPrompt, \(value\) => \{\s*if \(value\.trim\(\)\) compositionPromptNotice\.value = ''/,
    'the announcement must clear when new prompt text is written',
  )
})

test('ownership resolves from this episode’s own files, never carried or parsed', () => {
  // The known-anchor set comes from this episode's own character list…
  assert.match(page, /await cm\.listForEpisode\(ep\)/, 'anchors are checked against this episode’s own roster')
  // …and the anchor/composition images from this episode's own file list.
  assert.ok(
    page.includes('/projects/${project}/episodes/${ep}/img2img-references'),
    'reference existence is read from this episode’s own route, never inferred',
  )
  // A read that fails refuses Save rather than falling back to defaults or to
  // the episode just left (AGENTS.md §4/§6 honesty).
  assert.match(page, /Never fall back to defaults silently/)
  assert.match(page, /:generate-disabled="!episodeId \|\| !configLoaded \|\| !storyLoaded"/)
  // The page saves the whole config it loaded and claims no pacing authority —
  // pinned in full by continuityPresetPacing.test.ts; asserted here only so a
  // rewrite of this page cannot silently reintroduce the claim.
  assert.doesNotMatch(page, /claim_pacing/, 'a visual-setup save must not claim the episode rhythm')
})
