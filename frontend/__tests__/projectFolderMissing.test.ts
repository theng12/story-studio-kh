/**
 * v1.4.2 — the app stops recommending a button it removed, and stops hiding a
 * broken project.
 *
 * Two defects, both found while answering a question about moving assets to a
 * new Mac, and both the same underlying fault: the app said something that was
 * not true, or said nothing when it knew better.
 *
 * 1. **Instructions pointing at nothing.** "🔗 Add existing project folder…"
 *    was removed from the home page on 2026-08-08, and
 *    `channelCreationFlow.test.ts` asserts it stays removed. Four places still
 *    told people to use it — two of them directly beneath actions that REMOVE a
 *    project, promising a recovery route that did not exist.
 *
 * 2. **A broken project rendering clean.** `output_root_exists` was computed and
 *    never read, so a project whose episodes folder had moved looked healthy
 *    while every episode inside it silently vanished.
 *
 * And one found while fixing them: hiding a project had become a ONE-WAY DOOR,
 * because the restore UI went with the same home-page collapse while Settings
 * kept offering "Hide project". The backend routes and their tests were intact,
 * so the fix was wiring, not new machinery.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const home = read('../pages/index.vue')
const settings = read('../pages/projects/[slug]/settings.vue')
const dashboard = read('../pages/projects/[slug]/index.vue')
const guide = read('../composables/useFeatureGuide.ts')

/**
 * Comments explaining the removal are legitimate and must not trip this; only
 * text a person can READ counts. Everything from `//` to end of line goes.
 */
const withoutComments = (src: string) => src
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')

test('no user-facing text recommends the removed button', () => {
  for (const [name, src] of [
    ['index.vue', home],
    ['settings.vue', settings],
    ['dashboard', dashboard],
    ['useFeatureGuide', guide],
  ] as const) {
    assert.ok(
      !/Add existing project folder/.test(withoutComments(src)),
      `${name} still tells the user to use "Add existing project folder…", which was removed on 2026-08-08`,
    )
  }
})

test('the honest recovery route is described instead', () => {
  // Project discovery is a filesystem scan of the projects root, so the true
  // instruction is where to put the folder — not which button to press.
  assert.match(settings, /projects folder/i)
  assert.match(settings, /project\.json/)
  assert.match(settings, /Settings\s*(→|>)\s*Storage/i)
})

test('the unlink flow is gone entirely, not merely reworded', () => {
  // v1.4.3 replaced this test's subject rather than its intent. The 1.4.2 fix
  // corrected a confirmation dialog that promised a recovery route which no
  // longer existed; 1.4.3 removed the whole idea of a project living outside
  // the Library, so there is nothing to unlink FROM and no dialog to word.
  //
  // Asserted as an absence because the failure mode is someone reinstating it
  // from the old comments without the owner's instruction: *"i don't want
  // connection like in the past where i have to link and stuff."*
  const live = withoutComments(settings)
  assert.ok(!/Unlink project from this Mac\?/.test(live), 'the unlink confirmation is back')
  assert.ok(!/unlinkFromThisMac/.test(live), 'the unlink handler is back')
  assert.ok(!/useLinkedProjects/.test(live), 'the linked-projects client is back')
  // And the honest replacement is stated: a channel is a folder in the Library.
  assert.match(settings, /folder in your Library/i)
})

test('hiding a project has a way back, and Settings names it', () => {
  // Hiding writes a soft-delete tombstone that the folder scan obeys, so
  // without this panel the files stay on disk and are unreachable from the app
  // forever. Moving the folder does NOT clear the tombstone.
  assert.match(home, /useSoftDeletedProjects\(\)/)
  assert.match(home, /Hidden channels/)
  assert.match(home, /restoreHidden/)
  assert.match(settings, /Hidden channels/)
  // And Settings must not send people to move the folder instead, which fails.
  assert.match(settings, /would not bring it back/i)
})

test('restoring re-reads the live list rather than leaving a stale page', () => {
  assert.match(home, /restoreHidden[\s\S]{0,320}loadProjects\(\)/)
})

test('a project whose episodes folder is missing says so on the card', () => {
  assert.match(home, /output_root_exists === false/)
  assert.match(home, /Folder missing/)
  // Naming the path is the whole value: a warning with no path leaves the
  // person nothing to act on.
  assert.match(home, /Episodes folder not found/)
  assert.match(home, /project\.output_root/)
})

test('and on the project page, above everything else', () => {
  assert.match(dashboard, /outputRootMissing/)
  assert.match(dashboard, /outputRootPath/)
  assert.match(dashboard, /episodes folder could not be found/i)
  // It must sit ABOVE the loading/refresh notices: while it is true every count
  // below reads zero, and a person who cannot see why hunts the wrong fault.
  assert.ok(
    dashboard.indexOf('outputRootMissing') < dashboard.indexOf('Loading verified project status'),
    'the missing-folder notice must render above the loading notice',
  )
})

test('only an explicit false accuses a project', () => {
  // An older backend, or a response predating the field, must read as "unknown"
  // and stay silent rather than reporting every healthy project as broken.
  assert.match(dashboard, /output_root_exists === false/)
  assert.ok(
    !/!\s*\w+\.output_root_exists/.test(dashboard + home),
    'a truthiness check would treat a missing field as a missing folder',
  )
})

test('nothing offers to repair the path automatically', () => {
  // Deliberate: one of the owner's two broken projects had its OWN ./episodes
  // present but empty, while the real episodes were in a sibling folder. Any
  // guess would have silently adopted the empty one and reported success.
  //
  // Scoped to the notice itself — the dashboard legitimately offers to "Repair
  // failed jobs" elsewhere, which is a different thing entirely.
  const start = dashboard.indexOf('outputRootMissing')
  const notice = withoutComments(dashboard.slice(start, dashboard.indexOf('</WorkspaceNotice>', start)))
  assert.ok(
    !/repair|auto-?fix|relink|reconnect automatically|find it for me/i.test(notice),
    'the missing-folder notice must not offer to guess a replacement path',
  )
  // Its only action is to show the person where the setting lives.
  assert.match(notice, /Settings\s*→\s*Storage/)
  // And the card states the fact without offering to act on it.
  const cardStart = home.indexOf('Episodes folder not found')
  assert.ok(
    !/repair|auto-?fix|relink/i.test(withoutComments(home.slice(cardStart, cardStart + 400))),
    'the project card must not offer to repair the path',
  )
})
