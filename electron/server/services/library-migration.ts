/**
 * Retiring the old location settings, once, on the way to the Library (v1.4.3).
 *
 * Four concepts became one. Three of them held real paths on the owner's
 * machine, and this decides what happens to each. The rule throughout:
 *
 *   **Never move a person's folders without being asked.**
 *
 * Deleting a stale setting is safe. Moving files is not — the app cannot know
 * whether a folder is precious, and a wrong guess is unrecoverable. So anything
 * that still exists outside the Library is REPORTED, with its path, and left
 * exactly where it is.
 *
 * ── What each setting becomes ──
 *
 * `projects_root_override` → copied into `library_root`. Same folder, new name;
 *   an upgrading install must not be sent to the first-run screen.
 *
 * `linked_project_paths` → dropped. Every entry that no longer exists is
 *   deleted silently, because a link to a folder that is gone is not
 *   information. On the owner's machine all five were iCloud paths under
 *   `Library/Mobile Documents/…` and all five were already dead, while the same
 *   five channels sat healthy in his Documents folder — so the honest migration
 *   is silence. An entry that DOES still exist is reported, so he can copy that
 *   folder into the Library himself.
 *
 * `named-roots.json` → reported if it held anything. `${ASSET}` is now always
 *   `<Library>/_Project Assets`, so any files a named root pointed at need
 *   moving there by hand. The map itself is not read again.
 *
 * `external_final_video_root` → reported if set. New renders go to
 *   `<Library>/Exports`; the existing pile stays put. On his machine that is
 *   220 GB and 191 finished videos, which is not something to relocate behind
 *   someone's back.
 *
 * Runs once. The notices are stored so the app can show them when there is a
 * window to show them in, and cleared when he dismisses them.
 *
 * ── Dismissal is remembered, not inferred (v1.4.8) ──
 *
 * Until 1.4.8 only notice 2 ever went away, because it happened to clear the
 * setting it was generated from. Notices 3 and 4 read a condition that is still
 * true — `named-roots.json` exists, `external_final_video_root` is set — and so
 * this function put them straight back on the next boot, seconds after they had
 * been dismissed. "Got it" did nothing that lasted, which is the worst kind of
 * button.
 *
 * The fix is NOT to clear those settings. They are deliberately retained (see
 * `projects_root_override` below: a downgrade to 1.4.2 still reads it), and the
 * export root is still consulted when looking for finished videos. Dismissal is
 * a statement about the MESSAGE, not about the data behind it — so it is
 * recorded separately, in `MIGRATION_NOTICES_DISMISSED_KEY`, and both the
 * generator and the reader honour it. A dismissed notice is gone for good:
 * across a restart, across a settings reload, and across a downgrade to a build
 * that re-adds it, because the acknowledgement outlives the notice list.
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { LIBRARY_ROOT_KEY } from './library.js'

/** Where one-time upgrade messages wait until the UI can show them. */
export const MIGRATION_NOTICES_KEY = 'library_migration_notices'

/**
 * Which notices the customer has read and closed. Ids only — this outlives the
 * notices themselves, so it stays a tiny list of strings forever.
 */
export const MIGRATION_NOTICES_DISMISSED_KEY = 'library_migration_notices_dismissed'

export interface MigrationNotice {
  /** Stable id so a notice is never shown twice. */
  id: string
  title: string
  body: string
  /** Folders the person may want to act on. Shown verbatim. */
  paths: string[]
}

/**
 * Fold the retired location settings into the Library.
 *
 * Idempotent and never throws: this runs at boot, and a failure to tidy up old
 * settings must not stop the app starting.
 */
