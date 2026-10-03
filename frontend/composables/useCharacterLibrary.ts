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

  async function create(draft: Partial<Character> & Pick<Character, 'name' | 'description'>): Promise<Character> {
    return await post<Character>('/character-library', draft)
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

  async function uploadReferenceImage(id: string, file: File): Promise<{ relativePath: string }> {
    const data_base64 = await fileToBase64(file)
    return await post<{ relativePath: string }>(
      `/character-library/${encodeURIComponent(id)}/reference-image`,
      { filename: file.name, data_base64 },
    )
  }

  return {
    list, create, getOne, update, remove, uploadReferenceImage,
  }
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
