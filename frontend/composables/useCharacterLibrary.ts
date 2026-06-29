/**
 * Global character library composable (Phase 7).
 *
 * Wraps the /api/character-library endpoints + the cross-project save/import
 * actions. App-level (no slug param) — the library is shared across every
 * project on this machine.
 */

import { useApi } from './useApi.js'
import type { Character } from './useCharacters.js'

export function useCharacterLibrary() {
  const { get, post, put, del } = useApi()

  async function list(): Promise<Character[]> {
    return await get<Character[]>('/character-library')
  }

  async function getOne(id: string): Promise<Character> {
    return await get<Character>(`/character-library/${encodeURIComponent(id)}`)
  }

  async function update(id: string, patch: Partial<Character>): Promise<Character> {
    return await put<Character>(`/character-library/${encodeURIComponent(id)}`, patch)
  }

  async function remove(id: string): Promise<{ ok: boolean }> {
    return await del<{ ok: boolean }>(`/character-library/${encodeURIComponent(id)}`)
  }

  /** Save a project character to the library. Returns the saved library record. */
  async function saveProjectCharacter(
    projectSlug: string,
    characterId: string,
    opts?: { libraryId?: string; overwrite?: boolean },
  ): Promise<Character> {
    return await post<Character>(
      `/projects/${encodeURIComponent(projectSlug)}/characters/${encodeURIComponent(characterId)}/save-to-library`,
      opts || {},
    )
  }

  /** Import a library character into a project. Returns the project copy. */
  async function importToProject(
    libraryId: string,
    projectSlug: string,
    opts?: {
      targetId?: string
      scope?: 'project' | 'episode'
      episode_codes?: string[]
      overwrite?: boolean
    },
  ): Promise<Character> {
    return await post<Character>(
      `/character-library/${encodeURIComponent(libraryId)}/import-to/${encodeURIComponent(projectSlug)}`,
      opts || {},
    )
  }

  /** Library characters assigned to a given project (unified-library model). */
  async function listForProject(projectSlug: string): Promise<Character[]> {
    return await get<Character[]>(`/projects/${encodeURIComponent(projectSlug)}/library-characters`)
  }

  /** Assign a library character to a project (idempotent). Returns the updated record. */
  async function assignToProject(libraryId: string, projectSlug: string): Promise<Character> {
    return await post<Character>(
      `/character-library/${encodeURIComponent(libraryId)}/assign/${encodeURIComponent(projectSlug)}`,
      {},
    )
  }

  /** Unassign a library character from a project (reversible; keeps the library entry). */
  async function unassignFromProject(libraryId: string, projectSlug: string): Promise<Character> {
    return await del<Character>(
      `/character-library/${encodeURIComponent(libraryId)}/assign/${encodeURIComponent(projectSlug)}`,
    )
  }

  return {
    list, getOne, update, remove, saveProjectCharacter, importToProject,
    listForProject, assignToProject, unassignFromProject,
  }
}