export async function migrateLegacyLocationSettings(): Promise<MigrationNotice[]> {
  const notices: MigrationNotice[] = []
  try {
    // ── 1. The old projects root becomes the Library ──
    const library = await getAppSetting(LIBRARY_ROOT_KEY)
    const legacyRoot = await getAppSetting('projects_root_override')
    if ((typeof library !== 'string' || !library.trim())
      && typeof legacyRoot === 'string' && legacyRoot.trim()) {
      await setAppSetting(LIBRARY_ROOT_KEY, legacyRoot.trim())
      // Deliberately NOT deleted. If someone downgrades to 1.4.2 the old key is
      // still what that build reads, and leaving it costs one stale string.
    }

    // ── 2. Linked project paths ──
    const linked = await getAppSetting('linked_project_paths')
    if (Array.isArray(linked) && linked.length) {
      const alive = linked.filter(p => typeof p === 'string' && p.trim() && existsSync(p))
      if (alive.length) {
        notices.push({
          id: 'linked-projects-retired',
          title: 'Some channels were kept outside your Library',
          body: 'Story Studio used to track channels stored anywhere on this Mac. It now shows '
            + 'whatever is inside your Library, so these folders will not appear until you copy or '
            + 'move them in. Nothing has been changed or deleted — they are exactly where they were.',
          paths: alive,
        })
      }
      // Dead entries are dropped without a word: a link to a folder that no
      // longer exists tells nobody anything useful.
      await setAppSetting('linked_project_paths', [])
    }

    // ── 3. Named roots ──
    const roots = await readNamedRootsOnce()
    if (Object.keys(roots).length) {
      notices.push({
        id: 'named-roots-retired',
        title: 'Custom folder labels have been replaced',
        body: 'Labels like ${TERRANASH} pointed at a different folder on every Mac, so a project '
          + 'that worked here did not work anywhere else. Shared files now live in the '
          + '"_Project Assets" folder inside your Library and are written as ${ASSET}/…. Move the '
          + 'files from the folders below into _Project Assets, and any preset that referenced a '
          + 'label will need pointing at ${ASSET}/ instead.',
        paths: Object.entries(roots).map(([name, p]) => `\${${name}} → ${p}`),
      })
    }

    // ── 4. The external export root ──
    const exportRoot = await getAppSetting('external_final_video_root')
    if (typeof exportRoot === 'string' && exportRoot.trim()) {
      notices.push({
        id: 'exports-moved',
        title: 'Finished videos now go into your Library',
        body: 'New renders are saved to the "Exports" folder inside your Library. The videos you '
          + 'have already made have NOT been moved — they are still where they were, and they are '
          + 'yours to keep, move or delete. Story Studio still finds them when checking what is done.',
        paths: [exportRoot.trim()],
      })
    }

    // Anything already dismissed is not regenerated, and not returned. The
    // conditions above are still true and always will be; the customer's answer
    // to them is the newer fact.
    const dismissed = await readDismissedIds()
    const fresh = notices.filter(n => !dismissed.has(n.id))
    notices.length = 0
    notices.push(...fresh)

    if (notices.length) {
      const existing = await getAppSetting(MIGRATION_NOTICES_KEY)
      const seen = new Set(
        (Array.isArray(existing) ? existing : []).map((n: any) => n?.id).filter(Boolean),
      )
      const merged = [...(Array.isArray(existing) ? existing : []), ...notices.filter(n => !seen.has(n.id))]
      await setAppSetting(MIGRATION_NOTICES_KEY, merged)
    }
  } catch (e: any) {
    // Tidying old settings is never worth failing a boot over.
    console.warn('[library-migration] skipped:', e?.message || e)
  }
  return notices
}

/** The acknowledged ids, tolerant of a hand-edited or absent settings file. */
async function readDismissedIds(): Promise<Set<string>> {
  const raw = await getAppSetting(MIGRATION_NOTICES_DISMISSED_KEY)
  return new Set(
    (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string' && !!id),
  )
}

/**
 * Read the retired `named-roots.json` one last time, to report what it held.
 * The module that owned it is gone; this is a plain file read and nothing else.
 */
async function readNamedRootsOnce(): Promise<Record<string, string>> {
  try {
    const { getUserDataDir } = await import('./project-manager.js')
    const file = path.join(getUserDataDir(), 'named-roots.json')
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v),
    ) as Record<string, string>
  } catch {
    return {}
  }
}

export async function listMigrationNotices(): Promise<MigrationNotice[]> {
  const raw = await getAppSetting(MIGRATION_NOTICES_KEY)
  if (!Array.isArray(raw) || !raw.length) return []
  // Filtered on the way out as well as at generation. An older build that
  // doesn't know about the acknowledgement key can still push a dismissed
  // notice back into the stored list; this is what makes downgrade-then-upgrade
  // silent rather than a resurrection.
  const dismissed = await readDismissedIds()
  return raw.filter((n: any) => n && !dismissed.has(n.id))
}

/**
 * Record that the customer has read a notice, then drop it.
 *
 * The acknowledgement is written FIRST and is the durable half. Removing it
 * from the stored list is only tidying — if the process died between the two
 * writes, the notice would still never be shown again.
 */
export async function dismissMigrationNotice(id: string): Promise<void> {
  if (typeof id !== 'string' || !id) return
  const dismissed = await readDismissedIds()
  if (!dismissed.has(id)) {
    dismissed.add(id)
    await setAppSetting(MIGRATION_NOTICES_DISMISSED_KEY, [...dismissed])
  }
  const raw = await getAppSetting(MIGRATION_NOTICES_KEY)
  const stored = Array.isArray(raw) ? raw : []
  await setAppSetting(MIGRATION_NOTICES_KEY, stored.filter((n: any) => n?.id !== id))
}
