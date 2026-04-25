/**
 * Character library composable — per-project CRUD + episode-scoped picker
 * data. Wraps the /api/projects/:slug/characters endpoints.
 *
 * No module-level cache — characters are project-scoped, change frequently
 * during authoring, and the underlying CRUD endpoints are cheap (just file
 * reads from PROJECTS_ROOT). Each call goes to the backend; the page-level
 * UI handles freshness for its own ref.
 */

import { ref, computed } from 'vue'
import { useApi } from './useApi.js'

export interface CharacterSpeech {
  tonation?: string
  voiceId?: string
  voiceProvider?: string
}

export interface CharacterReferences {
  images?: string[]
  style_keywords?: string[]
}

export interface Character {
  id: string
  name: string
  archetype?: string
  description: string
  scope: 'episode' | 'project'
  episode_codes?: string[]
  speech?: CharacterSpeech
  references?: CharacterReferences
  source: 'project' | 'imported'
  schemaVersion: 1
  created_at: string
}

export function useCharacters(slug: string | (() => string)) {
  const { get, post, put, del } = useApi()

  function getSlug(): string {
    return typeof slug === 'function' ? slug() : slug
  }

  /** Full project list (no episode filter). Used by the Characters page. */
  async function list(): Promise<Character[]> {
    return await get<Character[]>(`/projects/${getSlug()}/characters`)
  }

  /** Picker-friendly: project-scoped + episode-scoped matching this episode. */
  async function listForEpisode(episodeCode: string): Promise<Character[]> {
    return await get<Character[]>(`/projects/${getSlug()}/characters?episode_code=${encodeURIComponent(episodeCode)}`)
  }

  async function getOne(id: string): Promise<Character> {
    return await get<Character>(`/projects/${getSlug()}/characters/${encodeURIComponent(id)}`)
  }

  async function create(draft: Partial<Character> & Pick<Character, 'name' | 'description'>): Promise<Character> {
    return await post<Character>(`/projects/${getSlug()}/characters`, draft)
  }

  async function update(id: string, patch: Partial<Character>): Promise<Character> {
    return await put<Character>(`/projects/${getSlug()}/characters/${encodeURIComponent(id)}`, patch)
  }

  async function promote(id: string): Promise<Character> {
    return await put<Character>(`/projects/${getSlug()}/characters/${encodeURIComponent(id)}/promote`, {})
  }

  async function remove(id: string): Promise<{ ok: boolean }> {
    return await del<{ ok: boolean }>(`/projects/${getSlug()}/characters/${encodeURIComponent(id)}`)
  }

  /**
   * Upload a reference image. Caller passes a File object; we base64-encode
   * it on the client side (route accepts JSON, no multipart parser added).
   */
  async function uploadReferenceImage(id: string, file: File): Promise<{ relativePath: string }> {
    const data_base64 = await fileToBase64(file)
    return await post<{ relativePath: string }>(
      `/projects/${getSlug()}/characters/${encodeURIComponent(id)}/reference-image`,
      { filename: file.name, data_base64 },
    )
  }

  return { list, listForEpisode, getOne, create, update, promote, remove, uploadReferenceImage }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const idx = dataUrl.indexOf('base64,')
      resolve(idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}
