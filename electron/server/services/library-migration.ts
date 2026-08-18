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
 */

import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { getAppSetting, setAppSetting } from './app-settings.js'
import { LIBRARY_ROOT_KEY } from './library.js'

/** Where one-time upgrade messages wait until the UI can show them. */
export const MIGRATION_NOTICES_KEY = 'library_migration_notices'

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
  return Array.isArray(raw) ? raw : []
}

export async function dismissMigrationNotice(id: string): Promise<void> {
  const raw = await listMigrationNotices()
  await setAppSetting(MIGRATION_NOTICES_KEY, raw.filter(n => n?.id !== id))
}
