/**
 * Episode Visual Setup (Character Sheet) — the Story context section,
 * Phase 1 of the owner-approved refactor (2026-11-05: 54959 → 54963 → 54879).
 *
 * Static analysis over the page source (the frontend lane's convention): it
 * proves the wiring and the episode-change contract are present in the
 * source. It does NOT prove the DOM renders (AGENTS.md §3 — a screenshot
 * closes that gap), and it never runs the Story suite on its own.
 *
 * What it pins:
 *   - one shared contract with the backend for kinds/labels/ids/doc shape —
 *     the page never grows a second copy of the kind list;
 *   - the inventory reads and saves its OWN episode-owned sidecar, and the
 *     story facts never ride the continuity save or the channel look;
 *   - Save stays off until the story read has answered, a failed read never
 *     falls back to an empty inventory, and a half-save says which half
 *     failed (§8 honest states);
 *   - an episode change blanks the previous episode's inventory, its loaded
 *     flag and the half-typed add-row name BEFORE the reloads (§4);
 *   - keep/drop is a restorable retire, and the adaptive one-canonical-
 *     reference rule is on screen where importance is chosen.
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

test('story context uses the shared contract and its own episode-owned route', () => {
  // One source of truth: the kinds, labels and id minting come from the
  // backend contract module, not from a list typed into the page.
  assert.match(
    page,
    /from '\.\.\/\.\.\/\.\.\/\.\.\/electron\/server\/contracts\/story-entities\.js'/,
    'the page must import the shared story-entities contract',
  )
  assert.match(page, /STORY_ENTITY_KINDS/)
  assert.match(page, /canonicalStoryEntityId/)

  // Read AND save go through this episode's own inventory route.
  const routeUses = page.match(/story-entities\/\$\{ep\}/g) || []
  assert.ok(routeUses.length >= 2, 'both loadStory and saveConfig must use the episode-owned route')

  // The save only writes the inventory half — story facts, never the look.
  assert.match(page, /entities: storyDoc\.value\.entities/)
  const section = /<section class="card mt-3 cs-story-context">[\s\S]*?<\/section>/.exec(page)?.[0]
  assert.ok(section, 'the Story context section must exist')
  assert.ok(!section!.includes('style_bible'), 'story facts must not carry the channel look')
  assert.ok(!section!.includes('StylePicker'), 'the channel look stays in its own section')
  assert.match(section!, /kept separate from the channel look/)
})

test('save stays off until the story context has answered, and says which half failed', () => {
  assert.match(
    page,
    /:generate-disabled="!episodeId \|\| !configLoaded \|\| !storyLoaded"/,
    'Save is disabled until BOTH reads have answered',
  )
  assert.match(page, /if \(!ep \|\| !configLoaded\.value \|\| !storyLoaded\.value\) return/)
  assert.match(page, /Saving is off until the story context loads/)
  // A failed read refuses Save rather than falling back to an empty
  // inventory a later save would write over the real one (§8).
  assert.match(page, /Never fall back to defaults silently/)
  assert.match(page, /storyLoadError\.value = e\?\.data\?\.detail/)
  // A save whose story half failed must say so — never a bare success.
  assert.match(page, /Visual setup saved, but story context failed/)
  // Inventory edits or an explicitly reviewed proposal draft need a story save.
  assert.match(page, /if \(storyDirty\.value \|\| proposalsReviewed\.value\)/)
})

test('an episode change blanks the story inventory before the reloads', () => {
  const watcher = episodeChangeWatcher()

  const blankDoc = watcher.indexOf('storyDoc.value = emptyStoryEntities()')
  const blankLoaded = watcher.indexOf('storyLoaded.value = false')
  const reload = watcher.indexOf('void loadStory()')
  assert.ok(blankDoc >= 0 && blankDoc < reload, 'the inventory must be blanked before its reload')
  assert.ok(blankLoaded >= 0 && blankLoaded < reload, 'Save must not stay enabled on the previous episode’s inventory')
  assert.match(watcher, /storyChapters\.value = null/, 'the script chapter count is episode-owned too')
  // The half-typed add-row name is episode-owned draft text (§4).
  assert.match(watcher, /newEntityName\.value = ''/)
  const firstLoad = watcher.indexOf('void loadCharacters()')
  assert.ok(firstLoad >= 0)
  assert.ok(blankDoc < firstLoad && blankLoaded < firstLoad, 'blanks happen before ANY reload starts')
})

test('keep/drop is a restorable retire and the reference rule is on screen', () => {
  assert.match(page, /entity\.review === 'drop' \? 'Restore' : 'Drop'/)
  assert.match(page, /Dropped from the inventory — restore any time; nothing is deleted/)
  // Adaptive reference rule: importance is a per-entity flag shown where the
  // choice is made — one canonical reference, additions only when needed.
  assert.match(page, /Needs reference/)
  assert.match(page, /An important entity holds one canonical reference/)
  // A cast link's canonical reference is the linked character's portrait —
  // the existing character reference pipeline, never a second one.
  assert.match(page, /Canonical reference: \{\{ characterName\(entity\.character_id\) \}\}’s portrait/)
  // A link whose character is gone is visible, not silently dropped.
  assert.match(page, /This character is no longer in this channel/)
  // A missing script folder is reported as not on disk — never as zero.
  assert.match(page, /chapter folder not on disk/)
})
